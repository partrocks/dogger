# Dogger — developer Makefile
# `make dev` is the canonical way to start the app locally.

.PHONY: dev build check clean install

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
