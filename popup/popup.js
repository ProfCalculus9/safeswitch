// Popup UI. It never sees cookies or the encryption key: it only sends
// messages to the background worker and renders the answers. All text is set
// with textContent (never innerHTML), so account labels can't inject markup.

import { matchSite } from '../lib/sites.js';

const view = document.getElementById('view');
const banner = document.getElementById('banner');
const btnLock = document.getElementById('btn-lock');
const btnTab = document.getElementById('btn-tab');
const btnHelp = document.getElementById('btn-help');

const IN_TAB = new URLSearchParams(location.search).has('tab');

async function getCurrentSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return matchSite(tab?.url);
  } catch {
    return null;
  }
}

function renderSiteNotice(site) {
  const content = site
    ? [h('h2', {}, site.name + ' support is coming'),
       h('p', {}, 'SafeSwitch recognized ' + site.name + ', but its session adapter is not available yet. No cookies will be accessed or changed for this website.'),
       h('p', { class: 'hint' }, 'Reddit is currently the only supported account switcher.')]
    : [h('h2', {}, 'Open a supported website'),
       h('p', {}, 'Open Reddit in the active browser tab, then click the SafeSwitch toolbar icon to manage Reddit accounts.'),
       h('p', { class: 'hint' }, 'Instagram, Facebook and X adapters are planned, but not yet enabled.')];
  view.replaceChildren(h('section', { class: 'stack' }, ...content));
}

if (IN_TAB) document.body.classList.add('tab-mode');

// ---- helpers ---------------------------------------------------------------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function send(type, args = {}) {
  return chrome.runtime.sendMessage({ type, args }).then((res) => {
    if (!res) throw Object.assign(new Error('No response from the background worker.'), { code: 'NO_RESPONSE' });
    if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
    return res.result;
  });
}

let bannerTimer;
function say(kind, text, sticky = false) {
  clearTimeout(bannerTimer);
  banner.className = `banner ${kind}`;
  banner.textContent = text;
  banner.hidden = false;
  if (!sticky) bannerTimer = setTimeout(() => (banner.hidden = true), 5000);
}
function clearBanner() {
  clearTimeout(bannerTimer);
  banner.hidden = true;
}

// Disable a button while an async action runs.
async function busy(btn, fn) {
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
  }
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// ---- views -----------------------------------------------------------------

async function render() {
  let status;
  try {
    status = await send('status');
  } catch (e) {
    view.replaceChildren(h('p', {}, 'Could not reach the extension background: ' + e.message));
    return;
  }
  btnLock.hidden = !status.unlocked;
  btnTab.hidden = IN_TAB;
  // The popup's website context is determined by the current active tab.
  // Never offer Reddit actions on another domain.
  const site = await getCurrentSite();
  if (!site || !site.enabled) {
    renderSiteNotice(site);
    return;
  }
  if (!status.exists) return renderCreate();
  if (!status.unlocked) return renderUnlock();
  if (site.id === 'instagram') return renderInstagramMain(status);
  return renderMain(status);
}

function renderCreate() {
  const pass = h('input', { type: 'password', id: 'p1', autocomplete: 'new-password', minlength: '10' });
  const pass2 = h('input', { type: 'password', id: 'p2', autocomplete: 'new-password' });
  const go = h('button', { class: 'primary full', type: 'submit' }, 'Create vault');

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        if (pass.value !== pass2.value) return say('err', 'The two passphrases do not match.');
        try {
          await busy(go, () => send('createVault', { passphrase: pass.value }));
          pass.value = pass2.value = '';
          render();
          say('ok', 'Vault created. New here? Press Help (top right) for a 2-minute guide.');
        } catch (err) {
          say('err', err.message);
        }
      },
    },
    h('p', {}, 'Choose a master passphrase. It encrypts your saved account sessions on this device. SafeSwitch never stores your site passwords, and if you forget this passphrase the vault cannot be recovered.'),
    h('div', { class: 'field' }, h('label', { for: 'p1' }, 'Master passphrase (10+ characters)'), pass),
    h('div', { class: 'field' }, h('label', { for: 'p2' }, 'Repeat passphrase'), pass2),
    go,
    h('div', { class: 'hint' }, 'Already have an exported vault? ', h('button', { class: 'link', type: 'button', onclick: renderImportOnly }, 'Import it')),
  );
  view.replaceChildren(form);
  pass.focus();
}

function renderImportOnly() {
  const file = h('input', { type: 'file', accept: '.json,application/json' });
  view.replaceChildren(
    h(
      'div',
      { class: 'stack' },
      h('p', {}, 'Choose a vault file exported from SafeSwitch. You will unlock it with the passphrase it was created with.'),
      file,
      h('button', { class: 'link', type: 'button', onclick: render }, 'Back'),
    ),
  );
  file.addEventListener('change', () => importFile(file));
}

async function forgotPassphrase() {
  if (!confirm('A forgotten passphrase cannot be recovered. You can delete the vault and start again, but every session saved in it will be lost. Your current Reddit login in the browser is not affected.\n\nDelete the vault?')) return;
  try {
    await send('resetAll');
    say('ok', 'Vault deleted. You can create a new one.');
    render();
  } catch (err) {
    say('err', err.message);
  }
}

function renderUnlock() {
  const pass = h('input', { type: 'password', id: 'unlock-pass', autocomplete: 'current-password' });
  const go = h('button', { class: 'primary full', type: 'submit' }, 'Unlock');
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await busy(go, () => send('unlock', { passphrase: pass.value }));
          pass.value = '';
          clearBanner();
          render();
        } catch (err) {
          say('err', err.message);
          pass.select();
        }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'unlock-pass' }, 'Master passphrase'), pass),
    go,
    h('div', { class: 'hint' }, h('button', { class: 'link', type: 'button', onclick: forgotPassphrase }, 'Forgot your passphrase?')),
  );
  view.replaceChildren(form);
  pass.focus();
}

async function renderMain(status) {
  let data;
  try {
    data = await send('list');
  } catch (e) {
    if (e.code === 'LOCKED') return render();
    say('err', e.message, true);
    return;
  }

  const sections = [h('div', { class: 'site-context' }, 'Reddit · reddit.com')];

  // Saved accounts
  const list = h('ul', { class: 'accounts' });
  for (const a of data.accounts) {
    const isActive = a.id === data.activeId;
    const switchBtn = h('button', { class: isActive ? '' : 'primary', type: 'button', disabled: isActive }, isActive ? 'Active' : 'Switch');
    switchBtn.addEventListener('click', () => doSwitch(a, switchBtn));
    const del = h('button', { class: 'danger', type: 'button', title: `Remove ${a.label}`, 'aria-label': `Remove ${a.label}` }, 'Remove');
    del.addEventListener('click', async () => {
      if (!confirm(`Remove "${a.label}" from the vault? You can save it again later by signing in.`)) return;
      try {
        await send('removeAccount', { id: a.id });
        render();
      } catch (err) {
        say('err', err.message);
      }
    });
    list.append(
      h(
        'li',
        { class: 'account' + (isActive ? ' active' : '') },
        h(
          'div',
          { class: 'meta' },
          h('div', { class: 'name' }, h('span', { class: 'label' }, a.label), isActive ? h('span', { class: 'badge' }, 'current') : null),
          h('div', { class: 'sub' }, [a.username ? `u/${a.username}` : 'username unknown', a.savedAt ? ` · saved ${ago(a.savedAt)}` : ''].join('')),
        ),
        switchBtn,
        del,
      ),
    );
  }
  sections.push(
    h(
      'section',
      {},
      h('h2', {}, 'Accounts'),
      data.accounts.length ? list : h('div', { class: 'empty' }, 'No accounts saved yet. Sign in to Reddit normally, then use "Save current session" below. New here? Press Help (top right) for a 2-minute guide.'),
    ),
  );

  // Save current
  const label = h('input', { type: 'text', id: 'label', maxlength: '40', placeholder: 'Label (defaults to your username)' });
  const saveBtn = h('button', { class: 'full', type: 'submit' }, 'Save current session');
  sections.push(
    h(
      'section',
      {},
      h('h2', {}, 'Save'),
      h(
        'form',
        {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const r = await busy(saveBtn, () => send('saveCurrent', { label: label.value }));
              say('ok', r.updated ? 'Session updated.' : 'Session saved.');
              render();
            } catch (err) {
              say('err', err.message);
            }
          },
        },
        label,
        saveBtn,
        h('div', { class: 'hint' }, 'Saves whichever Reddit account this browser is signed in to right now.'),
      ),
    ),
  );

  // Add another
  const newBtn = h('button', { class: 'full', type: 'button' }, 'Sign in to another account…');
  newBtn.addEventListener('click', () => doNewLogin(newBtn));
  sections.push(
    h(
      'section',
      {},
      newBtn,
      h('div', { class: 'hint' }, 'Signs this browser out of Reddit (your saved sessions stay in the vault) so you can log in as a different account.'),
    ),
  );

  sections.push(renderSettings(status));
  view.replaceChildren(...sections);
}

// Instagram deliberately requests cookie access only when the user chooses it.
// Account switching remains opt-in and is not run on opening a website.
const INSTAGRAM_ORIGINS = ['https://*.instagram.com/*'];

async function renderInstagramMain(status) {
  let permission = false;
  try {
    permission = await chrome.permissions.contains({ origins: INSTAGRAM_ORIGINS });
  } catch (err) {
    return view.replaceChildren(h('p', {}, 'Could not check Instagram permission: ' + err.message));
  }
  if (!permission) {
    const grant = h('button', { class: 'primary full' }, 'Enable Instagram switching');
    grant.addEventListener('click', async () => {
      try {
        const granted = await chrome.permissions.request({ origins: INSTAGRAM_ORIGINS });
        if (!granted) return say('warn', 'Instagram permission was not granted.', true);
        render();
      } catch (err) { say('err', err.message, true); }
    });
    view.replaceChildren(h('section', { class: 'stack' },
      h('h2', {}, 'Instagram · Experimental'),
      h('p', {}, 'To save and switch Instagram sessions, allow access to Instagram cookies. Reddit stays independent.'),
      grant,
      h('p', { class: 'hint' }, 'Only instagram.com host permission is requested. Never grant account access to an extension you do not trust.')
    ));
    return;
  }
  let data;
  try {
    data = await send('instagramList');
  } catch (err) {
    say('err', err.message, true);
    return;
  }
  const sections = [
    h('div', { class: 'site-context' }, 'Instagram · Experimental'),
    h('p', { class: 'hint' }, 'Switching restores encrypted session cookies locally. Instagram may still require reauthentication. Verify the displayed account after each switch.'),
  ];
  const list = h('ul', { class: 'accounts' });
  for (const account of data.accounts) {
    const active = data.activeId === account.id;
    const switchBtn = h('button', { class: active ? '' : 'primary', disabled: active }, active ? 'Saved as active' : 'Switch');
    switchBtn.addEventListener('click', () => igSwitch(account, switchBtn));
    const removeBtn = h('button', { class: 'danger', title: 'Remove this saved Instagram account' }, 'Remove');
    removeBtn.addEventListener('click', async () => {
      if (!confirm('Remove "' + account.label + '" from the encrypted vault?')) return;
      try {
        await send('instagramRemove', { id: account.id });
        render();
      } catch (err) { say('err', err.message, true); }
    });
    list.append(h('li', { class: 'account' },
      h('div', { class: 'meta' },
        h('div', { class: 'name' }, account.label),
        h('div', { class: 'sub' }, 'Instagram user ID: ' + account.userId + ' · saved ' + ago(account.savedAt))
      ), switchBtn, removeBtn));
  }
  sections.push(h('section', {},
    h('h2', {}, 'Instagram accounts'),
    data.accounts.length ? list : h('div', { class: 'empty' },
      'No Instagram accounts saved yet. Sign in to Instagram normally, then save this session below.')
  ));
  const label = h('input', { type: 'text', maxlength: '40', placeholder: 'Account label, e.g. Personal' });
  const saveBtn = h('button', { class: 'primary full', type: 'submit' }, 'Save current Instagram session');
  sections.push(h('form', { class: 'stack', onsubmit: async (event) => {
    event.preventDefault();
    try {
      const result = await busy(saveBtn, () => send('instagramSave', { label: label.value }));
      say('ok', result.updated ? 'Instagram session updated.' : 'Instagram session saved.');
      render();
    } catch (err) { say('err', err.message, true); }
  } }, label, saveBtn));
  const newBtn = h('button', { class: 'full' }, 'Sign in to another Instagram account…');
  newBtn.addEventListener('click', () => igNewLogin(newBtn));
  sections.push(h('section', {}, newBtn,
    h('p', { class: 'hint' }, 'With permission, clears Instagram cookies and website storage without calling Instagram Log out. This may erase Instagram drafts and preferences; save your current session first.')
  ));
  sections.push(renderSettings(status));
  view.replaceChildren(...sections);
}

async function igSwitch(account, btn, force = false) {
  try {
    const result = await busy(btn, () => send('instagramSwitch', { id: account.id, force }));
    say('ok', 'Cookies restored for ' + result.label + '. Check Instagram to confirm that you are logged in.');
    render();
  } catch (err) {
    if (err.code === 'UNSAVED_SESSION' && !force) {
      if (confirm(err.message + '\\n\\nSwitch anyway? The current unsaved session may be lost.')) {
        return igSwitch(account, btn, true);
      }
      return;
    }
    say('err', err.message, true);
  }
}

async function igNewLogin(btn, force = false) {
  // Explicit permission and confirmation are required: deleting Instagram
  // origin storage can remove site preferences, saved drafts and offline data.
  // No Facebook, Reddit, browser history or passwords are cleared.
  if (!force) {
    if (!confirm('Prepare a different Instagram login?\\n\\nThis will clear Instagram cookies and site storage (including local drafts/preferences) for instagram.com in this Brave profile. Saved SafeSwitch vault sessions stay encrypted. Other sites are not affected.\\n\\nContinue?')) return;
  }
  try {
    // The permissions prompt must start from the user click, before other
    // async work. It is needed only for this origin-scoped cleanup action.
    const granted = await chrome.permissions.request({ permissions: ['browsingData'] });
    if (!granted) return say('warn', 'Site-data cleanup permission was declined. No session was changed.', true);
    await busy(btn, () => send('instagramPrepareLogin', { force, clearSiteData: true }));
    say('ok', 'Instagram cookies and site storage cleared. Sign in to your other account, then save it.');
    render();
  } catch (err) {
    if (err.code === 'UNSAVED_SESSION' && !force) {
      if (confirm(err.message + '\\n\\nClear the unsaved Instagram session anyway?')) {
        return igNewLogin(btn, true);
      }
      return;
    }
    say('err', err.message, true);
  }
}

async function doSwitch(account, btn, force = false) {
  try {
    const r = await busy(btn, () => send('switchTo', { id: account.id, force }));
    say('ok', `Switched to ${r.label}.`);
    render();
  } catch (err) {
    if (err.code === 'UNSAVED_SESSION' && !force) {
      if (confirm(`${err.message}\n\nSwitching now will sign that account out and its session will be lost unless you save it first.\n\nSwitch anyway?`)) {
        return doSwitch(account, btn, true);
      }
      return say('warn', 'Not switched. Save the current session first.', true);
    }
    say('err', err.message, true);
  }
}

async function doNewLogin(btn, force = false) {
  try {
    await busy(btn, () => send('prepareNewLogin', { force }));
    say('ok', 'Signed out of Reddit. Log in as the other account, then come back and save it.');
    render();
  } catch (err) {
    if (err.code === 'UNSAVED_SESSION' && !force) {
      if (confirm(`${err.message}\n\nSigning out now will lose that session unless you save it first.\n\nSign out anyway?`)) {
        return doNewLogin(btn, true);
      }
      return say('warn', 'Not signed out. Save the current session first.', true);
    }
    say('err', err.message, true);
  }
}

function renderSettings(status) {
  const idle = h('input', { type: 'number', id: 'idle', min: '1', max: '1440', value: String(status.idleMinutes) });
  const idleBtn = h('button', { type: 'button' }, 'Set');
  idleBtn.addEventListener('click', async () => {
    try {
      await busy(idleBtn, () => send('setIdleMinutes', { minutes: Number(idle.value) }));
      say('ok', 'Auto-lock updated.');
    } catch (err) {
      say('err', err.message);
    }
  });

  const exportBtn = h('button', { type: 'button' }, 'Export encrypted vault');
  exportBtn.addEventListener('click', async () => {
    try {
      const json = await busy(exportBtn, () => send('exportVault'));
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = h('a', { href: url, download: `safeswitch-vault-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      say('ok', 'Exported. The file is encrypted and needs your passphrase.');
    } catch (err) {
      say('err', err.message);
    }
  });

  const file = h('input', { type: 'file', accept: '.json,application/json', id: 'import-file' });
  file.addEventListener('change', () => importFile(file));

  const oldP = h('input', { type: 'password', id: 'old-pass', autocomplete: 'current-password' });
  const newP = h('input', { type: 'password', id: 'new-pass', autocomplete: 'new-password' });
  const changeBtn = h('button', { type: 'submit' }, 'Change passphrase');

  const resetBtn = h('button', { class: 'danger', type: 'button' }, 'Delete vault…');
  resetBtn.addEventListener('click', async () => {
    if (!confirm('Delete the vault and every saved session? This cannot be undone. Your current Reddit login in the browser is not affected.')) return;
    try {
      await send('resetAll');
      say('ok', 'Vault deleted.');
      render();
    } catch (err) {
      say('err', err.message);
    }
  });

  return h(
    'details',
    {},
    h('summary', {}, 'Settings & backup'),
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'field' }, h('label', { for: 'idle' }, 'Auto-lock after (minutes of inactivity)'), h('div', { class: 'row' }, h('div', { class: 'grow' }, idle), idleBtn)),
      exportBtn,
      h('div', { class: 'field' }, h('label', { for: 'import-file' }, 'Import a vault file (replaces the current vault)'), file),
      h(
        'form',
        {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await busy(changeBtn, () => send('changePassphrase', { oldPassphrase: oldP.value, newPassphrase: newP.value }));
              oldP.value = newP.value = '';
              say('ok', 'Passphrase changed.');
            } catch (err) {
              say('err', err.message);
            }
          },
        },
        h('div', { class: 'field' }, h('label', { for: 'old-pass' }, 'Current passphrase'), oldP),
        h('div', { class: 'field' }, h('label', { for: 'new-pass' }, 'New passphrase (10+ characters)'), newP),
        changeBtn,
      ),
      resetBtn,
    ),
  );
}

async function importFile(input) {
  const f = input.files?.[0];
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) return say('err', 'That file is too large to be a SafeSwitch vault.');
  try {
    const text = await f.text();
    if (!confirm('Importing replaces the vault on this device with the one in the file. You will unlock it with that vault\'s passphrase. Continue?')) {
      input.value = '';
      return;
    }
    await send('importVault', { json: text });
    say('ok', 'Vault imported. Unlock it with its passphrase.');
    render();
  } catch (err) {
    say('err', err.message);
  } finally {
    input.value = '';
  }
}

// ---- header buttons --------------------------------------------------------

btnLock.addEventListener('click', async () => {
  try {
    await send('lock');
    clearBanner();
    render();
  } catch (err) {
    say('err', err.message);
  }
});

btnTab.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?tab=1') });
  window.close();
});

btnHelp.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup/help.html') });
  if (!IN_TAB) window.close();
});

render();
