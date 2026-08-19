# Changelog

All notable changes to Prime Orbit are documented in this file.

## [0.1.11] - 2026-08-19

### Git workflow

- Moved the Changes inspector to the first tab and made it the default view for project conversations.
- Replaced placeholder `+0 -0` counters with bounded Git numstat data for tracked, staged, renamed, deleted, binary, and untracked files.
- Added expandable, syntax-colored per-file diff previews with explicit binary, metadata-only, error, loading, and truncation states.
- Added top-level **Commit + push** and **Publish release** actions that prepare precise Prime Agent instructions without sending them automatically.
- Protected existing composer text with a styled confirmation before a prepared Git instruction can replace it.

### Safety and validation

- Confined diff requests to validated repository-relative paths and bounded Git stdout, stderr, and untracked-file reads.
- Kept all Git mutations under Prime Agent control: the inspector itself remains read-only and never commits, pushes, tags, or publishes automatically.
- Added Rust coverage for Git parsing, path traversal, untracked files, and per-file diffs.

## [0.1.10] - 2026-08-19

### Reliability and persistence

- Stopped the workspace-state write storm caused by property-order-sensitive JSON comparisons and made identical native CAS writes idempotent.
- Kept runtime-only status, messages, activities, and errors out of durable workspace timestamps and automatic-save retries.
- Made prompt submission transactional, preserving concurrent runtime updates while rolling failed optimistic messages back exactly.
- Hardened multi-window runtime ownership, interactive extension request routing, queued follow-ups, and local session-history recovery.

### Security and integrations

- Moved image attachments to bounded, window-scoped native handles with TTL and aggregate limits while preserving explicitly selected external documents as path references.
- Redacted credentials from renderer diagnostics and activity payloads before display or persistence.
- Hardened MCP settings with HTTPS/auth rules, safe loopback exceptions, guarded atomic locking, secret-free inspection, and protection against moving opaque authorization headers to a new origin.
- Confined model configuration edits to the managed `models.json` file and strengthened runtime, path, symlink, and input validation.

### Desktop experience

- Added a complete project context menu for pinning, renaming, opening, archiving, and typed deletion confirmation without changing the active conversation.
- Opened project folders directly in Explorer, Finder, or the Linux file manager instead of selecting them in the parent folder.
- Improved attachment errors, provider/MCP setup, managed-install feedback, retry behavior, and bilingual interface coverage.

### Engineering

- Declared Node.js 22.12 for development, Rust 1.88 as the MSRV, locked Rust validation, dependency audits, and Tauri integration builds in CI.
- 74 Rust tests and 20 frontend unit tests, plus TypeScript production, strict Clippy, MSRV, and Windows bundle validation.

## [0.1.9] - 2026-08-19

### Managed Prime Agent repair

- Pinned managed installations to the verified stable Prime Agent `v0.7.3` tag and exact commit instead of following a moving beta/main checkout.
- Added a Windows compatibility preload for managed source runtimes that uses `Scripts/python.exe`, keeps descendant process windows hidden, and normalizes only the exact session-lease `EPERM` collision expected by Prime Agent.
- Prepared and validated the Python kernel as part of managed installation so Python tools are ready before setup reports success.
- Repaired the previous generated-model build artifact safely and restored that one tracked file atomically after future builds, keeping the managed checkout updateable.

### Safety and validation

- Preserved user or concurrent changes and refused unexpected managed-runtime mutations instead of resetting the checkout.
- Added subprocess contract tests for Windows path rewriting, hidden process options, Node option quoting, session-lease normalization, and promisified child-process APIs.
- 50 Rust tests and 5 frontend unit tests.
- TypeScript production build and strict Rust Clippy validation with warnings denied.

## [0.1.8] - 2026-08-19

### Highlights

- Introduced the complete Tauri 2 desktop workspace for Prime Agent, organized around projects and persistent conversations.
- Added lazy conversation loading, multi-window runtime ownership, background agents, and read-only session-history recovery.
- Added model/provider management, HTTP MCP configuration, attachments, tool inspection, Git changes, and a managed Prime Agent installer.
- Added stable manual ordering with drag and drop for projects and conversations, execution status indicators, archive and typed project deletion flows.
- Added English and French interfaces, theme preferences, accessible dismissible menus, and a custom application context menu.

### Reliability and Windows fixes

- Moved blocking filesystem, process, diagnostic, Git, and configuration work off the Tauri UI thread.
- Added atomic revisioned workspace persistence with three-way multi-window reconciliation.
- Deduplicated streaming listeners, tool events, Python executions, and inspector activity.
- Added strict runtime health checks and actionable startup diagnostics.
- Added safe recovery for stale Prime Agent session leases affected by Windows `EPERM` directory-rename behavior.

### Validation

- 41 Rust tests.
- 5 frontend unit tests.
- TypeScript build and checks.
- Strict Rust Clippy validation with warnings denied.

[0.1.11]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.11
[0.1.10]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.10
[0.1.9]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.9
[0.1.8]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.8
