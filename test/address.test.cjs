const test = require('node:test');
const assert = require('node:assert/strict');
const { isWebUrl, resolveAddress } = require('../address.cjs');

test('resolves ordinary text to a DuckDuckGo search', () => {
  assert.equal(
    resolveAddress('cute cats'),
    'https://duckduckgo.com/?q=cute%20cats',
  );
});

test('resolves searches using the selected engine', () => {
  assert.equal(
    resolveAddress('cute cats', 'bing'),
    'https://www.bing.com/search?q=cute%20cats',
  );
  assert.throws(() => resolveAddress('cute cats', 'unknown'), /supported search engine/);
});

test('resolves web addresses without changing their protocol', () => {
  assert.equal(resolveAddress('example.com'), 'https://example.com');
  assert.equal(resolveAddress('example.com:8080/path'), 'https://example.com:8080/path');
  assert.equal(resolveAddress('localhost:3000'), 'https://localhost:3000');
  assert.equal(resolveAddress('http://localhost:3000'), 'http://localhost:3000');
});

test('rejects empty and non-web addresses', () => {
  assert.throws(() => resolveAddress('   '), /Enter a search or web address/);
  assert.throws(() => resolveAddress('file:///etc/passwd'), /Only http and https/);
  assert.equal(isWebUrl('javascript:alert(1)'), false);
});
