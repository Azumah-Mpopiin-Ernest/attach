const APP = 'LHIMS_ASSIST_APP';
const EXT = 'LHIMS_ASSIST_EXT';
const pending = new Map();
const listeners = new Set();
let seq = 0;
let started = false;

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const d = e.data;
    if (!d || d.source !== EXT) return;
    if (d.type === 'RESPONSE') {
      const p = pending.get(d.requestId);
      if (!p) return;
      pending.delete(d.requestId);
      clearTimeout(p.timer);
      if (d.ok) p.resolve(d.data); else p.reject(new Error(d.error));
      return;
    }
    listeners.forEach((fn) => fn(d));
  });
}

export function request(type, payload = {}, timeoutMs = 4000) {
  start();
  return new Promise((resolve, reject) => {
    const requestId = `r${++seq}`;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('TIMEOUT')); }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    window.postMessage({ source: APP, type, requestId, payload }, window.location.origin);
  });
}

export function subscribe(fn) {
  start();
  listeners.add(fn);
  return () => listeners.delete(fn);
}