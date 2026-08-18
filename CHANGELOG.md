# Changelog

All notable changes to Prime Orbit are documented in this file.

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

[0.1.9]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.9
[0.1.8]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.8
