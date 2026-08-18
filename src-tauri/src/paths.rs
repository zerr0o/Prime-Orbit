use std::path::{Path, PathBuf};

/// Canonicalize without leaking Windows verbatim (`\\?\`) prefixes into the
/// CLI, PowerShell, persisted configuration, or frontend payloads.
pub fn canonicalize(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}
