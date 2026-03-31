const crypto = require('crypto');

const LYZR_API_URL = process.env.LYZR_API_URL || 'https://agent-prod.studio.lyzr.ai/v3/inference/chat/';

function getLyzrConfig() {
  const apiKey = process.env.LYZR_API_KEY;
  const agentId = process.env.LYZR_AGENT_ID;

  return {
    apiUrl: LYZR_API_URL,
    apiKey,
    agentId,
    enabled: Boolean(apiKey && agentId)
  };
}

function buildSessionId(userId, courseId) {
  const raw = `${userId}:${courseId}`;
  return `eduflow-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

function extractReply(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const directCandidates = [
    payload.answer,
    payload.response,
    payload.message,
    payload.output,
    payload.text,
    payload.content
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  if (Array.isArray(payload.messages)) {
    for (let i = payload.messages.length - 1; i >= 0; i -= 1) {
      const msg = payload.messages[i];
      if (msg && typeof msg.content === 'string' && msg.content.trim()) {
        return msg.content.trim();
      }
    }
  }

  if (Array.isArray(payload.data)) {
    for (let i = payload.data.length - 1; i >= 0; i -= 1) {
      const item = payload.data[i];
      if (item && typeof item.message === 'string' && item.message.trim()) {
        return item.message.trim();
      }
    }
  }

  return null;
}

async function sendTutorMessage({ userId, userEmail, courseId, courseTitle, notesText, studentMessage }) {
  const { apiUrl, apiKey, agentId, enabled } = getLyzrConfig();
  if (!enabled) {
    throw new Error('Lyzr is not configured');
  }

  const scopedPrompt = [
    `Course title: ${courseTitle || 'Untitled course'}`,
    'Instructor-provided scope:',
    notesText && notesText.trim() ? notesText.trim() : 'No notes provided by instructor.',
    '',
    'Student question:',
    studentMessage
  ].join('\n');

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey
    },
    body: JSON.stringify({
      user_id: userEmail || userId,
      agent_id: agentId,
      session_id: buildSessionId(userId, courseId),
      message: scopedPrompt
    })
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_) {
    parsed = null;
  }

  if (!response.ok) {
    const reason = parsed?.message || parsed?.error || text || 'Lyzr request failed';
    throw new Error(reason);
  }

  const reply = extractReply(parsed);
  if (!reply) {
    throw new Error('Lyzr returned an empty response');
  }

  return {
    reply,
    raw: parsed
  };
}

module.exports = {
  getLyzrConfig,
  sendTutorMessage
};
