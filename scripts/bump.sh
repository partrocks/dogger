#!/usr/bin/env bash
#
# Bump Dogger's version across every file that carries it, keeping them in sync:
#   - package.json (+ package-lock.json)
#   - src-tauri/tauri.conf.json
#   - src-tauri/Cargo.toml
#   - src-tauri/Cargo.lock
#
# Usage:
#   scripts/bump.sh patch        # 0.1.0 -> 0.1.1
#   scripts/bump.sh minor        # 0.1.0 -> 0.2.0
#   scripts/bump.sh major        # 0.1.0 -> 1.0.0
#   scripts/bump.sh 1.2.3        # set an explicit version
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/package.json"
CONF="$ROOT/src-tauri/tauri.conf.json"
CARGO="$ROOT/src-tauri/Cargo.toml"
LOCK="$ROOT/src-tauri/Cargo.lock"

usage() { echo "Usage: $(basename "$0") <patch|minor|major|X.Y.Z>" >&2; exit 1; }
[ $# -eq 1 ] || usage
BUMP="$1"

command -v jq   >/dev/null || { echo "error: jq is required" >&2; exit 1; }
command -v node >/dev/null || { echo "error: node is required" >&2; exit 1; }
command -v perl >/dev/null || { echo "error: perl is required" >&2; exit 1; }

# --- read current versions ----------------------------------------------------
pkg_v=$(node -p "require('$PKG').version")
conf_v=$(jq -r .version "$CONF")
cargo_v=$(perl -ne 'if(/^version\s*=\s*"([^"]+)"/){print $1; exit}' "$CARGO")

if [ "$pkg_v" != "$conf_v" ] || [ "$pkg_v" != "$cargo_v" ]; then
  echo "error: version files are out of sync:" >&2
  echo "  package.json:    $pkg_v"  >&2
  echo "  tauri.conf.json: $conf_v" >&2
  echo "  Cargo.toml:      $cargo_v" >&2
  echo "Make them match, then bump again." >&2
  exit 1
fi
CURRENT="$pkg_v"

# --- compute new version ------------------------------------------------------
case "$BUMP" in
  major|minor|patch)
    IFS=. read -r MA MI PA <<< "$CURRENT"
    case "$BUMP" in
      major) MA=$((MA + 1)); MI=0; PA=0 ;;
      minor) MI=$((MI + 1)); PA=0 ;;
      patch) PA=$((PA + 1)) ;;
    esac
    NEW="$MA.$MI.$PA"
    ;;
  [0-9]*.[0-9]*.[0-9]*) NEW="$BUMP" ;;
  *) usage ;;
esac

echo "Bumping $CURRENT -> $NEW"

# --- write everywhere ---------------------------------------------------------
# package.json (+ package-lock.json); --no-git-tag-version skips git entirely.
(cd "$ROOT" && npm version "$NEW" --no-git-tag-version --allow-same-version >/dev/null)

# tauri.conf.json
tmp=$(mktemp)
jq --arg v "$NEW" '.version = $v' "$CONF" > "$tmp" && mv "$tmp" "$CONF"

# Cargo.toml: only the line-anchored [package] version (deps use inline version =).
perl -i -pe 'if (!$d && /^version\s*=\s*"[^"]+"/) { s/"[^"]+"/"'"$NEW"'"/; $d=1 }' "$CARGO"

# Cargo.lock: the dogger package entry.
perl -0777 -i -pe 's/(name = "dogger"\nversion = ")[^"]+(")/${1}'"$NEW"'${2}/' "$LOCK"

echo "Updated:"
echo "  package.json, package-lock.json"
echo "  src-tauri/tauri.conf.json"
echo "  src-tauri/Cargo.toml"
echo "  src-tauri/Cargo.lock"
echo
echo "Next: commit the change, open a PR, and merge to cut release v$NEW."
