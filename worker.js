const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { Worker } = require('bullmq');
const Course = require('./models/Course');
const connectDB = require('./config/db');
const { getOrCreateContainerClient, getBlobNameFromUrl } = require('./utils/storage');
const { transcodeVideoToMp4 } = require('./utils/video_processing');
const { QUEUE_NAME, getRedisConfig } = require('./queues/videoTranscodeQueue');

async function processJob(job) {
  const { courseId, videoId } = job.data;
  const course = await Course.findById(courseId);

  if (!course) {
    return;
  }

  const video = course.videos.id(videoId);
  if (!video) {
    return;
  }

  const sourceUrl = video.sourceVideoUrl || video.videoUrl;
  if (!sourceUrl) {
    video.videoStatus = 'failed';
    video.transcodeError = 'Missing source video URL';
    await course.save();
    return;
  }

  video.videoStatus = 'processing';
  video.transcodeError = '';
  await course.save();

  try {
    const containerClient = await getOrCreateContainerClient();
    if (!containerClient) {
      throw new Error('Azure storage is not configured');
    }

    const sourceBlobName = getBlobNameFromUrl(sourceUrl);
    if (!sourceBlobName) {
      throw new Error('Invalid source video URL');
    }

    const sourceBlobClient = containerClient.getBlockBlobClient(sourceBlobName);
    const downloadResponse = await sourceBlobClient.download();
    const chunks = [];

    for await (const chunk of downloadResponse.readableStreamBody) {
      chunks.push(chunk);
    }

    const sourceBuffer = Buffer.concat(chunks);
    const processed = await transcodeVideoToMp4({
      data: sourceBuffer,
      name: `${video.title || 'video'}.mp4`,
      mimetype: 'video/mp4'
    });

    const outputBlobName = `video-ready-${Date.now()}-${video._id}.mp4`;
    const outputBlobClient = containerClient.getBlockBlobClient(outputBlobName);

    await outputBlobClient.uploadData(processed.data, {
      blobHTTPHeaders: {
        blobContentType: 'video/mp4',
        blobCacheControl: 'public, max-age=31536000'
      }
    });

    video.videoUrl = outputBlobClient.url;
    video.videoStatus = 'ready';
    video.transcodeError = '';
    await course.save();
  } catch (error) {
    video.videoStatus = 'failed';
    video.transcodeError = error.message || 'Transcode failed';
    await course.save();
    throw error;
  }
}

async function startWorker() {
  const redisConfig = getRedisConfig();
  if (!redisConfig) {
    throw new Error('REDIS_URL is required for worker');
  }

  await connectDB();

  const worker = new Worker(QUEUE_NAME, processJob, redisConfig);

  worker.on('completed', (job) => {
    console.log(`[worker] completed job ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[worker] failed job ${job?.id}:`, err.message || err);
  });

  console.log('[worker] video transcode worker started');
}

startWorker().catch((error) => {
  console.error('[worker] startup failed:', error);
  process.exit(1);
});
