const express = require('express');
const InstructorRequest = require('../models/InstructorRequest');
const User = require('../models/User');
const { ensureAuth, ensureRole } = require('../middleware/auth');

const router = express.Router();

router.get('/me', ensureAuth, async (req, res) => {
  try {
    const request = await InstructorRequest.findOne({ user: req.user.id })
      .populate('reviewedBy', 'email')
      .lean();

    return res.json({ success: true, request: request || null });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load instructor request' });
  }
});

router.post('/', ensureRole('student'), async (req, res) => {
  try {
    const {
      headline,
      experienceYears,
      expertise,
      motivation,
      portfolioUrl = ''
    } = req.body;

    if (!headline || !expertise || !motivation) {
      return res.status(400).json({
        success: false,
        message: 'Headline, expertise and motivation are required'
      });
    }

    const user = await User.findById(req.user.id).select('role');
    if (!user || user.role !== 'student') {
      return res.status(403).json({ success: false, message: 'Only students can submit an instructor request' });
    }

    const existing = await InstructorRequest.findOne({ user: req.user.id });
    if (existing?.status === 'pending') {
      return res.status(400).json({ success: false, message: 'An instructor request is already pending review' });
    }

    const normalizedPayload = {
      headline: headline.trim(),
      experienceYears: Number(experienceYears) || 0,
      expertise: expertise.trim(),
      motivation: motivation.trim(),
      portfolioUrl: portfolioUrl.trim(),
      status: 'pending',
      reviewedBy: null,
      reviewedAt: null,
      reviewNotes: ''
    };

    let request;
    if (existing) {
      Object.assign(existing, normalizedPayload);
      request = await existing.save();
    } else {
      request = await InstructorRequest.create({
        user: req.user.id,
        ...normalizedPayload
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Instructor application submitted successfully',
      request
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to submit instructor request' });
  }
});

module.exports = router;
