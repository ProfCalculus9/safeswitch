# SafeSwitch

A Manifest V3 extension for Brave / Chrome / Edge that switches between Reddit accounts using an **encrypted vault of session cookies**.

It never asks for, sees or stores your Reddit password. You sign in to Reddit normally (2FA works), then save that session. Switching swaps the saved cookies back in.

## Install in Brave (unpacked)

1. Unzip the folder somewhere permanent (Brave reads it from there on every start).
2. Open `brave://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `safeswitch` folder (the one containing `manifest.json`).
4. Pin the extension from the puzzle-piece menu.

## Quick start (about two minutes)

1. Click the SafeSwitch icon and create a vault with a master passphrase (10+ characters). Write it down: there is no recovery.
2. Sign in to Reddit account 1 as usual. Open SafeSwitch, type a label (for example "Main") and press **Save current session**.
3. Press **Sign in to another account...**. This clears Reddit's sign-in in this browser *without* using Reddit's own Log out, so account 1's session is not ended. Your open Reddit tabs reload signed out; click **Log In** there (or go to reddit.com/login).
4. Sign in to account 2, open SafeSwitch, type a different label and press **Save current session**.
5. Press **Switch** next to either account whenever you like. Open Reddit tabs reload as that account.

> **Used Reddit's own "Log out" on a saved account?** Reddit ends that session, so switching to it shows you as a guest. Sign in to that account again: SafeSwitch updates the saved copy the next time you switch away from it (or press **Save current session** to do it right away). After that, both accounts stay signed in.

The **Help** button in the popup (also opened automatically on first install) has the full illustrated guide: step-by-step screenshots, everyday use, troubleshooting and backup.

Other things you can do:
- **Settings & backup**: auto-lock timer, encrypted export/import, change passphrase, delete vault.
- Forgot your passphrase? Use **Forgot your passphrase?** on the unlock screen to delete the vault and start again.
- If the popup closes when a file picker opens, use **Open in tab** and do import/export from there.

## How it works

| Piece | Detail |
|---|---|
| Key derivation | PBKDF2-SHA256, 600,000 iterations, random 16-byte salt |
| Encryption | AES-256-GCM, fresh random 96-bit IV on every write; header fields are authenticated |
| At rest | Only one item in `chrome.storage.local`: the encrypted blob. Labels, usernames, cookies and the active account are all inside it |
| Unlocked key | Derived key kept in `chrome.storage.session` (memory only, extension contexts only). Wiped on lock, auto-lock timeout and browser restart |
| Network | One request: `old.reddit.com/api/me.json`, to learn which username the current cookies belong to. No analytics, no remote code, no other servers |
| Permissions | `cookies`, `storage`, `alarms`, host access to `*.reddit.com` only |
| Safety rails | Refuses to switch away from a signed-in account that isn't saved (so you don't lose a session); rolls back to the previous session if a restore fails; never writes cookies for non-Reddit domains; imported vaults with weak or absurd KDF settings are rejected |

## Threat model

**Protects against**
- Someone copying your browser profile, a backup, or the exported file: they get ciphertext.
- Anyone using your machine after the vault auto-locks or the browser restarts.
- Plaintext password exposure: there are no passwords to expose. (RES stores them unencrypted.)

**Does not protect against**
- Malware running as you while the vault is unlocked, or another extension with cookie access. They can already read your live Reddit session cookie without this extension.
- A weak master passphrase. PBKDF2 slows guessing but cannot save a guessable passphrase.
- Reddit revoking a session. Saved sessions expire like any login; re-save when that happens.
- A compromised copy of this extension. It is a small unpacked codebase (about 1,100 lines, no dependencies) you can read end to end. Don't load modified copies from anywhere else.

## Not yet verified against live Reddit

Tested with unit tests and a real Chromium run using seeded cookies, but never against the real reddit.com. Check these on first use:
- **Login detection** treats the `reddit_session` cookie as "signed in". If saving says "No signed-in Reddit session found" while you are signed in, Reddit uses a different cookie name for your account type; that is a one-line change in `lib/cookies.js`.
- **Username detection** (the me.json call). If it fails you just see "username unknown" and must type a label; saving and switching still work, but the unsaved-session warning is weaker.
- **Session binding.** If Reddit ties a session to other signals and signs you out after a switch, saved sessions won't survive switching; separate Brave profiles would then be the safer approach.

## Develop

```
npm test        # 60 unit tests: crypto, cookie handling, vault service, message router
```

No dependencies or build step. Files: `lib/crypto.js` (vault crypto), `lib/cookies.js` (capture/restore), `lib/service.js` (all vault logic), `lib/router.js` (popup messages), `background.js` (service worker), `popup/` (UI and the Help guide, `popup/help.html`).

## Privacy

See [PRIVACY.md](PRIVACY.md). SafeSwitch keeps everything on your device and sends nothing to the developer.

## License

MIT, see [LICENSE](LICENSE).

## Disclaimer

SafeSwitch is an independent project and is not affiliated with or endorsed by Reddit. It is provided as is; keep your master passphrase safe, because a forgotten passphrase cannot be recovered.
