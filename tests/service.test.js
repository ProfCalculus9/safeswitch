import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome, loginAs, fakeRedditFetch } from './helpers/fake-chrome.js';
import { createService, ALARM_NAME, MAX_ACCOUNTS, DEFAULT_IDLE_MINUTES } from '../lib/service.js';

const PASS = 'correct horse battery staple';
const NEW_PASS = 'a completely different passphrase';
const USERS = {
  'sess-alice': 'alice',
  'sess-alice-2': 'alice',
  'sess-bob': 'bob',
  'sess-carol': 'carol',
};

async function setup({ users = USERS, now, fetchImpl, create = true } = {}) {
  const fake = createFakeChrome();
  const fetch = fetchImpl ?? fakeRedditFetch(fake, users);
  const svc = createService({ chrome: fake.chrome, fetch, now });
  if (create) await svc.createVault(PASS);
  return { fake, svc, fetch };
}

const code = (c) => (e) => e?.code === c;
const sessionValue = (fake) => [...fake.jar.values()].find((c) => c.name === 'reddit_session')?.value;

// ---- vault lifecycle -------------------------------------------------------

test('create vault: unlocked, alarm armed, only the key in session storage', async () => {
  const { fake, svc } = await setup({ create: false });
  assert.deepEqual(await svc.status(), { exists: false, unlocked: false, idleMinutes: DEFAULT_IDLE_MINUTES });
  const st = await svc.createVault(PASS);
  assert.equal(st.exists, true);
  assert.equal(st.unlocked, true);
  assert.equal(fake.state.alarms.get(ALARM_NAME).delayInMinutes, DEFAULT_IDLE_MINUTES);
  assert.deepEqual(Object.keys(fake.chrome.storage.session.data), ['sessionKey']);
  assert.deepEqual(Object.keys(fake.chrome.storage.local.data), ['vault']);
});

test('create vault rejects short passphrases and a second vault', async () => {
  const { svc } = await setup({ create: false });
  await assert.rejects(() => svc.createVault('short'), code('WEAK_PASSPHRASE'));
  await assert.rejects(() => svc.createVault(undefined), code('WEAK_PASSPHRASE'));
  await svc.createVault(PASS);
  await assert.rejects(() => svc.createVault(NEW_PASS), code('VAULT_EXISTS'));
});

test('lock clears the key and alarm; unlock with the wrong passphrase fails', async () => {
  const { fake, svc } = await setup();
  const st = await svc.lock();
  assert.equal(st.unlocked, false);
  assert.equal(fake.chrome.storage.session.data.sessionKey, undefined);
  assert.equal(fake.state.alarms.has(ALARM_NAME), false);

  await assert.rejects(() => svc.unlock('wrong passphrase!!'), code('DECRYPT_FAILED'));
  assert.equal((await svc.status()).unlocked, false);

  const ok = await svc.unlock(PASS);
  assert.equal(ok.unlocked, true);
  assert.ok(fake.state.alarms.has(ALARM_NAME));
});

test('every vault operation is refused while locked', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-alice');
  await svc.lock();
  await assert.rejects(() => svc.list(), code('LOCKED'));
  await assert.rejects(() => svc.saveCurrent(), code('LOCKED'));
  await assert.rejects(() => svc.switchTo('x'), code('LOCKED'));
  await assert.rejects(() => svc.prepareNewLogin(), code('LOCKED'));
  await assert.rejects(() => svc.removeAccount('x'), code('LOCKED'));
  // and nothing touched the browser's cookies
  assert.equal(sessionValue(fake), 'sess-alice');
});

test('operations on a missing vault report NO_VAULT', async () => {
  const { svc } = await setup({ create: false });
  await assert.rejects(() => svc.unlock(PASS), code('NO_VAULT'));
  await assert.rejects(() => svc.list(), code('NO_VAULT'));
  await assert.rejects(() => svc.exportVault(), code('NO_VAULT'));
  await assert.rejects(() => svc.changePassphrase(PASS, NEW_PASS), code('NO_VAULT'));
});

// ---- saving ------------------------------------------------------------------

test('save requires a signed-in session', async () => {
  const { svc } = await setup();
  await assert.rejects(() => svc.saveCurrent(), code('NOT_LOGGED_IN'));
});

test('save stores the session under the detected username and never in plaintext', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-alice');
  const r = await svc.saveCurrent();
  assert.equal(r.updated, false);
  const list = await svc.list();
  assert.equal(list.accounts.length, 1);
  assert.equal(list.accounts[0].label, 'alice');
  assert.equal(list.accounts[0].username, 'alice');
  assert.equal(list.activeId, r.id);
  assert.ok(!('cookies' in list.accounts[0]), 'list must not expose cookies');

  const atRest = JSON.stringify(fake.chrome.storage.local.data);
  for (const secret of ['sess-alice', 'tok-sess', 'edge-sess', 'alice', 'reddit_session']) {
    assert.ok(!atRest.includes(secret), `"${secret}" leaked into storage`);
  }
});

test('saving the same user again updates instead of duplicating', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-alice');
  const first = await svc.saveCurrent();
  const second = await svc.saveCurrent({ label: 'renamed' });
  assert.equal(second.updated, true);
  assert.equal(second.id, first.id);
  const { accounts } = await svc.list();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].label, 'renamed');
});

test('label rules: length, empty, and clashes with another account', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-alice');
  await assert.rejects(() => svc.saveCurrent({ label: 'x'.repeat(41) }), code('BAD_LABEL'));
  await svc.saveCurrent({ label: 'shared' });
  loginAs(fake, 'sess-bob');
  await assert.rejects(() => svc.saveCurrent({ label: 'SHARED' }), code('LABEL_TAKEN'));
  assert.equal((await svc.list()).accounts.length, 1);
});

test('account limit is enforced', async () => {
  const users = {};
  for (let i = 0; i <= MAX_ACCOUNTS; i++) users[`sess-u${i}`] = `u${i}`;
  const { fake, svc } = await setup({ users });
  for (let i = 0; i < MAX_ACCOUNTS; i++) {
    loginAs(fake, `sess-u${i}`);
    await svc.saveCurrent();
  }
  loginAs(fake, `sess-u${MAX_ACCOUNTS}`);
  await assert.rejects(() => svc.saveCurrent(), code('TOO_MANY'));
  assert.equal((await svc.list()).accounts.length, MAX_ACCOUNTS);
});

// ---- switching ---------------------------------------------------------------

test('switching swaps the whole cookie set and reloads Reddit tabs', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-alice');
  const a = await svc.saveCurrent();
  loginAs(fake, 'sess-bob');
  const b = await svc.saveCurrent();
  fake.state.tabs = [{ id: 7 }, { id: 9 }];

  const r = await svc.switchTo(a.id);
  assert.equal(r.label, 'alice');
  assert.equal(sessionValue(fake), 'sess-alice');
  const cookies = [...fake.jar.values()];
  assert.equal(cookies.length, 3);
  assert.equal(cookies.find((c) => c.name === 'token_v2').value, 'tok-sess-alice');
  assert.equal(cookies.find((c) => c.name === 'edgebucket').value, 'edge-sess-alice');
  assert.equal((await svc.list()).activeId, a.id);
  assert.deepEqual(fake.state.reloaded.sort(), [7, 9]);

  await svc.switchTo(b.id);
  assert.equal(sessionValue(fake), 'sess-bob');
  assert.equal(cookies.length, 3);
  assert.equal((await svc.list()).activeId, b.id);
});

test('switching leaves cookies for other sites alone', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-alice');
  const a = await svc.saveCurrent();
  loginAs(fake, 'sess-bob');
  await svc.saveCurrent();
  fake.jar.set('keep|.example.com|/', { name: 'keep', value: 'mine', domain: '.example.com', path: '/', hostOnly: false });
  await svc.switchTo(a.id);
  assert.equal(fake.jar.get('keep|.example.com|/').value, 'mine');
});

test('rotated session cookies are saved when you switch away', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-alice');
  const a = await svc.saveCurrent();
  loginAs(fake, 'sess-bob');
  const b = await svc.saveCurrent();
  await svc.switchTo(a.id);

  // Reddit rotates alice's session while she browses.
  fake.jar.get('reddit_session|.reddit.com|/').value = 'sess-alice-2';
  await svc.switchTo(b.id);
  assert.equal(sessionValue(fake), 'sess-bob');
  await svc.switchTo(a.id);
  assert.equal(sessionValue(fake), 'sess-alice-2');
});

test('an unsaved signed-in account blocks the switch and nothing is changed', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-alice');
  const a = await svc.saveCurrent();
  loginAs(fake, 'sess-carol'); // signed in, never saved

  await assert.rejects(
    () => svc.switchTo(a.id),
    (e) => e.code === 'UNSAVED_SESSION' && e.message.includes('u/carol'),
  );
  assert.equal(sessionValue(fake), 'sess-carol');

  const r = await svc.switchTo(a.id, { force: true });
  assert.equal(r.label, 'alice');
  assert.equal(sessionValue(fake), 'sess-alice');
});

test('a failed restore rolls the browser back to the previous session', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-alice');
  const a = await svc.saveCurrent();
  loginAs(fake, 'sess-bob');
  const b = await svc.saveCurrent();

  const realSet = fake.chrome.cookies.set;
  fake.chrome.cookies.set = async (d) => (d.value === 'sess-alice' ? null : realSet(d));

  await assert.rejects(() => svc.switchTo(a.id), code('RESTORE_FAILED'));
  assert.equal(sessionValue(fake), 'sess-bob');
  assert.equal(fake.jar.size, 3);
  assert.equal((await svc.list()).activeId, b.id);
  assert.deepEqual(fake.state.reloaded, []);
});

test('an expired saved session reports SESSION_EXPIRED and rolls back', async () => {
  let t = Date.now();
  const { fake, svc } = await setup({ now: () => t });
  loginAs(fake, 'sess-alice', { expires: Math.floor(t / 1000) + 3600 });
  const a = await svc.saveCurrent();
  loginAs(fake, 'sess-bob');
  await svc.saveCurrent();

  t += 2 * 3600 * 1000; // two hours later alice's cookies have expired
  await assert.rejects(() => svc.switchTo(a.id), code('SESSION_EXPIRED'));
  assert.equal(sessionValue(fake), 'sess-bob');
});

test('switching to an account that no longer exists is refused', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-alice');
  await svc.saveCurrent();
  await assert.rejects(() => svc.switchTo('does-not-exist'), code('NOT_FOUND'));
  assert.equal(sessionValue(fake), 'sess-alice');
});

test('when Reddit cannot be reached, nothing is overwritten on a guess', async () => {
  const { fake, svc } = await setup({ users: {} }); // every identity lookup fails
  loginAs(fake, 'sess-x');
  await assert.rejects(() => svc.saveCurrent(), code('BAD_LABEL')); // no username to default to
  const m = await svc.saveCurrent({ label: 'mystery' });
  assert.equal((await svc.list()).accounts[0].username, null);

  loginAs(fake, 'sess-y');
  const r = await svc.switchTo(m.id); // identity unknown, so no false "unsaved" alarm
  assert.equal(r.label, 'mystery');
  assert.equal(sessionValue(fake), 'sess-x');
});

// ---- new login / remove ------------------------------------------------------

test('prepareNewLogin signs out, keeps the vault, and saves rotated cookies first', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-alice');
  const a = await svc.saveCurrent();
  fake.jar.get('reddit_session|.reddit.com|/').value = 'sess-alice-2';

  await svc.prepareNewLogin();
  assert.equal(fake.jar.size, 0);
  assert.equal((await svc.list()).activeId, null);
  assert.equal((await svc.list()).accounts.length, 1);

  await svc.switchTo(a.id);
  assert.equal(sessionValue(fake), 'sess-alice-2');
});

test('prepareNewLogin will not discard an unsaved session unless forced', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-carol');
  await assert.rejects(() => svc.prepareNewLogin(), code('UNSAVED_SESSION'));
  assert.equal(sessionValue(fake), 'sess-carol');
  await svc.prepareNewLogin({ force: true });
  assert.equal(fake.jar.size, 0);
});

test('remove deletes the account and clears the active marker', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-alice');
  const a = await svc.saveCurrent();
  await svc.removeAccount(a.id);
  const list = await svc.list();
  assert.equal(list.accounts.length, 0);
  assert.equal(list.activeId, null);
  await assert.rejects(() => svc.removeAccount(a.id), code('NOT_FOUND'));
});

// ---- settings ------------------------------------------------------------------

test('auto-lock minutes are validated and re-arm the alarm', async () => {
  const { fake, svc } = await setup();
  for (const bad of [0, -5, 1.5, 1441, '5', null, NaN]) {
    await assert.rejects(() => svc.setIdleMinutes(bad), code('BAD_SETTING'));
  }
  const st = await svc.setIdleMinutes(30);
  assert.equal(st.idleMinutes, 30);
  assert.equal(fake.state.alarms.get(ALARM_NAME).delayInMinutes, 30);
});

// ---- backup --------------------------------------------------------------------

test('export is encrypted; import into a fresh browser needs the passphrase', async () => {
  const a = await setup();
  loginAs(a.fake, 'sess-alice');
  await a.svc.saveCurrent();
  const json = await a.svc.exportVault();
  for (const secret of ['sess-alice', 'tok-sess', 'alice', 'reddit_session']) {
    assert.ok(!json.includes(secret), `"${secret}" leaked into export`);
  }

  const b = await setup({ create: false });
  const st = await b.svc.importVault(json);
  assert.equal(st.exists, true);
  assert.equal(st.unlocked, false);
  await assert.rejects(() => b.svc.unlock('wrong passphrase!!'), code('DECRYPT_FAILED'));
  await b.svc.unlock(PASS);
  const { accounts } = await b.svc.list();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].username, 'alice');

  // and the imported session actually works
  b.fake.jar.clear();
  await b.svc.switchTo(accounts[0].id);
  assert.equal(sessionValue(b.fake), 'sess-alice');
});

test('import rejects garbage, weak settings and oversized input', async () => {
  const { svc } = await setup();
  const good = JSON.parse(await svc.exportVault());
  await assert.rejects(() => svc.importVault('not json'), code('BAD_VAULT'));
  await assert.rejects(() => svc.importVault('{}'), code('BAD_VAULT'));
  await assert.rejects(() => svc.importVault(JSON.stringify({ ...good, iterations: 1000 })), code('BAD_VAULT'));
  await assert.rejects(() => svc.importVault(JSON.stringify({ ...good, kdf: 'none' })), code('BAD_VAULT'));
  await assert.rejects(() => svc.importVault(JSON.stringify({ ...good, ct: 'AAAA' })), code('BAD_VAULT'));
  await assert.rejects(() => svc.importVault('x'.repeat(9 * 1024 * 1024)), code('BAD_VAULT'));
  await assert.rejects(() => svc.importVault(undefined), code('BAD_VAULT'));
  // the existing vault is untouched by failed imports
  assert.equal((await svc.list()).accounts.length, 0);
});

test('import keeps only known fields and locks the vault', async () => {
  const { fake, svc } = await setup();
  const good = JSON.parse(await svc.exportVault());
  await svc.importVault(JSON.stringify({ ...good, evil: '<script>', extra: { a: 1 } }));
  assert.deepEqual(Object.keys(fake.chrome.storage.local.data.vault).sort(), ['ct', 'iterations', 'iv', 'kdf', 'salt', 'v']);
  assert.equal((await svc.status()).unlocked, false);
  assert.equal(fake.chrome.storage.session.data.sessionKey, undefined);
});

test('a tampered import is detected when unlocking', async () => {
  const { svc } = await setup();
  const good = JSON.parse(await svc.exportVault());
  const bytes = Buffer.from(good.ct, 'base64');
  bytes[3] ^= 1;
  await svc.importVault(JSON.stringify({ ...good, ct: bytes.toString('base64') }));
  await assert.rejects(() => svc.unlock(PASS), code('DECRYPT_FAILED'));
});

// ---- passphrase ----------------------------------------------------------------

test('change passphrase re-encrypts with a new salt and keeps the accounts', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-alice');
  await svc.saveCurrent();
  const before = structuredClone(fake.chrome.storage.local.data.vault);

  await assert.rejects(() => svc.changePassphrase('wrong passphrase!!', NEW_PASS), code('DECRYPT_FAILED'));
  await assert.rejects(() => svc.changePassphrase(PASS, 'short'), code('WEAK_PASSPHRASE'));
  assert.deepEqual(fake.chrome.storage.local.data.vault, before, 'failed attempts must not modify the vault');

  const st = await svc.changePassphrase(PASS, NEW_PASS);
  assert.equal(st.unlocked, true);
  const after = fake.chrome.storage.local.data.vault;
  assert.notEqual(after.salt, before.salt);
  assert.notEqual(after.ct, before.ct);

  await svc.lock();
  await assert.rejects(() => svc.unlock(PASS), code('DECRYPT_FAILED'));
  await svc.unlock(NEW_PASS);
  assert.equal((await svc.list()).accounts.length, 1);
});

// ---- reset ---------------------------------------------------------------------

test('delete vault removes saved sessions but leaves the browser signed in', async () => {
  const { fake, svc } = await setup();
  loginAs(fake, 'sess-alice');
  await svc.saveCurrent();
  const st = await svc.resetAll();
  assert.deepEqual(st, { exists: false, unlocked: false, idleMinutes: DEFAULT_IDLE_MINUTES });
  assert.equal(fake.chrome.storage.local.data.vault, undefined);
  assert.equal(sessionValue(fake), 'sess-alice');
});

// ---- identity lookup -----------------------------------------------------------

test('username detection only accepts plausible Reddit usernames', async () => {
  const mk = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });
  const run = async (fetchImpl) => (await setup({ fetchImpl })).svc.detectUsername();

  assert.equal(await run(mk({ data: { name: 'some_user-1' } })), 'some_user-1');
  assert.equal(await run(mk({ data: { name: '<script>alert(1)</script>' } })), null);
  assert.equal(await run(mk({ data: { name: 'a'.repeat(40) } })), null);
  assert.equal(await run(mk({ data: { name: 42 } })), null);
  assert.equal(await run(mk({})), null);
  assert.equal(await run(mk({ data: { name: 'x' } }, false)), null);
  assert.equal(await run(async () => { throw new Error('offline'); }), null);
  assert.equal(await run(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })), null);
});

test('no identity lookup happens when nobody is signed in', async () => {
  const { fake, svc, fetch } = await setup();
  fake.jar.clear();
  await assert.rejects(() => svc.saveCurrent(), code('NOT_LOGGED_IN'));
  assert.equal(fetch.calls, 0);
});
