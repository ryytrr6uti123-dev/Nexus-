const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const AI_TIMEOUT_MS = 120000;
const MAX_TURNS = 20;
const MAX_MESSAGE_LENGTH = 4000;
const DAILY_QUESTION_LIMIT = 200;
const DEFAULT_OLLAMA_MODEL = 'qwen2.5:3b';

const modeInstructions = {
  creative: [
    'Be a practical software, UI, and design partner.',
    'For implementation requests, lead with a complete, usable solution and keep changes focused.',
    'Explain important tradeoffs briefly; consider accessibility, responsive behavior, and maintainability when relevant.',
    'Ask a focused clarifying question only when missing information prevents a useful answer.',
    'Do not claim you inspected files, used tools, or checked current information unless that context is provided.',
  ].join(' '),
  concise: [
    'Be a concise general-purpose assistant.',
    'Answer the main question first, use short explanations, and avoid filler or repeating the prompt.',
    'Mention important caveats and uncertainty plainly; ask a clarifying question only when necessary.',
    'Do not claim you inspected files, used tools, or checked current information unless that context is provided.',
  ].join(' '),
  ideas: [
    'Be a thoughtful brainstorming partner.',
    'Offer three distinct, actionable ideas when the request allows, with a brief benefit or tradeoff for each.',
    "Recommend the strongest fit based on the user's stated goals; do not present guesses as facts.",
  ].join(' '),
  tutor: [
    'Be a patient tutor who helps the user understand, not just get an answer.',
    'Explain concepts in clear steps using a small example when useful, and adapt to the level implied by the question.',
    'For practice or homework, guide the user through the reasoning before revealing a full solution unless they ask directly.',
    'Correct misconceptions respectfully and say when you are uncertain.',
  ].join(' '),
};

class AiServiceError extends Error {
  constructor(message, statusCode = 502, options) {
    super(message, options);
    this.name = 'AiServiceError';
    this.statusCode = statusCode;
  }
}

function normalizeConversation(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_TURNS) {
    throw new AiServiceError(`Send between 1 and ${MAX_TURNS} messages.`, 400);
  }

  const conversation = messages.map(message => {
    if (
      !message
      || !['user', 'model'].includes(message.role)
      || typeof message.text !== 'string'
      || !message.text.trim()
      || message.text.length > MAX_MESSAGE_LENGTH
    ) {
      throw new AiServiceError(`Each message must be 1-${MAX_MESSAGE_LENGTH} characters.`, 400);
    }
    return {
      role: message.role === 'model' ? 'assistant' : 'user',
      content: message.text.trim(),
    };
  });

  if (conversation.at(-1).role !== 'user') {
    throw new AiServiceError('The latest message must be from you.', 400);
  }
  return conversation;
}

async function generateAiReply(messages, mode = 'creative', {
  baseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  model = process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = AI_TIMEOUT_MS,
} = {}) {
  const conversation = normalizeConversation(messages);
  if (!Object.hasOwn(modeInstructions, mode)) {
    throw new AiServiceError('Choose a supported assistant mode.', 400);
  }
  if (typeof fetchImpl !== 'function') {
    throw new AiServiceError('The local AI service is unavailable in this environment.', 503);
  }

  let endpoint;
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol.');
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/chat`;
    endpoint = url.toString();
  } catch (error) {
    throw new AiServiceError('OLLAMA_BASE_URL must be a valid HTTP or HTTPS URL.', 500, { cause: error });
  }

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: modeInstructions[mode] },
          ...conversation,
        ],
        options: { num_predict: 1200, temperature: 0.7 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new AiServiceError('The local AI model took too long to respond. Try again.', 504, { cause: error });
    }
    throw new AiServiceError(
      'Could not reach the local AI model. Start Ollama and check OLLAMA_BASE_URL.',
      503,
      { cause: error },
    );
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new AiServiceError(`The local model "${model}" is not installed. Run ollama pull ${model}.`, 503);
    }
    throw new AiServiceError(`Ollama returned HTTP ${response.status}. Check the local model service.`, 502);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new AiServiceError('The local AI model returned an invalid response.', 502, { cause: error });
  }

  const reply = payload?.message?.content;
  if (typeof reply !== 'string' || !reply.trim()) {
    throw new AiServiceError('The local AI model did not return a response. Please try again.', 502);
  }
  return reply.trim();
}

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

function createAiQuotaKey(namespace, identifier) {
  if (typeof namespace !== 'string' || !namespace || typeof identifier !== 'string' || !identifier) {
    throw new TypeError('An AI quota namespace and identity are required.');
  }
  return crypto.createHash('sha256').update(`nexus-ai:${namespace}:${identifier}`).digest('hex');
}

class AiQuotaStore {
  constructor(filePath, { now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.entries = new Map();
    this.queue = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    let contents;
    try {
      contents = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    const parsed = JSON.parse(contents);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error('The Nexus AI usage store has an unsupported format.');
    }

    const today = utcDay(this.now());
    for (const entry of parsed.entries) {
      if (
        typeof entry?.key === 'string'
        && /^[a-f0-9]{64}$/.test(entry.key)
        && entry.day === today
        && Number.isInteger(entry.used)
        && entry.used >= 0
        && entry.used <= DAILY_QUESTION_LIMIT
      ) {
        this.entries.set(entry.key, { day: entry.day, used: entry.used });
      }
    }
  }

  async persist() {
    const today = utcDay(this.now());
    const contents = JSON.stringify({
      version: 1,
      entries: [...this.entries]
        .filter(([, entry]) => entry.day === today)
        .map(([key, entry]) => ({ key, ...entry })),
    });
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, contents, { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  serialize(operation) {
    const result = this.queue.then(async () => {
      await this.ready;
      return operation();
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  usageFor(key) {
    const today = utcDay(this.now());
    const entry = this.entries.get(key);
    const used = entry?.day === today ? entry.used : 0;
    const tomorrow = new Date(this.now());
    tomorrow.setUTCHours(0, 0, 0, 0);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return {
      limit: DAILY_QUESTION_LIMIT,
      used,
      remaining: DAILY_QUESTION_LIMIT - used,
      resetsAt: tomorrow.toISOString(),
    };
  }

  async getUsage(key) {
    await this.ready;
    await this.queue;
    return this.usageFor(key);
  }

  reserve(key) {
    return this.serialize(async () => {
      const current = this.usageFor(key);
      if (current.remaining === 0) {
        throw new AiServiceError(
          `You've used all ${DAILY_QUESTION_LIMIT} Nexus AI questions for today. Your allowance resets at midnight UTC.`,
          429,
        );
      }
      const previous = this.entries.get(key);
      this.entries.set(key, { day: utcDay(this.now()), used: current.used + 1 });
      try {
        await this.persist();
      } catch (error) {
        if (previous) this.entries.set(key, previous);
        else this.entries.delete(key);
        throw error;
      }
      return this.usageFor(key);
    });
  }

  refund(key) {
    return this.serialize(async () => {
      const current = this.usageFor(key);
      if (current.used === 0) return current;
      const previous = this.entries.get(key);
      if (current.used === 1) this.entries.delete(key);
      else this.entries.set(key, { day: utcDay(this.now()), used: current.used - 1 });
      try {
        await this.persist();
      } catch (error) {
        if (previous) this.entries.set(key, previous);
        throw error;
      }
      return this.usageFor(key);
    });
  }
}

async function askAiWithQuota(messages, mode, { quotaStore, quotaKey, ...options } = {}) {
  if (!quotaStore || typeof quotaKey !== 'string') {
    throw new AiServiceError('The Nexus AI token service is unavailable.', 503);
  }
  await quotaStore.reserve(quotaKey);
  try {
    const reply = await generateAiReply(messages, mode, options);
    return { reply, usage: await quotaStore.getUsage(quotaKey) };
  } catch (error) {
    try {
      await quotaStore.refund(quotaKey);
    } catch (refundError) {
      console.error('Could not restore a Nexus AI token after a failed response.', refundError);
    }
    throw error;
  }
}

module.exports = {
  AiQuotaStore,
  AiServiceError,
  DAILY_QUESTION_LIMIT,
  DEFAULT_OLLAMA_MODEL,
  askAiWithQuota,
  createAiQuotaKey,
  generateAiReply,
};
