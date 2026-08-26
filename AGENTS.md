# Repository Guidelines

## Project Structure & Module Organization

Prime Orbit is a React/TypeScript frontend packaged as a Tauri 2 Windows application.

- `src/components/` contains UI surfaces; `src/hooks/` owns stateful workflows such as the Prime Agent runtime.
- `src/lib/` contains reusable bridge and data helpers. Shared types and translations live in `src/types.ts` and `src/i18n.ts`.
- `src-tauri/src/` contains Rust commands, session management, persistence, updater, tray, and native integrations.
- `src-tauri/assets/` contains bundled Prime Agent bridge scripts; `public/` contains static frontend assets.
- `tests/*.test.mjs` contains frontend and protocol regressions. Rust tests live beside modules or in `src-tauri/tests/`.
- `docs/` and `PRODUCT.md` record product and architecture decisions.

## Build, Test, and Development Commands

Use Node.js 22.12 or newer.

```powershell
npm install                  # Install JavaScript dependencies
npm run desktop:dev          # Run the real Tauri desktop application
npm run dev                  # Run the browser-only Vite UI
npm run test:unit            # Run all Node test files
npm run check                # Type-check TypeScript and cargo check Rust
npm run build                # Produce the frontend production bundle
npm run desktop:build        # Build Windows installers
```

Before submitting native changes, also run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## Coding Style & Naming Conventions

Use two-space indentation in TypeScript/TSX and `rustfmt` in Rust. Keep TypeScript strict and free of unused declarations. Use `PascalCase` for components and types, `useCamelCase` for hooks, `camelCase` for functions and variables, and `snake_case` for Rust modules. Preserve the UI tokens and patterns in `src/styles.css`.

## Testing Guidelines

Use Node's built-in `node:test` and `assert`. Name tests after observable behavior and files as `<feature>.test.mjs`. Add regressions for runtime races, queues, persistence, redaction, updater, or bridge changes. Validate native flows in Tauri with a real Prime Agent runtime; browser rendering is insufficient.

## Commit & Pull Request Guidelines

History uses prefixes such as `fix:`, `feat:`, `chore:`, and `release:`. Keep commits focused and imperative. Pull requests should explain user impact, tests, linked issues, and include screenshots for UI changes. Call out protocol, migration, updater, or security implications.

## Security & Agent-Specific Instructions

Never commit keys, tokens, private prompts, personal paths, installers, or runtime logs. Do not weaken path validation, redaction, process ownership, atomic persistence, or session locks. Preserve unrelated worktree changes. Visible Prime Agent actions must map to supported capabilities, and background sessions must survive navigation.
