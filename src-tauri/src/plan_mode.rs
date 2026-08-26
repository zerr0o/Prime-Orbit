//! Native support for Prime Orbit's isolated Plan runtime and generated plans.
//!
//! The trusted Prime Agent extension is embedded in the executable, repaired
//! atomically under the application data directory, and never loaded from the
//! project being inspected. Generated Markdown is the sole project write
//! allowed by the Plan workflow, and only after the agent has submitted the
//! completed document to Orbit.

use crate::{
    agents::{attest_plan_document_write, attest_recovered_plan_document_write, AgentsState},
    storage::{app_data_dir, write_atomic, write_atomic_new, AtomicCreateResult},
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use tauri::AppHandle;

const PLAN_EXTENSION_FILE_NAME: &str = "prime-orbit-plan-mode.ts";
const PLAN_EXTENSION_BYTES: &[u8] = include_bytes!("../assets/prime-orbit-plan-mode.ts");
const MAX_PLAN_TITLE_CHARS: usize = 200;
const MAX_PLAN_MARKDOWN_BYTES: usize = 512 * 1024;
const MAX_PLAN_ID_CHARS: usize = 128;

#[derive(Default)]
pub(crate) struct PlanDocumentState(Mutex<()>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WritePlanDocumentInput {
    conversation_id: String,
    request_id: String,
    project_path: String,
    plan_id: String,
    title: String,
    markdown: String,
    #[serde(default)]
    recovered_from_transcript: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WritePlanDocumentResult {
    relative_path: String,
    created: bool,
}

pub(crate) fn ensure_plan_extension(app: &AppHandle) -> Result<PathBuf, String> {
    let runtime_root = app_data_dir(app)?.join("runtime");
    ensure_plain_directory(&runtime_root)?;
    ensure_plan_extension_in(&runtime_root)
}

fn ensure_plan_extension_in(runtime_root: &Path) -> Result<PathBuf, String> {
    let extension = runtime_root.join(PLAN_EXTENSION_FILE_NAME);
    let current = fs::read(&extension).ok();
    if current.as_deref() != Some(PLAN_EXTENSION_BYTES) {
        write_atomic(&extension, PLAN_EXTENSION_BYTES)?;
    }
    Ok(extension)
}

/// Opens the verified embedded extension with a Windows share mode that allows
/// Prime Agent to read it but prevents replacement, writes, and deletion for
/// the complete lifetime of the spawned Plan process.
pub(crate) fn lock_plan_extension_for_launch(path: &Path) -> Result<Arc<fs::File>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Impossible de vérifier {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("L’extension Plan doit être un fichier physique régulier.".to_string());
    }

    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Impossible de verrouiller {}: {error}", path.display()))?;
    let opened = file
        .metadata()
        .map_err(|error| format!("Impossible de vérifier le verrou Plan: {error}"))?;
    if !opened.is_file() || opened.len() != PLAN_EXTENSION_BYTES.len() as u64 {
        return Err("L’extension Plan verrouillée a une taille inattendue.".to_string());
    }
    let mut bytes = Vec::with_capacity(PLAN_EXTENSION_BYTES.len());
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Impossible de relire l’extension Plan verrouillée: {error}"))?;
    if bytes != PLAN_EXTENSION_BYTES {
        return Err(
            "L’extension Plan verrouillée ne correspond pas au binaire embarqué.".to_string(),
        );
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("Impossible de réinitialiser le verrou Plan: {error}"))?;
    Ok(Arc::new(file))
}

fn validate_plan_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > MAX_PLAN_ID_CHARS {
        return Err("L’identifiant du plan est invalide.".to_string());
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("L’identifiant du plan contient des caractères interdits.".to_string());
    }
    Ok(value.to_string())
}

fn validate_title(value: &str) -> Result<String, String> {
    let title = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err("Le titre du plan est requis.".to_string());
    }
    if title.chars().count() > MAX_PLAN_TITLE_CHARS || title.contains(['\0', '\r', '\n']) {
        return Err("Le titre du plan est invalide ou trop long.".to_string());
    }
    Ok(title)
}

fn validate_markdown(value: &str) -> Result<String, String> {
    let markdown = value.trim();
    if markdown.is_empty() {
        return Err("Le document de planification est vide.".to_string());
    }
    if markdown.contains('\0') || markdown.len() > MAX_PLAN_MARKDOWN_BYTES {
        return Err(format!(
            "Le document de planification dépasse la limite de {} octets ou contient un caractère interdit.",
            MAX_PLAN_MARKDOWN_BYTES
        ));
    }
    Ok(markdown.to_string())
}

fn slugify_title(title: &str) -> String {
    let mut slug = String::new();
    let mut separator_pending = false;
    for character in title.chars() {
        if character.is_ascii_alphanumeric() {
            if separator_pending && !slug.is_empty() {
                slug.push('-');
            }
            slug.extend(character.to_lowercase());
            separator_pending = false;
        } else if character.is_alphanumeric() {
            // Keep non-ASCII letters out of the native filename. The complete
            // localized title remains inside the Markdown document.
            separator_pending = !slug.is_empty();
        } else {
            separator_pending = !slug.is_empty();
        }
        if slug.len() >= 64 {
            break;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "plan".to_string()
    } else {
        slug
    }
}

fn ensure_plain_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "Le dossier de plans {} ne peut pas être un lien symbolique.",
            path.display()
        )),
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(format!(
            "Le chemin de plans {} n’est pas un dossier.",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(path)
            .map_err(|error| format!("Impossible de créer {}: {error}", path.display())),
        Err(error) => Err(format!(
            "Impossible de vérifier {}: {error}",
            path.display()
        )),
    }
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    let Ok(relative) = candidate.strip_prefix(root) else {
        return false;
    };
    !relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    })
}

fn write_plan_document_in(
    project_path: &Path,
    plan_id: &str,
    title: &str,
    markdown: &str,
) -> Result<WritePlanDocumentResult, String> {
    let plan_id = validate_plan_id(plan_id)?;
    let title = validate_title(title)?;
    let markdown = validate_markdown(markdown)?;
    let bytes = format!("<!-- prime-orbit-plan-id:{plan_id} -->\n{markdown}\n").into_bytes();
    let project_root = dunce::canonicalize(project_path).map_err(|error| {
        format!(
            "Le dossier du projet {} est inaccessible: {error}",
            project_path.display()
        )
    })?;
    if !project_root.is_dir() {
        return Err("Le chemin du projet n’est pas un dossier.".to_string());
    }

    let prime_dir = project_root.join(".prime");
    ensure_plain_directory(&prime_dir)?;
    let plans_dir = prime_dir.join("plans");
    ensure_plain_directory(&plans_dir)?;
    let canonical_plans = dunce::canonicalize(&plans_dir).map_err(|error| {
        format!(
            "Le dossier de plans {} est inaccessible: {error}",
            plans_dir.display()
        )
    })?;
    if !is_within(&project_root, &canonical_plans) {
        return Err("Le dossier de plans sort du projet autorisé.".to_string());
    }

    let base_name = slugify_title(&title);
    let owner_marker = format!("<!-- prime-orbit-plan-id:{plan_id} -->\n");
    for suffix in 1..=1_000 {
        let file_name = if suffix == 1 {
            format!("{base_name}.md")
        } else {
            format!("{base_name}-{suffix}.md")
        };
        let destination = canonical_plans.join(&file_name);
        match fs::symlink_metadata(&destination) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(
                        "Le chemin du document de planification n’est pas un fichier ordinaire."
                            .to_string(),
                    );
                }
                let existing = fs::read(&destination).map_err(|error| {
                    format!("Impossible de relire {}: {error}", destination.display())
                })?;
                if existing.starts_with(owner_marker.as_bytes()) && existing == bytes {
                    return Ok(WritePlanDocumentResult {
                        relative_path: format!(".prime/plans/{file_name}"),
                        created: false,
                    });
                }
                // Never replace a path selected from prior metadata. A changed
                // owned revision and every foreign collision receive a fresh
                // suffix, eliminating check/use overwrite races.
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ensure_plain_directory(&canonical_plans)?;
                if dunce::canonicalize(&canonical_plans).ok().as_deref()
                    != Some(canonical_plans.as_path())
                {
                    return Err("Le dossier de plans a changé pendant l’écriture.".to_string());
                }
                match write_atomic_new(&destination, &bytes)? {
                    AtomicCreateResult::Created => {
                        return Ok(WritePlanDocumentResult {
                            relative_path: format!(".prime/plans/{file_name}"),
                            created: true,
                        });
                    }
                    AtomicCreateResult::AlreadyExists => continue,
                }
            }
            Err(error) => {
                return Err(format!(
                    "Impossible de vérifier {}: {error}",
                    destination.display()
                ));
            }
        }
    }
    Err("Trop de plans utilisent déjà ce titre.".to_string())
}

#[tauri::command]
pub(crate) async fn write_plan_document(
    window: tauri::WebviewWindow,
    agents: tauri::State<'_, AgentsState>,
    state: tauri::State<'_, PlanDocumentState>,
    input: WritePlanDocumentInput,
) -> Result<WritePlanDocumentResult, String> {
    let recovered = if input.recovered_from_transcript {
        if input.plan_id != input.request_id {
            return Err(
                "L’identifiant du plan récupéré ne correspond pas à l’appel Prime Agent."
                    .to_string(),
            );
        }
        Some(attest_recovered_plan_document_write(
            agents.inner(),
            window.label(),
            &input.conversation_id,
            &input.request_id,
            Path::new(&input.project_path),
        )?)
    } else {
        attest_plan_document_write(
            agents.inner(),
            window.label(),
            &input.conversation_id,
            &input.request_id,
            &input.plan_id,
            Path::new(&input.project_path),
        )?;
        None
    };
    let _guard = state.0.lock();
    let (title, markdown) = recovered
        .as_ref()
        .map(|document| (document.title.as_str(), document.markdown.as_str()))
        .unwrap_or((input.title.as_str(), input.markdown.as_str()));
    write_plan_document_in(
        Path::new(&input.project_path),
        &input.plan_id,
        title,
        markdown,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_plan_extension_in, lock_plan_extension_for_launch, slugify_title, validate_markdown,
        write_plan_document_in, PLAN_EXTENSION_BYTES, PLAN_EXTENSION_FILE_NAME,
    };
    use std::fs;

    #[test]
    fn embedded_extension_is_written_and_repaired_atomically() {
        let temporary = tempfile::tempdir().unwrap();
        let extension = ensure_plan_extension_in(temporary.path()).unwrap();
        assert_eq!(extension, temporary.path().join(PLAN_EXTENSION_FILE_NAME));
        assert_eq!(fs::read(&extension).unwrap(), PLAN_EXTENSION_BYTES);
        fs::write(&extension, b"tampered").unwrap();
        ensure_plan_extension_in(temporary.path()).unwrap();
        assert_eq!(fs::read(&extension).unwrap(), PLAN_EXTENSION_BYTES);
        let guard = lock_plan_extension_for_launch(&extension).unwrap();
        #[cfg(windows)]
        assert!(fs::write(&extension, b"race replacement").is_err());
        drop(guard);
    }

    #[test]
    fn plan_filename_is_bounded_and_portable() {
        assert_eq!(
            slugify_title("  Migration API — Étape 2  "),
            "migration-api-tape-2"
        );
        assert_eq!(slugify_title("日本語"), "plan");
        assert!(slugify_title(&"A".repeat(500)).len() <= 64);
    }

    #[test]
    fn writes_once_then_returns_the_same_document_idempotently() {
        let temporary = tempfile::tempdir().unwrap();
        let first = write_plan_document_in(
            temporary.path(),
            "plan_1234567890abcdef",
            "Migration API",
            "# Migration API\n\n1. Inspecter.",
        )
        .unwrap();
        assert!(first.created);
        assert_eq!(first.relative_path, ".prime/plans/migration-api.md");
        let second = write_plan_document_in(
            temporary.path(),
            "plan_1234567890abcdef",
            "Migration API",
            "# Migration API\n\n1. Inspecter.",
        )
        .unwrap();
        assert!(!second.created);
        assert_eq!(second.relative_path, first.relative_path);
    }

    #[test]
    fn versions_changed_owned_documents_and_avoids_foreign_title_collisions() {
        let temporary = tempfile::tempdir().unwrap();
        write_plan_document_in(temporary.path(), "same-plan", "Plan", "# One").unwrap();
        let revised =
            write_plan_document_in(temporary.path(), "same-plan", "Plan", "# Two").unwrap();
        assert!(revised.created);
        assert_eq!(revised.relative_path, ".prime/plans/plan-2.md");
        let original = fs::read_to_string(temporary.path().join(".prime/plans/plan.md")).unwrap();
        let saved = fs::read_to_string(temporary.path().join(".prime/plans/plan-2.md")).unwrap();
        assert!(original.ends_with("# One\n"));
        assert!(saved.starts_with("<!-- prime-orbit-plan-id:same-plan -->\n"));
        assert!(saved.ends_with("# Two\n"));

        let collision =
            write_plan_document_in(temporary.path(), "other-plan", "Plan", "# Other").unwrap();
        assert!(collision.created);
        assert_eq!(collision.relative_path, ".prime/plans/plan-3.md");
        assert!(validate_markdown("  ").is_err());
        assert!(validate_markdown(&"x".repeat(512 * 1024 + 1)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_prime_directory() {
        use std::os::unix::fs::symlink;
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), project.path().join(".prime")).unwrap();
        assert!(write_plan_document_in(project.path(), "plan-1", "Plan", "# Plan").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_a_symlinked_prime_directory_when_supported() {
        use std::os::windows::fs::symlink_dir;
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        if symlink_dir(outside.path(), project.path().join(".prime")).is_ok() {
            assert!(write_plan_document_in(project.path(), "plan-1", "Plan", "# Plan").is_err());
        }
    }
}
