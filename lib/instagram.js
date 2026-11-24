// Experimental Instagram cookie adapter. It only touches instagram.com cookies.
// Never share site session cookies with other domains or return them to the popup.
import { VaultError } from './crypto.js';

const DOMAIN = 'instagram.com';
const bare = (domain) => String(domain || '').replace(/^\./, '').toLowerCase();
export const isInstagramCookie = (cookie) => {
  const domain = bare(cookie?.domain);
  return domain === DOMAIN || domain.endsWith('.' + DOMAIN);
};

const cookieUrl = (c) => `${c.secure ? 'https' : 'http'}://${bare(c.domain)}${c.path || '/'}`;

export function identity(cookies) {
  const session = cookies.find((c) => c.name === 'sessionid' && c.value && isInstagramCookie(c));
  const id = cookies.find((c) => c.name === 'ds_user_id' && /^\d+$/.test(c.value || '') && isInstagramCookie(c));
  return session && id ? id.value : null;
}

function serialize(c) {
  const out = {
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    secure: !!c.secure, httpOnly: !!c.httpOnly, hostOnly: !!c.hostOnly,
    sameSite: c.sameSite || 'unspecified',
  };
  if (!c.session && typeof c.expirationDate === 'number') out.expirationDate = c.expirationDate;
  if (c.storeId) out.storeId = c.storeId;
  if (c.partitionKey) out.partitionKey = c.partitionKey;
  return out;
}

export async function snapshot(api) {
  const all = await api.cookies.getAll({ domain: DOMAIN });
  return all.filter(isInstagramCookie).map(serialize);
}

export async function clear(api) {
  const cookies = await snapshot(api);
  let failed = 0;
  for (const c of cookies) {
    const args = { url: cookieUrl(c), name: c.name };
    if (c.storeId) args.storeId = c.storeId;
    if (c.partitionKey) args.partitionKey = c.partitionKey;
    try {
      const removed = await api.cookies.remove(args);
      if (!removed) failed++;
    } catch {
      failed++;
    }
  }
  if (failed) throw new VaultError('CLEAR_FAILED', 'Could not remove all Instagram cookies. No account switch completed.');
  return cookies.length;
}

export async function restore(api, cookies, nowSec = Date.now() / 1000) {
  let restored = 0;
  for (const c of cookies) {
    if (!isInstagramCookie(c) || typeof c.name !== 'string' || typeof c.value !== 'string') {
      throw new VaultError('BAD_SESSION', 'Saved session contains an invalid Instagram cookie.');
    }
    if (typeof c.expirationDate === 'number' && c.expirationDate <= nowSec) continue;
    const args = {
      url: cookieUrl(c), name: c.name, value: c.value,
      path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly,
    };
    if (!c.hostOnly) args.domain = c.domain;
    if (c.sameSite) args.sameSite = c.sameSite;
    if (typeof c.expirationDate === 'number') args.expirationDate = c.expirationDate;
    if (c.storeId) args.storeId = c.storeId;
    if (c.partitionKey) args.partitionKey = c.partitionKey;
    const result = await api.cookies.set(args);
    if (!result) throw new VaultError('RESTORE_FAILED', 'Browser rejected an Instagram session cookie.');
    restored++;
  }
  return restored;
}
