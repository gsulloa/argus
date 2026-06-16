.PHONY: install dev build typecheck lint fmt test \
        rust-fmt rust-clippy rust-test rust-check ci

install:
	pnpm install

dev:
	pnpm tauri:dev

build:
	pnpm tauri:build

typecheck:
	pnpm typecheck

lint:
	pnpm lint

fmt:
	pnpm format
	cd src-tauri && cargo fmt

rust-fmt:
	cd src-tauri && cargo fmt --check

rust-clippy:
	cd src-tauri && cargo clippy -- -D warnings

rust-test:
	cd src-tauri && cargo test

rust-check:
	cd src-tauri && cargo check

ci: typecheck rust-fmt rust-clippy rust-test
