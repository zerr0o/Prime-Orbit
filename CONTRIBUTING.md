# Contributing to Prime Orbit

Thanks for helping improve Prime Orbit. Bug reports, focused fixes, documentation improvements, and carefully scoped features are welcome.

## Before opening an issue

- Search existing issues first.
- Include the Prime Orbit version, operating system, Prime Agent version, and clear reproduction steps.
- Remove API keys, OAuth tokens, private prompts, local file contents, and personal paths from logs and screenshots.
- For security-sensitive reports, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

```powershell
npm install
npm run desktop:dev
```

See the [README](README.md#development) for prerequisites and architecture details.

## Before submitting a change

```powershell
npm run test:unit
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Please keep pull requests focused, explain the user impact, and add tests for reliability or protocol changes. Never weaken path validation, secret redaction, process ownership, atomic persistence, or session-lock safety to make a feature easier to implement.
