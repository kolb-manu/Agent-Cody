'use strict';
/*
 * macOS update check: compare the latest GitHub Release with the running version.
 * Pure and Electron-free so it can be unit-tested; main.js does the fetching and the UI.
 * (Windows uses electron-updater instead, which can install updates itself.)
 */

const REPO = 'kolb-manu/Agent-Cody';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE_URL = `https://github.com/${REPO}/releases/latest`;

/** "v1.2.3" / "1.2.3" / "1.2.3-beta.1" → [1, 2, 3], or null if it isn't a version. */
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\s*$/i.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 1 if a > b, -1 if a < b, 0 if equal. Unparseable versions count as older than anything valid. */
function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

/** Strip a leading "v": "v0.2.0" → "0.2.0". */
function cleanVersion(v) {
  const p = parseVersion(v);
  return p ? p.join('.') : null;
}

/**
 * GitHub "latest release" JSON → { version, downloadUrl, pageUrl } or null if it's unusable.
 * downloadUrl is the DMG for this CPU (arm64 / x64), or the release page if that asset is missing.
 */
function parseLatestRelease(json, arch) {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) return null;
  const version = cleanVersion(json.tag_name);
  if (!version) return null;
  const pageUrl = typeof json.html_url === 'string' && json.html_url.startsWith('https://') ? json.html_url : RELEASES_PAGE_URL;
  const suffix = `mac-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
  const asset = (Array.isArray(json.assets) ? json.assets : []).find((a) =>
    a && typeof a.name === 'string' && a.name.endsWith(suffix) &&
    typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith('https://'));
  return { version, downloadUrl: asset ? asset.browser_download_url : pageUrl, pageUrl };
}

/** The release if it's newer than what's running, otherwise null. */
function newerRelease(json, currentVersion, arch) {
  const r = parseLatestRelease(json, arch);
  return r && compareVersions(r.version, currentVersion) > 0 ? r : null;
}

module.exports = { LATEST_RELEASE_URL, RELEASES_PAGE_URL, parseVersion, compareVersions, cleanVersion, parseLatestRelease, newerRelease };
