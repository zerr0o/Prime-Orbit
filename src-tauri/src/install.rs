use crate::{
    paths::canonicalize,
    runtime::{
        capture_command_output, ensure_supported_node, external_command, find_program,
        find_source_cli, managed_runtime_root, now_millis, persist_runtime_config, RuntimeConfig,
        OFFICIAL_REPOSITORY_URL, SUPPORTED_PRIME_AGENT_COMMIT, SUPPORTED_PRIME_AGENT_TAG,
    },
    storage::{write_atomic, PersistenceLock},
};
use serde::Serialize;
use std::{
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};
use tauri::{AppHandle, Emitter, Manager};

const GENERATED_MODELS_PATH: &str = "packages/ai/src/models.generated.ts";

#[derive(Debug)]
struct GeneratedModelsBaseline {
    head: String,
    contents: Vec<u8>,
}

pub struct InstallState(pub Arc<AtomicBool>);

impl Default for InstallState {
    fn default() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickInstallStarted {
    pub started: bool,
    pub source_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgressEvent {
    stage: String,
    message: String,
    percent: Option<u8>,
    stream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallCompleteEvent {
    success: bool,
    source_dir: String,
    cli_path: Option<String>,
    error: Option<String>,
}

fn emit_progress(
    app: &AppHandle,
    stage: &str,
    message: impl Into<String>,
    percent: Option<u8>,
    stream: Option<&str>,
) {
    let _ = app.emit(
        "prime-agent://install-progress",
        InstallProgressEvent {
            stage: stage.to_string(),
            message: message.into(),
            percent,
            stream: stream.map(str::to_string),
        },
    );
}

fn stream_command_output<R: Read>(reader: R, app: AppHandle, stage: String, stream: &'static str) {
    let mut reader = BufReader::new(reader);
    let mut record = Vec::new();
    loop {
        record.clear();
        match reader.read_until(b'\n', &mut record) {
            Ok(0) => break,
            Ok(_) => {
                if record.last() == Some(&b'\n') {
                    record.pop();
                }
                if record.last() == Some(&b'\r') {
                    record.pop();
                }
                let line = String::from_utf8_lossy(&record).trim().to_string();
                if !line.is_empty() {
                    emit_progress(&app, &stage, line, None, Some(stream));
                }
            }
            Err(error) => {
                emit_progress(
                    &app,
                    &stage,
                    format!("Erreur de lecture de {stream}: {error}"),
                    None,
                    Some("stderr"),
                );
                break;
            }
        }
    }
}

fn run_streaming(
    app: &AppHandle,
    stage: &str,
    mut command: Command,
    cwd: &Path,
) -> Result<(), String> {
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Impossible de lancer l’étape {stage}: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("L’étape {stage} n’a pas fourni stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("L’étape {stage} n’a pas fourni stderr"))?;
    let stdout_app = app.clone();
    let stderr_app = app.clone();
    let stdout_stage = stage.to_string();
    let stderr_stage = stage.to_string();
    let stdout_thread =
        thread::spawn(move || stream_command_output(stdout, stdout_app, stdout_stage, "stdout"));
    let stderr_thread =
        thread::spawn(move || stream_command_output(stderr, stderr_app, stderr_stage, "stderr"));
    let status = child
        .wait()
        .map_err(|error| format!("Impossible d’attendre l’étape {stage}: {error}"))?;
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    if status.success() {
        Ok(())
    } else {
        Err(format!("L’étape {stage} a échoué avec le statut {status}"))
    }
}

fn prepare_managed_kernel(app: &AppHandle, node: &Path, source_dir: &Path) -> Result<(), String> {
    let bootstrap = source_dir.join("packages/coding-agent/dist/core/kernel/bootstrap-cli.js");
    let metadata = fs::symlink_metadata(&bootstrap).map_err(|error| {
        format!(
            "Le bootstrap Python compilé {} est introuvable: {error}",
            bootstrap.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Le bootstrap Python {} doit être un fichier régulier non symbolique",
            bootstrap.display()
        ));
    }

    emit_progress(
        app,
        "kernel",
        "Préparation du kernel Python Prime Agent",
        Some(88),
        None,
    );
    let mut command = external_command(node, &[bootstrap.as_os_str().to_owned()]);
    #[cfg(windows)]
    crate::node_compat::configure_source_rpc(app, &mut command)?;
    command.env("PRIME_AGENT_INSTALL_UV", "1");
    command.env("PI_SKIP_VERSION_CHECK", "1");
    run_streaming(app, "kernel", command, source_dir)
}

fn normalized_repository_url(value: &str) -> String {
    value
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .replace("git@github.com:", "https://github.com/")
        .to_ascii_lowercase()
}

fn git_output(git: &Path, source_dir: &Path, arguments: &[OsString]) -> Result<Output, String> {
    let mut command_arguments = vec![OsString::from("-C"), source_dir.as_os_str().to_owned()];
    command_arguments.extend_from_slice(arguments);
    let mut command = external_command(git, &command_arguments);
    let output = capture_command_output(&mut command)?;
    if !output.status.success() {
        let command = arguments
            .iter()
            .map(|argument| argument.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        return Err(format!(
            "Git {} a échoué dans {}: {}",
            command,
            source_dir.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output)
}

fn git_text(git: &Path, source_dir: &Path, arguments: &[&str]) -> Result<String, String> {
    let arguments = arguments.iter().map(OsString::from).collect::<Vec<_>>();
    let output = git_output(git, source_dir, &arguments)?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_file_at_revision(
    git: &Path,
    source_dir: &Path,
    revision: &str,
    relative_path: &str,
) -> Result<Vec<u8>, String> {
    let object = format!("{revision}:{relative_path}");
    let output = git_output(
        git,
        source_dir,
        &[OsString::from("show"), OsString::from(object)],
    )?;
    Ok(output.stdout)
}

fn tracked_changes(git: &Path, source_dir: &Path) -> Result<String, String> {
    git_text(
        git,
        source_dir,
        &["status", "--porcelain", "--untracked-files=no"],
    )
}

fn generated_models_changes(git: &Path, source_dir: &Path) -> Result<String, String> {
    git_text(
        git,
        source_dir,
        &[
            "status",
            "--porcelain",
            "--untracked-files=no",
            "--",
            GENERATED_MODELS_PATH,
        ],
    )
}

fn ensure_tracked_checkout_clean(git: &Path, source_dir: &Path) -> Result<(), String> {
    if tracked_changes(git, source_dir)?.is_empty() {
        return Ok(());
    }
    Err(
        "Le runtime géré contient des modifications suivies. L’installation refuse de les écraser; aucun fichier utilisateur n’a été supprimé."
            .to_string(),
    )
}

fn generated_models_baseline(
    git: &Path,
    source_dir: &Path,
) -> Result<GeneratedModelsBaseline, String> {
    ensure_tracked_checkout_clean(git, source_dir)?;
    let head = git_text(git, source_dir, &["rev-parse", "HEAD"])?;
    let contents = git_file_at_revision(git, source_dir, &head, GENERATED_MODELS_PATH)?;
    let target = source_dir.join(GENERATED_MODELS_PATH);
    let current = fs::read(&target).map_err(|error| {
        format!(
            "Impossible de lire le fichier généré suivi {}: {error}",
            target.display()
        )
    })?;
    if current != contents {
        return Err(format!(
            "{} ne correspond pas à HEAD malgré un statut Git propre; la compilation est interrompue sans écraser le fichier",
            target.display()
        ));
    }
    Ok(GeneratedModelsBaseline { head, contents })
}

fn restore_generated_models(
    git: &Path,
    source_dir: &Path,
    baseline: &GeneratedModelsBaseline,
) -> Result<bool, String> {
    let current_head = git_text(git, source_dir, &["rev-parse", "HEAD"])?;
    if current_head != baseline.head {
        return Err(
            "Le HEAD du runtime a changé pendant la compilation; le fichier généré n’a pas été restauré afin de préserver les changements concurrents."
                .to_string(),
        );
    }

    let all_changes = tracked_changes(git, source_dir)?;
    let generated_change = generated_models_changes(git, source_dir)?;
    if all_changes != generated_change {
        return Err(
            "D’autres fichiers suivis ont changé pendant la compilation; aucun fichier n’a été restauré afin de préserver ces changements."
                .to_string(),
        );
    }

    let target = source_dir.join(GENERATED_MODELS_PATH);
    let current = fs::read(&target).ok();
    if current.as_deref() == Some(baseline.contents.as_slice()) {
        ensure_tracked_checkout_clean(git, source_dir)?;
        return Ok(false);
    }
    write_atomic(&target, &baseline.contents).map_err(|error| {
        format!(
            "Impossible de restaurer atomiquement {} depuis HEAD: {error}",
            target.display()
        )
    })?;
    ensure_tracked_checkout_clean(git, source_dir)?;
    Ok(true)
}

fn repair_previous_generated_models_change(git: &Path, source_dir: &Path) -> Result<bool, String> {
    let all_changes = tracked_changes(git, source_dir)?;
    if all_changes.is_empty() {
        return Ok(false);
    }
    let generated_change = generated_models_changes(git, source_dir)?;
    if generated_change.is_empty() || all_changes != generated_change {
        return ensure_tracked_checkout_clean(git, source_dir).map(|()| false);
    }
    let head = git_text(git, source_dir, &["rev-parse", "HEAD"])?;
    let baseline = GeneratedModelsBaseline {
        contents: git_file_at_revision(git, source_dir, &head, GENERATED_MODELS_PATH)?,
        head,
    };
    restore_generated_models(git, source_dir, &baseline)
}

fn verify_official_repository(git: &Path, source_dir: &Path) -> Result<(), String> {
    let actual = git_text(git, source_dir, &["remote", "get-url", "origin"])?;
    if normalized_repository_url(&actual) != normalized_repository_url(OFFICIAL_REPOSITORY_URL) {
        return Err(format!(
            "Le dossier géré {} pointe vers une origine non officielle ({actual}). Il ne sera pas modifié.",
            source_dir.display()
        ));
    }
    Ok(())
}

fn verify_supported_revision(git: &Path, source_dir: &Path) -> Result<(), String> {
    let tag_revision = format!("refs/tags/{SUPPORTED_PRIME_AGENT_TAG}^{{commit}}");
    let tag_commit = git_text(git, source_dir, &["rev-parse", &tag_revision])?;
    if tag_commit != SUPPORTED_PRIME_AGENT_COMMIT {
        return Err(format!(
            "Le tag officiel {SUPPORTED_PRIME_AGENT_TAG} pointe vers {tag_commit}, mais Prime Orbit attend la révision {SUPPORTED_PRIME_AGENT_COMMIT}. L’installation est interrompue."
        ));
    }
    let head = git_text(git, source_dir, &["rev-parse", "HEAD"])?;
    if head != SUPPORTED_PRIME_AGENT_COMMIT {
        return Err(format!(
            "Le runtime géré est sur {head}, pas sur la révision Prime Agent prise en charge {SUPPORTED_PRIME_AGENT_COMMIT}."
        ));
    }
    Ok(())
}

fn fetch_and_checkout_supported_release(
    app: &AppHandle,
    git: &Path,
    source_dir: &Path,
    runtime_root: &Path,
) -> Result<(), String> {
    emit_progress(
        app,
        "update",
        format!("Récupération de Prime Agent {SUPPORTED_PRIME_AGENT_TAG}"),
        Some(18),
        None,
    );
    let fetch_arguments = vec![
        OsString::from("-C"),
        source_dir.as_os_str().to_owned(),
        OsString::from("fetch"),
        OsString::from("--depth"),
        OsString::from("1"),
        OsString::from("origin"),
        OsString::from("tag"),
        OsString::from(SUPPORTED_PRIME_AGENT_TAG),
    ];
    run_streaming(
        app,
        "update",
        external_command(git, &fetch_arguments),
        runtime_root,
    )?;

    let tag_revision = format!("refs/tags/{SUPPORTED_PRIME_AGENT_TAG}^{{commit}}");
    let tag_commit = git_text(git, source_dir, &["rev-parse", &tag_revision])?;
    if tag_commit != SUPPORTED_PRIME_AGENT_COMMIT {
        return Err(format!(
            "Le tag récupéré {SUPPORTED_PRIME_AGENT_TAG} ne correspond pas à la révision approuvée {SUPPORTED_PRIME_AGENT_COMMIT}; le checkout existant n’a pas été modifié."
        ));
    }

    let checkout_arguments = vec![
        OsString::from("-C"),
        source_dir.as_os_str().to_owned(),
        OsString::from("checkout"),
        OsString::from("--detach"),
        OsString::from(format!("refs/tags/{SUPPORTED_PRIME_AGENT_TAG}")),
    ];
    run_streaming(
        app,
        "update",
        external_command(git, &checkout_arguments),
        runtime_root,
    )?;
    verify_supported_revision(git, source_dir)?;
    ensure_tracked_checkout_clean(git, source_dir)
}

fn validated_install_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let app_data = crate::storage::app_data_dir(app)?;
    let runtime_root = managed_runtime_root(app)?;
    if !runtime_root.exists() {
        fs::create_dir(&runtime_root).map_err(|error| {
            format!(
                "Impossible de créer le dossier runtime {}: {error}",
                runtime_root.display()
            )
        })?;
    }
    let runtime_root = canonicalize(&runtime_root).map_err(|error| {
        format!(
            "Impossible de résoudre le dossier runtime {}: {error}",
            runtime_root.display()
        )
    })?;
    if !runtime_root.starts_with(&app_data) {
        return Err(format!(
            "Le dossier runtime {} sort du stockage géré {}",
            runtime_root.display(),
            app_data.display()
        ));
    }
    let source_dir = runtime_root.join("prime-agent");
    if source_dir.exists() {
        let link_metadata = fs::symlink_metadata(&source_dir).map_err(|error| {
            format!(
                "Impossible d’inspecter le runtime {}: {error}",
                source_dir.display()
            )
        })?;
        if link_metadata.file_type().is_symlink() || !link_metadata.is_dir() {
            return Err(format!(
                "Le runtime géré {} doit être un dossier réel non symbolique",
                source_dir.display()
            ));
        }
        let canonical = canonicalize(&source_dir).map_err(|error| {
            format!(
                "Impossible de résoudre le runtime {}: {error}",
                source_dir.display()
            )
        })?;
        if !canonical.starts_with(&runtime_root)
            || canonical.parent() != Some(runtime_root.as_path())
        {
            return Err(format!(
                "La cible runtime {} ne correspond pas exactement au dossier géré attendu",
                canonical.display()
            ));
        }
        return Ok((runtime_root, canonical));
    }
    Ok((runtime_root, source_dir))
}

fn perform_install(app: &AppHandle, source_dir: &Path) -> Result<PathBuf, String> {
    let git = find_program("git").ok_or_else(|| "Git est introuvable dans PATH".to_string())?;
    let node =
        find_program("node").ok_or_else(|| "Node.js est introuvable dans PATH".to_string())?;
    ensure_supported_node(&node)?;
    let npm = find_program("npm").ok_or_else(|| "npm est introuvable dans PATH".to_string())?;
    #[cfg(windows)]
    find_program("bash").ok_or_else(|| {
        "Bash est requis par Prime Agent sous Windows (Git Bash, MSYS2/Cygwin ou WSL)".to_string()
    })?;
    let runtime_root = source_dir
        .parent()
        .ok_or_else(|| "La cible du runtime n’a pas de dossier parent".to_string())?;

    emit_progress(
        app,
        "prerequisites",
        "Git, Node.js et npm sont disponibles",
        Some(8),
        None,
    );

    if source_dir.exists() {
        let git_metadata = fs::symlink_metadata(source_dir.join(".git")).map_err(|error| {
            format!(
                "Le dossier {} existe mais n’est pas un clone Git exploitable: {error}. Aucun fichier n’a été supprimé.",
                source_dir.display()
            )
        })?;
        if git_metadata.file_type().is_symlink() || !git_metadata.is_dir() {
            return Err(format!(
                "{} existe mais .git n’est pas un dossier réel non symbolique. Aucun fichier n’a été supprimé.",
                source_dir.display()
            ));
        }
        verify_official_repository(&git, source_dir)?;
        if repair_previous_generated_models_change(&git, source_dir)? {
            emit_progress(
                app,
                "repair",
                format!(
                    "Restauration atomique de {GENERATED_MODELS_PATH} laissé par une compilation précédente"
                ),
                Some(12),
                None,
            );
        }
        ensure_tracked_checkout_clean(&git, source_dir)?;
        fetch_and_checkout_supported_release(app, &git, source_dir, runtime_root)?;
    } else {
        emit_progress(
            app,
            "clone",
            "Clonage du dépôt officiel Prime Agent",
            Some(15),
            None,
        );
        let arguments = vec![
            OsString::from("clone"),
            OsString::from("--depth"),
            OsString::from("1"),
            OsString::from("--branch"),
            OsString::from(SUPPORTED_PRIME_AGENT_TAG),
            OsString::from("--single-branch"),
            OsString::from(OFFICIAL_REPOSITORY_URL),
            source_dir.as_os_str().to_owned(),
        ];
        run_streaming(
            app,
            "clone",
            external_command(&git, &arguments),
            runtime_root,
        )?;
        let canonical = canonicalize(source_dir).map_err(|error| {
            format!(
                "Le clone {} ne peut pas être résolu: {error}",
                source_dir.display()
            )
        })?;
        if canonical.parent() != Some(runtime_root) {
            return Err("Le clone a été créé hors de la cible gérée attendue".to_string());
        }
        verify_official_repository(&git, &canonical)?;
        verify_supported_revision(&git, &canonical)?;
        ensure_tracked_checkout_clean(&git, &canonical)?;
    }

    emit_progress(
        app,
        "dependencies",
        "Installation reproductible des dépendances npm",
        Some(42),
        None,
    );
    run_streaming(
        app,
        "dependencies",
        external_command(&npm, &[OsString::from("ci")]),
        source_dir,
    )?;

    let generated_baseline = generated_models_baseline(&git, source_dir)?;
    emit_progress(app, "build", "Compilation de Prime Agent", Some(72), None);
    let build_result = run_streaming(
        app,
        "build",
        external_command(&npm, &[OsString::from("run"), OsString::from("build")]),
        source_dir,
    );
    let restore_result = restore_generated_models(&git, source_dir, &generated_baseline);
    match (build_result, restore_result) {
        (Ok(()), Ok(restored)) => {
            if restored {
                emit_progress(
                    app,
                    "build",
                    format!("{GENERATED_MODELS_PATH} restauré atomiquement depuis HEAD"),
                    Some(82),
                    None,
                );
            }
        }
        (Err(build_error), Ok(_)) => return Err(build_error),
        (Ok(()), Err(restore_error)) => return Err(restore_error),
        (Err(build_error), Err(restore_error)) => {
            return Err(format!(
                "{build_error}. La restauration de {GENERATED_MODELS_PATH} a également échoué: {restore_error}"
            ));
        }
    }

    prepare_managed_kernel(app, &node, source_dir)?;

    let source_dir = canonicalize(source_dir).map_err(|error| {
        format!(
            "Impossible de résoudre le runtime compilé {}: {error}",
            source_dir.display()
        )
    })?;
    let cli = find_source_cli(&source_dir).ok_or_else(|| {
        format!(
            "La compilation s’est terminée sans produire le cli.js attendu dans {}",
            source_dir.display()
        )
    })?;
    let node = canonicalize(&node).unwrap_or(node);
    let config = RuntimeConfig {
        executable_path: None,
        source_dir: Some(source_dir.to_string_lossy().into_owned()),
        node_path: Some(node.to_string_lossy().into_owned()),
        cli_path: Some(cli.to_string_lossy().into_owned()),
        repository_url: Some(OFFICIAL_REPOSITORY_URL.to_string()),
        updated_at: Some(now_millis()),
    };
    // The quick installer is single-flight. This lock also prevents a settings
    // save in another window from interleaving with this atomic config write.
    let persistence = app.state::<PersistenceLock>();
    let _guard = persistence.0.lock();
    persist_runtime_config(app, &config)?;
    emit_progress(
        app,
        "complete",
        "Prime Agent est installé et prêt",
        Some(100),
        None,
    );
    Ok(cli)
}

fn quick_install_prime_agent_blocking(
    app: AppHandle,
    install_flag: Arc<AtomicBool>,
) -> Result<QuickInstallStarted, String> {
    install_flag
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "Une installation de Prime Agent est déjà en cours".to_string())?;

    let flag = Arc::clone(&install_flag);
    let (_, source_dir) = match validated_install_paths(&app) {
        Ok(paths) => paths,
        Err(error) => {
            flag.store(false, Ordering::SeqCst);
            return Err(error);
        }
    };
    let response = QuickInstallStarted {
        started: true,
        source_dir: source_dir.to_string_lossy().into_owned(),
    };
    let event_source_dir = response.source_dir.clone();
    thread::spawn(move || {
        emit_progress(
            &app,
            "starting",
            "Préparation de l’installation Prime Agent",
            Some(2),
            None,
        );
        let result = perform_install(&app, &source_dir);
        let complete = match result {
            Ok(cli) => InstallCompleteEvent {
                success: true,
                source_dir: event_source_dir,
                cli_path: Some(cli.to_string_lossy().into_owned()),
                error: None,
            },
            Err(error) => {
                emit_progress(&app, "error", &error, None, Some("stderr"));
                InstallCompleteEvent {
                    success: false,
                    source_dir: event_source_dir,
                    cli_path: None,
                    error: Some(error),
                }
            }
        };
        flag.store(false, Ordering::SeqCst);
        let _ = app.emit("prime-agent://install-complete", complete);
    });
    Ok(response)
}

#[tauri::command]
pub async fn quick_install_prime_agent(
    app: AppHandle,
    install_state: tauri::State<'_, InstallState>,
) -> Result<QuickInstallStarted, String> {
    let flag = Arc::clone(&install_state.0);
    crate::run_blocking(move || quick_install_prime_agent_blocking(app, flag)).await
}

#[tauri::command]
pub fn is_prime_agent_installing(install_state: tauri::State<'_, InstallState>) -> bool {
    install_state.0.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::{
        generated_models_baseline, normalized_repository_url,
        repair_previous_generated_models_change, restore_generated_models, tracked_changes,
        GENERATED_MODELS_PATH,
    };
    use crate::runtime::find_program;
    use std::{fs, path::PathBuf};
    use tempfile::TempDir;

    fn git_fixture() -> Option<(TempDir, PathBuf, PathBuf)> {
        let git = find_program("git")?;
        let directory = tempfile::tempdir().expect("temporary git repository");
        let repository = directory.path().join("repo");
        fs::create_dir_all(repository.join("packages/ai/src")).expect("fixture directories");
        fs::write(
            repository.join(GENERATED_MODELS_PATH),
            b"// generated at HEAD\nexport const MODELS = [];\n",
        )
        .expect("generated fixture");
        fs::write(repository.join("README.md"), b"fixture\n").expect("readme fixture");
        super::git_text(&git, &repository, &["init"]).expect("git init");
        super::git_text(
            &git,
            &repository,
            &["config", "user.email", "test@example.invalid"],
        )
        .expect("git email");
        super::git_text(
            &git,
            &repository,
            &["config", "user.name", "Prime Orbit tests"],
        )
        .expect("git name");
        super::git_text(&git, &repository, &["add", "."]).expect("git add");
        super::git_text(&git, &repository, &["commit", "-m", "fixture"]).expect("git commit");
        Some((directory, repository, git))
    }

    #[test]
    fn normalizes_official_https_and_ssh_origins() {
        assert_eq!(
            normalized_repository_url("https://github.com/PrimeIntellect-ai/prime-agent.git"),
            normalized_repository_url("git@github.com:PrimeIntellect-ai/prime-agent.git")
        );
    }

    #[test]
    fn restores_only_the_generated_model_file_atomically() {
        let Some((_directory, repository, git)) = git_fixture() else {
            return;
        };
        let baseline = generated_models_baseline(&git, &repository).expect("clean baseline");
        fs::write(
            repository.join(GENERATED_MODELS_PATH),
            b"// rewritten by npm build\n",
        )
        .expect("simulated generator output");

        assert!(restore_generated_models(&git, &repository, &baseline).expect("restore"));
        assert_eq!(
            fs::read(repository.join(GENERATED_MODELS_PATH)).expect("restored file"),
            baseline.contents
        );
        assert!(tracked_changes(&git, &repository)
            .expect("clean status")
            .is_empty());
    }

    #[test]
    fn preserves_all_files_when_an_unexpected_tracked_change_appears() {
        let Some((_directory, repository, git)) = git_fixture() else {
            return;
        };
        let baseline = generated_models_baseline(&git, &repository).expect("clean baseline");
        let generated_after_build = b"// rewritten by npm build\n";
        fs::write(
            repository.join(GENERATED_MODELS_PATH),
            generated_after_build,
        )
        .expect("simulated generator output");
        fs::write(repository.join("README.md"), b"user edit\n").expect("concurrent user edit");

        let error = restore_generated_models(&git, &repository, &baseline)
            .expect_err("concurrent change must stop restoration");
        assert!(error.contains("D’autres fichiers suivis"));
        assert_eq!(
            fs::read(repository.join(GENERATED_MODELS_PATH)).expect("preserved generated file"),
            generated_after_build
        );
        assert_eq!(
            fs::read(repository.join("README.md")).expect("preserved user file"),
            b"user edit\n"
        );
    }

    #[test]
    fn repairs_a_legacy_build_change_only_when_it_is_the_sole_tracked_change() {
        let Some((_directory, repository, git)) = git_fixture() else {
            return;
        };
        fs::write(
            repository.join(GENERATED_MODELS_PATH),
            b"// stale previous build output\n",
        )
        .expect("legacy generator output");
        assert!(repair_previous_generated_models_change(&git, &repository)
            .expect("repair legacy generated change"));
        assert!(tracked_changes(&git, &repository)
            .expect("clean status")
            .is_empty());

        fs::write(
            repository.join(GENERATED_MODELS_PATH),
            b"// another stale build output\n",
        )
        .expect("second generator output");
        fs::write(repository.join("README.md"), b"user edit\n").expect("user edit");
        assert!(repair_previous_generated_models_change(&git, &repository).is_err());
        assert_eq!(
            fs::read(repository.join("README.md")).expect("preserved edit"),
            b"user edit\n"
        );
    }
}
