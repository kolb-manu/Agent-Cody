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

## What the workflow does

1. **Unit tests** (`npm test`) on Linux, plus a check that the tag matches `package.json`. If either fails, nothing gets built or published.
2. **Build** on a macOS runner and a Windows runner in parallel with electron-builder.
   - The Mac apps are *ad-hoc* signed, which is free and needs no certificate. This keeps the app bundle valid, so friends get the normal "unidentified developer" prompt instead of an "app is damaged" error.
   - Each build is smoke-tested: the packaged app is started, and the workflow checks that its local server answers. The Windows smoke test doesn't block a release, because CI desktop sessions can be unreliable.
3. **Release:** creates the GitHub Release for the tag and attaches all installers. If the release already exists (for example after re-running a failed job), the files are replaced.

You can also start the workflow by hand (**Actions → Release → Run workflow**). On a branch, it only builds, and the installers are downloadable from the run page for 14 days. Choose a tag in "Use workflow from" to publish that tag's release.

## Notes

- **No signing, no secrets.** Friends will see a first-launch warning; the README explains how to get past it. To add real signing later, add the electron-builder signing secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, plus Apple notarization). Then remove `"identity": "-"` and `"hardenedRuntime": false` from the `mac` section of `package.json`, and drop `CSC_IDENTITY_AUTO_DISCOVERY` from the workflow.
- **Made a mistake?** Delete the release and the tag on GitHub, fix the problem, then tag and push again:
  ```bash
  git tag -d v1.0.1 && git push origin :refs/tags/v1.0.1
  ```
