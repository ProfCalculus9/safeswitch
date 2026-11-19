// Cookie helpers for capturing and restoring a Reddit session.
// Every function takes the `chrome` API object so it can be tested with a fake.

export const REDDIT_DOMAIN = 'reddit.com';
export const SESSION_COOKIE = 'reddit_session';

const bare = (d) => String(d || '').replace(/^\./, '').toLowerCase();

// True only for reddit.com and its subdomains (not "evilreddit.com").
export function isRedditCookie(c) {
  const d = bare(c?.domain);
  return d === REDDIT_DOMAIN || d.endsWith('.' + REDDIT_DOMAIN);
}

// The URL the cookies API needs in order to set or remove this cookie.
export function cookieUrl(c) {
  return `${c.secure ? 'https' : 'http'}://${bare(c.domain)}${c.path || '/'}`;
}

// Reddit sets reddit_session only for signed-in users.
export function isLoggedIn(cookies) {
  return cookies.some((c) => c.name === SESSION_COOKIE && typeof c.value === 'string' && c.value.length > 0);
}

function toStored(c) {
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    hostOnly: !!c.hostOnly,
    sameSite: c.sameSite || 'unspecified',
  };
  if (!c.session && typeof c.expirationDate === 'number') out.expirationDate = c.expirationDate;
  return out;
}

export async function snapshotCookies(api) {
  const all = await api.cookies.getAll({ domain: REDDIT_DOMAIN });
  return all.filter(isRedditCookie).map(toStored);
}

export async function clearRedditCookies(api) {
  const all = (await api.cookies.getAll({ domain: REDDIT_DOMAIN })).filter(isRedditCookie);
  await Promise.all(
    all.map((c) => Promise.resolve(api.cookies.remove({ url: cookieUrl(c), name: c.name })).catch(() => null)),
  );
  return all.length;
}

// nowSec: current time in seconds, used to skip cookies that already expired.
export async function restoreCookies(api, cookies, nowSec = Date.now() / 1000) {
  let restored = 0;
  let skipped = 0;
  let failed = 0;
  for (const c of cookies) {
    // Defence in depth: never write a cookie for any site except Reddit,
    // even if the stored data were somehow altered.
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string' || !isRedditCookie(c)) {
      skipped++;
      continue;
    }
    if (typeof c.expirationDate === 'number' && c.expirationDate <= nowSec) {
      skipped++;
      continue;
    }
    const details = {
      url: cookieUrl(c),
      name: c.name,
      value: c.value,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
    };
    if (!c.hostOnly) details.domain = c.domain; // host-only cookies must not carry a domain
    if (c.sameSite) details.sameSite = c.sameSite;
    if (typeof c.expirationDate === 'number') details.expirationDate = c.expirationDate;
    try {
      const res = await api.cookies.set(details);
      if (res) restored++;
      else failed++;
    } catch {
      failed++;
    }
  }
  return { restored, skipped, failed };
}
