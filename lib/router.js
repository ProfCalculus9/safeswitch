// Maps popup messages onto service methods. Only names listed here are
// callable, and secrets (cookies) never appear in any response.

export function createRouter(service) {
  const handlers = {
    status: () => service.status(),
    instagramList: () => service.instagramList(),
    instagramSave: (a) => service.instagramSave({ label: a.label }),
    instagramSwitch: (a) => service.instagramSwitch(a.id, { force: !!a.force }),
    instagramPrepareLogin: (a) => service.instagramPrepareLogin({ force: !!a.force }),
    instagramRemove: (a) => service.instagramRemove(a.id),
    createVault: (a) => service.createVault(a.passphrase),
    unlock: (a) => service.unlock(a.passphrase),
    lock: () => service.lock(),
    list: () => service.list(),
    detectUsername: () => service.detectUsername(),
    saveCurrent: (a) => service.saveCurrent({ label: a.label }),
    switchTo: (a) => service.switchTo(a.id, { force: !!a.force }),
    prepareNewLogin: (a) => service.prepareNewLogin({ force: !!a.force }),
    removeAccount: (a) => service.removeAccount(a.id),
    setIdleMinutes: (a) => service.setIdleMinutes(a.minutes),
    exportVault: () => service.exportVault(),
    importVault: (a) => service.importVault(a.json),
    changePassphrase: (a) => service.changePassphrase(a.oldPassphrase, a.newPassphrase),
    resetAll: () => service.resetAll(),
  };

  return async function handle(msg) {
    const type = msg && typeof msg === 'object' ? msg.type : undefined;
    if (typeof type !== 'string' || !Object.hasOwn(handlers, type)) {
      return { ok: false, error: { code: 'BAD_REQUEST', message: 'Unknown request.' } };
    }
    try {
      return { ok: true, result: await handlers[type](msg.args ?? {}) };
    } catch (err) {
      return { ok: false, error: { code: err?.code || 'ERROR', message: err?.message || 'Something went wrong.' } };
    }
  };
}
