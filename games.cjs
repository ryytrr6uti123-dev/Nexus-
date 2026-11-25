const FEED_URL = 'https://gamemonetize.com/feed.php';
const PAGE_SIZE = 1000;
const TARGET_COUNT = 2500;
const MINIMUM_COUNT = 2001;
const MAX_PAGES = 6;
const CACHE_DURATION = 12 * 60 * 60 * 1000;
const REQUEST_DELAY = 1100;

let cachedGames;
let cacheExpiresAt = 0;
let pendingCatalog;

function isGameHost(hostname) {
  return hostname === 'gamemonetize.com'
    || hostname.endsWith('.gamemonetize.com')
    || hostname === 'gamemonetize.co'
    || hostname.endsWith('.gamemonetize.co');
}

function normalizeGame(game) {
  if (!game || !['string', 'number'].includes(typeof game.id)) return null;

  const id = String(game.id);
  const title = typeof game.title === 'string' ? game.title.trim().slice(0, 200) : '';
  if (!/^[\w-]{1,80}$/.test(id) || !title) return null;

  let url;
  try {
    url = new URL(game.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !isGameHost(url.hostname)) return null;

  let thumbnail = '';
  try {
    const imageUrl = new URL(game.thumb);
    if (
      imageUrl.protocol === 'https:'
      && (imageUrl.hostname === 'img.gamemonetize.com'
        || imageUrl.hostname === 'img.gamemonetize.co')
    ) {
      thumbnail = imageUrl.href;
    }
  } catch {
    thumbnail = '';
  }

  return {
    id,
    title,
    category: typeof game.category === 'string' && game.category.trim()
      ? game.category.trim().slice(0, 80)
      : 'Other',
    tags: typeof game.tags === 'string' ? game.tags.slice(0, 500) : '',
    thumbnail,
    url: url.href,
  };
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchFeedPage(fetchImpl, page, pause) {
  const query = new URLSearchParams({
    format: '0',
    num: String(PAGE_SIZE),
    page: String(page),
  });
  const url = `${FEED_URL}?${query}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });

    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await pause(Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 15000)
        : 1000 * (2 ** attempt));
      continue;
    }
    if (!response.ok) {
      throw new Error(`Game catalog request failed (HTTP ${response.status}).`);
    }

    let rows;
    try {
      rows = await response.json();
    } catch (error) {
      throw new Error(`Game catalog page ${page} was not valid JSON: ${error.message}`);
    }
    if (!Array.isArray(rows)) {
      throw new Error(`Game catalog page ${page} did not contain a game list.`);
    }
    return rows;
  }

  throw new Error(`Game catalog page ${page} was rate-limited too many times.`);
}

async function fetchGameCatalog(fetchImpl = globalThis.fetch, pause = delay) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('This runtime does not support fetching the game catalog.');
  }

  const games = new Map();
  for (let page = 1; page <= MAX_PAGES && games.size < TARGET_COUNT; page++) {
    const rows = await fetchFeedPage(fetchImpl, page, pause);
    for (const row of rows) {
      const game = normalizeGame(row);
      if (game && !games.has(game.id)) games.set(game.id, game);
    }
    if (page < MAX_PAGES && games.size < TARGET_COUNT) await pause(REQUEST_DELAY);
  }

  if (games.size < MINIMUM_COUNT) {
    throw new Error(`The game catalog returned ${games.size} unique games; at least ${MINIMUM_COUNT} are required.`);
  }
  return [...games.values()].slice(0, TARGET_COUNT);
}

function getGameCatalog() {
  if (cachedGames && Date.now() < cacheExpiresAt) {
    return Promise.resolve(cachedGames);
  }
  if (!pendingCatalog) {
    pendingCatalog = fetchGameCatalog()
      .then(games => {
        cachedGames = games;
        cacheExpiresAt = Date.now() + CACHE_DURATION;
        return games;
      })
      .finally(() => {
        pendingCatalog = null;
      });
  }
  return pendingCatalog;
}

module.exports = {
  fetchGameCatalog,
  getGameCatalog,
  normalizeGame,
};
