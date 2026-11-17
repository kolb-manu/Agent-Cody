# Releasing Agent Cody

Releases are built and published automatically by GitHub Actions (`.github/workflows/release.yml`) when you push a version tag.

## Publish a new version

1. **Bump the version** in `package.json` (for example `"version": "1.0.1"`). `npm version` does this for you without creating a tag:
   ```bash
   npm version 1.0.1 --no-git-tag-version
   ```
2. **Commit** the change on `main`:
   ```bash
   git commit -am "Release 1.0.1"
   ```
3. **Tag** the commit. The tag must be `v` + the exact version in `package.json`, or the workflow stops:
   ```bash
   git tag v1.0.1
   ```
4. **Push** the commit and the tag:
   ```bash
   git push origin main v1.0.1
   ```

That's it. Follow the run under the repo's **Actions** tab (it takes about 10–15 minutes). When it finishes, the release appears under **Releases** with release notes generated from the commits since the last release, plus these files:

| File | For |
| --- | --- |
| `Agent-Cody-1.0.1-mac-arm64.dmg` | Mac with Apple Silicon (M1/M2/M3/M4…) |
| `Agent-Cody-1.0.1-mac-x64.dmg` | Mac with Intel |
| `Agent-Cody-1.0.1-win-x64.exe` | Windows 10/11 installer (per user, no admin) |
| `Agent-Cody-1.0.1-win-x64.exe.blockmap` | Windows auto-update (lets it download only what changed) |
| `latest.yml` | Windows auto-update (tells installed copies which version is newest) |

## What the workflow does

1. **Unit tests** (`npm test`) on Linux, plus a check that the tag matches `package.json`. If either fails, nothing gets built or published.
2. **Build** on a macOS runner and a Windows runner in parallel with electron-builder. The Telegram bot token is written into the app first (see [Telegram alerts](#telegram-alerts)).
   - The Mac apps are *ad-hoc* signed, which is free and needs no certificate. This keeps the app bundle valid, so friends get the normal "unidentified developer" prompt instead of an "app is damaged" error.
   - Each build is smoke-tested: the packaged app is started, and the workflow checks that its local server answers. The Windows smoke test doesn't block a release, because CI desktop sessions can be unreliable.
3. **Release:** creates the GitHub Release for the tag and attaches all installers. If the release already exists (for example after re-running a failed job), the files are replaced.

You can also start the workflow by hand (**Actions → Release → Run workflow**). On a branch, it only builds, and the installers are downloadable from the run page for 14 days. Choose a tag in "Use workflow from" to publish that tag's release.

## In-app updates

Starting with 0.2.0, Agent Cody checks for a new version 10 seconds after it starts and then every 6 hours. Users can turn this off with **Settings → Updates → Check automatically**, or check by hand with **Check for updates**.

- **Windows:** `electron-updater` reads `latest.yml` from the newest GitHub Release, downloads the installer in the background, and installs it when the user clicks **Restart to update** (or the next time they quit the app). The installer is unsigned. That works because no `publisherName` is configured, so electron-updater skips the signature check. The workflow fails the build if `publisherName` ever shows up in `app-update.yml`.
- **macOS:** the ad-hoc signed app can't install updates itself. It calls the GitHub API (`/releases/latest`), and if there's a newer tag it shows "Agent Cody X.Y.Z is available · Download". **Download** opens the right DMG (`mac-arm64` / `mac-x64`) in the browser, and the app explains how to drag the new version over the old one. Settings and hooks live outside the app bundle, so they survive.

Things to keep in mind:

- **Keep `latest.yml` and the `.blockmap` in every release.** The workflow uploads them. If you ever make a release by hand, attach them too, or Windows users won't see it. `latest.yml` names the installer file, so don't rename the `.exe` after building.
- **Only people on 0.2.0 or later get updates.** Anyone still on 0.1.0 has to install 0.2.0 by hand once.
- **The newest release is what counts.** Both platforms look at GitHub's "latest" release, which skips drafts and pre-releases. A pre-release is a safe way to share a test build without offering it to everyone.
- **Version numbers must go up.** Versions are compared as numbers (`0.10.0` is newer than `0.9.9`).

### Testing updates

- **Unit tests:** `npm test` covers version comparison and picking the DMG (`test/update-check.test.js`).
- **Mac, from source:** temporarily set `"version": "0.0.1"` in `package.json`, then run `AGENT_CODY_FORCE_UPDATE_CHECK=1 npm start`. Without that variable, `npm start` never checks for updates. After about 10 seconds the widget and the tray menu offer the latest release. **Download** opens its DMG. Put the version back afterwards. With the real version, **Settings → Check for updates** says "You’re up to date". To test the offline message, turn off Wi-Fi and press **Check for updates**. Automatic checks stay silent when offline.
- **Windows, from source:** `AGENT_CODY_FORCE_UPDATE_CHECK=1 npm start` uses `dev-app-update.yml` in the project folder. It only finds releases that have a `latest.yml`, so 0.2.0 is the first one it can see.
- **Windows, for real:** this can only be tested once two updater-enabled releases exist. Install 0.2.0, publish 0.2.1 (a pre-release won't do, see above), then start 0.2.0. About 10 seconds later it shows "Agent Cody 0.2.1 is ready · Restart to update". The updater logs to the console. When the app is installed, electron-updater also writes `%LOCALAPPDATA%\agent-cody-updater\` (downloads) for debugging.
- **CI:** a manual run of the workflow on a branch checks that `latest.yml` points at the built `.exe`, that the `.blockmap` exists, and that `app-update.yml` is inside the app.

## Telegram alerts

Telegram alerts use one shared bot, **@agentcodyalertsbot**. Each copy of the app talks to the Bot API directly; there is no server.

**The `TELEGRAM_BOT_TOKEN` repository secret is required for releases.** (GitHub → repo **Settings → Secrets and variables → Actions → New repository secret**, name `TELEGRAM_BOT_TOKEN`, value = the token from BotFather.) Before `electron-builder`, both build jobs run `scripts/write-telegram-config.js`, which writes the token to `src/main/telegram-config.json` (gitignored) so it gets packaged. Then `scripts/check-telegram-config.js` checks the file is inside every `app.asar`. Neither prints the token, and GitHub masks secrets in logs anyway.

- **Tag builds fail** if the secret is missing or doesn't look like a bot token, so a release never ships without Telegram.
- **Manual runs on a branch** only warn and build without Telegram. Settings then says "Telegram isn’t available in this build".

**Running from source:** the app reads the token from `AGENT_CODY_TELEGRAM_TOKEN` first, then `src/main/telegram-config.json`.

```bash
AGENT_CODY_TELEGRAM_TOKEN='123456:ABC…' npm start
# or write the config file once (it's gitignored):
TELEGRAM_BOT_TOKEN='123456:ABC…' node scripts/write-telegram-config.js
```

Use `AGENT_CODY_USER_DATA=/tmp/cody-test` as well to try the connect flow without touching your real settings. Without a token, everything except Telegram works as usual.

**Accepted risk:** the token is inside every installed app, so anyone who has the app could dig it out of the bundle and send messages as the bot or read its pending updates (which contain other people's `/start` codes). That's acceptable for a handful of friends. Nobody can read your Telegram chats with it, only what was sent to the bot.

**Rotating the token** (if it leaks, or someone leaves the group):

1. In Telegram, open **@BotFather** → `/mybots` → **@agentcodyalertsbot** → **API Token** → **Revoke current token**. The old token stops working immediately, so alerts stop in all installed copies.
2. Update the `TELEGRAM_BOT_TOKEN` secret on GitHub with the new token (and your local `AGENT_CODY_TELEGRAM_TOKEN` / `telegram-config.json`).
3. Publish a new release. Windows copies update themselves; Mac users install it from the update banner. Everyone stays connected: their chat ID doesn't change, so there's no need to reconnect.

## Notes

- **No signing.** The only secret is `TELEGRAM_BOT_TOKEN` (see above). Friends will see a first-launch warning; the README explains how to get past it. To add real signing later, add the electron-builder signing secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, plus Apple notarization). Then remove `"identity": "-"` and `"hardenedRuntime": false` from the `mac` section of `package.json`, and drop `CSC_IDENTITY_AUTO_DISCOVERY` from the workflow.
- **Made a mistake?** Delete the release and the tag on GitHub, fix the problem, then tag and push again:
  ```bash
  git tag -d v1.0.1 && git push origin :refs/tags/v1.0.1
  ```
