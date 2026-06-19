# Dogger — Distribution / Infra TODO

Things to build _outside_ the app to ship Dogger publicly.
Keep this list simple and tick items off as they're done.

## Status

- [ ] First release verified (push a bump, confirm `.dmg` is published)
- [ ] Homebrew tap repo
- [ ] Install script (`install.sh`)
- [ ] Website (`dogger.app`)
- [ ] Apple Developer ID (later — only when going beyond a dev audience)

> **Branch protection: skipped.** Rulesets on a private repo are a paid feature,
> and as the only developer it's not worth it. Work directly on `main` and
> self-manage. Revisit if/when others contribute.

---

## 1. Verify the release pipeline

The workflow (`.github/workflows/release.yml`) and permissions are set up. Confirm
it actually works end to end:

- `make bump` → `git push` → watch the Actions tab.
- A new release `vX.Y.Z` with a `.dmg` asset should appear.

Optional: add a `check.yml` that runs `make check` on push for a quick green/red
signal (safety net, not a merge gate).

## 2. Homebrew tap repo

A separate public GitHub repo named **`homebrew-tap`** under `partrocks`.

- Contains `Casks/dogger.rb` pointing at the latest release `.dmg` + its SHA256.
- Install command for users: `brew install --cask partrocks/tap/dogger --no-quarantine`.
- **Automate it:** have `release.yml` update the cask's `version` + `sha256` and push
  to the tap repo on each release.

## 3. Install script (`install.sh`)

A shell script hosted at `https://dogger.app/install.sh`.

- Download the latest `.dmg` from the GitHub release.
- Mount it, copy `Dogger.app` to `/Applications`, unmount.
- Run `xattr -dr com.apple.quarantine /Applications/Dogger.app`.
- Used by: `curl -fsSL https://dogger.app/install.sh | bash`.

## 4. Website (`dogger.app`)

Public landing + download page.

- Buy the `dogger.app` domain.
- Pages: what Dogger is, screenshots, install instructions (Homebrew + curl + dmg).
- A stable "Download" button linking to the latest GitHub release.
- Host `install.sh` here.

## 5. Apple Developer ID (later)

Only needed for a true zero-friction install (no quarantine flag) and for a
non-developer audience.

- Apple Developer Program: $99/yr.
- Create a **Developer ID Application** certificate.
- Notarize the `.dmg` in `release.yml` via `notarytool`.
- Add secrets: `APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD`, `APPLE_TEAM_ID` — Tauri picks these up automatically.
- The code is already kept signing-compliant, so this is config only.
