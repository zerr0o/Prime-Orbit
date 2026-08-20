use crate::storage::{app_data_dir, write_atomic};
use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::AppHandle;

const PRELOAD_FILE_NAME: &str = "prime-agent-node-compat.cjs";
const PRELOAD_BYTES: &[u8] = include_bytes!("../assets/prime-agent-node-compat.cjs");

pub(crate) fn configure_source_rpc(
    app: &AppHandle,
    command: &mut Command,
    source_dir: Option<&Path>,
) -> Result<(), String> {
    let runtime_root = app_data_dir(app)?.join("runtime");
    fs::create_dir_all(&runtime_root).map_err(|error| {
        format!(
            "Impossible de créer le dossier de compatibilité Node {}: {error}",
            runtime_root.display()
        )
    })?;
    let preload = ensure_preload_in(&runtime_root)?;
    let options = merged_node_options(std::env::var_os("NODE_OPTIONS").as_deref(), &preload)?;
    command.env("NODE_OPTIONS", options);
    command.env("PI_SKIP_VERSION_CHECK", "1");
    if let Some(source_dir) =
        source_dir.filter(|source_dir| crate::runtime::is_managed_source_dir(app, source_dir))
    {
        // Each immutable runtime generation owns its kernel environment. A
        // managed upgrade can therefore prepare Python while sessions from the
        // previous generation keep their loaded python.exe/pythonw.exe files.
        command.env(
            "PRIME_AGENT_KERNEL_VENV",
            source_dir.join(".prime-orbit").join("kernel-venv"),
        );
    }
    Ok(())
}

fn ensure_preload_in(runtime_root: &Path) -> Result<PathBuf, String> {
    let preload = runtime_root.join(PRELOAD_FILE_NAME);
    let current = fs::read(&preload).ok();
    if current.as_deref() != Some(PRELOAD_BYTES) {
        write_atomic(&preload, PRELOAD_BYTES)?;
    }
    Ok(preload)
}

fn merged_node_options(existing: Option<&OsStr>, preload: &Path) -> Result<OsString, String> {
    let preload = preload.to_str().ok_or_else(|| {
        format!(
            "Le chemin de compatibilité Node {} ne peut pas être transmis à Node.js",
            preload.display()
        )
    })?;
    if preload.contains(['"', '\r', '\n']) {
        return Err("Le chemin de compatibilité Node contient un caractère interdit".to_string());
    }
    // NODE_OPTIONS tokenizes its value before resolving `--require`. Quoted
    // Windows backslashes are consumed by that parser; forward slashes remain
    // valid Windows paths and also survive paths containing spaces.
    let preload = preload.replace('\\', "/");
    let requirement = format!("--require=\"{preload}\"");
    let mut result = existing.unwrap_or_default().to_os_string();
    if !result.is_empty() {
        result.push(" ");
    }
    result.push(requirement);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{ensure_preload_in, merged_node_options, PRELOAD_BYTES, PRELOAD_FILE_NAME};
    use std::{ffi::OsStr, fs, path::Path, process::Command};

    #[cfg(windows)]
    fn run_node_with_preload(
        node: &Path,
        preload: &Path,
        script: &str,
        environment: &[(&str, &Path)],
    ) -> std::process::Output {
        let options = merged_node_options(None, preload).expect("node options");
        let mut command = Command::new(node);
        command.args(["-e", script]).env("NODE_OPTIONS", options);
        for (name, value) in environment {
            command.env(name, value);
        }
        command.output().expect("launch Node fixture")
    }

    #[test]
    fn writes_and_repairs_the_preload_atomically() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let first = ensure_preload_in(temporary.path()).expect("write preload");
        assert_eq!(fs::read(&first).expect("read preload"), PRELOAD_BYTES);
        fs::write(&first, b"broken").expect("corrupt preload fixture");
        let repaired = ensure_preload_in(temporary.path()).expect("repair preload");
        assert_eq!(repaired, temporary.path().join(PRELOAD_FILE_NAME));
        assert_eq!(
            fs::read(repaired).expect("read repaired preload"),
            PRELOAD_BYTES
        );
    }

    #[test]
    fn preserves_existing_node_options_and_quotes_spaces() {
        let path = std::path::Path::new(r"C:\Users\Example User\AppData\runtime\compat.cjs");
        let merged =
            merged_node_options(Some(OsStr::new("--trace-warnings")), path).expect("merge options");
        assert_eq!(
            merged,
            OsStr::new(
                r#"--trace-warnings --require="C:/Users/Example User/AppData/runtime/compat.cjs""#
            )
        );
    }

    #[cfg(windows)]
    #[test]
    fn node_loads_the_preload_from_a_quoted_path_with_spaces() {
        let Some(node) = crate::runtime::find_program("node") else {
            return;
        };
        let temporary = tempfile::tempdir().expect("temporary directory");
        let runtime_root = temporary.path().join("runtime with spaces");
        fs::create_dir_all(&runtime_root).expect("runtime fixture");
        let preload = ensure_preload_in(&runtime_root).expect("write preload");
        let options = merged_node_options(None, &preload).expect("node options");
        let output = Command::new(node)
            .args(["-e", "process.stdout.write('preload-ok')"])
            .env("NODE_OPTIONS", options)
            .output()
            .expect("launch Node with preload");
        assert!(
            output.status.success(),
            "Node rejected the preload path: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"preload-ok");
    }

    #[cfg(windows)]
    #[test]
    fn esm_spawn_binding_rewrites_the_missing_posix_venv_interpreter() {
        let Some(node) = crate::runtime::find_program("node") else {
            return;
        };
        let temporary = tempfile::tempdir().expect("temporary directory");
        let runtime_root = temporary.path().join("runtime with spaces");
        fs::create_dir_all(&runtime_root).expect("runtime fixture");
        let preload = ensure_preload_in(&runtime_root).expect("write preload");
        let venv = temporary.path().join("kernel-venv");
        let scripts = venv.join("Scripts");
        fs::create_dir_all(&scripts).expect("Scripts directory");
        fs::copy(&node, scripts.join("python.exe")).expect("fake venv interpreter");
        let missing_posix_python = venv.join("bin").join("python");
        let script = r#"
            import('node:child_process').then(({ spawnSync }) => {
              const result = spawnSync(process.env.ORBIT_TEST_PYTHON, ['-e', "process.stdout.write('rewritten')"], { encoding: 'utf8', windowsHide: false });
              if (result.error || result.status !== 0) {
                process.stderr.write(String(result.error || result.stderr || result.status));
                process.exit(1);
              }
              process.stdout.write(result.stdout);
            });
        "#;
        let output = run_node_with_preload(
            &node,
            &preload,
            script,
            &[("ORBIT_TEST_PYTHON", missing_posix_python.as_path())],
        );
        assert!(
            output.status.success(),
            "preloaded ESM spawn failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"rewritten");
    }

    #[cfg(windows)]
    #[test]
    fn normalizes_only_the_prime_agent_session_lease_collision() {
        let Some(node) = crate::runtime::find_program("node") else {
            return;
        };
        let temporary = tempfile::tempdir().expect("temporary directory");
        let runtime_root = temporary.path().join("runtime");
        fs::create_dir_all(&runtime_root).expect("runtime fixture");
        let preload = ensure_preload_in(&runtime_root).expect("write preload");
        let leases = temporary.path().join("session-leases");
        fs::create_dir_all(&leases).expect("lease root");
        let hash = "a".repeat(64);
        let lock = leases.join(format!("{hash}.lock"));
        let candidate = leases.join(format!(
            "{hash}.lock.candidate-4242-123e4567-e89b-42d3-a456-426614174000"
        ));
        fs::create_dir_all(&lock).expect("existing lease");
        fs::create_dir_all(&candidate).expect("candidate lease");
        fs::write(candidate.join("owner.json"), b"{}\n").expect("candidate owner");

        let other_lock = leases.join("not-a-prime-agent-hash.lock");
        let other_candidate = leases.join("not-a-prime-agent-hash.lock.candidate-4242-test");
        fs::create_dir_all(&other_lock).expect("other lock");
        fs::create_dir_all(&other_candidate).expect("other candidate");
        let script = r#"
            import('node:fs').then(({ renameSync }) => {
              const code = (source, destination) => {
                try { renameSync(source, destination); return 'none'; }
                catch (error) { return error && error.code; }
              };
              process.stdout.write(JSON.stringify({
                targeted: code(process.env.ORBIT_TEST_CANDIDATE, process.env.ORBIT_TEST_LOCK),
                unrelated: code(process.env.ORBIT_TEST_OTHER_CANDIDATE, process.env.ORBIT_TEST_OTHER_LOCK),
              }));
            });
        "#;
        let output = run_node_with_preload(
            &node,
            &preload,
            script,
            &[
                ("ORBIT_TEST_CANDIDATE", candidate.as_path()),
                ("ORBIT_TEST_LOCK", lock.as_path()),
                ("ORBIT_TEST_OTHER_CANDIDATE", other_candidate.as_path()),
                ("ORBIT_TEST_OTHER_LOCK", other_lock.as_path()),
            ],
        );
        assert!(
            output.status.success(),
            "lease fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8(output.stdout).expect("utf8 fixture output"),
            r#"{"targeted":"EEXIST","unrelated":"EPERM"}"#
        );
    }

    #[cfg(windows)]
    #[test]
    fn preserves_exec_and_exec_file_custom_promises() {
        let Some(node) = crate::runtime::find_program("node") else {
            return;
        };
        let temporary = tempfile::tempdir().expect("temporary directory");
        let runtime_root = temporary.path().join("runtime");
        fs::create_dir_all(&runtime_root).expect("runtime fixture");
        let preload = ensure_preload_in(&runtime_root).expect("write preload");
        let script = r#"
            const { promisify } = require('node:util');
            const { exec, execFile } = require('node:child_process');
            Promise.all([
              promisify(exec)(`"${process.execPath}" -e "process.stdout.write('exec-ok')"`),
              promisify(execFile)(process.execPath, ['-e', "process.stdout.write('file-ok')"]),
            ]).then(([execResult, fileResult]) => {
              process.stdout.write(JSON.stringify({
                exec: execResult.stdout,
                file: fileResult.stdout,
                execObject: typeof execResult === 'object',
                fileObject: typeof fileResult === 'object',
              }));
            }).catch((error) => {
              process.stderr.write(String(error && (error.stack || error)));
              process.exit(1);
            });
        "#;
        let output = run_node_with_preload(&node, &preload, script, &[]);
        assert!(
            output.status.success(),
            "promisified child process fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8(output.stdout).expect("utf8 fixture output"),
            r#"{"exec":"exec-ok","file":"file-ok","execObject":true,"fileObject":true}"#
        );
    }
}
