'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compareVersions, cleanVersion, parseLatestRelease, newerRelease, RELEASES_PAGE_URL } = require('../src/main/update-check.js');

const release = (over = {}) => ({
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/kolb-manu/Agent-Cody/releases/tag/v0.2.0',
  draft: false,
  prerelease: false,
  assets: [
    { name: 'Agent-Cody-0.2.0-mac-arm64.dmg', browser_download_url: 'https://example.com/arm64.dmg' },
    { name: 'Agent-Cody-0.2.0-mac-x64.dmg', browser_download_url: 'https://example.com/x64.dmg' },
    { name: 'Agent-Cody-0.2.0-win-x64.exe', browser_download_url: 'https://example.com/win.exe' },
    { name: 'latest.yml', browser_download_url: 'https://example.com/latest.yml' },
  ],
  ...over,
});

test('compareVersions compares numerically, not as strings', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.9.9', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1);
});

test('compareVersions ignores a leading v and treats equal versions as equal', () => {
  assert.equal(compareVersions('v0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('V0.2.0', 'v0.1.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(cleanVersion('v0.2.0'), '0.2.0');
});

test('compareVersions treats junk as older than any real version', () => {
  assert.equal(compareVersions('banana', '0.1.0'), -1);
  assert.equal(compareVersions('0.1.0', ''), 1);
  assert.equal(compareVersions(undefined, null), 0);
  assert.equal(compareVersions('1.2', '0.1.0'), -1);
  assert.equal(compareVersions({}, '0.0.1'), -1);
  assert.equal(cleanVersion('latest'), null);
});

test('parseLatestRelease picks the DMG for the CPU', () => {
  assert.deepEqual(parseLatestRelease(release(), 'arm64'), {
    version: '0.2.0',
    downloadUrl: 'https://example.com/arm64.dmg',
    pageUrl: 'https://github.com/kolb-manu/Agent-Cody/releases/tag/v0.2.0',
  });
  assert.equal(parseLatestRelease(release(), 'x64').downloadUrl, 'https://example.com/x64.dmg');
});

test('parseLatestRelease falls back to the release page if the DMG is missing', () => {
  const r = parseLatestRelease(release({ assets: [{ name: 'Agent-Cody-0.2.0-mac-x64.dmg', browser_download_url: 'https://example.com/x64.dmg' }] }), 'arm64');
  assert.equal(r.downloadUrl, 'https://github.com/kolb-manu/Agent-Cody/releases/tag/v0.2.0');
  const noAssets = parseLatestRelease(release({ assets: undefined, html_url: undefined }), 'arm64');
  assert.equal(noAssets.downloadUrl, RELEASES_PAGE_URL);
  assert.equal(noAssets.pageUrl, RELEASES_PAGE_URL);
});

test('parseLatestRelease rejects malformed responses', () => {
  assert.equal(parseLatestRelease(null, 'arm64'), null);
  assert.equal(parseLatestRelease('not json', 'arm64'), null);
  assert.equal(parseLatestRelease({ message: 'API rate limit exceeded' }, 'arm64'), null);
  assert.equal(parseLatestRelease(release({ tag_name: 'nightly' }), 'arm64'), null);
  assert.equal(parseLatestRelease(release({ draft: true }), 'arm64'), null);
  assert.equal(parseLatestRelease(release({ assets: 'nope' }), 'arm64').downloadUrl, release().html_url);
  assert.equal(parseLatestRelease(release({ assets: [null, { name: 'x-mac-arm64.dmg', browser_download_url: 'javascript:alert(1)' }] }), 'arm64').downloadUrl, release().html_url);
});

test('newerRelease only returns a release that is newer than the running version', () => {
  assert.equal(newerRelease(release(), '0.1.0', 'arm64').version, '0.2.0');
  assert.equal(newerRelease(release(), '0.2.0', 'arm64'), null);
  assert.equal(newerRelease(release(), '0.3.0', 'arm64'), null);
  assert.equal(newerRelease({}, '0.1.0', 'arm64'), null);
});
