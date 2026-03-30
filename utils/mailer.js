const nodemailer = require('nodemailer');

function getResendConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || process.env.SMTP_FROM || process.env.SMTP_USER;

  return {
    apiKey,
    from,
    isConfigured: Boolean(apiKey && from)
  };
}

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

function shouldTryGmailSslFallback(error, config) {
  if (!config?.host || config.host.toLowerCase() !== 'smtp.gmail.com') {
    return false;
  }

  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return code.includes('ETIMEDOUT') || message.includes('timeout');
}

function buildGmailSslFallbackTransporter(config) {
  return nodemailer.createTransport({
    host: config.host,
    port: 465,
    secure: true,
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
  const resendConfig = getResendConfig();
  if (resendConfig.isConfigured) {
    return {
      ok: true,
      reason: 'Resend API configured (HTTPS mail delivery enabled)'
    };
  }

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

async function sendEmailViaResend({ to, subject, html, text }) {
  const resendConfig = getResendConfig();
  if (!resendConfig.isConfigured) {
    throw new Error('Resend is not configured. Set RESEND_API_KEY and RESEND_FROM.');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendConfig.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: resendConfig.from,
      to: [to],
      subject,
      html,
      text
    })
  });

  if (!response.ok) {
    let errorText = '';
    try {
      errorText = await response.text();
    } catch (_) {
      errorText = '';
    }
    throw new Error(`Resend API error (${response.status}): ${errorText || 'Unknown error'}`);
  }

  return response.json();
}

async function sendEmail({ to, subject, html, text }) {
  const resendConfig = getResendConfig();
  if (resendConfig.isConfigured) {
    return sendEmailViaResend({ to, subject, html, text });
  }

  const config = getMailConfig();
  const transporter = buildTransporter();

  if (!transporter) {
    throw new Error('SMTP is not configured. Set SMTP_USER and SMTP_PASS to enable emails.');
  }

  let info;
  try {
    info = await transporter.sendMail({
      from: config.from,
      to,
      subject,
      text,
      html
    });
  } catch (error) {
    if (!shouldTryGmailSslFallback(error, config)) {
      throw error;
    }

    const fallbackTransporter = buildGmailSslFallbackTransporter(config);
    info = await fallbackTransporter.sendMail({
      from: config.from,
      to,
      subject,
      text,
      html
    });
  }

  const acceptedCount = Array.isArray(info.accepted) ? info.accepted.length : 0;
  if (acceptedCount === 0) {
    throw new Error('Email was not accepted by SMTP provider');
  }

  return info;
}

module.exports = {
  getResendConfig,
  getMailConfig,
  sendEmail,
  verifyMailTransport
};
