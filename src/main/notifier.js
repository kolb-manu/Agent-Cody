'use strict';
/*
 * Native OS notifications via Electron's Notification API (Notification Center on macOS,
 * Action Center toasts on Windows). Clicking a notification calls onClick(sessionId).
 * Session alerts are also handed to Telegram (if connected), independently of the OS notification.
 */
const path = require('path');
const { Notification } = require('electron');

// Windows/Linux show this in the toast; macOS always uses the app icon.
const ICON = process.platform === 'darwin' ? undefined : path.join(__dirname, '..', 'assets', 'logo-256.png');

/** Store notification kinds → the three user-facing settings categories. */
const CATEGORY = {
  permission: 'attention', question: 'attention',
  done: 'finished',
  error: 'stopped', stopped: 'stopped', stale: 'stopped',
};

class Notifier {
  constructor({ settings, onClick, telegram = null }) {
    this.settings = settings;
    this.onClick = onClick;
    this.telegram = telegram;  // TelegramService or null
    this.live = new Set();     // keep references so Windows click handlers aren't garbage-collected
    this.lastSent = new Map(); // `${sessionId}:${kind}` -> time, to rate-limit duplicates
  }

  notify(n) {
    const category = CATEGORY[n.kind] || 'stopped';
    if (this.settings.get(`notify.${category}`) === false) return;
    const key = `${n.sessionId}:${n.kind}`;
    const now = Date.now();
    if (now - (this.lastSent.get(key) || 0) < 4000) return;
    this.lastSent.set(key, now);

    try { this.showDesktop(n, category); } catch (err) { console.warn('[agent-cody] notification failed:', err && err.message); }
    // Fire and forget: Telegram never delays the desktop notification, and works without it.
    if (this.telegram) this.telegram.alert(n).catch(() => {});
  }

  showDesktop(n, category) {
    if (!Notification.isSupported()) return;
    const notif = new Notification({
      title: n.title,
      body: n.body || '',
      silent: this.settings.get('sound') === false,
      urgency: category === 'attention' ? 'critical' : 'normal',
      icon: ICON,
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

  /** A notification about the app itself (e.g. a new version), not about a session. */
  notifyApp({ title, body, onClick }) {
    if (!Notification.isSupported()) return;
    const notif = new Notification({ title, body: body || '', silent: this.settings.get('sound') === false, icon: ICON });
    this.live.add(notif);
    const drop = () => this.live.delete(notif);
    notif.on('click', () => { drop(); if (onClick) onClick(); });
    notif.on('close', drop);
    notif.on('failed', drop);
    notif.show();
    setTimeout(drop, 10 * 60 * 1000).unref?.();
  }
}

module.exports = { Notifier, CATEGORY };
