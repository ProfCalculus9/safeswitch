// Service worker: owns the vault. The popup is only a thin UI that sends
// messages here, so a switch keeps running even if the popup closes mid-way.

import { createService } from './lib/service.js';
import { createRouter } from './lib/router.js';

const service = createService({ chrome, fetch: globalThis.fetch.bind(globalThis) });
const handle = createRouter(service);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only this extension's own pages may talk to the vault.
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg).then(sendResponse);
  return true; // keep the channel open for the async response
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === service.ALARM_NAME) service.lock();
});

// The in-memory key is wiped when the browser closes; make that explicit.
chrome.runtime.onStartup.addListener(() => {
  service.lock();
});
