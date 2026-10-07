const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../native/ui/model.js');

test('address entry handles web URLs, local servers, and search without executable schemes', () => {
  assert.equal(M.safeAddress('example.org/path'), 'https://example.org/path');
  assert.equal(M.safeAddress('localhost:8080/test'), 'http://localhost:8080/test');
  assert.equal(M.safeAddress('[::1]:8080'), 'http://[::1]:8080');
  assert.equal(M.safeAddress('  '), '');
  assert.equal(M.safeAddress('https://example.org'), 'https://example.org/');
  for (const value of ['javascript:alert(1)', 'data:text/html,evil', 'file:///etc/passwd', 'chrome://browser/content/browser.xhtml']) {
    assert.ok(M.safeAddress(value).startsWith('https://www.google.com/search?'));
  }
});

test('session restore preserves slot assignments and retains overflow instead of losing pages', () => {
  const tabs = [{ n: 'a', i: 3 }, { n: 'b', i: 0 }, { n: 'c', i: 3 }, { n: 'd', i: -1 }, { n: 'e', i: 4 }, { n: 'f', i: 99 }];
  const result = M.allocate(tabs, tab => tab.i);
  assert.deepEqual(result.slots.map(t => t.n), ['b', 'c', 'd', 'a', 'e']);
  assert.deepEqual(result.overflow.map(t => t.n), ['f']);
  assert.equal(new Set([...result.slots, ...result.overflow]).size, 6);
});

test('missing and malicious persisted slot values cannot alias slot zero', () => {
  for (const value of ['', null, undefined, -1, 5, 1.5, 'NaN', '<script>']) assert.equal(M.slotIndex(value), -1);
  assert.equal(M.slotIndex('0'), 0);
  assert.equal(M.slotIndex('4'), 4);
});

test('slot stepping is bounded and favicons cannot load chrome or local resources', () => {
  assert.equal(M.boundedStep(0, -1), 0);
  assert.equal(M.boundedStep(4, 1), 4);
  assert.equal(M.safeFavicon('chrome://browser/secret'), '');
  assert.equal(M.safeFavicon('file:///home/test'), '');
  assert.equal(M.safeFavicon('https://example.org/icon.png'), 'https://example.org/icon.png');
});
