const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

function isTranscodingEnabled() {
  const flag = (process.env.VIDEO_TRANSCODE_ENABLED || 'true').toLowerCase();
  return flag !== 'false' && flag !== '0' && flag !== 'no';
}

function getFfmpegCommand() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function randomName(prefix, ext) {
  const suffix = crypto.randomBytes(8).toString('hex');
  return `${prefix}-${Date.now()}-${suffix}${ext}`;
}

async function cleanupFiles(paths) {
  await Promise.all(
    paths.map(async (filePath) => {
      if (!filePath) {
        return;
      }
      try {
        await fs.unlink(filePath);
      } catch (_) {
        // Ignore cleanup errors.
      }
    })
  );
}

function runFfmpeg(inputPath, outputPath) {
  const ffmpegCommand = getFfmpegCommand();

  // Stream-friendly MP4 output for better first-play stability on mobile.
  const args = [
    '-y',
    '-i',
    inputPath,
    '-c:v',
    'libx264',
    '-preset',
    process.env.VIDEO_TRANSCODE_PRESET || 'veryfast',
    '-crf',
    process.env.VIDEO_TRANSCODE_CRF || '23',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-c:a',
    'aac',
    '-b:a',
    process.env.VIDEO_AUDIO_BITRATE || '128k',
    '-ac',
    '2',
    '-ar',
    '48000',
    outputPath
  ];

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegCommand, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';

    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on('error', (error) => {
      reject(error);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
    });
  });
}

async function transcodeVideoToMp4(videoFile) {
  if (!isTranscodingEnabled()) {
    return {
      data: videoFile.data,
      filename: videoFile.name,
      mimetype: videoFile.mimetype,
      transcoded: false
    };
  }

  const tempDir = os.tmpdir();
  const inputExt = path.extname(videoFile.name || '') || '.bin';
  const inputPath = path.join(tempDir, randomName('eduflow-upload', inputExt));
  const outputPath = path.join(tempDir, randomName('eduflow-output', '.mp4'));

  try {
    await fs.writeFile(inputPath, videoFile.data);
    await runFfmpeg(inputPath, outputPath);

    const transcodedData = await fs.readFile(outputPath);
    const baseName = path.parse(videoFile.name || 'video').name;

    return {
      data: transcodedData,
      filename: `${baseName}.mp4`,
      mimetype: 'video/mp4',
      transcoded: true
    };
  } catch (error) {
    console.warn('Video transcode fallback to original file:', error.message || error);

    return {
      data: videoFile.data,
      filename: videoFile.name,
      mimetype: videoFile.mimetype,
      transcoded: false
    };
  } finally {
    await cleanupFiles([inputPath, outputPath]);
  }
}

module.exports = {
  transcodeVideoToMp4
};
