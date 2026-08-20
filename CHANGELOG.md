# Changelog

All notable changes to Prime Orbit are documented in this file.

## [Unreleased]

## [0.1.16] - 2026-08-20

### Transactional Prime Agent 0.7.4 runtime

- Pinned managed installations to the verified official Prime Agent `v0.7.4` tag and exact commit.
- Prepared every managed update in a fresh versioned runtime, then selected it only after repository, dependency, build, kernel, and `--version` verification. A failed candidate leaves the previous runtime selected, while side-by-side files avoid the Windows `EPERM` collisions caused by replacing loaded binaries in place.
- Assigned each versioned managed runtime generation a stable private daemon socket shared by every Prime Orbit window. Queue mutations, resource reloads, and restarts retain that endpoint, while a newer generation cannot collide with the daemon used by active sessions.

### Official defaults and advisory RLM preferences

- Added native read/write support for Prime Agent's official global `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` settings, with validation, compatible locking, backup, atomic persistence, and multi-window refresh without exposing unrelated configuration or secrets.
- Applied the official main-agent defaults to new conversations unless a project or conversation makes a more specific choice.
- Added separate local model and reasoning preferences for future `rlm.run` delegations. Each new conversation captures a bounded advisory instruction; Prime Agent remains free to select an available compatible fallback, and RLM thinking is enabled only for Prime Agent 0.7.4 or newer.

### Validation

- Added targeted native coverage for transactional runtime generations, exact-version activation, generation-scoped daemon sockets, global settings isolation, and compatible settings writes.
- Added frontend coverage for official default precedence, multi-window updates, immutable RLM snapshots, advisory prompt construction, and Prime Agent version gating.
- Kept the signed Windows draft workflow responsible for full frontend, Rust, formatting, Clippy, MSRV, updater signature, digest, and checksum gates.

## [0.1.15] - 2026-08-20

### Clearer agent turns

- Grouped consecutive Prime Agent messages, Python executions, and other tool activity into one ordered visual turn with a single avatar and header.
- Preserved the exact causal order of text and tools, stable streaming identity, per-turn copy/retry/fork actions, tool details, token counts, and error feedback.
- Kept user and system messages as strict boundaries so separate instructions and replies never merge.

### Reliable context compaction

- Treated `compaction_start` and `compaction_end` as the authoritative lifecycle instead of reporting Prime Agent's legacy 30-second daemon acknowledgement timeout as a failed session.
- Added persistent compacting feedback, queued messages submitted during compaction as real follow-ups, and refreshed state, history, and context statistics when compaction finishes.
- Added a native process-wide fence so two windows cannot start overlapping compact operations, while state reads and queued prompts remain available.
- Disabled misleading duplicate or in-run compact actions and surfaced real failures without offering a dangerous automatic retry.

### Validation

- 83 frontend unit tests and TypeScript production build.
- 128 Rust tests, formatting, strict Clippy, and native multi-window compaction admission coverage.
- Signed Windows release workflow with updater signatures, `latest.json`, and installer checksums.

## [0.1.14] - 2026-08-20

### Signed in-app updates

- Added a native Tauri updater with an explicit **Check**, **Download**, and **Restart and update** flow in **Settings > About**, including release notes, published dates, bounded progress, retryable errors, and accessible discovery notifications.
- Added optional startup checks that never download or install automatically, with process-wide 24-hour coalescing, failure backoff, bounded check and download timeouts, and monotonic multi-window state revisions.
- Kept downloaded updater bytes in native memory and made installation process-wide so concurrent windows cannot start a new Prime Agent process while the application is preparing to restart.
- Warned before stopping open Prime Agent sessions and required an explicit second confirmation before interrupting active work for installation.

### Release integrity and migration

- Embedded the stable updater public key and GitHub `latest.json` endpoint while keeping updater signatures distinct from Windows Authenticode signing and SmartScreen reputation.
- Added a draft-first Windows release workflow with strict cross-manifest version checks, versioned release notes, pinned GitHub Actions, signed NSIS/MSI updater artifacts, SHA-256 checksums, and final signature verification against the key embedded in Prime Orbit.
- Made 0.1.14 the manual trust bootstrap: 0.1.13 and earlier cannot discover this update, but installations starting with 0.1.14 can use the signed stable channel for later releases.
- Refused published-tag or stale-draft reuse so a failed release cannot silently replace immutable or partial assets.

### Validation

- 74 frontend unit tests and TypeScript production build.
- Complete Rust test suite, formatting, strict Clippy, and Rust 1.88 MSRV check.
- Release gates validate the EXE/MSI, their updater signatures, `latest.json`, versioned notes, and `SHA256SUMS-v0.1.14.txt` before leaving a draft for manual review.

## [0.1.13] - 2026-08-20

### Native Prime Agent maintenance

- Added Prime Agent's real `/reload` operation for settings, skills, extensions, prompts, and MCP resources without creating a model turn or restarting the session.
- Added a per-conversation emergency restart with graceful daemon handoff, exact session-lease attestation, multi-window synchronization, and honest cancellation warnings for active work and undelivered messages.
- Separated read-only state refresh, resource reload, and emergency restart throughout the interface, with capability gates for unsupported runtime kinds.
- Added a native Save As flow for HTML exports, background completion across navigation, atomic final writes, and persistent success or failure notifications.

### Secure attachments and history

- Extended opaque, owner-scoped native attachment handles to every image and document selected, pasted, or dropped into the composer; original filesystem paths never reach the renderer or transcript.
- Preserved unsent attachments per conversation and reconstructed safe attachment cards from history, live user events, and queued messages.
- Added bounded native staging, payload sanitization, strict attachment manifests, retry-safe handle consumption, and lifecycle cleanup for document delivery through Prime Agent's RPC protocol.
- Hid Prime Agent's internal IPython state-restoration envelope from the visible transcript without suppressing legitimate user or assistant text.

### Reliability and integrations

- Fixed late queue snapshots and history responses that could display a queued user message after its assistant reply.
- Added bounded, chunk-aware Ollama health checks against the configured native endpoint and corrected OpenAI-compatible `/v1` URL translation.
- Hardened session restart and reload races, Windows lease recovery, concurrent stop/start behavior, and global multi-window maintenance events.
- Added accessible maintenance confirmations, native export errors, bilingual status feedback, and clearer queue-mode explanations.

### Validation

- 65 frontend unit tests and TypeScript production build.
- 114 Rust tests, formatting, strict Clippy, and Rust 1.88 MSRV check.
- Windows Tauri release build with NSIS and MSI installers.

## [0.1.12] - 2026-08-19

### Prime Agent fidelity

- Replaced the UI-only supervision selector with Prime Agent's real steering and follow-up queue modes and live queued instructions.
- Added real Prime Agent heartbeat and scheduled-job controls, including cross-session pause, resume, stop, and cancellation actions.
- Discovered top-level sessions created by the classic Prime Agent terminal and imported their metadata lazily into linked Orbit projects.
- Kept started sessions alive while navigating between conversations and pages, while preserving native multi-window ownership.
- Added true session branching from a selected turn through `get_fork_messages` and `fork`, while keeping session duplication clearly labeled as a clone.
- Synchronized conversation renames with Prime Agent session names and retried pending names when a session is next opened.
- Renamed Orbit-only activity views and permission labels so they no longer imply global Prime Agent discovery or sandboxing.
- Read the application version from package metadata instead of displaying a stale hard-coded version.

### Queue and conversation flow

- Replaced optimistic transcript rows with a discreet Prime Agent queue that exposes real steering and follow-up lanes.
- Added native editing and deletion for queued daemon messages with exact lane, index, and expected-text validation.
- Kept accepted prompts queued until Prime Agent emits their authoritative user turn, preserving the correct user/assistant order across consecutive turns.
- Prevented consumed messages from remaining stuck in the queue and kept duplicate queue entries independently addressable.

### Attachments and history

- Replaced generic image icons with bounded native-generated thumbnails in the composer, transcript, and Session inspector.
- Rehydrated image previews from saved Prime Agent histories without exposing original image bytes or paths to the renderer.

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

[0.1.16]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.16
[0.1.15]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.15
[0.1.14]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.14
[0.1.13]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.13
[0.1.12]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.12
[0.1.11]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.11
[0.1.10]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.10
[0.1.9]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.9
[0.1.8]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.8
