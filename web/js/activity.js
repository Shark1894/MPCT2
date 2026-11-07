// Time tracking in the page (Stats tab): ticks a TimeTracker once a second, notes your input,
// and sends stretches to the server every 30 s, when they end, and when the page is hidden.

import { TimeTracker } from './activity-core.js';

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function send(stretch, keepalive = false) {
  return fetch('/api/time', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stretch),
    keepalive,
  }).catch(() => {}); // a missed report is only a few seconds of stats
}

/**
 * Start counting. resolve() says what you're doing right now ({category, activity, detail}) or
 * null for pages that don't count (the Training hub, Stats). Returns {flush} to send the open
 * stretch now (before showing stats).
 */
export function startTimeTracking(resolve) {
  const tracker = new TimeTracker({ uuid });
  const touch = () => tracker.input(Date.now());
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(ev, touch, { capture: true, passive: true });
  }
  let lastMove = 0;
  window.addEventListener(
    'pointermove',
    () => {
      const now = Date.now();
      if (now - lastMove > 5000) {
        lastMove = now;
        touch();
      }
    },
    { capture: true, passive: true },
  );
  touch(); // opening the page counts as being there

  const visible = () => document.visibilityState === 'visible';
  const tick = () => {
    let activity = null;
    try {
      activity = resolve();
    } catch {
      activity = null;
    }
    for (const s of tracker.tick(Date.now(), visible(), activity)) send(s);
  };
  const flush = (keepalive = false) => {
    const p = tracker.pending();
    return p ? send(p, keepalive) : Promise.resolve();
  };
  setInterval(tick, 1000);
  setInterval(() => flush(), 30000);
  document.addEventListener('visibilitychange', () => {
    if (!visible()) flush(true);
  });
  window.addEventListener('pagehide', () => flush(true));
  return { tracker, flush: () => flush() };
}
