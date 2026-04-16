const express = require('express');
const rateLimit = require('express-rate-limit');
const Course = require('../models/Course');
const User = require('../models/User');
const { ensureRole } = require('../middleware/auth');
const { getLyzrConfig, sendTutorMessage } = require('../utils/lyzr_client');
const {
  getOrCreateContainerClient,
  getStorageConfig,
  signBlobReadUrl,
  createBlobUploadSasUrl
} = require('../utils/storage');
const { enqueueVideoTranscodeJob } = require('../queues/videoTranscodeQueue');

const router = express.Router();

const tutorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.COURSE_TUTOR_RATE_LIMIT_PER_MIN || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many tutor requests. Please try again shortly.' }
});

const MAX_THUMBNAIL_MB = Number(process.env.MAX_THUMBNAIL_UPLOAD_MB || 2);
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_UPLOAD_MB || 80);
const MAX_THUMBNAIL_BYTES = Math.max(1, MAX_THUMBNAIL_MB) * 1024 * 1024;
const MAX_VIDEO_BYTES = Math.max(1, MAX_VIDEO_MB) * 1024 * 1024;

function recalculateRatings(course) {
  const ratingsCount = course.reviews.length;
  const totalRating = course.reviews.reduce((sum, review) => sum + review.rating, 0);
  course.ratingsCount = ratingsCount;
  course.averageRating = ratingsCount ? Number((totalRating / ratingsCount).toFixed(2)) : 0;
}

function withSignedMedia(course) {
  const plainCourse = typeof course.toObject === 'function' ? course.toObject() : { ...course };

  return {
    ...plainCourse,
    averageRating: plainCourse.averageRating || 0,
    ratingsCount: plainCourse.ratingsCount || 0,
    videos: (plainCourse.videos || [])
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((video) => ({
        ...video,
        sourceVideoUrl: signBlobReadUrl(video.sourceVideoUrl || video.videoUrl),
        videoUrl: signBlobReadUrl(video.videoUrl)
      })),
    documents: (plainCourse.documents || [])
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((doc) => ({
        ...doc,
        documentUrl: signBlobReadUrl(doc.documentUrl)
      })),
    thumbnailUrl: signBlobReadUrl(plainCourse.thumbnailUrl),
    reviews: (plainCourse.reviews || []).map((review) => ({
      ...review,
      comment: review.comment || ''
    }))
  };
}

function normalizeFilename(name) {
  return (name || 'file').replace(/\s+/g, '-');
}

async function queueTranscodeForCourse(course) {
  let changed = false;

  for (const video of course.videos) {
    if (video.videoStatus === 'ready') {
      continue;
    }

    const queued = await enqueueVideoTranscodeJob({
      courseId: String(course._id),
      videoId: String(video._id)
    });

    const nextStatus = queued ? 'processing' : 'ready';
    if (video.videoStatus !== nextStatus) {
      video.videoStatus = nextStatus;
      changed = true;
    }

    if (!queued) {
      video.videoUrl = video.sourceVideoUrl || video.videoUrl;
      video.transcodeError = '';
      changed = true;
    }
  }

  if (changed) {
    await course.save();
  }
}

router.post('/uploads/sas', ensureRole('instructor'), async (req, res) => {
  try {
    const { isConfigured } = getStorageConfig();
    if (!isConfigured) {
      return res.status(503).json({
        success: false,
        message: 'Uploads are unavailable until Azure storage is configured'
      });
    }

    const { fileName, kind = 'video' } = req.body;
    if (!fileName || typeof fileName !== 'string') {
      return res.status(400).json({ success: false, message: 'fileName is required' });
    }

    const folderMap = { thumbnail: 'thumbnails', video: 'videos', document: 'documents' };
    const folder = folderMap[kind] || 'videos';
    const blobName = `${folder}/${Date.now()}-${normalizeFilename(fileName)}`;
    const sas = createBlobUploadSasUrl(blobName, { expiryMinutes: 60 });

    if (!sas) {
      return res.status(500).json({ success: false, message: 'Failed to generate upload SAS URL' });
    }

    return res.json({
      success: true,
      uploadUrl: sas.uploadUrl,
      blobUrl: sas.blobUrl,
      expiresOn: sas.expiresOn
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to prepare upload URL' });
  }
});

router.post('/publish/direct', ensureRole('instructor'), async (req, res) => {
  try {
    const { title, company, round, category, level, notesText, thumbnailUrl, videos, documents } = req.body;

    if (!title || !thumbnailUrl || !company || !round || !Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'title, company, round, thumbnailUrl and at least one video are required'
      });
    }

    const mappedVideos = videos.map((video, index) => ({
      title: String(video.title || `Video ${index + 1}`).trim(),
      sourceVideoUrl: String(video.videoUrl || '').trim(),
      videoUrl: String(video.videoUrl || '').trim(),
      videoStatus: 'pending',
      transcodeError: '',
      order: index
    })).filter((video) => video.sourceVideoUrl);

    if (mappedVideos.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one valid video URL is required' });
    }

    const mappedDocuments = (Array.isArray(documents) ? documents : []).map((doc, index) => ({
      title: String(doc.title || `Document ${index + 1}`).trim(),
      documentUrl: String(doc.documentUrl || '').trim(),
      documentType: String(doc.documentType || 'pdf').trim(),
      order: index
    })).filter((doc) => doc.documentUrl);

    const newCourse = new Course({
      title: String(title).trim(),
      company: String(company).trim(),
      round: String(round).trim(),
      category: category || 'general',
      level: level || 'beginner',
      notesText: String(notesText || '').trim(),
      thumbnailUrl,
      videos: mappedVideos,
      documents: mappedDocuments,
      instructor: req.user.id
    });

    await newCourse.save();
    await queueTranscodeForCourse(newCourse);

    return res.json({ success: true, course: withSignedMedia(newCourse) });
  } catch (error) {
    console.error('Direct course publish error:', error);
    return res.status(500).json({ success: false, message: 'Failed to publish course' });
  }
});

router.post('/', ensureRole('instructor'), async (req, res) => {
  try {
    const { isConfigured } = getStorageConfig();
    if (!isConfigured) {
      return res.status(503).json({
        success: false,
        message: 'Course uploads are unavailable until Azure storage is configured'
      });
    }

    const containerClient = await getOrCreateContainerClient();

    if (!req.files || !req.files.thumbnail) {
      return res.status(400).json({ success: false, message: 'No thumbnail image uploaded' });
    }

    const { title, company, round, category, level, notesText } = req.body;
    const thumbnail = req.files.thumbnail;

    if (!company || !round) {
      return res.status(400).json({
        success: false,
        message: 'company and round are required'
      });
    }

    if (thumbnail.size > MAX_THUMBNAIL_BYTES) {
      return res.status(400).json({
        success: false,
        message: `Thumbnail is too large. Max allowed size is ${MAX_THUMBNAIL_MB}MB.`
      });
    }

    const thumbnailBlobName = `thumbnail-${Date.now()}-${thumbnail.name.replace(/\s+/g, '-')}`;
    const thumbnailBlobClient = containerClient.getBlockBlobClient(thumbnailBlobName);

    await thumbnailBlobClient.uploadData(thumbnail.data, {
      blobHTTPHeaders: { blobContentType: thumbnail.mimetype }
    });

    const videos = [];
    for (const [key, value] of Object.entries(req.files)) {
      if (key.startsWith('videos[')) {
        const match = key.match(/videos\[(\d+)\]\[file\]/);
        if (match) {
          const index = match[1];
          const videoTitle = req.body[`videos[${index}][title]`];
          const videoFile = value;

          if (videoFile.size > MAX_VIDEO_BYTES) {
            return res.status(400).json({
              success: false,
              message: `Video "${videoFile.name}" is too large. Max allowed size is ${MAX_VIDEO_MB}MB.`
            });
          }

          const allowedTypes = ['video/mp4', 'video/webm', 'video/ogg'];
          if (!allowedTypes.includes(videoFile.mimetype)) {
            return res.status(400).json({
              success: false,
              message: 'Invalid file type. Only MP4, WebM or Ogg videos are allowed'
            });
          }

          const videoBlobName = `video-source-${Date.now()}-${normalizeFilename(videoFile.name)}`;
          const videoBlobClient = containerClient.getBlockBlobClient(videoBlobName);

          await videoBlobClient.uploadData(videoFile.data, {
            blobHTTPHeaders: {
              blobContentType: videoFile.mimetype,
              blobCacheControl: 'public, max-age=31536000'
            }
          });

          videos.push({
            title: videoTitle,
            sourceVideoUrl: videoBlobClient.url,
            videoUrl: videoBlobClient.url,
            videoStatus: 'pending',
            transcodeError: '',
            order: videos.length
          });
        }
      }
    }

    if (videos.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one video is required' });
    }

    // Handle document file uploads
    const documents = [];
    for (const [key, value] of Object.entries(req.files)) {
      if (key.startsWith('documents[')) {
        const match = key.match(/documents\[(\d+)\]\[file\]/);
        if (match) {
          const index = match[1];
          const docTitle = req.body[`documents[${index}][title]`];
          const docFile = value;

          const docBlobName = `documents/document-${Date.now()}-${normalizeFilename(docFile.name)}`;
          const docBlobClient = containerClient.getBlockBlobClient(docBlobName);

          await docBlobClient.uploadData(docFile.data, {
            blobHTTPHeaders: { blobContentType: docFile.mimetype }
          });

          const ext = (docFile.name || '').split('.').pop().toLowerCase();
          const typeMap = { pdf: 'pdf', ppt: 'ppt', pptx: 'pptx', doc: 'doc', docx: 'docx' };

          documents.push({
            title: docTitle || docFile.name,
            documentUrl: docBlobClient.url,
            documentType: typeMap[ext] || 'other',
            order: documents.length
          });
        }
      }
    }

    const newCourse = new Course({
      title,
      company,
      round,
      category: category || 'general',
      level: level || 'beginner',
      notesText: String(notesText || '').trim(),
      thumbnailUrl: thumbnailBlobClient.url,
      videos,
      documents,
      instructor: req.user.id
    });

    await newCourse.save();
    await queueTranscodeForCourse(newCourse);

    return res.json({ success: true, course: withSignedMedia(newCourse) });
  } catch (error) {
    console.error('Course creation error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create course' });
  }
});

router.get('/', async (req, res) => {
  try {
    const {
      q = '',
      category,
      level,
      company,
      round,
      minRating,
      sort = 'newest'
    } = req.query;

    const filter = {};

    if (q) {
      filter.$or = [
        { title: { $regex: q, $options: 'i' } },
        { category: { $regex: q, $options: 'i' } }
      ];
    }

    if (company && company !== 'all') {
      filter.company = company;
    }

    if (round && round !== 'all') {
      filter.round = round;
    }

    if (category && category !== 'all') {
      filter.category = category;
    }

    if (level && level !== 'all') {
      filter.level = level;
    }

    if (minRating) {
      filter.averageRating = { $gte: Number(minRating) || 0 };
    }

    const sortMap = {
      newest: { createdAt: -1 },
      'top-rated': { averageRating: -1, ratingsCount: -1 },
      popular: { 'studentsEnrolled.length': -1 }
    };

    const courses = await Course.find(filter)
      .populate('instructor', 'email')
      .sort(sortMap[sort] || sortMap.newest);

    const sortedCourses = sort === 'popular'
      ? courses.sort((a, b) => (b.studentsEnrolled.length || 0) - (a.studentsEnrolled.length || 0))
      : courses;

    return res.json({ success: true, courses: sortedCourses.map(withSignedMedia) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/my-courses/analytics', ensureRole('instructor'), async (req, res) => {
  try {
    const courses = await Course.find({ instructor: req.user.id })
      .populate('studentsEnrolled', 'videoProgress')
      .lean();

    let totalEnrollments = 0;
    let completionSamples = 0;
    let completedCount = 0;

    const topCourses = courses.map((course) => {
      const enrolled = course.studentsEnrolled?.length || 0;
      totalEnrollments += enrolled;

      let courseCompleted = 0;
      for (const student of course.studentsEnrolled || []) {
        const progress = (student.videoProgress || []).find(
          (item) => String(item.courseId) === String(course._id)
        );

        if (progress) {
          completionSamples += 1;
          if (progress.completed) {
            completedCount += 1;
            courseCompleted += 1;
          }
        }
      }

      const completionRate = enrolled ? Math.round((courseCompleted / enrolled) * 100) : 0;

      return {
        courseId: course._id,
        title: course.title,
        enrollments: enrolled,
        completionRate,
        averageRating: course.averageRating || 0,
        ratingsCount: course.ratingsCount || 0
      };
    }).sort((a, b) => b.enrollments - a.enrollments);

    return res.json({
      success: true,
      analytics: {
        totalCourses: courses.length,
        totalEnrollments,
        completionRate: completionSamples ? Math.round((completedCount / completionSamples) * 100) : 0,
        averageCourseRating: courses.length
          ? Number((courses.reduce((sum, c) => sum + (c.averageRating || 0), 0) / courses.length).toFixed(2))
          : 0,
        topCourses: topCourses.slice(0, 5)
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/my-courses', ensureRole('instructor'), async (req, res) => {
  try {
    const courses = await Course.find({ instructor: req.user.id })
      .populate('studentsEnrolled', 'email')
      .lean();

    return res.json({ success: true, courses: courses.map(withSignedMedia) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/enroll/:courseId', ensureRole('student'), async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    const user = await User.findById(req.user.id);

    if (!course || !user) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    if (user.enrolledCourses.some((id) => id.toString() === course._id.toString())) {
      return res.status(400).json({ success: false, message: 'Already enrolled' });
    }

    user.enrolledCourses.push(course._id);
    course.studentsEnrolled.push(user._id);

    await user.save();
    await course.save();

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/enrolled', ensureRole('student'), async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate({
      path: 'enrolledCourses',
      populate: { path: 'instructor', select: 'email' }
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const coursesWithProgress = user.enrolledCourses.map((course) => {
      const progress = user.videoProgress.find(
        (item) => item.courseId.toString() === course._id.toString()
      );

      const playbackPositions = user.playbackPositions
        .filter((item) => item.courseId.toString() === course._id.toString())
        .map((item) => ({
          videoId: item.videoId,
          positionSeconds: item.positionSeconds,
          durationSeconds: item.durationSeconds,
          updatedAt: item.updatedAt
        }));

      const signedCourse = withSignedMedia(course);

      return {
        ...signedCourse,
        watchedVideos: (progress?.watchedVideos || []).map((item) => String(item.videoId)),
        isCompleted: progress?.completed || false,
        playbackPositions
      };
    });

    return res.json({ success: true, courses: coursesWithProgress });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.patch('/:id', ensureRole('instructor'), async (req, res) => {
  try {
    const { title, company, round, category, level, notesText, videos, documents } = req.body;
    const course = await Course.findById(req.params.id);

    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    if (String(course.instructor) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    if (title && title.trim()) {
      course.title = title.trim();
    }

    if (company && ['tcs', 'cognizant', 'infosys_finacle', 'embedur'].includes(company)) {
      course.company = company;
    }

    if (round && round.trim()) {
      course.round = round.trim();
    }

    if (category && category.trim()) {
      course.category = category.trim();
    }

    if (level && ['beginner', 'intermediate', 'advanced'].includes(level)) {
      course.level = level;
    }

    if (typeof notesText === 'string') {
      course.notesText = notesText.trim();
    }

    if (Array.isArray(documents)) {
      course.documents = documents.map((doc, index) => ({
        ...doc,
        order: index
      }));
    }

    if (Array.isArray(videos) && videos.length) {
      const updatesById = new Map(videos.map((video, index) => [String(video._id), { ...video, order: index }]));
      course.videos = course.videos
        .map((video) => {
          const update = updatesById.get(String(video._id));
          if (!update) {
            return video;
          }

          video.title = update.title?.trim() || video.title;
          video.order = update.order;
          return video;
        })
        .sort((a, b) => (a.order || 0) - (b.order || 0));
    }

    await course.save();

    return res.json({ success: true, course: withSignedMedia(course) });
  } catch (error) {
    console.error('Course update error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update course' });
  }
});

router.post('/:courseId/tutor-chat', tutorLimiter, ensureRole('student', 'instructor', 'admin'), async (req, res) => {
  try {
    const { courseId } = req.params;
    const message = String(req.body?.message || '').trim();
    if (!message) {
      return res.status(400).json({ success: false, message: 'message is required' });
    }

    const course = await Course.findById(courseId)
      .select('title notesText instructor studentsEnrolled')
      .lean();

    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    const isInstructor = String(course.instructor) === String(req.user.id);
    const isEnrolled = (course.studentsEnrolled || []).some(
      (studentId) => String(studentId) === String(req.user.id)
    );
    const isAdmin = req.user.role === 'admin';

    if (!isInstructor && !isEnrolled && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Only enrolled students can use this tutor' });
    }

    const lyzrConfig = getLyzrConfig();
    if (!lyzrConfig.enabled) {
      return res.status(503).json({ success: false, message: 'Tutor is unavailable right now' });
    }

    const result = await sendTutorMessage({
      userId: req.user.id,
      userEmail: req.user.email,
      courseId,
      courseTitle: course.title,
      notesText: course.notesText || '',
      studentMessage: message
    });

    return res.json({
      success: true,
      reply: result.reply
    });
  } catch (error) {
    console.error('Tutor chat error:', error);
    return res.status(500).json({ success: false, message: 'Failed to get tutor response' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate('instructor', 'email')
      .populate('studentsEnrolled', 'email');

    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    return res.json({ success: true, course: withSignedMedia(course) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/status/:id', ensureRole('instructor'), async (req, res) => {
  try {
    const course = await Course.findById(req.params.id).select('instructor videos title');
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    if (String(course.instructor) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const videos = (course.videos || [])
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((video) => ({
        id: video._id,
        title: video.title,
        status: video.videoStatus || 'pending',
        transcodeError: video.transcodeError || ''
      }));

    const allReady = videos.length > 0 && videos.every((video) => video.status === 'ready');
    const hasFailure = videos.some((video) => video.status === 'failed');

    return res.json({
      success: true,
      courseId: course._id,
      title: course.title,
      status: allReady ? 'ready' : hasFailure ? 'failed' : 'processing',
      videos
    });
  } catch (_) {
    return res.status(500).json({ success: false, message: 'Failed to load publish status' });
  }
});

router.post('/:courseId/videos/:videoId/watch', ensureRole('student'), async (req, res) => {
  try {
    const { courseId, videoId } = req.params;
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    let videoProgress = user.videoProgress.find((progress) => progress.courseId.toString() === courseId);

    if (!videoProgress) {
      user.videoProgress.push({ courseId, watchedVideos: [] });
      videoProgress = user.videoProgress[user.videoProgress.length - 1];
    }

    const alreadyWatched = videoProgress.watchedVideos.some(
      (video) => video.videoId.toString() === videoId
    );

    if (!alreadyWatched) {
      videoProgress.watchedVideos.push({ videoId });

      const course = await Course.findById(courseId);
      if (course && videoProgress.watchedVideos.length >= course.videos.length) {
        videoProgress.completed = true;
        videoProgress.completedAt = new Date();
      }

      await user.save();
    }

    return res.json({
      success: true,
      watchedVideos: videoProgress.watchedVideos.map((video) => String(video.videoId)),
      completed: videoProgress.completed
    });
  } catch (error) {
    console.error('Video progress error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update video progress' });
  }
});

router.post('/:courseId/videos/:videoId/playback', ensureRole('student'), async (req, res) => {
  try {
    const { courseId, videoId } = req.params;
    const { positionSeconds = 0, durationSeconds = 0 } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const validPosition = Math.max(0, Number(positionSeconds) || 0);
    const validDuration = Math.max(0, Number(durationSeconds) || 0);

    const existing = user.playbackPositions.find(
      (item) => item.courseId.toString() === courseId && item.videoId.toString() === videoId
    );

    if (existing) {
      existing.positionSeconds = validPosition;
      existing.durationSeconds = validDuration;
      existing.updatedAt = new Date();
    } else {
      user.playbackPositions.push({
        courseId,
        videoId,
        positionSeconds: validPosition,
        durationSeconds: validDuration,
        updatedAt: new Date()
      });
    }

    await user.save();

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to save playback position' });
  }
});

router.post('/:courseId/reviews', ensureRole('student'), async (req, res) => {
  try {
    const { courseId } = req.params;
    const { rating, comment = '' } = req.body;

    const numericRating = Number(rating);
    if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
    }

    const user = await User.findById(req.user.id).select('enrolledCourses');
    if (!user || !user.enrolledCourses.some((id) => String(id) === courseId)) {
      return res.status(403).json({ success: false, message: 'Only enrolled students can review this course' });
    }

    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    const existingReview = course.reviews.find((review) => String(review.user) === req.user.id);
    if (existingReview) {
      existingReview.rating = numericRating;
      existingReview.comment = comment.trim();
      existingReview.updatedAt = new Date();
    } else {
      course.reviews.push({
        user: req.user.id,
        rating: numericRating,
        comment: comment.trim()
      });
    }

    recalculateRatings(course);
    await course.save();

    return res.json({ success: true, course: withSignedMedia(course) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to submit review' });
  }
});

module.exports = router;
