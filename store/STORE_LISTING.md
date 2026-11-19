# SafeSwitch: Chrome Web Store submission, copy and paste sheet

Fields are in the order the Developer Dashboard shows them. Anything in `[brackets]` is for you to fill in.

## Package tab
Upload `safeswitch-0.1.0-store.zip`. For future updates, raise `"version"` in `manifest.json` (for example 0.1.1) and upload a new zip. The Store rejects a version it has already seen.

## Store listing tab

**Name** (taken from the manifest): SafeSwitch: Encrypted Account Switcher

**Summary** (taken from the manifest): Switch Reddit accounts using an encrypted vault of session cookies. Never asks for or stores your password.

**Category:** Productivity

**Language:** English

**Detailed description:**

```
SafeSwitch lets you keep several Reddit accounts in one browser and switch between them in one click, without ever storing a password.

HOW IT WORKS
• Sign in to Reddit as usual (two-factor authentication works normally).
• Open SafeSwitch and press "Save current session".
• Repeat for each account, then switch from the toolbar. Open Reddit tabs reload automatically.

BUILT FOR SAFETY
• No passwords: SafeSwitch never asks for, sees or stores your Reddit password.
• Encrypted vault: saved sessions are encrypted with AES-256-GCM, using a key derived from your master passphrase (PBKDF2, 600,000 iterations).
• Auto-lock: the vault locks after a period of inactivity that you choose, and whenever the browser closes.
• Local only: everything stays on your device. No servers, no accounts, no analytics, no tracking.
• Guard rails: SafeSwitch warns you before switching away from a signed-in account that is not saved, and rolls back if a switch fails.
• Encrypted backups: export your vault to a file. It is useless without your passphrase.

GOOD TO KNOW
• If you forget your master passphrase the vault cannot be recovered. You can sign in to Reddit again and save your accounts again.
• Saved sessions expire like any Reddit login. If one does, sign in and save it again.
• SafeSwitch is an independent project and is not affiliated with or endorsed by Reddit.
```

**Store icon:** `icons/icon128.png` (already in the zip; upload the same file here).

**Screenshots:** upload the three files in the `screenshots` folder (1280 x 800).

**Optional:** small promo tile, marquee tile, video, homepage URL and support URL can be left empty.

## Privacy tab

**Single purpose description:**

```
Switch between multiple Reddit accounts in one browser by saving each signed-in session in an encrypted local vault and restoring it on demand.
```

**Permission justifications:**

| Permission | Paste this |
|---|---|
| `cookies` | Reads the Reddit session cookies of the account the user chooses to save, and writes them back when the user switches accounts. This is the extension's core function. Only reddit.com cookies are ever read or written. |
| `storage` | Keeps the user's encrypted vault in chrome.storage.local, and the temporary unlock key in chrome.storage.session (memory only, cleared on lock or browser close). |
| `alarms` | Automatically locks the vault after the user-configured period of inactivity. |
| Host permission `https://*.reddit.com/*` | Required to access Reddit cookies, and to request https://old.reddit.com/api/me.json with the user's own session to find out which username is currently signed in. |

**Remote code:** choose "No, I am not using remote code."

**Data usage, "What user data do you collect?":**
- Tick **Authentication information** (the extension handles Reddit session cookies).
- Optional, conservative choice: also tick **Personally identifiable information**, because the Reddit username is stored locally. Over-disclosing is harmless.
- Leave everything else unticked.

**Certifications:** tick all three statements (data is not sold, is not used for unrelated purposes, and is not used for creditworthiness or lending).

**Privacy policy URL:** `[the public link to PRIVACY.md, see the guide]`

## Distribution tab
- **Visibility:** Unlisted
- **Regions:** All regions
- **Pricing:** Free

## Test instructions tab
Paste:

```
No credentials are needed for the extension itself. To test it:
1. Install it, open the popup and create a vault with any passphrase of 10 or more characters.
2. Sign in to reddit.com with any Reddit account, then open the popup and press "Save current session".
3. Sign out and sign in to a second Reddit account (or use "Sign in to another account..."), then press "Save current session" again.
4. Press "Switch" next to the first account. The browser's Reddit session changes to that account and open Reddit tabs reload.
The extension only reads and writes reddit.com cookies. It makes one request, to old.reddit.com/api/me.json, to detect the signed-in username. Reviewers can use their own Reddit accounts.
```

## Before you press Submit
- Fill in the contact line at the bottom of `PRIVACY.md` and confirm the URL opens without signing in.
- Check the developer email and account settings: the dashboard asks you to declare trader or non-trader status. For a free personal project, non-trader is typically right, but read Google's definition for your situation.
