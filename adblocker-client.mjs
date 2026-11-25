import { FiltersEngine, Request } from '@ghostery/adblocker';

const requestTypes = {
  audio: 'media',
  document: 'main_frame',
  embed: 'object',
  fetch: 'xmlhttprequest',
  font: 'font',
  frame: 'sub_frame',
  iframe: 'sub_frame',
  image: 'image',
  manifest: 'other',
  object: 'object',
  ping: 'ping',
  script: 'script',
  serviceworker: 'script',
  sharedworker: 'script',
  style: 'stylesheet',
  track: 'media',
  video: 'media',
  worker: 'script',
  xslt: 'other',
};

export function normalizeRequestType(destination) {
  return requestTypes[destination] || 'other';
}

export function isRequestBlocked(engine, { url, destination, sourceUrl = '' }) {
  const result = engine.match(Request.fromRawDetails({
    url,
    type: normalizeRequestType(destination),
    sourceUrl,
  }));
  return Boolean(result.match || result.redirect);
}

export function createFilterEngine(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to load ad-blocking filters.');
  }
  return FiltersEngine.fromPrebuiltAdsAndTracking(fetchImpl);
}
