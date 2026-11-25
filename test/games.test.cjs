const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchGameCatalog, normalizeGame } = require('../games.cjs');

function game(id) {
  return {
    id: String(id),
    title: `Game ${id}`,
    category: 'Arcade',
    tags: 'Puzzle, Casual',
    thumb: 'https://img.gamemonetize.com/game/512x384.jpg',
    url: `https://html5.gamemonetize.com/game-${id}/`,
  };
}

test('normalizes only secure GameMonetize games and thumbnails', () => {
  assert.equal(normalizeGame({ ...game(1), url: 'http://html5.gamemonetize.com/game/' }), null);
  assert.equal(normalizeGame({ ...game(1), url: 'https://example.com/game/' }), null);
  assert.equal(normalizeGame({ ...game(1), thumb: 'https://example.com/cover.jpg' }).thumbnail, '');
  assert.equal(normalizeGame(game(1)).url, 'https://html5.gamemonetize.com/game-1/');
  assert.equal(normalizeGame(game(1)).thumbnail, game(1).thumb);
});

test('loads at least 2,001 distinct games from the paged catalog', async () => {
  const requestedPages = [];
  const fetchImpl = async requestUrl => {
    const url = new URL(requestUrl);
    const page = Number(url.searchParams.get('page'));
    requestedPages.push(page);
    const start = (page - 1) * 1000;
    const rows = Array.from({ length: 1000 }, (_, index) => game(start + index + 1));
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const games = await fetchGameCatalog(fetchImpl, async () => {});

  assert.equal(games.length, 2500);
  assert.equal(new Set(games.map(entry => entry.id)).size, 2500);
  assert.deepEqual(requestedPages, [1, 2, 3]);
});

test('retries rate-limited catalog pages', async () => {
  let requests = 0;
  const fetchImpl = async requestUrl => {
    const page = Number(new URL(requestUrl).searchParams.get('page'));
    if (page === 1 && requests++ === 0) {
      return new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '1' },
      });
    }
    const start = (page - 1) * 1000;
    return new Response(JSON.stringify(
      Array.from({ length: 1000 }, (_, index) => game(start + index + 1)),
    ), { status: 200 });
  };

  const games = await fetchGameCatalog(fetchImpl, async () => {});
  assert.equal(games.length, 2500);
  assert.equal(requests, 2);
});
