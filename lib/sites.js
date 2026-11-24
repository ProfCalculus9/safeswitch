// Supported websites for the context-aware popup. A site is marked enabled
// only when its session adapter is implemented and tested.
export const SITES = Object.freeze([
  { id: 'reddit', name: 'Reddit', domains: ['reddit.com'], enabled: true },
  { id: 'instagram', name: 'Instagram', domains: ['instagram.com'], enabled: false },
  { id: 'facebook', name: 'Facebook', domains: ['facebook.com'], enabled: false },
  { id: 'x', name: 'X', domains: ['x.com', 'twitter.com'], enabled: false },
]);

// Do not use substring matching: fake-reddit.com must never match reddit.com.
export function matchSite(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return SITES.find(({ domains }) =>
    domains.some((d) => hostname === d || hostname.endsWith('.' + d))
  ) ?? null;
}

export function siteById(id) {
  return SITES.find((site) => site.id === id) ?? null;
}
