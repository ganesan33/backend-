const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { ensureAuth } = require('../middleware/auth');
const { sendEmail } = require('../utils/mailer');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth requests. Try again later.' }
});

router.use(['/login', '/signup', '/refresh'], authLimiter);

const emailFlowLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Try again later.' }
});

router.use(['/verify-email/request', '/password-reset/request'], emailFlowLimiter);

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateOneTimeToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function trySendEmail(emailPayload) {
  try {
    const timeoutMs = Number(process.env.SMTP_SEND_TIMEOUT_MS || 20000);
    const result = await Promise.race([
      sendEmail(emailPayload),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Email send timeout')), timeoutMs);
      })
    ]);
    const acceptedCount = Array.isArray(result.accepted) ? result.accepted.length : 0;
    if (acceptedCount > 0) {
      return true;
    }
    return false;
  } catch (error) {
    console.error('Email delivery error:', error.message || error);
    return false;
  }
}

function buildCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  };
}

function generateAccessToken(user) {
  return jwt.sign({
    sub: String(user._id),
    email: user.email,
    role: user.role,
    tv: user.tokenVersion
  }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m'
  });
}

function generateRefreshToken(user) {
  return jwt.sign({
    sub: String(user._id),
    tv: user.tokenVersion,
    type: 'refresh'
  }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d'
  });
}

async function issueAuthCookies(res, userDoc) {
  const accessToken = generateAccessToken(userDoc);
  const refreshToken = generateRefreshToken(userDoc);

  await User.findByIdAndUpdate(userDoc._id, {
    refreshTokenHash: hashToken(refreshToken)
  });

  const cookieOptions = buildCookieOptions();
  res.cookie('access_token', accessToken, {
    ...cookieOptions,
    maxAge: 15 * 60 * 1000
  });
  res.cookie('refresh_token', refreshToken, {
    ...cookieOptions,
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  return { accessToken, refreshToken };
}

function clearAuthCookies(res) {
  const cookieOptions = buildCookieOptions();
  res.clearCookie('access_token', cookieOptions);
  res.clearCookie('refresh_token', cookieOptions);
}

function getRefreshToken(req) {
  if (req.cookies?.refresh_token) {
    return req.cookies.refresh_token;
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  if (typeof req.body?.refreshToken === 'string' && req.body.refreshToken.trim()) {
    return req.body.refreshToken.trim();
  }

  return null;
}

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid credentials' });
    }

    if (!user.emailVerified) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email before signing in'
      });
    }

    const tokens = await issueAuthCookies(res, user);

    return res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/signup', async (req, res) => {
  try {
    const { email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Email already exists' });
    }

    const user = new User({
      email,
      password,
      role: 'student',
      emailVerified: false
    });

    await user.save();

    const token = generateOneTimeToken();
    user.emailVerificationTokenHash = hashToken(token);
    user.emailVerificationExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await user.save();

    const emailSent = await trySendEmail({
      to: user.email,
      subject: 'Verify your EduFlow email',
      text: `Welcome to EduFlow. Use this verification code in the mobile app: ${token}. This code expires in 30 minutes.`,
      html: `<p>Welcome to EduFlow.</p><p>Use this verification code in the mobile app:</p><p><strong>${token}</strong></p><p>This code expires in 30 minutes.</p>`
    });

    return res.status(201).json({
      success: true,
      message: emailSent
        ? 'Signup successful. Verification email sent. Please check inbox, spam, or promotions.'
        : 'Signup successful. Verification email could not be sent right now. Please use resend verification after SMTP is available.'
    });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/verify-email/request', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const user = await User.findOne({ email });
    if (!user || user.emailVerified) {
      return res.json({ success: true, message: 'If the account exists, a verification email has been sent.' });
    }

    const token = generateOneTimeToken();
    user.emailVerificationTokenHash = hashToken(token);
    user.emailVerificationExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await user.save();

    const emailSent = await trySendEmail({
      to: user.email,
      subject: 'Verify your EduFlow email',
      text: `Use this verification code in the mobile app: ${token}. This code expires in 30 minutes.`,
      html: `<p>Use this verification code in the mobile app:</p><p><strong>${token}</strong></p><p>This code expires in 30 minutes.</p>`
    });

    return res.json({
      success: true,
      message: emailSent
        ? 'If the account exists, a verification email has been sent. Check inbox, spam, or promotions.'
        : 'If the account exists, we could not send email right now. Please try again shortly.'
    });
  } catch (error) {
    console.error('Verify email request error:', error);
    return res.status(500).json({ success: false, message: 'Failed to process request' });
  }
});

router.post('/verify-email/confirm', async (req, res) => {
  try {
    const { email, token } = req.body;

    if (!email || !token) {
      return res.status(400).json({ success: false, message: 'Email and token are required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid verification request' });
    }

    if (user.emailVerified) {
      return res.json({ success: true, message: 'Email already verified' });
    }

    const tokenHash = hashToken(token);
    const tokenValid = user.emailVerificationTokenHash
      && user.emailVerificationTokenHash === tokenHash
      && user.emailVerificationExpiresAt
      && user.emailVerificationExpiresAt > new Date();

    if (!tokenValid) {
      return res.status(400).json({ success: false, message: 'Invalid or expired verification token' });
    }

    user.emailVerified = true;
    user.emailVerificationTokenHash = null;
    user.emailVerificationExpiresAt = null;
    await user.save();

    const tokens = await issueAuthCookies(res, user);

    return res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    });
  } catch (error) {
    console.error('Verify email confirm error:', error);
    return res.status(500).json({ success: false, message: 'Failed to verify email' });
  }
});

router.post('/password-reset/request', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.json({ success: true, message: 'If the account exists, a reset email has been sent.' });
    }

    const token = generateOneTimeToken();
    user.passwordResetTokenHash = hashToken(token);
    user.passwordResetExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await user.save();

    const emailSent = await trySendEmail({
      to: user.email,
      subject: 'Reset your EduFlow password',
      text: `You requested a password reset. Use this reset code in the mobile app: ${token}. This code expires in 30 minutes.`,
      html: `<p>You requested a password reset.</p><p>Use this reset code in the mobile app:</p><p><strong>${token}</strong></p><p>This code expires in 30 minutes.</p>`
    });

    return res.json({
      success: true,
      message: emailSent
        ? 'If the account exists, a reset email has been sent. Check inbox, spam, or promotions.'
        : 'If the account exists, we could not send email right now. Please try again shortly.'
    });
  } catch (error) {
    console.error('Password reset request error:', error);
    return res.status(500).json({ success: false, message: 'Failed to process request' });
  }
});

router.post('/password-reset/confirm', async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;

    if (!email || !token || !newPassword) {
      return res.status(400).json({ success: false, message: 'Email, token and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid reset request' });
    }

    const tokenHash = hashToken(token);
    const tokenValid = user.passwordResetTokenHash
      && user.passwordResetTokenHash === tokenHash
      && user.passwordResetExpiresAt
      && user.passwordResetExpiresAt > new Date();

    if (!tokenValid) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
    }

    user.password = newPassword;
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    await user.save();

    return res.json({ success: true, message: 'Password reset successful. Please sign in.' });
  } catch (error) {
    console.error('Password reset confirm error:', error);
    return res.status(500).json({ success: false, message: 'Failed to reset password' });
  }
});

router.get('/me', ensureAuth, (req, res) => {
  return res.json({ success: true, user: req.user });
});

router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = getRefreshToken(req);

    if (!refreshToken) {
      return res.status(401).json({ success: false, message: 'Missing refresh token' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    if (decoded.type !== 'refresh') {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }

    const user = await User.findById(decoded.sub).select('email role tokenVersion refreshTokenHash emailVerified');
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }

    if (user.tokenVersion !== decoded.tv || user.refreshTokenHash !== hashToken(refreshToken)) {
      return res.status(401).json({ success: false, message: 'Refresh token revoked' });
    }

    const tokens = await issueAuthCookies(res, user);

    return res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    });
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
  }
});

router.post('/logout', async (req, res) => {
  const refreshToken = getRefreshToken(req);

  if (refreshToken) {
    try {
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      await User.findByIdAndUpdate(decoded.sub, { refreshTokenHash: null });
    } catch (error) {
      // Ignore invalid refresh token and still clear cookies.
    }
  }

  clearAuthCookies(res);
  return res.json({ success: true, message: 'Logged out successfully' });
});

module.exports = router;
