# Changelog

All notable changes to Prime Orbit are documented in this file.

## [Unreleased]

## [0.1.25] - 2026-08-24

### External links

- Enabled the scoped opener command so links inside conversations open in the system browser again; the capability previously carried the URL scope without enabling the underlying command.
- Added a system-browser fallback for http(s) transcript links when the native opener fails.

### Queue reliability

- Recognized delivered instructions whose running label Prime Agent truncates through compactRlmText; long prompts no longer remain stuck in the queue tray.
- Repaired delivered queue rows whenever an authoritative state snapshot arrives or the conversation is selected, removing the need to press refresh state after delivery happened in another conversation or window.

## [0.1.24] - 2026-08-22

### Conversation state reliability

- Cleared the active-run marker when a queued prompt submission fails before reaching Prime Agent, so failed sends roll back cleanly instead of forcing every later prompt into queue-only delivery until restart.
- Kept the agent slot alive when child termination fails during an explicit stop, preventing orphaned RPC clients from hiding behind a freed conversation identifier; the slot is removed only after the exact terminated process is confirmed and only while no emergency restart has claimed it.

### Process ownership

- Added window ownership enforcement to explicit agent stops, mirroring restart semantics: windows attached to the conversation may stop it, unowned idle agents remain stoppable for cleanup, and foreign windows are rejected.

### History containment

- Required session history files to reside under a known Prime Agent sessions root even when the expected session identifier matches, closing a local file disclosure path through renderer-controlled session paths; configured agent directories remain valid roots.

### Interface

- Introduced a modal stack so stacked dialogs close one layer at a time and only the topmost dialog traps Tab focus.

## [0.1.23] - 2026-08-22

### Queue cleanup

- Treated a missing active daemon session as a reconciliation boundary when deleting a stale Steer or Follow-up row, so Orbit removes the orphaned local entry instead of reporting `La session Prime Agent n’est pas active dans le daemon`.
- Kept edits and reordering fail-closed after a session leaves Prime Agent's active queue, while preserving the existing race reconciliation against authoritative state and history.

### Update shutdown safety

- Stopped every Orbit RPC client and the exact private managed Prime Agent daemon before installing an application update, even when no active conversation is visible.
- Waited for the daemon socket to disappear before allowing the installer to replace and restart Prime Orbit, and cancelled the update when shutdown could not be confirmed.
- Left external and system Prime Agent daemons untouched; only Orbit-owned versioned runtime sockets are eligible for managed shutdown.

### Validation

- Added bridge regressions for exact shutdown requests, socket-disappearance attestation, and bounded failure when a daemon remains reachable.
- Revalidated 198 frontend tests, 175 native tests, TypeScript, Rust 1.88, strict Clippy, the production build, and a real isolated Prime Agent 0.8 daemon shutdown on Windows.

## [0.1.22] - 2026-08-22

### Steer and follow-up reconciliation

- Reconciled queued instructions against Prime Agent 0.8's complete action lifecycle instead of relying only on a live `message_start` event that may be missed during reconnects or fast transitions.
- Promoted a queued instruction into the visible transcript when Prime Agent reports its durable `running` phase, then reloaded canonical persisted history at the next terminal boundary.
- Preserved intentional same-text Steer and Follow-up instructions as two distinct actions, including Prime Agent's steering-first delivery priority.
- Removed consumed instructions from the editable queue immediately, so a delivered message no longer remains stuck as `Syncing` above the composer.

### Safe queue mutations

- Added a full-lane snapshot precondition to queue edits and deletions so an index can never silently target a different duplicate after the queue advances.
- Resynchronized a raced deletion through the active RPC session and treated an already delivered instruction as completed instead of surfacing the separate daemon bridge's stale-session error.

### Validation

- Added frontend regressions for missed user events, terminal history repair, same-text cross-lane actions, and late running snapshots.
- Revalidated all frontend tests, TypeScript, Rust, and Prime Agent 0.8's upstream queued-action suites from an external checkout.

## [0.1.21] - 2026-08-22

### Prime Agent 0.8.0

- Pinned managed installations to the official Prime Agent `v0.8.0` tag and exact verified commit, while retaining the transactional side-by-side runtime activation used on Windows.
- Adapted MCP configuration to Prime Agent 0.8's global-only executable server settings. New project-scoped entries are blocked, existing legacy entries remain visible for deliberate cleanup, and the OAuth endpoint-binding migration is explained in the interface.
- Kept Linear and Notion aligned with the authoritative built-in catalog instead of allowing custom entries to override their reserved names.

### Durable refinement outcomes

- Added compact, expandable conversation cards for Prime Agent 0.8's persisted `refinement_outcome` messages in both live and restored sessions.
- Deduplicated the start/end delivery pair by refinement id and exposed only bounded public fields: summary, scope, edit action, type, id, title, applied state, and error.
- Added native sanitization that drops harness paths, rationale, metadata, and private before/after snapshots before runtime events or session history can cross into the WebView.

### Validation

- Added frontend and native regression coverage for live and historical refinement outcomes, safe field projection, private-data removal, and duplicate delivery.
- Revalidated the production frontend build, complete frontend and Rust test suites, formatting, strict Clippy, and the official Prime Agent 0.8 runtime from an external working directory.

## [0.1.20] - 2026-08-22

### Desktop tray and closing

- Added a native Windows tray menu that can reopen Prime Orbit or quit it explicitly while conversations remain available in the background.
- Replaced ambiguous window closing with an integrated **Minimize** or **Quit** choice, including a **Don't ask again** preference and a matching control in **Settings > General**.
- Kept the close dialog focused and visually consistent with the rest of the application, with the two destination cards acting as the only action buttons.
- Flushed the latest workspace state before a remembered quit and synchronized native tray labels with the selected application language.

### Memory and refinement reader

- Opened memory and refinement cards in a dedicated large reader with rendered Markdown, bounded public metadata, and the same type-specific icon used in the Session list.
- Added comfortable reading width, clearer hierarchy, compact metadata badges, previous and next navigation, and keyboard shortcuts without exposing private runtime fields.
- Added safe copy, open-file, reveal-folder, delete, and rollback actions while retaining the existing integrated confirmation flows for destructive operations.

### Validation

- Added frontend coverage for native close decisions, remembered preferences, tray localization, memory and refinement navigation, safe copying, contextual file actions, and destructive confirmations.
- Revalidated the production frontend build, complete frontend and Rust test suites, formatting, strict Clippy, Rust 1.88 compatibility, and signed Windows release gates.

## [0.1.19] - 2026-08-21

### Session memory and controls

- Loaded the active session's existing memory entries and refinement history into the inspector, with bounded refreshes after refinement completes.
- Added accessible contextual actions to open a memory or refinement journal, reveal its folder, delete an exact memory entry with confirmation and backup, or append a safe rollback for an applied refinement.
- Reworked **Reload resources** to target the exact active daemon session and reuse its owning RPC identity without submitting a chat prompt or replaying an earlier command.

### Models and conversation workflow

- Added persistent model favorites, shown first in every shared model picker and merged safely across concurrent windows.
- Added search to the default-model and preferred-subagent-model selectors in Settings.
- Added a direct, keyboard-accessible new-conversation action for each project in the workspace sidebar.

### Native editing and runtime resilience

- Restored Windows dictionary suggestions inside Prime Orbit's themed composer context menu, including Unicode words and exact replacement ranges.
- Prevented a connecting session from treating its first prompt as a follow-up, stopped stale local-history loading from relatching a ready conversation, and kept newer prompt admissions safe from older idle snapshots.
- Presented parent-managed subagent shutdowns as normal closures and refreshed session memory after completed refinements.

### Validation

- Added coverage for exact resource-reload ownership, session inspector reconstruction and actions, model favorite ordering and persistence, project-scoped conversation creation, native spelling suggestions, and session lifecycle races.
- Revalidated the frontend production build, complete frontend and Rust test suites, formatting, strict Clippy, Rust 1.88 compatibility, and signed Windows release gates.

## [0.1.18] - 2026-08-21

### Reliable runtime recovery

- Reconciled terminal renderer state with Prime Agent's authoritative daemon state when a final lifecycle event is missed, closing orphaned Python activity and preventing completed runs from forcing the next prompt into the follow-up queue.
- Guarded idle recovery and Goal resynchronization with lifecycle epochs so an older state response cannot erase a newer prompt or agent run.
- Retried authoritative history loading after recovery when an earlier response was rejected while stale local run markers were still present.

### Cleaner collaboration and editing

- Replaced raw agent-to-agent protocol envelopes with compact expandable notices, with native and renderer-side validation, bounded content, deduplication, and removal of private runtime identifiers.
- Kept rename fields focused through periodic workspace refreshes and restored focus correctly when dialogs close.
- Added Markdown list continuation in the composer and delegated its right-click menu to native WebView2 spelling suggestions when available.
- Rendered updater release notes as safe structured Markdown and temporarily hid the global new-conversation button while keeping workspace creation available.

### Validation

- Added coverage for missed terminal events, stale idle snapshots, orphaned Python tools, inter-agent message sanitization, modal focus, list editing, native spelling-menu delegation, and release-note Markdown safety.
- Revalidated the frontend production build, complete frontend and Rust test suites, formatting, strict Clippy, Rust 1.88 compatibility, and signed Windows release gates.

## [0.1.17] - 2026-08-21

### Reliable session controls

- Reconciled accepted Steer and follow-up messages from Prime Agent's persisted history when a fast queue transition or background navigation hides the live user event, preserving the authoritative turn order and attachment identity.
- Made Goal mutations wait for the matching Prime Agent `goal_update`, survive navigation, and resynchronize the originating session. Completed goals remain inspectable history, are no longer counted as active, and can be cleared reliably.
- Added explicit refinement progress and a native process-wide Compact/Refine admission fence so concurrent windows cannot start overlapping context maintenance operations.

### Faster, clearer conversations

- Isolated the transcript from draft persistence so typing in a long conversation no longer refilters, regroups, and reparses every historical Markdown message.
- Memoized stable turns and tool content, limited streaming updates to the affected turn, and coalesced automatic scrolling per animation frame.
- Collapsed Python executions by default, added detailed context-usage feedback, and reorganized Session into dedicated runtime, files, Goal, agents, and monitoring sections.

### Navigation and desktop safety

- Added the full conversation context menu outside the sidebar, including move, pin, rename, and archive actions.
- Reopened the most recently updated active conversation when selecting a project instead of always creating a new one.
- Moved main-agent and advisory RLM defaults into Models, blocked the WebView print shortcut, and routed Markdown links through explicit web or project-confined file handling.

### Validation

- Added targeted coverage for queue reconciliation, duplicate turns and attachments, Goal lifecycle races, long-transcript memoization, project navigation, conversation menus, safe links, keyboard shortcuts, context details, and Session sections.
- Revalidated the TypeScript production build, complete frontend and Rust test suites, formatting, strict Clippy, Rust 1.88 compatibility, and the signed Windows release gates.

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

[0.1.23]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.23
[0.1.22]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.22
[0.1.21]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.21
[0.1.20]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.20
[0.1.19]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.19
[0.1.18]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.18
[0.1.17]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.17
[0.1.16]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.16
[0.1.15]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.15
[0.1.14]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.14
[0.1.13]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.13
[0.1.12]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.12
[0.1.11]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.11
[0.1.10]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.10
[0.1.9]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.9
[0.1.8]: https://github.com/zerr0o/Prime-Orbit/releases/tag/v0.1.8
