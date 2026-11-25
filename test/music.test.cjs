const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMusicResults, searchMusic } = require('../music.cjs');

test('normalizes official music search results and excludes unsafe provider URLs', () => {
  const [track] = normalizeMusicResults([{
    trackId: 123,
    trackName: 'Sample Song',
    artistName: 'Sample Artist',
    collectionName: 'Sample Album',
    artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg',
    previewUrl: 'https://audio-ssl.itunes.apple.com/preview.m4a',
    trackViewUrl: 'https://music.apple.com/us/album/sample/123',
  }, {
    trackId: 456,
    trackName: 'Unsafe Song',
    artistName: 'Unsafe Artist',
    previewUrl: 'javascript:alert(1)',
    trackViewUrl: 'https://example.com/song',
    artworkUrl100: 'https://example.com/art.jpg',
  }]);

  assert.deepEqual(track, {
    id: '123',
    title: 'Sample Song',
    artist: 'Sample Artist',
    album: 'Sample Album',
    artworkUrl: 'https://is1-ssl.mzstatic.com/image/600x600bb.jpg',
    previewUrl: 'https://audio-ssl.itunes.apple.com/preview.m4a',
    trackUrl: 'https://music.apple.com/us/album/sample/123',
  });
  assert.equal(normalizeMusicResults([{
    trackId: 456,
    trackName: 'Unsafe Song',
    artistName: 'Unsafe Artist',
    previewUrl: 'javascript:alert(1)',
    trackViewUrl: 'https://example.com/song',
    artworkUrl100: 'https://example.com/art.jpg',
  }])[0].previewUrl, '');
});

test('searchMusic sends a bounded song search to Apple and normalizes its response', async () => {
  let requestedUrl;
  const results = await searchMusic('Kendrick Lamar', async url => {
    requestedUrl = new URL(url);
    return {
      ok: true,
      json: async () => ({
        results: [{
          trackId: 10,
          trackName: 'Song',
          artistName: 'Artist',
          trackViewUrl: 'https://music.apple.com/us/album/song/10',
        }],
      }),
    };
  });

  assert.equal(requestedUrl.hostname, 'itunes.apple.com');
  assert.equal(requestedUrl.searchParams.get('term'), 'Kendrick Lamar');
  assert.equal(requestedUrl.searchParams.get('entity'), 'song');
  assert.equal(results[0].id, '10');
});

test('searchMusic rejects empty and oversized queries', async () => {
  await assert.rejects(searchMusic('   '), /Enter an artist/);
  await assert.rejects(searchMusic('a'.repeat(101)), /100 characters/);
});
