const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Invalid email']
  },
  password: {
    type: String,
    required: true,
    minlength: 8
  },
  role: {
    type: String,
    enum: ['student', 'instructor', 'admin'],
    default: 'student'
  },
  emailVerified: {
    type: Boolean,
    default: false
  },
  emailVerificationTokenHash: {
    type: String,
    default: null
  },
  emailVerificationExpiresAt: {
    type: Date,
    default: null
  },
  passwordResetTokenHash: {
    type: String,
    default: null
  },
  passwordResetExpiresAt: {
    type: Date,
    default: null
  },
  tokenVersion: {
    type: Number,
    default: 0
  },
  refreshTokenHash: {
    type: String,
    default: null
  },
  enrolledCourses: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course'
  }],
  videoProgress: [{
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true
    },
    watchedVideos: [{
      videoId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
      },
      watchedAt: {
        type: Date,
        default: Date.now
      }
    }],
    completed: {
      type: Boolean,
      default: false
    },
    completedAt: Date
  }],
  playbackPositions: [{
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true
    },
    videoId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true
    },
    positionSeconds: {
      type: Number,
      default: 0
    },
    durationSeconds: {
      type: Number,
      default: 0
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  }],
  createdAt: {
    type: Date,
    default: Date.now
  }
});

userSchema.pre('save', async function onSave(next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);

    if (!this.isNew) {
      this.tokenVersion += 1;
      this.refreshTokenHash = null;
    }
  }
  next();
});

module.exports = mongoose.model('User', userSchema);
