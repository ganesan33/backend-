const express = require('express');
const Course = require('../models/Course');
const User = require('../models/User');
const InstructorRequest = require('../models/InstructorRequest');
const { ensureRole } = require('../middleware/auth');
const { getContainerClient, signBlobReadUrl } = require('../utils/storage');
const { sendEmail } = require('../utils/mailer');

const router = express.Router();

function withSignedMedia(course) {
  const plainCourse = typeof course.toObject === 'function' ? course.toObject() : { ...course };

  return {
    ...plainCourse,
    thumbnailUrl: signBlobReadUrl(plainCourse.thumbnailUrl),
    videos: (plainCourse.videos || []).map((video) => ({
      ...video,
      sourceVideoUrl: signBlobReadUrl(video.sourceVideoUrl || video.videoUrl),
      videoUrl: signBlobReadUrl(video.videoUrl)
    }))
  };
}

router.get('/courses', ensureRole('admin'), async (req, res) => {
  try {
    const courses = await Course.find().populate('instructor', 'email');
    return res.json({ success: true, courses: courses.map(withSignedMedia) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load courses' });
  }
});

router.get('/analytics', ensureRole('admin'), async (req, res) => {
  try {
    const [
      totalUsers,
      totalStudents,
      totalInstructors,
      totalAdmins,
      totalCourses,
      courses
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ role: 'student' }),
      User.countDocuments({ role: 'instructor' }),
      User.countDocuments({ role: 'admin' }),
      Course.countDocuments(),
      Course.find().select('studentsEnrolled averageRating ratingsCount').lean()
    ]);

    const totalEnrollments = courses.reduce((sum, course) => sum + (course.studentsEnrolled?.length || 0), 0);
    const averageRating = courses.length
      ? Number((courses.reduce((sum, course) => sum + (course.averageRating || 0), 0) / courses.length).toFixed(2))
      : 0;
    const totalReviews = courses.reduce((sum, course) => sum + (course.ratingsCount || 0), 0);

    return res.json({
      success: true,
      analytics: {
        users: {
          total: totalUsers,
          students: totalStudents,
          instructors: totalInstructors,
          admins: totalAdmins
        },
        courses: {
          total: totalCourses,
          totalEnrollments,
          averageRating,
          totalReviews
        }
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load analytics' });
  }
});

router.get('/instructor-requests', ensureRole('admin'), async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const allowedStatuses = ['pending', 'approved', 'rejected', 'all'];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status filter' });
    }

    const filter = status === 'all' ? {} : { status };

    const requests = await InstructorRequest.find(filter)
      .populate('user', 'email role')
      .populate('reviewedBy', 'email')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, requests });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load instructor requests' });
  }
});

router.patch('/instructor-requests/:id', ensureRole('admin'), async (req, res) => {
  try {
    const { action, reviewNotes = '' } = req.body;
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action must be approve or reject' });
    }

    const request = await InstructorRequest.findById(req.params.id).populate('user', 'email role');
    if (!request) {
      return res.status(404).json({ success: false, message: 'Instructor request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Only pending requests can be reviewed' });
    }

    const isApprove = action === 'approve';

    request.status = isApprove ? 'approved' : 'rejected';
    request.reviewNotes = reviewNotes.trim();
    request.reviewedBy = req.user.id;
    request.reviewedAt = new Date();
    await request.save();

    if (isApprove && request.user && request.user.role !== 'instructor') {
      await User.findByIdAndUpdate(request.user._id, { role: 'instructor' });
    }

    if (request.user?.email) {
      const subject = isApprove
        ? 'Your EduFlow instructor application is approved'
        : 'Update on your EduFlow instructor application';
      const text = isApprove
        ? 'Congratulations. Your instructor application has been approved and your account is now upgraded.'
        : `Your instructor application was not approved at this time.${request.reviewNotes ? ` Reviewer notes: ${request.reviewNotes}` : ''}`;

      try {
        await sendEmail({
          to: request.user.email,
          subject,
          text,
          html: `<p>${text}</p>`
        });
      } catch (emailError) {
        console.error('Instructor decision email error:', emailError.message || emailError);
      }
    }

    return res.json({
      success: true,
      message: isApprove ? 'Instructor request approved' : 'Instructor request rejected',
      request
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to review instructor request' });
  }
});

router.delete('/courses/:id', ensureRole('admin'), async (req, res) => {
  try {
    const containerClient = getContainerClient();
    const course = await Course.findById(req.params.id);
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    if (containerClient && course.thumbnailUrl) {
      const thumbnailBlobName = course.thumbnailUrl.split('/').pop();
      try {
        await containerClient.getBlockBlobClient(thumbnailBlobName).delete();
      } catch (blobError) {
        console.error('Thumbnail blob deletion error:', blobError);
      }
    }

    for (const video of course.videos) {
      if (!containerClient) {
        continue;
      }

      if (video.videoUrl) {
        const videoBlobName = video.videoUrl.split('/').pop();
        try {
          await containerClient.getBlockBlobClient(videoBlobName).delete();
        } catch (blobError) {
          console.error('Video blob deletion error:', blobError);
        }
      }
    }

    await Course.deleteOne({ _id: req.params.id });

    return res.json({ success: true });
  } catch (error) {
    console.error('Course deletion error:', error);
    return res.status(500).json({ success: false, message: 'Deletion failed' });
  }
});

module.exports = router;
