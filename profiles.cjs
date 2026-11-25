const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

class ProfileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ProfileError';
    this.status = status;
  }
}

function defaultProfileData() {
  return {
    recentSearches: [],
    recentGames: [],
    favoriteGames: [],
    recentMusic: [],
    playlists: [],
  };
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeIdList(value, limit) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item && item.length <= 100))]
    .slice(0, limit);
}

function isSafeUrl(value, allowedHostname) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && allowedHostname(url.hostname);
  } catch {
    return false;
  }
}

function normalizeTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const id = cleanText(track.id, 100);
  const title = cleanText(track.title, 200);
  const artist = cleanText(track.artist, 200);
  if (!id || !title || !artist) return null;

  return {
    id,
    title,
    artist,
    album: cleanText(track.album, 200),
    artworkUrl: isSafeUrl(track.artworkUrl, hostname => hostname.endsWith('.mzstatic.com'))
      ? track.artworkUrl
      : '',
    previewUrl: isSafeUrl(
      track.previewUrl,
      hostname => hostname === 'audio-ssl.itunes.apple.com',
    ) ? track.previewUrl : '',
    trackUrl: isSafeUrl(track.trackUrl, hostname => hostname === 'music.apple.com')
      ? track.trackUrl
      : '',
  };
}

function normalizeTrackList(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeTrack).filter(Boolean).slice(0, limit);
}

function normalizeProfileData(value) {
  const data = value && typeof value === 'object' ? value : {};
  const recentSearches = Array.isArray(data.recentSearches)
    ? [...new Set(data.recentSearches
      .filter(item => typeof item === 'string')
      .map(item => item.trim().slice(0, 200))
      .filter(Boolean))]
      .slice(0, 50)
    : [];
  const playlists = Array.isArray(data.playlists)
    ? data.playlists.slice(0, 50).map(playlist => ({
      id: /^[\w-]{1,64}$/.test(cleanText(playlist?.id, 64))
        ? cleanText(playlist.id, 64)
        : crypto.randomUUID(),
      name: cleanText(playlist?.name, 80).slice(0, 60) || 'Untitled playlist',
      tracks: normalizeTrackList(playlist?.tracks, 100),
    }))
    : [];

  return {
    recentSearches,
    recentGames: normalizeIdList(data.recentGames, 100),
    favoriteGames: normalizeIdList(data.favoriteGames, 500),
    recentMusic: normalizeTrackList(data.recentMusic, 50),
    playlists,
  };
}

function normalizeUsername(value) {
  if (typeof value !== 'string') {
    throw new ProfileError('Enter a username between 3 and 24 characters.');
  }
  const username = value.normalize('NFKC').trim();
  if (!/^[\p{L}\p{M}\p{N}_.-]{3,24}$/u.test(username)) {
    throw new ProfileError('Usernames must be 3–24 letters, numbers, dots, underscores, or hyphens.');
  }
  return username;
}

function validatePassword(password) {
  if (
    typeof password !== 'string'
    || Buffer.byteLength(password, 'utf8') < 8
    || Buffer.byteLength(password, 'utf8') > 256
  ) {
    throw new ProfileError('Passwords must be between 8 and 256 bytes.');
  }
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

class ProfileStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.accounts = new Map();
    this.sessions = new Map();
    this.writeQueue = Promise.resolve();
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
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
      throw new Error('The Nexus profile store has an unsupported format.');
    }

    for (const account of parsed.accounts) {
      if (
        typeof account?.id !== 'string'
        || typeof account.username !== 'string'
        || typeof account.passwordSalt !== 'string'
        || typeof account.passwordHash !== 'string'
      ) {
        throw new Error('The Nexus profile store contains an invalid account record.');
      }
      this.accounts.set(account.id, {
        id: account.id,
        username: account.username,
        usernameKey: account.username.normalize('NFKC').toLocaleLowerCase('en-US'),
        passwordSalt: account.passwordSalt,
        passwordHash: account.passwordHash,
        createdAt: account.createdAt,
        data: normalizeProfileData(account.data),
      });
    }

    const now = Date.now();
    for (const session of Array.isArray(parsed.sessions) ? parsed.sessions : []) {
      if (
        typeof session?.tokenHash === 'string'
        && typeof session.accountId === 'string'
        && Number.isFinite(session.expiresAt)
        && session.expiresAt > now
        && this.accounts.has(session.accountId)
      ) {
        this.sessions.set(session.tokenHash, session);
      }
    }
  }

  serialize() {
    return JSON.stringify({
      version: 1,
      accounts: [...this.accounts.values()].map(account => ({
        id: account.id,
        username: account.username,
        passwordSalt: account.passwordSalt,
        passwordHash: account.passwordHash,
        createdAt: account.createdAt,
        data: account.data,
      })),
      sessions: [...this.sessions.values()],
    });
  }

  async persist() {
    const contents = this.serialize();
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await fs.writeFile(temporaryPath, contents, { mode: 0o600 });
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    });
    return this.writeQueue;
  }

  findAccountByUsername(username) {
    const key = username.normalize('NFKC').toLocaleLowerCase('en-US');
    return [...this.accounts.values()].find(account => account.usernameKey === key);
  }

  createSession(account) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(hashToken(token), {
      tokenHash: hashToken(token),
      accountId: account.id,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return token;
  }

  publicProfile(account) {
    return {
      username: account.username,
      createdAt: account.createdAt,
      data: normalizeProfileData(account.data),
    };
  }

  async register(usernameValue, password) {
    await this.ready;
    const username = normalizeUsername(usernameValue);
    validatePassword(password);
    if (this.findAccountByUsername(username)) {
      throw new ProfileError('That username is already taken.', 409);
    }

    const salt = crypto.randomBytes(16);
    const passwordHash = await hashPassword(password, salt);
    if (this.findAccountByUsername(username)) {
      throw new ProfileError('That username is already taken.', 409);
    }

    const account = {
      id: crypto.randomUUID(),
      username,
      usernameKey: username.normalize('NFKC').toLocaleLowerCase('en-US'),
      passwordSalt: salt.toString('hex'),
      passwordHash: passwordHash.toString('hex'),
      createdAt: new Date().toISOString(),
      data: defaultProfileData(),
    };
    this.accounts.set(account.id, account);
    const token = this.createSession(account);
    try {
      await this.persist();
    } catch (error) {
      this.accounts.delete(account.id);
      this.sessions.delete(hashToken(token));
      throw error;
    }
    return { token, profile: this.publicProfile(account) };
  }

  async login(usernameValue, password) {
    await this.ready;
    if (
      typeof usernameValue !== 'string'
      || typeof password !== 'string'
      || Buffer.byteLength(password, 'utf8') > 256
    ) {
      throw new ProfileError('Invalid username or password.', 401);
    }
    const account = this.findAccountByUsername(usernameValue.normalize('NFKC').trim());
    const salt = account ? Buffer.from(account.passwordSalt, 'hex') : crypto.randomBytes(16);
    const expected = account
      ? Buffer.from(account.passwordHash, 'hex')
      : await hashPassword('invalid-profile-password', salt);
    const candidate = await hashPassword(password, salt);

    if (!account || candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
      throw new ProfileError('Invalid username or password.', 401);
    }

    const token = this.createSession(account);
    try {
      await this.persist();
    } catch (error) {
      this.sessions.delete(hashToken(token));
      throw error;
    }
    return { token, profile: this.publicProfile(account) };
  }

  async getProfile(token) {
    await this.ready;
    if (typeof token !== 'string' || !token) return null;
    const tokenHash = hashToken(token);
    const session = this.sessions.get(tokenHash);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(tokenHash);
      await this.persist();
      return null;
    }
    const account = this.accounts.get(session.accountId);
    return account ? this.publicProfile(account) : null;
  }

  async getAccountId(token) {
    await this.ready;
    if (typeof token !== 'string' || !token) return null;
    const tokenHash = hashToken(token);
    const session = this.sessions.get(tokenHash);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(tokenHash);
      await this.persist();
      return null;
    }
    return this.accounts.has(session.accountId) ? session.accountId : null;
  }

  async saveProfileData(token, data) {
    await this.ready;
    const account = this.getAccountForToken(token);
    const previousData = account.data;
    account.data = normalizeProfileData(data);
    try {
      await this.persist();
    } catch (error) {
      account.data = previousData;
      throw error;
    }
    return this.publicProfile(account);
  }

  async updateAccount(token, updates) {
    await this.ready;
    const account = this.getAccountForToken(token);
    const username = updates?.username ? normalizeUsername(updates.username) : account.username;
    const password = updates?.password || '';
    if (!updates?.username && !password) {
      throw new ProfileError('Enter a new username or password.');
    }
    if (password) validatePassword(password);

    let passwordSalt = account.passwordSalt;
    let passwordHash = account.passwordHash;
    if (password) {
      const salt = crypto.randomBytes(16);
      passwordHash = (await hashPassword(password, salt)).toString('hex');
      passwordSalt = salt.toString('hex');
    }

    const usernameKey = username.normalize('NFKC').toLocaleLowerCase('en-US');
    const duplicate = [...this.accounts.values()]
      .some(other => other.id !== account.id && other.usernameKey === usernameKey);
    if (duplicate) throw new ProfileError('That username is already taken.', 409);

    const previousAccount = {
      username: account.username,
      usernameKey: account.usernameKey,
      passwordSalt: account.passwordSalt,
      passwordHash: account.passwordHash,
    };
    account.username = username;
    account.usernameKey = usernameKey;
    account.passwordSalt = passwordSalt;
    account.passwordHash = passwordHash;
    try {
      await this.persist();
    } catch (error) {
      Object.assign(account, previousAccount);
      throw error;
    }
    return this.publicProfile(account);
  }

  async logout(token) {
    await this.ready;
    if (typeof token !== 'string' || !token) return;
    const tokenHash = hashToken(token);
    const session = this.sessions.get(tokenHash);
    if (!session) return;
    this.sessions.delete(tokenHash);
    try {
      await this.persist();
    } catch (error) {
      this.sessions.set(tokenHash, session);
      throw error;
    }
  }

  getAccountForToken(token) {
    if (typeof token !== 'string' || !token) {
      throw new ProfileError('Sign in to use your profile.', 401);
    }
    const tokenHash = hashToken(token);
    const session = this.sessions.get(tokenHash);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(tokenHash);
      throw new ProfileError('Your profile session has expired. Sign in again.', 401);
    }
    const account = this.accounts.get(session.accountId);
    if (!account) throw new ProfileError('Your profile could not be found.', 401);
    return account;
  }
}

module.exports = {
  ProfileError,
  ProfileStore,
  defaultProfileData,
  normalizeProfileData,
};
