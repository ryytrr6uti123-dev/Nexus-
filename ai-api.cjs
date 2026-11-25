const crypto = require('node:crypto');
const { AiServiceError, askAiWithQuota, createAiQuotaKey } = require('./ai.cjs');
const { isSameOrigin } = require('./profile-api.cjs');

const MAX_BODY_BYTES = 96 * 1024;
const GUEST_COOKIE_NAME = 'nexus_ai_guest';
const GUEST_COOKIE_MAX_AGE = 31536000;

function jsonResponse(response, status, value) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Cookie',
  });
  response.end(JSON.stringify(value));
}

function getCookie(request, name) {
  for (const cookie of (request.headers.cookie || '').split(';')) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return '';
}

function getSessionToken(request) {
  return getCookie(request, 'nexus_session');
}

function setGuestCookie(request, response, basePath, token) {
  const forwardedProtocol = request.headers['x-forwarded-proto']?.split(',')[0].trim();
  const secure = forwardedProtocol === 'https' || Boolean(request.socket?.encrypted);
  response.setHeader('Set-Cookie', [
    `${GUEST_COOKIE_NAME}=${token}`,
    `Path=${basePath}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${GUEST_COOKIE_MAX_AGE}`,
    ...(secure ? ['Secure'] : []),
  ].join('; '));
}

async function getQuotaKey(request, response, basePath, profileStore) {
  const accountId = await profileStore.getAccountId(getSessionToken(request));
  if (accountId) return createAiQuotaKey('profile', accountId);

  let guestToken = getCookie(request, GUEST_COOKIE_NAME);
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(guestToken)) {
    guestToken = crypto.randomBytes(32).toString('base64url');
    setGuestCookie(request, response, basePath, guestToken);
  }
  return createAiQuotaKey('guest', guestToken);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new AiServiceError('The assistant conversation is too large.', 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new AiServiceError('The assistant request must contain valid JSON.', 400, { cause: error });
  }
}

async function handleAiApi(request, response, {
  basePath,
  profileStore,
  aiQuotaStore,
  aiOptions = {},
}) {
  const requestUrl = new URL(request.url, 'http://localhost');
  const prefix = basePath === '/' ? '' : basePath.slice(0, -1);
  const usagePath = `${prefix}/api/ai/usage`;
  const chatPath = `${prefix}/api/ai/chat`;
  if (requestUrl.pathname !== usagePath && requestUrl.pathname !== chatPath) return false;

  if (!isSameOrigin(request)) {
    jsonResponse(response, 403, { error: 'Assistant requests must come from Nexus.' });
    return true;
  }
  if ((requestUrl.pathname === usagePath && request.method !== 'GET')
    || (requestUrl.pathname === chatPath && request.method !== 'POST')) {
    response.writeHead(405, {
      Allow: requestUrl.pathname === usagePath ? 'GET' : 'POST',
      'Cache-Control': 'no-store',
    });
    response.end();
    return true;
  }

  try {
    const quotaKey = await getQuotaKey(request, response, basePath, profileStore);
    if (requestUrl.pathname === usagePath) {
      jsonResponse(response, 200, { usage: await aiQuotaStore.getUsage(quotaKey) });
      return true;
    }

    const body = await readJsonBody(request);
    const result = await askAiWithQuota(body?.messages, body?.mode, {
      quotaStore: aiQuotaStore,
      quotaKey,
      ...aiOptions,
    });
    jsonResponse(response, 200, result);
  } catch (error) {
    if (!error.statusCode) console.error('Could not serve the Nexus AI request.', error);
    jsonResponse(response, error.statusCode || 500, {
      error: error.statusCode ? error.message : 'The Nexus AI assistant could not complete that request.',
    });
  }
  return true;
}

module.exports = { handleAiApi };
