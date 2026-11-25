const MUSIC_SEARCH_URL = 'https://itunes.apple.com/search';
const MUSIC_TIMEOUT_MS = 10000;

function isAllowedUrl(value, hostname) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && hostname(url.hostname);
  } catch {
    return false;
  }
}

function normalizeMusicTrack(track) {
  if (!track || !Number.isSafeInteger(track.trackId)) return null;

  const title = typeof track.trackName === 'string' ? track.trackName.trim() : '';
  const artist = typeof track.artistName === 'string' ? track.artistName.trim() : '';
  if (!title || !artist) return null;

  const artworkUrl = typeof track.artworkUrl100 === 'string'
    ? track.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.')
    : '';

  return {
    id: String(track.trackId),
    title: title.slice(0, 200),
    artist: artist.slice(0, 200),
    album: typeof track.collectionName === 'string' ? track.collectionName.slice(0, 200) : '',
    artworkUrl: isAllowedUrl(artworkUrl, hostname => hostname.endsWith('.mzstatic.com'))
      ? artworkUrl
      : '',
    previewUrl: isAllowedUrl(
      track.previewUrl,
      hostname => hostname === 'audio-ssl.itunes.apple.com',
    ) ? track.previewUrl : '',
    trackUrl: isAllowedUrl(
      track.trackViewUrl,
      hostname => hostname === 'music.apple.com',
    ) ? track.trackViewUrl : '',
  };
}

function normalizeMusicResults(results) {
  if (!Array.isArray(results)) return [];
  return results
    .map(normalizeMusicTrack)
    .filter(Boolean)
    .slice(0, 30);
}

async function searchMusic(query, fetchImpl = globalThis.fetch) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('Enter an artist, producer, or song to search.');
  }
  const term = query.trim();
  if (term.length > 100) throw new Error('Music searches must be 100 characters or fewer.');
  if (typeof fetchImpl !== 'function') throw new Error('Music search is unavailable in this environment.');

  const url = new URL(MUSIC_SEARCH_URL);
  url.search = new URLSearchParams({ term, entity: 'song', limit: '30' });

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(MUSIC_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('Music search timed out. Try again.');
    }
    throw new Error('Music search is temporarily unavailable.', { cause: error });
  }

  if (!response.ok) {
    throw new Error(`Music search returned HTTP ${response.status}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('Music search returned an invalid response.', { cause: error });
  }
  return normalizeMusicResults(payload?.results);
}

module.exports = { normalizeMusicResults, normalizeMusicTrack, searchMusic };
