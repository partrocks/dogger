# Dogger — Distribution / Infra TODO

Things to build *outside* the app to ship Dogger publicly.
Keep this list simple and tick items off as they're done.

## Status

- [ ] Release pipeline (build unsigned `.dmg`, publish GitHub Release)
- [ ] Homebrew tap repo
- [ ] Install script (`install.sh`)
- [ ] Website (`dogger.app`)
- [ ] Apple Developer ID (later — only when going beyond a dev audience)

> **Branch protection: skipped.** Rulesets on a private repo are a paid feature,
> and as the only developer it's not worth it. Work directly on `main` and
> self-manage. Revisit if/when others contribute.

---

## 1. Release pipeline (GitHub Actions)

One workflow in `.github/workflows/release.yml`, triggered on push to `main`:

- Read the version from the repo. If a `vX.Y.Z` tag already exists, do nothing
  (so only an actual version bump cuts a release).
- Otherwise build the `aarch64-apple-darwin` `.dmg`, create the `vX.Y.Z` tag, and
  publish a GitHub Release with the `.dmg` attached.

Version bumping is **manual and self-disciplined** (done — `scripts/bump.sh` +
Makefile targets):

- `make bump` / `make bump-patch`
- `make bump-minor`
- `make bump-major`

Each updates all version files together (`package.json`, `tauri.conf.json`,
`Cargo.toml`, `Cargo.lock`) and commits. Push to `main` → release fires.

Optional: a `check.yml` that runs `make check` on push for a quick green/red
signal (no longer a merge gate, just a safety net).

## 3. Homebrew tap repo

A separate public GitHub repo named `**homebrew-tap`** under `partrocks`.

- Contains `Casks/dogger.rb` pointing at the latest release `.dmg` + its SHA256.
- Install command for users: `brew install --cask partrocks/tap/dogger --no-quarantine`.
- **Automate it:** have `release.yml` update the cask's `version` + `sha256` and push
to the tap repo on each release.

## 4. Install script (`install.sh`)

A shell script hosted at `https://dogger.app/install.sh`.

- Download the latest `.dmg` from the GitHub release.
- Mount it, copy `Dogger.app` to `/Applications`, unmount.
- Run `xattr -dr com.apple.quarantine /Applications/Dogger.app`.
- Used by: `curl -fsSL https://dogger.app/install.sh | bash`.

## 5. Website (`dogger.app`)

Public landing + download page.

- Buy the `dogger.app` domain.
- Pages: what Dogger is, screenshots, install instructions (Homebrew + curl + dmg).
- A stable "Download" button linking to the latest GitHub release.
- Host `install.sh` here.

## 6. Apple Developer ID (later)

Only needed for a true zero-friction install (no quarantine flag) and for a
non-developer audience.

- Apple Developer Program: $99/yr.
- Create a **Developer ID Application** certificate.
- Notarize the `.dmg` in `release.yml` via `notarytool`.
- Add secrets: `APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID` — Tauri picks these up automatically.
- The code is already kept signing-compliant, so this is config only.

