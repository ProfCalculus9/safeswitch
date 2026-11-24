import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSite, siteById } from '../lib/sites.js';

test('recognizes Reddit subdomains as the working adapter', () => {
  assert.equal(matchSite('https://www.reddit.com/r/test')?.id, 'reddit');
  assert.equal(matchSite('https://old.reddit.com/')?.enabled, true);
});

test('recognizes planned websites without enabling switching', () => {
  for (const [host, id] of [['instagram.com', 'instagram'], ['m.facebook.com', 'facebook'], ['x.com', 'x'], ['twitter.com', 'x']]) {
    assert.equal(matchSite('https://' + host)?.id, id);
    assert.equal(matchSite('https://' + host)?.enabled, false);
  }
});

test('rejects lookalike hostnames and unsupported protocols', () => {
  for (const url of ['https://fake-reddit.com', 'https://reddit.com.evil.example', 'https://notinstagram.com', 'chrome://extensions', 'file:///tmp/reddit.com', 'not-a-url']) {
    assert.equal(matchSite(url), null, url);
  }
});

test('unknown site ids are not resolved', () => {
  assert.equal(siteById('unknown'), null);
});
