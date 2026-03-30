const jwt = require('jsonwebtoken');
const User = require('../models/User');

function getAccessToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return req.cookies?.access_token || null;
}

const ensureAuth = async (req, res, next) => {
  const token = getAccessToken(req);

  if (!token) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const user = await User.findById(decoded.sub).select('email role tokenVersion emailVerified').lean();

    if (!user || user.tokenVersion !== decoded.tv) {
      return res.status(401).json({ success: false, message: 'Token revoked' });
    }

    req.user = {
      id: String(decoded.sub),
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
      emailVerified: user.emailVerified
    };

    return next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

const ensureRole = (...roles) => async (req, res, next) => {
  await ensureAuth(req, res, () => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    return next();
  });
};

module.exports = { ensureAuth, ensureRole };
