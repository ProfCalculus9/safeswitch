import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome, loginAs, fakeRedditFetch } from './helpers/fake-chrome.js';
import { createService } from '../lib/service.js';
import { createRouter } from '../lib/router.js';

const PASS = 'correct horse battery staple';

function setup() {
  const fake = createFakeChrome();
  const svc = createService({ chrome: fake.chrome, fetch: fakeRedditFetch(fake, { 'sess-alice': 'alice' }) });
  return { fake, handle: createRouter(svc) };
}

test('unknown, inherited and malformed request types are rejected', async () => {
  const { handle } = setup();
  for (const msg of [
    undefined,
    null,
    'status',
    42,
    {},
    { type: 42 },
    { type: 'nope' },
    { type: '__proto__' },
    { type: 'constructor' },
    { type: 'toString' },
    { type: 'hasOwnProperty' },
  ]) {
    const res = await handle(msg);
    assert.equal(res.ok, false, JSON.stringify(msg));
    assert.equal(res.error.code, 'BAD_REQUEST');
  }
});

test('full flow through the message interface', async () => {
  const { fake, handle } = setup();
  assert.deepEqual((await handle({ type: 'status' })).result.exists, false);
  assert.equal((await handle({ type: 'createVault', args: { passphrase: PASS } })).ok, true);

  loginAs(fake, 'sess-alice');
  const saved = await handle({ type: 'saveCurrent', args: { label: 'main' } });
  assert.equal(saved.ok, true);

  const list = await handle({ type: 'list' });
  assert.equal(list.result.accounts[0].label, 'main');

  fake.jar.clear();
  const sw = await handle({ type: 'switchTo', args: { id: saved.result.id } });
  assert.equal(sw.ok, true);
  assert.equal(sw.result.label, 'main');
});

test('responses never contain cookie values or the key', async () => {
  const { fake, handle } = setup();
  await handle({ type: 'createVault', args: { passphrase: PASS } });
  loginAs(fake, 'sess-alice');
  const responses = [
    await handle({ type: 'saveCurrent', args: {} }),
    await handle({ type: 'list' }),
    await handle({ type: 'status' }),
    await handle({ type: 'detectUsername' }),
  ];
  const text = JSON.stringify(responses);
  for (const secret of ['sess-alice', 'tok-sess', 'edge-sess', fake.chrome.storage.session.data.sessionKey]) {
    assert.ok(!text.includes(secret), `"${secret}" appeared in a response`);
  }
});

test('errors come back as { ok:false, error:{ code, message } } and never throw', async () => {
  const { handle } = setup();
  const res = await handle({ type: 'list' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'NO_VAULT');
  assert.equal(typeof res.error.message, 'string');

  await handle({ type: 'createVault', args: { passphrase: PASS } });
  const bad = await handle({ type: 'createVault', args: { passphrase: PASS } });
  assert.equal(bad.error.code, 'VAULT_EXISTS');
});

test('force flag only counts when explicitly truthy', async () => {
  const { fake, handle } = setup();
  await handle({ type: 'createVault', args: { passphrase: PASS } });
  loginAs(fake, 'sess-alice'); // signed in but not saved
  const refused = await handle({ type: 'prepareNewLogin', args: { force: 'false-ish string is truthy, but undefined is not' } });
  assert.equal(refused.ok, true); // a truthy value forces; documents current behaviour

  loginAs(fake, 'sess-alice');
  const noArgs = await handle({ type: 'prepareNewLogin' });
  assert.equal(noArgs.ok, false);
  assert.equal(noArgs.error.code, 'UNSAVED_SESSION');
});
