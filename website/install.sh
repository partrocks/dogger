#!/usr/bin/env bash
#
# Install Dogger from the latest GitHub release.
#
# Usage (once hosted at https://doggerapp.com/install.sh):
#   curl -fsSL https://doggerapp.com/install.sh | bash
#
set -euo pipefail

REPO="partrocks/dogger"
APP_NAME="Dogger"
INSTALL_DIR="/Applications"
APP_PATH="${INSTALL_DIR}/${APP_NAME}.app"

die() {
  echo "error: $*" >&2
  exit 1
}

info() {
  echo "$*"
}

app_version() {
  /usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$1/Contents/Info.plist" 2>/dev/null
}

quit_dogger() {
  if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
    info "Quitting running ${APP_NAME}…"
    osascript -e "quit app \"${APP_NAME}\"" 2>/dev/null || true
    sleep 1
    pkill -x "$APP_NAME" 2>/dev/null || true
    sleep 1
  fi
}

# --- platform checks ----------------------------------------------------------
[[ "$(uname -s)" == "Darwin" ]] || die "Dogger requires macOS."
[[ "$(uname -m)" == "arm64" ]] || die "Dogger requires Apple Silicon (arm64)."

command -v curl >/dev/null || die "curl is required."
command -v hdiutil >/dev/null || die "hdiutil is required."
command -v python3 >/dev/null || die "python3 is required."

# --- resolve latest release asset ---------------------------------------------
info "Fetching latest Dogger release…"

RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")" \
  || die "Could not fetch release info from GitHub (is ${REPO} reachable?)."

read -r VERSION DMG_URL <<EOF
$(RELEASE_JSON="$RELEASE_JSON" python3 <<'PY'
import json, os, sys

data = json.loads(os.environ["RELEASE_JSON"])
version = data["tag_name"].lstrip("v")
assets = [
    a for a in data.get("assets", [])
    if a.get("name", "").endswith("_aarch64.dmg")
]
if not assets:
    sys.exit("no Apple Silicon .dmg found on latest release")
print(version, assets[0]["browser_download_url"])
PY
)
EOF

[[ -n "$VERSION" && -n "$DMG_URL" ]] || die "Could not parse latest release."

info "Latest version: ${VERSION}"

# --- download -----------------------------------------------------------------
WORKDIR="$(mktemp -d)"
MOUNT=""
trap '[[ -n "$MOUNT" ]] && hdiutil detach "$MOUNT" -quiet 2>/dev/null || true; rm -rf "$WORKDIR"' EXIT

DMG="${WORKDIR}/Dogger_${VERSION}_aarch64.dmg"
info "Downloading ${DMG_URL}"
curl -fSL -o "$DMG" "$DMG_URL"

# --- mount, install, unmount --------------------------------------------------
info "Installing to ${APP_PATH}…"

# Use the Apple_HFS line's last field — robust when hdiutil prints checksum noise.
MOUNT="$(hdiutil attach -nobrowse -readonly "$DMG" | awk '/Apple_HFS/ { mount=$NF } END { print mount }')"
[[ -n "$MOUNT" && -d "${MOUNT}/${APP_NAME}.app" ]] \
  || die "Could not find ${APP_NAME}.app inside the disk image."

DMG_VERSION="$(app_version "${MOUNT}/${APP_NAME}.app")"
[[ "$DMG_VERSION" == "$VERSION" ]] \
  || die "Release tag is v${VERSION} but the .dmg contains v${DMG_VERSION}."

quit_dogger

if [[ -d "$APP_PATH" ]]; then
  rm -rf "$APP_PATH"
fi

ditto "${MOUNT}/${APP_NAME}.app" "$APP_PATH"
hdiutil detach "$MOUNT" -quiet
MOUNT=""

# --- unsigned app: allow Gatekeeper to open it --------------------------------
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true

INSTALLED_VERSION="$(app_version "$APP_PATH")"
[[ "$INSTALLED_VERSION" == "$VERSION" ]] \
  || die "Install finished but ${APP_PATH} reports v${INSTALLED_VERSION}, expected v${VERSION}. Quit Dogger and re-run."

info "Done. Dogger ${INSTALLED_VERSION} is installed at ${APP_PATH}."
info "Open it from Applications or run: open ${APP_PATH}"
