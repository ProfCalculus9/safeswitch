// A small in-memory stand-in for the parts of the `chrome` API that SafeSwitch uses.
// The cookie jar follows real browser rules closely enough to catch mistakes:
// host-only vs domain cookies, path scoping, and removal by url + name.

const bare = (d) => d.replace(/^\./, '').toLowerCase();

function makeArea() {
  const data = {};
  return {
    data,
    async get(key) {
      if (key == null) return structuredClone(data);
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
    },
    async remove(key) {
      for (const k of Array.isArray(key) ? key : [key]) delete data[k];
    },
  };
}

export function createFakeChrome() {
  const jar = new Map(); // key: name|domain|path -> cookie
  const keyOf = (c) => `${c.name}|${c.domain}|${c.path}`;
  const state = { setCalls: 0, failSetFor: new Set(), alarms: new Map(), reloaded: [], tabs: [] };

  const cookies = {
    jar,
    async getAll({ domain } = {}) {
      const d = domain ? bare(domain) : null;
      return [...jar.values()]
        .filter((c) => {
          if (!d) return true;
          const cd = bare(c.domain);
          return cd === d || cd.endsWith('.' + d);
        })
        .map((c) => structuredClone(c));
    },
    async set(details) {
      state.setCalls++;
      if (state.failSetFor.has(details.name)) return null; // browsers return null when a set is rejected
      const url = new URL(details.url);
      const hostOnly = details.domain === undefined;
      const domain = hostOnly ? url.hostname : details.domain.startsWith('.') ? details.domain : '.' + details.domain;
      const c = {
        name: details.name,
        value: details.value,
        domain,
        hostOnly,
        path: details.path || '/',
        secure: !!details.secure,
        httpOnly: !!details.httpOnly,
        sameSite: details.sameSite || 'unspecified',
        session: details.expirationDate === undefined,
        storeId: '0',
      };
      if (details.expirationDate !== undefined) c.expirationDate = details.expirationDate;
      jar.set(keyOf(c), c);
      return structuredClone(c);
    },
    async remove({ url, name }) {
      const host = new URL(url).hostname;
      const path = new URL(url).pathname;
      let removed = null;
      for (const [k, c] of jar) {
        const cd = bare(c.domain);
        const hostMatches = c.hostOnly ? host === cd : host === cd || host.endsWith('.' + cd);
        if (c.name === name && hostMatches && c.path === path) {
          jar.delete(k);
          removed = { url, name };
        }
      }
      return removed;
    },
  };

  const chrome = {
    cookies,
    storage: { local: makeArea(), session: makeArea() },
    alarms: {
      async create(name, info) {
        state.alarms.set(name, info);
      },
      async clear(name) {
        return state.alarms.delete(name);
      },
    },
    tabs: {
      async query() {
        return state.tabs.map((t) => ({ ...t }));
      },
      async reload(id) {
        state.reloaded.push(id);
      },
    },
    runtime: { id: 'test-extension-id' },
  };

  return { chrome, state, jar };
}

// Put a signed-in Reddit session into the jar, the way a real login would.
export function loginAs(fake, sessionValue, { expires = Math.floor(Date.now() / 1000) + 86400 } = {}) {
  fake.jar.clear();
  const base = { path: '/', secure: true, sameSite: 'lax', session: false, storeId: '0', expirationDate: expires };
  const put = (c) => {
    const full = { ...base, ...c };
    fake.jar.set(`${full.name}|${full.domain}|${full.path}`, full);
  };
  put({ name: 'reddit_session', value: sessionValue, domain: '.reddit.com', hostOnly: false, httpOnly: true });
  put({ name: 'token_v2', value: `tok-${sessionValue}`, domain: '.reddit.com', hostOnly: false, httpOnly: false });
  put({ name: 'edgebucket', value: `edge-${sessionValue}`, domain: 'www.reddit.com', hostOnly: true, httpOnly: false });
}

// A fetch() stand-in for Reddit's me.json: the username comes from the session cookie
// currently in the jar. Map session value -> username, e.g. { 'sess-alice': 'alice' }.
export function fakeRedditFetch(fake, users) {
  const fn = async () => {
    fn.calls++;
    const s = [...fake.jar.values()].find((c) => c.name === 'reddit_session');
    const name = s && users[s.value];
    if (!name) return { ok: false, status: 403, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: { name } }) };
  };
  fn.calls = 0;
  return fn;
}
