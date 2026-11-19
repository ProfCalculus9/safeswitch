import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome, loginAs } from './helpers/fake-chrome.js';
import {
  isRedditCookie,
  cookieUrl,
  isLoggedIn,
  snapshotCookies,
  clearRedditCookies,
  restoreCookies,
} from '../lib/cookies.js';

const NOW = Math.floor(Date.now() / 1000);

test('isRedditCookie accepts reddit.com and subdomains only', () => {
  assert.ok(isRedditCookie({ domain: '.reddit.com' }));
  assert.ok(isRedditCookie({ domain: 'reddit.com' }));
  assert.ok(isRedditCookie({ domain: 'www.reddit.com' }));
  assert.ok(isRedditCookie({ domain: 'old.reddit.com' }));
  assert.ok(isRedditCookie({ domain: '.OLD.Reddit.COM' }));
  assert.ok(!isRedditCookie({ domain: 'evilreddit.com' }));
  assert.ok(!isRedditCookie({ domain: '.notreddit.com' }));
  assert.ok(!isRedditCookie({ domain: 'reddit.com.evil.example' }));
  assert.ok(!isRedditCookie({ domain: 'google.com' }));
  assert.ok(!isRedditCookie({}));
  assert.ok(!isRedditCookie(null));
});

test('cookieUrl builds a url from domain, path and secure flag', () => {
  assert.equal(cookieUrl({ domain: '.reddit.com', path: '/', secure: true }), 'https://reddit.com/');
  assert.equal(cookieUrl({ domain: 'www.reddit.com', path: '/r', secure: false }), 'http://www.reddit.com/r');
  assert.equal(cookieUrl({ domain: 'www.reddit.com' }), 'http://www.reddit.com/');
});

test('isLoggedIn needs a non-empty reddit_session cookie', () => {
  assert.ok(isLoggedIn([{ name: 'reddit_session', value: 'abc' }]));
  assert.ok(!isLoggedIn([{ name: 'reddit_session', value: '' }]));
  assert.ok(!isLoggedIn([{ name: 'edgebucket', value: 'abc' }]));
  assert.ok(!isLoggedIn([]));
});

test('snapshot captures only Reddit cookies and keeps their attributes', async () => {
  const fake = createFakeChrome();
  loginAs(fake, 'sess-a');
  fake.jar.set('x|.example.com|/', { name: 'x', value: 'other-site', domain: '.example.com', path: '/', hostOnly: false });
  fake.jar.set('y|.evilreddit.com|/', { name: 'y', value: 'lookalike', domain: '.evilreddit.com', path: '/', hostOnly: false });

  const snap = await snapshotCookies(fake.chrome);
  assert.equal(snap.length, 3);
  assert.ok(snap.every((c) => isRedditCookie(c)));
  const session = snap.find((c) => c.name === 'reddit_session');
  assert.equal(session.value, 'sess-a');
  assert.equal(session.httpOnly, true);
  assert.equal(session.hostOnly, false);
  assert.equal(typeof session.expirationDate, 'number');
  assert.equal(snap.find((c) => c.name === 'edgebucket').hostOnly, true);
});

test('clearRedditCookies removes Reddit cookies and leaves other sites alone', async () => {
  const fake = createFakeChrome();
  loginAs(fake, 'sess-a');
  fake.jar.set('x|.example.com|/', { name: 'x', value: 'keep', domain: '.example.com', path: '/', hostOnly: false });
  const removed = await clearRedditCookies(fake.chrome);
  assert.equal(removed, 3);
  assert.deepEqual([...fake.jar.keys()], ['x|.example.com|/']);
});

test('restore puts back an identical session (domain and host-only cookies)', async () => {
  const fake = createFakeChrome();
  loginAs(fake, 'sess-a');
  const snap = await snapshotCookies(fake.chrome);
  await clearRedditCookies(fake.chrome);
  assert.equal(fake.jar.size, 0);

  const res = await restoreCookies(fake.chrome, snap, NOW);
  assert.deepEqual(res, { restored: 3, skipped: 0, failed: 0 });

  const after = await snapshotCookies(fake.chrome);
  const norm = (list) => list.map((c) => `${c.name}|${c.domain}|${c.hostOnly}|${c.value}|${c.httpOnly}|${c.secure}`).sort();
  assert.deepEqual(norm(after), norm(snap));
});

test('restore skips expired cookies', async () => {
  const fake = createFakeChrome();
  loginAs(fake, 'sess-a', { expires: NOW - 10 });
  const snap = await snapshotCookies(fake.chrome);
  await clearRedditCookies(fake.chrome);
  const res = await restoreCookies(fake.chrome, snap, NOW);
  assert.equal(res.restored, 0);
  assert.equal(res.skipped, 3);
  assert.equal(fake.jar.size, 0);
});

test('restore never writes cookies for non-Reddit domains, even if the data was altered', async () => {
  const fake = createFakeChrome();
  const evil = [
    { name: 'a', value: '1', domain: '.google.com', path: '/', secure: true, hostOnly: false },
    { name: 'b', value: '2', domain: 'evilreddit.com', path: '/', secure: true, hostOnly: true },
    { name: 'c', value: '3', domain: 'reddit.com.evil.example', path: '/', secure: true, hostOnly: true },
    { name: 'ok', value: '4', domain: '.reddit.com', path: '/', secure: true, hostOnly: false },
    null,
    { name: 5, value: 'x', domain: '.reddit.com' },
  ];
  const res = await restoreCookies(fake.chrome, evil, NOW);
  assert.equal(res.restored, 1);
  assert.equal(res.skipped, 5);
  assert.deepEqual([...fake.jar.values()].map((c) => c.name), ['ok']);
});

test('restore reports failures when the browser rejects a cookie', async () => {
  const fake = createFakeChrome();
  loginAs(fake, 'sess-a');
  const snap = await snapshotCookies(fake.chrome);
  await clearRedditCookies(fake.chrome);
  fake.state.failSetFor.add('token_v2');
  const res = await restoreCookies(fake.chrome, snap, NOW);
  assert.deepEqual(res, { restored: 2, skipped: 0, failed: 1 });
});

test('a session cookie (no expiry) is restored as a session cookie', async () => {
  const fake = createFakeChrome();
  const res = await restoreCookies(
    fake.chrome,
    [{ name: 'reddit_session', value: 'v', domain: '.reddit.com', path: '/', secure: true, httpOnly: true, hostOnly: false, sameSite: 'lax' }],
    NOW,
  );
  assert.equal(res.restored, 1);
  const [c] = await snapshotCookies(fake.chrome);
  assert.equal(c.expirationDate, undefined);
});
