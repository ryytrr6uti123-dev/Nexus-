const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { AiQuotaStore } = require('../ai.cjs');
const { handleAiApi } = require('../ai-api.cjs');

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
    ...(options.protocol ? { 'x-forwarded-proto': options.protocol } : {}),
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

async function callApi(options = {}) {
  const request = createRequest(options.url || '/Nexus/api/ai/usage', options);
  const response = createResponse();
  const handled = await handleAiApi(request, response, {
    basePath: '/Nexus/',
    profileStore: options.profileStore || { getAccountId: async () => null },
    aiQuotaStore: options.aiQuotaStore,
    aiOptions: options.aiOptions,
  });
  return { handled, response, json: response.body ? JSON.parse(response.body) : null };
}

test('issues a private guest cookie and reports the daily question balance', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-ai-api-'));
  try {
    const aiQuotaStore = new AiQuotaStore(path.join(directory, 'usage.json'));
    const result = await callApi({
      aiQuotaStore,
      protocol: 'https',
      origin: 'https://nexus.test',
    });

    assert.equal(result.handled, true);
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.json.usage.remaining, 200);
    assert.match(result.response.headers['Set-Cookie'], /HttpOnly/);
    assert.match(result.response.headers['Set-Cookie'], /Secure/);
    assert.match(result.response.headers['Set-Cookie'], /Path=\/Nexus\//);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('spends one question token for successful self-hosted inference', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-ai-api-'));
  try {
    const aiQuotaStore = new AiQuotaStore(path.join(directory, 'usage.json'));
    const usage = await callApi({
      aiQuotaStore,
      origin: 'http://nexus.test',
    });
    const guestCookie = usage.response.headers['Set-Cookie'].split(';')[0];
    const result = await callApi({
      url: '/Nexus/api/ai/chat',
      method: 'POST',
      body: { messages: [{ role: 'user', text: 'Hello' }], mode: 'concise' },
      cookie: guestCookie,
      origin: 'http://nexus.test',
      aiQuotaStore,
      aiOptions: {
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ message: { content: 'Hello from Nexus.' } }),
        }),
      },
    });

    assert.equal(result.response.statusCode, 200);
    assert.equal(result.json.reply, 'Hello from Nexus.');
    assert.equal(result.json.usage.used, 1);
    assert.equal(result.json.usage.remaining, 199);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('rejects cross-origin AI calls without consuming tokens', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-ai-api-'));
  try {
    const aiQuotaStore = new AiQuotaStore(path.join(directory, 'usage.json'));
    const result = await callApi({
      url: '/Nexus/api/ai/chat',
      method: 'POST',
      body: { messages: [{ role: 'user', text: 'Hello' }], mode: 'concise' },
      origin: 'https://attacker.example',
      aiQuotaStore,
    });

    assert.equal(result.response.statusCode, 403);
    assert.match(result.json.error, /must come from Nexus/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
