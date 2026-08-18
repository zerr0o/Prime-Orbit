use crate::{
    paths::canonicalize,
    runtime::{capture_command_output, external_command, find_program},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Output,
};

const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentData {
    pub path: String,
    pub name: String,
    pub mime_type: String,
    pub data_base64: String,
    pub size: u64,
    pub is_image: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub status: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangesResult {
    pub cwd: String,
    pub is_repository: bool,
    pub branch: Option<String>,
    pub files: Vec<GitChangedFile>,
    pub diff_stat: String,
    pub error: Option<String>,
}

fn regular_file(path: String) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("Le chemin de la pièce jointe doit être absolu".to_string());
    }
    let link_metadata = fs::symlink_metadata(&path).map_err(|error| {
        format!(
            "La pièce jointe {} est inaccessible: {error}",
            path.display()
        )
    })?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return Err(format!(
            "La pièce jointe {} doit être un fichier régulier non symbolique",
            path.display()
        ));
    }
    canonicalize(&path)
        .map_err(|error| format!("Impossible de résoudre {}: {error}", path.display()))
}

fn is_textual(mime_type: &str, path: &Path) -> bool {
    if mime_type.starts_with("text/") {
        return true;
    }
    if matches!(
        mime_type,
        "application/json"
            | "application/ld+json"
            | "application/javascript"
            | "application/xml"
            | "application/yaml"
            | "application/toml"
            | "application/sql"
    ) {
        return true;
    }
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "md" | "mdx"
            | "txt"
            | "rs"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "css"
            | "scss"
            | "html"
            | "xml"
            | "yaml"
            | "yml"
            | "toml"
            | "json"
            | "jsonl"
            | "py"
            | "go"
            | "java"
            | "kt"
            | "swift"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "cs"
            | "sh"
            | "ps1"
            | "sql"
            | "diff"
            | "patch"
    )
}

fn read_attachment_blocking(path: String) -> Result<AttachmentData, String> {
    let path = regular_file(path)?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Impossible d’inspecter {}: {error}", path.display()))?;
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "La pièce jointe fait {} octets; la limite est de {} octets (25 Mio)",
            metadata.len(),
            MAX_ATTACHMENT_BYTES
        ));
    }
    let data = fs::read(&path)
        .map_err(|error| format!("Impossible de lire {}: {error}", path.display()))?;
    let mime_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let is_image = mime_type.starts_with("image/");
    let text_preview = is_textual(&mime_type, &path).then(|| {
        let preview = &data[..data.len().min(MAX_TEXT_PREVIEW_BYTES)];
        let mut text = String::from_utf8_lossy(preview)
            .trim_start_matches('\u{feff}')
            .to_string();
        if data.len() > preview.len() {
            text.push_str("\n…");
        }
        text
    });
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .ok_or_else(|| "Le nom de la pièce jointe n’est pas représentable en UTF-8".to_string())?;
    Ok(AttachmentData {
        path: path.to_string_lossy().into_owned(),
        name,
        mime_type,
        data_base64: STANDARD.encode(data),
        size: metadata.len(),
        is_image,
        text_preview,
    })
}

#[tauri::command]
pub async fn read_attachment(path: String) -> Result<AttachmentData, String> {
    crate::run_blocking(move || read_attachment_blocking(path)).await
}

fn validated_git_cwd(cwd: String) -> Result<PathBuf, String> {
    let path = PathBuf::from(cwd);
    if !path.is_absolute() {
        return Err("Le chemin du projet Git doit être absolu".to_string());
    }
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Le projet {} est inaccessible: {error}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!("{} n’est pas un dossier", path.display()));
    }
    canonicalize(&path)
        .map_err(|error| format!("Impossible de résoudre {}: {error}", path.display()))
}

fn git_output(git: &Path, cwd: &Path, arguments: &[&str]) -> Result<Output, String> {
    let mut all_arguments = vec![OsString::from("-C"), cwd.as_os_str().to_owned()];
    all_arguments.extend(arguments.iter().map(OsString::from));
    let mut command = external_command(git, &all_arguments);
    capture_command_output(&mut command)
}

fn output_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn output_error(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("Git a quitté avec le statut {}", output.status)
    } else {
        stderr
    }
}

fn parse_porcelain_z(bytes: &[u8]) -> Vec<GitChangedFile> {
    let records: Vec<&[u8]> = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect();
    let mut files = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if record.len() < 3 {
            index += 1;
            continue;
        }
        let status = String::from_utf8_lossy(&record[..2]).into_owned();
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        let renamed_or_copied = status
            .as_bytes()
            .iter()
            .any(|byte| matches!(byte, b'R' | b'C'));
        let original_path = if renamed_or_copied && index + 1 < records.len() {
            index += 1;
            Some(String::from_utf8_lossy(records[index]).into_owned())
        } else {
            None
        };
        files.push(GitChangedFile {
            status,
            path,
            original_path,
        });
        index += 1;
    }
    files
}

fn list_git_changes_blocking(cwd: String) -> Result<GitChangesResult, String> {
    let cwd = validated_git_cwd(cwd)?;
    let base = || GitChangesResult {
        cwd: cwd.to_string_lossy().into_owned(),
        is_repository: false,
        branch: None,
        files: Vec::new(),
        diff_stat: String::new(),
        error: None,
    };
    let Some(git) = find_program("git") else {
        return Ok(GitChangesResult {
            error: Some("Git est introuvable dans PATH".to_string()),
            ..base()
        });
    };
    let repository = git_output(&git, &cwd, &["rev-parse", "--is-inside-work-tree"])?;
    if !repository.status.success() || output_text(&repository) != "true" {
        return Ok(GitChangesResult {
            error: Some("Ce dossier n’appartient pas à un dépôt Git".to_string()),
            ..base()
        });
    }

    let status = git_output(
        &git,
        &cwd,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    if !status.status.success() {
        return Ok(GitChangesResult {
            is_repository: true,
            error: Some(output_error(&status)),
            ..base()
        });
    }

    let branch_output = git_output(&git, &cwd, &["symbolic-ref", "--short", "HEAD"])?;
    let branch = if branch_output.status.success() {
        Some(output_text(&branch_output))
    } else {
        let detached = git_output(&git, &cwd, &["rev-parse", "--short", "HEAD"])?;
        detached
            .status
            .success()
            .then(|| format!("detached@{}", output_text(&detached)))
    };

    let unstaged = git_output(&git, &cwd, &["diff", "--stat", "--no-color", "--"])?;
    let staged = git_output(
        &git,
        &cwd,
        &["diff", "--cached", "--stat", "--no-color", "--"],
    )?;
    let mut errors = Vec::new();
    if !unstaged.status.success() {
        errors.push(format!("Diff non indexé: {}", output_error(&unstaged)));
    }
    if !staged.status.success() {
        errors.push(format!("Diff indexé: {}", output_error(&staged)));
    }
    let mut sections = Vec::new();
    let staged_text = output_text(&staged);
    let unstaged_text = output_text(&unstaged);
    if !staged_text.is_empty() {
        sections.push(format!("Indexé:\n{staged_text}"));
    }
    if !unstaged_text.is_empty() {
        sections.push(format!("Non indexé:\n{unstaged_text}"));
    }

    Ok(GitChangesResult {
        cwd: cwd.to_string_lossy().into_owned(),
        is_repository: true,
        branch,
        files: parse_porcelain_z(&status.stdout),
        diff_stat: sections.join("\n\n"),
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    })
}

#[tauri::command]
pub async fn list_git_changes(cwd: String) -> Result<GitChangesResult, String> {
    crate::run_blocking(move || list_git_changes_blocking(cwd)).await
}

#[cfg(test)]
mod tests {
    use super::parse_porcelain_z;

    #[test]
    fn parses_modified_renamed_and_untracked_records() {
        let files = parse_porcelain_z(b" M src/lib.rs\0R  new name.rs\0old name.rs\0?? note.md\0");
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, " M");
        assert_eq!(files[0].path, "src/lib.rs");
        assert_eq!(files[1].path, "new name.rs");
        assert_eq!(files[1].original_path.as_deref(), Some("old name.rs"));
        assert_eq!(files[2].status, "??");
        assert_eq!(files[2].path, "note.md");
    }
}
