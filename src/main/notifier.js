'use strict';
/*
 * Native OS notifications via Electron's Notification API (Notification Center on macOS,
 * Action Center toasts on Windows). Clicking a notification calls onClick(sessionId).
 */
const { Notification } = require('electron');

/** Store notification kinds → the three user-facing settings categories. */
const CATEGORY = {
  permission: 'attention', question: 'attention',
  done: 'finished',
  error: 'stopped', stopped: 'stopped', stale: 'stopped',
};

class Notifier {
  constructor({ settings, onClick }) {
    this.settings = settings;
    this.onClick = onClick;
    this.live = new Set();     // keep references so Windows click handlers aren't garbage-collected
    this.lastSent = new Map(); // `${sessionId}:${kind}` -> time, to rate-limit duplicates
  }

  notify(n) {
    if (!Notification.isSupported()) return;
    const category = CATEGORY[n.kind] || 'stopped';
    if (this.settings.get(`notify.${category}`) === false) return;
    const key = `${n.sessionId}:${n.kind}`;
    const now = Date.now();
    if (now - (this.lastSent.get(key) || 0) < 4000) return;
    this.lastSent.set(key, now);

    const notif = new Notification({
      title: n.title,
      body: n.body || '',
      silent: this.settings.get('sound') === false,
      urgency: category === 'attention' ? 'critical' : 'normal',
    });
    this.live.add(notif);
    const drop = () => this.live.delete(notif);
    notif.on('click', () => { drop(); this.onClick(n.sessionId); });
    notif.on('close', drop);
    notif.on('failed', drop);
    notif.show();
    // Don't hold references forever if the OS never reports close.
    setTimeout(drop, 10 * 60 * 1000).unref?.();
  }
}

module.exports = { Notifier, CATEGORY };
