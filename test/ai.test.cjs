const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  AiQuotaStore,
  DAILY_QUESTION_LIMIT,
  askAiWithQuota,
  createAiQuotaKey,
  generateAiReply,
} = require('../ai.cjs');

async function withQuotaStore(run, options) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-ai-usage-'));
  try {
    const filePath = path.join(directory, 'usage.json');
    const store = new AiQuotaStore(filePath, options);
    await store.ready;
    await run(store, filePath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('sends a bounded conversation to the local Ollama model', async () => {
  let requestedUrl;
  let requestOptions;
  const reply = await generateAiReply([
    { role: 'user', text: 'Help me improve this layout.' },
    { role: 'model', text: 'What kind of page is it?' },
    { role: 'user', text: 'A music player.' },
  ], 'creative', {
    model: 'test-model',
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestOptions = options;
      return {
        ok: true,
        json: async () => ({ message: { content: 'Try a clearer player layout.' } }),
      };
    },
  });

  assert.equal(requestedUrl, 'http://127.0.0.1:11434/api/chat');
  const body = JSON.parse(requestOptions.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages.slice(1).map(message => message.role), ['user', 'assistant', 'user']);
  assert.match(body.messages[0].content, /software, UI, and design partner/i);
  assert.equal(reply, 'Try a clearer player layout.');
});

test('validates conversations, assistant modes, and local model availability', async () => {
  await assert.rejects(
    generateAiReply([{ role: 'model', text: 'not a user prompt' }], 'creative'),
    /latest message must be from you/,
  );
  await assert.rejects(
    generateAiReply([{ role: 'user', text: 'Hello' }], 'unsupported'),
    /Choose a supported assistant mode/,
  );
  await assert.rejects(
    generateAiReply([{ role: 'user', text: 'Hello' }], 'creative', { fetchImpl: null }),
    /local AI service is unavailable/,
  );
  await assert.rejects(
    generateAiReply([{ role: 'user', text: 'Hello' }], 'creative', {
      fetchImpl: async () => { throw new Error('connection refused'); },
    }),
    /Start Ollama/,
  );
});

test('provides distinct instructions for each assistant mode', async () => {
  const instructions = {};
  for (const mode of ['creative', 'concise', 'ideas', 'tutor']) {
    await generateAiReply([{ role: 'user', text: 'Help me.' }], mode, {
      fetchImpl: async (_url, options) => {
        instructions[mode] = JSON.parse(options.body).messages[0].content;
        return {
          ok: true,
          json: async () => ({ message: { content: 'Sure.' } }),
        };
      },
    });
  }

  assert.match(instructions.creative, /software, UI, and design partner/i);
  assert.match(instructions.concise, /Answer the main question first/i);
  assert.match(instructions.ideas, /three distinct, actionable ideas/i);
  assert.match(instructions.tutor, /patient tutor/i);
  assert.equal(new Set(Object.values(instructions)).size, 4);
});

test('enforces and persists the 200-question daily allowance with a UTC reset', async () => {
  let now = new Date('2026-11-25T13:00:00.000Z');
  await withQuotaStore(async (store, filePath) => {
    const key = createAiQuotaKey('profile', 'account-id');
    assert.equal(DAILY_QUESTION_LIMIT, 200);

    for (let question = 0; question < DAILY_QUESTION_LIMIT; question++) {
      await store.reserve(key);
    }

    assert.deepEqual(await store.getUsage(key), {
      limit: 200,
      used: 200,
      remaining: 0,
      resetsAt: '2026-11-26T00:00:00.000Z',
    });
    await assert.rejects(store.reserve(key), error => error.statusCode === 429);

    const restored = new AiQuotaStore(filePath, { now: () => new Date(now) });
    assert.equal((await restored.getUsage(key)).used, 200);

    now = new Date('2026-11-26T00:00:00.000Z');
    assert.equal((await restored.getUsage(key)).remaining, 200);
  }, { now: () => new Date(now) });
});

test('returns a token after local inference fails', async () => {
  await withQuotaStore(async store => {
    const quotaKey = createAiQuotaKey('guest', 'guest-session');
    await assert.rejects(
      askAiWithQuota([{ role: 'user', text: 'Hello' }], 'concise', {
        quotaStore: store,
        quotaKey,
        fetchImpl: async () => { throw new Error('Ollama is offline'); },
      }),
      /Start Ollama/,
    );
    assert.equal((await store.getUsage(quotaKey)).remaining, DAILY_QUESTION_LIMIT);
  });
});
