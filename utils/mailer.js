const nodemailer = require('nodemailer');

function getMailConfig() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user || 'EduFlow <no-reply@example.com>';

  return {
    host,
    port,
    user,
    pass,
    from,
    isConfigured: Boolean(user && pass)
  };
}

function buildTransporter() {
  const config = getMailConfig();

  if (!config.isConfigured) {
    return null;
  }

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 15000),
    auth: {
      user: config.user,
      pass: config.pass
    }
  });
}

async function verifyMailTransport() {
  const config = getMailConfig();
  const transporter = buildTransporter();

  if (!transporter) {
    return {
      ok: false,
      reason: 'SMTP is not configured (missing SMTP_USER/SMTP_PASS).'
    };
  }

  try {
    await transporter.verify();
    return {
      ok: true,
      reason: `SMTP ready (${config.host}:${config.port})`
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.message || 'SMTP verification failed'
    };
  }
}

async function sendEmail({ to, subject, html, text }) {
  const config = getMailConfig();
  const transporter = buildTransporter();

  if (!transporter) {
    throw new Error('SMTP is not configured. Set SMTP_USER and SMTP_PASS to enable emails.');
  }

  const info = await transporter.sendMail({
    from: config.from,
    to,
    subject,
    text,
    html
  });

  const acceptedCount = Array.isArray(info.accepted) ? info.accepted.length : 0;
  if (acceptedCount === 0) {
    throw new Error('Email was not accepted by SMTP provider');
  }

  return info;
}

module.exports = {
  getMailConfig,
  sendEmail,
  verifyMailTransport
};
