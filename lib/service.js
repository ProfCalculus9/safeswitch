// The vault service: all state-changing logic lives here so it can run in the
// background service worker and be unit-tested against a fake `chrome`.
//
// Storage layout
//   chrome.storage.local   vault     encrypted blob (see crypto.js)
//                          settings  { idleMinutes }  (not secret)
//   chrome.storage.session sessionKey  derived key, in memory only. Cleared when
//                          the browser closes or the vault is locked.
//
// Everything sensitive (labels, usernames, cookies, which account is active)
// is inside the encrypted payload: { accounts: [...], activeId }.

import { VaultError, newHeader, deriveKey, encryptVault, decryptVault, validateBlob } from './crypto.js';
import * as K from './cookies.js';
import * as IG from './instagram.js';

export const MIN_PASSPHRASE_LENGTH = 10;
export const DEFAULT_IDLE_MINUTES = 15;
export const ALARM_NAME = 'safeswitch-autolock';
export const MAX_ACCOUNTS = 25;
export const MAX_LABEL_LENGTH = 40;

const MAX_IMPORT_CHARS = 8 * 1024 * 1024;
const KEY_VAULT = 'vault';
const KEY_SETTINGS = 'settings';
const KEY_SESSION = 'sessionKey';
const ME_URL = 'https://old.reddit.com/api/me.json';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function createService({ chrome: api, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), now = () => Date.now() }) {
  const local = api.storage.local;
  const session = api.storage.session;

  // Run operations one at a time so two popup clicks can never interleave
  // their read-modify-write cycles on the vault.
  let chain = Promise.resolve();
  function serial(fn) {
    const run = chain.then(() => fn());
    chain = run.catch(() => {});
    return run;
  }

  // ---- storage helpers -----------------------------------------------------
  const getLocal = async (key) => (await local.get(key))[key];
  const getSessionKey = async () => (await session.get(KEY_SESSION))[KEY_SESSION];
  const idleMinutes = async () => (await getLocal(KEY_SETTINGS))?.idleMinutes ?? DEFAULT_IDLE_MINUTES;

  async function armAlarm() {
    await api.alarms.create(ALARM_NAME, { delayInMinutes: await idleMinutes() });
  }
  async function unlockWith(key) {
    await session.set({ [KEY_SESSION]: key });
    await armAlarm();
  }
  async function lockNow() {
    await session.remove(KEY_SESSION);
    await api.alarms.clear(ALARM_NAME);
  }

  async function open() {
    const vault = await getLocal(KEY_VAULT);
    if (!vault) throw new VaultError('NO_VAULT', 'No vault exists yet.');
    const key = await getSessionKey();
    if (!key) throw new VaultError('LOCKED', 'The vault is locked.');
    const payload = await decryptVault(key, vault);
    if (!payload || !Array.isArray(payload.accounts)) {
      throw new VaultError('BAD_VAULT', 'The vault contents are malformed.');
    }
    return { vault, key, payload };
  }
  async function persist(ctx) {
    await local.set({ [KEY_VAULT]: await encryptVault(ctx.key, ctx.vault, ctx.payload) });
  }

  async function readStatus() {
    const vault = await getLocal(KEY_VAULT);
    const key = vault ? await getSessionKey() : undefined;
    return { exists: !!vault, unlocked: !!key, idleMinutes: await idleMinutes() };
  }

  function checkPassphrase(p) {
    if (typeof p !== 'string' || p.length < MIN_PASSPHRASE_LENGTH) {
      throw new VaultError('WEAK_PASSPHRASE', `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
    }
  }

  // ---- Reddit identity -----------------------------------------------------
  // Best effort: ask Reddit who the current cookies belong to. Returns null if
  // the request fails for any reason; callers must cope with that.
  async function detectUsernameRaw() {
    if (!fetchImpl) return null;
    try {
      const res = await fetchImpl(ME_URL, {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
      });
      if (!res.ok) return null;
      const name = (await res.json())?.data?.name;
      return typeof name === 'string' && /^[\w-]{1,32}$/.test(name) ? name : null;
    } catch {
      return null;
    }
  }

  async function inspectCurrent() {
    const cookies = await K.snapshotCookies(api);
    const loggedIn = K.isLoggedIn(cookies);
    const name = loggedIn ? await detectUsernameRaw() : null;
    return { cookies, loggedIn, name };
  }

  const matchAccount = (payload, snap) =>
    snap.loggedIn && snap.name ? payload.accounts.find((a) => same(a.username, snap.name)) : undefined;

  // Positive evidence that the browser holds a session the vault doesn't know.
  const isUnsaved = (payload, snap) => snap.loggedIn && !!snap.name && !matchAccount(payload, snap);

  // Refresh the stored cookies of the account the browser is currently signed
  // in as (rotated tokens), but only when Reddit confirms the identity. We never
  // overwrite a saved account on a guess.
  function refreshMatching(payload, snap) {
    const match = matchAccount(payload, snap);
    if (!match) return false;
    match.cookies = snap.cookies;
    match.savedAt = now();
    return true;
  }

  async function reloadRedditTabs() {
    try {
      const tabs = await api.tabs.query({ url: ['https://*.reddit.com/*'] });
      await Promise.all(tabs.map((t) => Promise.resolve(api.tabs.reload(t.id)).catch(() => null)));
    } catch {
      /* tabs are a convenience; ignore */
    }
  }

  async function rollback(cookies) {
    try {
      await K.clearRedditCookies(api);
      if (cookies.length) await K.restoreCookies(api, cookies, now() / 1000);
    } catch {
      /* best effort */
    }
  }

  function unsavedError(snap) {
    return new VaultError('UNSAVED_SESSION', `u/${snap.name} is signed in to Reddit but is not saved in the vault.`);
  }

  // ---- Experimental Instagram adapter ------------------------------------
  // Store Instagram accounts within the SAME encrypted vault, separate from
  // legacy Reddit accounts. Existing vaults need no migration and remain readable.
  const igAccounts = (payload) => {
    if (!Array.isArray(payload.instagramAccounts)) payload.instagramAccounts = [];
    return payload.instagramAccounts;
  };

  async function igCurrent() {
    const cookies = await IG.snapshot(api);
    return { cookies, userId: IG.identity(cookies) };
  }

  async function reloadInstagramTabs() {
    try {
      const tabs = await api.tabs.query({ url: ['https://*.instagram.com/*'] });
      await Promise.all(tabs.map((t) => Promise.resolve(api.tabs.reload(t.id)).catch(() => null)));
    } catch { /* convenience only */ }
  }

  async function igRollback(previous) {
    try {
      await IG.clear(api);
      await IG.restore(api, previous, now() / 1000);
    } catch { /* report failed switch; rollback is best effort */ }
  }

  // ---- public API ----------------------------------------------------------
  return {
    ALARM_NAME,

    status: () => serial(readStatus),

    instagramList: () =>
      serial(async () => {
        const { payload } = await open();
        await armAlarm();
        return {
          activeId: payload.instagramActiveId ?? null,
          accounts: igAccounts(payload).map(({ id, label, userId, savedAt }) => ({ id, label, userId, savedAt })),
        };
      }),

    instagramSave: ({ label } = {}) =>
      serial(async () => {
        const ctx = await open();
        const snap = await igCurrent();
        if (!snap.userId) {
          throw new VaultError('NOT_LOGGED_IN', 'No Instagram session detected. Sign in on instagram.com, then retry.');
        }
        const accounts = igAccounts(ctx.payload);
        const clean = String(label || '').trim();
        if (!clean || clean.length > MAX_LABEL_LENGTH) {
          throw new VaultError('BAD_LABEL', 'Enter an account label (1 to 40 characters).');
        }
        const matched = accounts.find((a) => a.userId === snap.userId);
        const taken = accounts.find((a) => same(a.label, clean) && a !== matched);
        if (taken) throw new VaultError('LABEL_TAKEN', 'That label belongs to another Instagram account.');
        if (!matched && accounts.length >= MAX_ACCOUNTS) {
          throw new VaultError('TOO_MANY', 'Maximum 25 Instagram accounts.');
        }
        const account = matched ?? { id: crypto.randomUUID(), userId: snap.userId };
        Object.assign(account, { label: clean, cookies: snap.cookies, savedAt: now() });
        if (!matched) accounts.push(account);
        ctx.payload.instagramActiveId = account.id;
        await persist(ctx);
        await armAlarm();
        return { updated: !!matched };
      }),

    instagramSwitch: (id, { force = false } = {}) =>
      serial(async () => {
        const ctx = await open();
        const accounts = igAccounts(ctx.payload);
        const target = accounts.find((a) => a.id === id);
        if (!target) throw new VaultError('NOT_FOUND', 'Instagram account not found.');
        const previous = await igCurrent();
        const current = accounts.find((a) => a.userId === previous.userId);
        if (previous.userId && !current && !force) {
          throw new VaultError('UNSAVED_SESSION', 'An unsaved Instagram session is active. Save it before switching.');
        }
        if (current) {
          current.cookies = previous.cookies;
          current.savedAt = now();
        }
        try {
          await IG.clear(api);
          await IG.restore(api, target.cookies, now() / 1000);
          const restored = await igCurrent();
          if (restored.userId !== target.userId) {
            throw new VaultError('RESTORE_FAILED', 'Instagram session cookies could not be verified locally.');
          }
        } catch (e) {
          await igRollback(previous.cookies);
          await persist(ctx);
          throw e;
        }
        ctx.payload.instagramActiveId = target.id;
        await persist(ctx);
        await armAlarm();
        await reloadInstagramTabs();
        return { label: target.label, verifiedLocally: true };
      }),

    instagramPrepareLogin: ({ force = false } = {}) =>
      serial(async () => {
        const ctx = await open();
        const previous = await igCurrent();
        const accounts = igAccounts(ctx.payload);
        const current = accounts.find((a) => a.userId === previous.userId);
        if (previous.userId && !current && !force) {
          throw new VaultError('UNSAVED_SESSION', 'An unsaved Instagram session is active. Save it first.');
        }
        if (current) {
          current.cookies = previous.cookies;
          current.savedAt = now();
        }
        try {
          await IG.clear(api);
        } catch (e) {
          await igRollback(previous.cookies);
          throw e;
        }
        ctx.payload.instagramActiveId = null;
        await persist(ctx);
        await armAlarm();
        await reloadInstagramTabs();
        return { ok: true };
      }),

    instagramRemove: (id) =>
      serial(async () => {
        const ctx = await open();
        const before = igAccounts(ctx.payload);
        const after = before.filter((a) => a.id !== id);
        if (before.length === after.length) throw new VaultError('NOT_FOUND', 'Instagram account not found.');
        ctx.payload.instagramAccounts = after;
        if (ctx.payload.instagramActiveId === id) ctx.payload.instagramActiveId = null;
        await persist(ctx);
        await armAlarm();
        return { removed: true };
      }),



    createVault: (passphrase) =>
      serial(async () => {
        if (await getLocal(KEY_VAULT)) throw new VaultError('VAULT_EXISTS', 'A vault already exists.');
        checkPassphrase(passphrase);
        const header = newHeader();
        const key = await deriveKey(passphrase, header);
        const blob = await encryptVault(key, header, { accounts: [], activeId: null });
        await local.set({ [KEY_VAULT]: blob });
        await unlockWith(key);
        return readStatus();
      }),

    unlock: (passphrase) =>
      serial(async () => {
        const vault = await getLocal(KEY_VAULT);
        if (!vault) throw new VaultError('NO_VAULT', 'No vault exists yet.');
        validateBlob(vault);
        const key = await deriveKey(passphrase, vault);
        await decryptVault(key, vault); // throws DECRYPT_FAILED on a wrong passphrase
        await unlockWith(key);
        return readStatus();
      }),

    lock: () =>
      serial(async () => {
        await lockNow();
        return readStatus();
      }),

    list: () =>
      serial(async () => {
        const { payload } = await open();
        await armAlarm();
        return {
          activeId: payload.activeId ?? null,
          accounts: payload.accounts.map((a) => ({
            id: a.id,
            label: a.label,
            username: a.username ?? null,
            savedAt: a.savedAt,
          })),
        };
      }),

    detectUsername: () => detectUsernameRaw(),

    saveCurrent: ({ label } = {}) =>
      serial(async () => {
        const ctx = await open();
        const { payload } = ctx;
        const snap = await inspectCurrent();
        if (!snap.loggedIn) {
          throw new VaultError('NOT_LOGGED_IN', 'No signed-in Reddit session found. Sign in to Reddit first.');
        }
        const clean = String(label || snap.name || '').trim();
        if (!clean || clean.length > MAX_LABEL_LENGTH) {
          throw new VaultError('BAD_LABEL', `Enter a label (1 to ${MAX_LABEL_LENGTH} characters).`);
        }

        const byUser = snap.name ? payload.accounts.find((a) => same(a.username, snap.name)) : undefined;
        const byLabel = payload.accounts.find((a) => same(a.label, clean));
        let acct;
        let updated = true;
        if (byUser) {
          if (byLabel && byLabel !== byUser) throw new VaultError('LABEL_TAKEN', 'That label belongs to another saved account.');
          acct = byUser;
        } else if (byLabel) {
          if (byLabel.username && snap.name) throw new VaultError('LABEL_TAKEN', 'That label belongs to another saved account.');
          acct = byLabel;
        } else {
          if (payload.accounts.length >= MAX_ACCOUNTS) {
            throw new VaultError('TOO_MANY', `You can save up to ${MAX_ACCOUNTS} accounts.`);
          }
          acct = { id: crypto.randomUUID() };
          payload.accounts.push(acct);
          updated = false;
        }
        acct.label = clean;
        acct.username = snap.name ?? acct.username ?? null;
        acct.cookies = snap.cookies;
        acct.savedAt = now();
        payload.activeId = acct.id;
        await persist(ctx);
        await armAlarm();
        return { id: acct.id, updated };
      }),

    switchTo: (id, { force = false } = {}) =>
      serial(async () => {
        const ctx = await open();
        const { payload } = ctx;
        const target = payload.accounts.find((a) => a.id === id);
        if (!target) throw new VaultError('NOT_FOUND', 'That account is no longer in the vault.');

        const snap = await inspectCurrent();
        if (!force && isUnsaved(payload, snap)) throw unsavedError(snap);
        refreshMatching(payload, snap);

        let outcome;
        try {
          await K.clearRedditCookies(api);
          outcome = await K.restoreCookies(api, target.cookies, now() / 1000);
          const after = await K.snapshotCookies(api);
          if (!K.isLoggedIn(after)) {
            throw outcome.failed > 0
              ? new VaultError('RESTORE_FAILED', 'Could not restore the saved session cookies.')
              : new VaultError('SESSION_EXPIRED', 'This saved session has expired. Sign in to Reddit and save it again.');
          }
        } catch (err) {
          await rollback(snap.cookies);
          await persist(ctx); // keep any refreshed snapshot
          throw err;
        }

        payload.activeId = target.id;
        await persist(ctx);
        await armAlarm();
        await reloadRedditTabs();
        return { label: target.label, restored: outcome.restored };
      }),

    // Clears Reddit cookies so you can sign in to another account normally.
    prepareNewLogin: ({ force = false } = {}) =>
      serial(async () => {
        const ctx = await open();
        const { payload } = ctx;
        const snap = await inspectCurrent();
        if (!force && isUnsaved(payload, snap)) throw unsavedError(snap);
        refreshMatching(payload, snap);
        await K.clearRedditCookies(api);
        payload.activeId = null;
        await persist(ctx);
        await armAlarm();
        await reloadRedditTabs();
        return { ok: true };
      }),

    removeAccount: (id) =>
      serial(async () => {
        const ctx = await open();
        const before = ctx.payload.accounts.length;
        ctx.payload.accounts = ctx.payload.accounts.filter((a) => a.id !== id);
        if (ctx.payload.accounts.length === before) throw new VaultError('NOT_FOUND', 'That account is no longer in the vault.');
        if (ctx.payload.activeId === id) ctx.payload.activeId = null;
        await persist(ctx);
        await armAlarm();
        return { removed: true };
      }),

    setIdleMinutes: (minutes) =>
      serial(async () => {
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
          throw new VaultError('BAD_SETTING', 'Auto-lock must be between 1 and 1440 minutes.');
        }
        await local.set({ [KEY_SETTINGS]: { idleMinutes: minutes } });
        if (await getSessionKey()) await armAlarm();
        return readStatus();
      }),

    // The export is the encrypted blob itself: safe to store anywhere, useless
    // without the passphrase.
    exportVault: () =>
      serial(async () => {
        const vault = await getLocal(KEY_VAULT);
        if (!vault) throw new VaultError('NO_VAULT', 'No vault exists yet.');
        return JSON.stringify(vault, null, 2);
      }),

    importVault: (text) =>
      serial(async () => {
        if (typeof text !== 'string' || text.length > MAX_IMPORT_CHARS) {
          throw new VaultError('BAD_VAULT', 'That file is not a SafeSwitch vault.');
        }
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new VaultError('BAD_VAULT', 'That file is not a SafeSwitch vault.');
        }
        const blob = {
          v: parsed?.v,
          kdf: parsed?.kdf,
          iterations: parsed?.iterations,
          salt: parsed?.salt,
          iv: parsed?.iv,
          ct: parsed?.ct,
        };
        validateBlob(blob);
        await local.set({ [KEY_VAULT]: blob });
        await lockNow(); // must unlock with the imported vault's own passphrase
        return readStatus();
      }),

    changePassphrase: (oldPassphrase, newPassphrase) =>
      serial(async () => {
        const vault = await getLocal(KEY_VAULT);
        if (!vault) throw new VaultError('NO_VAULT', 'No vault exists yet.');
        validateBlob(vault);
        const oldKey = await deriveKey(oldPassphrase, vault);
        const payload = await decryptVault(oldKey, vault); // verifies the old passphrase
        checkPassphrase(newPassphrase);
        const header = newHeader(); // fresh salt
        const newKey = await deriveKey(newPassphrase, header);
        await local.set({ [KEY_VAULT]: await encryptVault(newKey, header, payload) });
        await unlockWith(newKey);
        return readStatus();
      }),

    // Deletes the vault and everything in it. Does not touch Reddit cookies.
    resetAll: () =>
      serial(async () => {
        await local.remove(KEY_VAULT);
        await lockNow();
        return readStatus();
      }),
  };
}
