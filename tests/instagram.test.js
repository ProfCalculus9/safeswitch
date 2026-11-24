import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome } from './helpers/fake-chrome.js';
import { createService } from '../lib/service.js';
import * as IG from '../lib/instagram.js';

function loginInstagram(fake, id) {
  for (const [key, c] of fake.jar) if (IG.isInstagramCookie(c)) fake.jar.delete(key);
  for (const [name, value] of [['ds_user_id', String(id)], ['sessionid', 'session-' + id], ['csrftoken', 'csrf-' + id]]) {
    const c = { name, value, domain: '.instagram.com', path: '/', hostOnly: false,
      secure: true, httpOnly: name === 'sessionid', session: true, sameSite: 'lax', storeId: '0' };
    fake.jar.set(name + '|' + c.domain + '|' + c.path, c);
  }
}

test('Instagram identity requires both sessionid and ds_user_id', () => {
  assert.equal(IG.identity([{ name: 'ds_user_id', value: '123', domain: '.instagram.com' }]), null);
  assert.equal(IG.identity([{ name: 'sessionid', value: 'secret', domain: '.instagram.com' }]), null);
  assert.equal(IG.identity([
    { name: 'sessionid', value: 'secret', domain: '.instagram.com' },
    { name: 'ds_user_id', value: '123', domain: '.instagram.com' }
  ]), '123');
});

test('Instagram cookie adapter excludes lookalike domains', async () => {
  const fake = createFakeChrome();
  loginInstagram(fake, '123');
  fake.jar.set('evil', { name: 'sessionid', value: 'x', domain: '.notinstagram.com', path: '/' });
  const snapshot = await IG.snapshot(fake.chrome);
  assert.equal(snapshot.length, 3);
  assert.equal(snapshot.every(IG.isInstagramCookie), true);
  await IG.clear(fake.chrome);
  assert.equal((await IG.snapshot(fake.chrome)).length, 0);
  assert.equal(fake.jar.has('evil'), true);
});

test('Instagram account switching keeps Reddit cookies and vault accounts intact', async () => {
  const fake = createFakeChrome();
  const service = createService({ chrome: fake.chrome, fetch: async () => ({ ok: false }) });
  await service.createVault('strong-test-passphrase');
  const reddit = { name: 'reddit_session', value: 'reddit-secret', domain: '.reddit.com', path: '/',
    hostOnly: false, secure: true, httpOnly: true, sameSite: 'lax', session: true };
  fake.jar.set('reddit', reddit);

  loginInstagram(fake, '101');
  await service.instagramSave({ label: 'First' });
  await service.instagramPrepareLogin();
  assert.equal(fake.jar.get('reddit').value, 'reddit-secret');
  loginInstagram(fake, '202');
  await service.instagramSave({ label: 'Second' });
  const list = await service.instagramList();
  assert.equal(list.accounts.length, 2);
  await service.instagramSwitch(list.accounts.find(a => a.userId === '101').id);
  assert.equal(IG.identity(await IG.snapshot(fake.chrome)), '101');
  assert.equal(fake.jar.get('reddit').value, 'reddit-secret');
  assert.deepEqual((await service.list()).accounts, []);
});

test('Unsaved Instagram session is protected from accidental switching', async () => {
  const fake = createFakeChrome();
  const service = createService({ chrome: fake.chrome });
  await service.createVault('strong-test-passphrase');
  loginInstagram(fake, '1');
  await service.instagramSave({ label: 'Saved' });
  loginInstagram(fake, '2');
  const target = (await service.instagramList()).accounts[0];
  await assert.rejects(() => service.instagramSwitch(target.id), { code: 'UNSAVED_SESSION' });
  assert.equal(IG.identity(await IG.snapshot(fake.chrome)), '2');
});

test('Restore failure attempts cookie rollback', async () => {
  const fake = createFakeChrome();
  const service = createService({ chrome: fake.chrome });
  await service.createVault('strong-test-passphrase');
  loginInstagram(fake, '1');
  await service.instagramSave({ label: 'First' });
  await service.instagramPrepareLogin();
  loginInstagram(fake, '2');
  await service.instagramSave({ label: 'Second' });
  fake.state.failSetFor.add('ds_user_id');
  const target = (await service.instagramList()).accounts.find(a => a.userId === '1');
  await assert.rejects(() => service.instagramSwitch(target.id), { code: 'RESTORE_FAILED' });
  // The fake also rejects the rollback's ds_user_id, so recovery is best-effort.
  // Importantly, a failed operation must not mark the target account active.
  assert.equal((await service.instagramList()).activeId !== target.id, true);
});

test('Instagram prepare-login removes only selected origin storage when opted in', async () => {
  const fake = createFakeChrome();
  const calls = [];
  fake.chrome.browsingData = {
    async remove(options, types) { calls.push({ options, types }); }
  };
  const service = createService({ chrome: fake.chrome });
  await service.createVault('strong-test-passphrase');
  loginInstagram(fake, '543');
  await service.instagramSave({ label: 'Private' });
  await service.instagramPrepareLogin({ clearSiteData: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.origins, ['https://www.instagram.com', 'https://instagram.com']);
  assert.deepEqual(calls[0].types, {
    localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true,
  });
  assert.equal((await IG.snapshot(fake.chrome)).length, 0);
  assert.equal((await service.instagramList()).accounts.length, 1);
});

test('Instagram site-data cleanup fails safely without the browser API', async () => {
  const fake = createFakeChrome();
  const service = createService({ chrome: fake.chrome });
  await service.createVault('strong-test-passphrase');
  loginInstagram(fake, '123');
  await service.instagramSave({ label: 'Test' });
  await assert.rejects(
    () => service.instagramPrepareLogin({ clearSiteData: true }),
    { code: 'UNSUPPORTED' }
  );
  assert.equal(IG.identity(await IG.snapshot(fake.chrome)), '123');
});
