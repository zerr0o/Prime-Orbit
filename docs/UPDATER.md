# Prime Orbit updater and release signing

Prime Orbit uses Tauri 2's updater signature as the application update trust root. The stable channel is a static manifest hosted by the public GitHub repository:

```text
https://github.com/zerr0o/Prime-Orbit/releases/latest/download/latest.json
```

GitHub exposes that URL without authentication for this public repository. Drafts and prereleases do not become the stable `latest` release, so they cannot be offered to stable clients through this endpoint.

## Bootstrap limitation

Prime Orbit 0.1.13 was published before the updater plugin and signing key were embedded. It has no `latest.json` or Tauri updater signatures and cannot upgrade itself.

The first updater-enabled release must therefore be installed manually over 0.1.13. Once that release is installed, subsequent releases signed by the same updater key can be downloaded and installed from inside Prime Orbit.

## One-time signing setup

Generate the updater key pair once, on a trusted machine, and write it outside the repository:

```powershell
npx tauri signer generate --write-keys "$env:USERPROFILE\.tauri\prime-orbit-updater.key"
```

This creates a private key and a matching `.pub` file.

1. Keep the private key outside the repository and back it up in at least one encrypted offline location.
2. Commit only the contents of `prime-orbit-updater.key.pub` as `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
3. Add the complete private-key contents as the GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`.
4. If the key has a password, add it as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The password secret is optional for an unencrypted key; an encrypted key is preferred.

Never print the private key in workflow logs, store it in an `.env` file, or commit it. Losing this key prevents installed copies from trusting future updates and forces a manual reinstall with a new trust root.

`TAURI_SIGNING_PRIVATE_KEY` signs updater payloads. It is not a Windows Authenticode certificate and does not establish a publisher reputation with SmartScreen. Code signing the EXE/MSI is a separate distribution concern.

## Release workflow

`.github/workflows/release.yml` runs only for stable `vMAJOR.MINOR.PATCH` tags. Before creating anything on GitHub it:

- verifies that the tag matches `package.json`, both lockfiles, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`;
- requires non-empty versioned notes at `docs/releases/vMAJOR.MINOR.PATCH.md`;
- verifies that the tagged commit belongs to `main`;
- refuses to reuse either a published release or a stale draft carrying the same tag;
- refuses to continue without the updater private key;
- runs the frontend audit, tests, production build, Rust formatting, tests, strict Clippy, and Rust 1.88 compatibility check.

The release build merges `src-tauri/tauri.release.conf.json`, which enables `bundle.createUpdaterArtifacts` only for signed release builds. Ordinary local bundles do not need the private updater key.

The workflow passes the versioned Markdown file unchanged to the GitHub draft. Tauri also copies that release body into `latest.json`, so the in-app updater presents the same reviewed notes as GitHub instead of generic or stale copy.

The pinned official Tauri action then creates a **draft** GitHub release and uploads:

- the NSIS installer and its `.sig` file;
- the MSI installer and its `.sig` file;
- `latest.json`, containing `windows-x86_64`, `windows-x86_64-nsis`, and `windows-x86_64-msi` entries.
- `SHA256SUMS-vMAJOR.MINOR.PATCH.txt`, covering the uploaded EXE and MSI installers.

The generic Windows entry is deliberately mapped to NSIS, while Tauri 2 clients installed through MSI or NSIS use the installer-specific entry when available. A final gate checks that the GitHub body and updater notes match the versioned Markdown, every manifest URL resolves to the uploaded installer and `.sig`, every manifest signature matches its generated local `.sig`, the SHA-256 manifest is attached, and the release is still a draft.

The workflow never publishes the release. Before manually publishing the draft:

1. review and complete the release notes;
2. verify the EXE, MSI, both signatures, `latest.json`, and the SHA-256 manifest are attached;
3. test an update from the previous updater-enabled release on Windows;
4. publish only after that test passes.

Do not rerun a published tag to replace its artifacts. Published installer bytes and signatures should be treated as immutable. A failed run may leave a draft with partial assets; review and delete that draft before rerunning the tag so the next build starts from an empty release.

## Stable channel and prereleases

The initial implementation has one honest channel: stable. GitHub's `releases/latest` endpoint selects a published, non-prerelease, non-draft release, and public resources need no client token.

A beta selector must not be exposed until a separate beta manifest exists. A future beta channel should use its own fixed endpoint or dynamic update service; GitHub's stable `latest` URL intentionally ignores prereleases.

## Key rotation

Rotate keys before the old private key is retired:

1. generate and back up a new key pair;
2. build a transitional release that embeds the **new public key** but is still signed with the **old private key**;
3. let existing clients install that transitional release;
4. switch the Actions secret to the new private key for later releases;
5. retain the old key securely until the transition window is closed.

If the old private key is already lost, automatic rotation is impossible for existing installations. They must manually install a build carrying the new public key.

## Rollback policy

Tauri accepts only a version newer than the installed version by default. Keep that protection enabled.

- To stop a bad rollout, remove it from the stable `latest` position or mark it as a prerelease. This protects clients that have not updated yet.
- Clients that already installed the bad version will not downgrade automatically.
- The normal recovery is to publish the last known-good code plus the fix as a new, higher patch version signed with the same key.
- A true downgrade requires a custom version comparator and a controlled update service. It should be reserved for an explicitly designed emergency channel, never enabled globally for the static GitHub manifest.

Keeping the preceding stable release and its immutable assets available makes forward recovery and manual repair possible without weakening version checks.
