use crate::paths::canonicalize;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const MAX_OWNER_BYTES: u64 = 64 * 1024;
const GUARD_STALE_AFTER: Duration = Duration::from_secs(10);
static QUARANTINE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionLeaseOwner {
    version: u8,
    token: String,
    pid: u32,
    process_start_id: Option<String>,
    session_path: String,
    created_at: String,
}

#[derive(Debug)]
struct OwnerSnapshot {
    bytes: Option<Vec<u8>>,
    owner: Option<SessionLeaseOwner>,
}

#[cfg(windows)]
struct LeaseGuard {
    path: PathBuf,
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl Drop for LeaseGuard {
    fn drop(&mut self) {
        // The guard is an empty directory created atomically, matching
        // proper-lockfile's lockfilePath protocol. Never recurse here: a
        // non-empty directory is not ours to remove.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
        let _ = fs::remove_dir(&self.path);
    }
}

/// Prime Agent currently treats EEXIST/ENOTEMPTY as a session-lease collision.
/// Node returns EPERM for that same directory rename on Windows, so its stale
/// owner recovery is never reached. Prime Orbit performs the intended recovery
/// before spawning the RPC client, but only for the exact selected session and
/// only after proving that the recorded process is no longer the same process.
pub(crate) fn reclaim_stale_session_lease(
    app: &AppHandle,
    session_path: &Path,
    cwd: &Path,
) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let home = app
            .path()
            .home_dir()
            .map_err(|error| format!("Impossible de localiser les verrous Prime Agent: {error}"))?;
        let configured = std::env::var_os("PRIME_AGENT_CODING_AGENT_DIR")
            .or_else(|| std::env::var_os("PI_CODING_AGENT_DIR"));
        let agent_dir = resolve_agent_dir(&home, cwd, configured.as_deref());
        let lease_root = agent_dir.join("session-leases");
        reclaim_stale_session_lease_in(&lease_root, session_path)
    }

    #[cfg(not(windows))]
    {
        let _ = (app, session_path, cwd);
        Ok(false)
    }
}

fn resolve_agent_dir(home: &Path, cwd: &Path, configured: Option<&OsStr>) -> PathBuf {
    let Some(configured) = configured.filter(|value| !value.is_empty()) else {
        return home.join(".prime").join("agent");
    };
    let text = configured.to_string_lossy();
    if text == "~" {
        return home.to_path_buf();
    }
    if let Some(relative) = text.strip_prefix("~/") {
        return home.join(relative);
    }
    let path = PathBuf::from(configured);
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}

#[cfg(windows)]
fn reclaim_stale_session_lease_in(lease_root: &Path, session_path: &Path) -> Result<bool, String> {
    let canonical_session = canonicalize(session_path).map_err(|error| {
        format!(
            "Impossible de vérifier la session {}: {error}",
            session_path.display()
        )
    })?;
    let canonical_text = canonical_session.to_string_lossy();
    let hash = format!("{:x}", Sha256::digest(canonical_text.as_bytes()));
    let lock_path = lease_root.join(format!("{hash}.lock"));

    match fs::metadata(lease_root) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(format!(
                "Le dossier de verrous Prime Agent {} est invalide",
                lease_root.display()
            ))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Impossible d’inspecter {}: {error}",
                lease_root.display()
            ))
        }
    }

    let guard_path = appended_path(&lock_path, ".guard");
    let _guard = acquire_lease_guard(&guard_path)?;

    // Inspect only after owning the same atomic guard used by Prime Agent.
    let metadata = match fs::symlink_metadata(&lock_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Impossible d’inspecter le verrou {}: {error}",
                lock_path.display()
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "Le verrou Prime Agent {} n’est pas un dossier local sûr",
            lock_path.display()
        ));
    }

    let first = read_owner_snapshot(&lock_path)?;
    let first_owner = first.owner.as_ref().ok_or_else(|| {
        format!(
            "Le verrou Prime Agent {} ne contient pas de propriétaire valide; il reste intact par sécurité",
            lock_path.display()
        )
    })?;
    validate_owner_session(first_owner, &canonical_session, &lock_path)?;
    if lease_owner_is_alive(first_owner) {
        return Ok(false);
    }

    // Re-read immediately before the atomic rename. A changed token/owner means
    // another process won the race, so this attempt must leave the lock alone.
    let second = read_owner_snapshot(&lock_path)?;
    if first.bytes != second.bytes {
        return Ok(false);
    }
    let second_owner = second.owner.as_ref().ok_or_else(|| {
        format!(
            "Le propriétaire du verrou {} a changé pendant sa vérification",
            lock_path.display()
        )
    })?;
    validate_owner_session(second_owner, &canonical_session, &lock_path)?;
    if lease_owner_is_alive(second_owner) {
        return Ok(false);
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    for _ in 0..16 {
        let counter = QUARANTINE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let quarantine = appended_path(
            &lock_path,
            &format!(
                ".stale-prime-orbit-{}-{timestamp}-{counter}",
                std::process::id()
            ),
        );
        match fs::rename(&lock_path, &quarantine) {
            Ok(()) => return Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Le verrou obsolète {} n’a pas pu être placé en quarantaine: {error}",
                    lock_path.display()
                ))
            }
        }
    }

    Err(format!(
        "Impossible de choisir un nom de quarantaine pour {}",
        lock_path.display()
    ))
}

#[cfg(windows)]
fn appended_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

#[cfg(windows)]
fn acquire_lease_guard(path: &Path) -> Result<LeaseGuard, String> {
    for _ in 0..3 {
        match fs::create_dir(path) {
            Ok(()) => {
                let handle = match pin_guard_directory(path) {
                    Ok(handle) => handle,
                    Err(error) => {
                        let _ = fs::remove_dir(path);
                        return Err(error);
                    }
                };
                return Ok(LeaseGuard {
                    path: path.to_path_buf(),
                    handle,
                });
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let first = match fs::symlink_metadata(path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == ErrorKind::NotFound => continue,
                    Err(error) => {
                        return Err(format!(
                            "Impossible d’inspecter le guard {}: {error}",
                            path.display()
                        ))
                    }
                };
                if first.file_type().is_symlink() || !first.is_dir() {
                    return Err(format!(
                        "Le guard Prime Agent {} n’est pas un dossier local sûr",
                        path.display()
                    ));
                }
                let first_modified = first.modified().map_err(|error| {
                    format!(
                        "Impossible de dater le guard Prime Agent {}: {error}",
                        path.display()
                    )
                })?;
                let stale = guard_is_stale(first_modified, SystemTime::now());
                if !stale {
                    return Err(
                        "Prime Agent coordonne actuellement cette session. Réessayez dans quelques secondes."
                            .to_string(),
                    );
                }

                // Match proper-lockfile's stale recovery conservatively. A
                // refreshed mtime proves that a live owner still holds it.
                let second = match fs::symlink_metadata(path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == ErrorKind::NotFound => continue,
                    Err(error) => {
                        return Err(format!(
                            "Impossible de revérifier le guard {}: {error}",
                            path.display()
                        ))
                    }
                };
                if second.modified().ok() != Some(first_modified) {
                    return Err(
                        "Prime Agent coordonne actuellement cette session. Réessayez dans quelques secondes."
                            .to_string(),
                    );
                }
                match fs::remove_dir(path) {
                    Ok(()) => continue,
                    Err(error) if error.kind() == ErrorKind::NotFound => continue,
                    Err(error) => {
                        return Err(format!(
                            "Impossible de récupérer le guard obsolète {}: {error}",
                            path.display()
                        ))
                    }
                }
            }
            Err(error) => {
                return Err(format!(
                    "Impossible d’acquérir le guard Prime Agent {}: {error}",
                    path.display()
                ))
            }
        }
    }

    Err(format!(
        "Impossible d’acquérir le guard Prime Agent {} après plusieurs tentatives",
        path.display()
    ))
}

#[cfg(windows)]
fn pin_guard_directory(path: &Path) -> Result<windows_sys::Win32::Foundation::HANDLE, String> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        Storage::FileSystem::{
            CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY, FILE_SHARE_READ,
            FILE_SHARE_WRITE, OPEN_EXISTING,
        },
    };

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "Impossible de protéger le guard Prime Agent {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(handle)
}

#[cfg(windows)]
fn guard_is_stale(modified: SystemTime, now: SystemTime) -> bool {
    now.duration_since(modified).unwrap_or_default() >= GUARD_STALE_AFTER
}

#[cfg(windows)]
fn read_owner_snapshot(lock_path: &Path) -> Result<OwnerSnapshot, String> {
    let owner_path = lock_path.join("owner.json");
    let metadata = match fs::symlink_metadata(&owner_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(OwnerSnapshot {
                bytes: None,
                owner: None,
            })
        }
        Err(error) => {
            return Err(format!(
                "Impossible d’inspecter {}: {error}",
                owner_path.display()
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Le propriétaire du verrou {} n’est pas un fichier local sûr",
            owner_path.display()
        ));
    }
    if metadata.len() > MAX_OWNER_BYTES {
        return Err(format!(
            "Le propriétaire du verrou {} dépasse la taille autorisée",
            owner_path.display()
        ));
    }
    let bytes = fs::read(&owner_path)
        .map_err(|error| format!("Impossible de lire {}: {error}", owner_path.display()))?;
    if bytes.len() as u64 > MAX_OWNER_BYTES {
        return Err(format!(
            "Le propriétaire du verrou {} dépasse la taille autorisée",
            owner_path.display()
        ));
    }
    let owner = serde_json::from_slice::<SessionLeaseOwner>(&bytes)
        .ok()
        .filter(|owner| {
            owner.version == 1
                && !owner.token.is_empty()
                && owner.pid > 0
                && !owner.session_path.is_empty()
                && !owner.created_at.is_empty()
        });
    Ok(OwnerSnapshot {
        bytes: Some(bytes),
        owner,
    })
}

#[cfg(windows)]
fn validate_owner_session(
    owner: &SessionLeaseOwner,
    expected: &Path,
    lock_path: &Path,
) -> Result<(), String> {
    let owner_path = canonicalize(&owner.session_path).map_err(|error| {
        format!(
            "Le verrou {} référence une session invalide: {error}",
            lock_path.display()
        )
    })?;
    if owner_path != expected {
        return Err(format!(
            "Le verrou {} ne correspond pas à la session demandée",
            lock_path.display()
        ));
    }
    Ok(())
}

#[cfg(windows)]
enum ProcessIdentity {
    Dead,
    Alive(Option<String>),
}

#[cfg(windows)]
fn lease_owner_is_alive(owner: &SessionLeaseOwner) -> bool {
    match windows_process_identity(owner.pid) {
        ProcessIdentity::Dead => false,
        ProcessIdentity::Alive(None) => true,
        ProcessIdentity::Alive(Some(actual)) => owner
            .process_start_id
            .as_ref()
            .map(|expected| expected == &actual)
            .unwrap_or(true),
    }
}

#[cfg(windows)]
fn windows_process_identity(pid: u32) -> ProcessIdentity {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, FILETIME},
        System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        let error = unsafe { GetLastError() };
        return if error == ERROR_INVALID_PARAMETER {
            ProcessIdentity::Dead
        } else {
            // Access denied and transient query failures are treated as alive;
            // failing closed is essential because reclaiming a live writer can
            // corrupt a JSONL session.
            ProcessIdentity::Alive(None)
        };
    }

    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    let success =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    unsafe {
        CloseHandle(handle);
    }
    if success == 0 {
        return ProcessIdentity::Alive(None);
    }

    let filetime_ticks = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
    // .NET DateTime.Ticks (used by Prime Agent's PowerShell probe) starts at
    // year 1; FILETIME starts at 1601. Both units are 100 ns.
    const FILETIME_TO_DATETIME_TICKS: u64 = 504_911_232_000_000_000;
    ProcessIdentity::Alive(Some(format!(
        "win:{}",
        filetime_ticks.saturating_add(FILETIME_TO_DATETIME_TICKS)
    )))
}

#[cfg(all(test, windows))]
mod tests {
    use super::{
        acquire_lease_guard, appended_path, guard_is_stale, reclaim_stale_session_lease_in,
        resolve_agent_dir, windows_process_identity, ProcessIdentity, GUARD_STALE_AFTER,
    };
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::{fs, path::Path, time::SystemTime};
    use tempfile::TempDir;

    fn fixture() -> (TempDir, std::path::PathBuf, std::path::PathBuf) {
        let temporary = TempDir::new().expect("temp directory");
        let session = temporary.path().join("session.jsonl");
        fs::write(&session, "").expect("session file");
        let session = dunce::canonicalize(session).expect("canonical session");
        let root = temporary.path().join("session-leases");
        fs::create_dir_all(&root).expect("lease root");
        (temporary, root, session)
    }

    #[test]
    fn resolves_the_same_agent_directory_overrides_as_prime_agent() {
        let temporary = TempDir::new().expect("temp directory");
        let home = temporary.path().join("home");
        let cwd = temporary.path().join("project");
        fs::create_dir_all(&home).expect("home");
        fs::create_dir_all(&cwd).expect("cwd");

        assert_eq!(
            resolve_agent_dir(&home, &cwd, None),
            home.join(".prime").join("agent")
        );
        assert_eq!(
            resolve_agent_dir(&home, &cwd, Some(std::ffi::OsStr::new("~"))),
            home
        );
        assert_eq!(
            resolve_agent_dir(&home, &cwd, Some(std::ffi::OsStr::new("~/custom-agent"))),
            home.join("custom-agent")
        );
        assert_eq!(
            resolve_agent_dir(&home, &cwd, Some(std::ffi::OsStr::new("relative-agent"))),
            cwd.join("relative-agent")
        );
        let absolute = temporary.path().join("absolute-agent");
        assert_eq!(
            resolve_agent_dir(&home, &cwd, Some(absolute.as_os_str())),
            absolute
        );
    }

    fn lock_path(root: &Path, session: &Path) -> std::path::PathBuf {
        let hash = format!("{:x}", Sha256::digest(session.to_string_lossy().as_bytes()));
        root.join(format!("{hash}.lock"))
    }

    fn write_owner(
        root: &Path,
        session: &Path,
        pid: u32,
        process_start_id: Option<&str>,
    ) -> std::path::PathBuf {
        let lock = lock_path(root, session);
        fs::create_dir(&lock).expect("lock directory");
        fs::write(
            lock.join("owner.json"),
            serde_json::to_vec(&json!({
                "version": 1,
                "token": "test-token",
                "pid": pid,
                "processStartId": process_start_id,
                "activeSessionId": "test-session",
                "sessionPath": session,
                "createdAt": "2026-08-18T00:00:00.000Z"
            }))
            .expect("owner json"),
        )
        .expect("owner file");
        lock
    }

    #[test]
    fn quarantines_a_lock_owned_by_a_dead_process() {
        let (_temporary, root, session) = fixture();
        let lock = write_owner(&root, &session, u32::MAX, None);

        assert!(reclaim_stale_session_lease_in(&root, &session).expect("reclaim"));
        assert!(!lock.exists());
        assert!(fs::read_dir(&root)
            .expect("lease listing")
            .any(|entry| entry
                .expect("lease entry")
                .file_name()
                .to_string_lossy()
                .contains(".stale-prime-orbit-")));
    }

    #[test]
    fn preserves_a_lock_owned_by_the_current_process() {
        let (_temporary, root, session) = fixture();
        let start_id = match windows_process_identity(std::process::id()) {
            ProcessIdentity::Alive(Some(identity)) => identity,
            _ => panic!("current process identity should be readable"),
        };
        let lock = write_owner(&root, &session, std::process::id(), Some(&start_id));

        assert!(!reclaim_stale_session_lease_in(&root, &session).expect("inspect"));
        assert!(lock.exists());
    }

    #[test]
    fn quarantines_a_reused_pid_identity() {
        let (_temporary, root, session) = fixture();
        let lock = write_owner(&root, &session, std::process::id(), Some("win:1"));

        assert!(reclaim_stale_session_lease_in(&root, &session).expect("reclaim"));
        assert!(!lock.exists());
    }

    #[test]
    fn preserves_a_lock_while_the_upstream_guard_exists() {
        let (_temporary, root, session) = fixture();
        let lock = write_owner(&root, &session, u32::MAX, None);
        fs::create_dir(appended_path(&lock, ".guard")).expect("guard directory");

        let error = reclaim_stale_session_lease_in(&root, &session)
            .expect_err("an active guard must defer recovery");
        assert!(error.contains("coordonne actuellement"));
        assert!(lock.exists());
    }

    #[test]
    fn preserves_an_ownerless_lock_when_liveness_cannot_be_proved() {
        let (_temporary, root, session) = fixture();
        let lock = lock_path(&root, &session);
        fs::create_dir(&lock).expect("lock directory");

        let error = reclaim_stale_session_lease_in(&root, &session)
            .expect_err("ownerless lock must fail closed");
        assert!(error.contains("propriétaire valide"));
        assert!(lock.exists());
    }

    #[test]
    fn preserves_a_malformed_owner_when_liveness_cannot_be_proved() {
        let (_temporary, root, session) = fixture();
        let lock = lock_path(&root, &session);
        fs::create_dir(&lock).expect("lock directory");
        fs::write(lock.join("owner.json"), b"{\"version\":1}").expect("malformed owner");

        let error = reclaim_stale_session_lease_in(&root, &session)
            .expect_err("malformed owner must fail closed");
        assert!(error.contains("propriétaire valide"));
        assert!(lock.exists());
    }

    #[test]
    fn only_reclaims_a_guard_after_the_conservative_stale_threshold() {
        let now = SystemTime::now();
        assert!(!guard_is_stale(now - (GUARD_STALE_AFTER / 2), now));
        assert!(guard_is_stale(now - GUARD_STALE_AFTER, now));
    }

    #[test]
    fn holds_the_same_atomic_guard_used_by_prime_agent() {
        let (_temporary, root, session) = fixture();
        let lock = write_owner(&root, &session, u32::MAX, None);
        let guard_path = appended_path(&lock, ".guard");

        let guard = acquire_lease_guard(&guard_path).expect("acquire guard");
        let collision = fs::create_dir(&guard_path).expect_err("guard must be exclusive");
        assert_eq!(collision.kind(), std::io::ErrorKind::AlreadyExists);
        fs::remove_dir(&guard_path).expect_err("a live guard must be pinned against deletion");
        drop(guard);

        let guard_after_release = acquire_lease_guard(&guard_path).expect("reacquire guard");
        drop(guard_after_release);
        assert!(!guard_path.exists());
    }
}
