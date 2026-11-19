# SafeSwitch Privacy Policy

**Effective date:** 18 November 2026

SafeSwitch is a browser extension that lets you switch between Reddit accounts in one browser. This policy explains what data it handles.

**In short:** SafeSwitch does not collect, transmit, sell or share any of your data with the developer or anyone else. Everything it stores stays on your device, inside your browser profile, in encrypted form.

## What SafeSwitch handles

When you press "Save current session", SafeSwitch stores:

- the Reddit session cookies of the account you are signed in to (authentication information),
- the label you give the account, and
- the Reddit username that the session belongs to.

All of this is kept in the browser's local extension storage, **encrypted** with AES-256-GCM. The encryption key is derived from your master passphrase (PBKDF2-SHA256, 600,000 iterations, random salt).

- Your master passphrase is never stored. A key derived from it is held in memory only while the vault is unlocked, and is discarded when you lock the vault, when the auto-lock timer runs out, or when the browser closes.
- SafeSwitch never asks for, reads or stores your Reddit password.
- Your auto-lock setting (a number of minutes) is stored locally and is not secret.

## Network requests

SafeSwitch makes one kind of network request: to `https://old.reddit.com/api/me.json`, using your own Reddit session, to find out which username the current session belongs to. This is a request to Reddit itself, the same as visiting Reddit, and the response is used only on your device.

SafeSwitch has no servers of its own and sends nothing to the developer or any third party. It contains no analytics, telemetry, advertising or remote code.

## Sharing and use of data

- Your data is not sold, rented, shared or transferred to anyone.
- Your data is used only to provide the single feature of switching between your Reddit accounts.
- Your data is not used for advertising, for credit or lending decisions, or for any purpose unrelated to that feature.

## Exports

If you choose "Export encrypted vault", SafeSwitch writes a file containing your encrypted vault to a location you pick. The file is unreadable without your master passphrase. You are responsible for where you keep it.

## Permissions

- **cookies** and **access to \*.reddit.com**: to read the Reddit session cookies you choose to save and to restore them when you switch accounts. SafeSwitch never reads or writes cookies for any other site.
- **storage**: to keep the encrypted vault (and, in memory only, the unlock key).
- **alarms**: to lock the vault automatically after a period of inactivity.

## Your control

You can remove any saved account, or delete the entire vault, from SafeSwitch's settings. Uninstalling the extension removes all of its stored data. If you forget your master passphrase the vault cannot be recovered; you would need to delete it, sign in to Reddit again and re-save your accounts.

## Changes to this policy

If this policy changes, the updated version will be published at this address with a new effective date.

## Contact

Questions or concerns: https://github.com/ProfCalculus9/safeswitch/issues

SafeSwitch is an independent project and is not affiliated with or endorsed by Reddit.
