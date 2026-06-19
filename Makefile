# Dogger — developer Makefile
# `make dev` is the canonical way to start the app locally.

.PHONY: dev build check clean install clear-icon-cache bump bump-patch bump-minor bump-major check-version

# Run the Tauri app locally (starts Vite + the desktop window).
dev:
	npm run tauri dev

# Build the macOS desktop app bundle.
build:
	npm run tauri build

# Run basic checks: TypeScript typecheck + Rust format/clippy/compile checks.
check:
	npx tsc --noEmit
	cd src-tauri && cargo fmt --check
	cd src-tauri && cargo check

# Remove generated build artefacts (safe to re-create).
clean:
	rm -rf dist
	cd src-tauri && cargo clean

# Convenience: install JS dependencies.
install:
	npm install

# Print the version recorded in each file (handy for spotting drift).
check-version:
	@printf '%-22s %s\n' "package.json:"    "$$(node -p "require('./package.json').version")"
	@printf '%-22s %s\n' "tauri.conf.json:" "$$(jq -r .version src-tauri/tauri.conf.json)"
	@printf '%-22s %s\n' "Cargo.toml:"      "$$(perl -ne 'if(/^version\s*=\s*\"([^\"]+)\"/){print $$1; exit}' src-tauri/Cargo.toml)"

# Version bumps. Updates package.json, tauri.conf.json, Cargo.toml + Cargo.lock
# together. Run on a branch, commit the change, then merge to cut a release.
# `make bump` is shorthand for the most common case, a patch bump.
bump: bump-patch

bump-patch:
	./scripts/bump.sh patch

bump-minor:
	./scripts/bump.sh minor

bump-major:
	./scripts/bump.sh major

# Force macOS to drop cached app icons, then restart Dock + Finder.
# Run this after changing src-tauri/icons and rebuilding to see the new icon.
clear-icon-cache:
	sudo rm -rf /Library/Caches/com.apple.iconservices.store
	sudo find /private/var/folders -name com.apple.dock.iconcache -delete 2>/dev/null || true
	killall Dock
	killall Finder
