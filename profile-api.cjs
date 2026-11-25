const { ProfileError } = require('./profiles.cjs');
const { searchMusic } = require('./music.cjs');

const MAX_BODY_BYTES = 1024 * 1024;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;
const authAttempts = new Map();

function jsonResponse(response, status, value, headers = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Cookie',
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message) {
  jsonResponse(response, status, { error: message });
}

function getSessionToken(request) {
  const cookies = (request.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === 'nexus_session') {
      return cookie.slice(separator + 1).trim();
    }
  }
  return '';
}

function cookieHeader(request, basePath, clear = false) {
  const forwardedProtocol = request.headers['x-forwarded-proto']?.split(',')[0].trim();
  const secure = forwardedProtocol === 'https' || Boolean(request.socket?.encrypted);
  return [
    `nexus_session=${clear ? '' : 'TOKEN_PLACEHOLDER'}`,
    `Path=${basePath}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${clear ? 0 : 2592000}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function setSessionCookie(request, response, basePath, token) {
  const cookie = cookieHeader(request, basePath).replace('TOKEN_PLACEHOLDER', token);
  response.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(request, response, basePath) {
  response.setHeader('Set-Cookie', cookieHeader(request, basePath, true));
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new ProfileError('Request body is too large.', 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ProfileError('Request body must be valid JSON.');
  }
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (originUrl.origin !== origin) return false;

  const forwardedProtocol = request.headers['x-forwarded-proto']?.split(',')[0].trim();
  const protocol = forwardedProtocol || (request.socket?.encrypted ? 'https' : 'http');
  const forwardedHosts = [
    request.headers['x-forwarded-host']?.split(',')[0].trim(),
    request.headers['x-original-host']?.split(',')[0].trim(),
  ].filter(Boolean);
  const hosts = [request.headers.host, ...forwardedHosts].filter(Boolean);
  if (hosts.some(host => origin === `${protocol}://${host}`)) return true;
  return request.headers['sec-fetch-site'] === 'same-origin';
}

function isRateLimited(request) {
  const now = Date.now();
  for (const [address, entry] of authAttempts) {
    if (entry.resetAt <= now) authAttempts.delete(address);
  }
  const address = request.socket?.remoteAddress || 'unknown';
  const entry = authAttempts.get(address);
  if (!entry || entry.resetAt <= now) {
    authAttempts.set(address, { attempts: 1, resetAt: now + AUTH_WINDOW_MS });
    return false;
  }
  entry.attempts++;
  return entry.attempts > AUTH_MAX_ATTEMPTS;
}

async function handleProfileApi(request, response, { basePath, profileStore }) {
  const requestUrl = new URL(request.url, 'http://localhost');
  const profilePath = `${basePath === '/' ? '' : basePath.slice(0, -1)}/api/profile`;
  const musicPath = `${basePath === '/' ? '' : basePath.slice(0, -1)}/api/music/search`;
  const pathname = requestUrl.pathname;

  if (pathname === musicPath) {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' });
      response.end();
      return true;
    }
    try {
      const tracks = await searchMusic(requestUrl.searchParams.get('q') || '');
      jsonResponse(response, 200, { tracks });
    } catch (error) {
      console.error('Could not search the Apple Music catalog.', error);
      sendError(response, 502, error.message);
    }
    return true;
  }

  if (pathname !== profilePath && !pathname.startsWith(`${profilePath}/`)) return false;
  if (!isSameOrigin(request)) {
    sendError(response, 403, 'Profile requests must come from Nexus.');
    return true;
  }

  const endpoint = pathname.slice(profilePath.length);
  const token = getSessionToken(request);
  try {
    if (endpoint === '/register' || endpoint === '/login') {
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' });
        response.end();
        return true;
      }
      if (isRateLimited(request)) {
        sendError(response, 429, 'Too many sign-in attempts. Try again later.');
        return true;
      }

      const body = await readJsonBody(request);
      const result = endpoint === '/register'
        ? await profileStore.register(body?.username, body?.password)
        : await profileStore.login(body?.username, body?.password);
      setSessionCookie(request, response, basePath, result.token);
      jsonResponse(response, 200, { profile: result.profile });
      return true;
    }

    if (endpoint === '/logout') {
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' });
        response.end();
        return true;
      }
      await profileStore.logout(token);
      clearSessionCookie(request, response, basePath);
      jsonResponse(response, 200, { ok: true });
      return true;
    }

    if (endpoint === '/me') {
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET' });
        response.end();
        return true;
      }
      jsonResponse(response, 200, { profile: await profileStore.getProfile(token) });
      return true;
    }

    if (endpoint === '/data') {
      if (request.method !== 'PUT') {
        response.writeHead(405, { Allow: 'PUT' });
        response.end();
        return true;
      }
      const body = await readJsonBody(request);
      const profile = await profileStore.saveProfileData(token, body?.data);
      jsonResponse(response, 200, { profile });
      return true;
    }

    if (endpoint === '/account') {
      if (request.method !== 'PATCH') {
        response.writeHead(405, { Allow: 'PATCH' });
        response.end();
        return true;
      }
      const body = await readJsonBody(request);
      const profile = await profileStore.updateAccount(token, body);
      jsonResponse(response, 200, { profile });
      return true;
    }

    sendError(response, 404, 'Profile endpoint not found.');
  } catch (error) {
    if (error instanceof ProfileError) {
      sendError(response, error.status, error.message);
    } else {
      console.error('Profile API request failed.', error);
      sendError(response, 500, 'The profile service is temporarily unavailable.');
    }
  }
  return true;
}

module.exports = { handleProfileApi, isSameOrigin };
