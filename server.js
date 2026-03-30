const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const express = require('express');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const connectDB = require('./config/db');

const authRoutes = require('./routes/auth');
const courseRoutes = require('./routes/courses');
const adminRoutes = require('./routes/admin');
const instructorRequestRoutes = require('./routes/instructorRequests');
const { verifyMailTransport } = require('./utils/mailer');

const app = express();

// Render runs behind a reverse proxy, so trust X-Forwarded-* headers.
app.set('trust proxy', 1);

if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET) {
  throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set in environment variables.');
}

connectDB();

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(fileUpload({
  limits: { fileSize: 500 * 1024 * 1024 },
  abortOnLimit: true,
  useTempFiles: false,
  tempFileDir: '/tmp/'
}));

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'EduFlow backend is running' });
});

app.use('/api/auth', authRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/instructor-requests', instructorRequestRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);

  // Non-blocking startup check so production logs show SMTP readiness/errors.
  verifyMailTransport()
    .then((result) => {
      if (result.ok) {
        console.log(`[MAIL] ${result.reason}`);
      } else {
        console.warn(`[MAIL] ${result.reason}`);
      }
    })
    .catch((error) => {
      console.warn(`[MAIL] SMTP verification check failed: ${error?.message || error}`);
    });
});
