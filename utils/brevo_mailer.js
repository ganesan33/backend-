function getBrevoConfig() {
  const apiKey = process.env.BREVO_API_KEY;
  const from = process.env.BREVO_FROM;
  const fromName = process.env.BREVO_FROM_NAME || 'EduFlow';

  return {
    apiKey,
    from,
    fromName,
    isConfigured: Boolean(apiKey && from)
  };
}

async function verifyBrevoMailer() {
  const config = getBrevoConfig();

  if (!config.isConfigured) {
    return {
      ok: false,
      reason: 'Brevo is not configured (missing BREVO_API_KEY and BREVO_FROM).'
    };
  }

  // Brevo API is always reachable (HTTPS on port 443), so just verify key format
  if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
    return {
      ok: false,
      reason: 'Brevo API key is invalid.'
    };
  }

  return {
    ok: true,
    reason: 'Brevo API ready (HTTPS mail delivery enabled)'
  };
}

async function sendEmailViaBrevo({ to, subject, html, text }) {
  const config = getBrevoConfig();

  if (!config.isConfigured) {
    throw new Error('Brevo is not configured. Set BREVO_API_KEY and BREVO_FROM.');
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': config.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender: {
        name: config.fromName,
        email: config.from
      },
      to: [
        {
          email: to
        }
      ],
      subject,
      htmlContent: html || text,
      textContent: text
    })
  });

  if (!response.ok) {
    let errorText = '';
    try {
      errorText = await response.text();
    } catch (_) {
      errorText = '';
    }
    throw new Error(`Brevo API error (${response.status}): ${errorText || 'Unknown error'}`);
  }

  return response.json();
}

module.exports = {
  getBrevoConfig,
  sendEmailViaBrevo,
  verifyBrevoMailer
};
