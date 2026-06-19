# Dogger — Distribution / Infra TODO

Things to build _outside_ the app to ship Dogger publicly.
Keep this list simple and tick items off as they're done.

## Status

- [ ] Install script (`install.sh`)
- [ ] Website (`doggerapp.com`)
- [ ] Apple Developer ID (later — only when going beyond a dev audience)

> **Branch protection: skipped.** Rulesets on a private repo are a paid feature,
> and as the only developer it's not worth it. Work directly on `main` and
> self-manage. Revisit if/when others contribute.

---

## Release workflow (dogger repo)

After `make bump` + `git push`, GitHub Actions:

1. Builds the `.dmg` and publishes `vX.Y.Z` on GitHub Releases.
2. Updates `partrocks/homebrew-tap` (`version` + `sha256` in `Casks/dogger.rb`).

You only need the bump + push — no manual tap update.

### One-time: `HOMEBREW_TAP_TOKEN` secret

The default `GITHUB_TOKEN` cannot push to another repo. Add a PAT so the release
workflow can update the tap.

1. GitHub → **Settings** (your account) → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. **Resource owner:** `partrocks` (or your user, if the tap is under your account).
3. **Repository access:** Only select repositories → **`homebrew-tap`**.
4. **Permissions:** Repository permissions → **Contents** → **Read and write**.
5. Generate and copy the token.
6. Open **`partrocks/dogger`** → **Settings** → **Secrets and variables** →
   **Actions** → **New repository secret**.
7. Name: **`HOMEBREW_TAP_TOKEN`**, value: paste the token.

If the secret is missing, the release still succeeds but the tap is not updated.

---

## 1. Install script (`install.sh`)

Script lives in **`dogger/scripts/install.sh`**. Host it at `https://doggerapp.com/install.sh`.

- Fetches the latest release from GitHub (`partrocks/dogger`).
- Downloads the Apple Silicon `.dmg`, copies **Dogger.app** to `/Applications`.
- Strips quarantine so the unsigned app opens.
- Used by: `curl -fsSL https://doggerapp.com/install.sh | bash`.

## 2. Website (`doggerapp.com`)

Public landing + download page.

- Domain registered: `doggerapp.com`.
- Pages: what Dogger is, screenshots, install instructions (Homebrew + curl + dmg).
- A stable "Download" button linking to the latest GitHub release.
- Host `install.sh` here.

## 3. Apple Developer ID (later)

Only needed for a true zero-friction install (no manual `xattr`) and for a
non-developer audience.

- Apple Developer Program: $99/yr.
- Create a **Developer ID Application** certificate.
- Notarize the `.dmg` in `release.yml` via `notarytool`.
- Add secrets: `APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD`, `APPLE_TEAM_ID` — Tauri picks these up automatically.
- The code is already kept signing-compliant, so this is config only.
