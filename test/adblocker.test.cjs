const test = require('node:test');
const assert = require('node:assert/strict');
const { FiltersEngine } = require('@ghostery/adblocker');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { isRequestBlocked, normalizeRequestType } = require('../adblocker-client.mjs');

test('maps Scramjet destinations to Ghostery request types', () => {
  assert.equal(normalizeRequestType('document'), 'main_frame');
  assert.equal(normalizeRequestType('iframe'), 'sub_frame');
  assert.equal(normalizeRequestType('fetch'), 'xmlhttprequest');
  assert.equal(normalizeRequestType('unrecognized'), 'other');
});

test('blocks matching ad requests but honors exception filters', () => {
  const engine = FiltersEngine.parse(
    '||ads.example^$script\n@@||ads.example/allowed.js$script',
  );
  const request = {
    destination: 'script',
    sourceUrl: 'https://publisher.example/',
  };

  assert.equal(isRequestBlocked(engine, {
    ...request,
    url: 'https://ads.example/ad.js',
  }), true);
  assert.equal(isRequestBlocked(engine, {
    ...request,
    url: 'https://ads.example/allowed.js',
  }), false);
});

test('enables network blocking in both Electron sessions', () => {
  const blocker = ElectronBlocker.parse('||ads.example^$script');
  blocker.config.loadCosmeticFilters = false;
  const sessions = Array.from({ length: 2 }, () => {
    const listeners = {};
    return {
      listeners,
      webRequest: {
        onBeforeRequest: (_filter, listener) => {
          listeners.beforeRequest = listener;
        },
        onHeadersReceived: (_filter, listener) => {
          listeners.headersReceived = listener;
        },
      },
    };
  });

  sessions.forEach(session => blocker.enableBlockingInSession(session));
  for (const { listeners } of sessions) {
    let response;
    listeners.beforeRequest({
      id: 1,
      url: 'https://ads.example/ad.js',
      resourceType: 'script',
      referrer: 'https://publisher.example/',
    }, result => {
      response = result;
    });
    assert.deepEqual(response, { cancel: true });
  }
});
