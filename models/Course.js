const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  sourceVideoUrl: {
    type: String,
    default: ''
  },
  videoUrl: {
    type: String,
    required: true
  },
  videoStatus: {
    type: String,
    enum: ['pending', 'processing', 'ready', 'failed'],
    default: 'pending'
  },
  transcodeError: {
    type: String,
    default: ''
  },
  order: {
    type: Number,
    default: 0
  }
});

const documentSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  documentUrl: {
    type: String,
    required: true
  },
  documentType: {
    type: String,
    enum: ['pdf', 'ppt', 'pptx', 'doc', 'docx', 'other'],
    default: 'pdf'
  },
  order: {
    type: Number,
    default: 0
  }
});

const reviewSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  rating: {
    type: Number,
    min: 1,
    max: 5,
    required: true
  },
  comment: {
    type: String,
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const courseSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  company: {
    type: String,
    enum: ['tcs', 'cognizant', 'infosys_finacle', 'embedur'],
    required: true
  },
  round: {
    type: String,
    required: true
  },
  category: {
    type: String,
    default: 'general'
  },
  level: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced'],
    default: 'beginner'
  },
  notesText: {
    type: String,
    default: ''
  },
  thumbnailUrl: {
    type: String,
    required: true
  },
  videos: [videoSchema],
  documents: [documentSchema],
  instructor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  studentsEnrolled: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  reviews: [reviewSchema],
  averageRating: {
    type: Number,
    default: 0
  },
  ratingsCount: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Course', courseSchema);
