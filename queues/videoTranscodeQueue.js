const { Queue } = require('bullmq');

const QUEUE_NAME = 'video-transcode';

let sharedQueue = null;

function getRedisConfig() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return null;
  }

  return {
    connection: {
      url: redisUrl,
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    }
  };
}

function getVideoTranscodeQueue() {
  const redisConfig = getRedisConfig();
  if (!redisConfig) {
    return null;
  }

  if (!sharedQueue) {
    sharedQueue = new Queue(QUEUE_NAME, redisConfig);
  }

  return sharedQueue;
}

async function enqueueVideoTranscodeJob(payload) {
  const queue = getVideoTranscodeQueue();
  if (!queue) {
    return false;
  }

  await queue.add('transcode', payload, {
    removeOnComplete: 1000,
    removeOnFail: 1000,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    }
  });

  return true;
}

module.exports = {
  QUEUE_NAME,
  getRedisConfig,
  getVideoTranscodeQueue,
  enqueueVideoTranscodeJob
};
