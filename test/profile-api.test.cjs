const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { ProfileStore } = require('../profiles.cjs');
const { handleProfileApi } = require('../profile-api.cjs');

async function withStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-profile-api-'));
  try {
    await run(new ProfileStore(path.join(directory, 'profiles.json')));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function createRequest(url, options = {}) {
  const request = Readable.from(options.body === undefined
    ? []
    : [Buffer.from(JSON.stringify(options.body))]);
  request.url = url;
  request.method = options.method || 'GET';
  request.headers = {
    host: 'nexus.test',
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
  };
  request.socket = { remoteAddress: '127.0.0.1', encrypted: false };
  return request;
}

function createResponse() {
  return {
    headers: {},
    statusCode: 0,
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = { ...this.headers, ...headers };
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(value = '') {
      this.body = value.toString();
    },
  };
}

async function callApi(store, url, options = {}) {
  const request = createRequest(url, options);
  const response = createResponse();
  const handled = await handleProfileApi(request, response, {
    basePath: '/Nexus/',
    profileStore: store,
  });
  return { handled, response, json: response.body ? JSON.parse(response.body) : null };
}

test('profile API registers accounts, stores an HttpOnly cookie, and persists activity', async () => {
  await withStore(async store => {
    const registration = await callApi(store, '/Nexus/api/profile/register', {
      method: 'POST',
      body: { username: 'profile_user', password: 'a sufficiently long password' },
      origin: 'http://nexus.test',
    });

    assert.equal(registration.response.statusCode, 200);
    assert.match(registration.response.headers['Set-Cookie'], /HttpOnly/);
    assert.match(registration.response.headers['Set-Cookie'], /SameSite=Lax/);
    const cookie = registration.response.headers['Set-Cookie'].split(';')[0];

    const saved = await callApi(store, '/Nexus/api/profile/data', {
      method: 'PUT',
      cookie,
      body: { data: { recentSearches: ['Kendrick Lamar'] } },
      origin: 'http://nexus.test',
    });
    assert.equal(saved.response.statusCode, 200);
    assert.deepEqual(saved.json.profile.data.recentSearches, ['Kendrick Lamar']);

    const current = await callApi(store, '/Nexus/api/profile/me', { cookie });
    assert.equal(current.json.profile.username, 'profile_user');
  });
});

test('profile API rejects cross-origin changes and unknown routes', async () => {
  await withStore(async store => {
    const crossOrigin = await callApi(store, '/Nexus/api/profile/register', {
      method: 'POST',
      body: { username: 'profile_user', password: 'a sufficiently long password' },
      origin: 'https://attacker.example',
    });
    assert.equal(crossOrigin.response.statusCode, 403);

    const missing = await callApi(store, '/Nexus/api/profile/not-a-route');
    assert.equal(missing.response.statusCode, 404);
  });
});

test('same-origin checks accept forwarded Codespaces hosts but reject other origins', async () => {
  const { isSameOrigin } = require('../profile-api.cjs');
  const forwardedRequest = {
    headers: {
      origin: 'https://nexus-preview.app.github.dev',
      host: 'localhost:4173',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'nexus-preview.app.github.dev',
    },
    socket: { encrypted: false },
  };
  assert.equal(isSameOrigin(forwardedRequest), true);

  assert.equal(isSameOrigin({
    ...forwardedRequest,
    headers: { ...forwardedRequest.headers, origin: 'https://attacker.example' },
  }), false);

  assert.equal(isSameOrigin({
    ...forwardedRequest,
    headers: {
      origin: 'https://nexus-preview.app.github.dev',
      host: 'localhost:4173',
      'sec-fetch-site': 'same-origin',
    },
  }), true);
  assert.equal(isSameOrigin({
    ...forwardedRequest,
    headers: {
      origin: 'https://attacker.example',
      host: 'localhost:4173',
      'sec-fetch-site': 'cross-site',
    },
  }), false);
});
