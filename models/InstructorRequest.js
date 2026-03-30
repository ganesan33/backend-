const mongoose = require('mongoose');

const instructorRequestSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  headline: {
    type: String,
    required: true,
    trim: true
  },
  experienceYears: {
    type: Number,
    required: true,
    min: 0,
    max: 60
  },
  expertise: {
    type: String,
    required: true,
    trim: true
  },
  motivation: {
    type: String,
    required: true,
    trim: true
  },
  portfolioUrl: {
    type: String,
    default: '',
    trim: true
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  reviewedAt: {
    type: Date,
    default: null
  },
  reviewNotes: {
    type: String,
    default: '',
    trim: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('InstructorRequest', instructorRequestSchema);
