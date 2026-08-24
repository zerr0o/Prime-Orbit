# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Prime Orbit is a Windows 10/11 x64 desktop application built with Tauri. Its product interface runs in a WebView and follows desktop interaction conventions.

## Users

Prime Orbit serves software developers who use Prime Agent against local project repositories on Windows. They need to supervise long-running agent sessions, move between projects and conversations, inspect work, and retain explicit control over actions that can modify their workspace.

## Product Purpose

Prime Orbit turns Prime Agent into a focused, project-first desktop workspace. Success means that developers can run and supervise persistent Prime Agent conversations without losing the authority of Prime Agent's own session history or weakening the native safety boundaries around projects, processes, and files.

## Positioning

Prime Orbit is an independent community client that presents Prime Agent's real protocol and session semantics through a native desktop workspace. It does not invent a competing transcript, agent state, or execution model.

## Operating Context

- Local Windows project folders and source repositories.
- Persistent Prime Agent sessions that can keep running in the background.
- Multiple projects, conversations, and application windows.
- English and French interface languages.
- Native Windows installers, tray behavior, notifications, and signed updates.
- The Plan workflow: select Plan mode for one conversation, let the agent inspect the project without modifying code, answer interactive questions, review the generated Markdown document, then either keep it or apply it immediately in the same conversation.

## Capabilities and Constraints

- Prime Agent owns the canonical transcript and agent lifecycle. Prime Orbit may persist UI metadata, drafts, plan-mode metadata, and session references, but not a competing transcript database.
- Plan mode is conversation-scoped and opt-in. New conversations start in Normal mode.
- Plan questions use Prime Agent's public extension UI request/response protocol and block until the user answers or cancels.
- During Plan mode, the agent must not have a path that can modify project code. This is an enforced runtime boundary, not only prompt wording.
- The completed plan is shown in the conversation and written atomically to `.prime/plans/<name>.md` only after generation.
- Applying a plan exits Plan mode and immediately starts implementation in the same conversation, using the generated document as the source of truth. Keeping it exits without implementation.
- When a Plan question or final decision appears while no Prime Orbit window is focused, Windows must show a system notification with the system notification sound.
- Path validation, process ownership, session locks, secret redaction, atomic persistence, and update safety must never be weakened.
- Prime Orbit is Windows-only for the current product scope and has no application telemetry.

## Brand Commitments

- Product name: Prime Orbit.
- Preserve the established Prime Orbit interface and logo (`public/prime-orbit.svg`).
- Product copy is direct, professional, calm, and available in English and French.
- The provided Codex screenshot is a functional reference for question flow, not a visual identity to copy.

## Evidence on Hand

- Product and architecture facts: `README.md`, `CONTRIBUTING.md`, and `SECURITY.md`.
- Existing interface screenshots: `docs/screenshots/workspace-home.png` and `docs/screenshots/conversation-inspector.png`.
- Incumbent visual and interaction system: `src/styles.css`, `src/components/Ui.tsx`, and `src/components/ConversationView.tsx`.
- User-provided functional reference: a desktop Plan-mode question with structured choices, a custom-response path, and a waiting state.
- No customer claims, telemetry evidence, or performance claims should be fabricated.

## Product Principles

1. Prime Agent is the protocol authority; Orbit reflects rather than guesses.
2. Safety boundaries must be enforceable and fail closed.
3. Long-running and multi-window work must survive navigation, reloads, and background execution.
4. Every destructive or execution transition remains explicit to the user.
5. Dense desktop workflows stay calm, legible, bilingual, and keyboard accessible.

## Accessibility & Inclusion

Interactive controls must remain keyboard operable, expose clear focus states and semantic labels, respect reduced motion, and provide equivalent English and French text. Plan questions must not rely on color or sound alone; the transcript and conversation state remain the durable visual signal.
