use crate::storage::write_atomic;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Take},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const EXPORT_RESERVATION_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_HTML_EXPORT_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone)]
struct PendingHtmlExport {
    owner: String,
    conversation_id: String,
    output_path: PathBuf,
    destination: PathBuf,
    created_at: Instant,
    dispatched: bool,
}

#[derive(Clone, Default)]
pub struct HtmlExportState(Arc<Mutex<HashMap<String, PendingHtmlExport>>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlExportReservation {
    token: String,
    output_path: String,
}

#[derive(Debug, Serialize)]
pub struct HtmlExportResult {
    path: String,
}

fn safe_export_file_name(title: &str) -> String {
    let mut stem = String::with_capacity(title.len().min(96));
    let mut last_was_separator = false;

    for character in title.trim().chars().take(80) {
        let invalid = character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            );
        if invalid || character.is_whitespace() || character == '.' {
            if !stem.is_empty() && !last_was_separator {
                stem.push('-');
                last_was_separator = true;
            }
        } else {
            stem.push(character);
            last_was_separator = false;
        }
    }

    let trimmed = stem.trim_matches(|character: char| {
        character.is_whitespace() || character == '.' || character == '-'
    });
    let mut stem = if trimmed.is_empty() {
        "conversation-prime-orbit".to_string()
    } else {
        trimmed.to_string()
    };

    let uppercase = stem.to_ascii_uppercase();
    let reserved = matches!(uppercase.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (uppercase.len() == 4
            && (uppercase.starts_with("COM") || uppercase.starts_with("LPT"))
            && uppercase.as_bytes()[3].is_ascii_digit()
            && uppercase.as_bytes()[3] != b'0');
    if reserved {
        stem.insert_str(0, "conversation-");
    }

    format!("{stem}.html")
}

fn ensure_html_extension(mut path: PathBuf) -> Result<PathBuf, String> {
    if path.file_name().is_none() {
        return Err("La destination HTML ne contient aucun nom de fichier".to_string());
    }
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("html"))
    {
        return Ok(path);
    }

    let mut file_name = path
        .file_name()
        .ok_or_else(|| "La destination HTML ne contient aucun nom de fichier".to_string())?
        .to_os_string();
    file_name.push(".html");
    path.set_file_name(file_name);
    Ok(path)
}

fn validate_destination(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Le dialogue système a renvoyé une destination non absolue".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "La destination HTML ne possède aucun dossier parent".to_string())?;
    let parent_metadata = fs::metadata(parent).map_err(|error| {
        format!(
            "Le dossier de destination {} est inaccessible: {error}",
            parent.display()
        )
    })?;
    if !parent_metadata.is_dir() {
        return Err(format!("{} n’est pas un dossier", parent.display()));
    }
    if path.exists() {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("Impossible d’inspecter {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "La destination {} doit être un fichier régulier non symbolique",
                path.display()
            ));
        }
    }
    Ok(())
}

fn remove_expired_exports(exports: &mut HashMap<String, PendingHtmlExport>) {
    let expired = exports
        .iter()
        .filter(|(_, pending)| pending.created_at.elapsed() >= EXPORT_RESERVATION_TTL)
        .map(|(token, _)| token.clone())
        .collect::<Vec<_>>();
    for token in expired {
        if let Some(pending) = exports.remove(&token) {
            let _ = fs::remove_file(pending.output_path);
        }
    }
}

fn validated_conversation_id(conversation_id: String) -> Result<String, String> {
    let conversation_id = conversation_id.trim();
    if conversation_id.is_empty() {
        return Err("conversationId ne peut pas être vide".to_string());
    }
    if conversation_id.len() > 256 || conversation_id.chars().any(char::is_control) {
        return Err("conversationId contient des caractères invalides".to_string());
    }
    Ok(conversation_id.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn begin_html_export(
    window: tauri::WebviewWindow,
    exports: tauri::State<'_, HtmlExportState>,
    conversation_id: String,
    suggested_name: String,
) -> Result<Option<HtmlExportReservation>, String> {
    let conversation_id = validated_conversation_id(conversation_id)?;
    let suggested_name = safe_export_file_name(&suggested_name);
    let selected = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Prime Orbit — HTML")
        .set_file_name(suggested_name)
        .add_filter("HTML", &["html"])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let destination = ensure_html_extension(
        selected
            .into_path()
            .map_err(|error| format!("Destination HTML invalide: {error}"))?,
    )?;
    validate_destination(&destination)?;

    let token = Uuid::new_v4().to_string();
    let export_directory = window
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Impossible de résoudre le cache Prime Orbit: {error}"))?
        .join("html-exports");
    fs::create_dir_all(&export_directory).map_err(|error| {
        format!(
            "Impossible de préparer le cache d’export {}: {error}",
            export_directory.display()
        )
    })?;
    let output_path = export_directory.join(format!("{token}.html"));
    let owner = window.label().to_string();

    {
        let mut pending = exports.0.lock();
        remove_expired_exports(&mut pending);
        pending.insert(
            token.clone(),
            PendingHtmlExport {
                owner,
                conversation_id,
                output_path: output_path.clone(),
                destination,
                created_at: Instant::now(),
                dispatched: false,
            },
        );
    }

    Ok(Some(HtmlExportReservation {
        token,
        output_path: output_path.to_string_lossy().into_owned(),
    }))
}

/// Ensures the generic renderer-to-RPC bridge cannot turn `export_html` into
/// an arbitrary filesystem write. Every output path must originate from the
/// native save dialog and is scoped to the requesting window and conversation.
pub(crate) fn validate_export_rpc_payload(
    state: &HtmlExportState,
    owner: &str,
    conversation_id: &str,
    payload: &Value,
) -> Result<(), String> {
    if payload.get("type").and_then(Value::as_str) != Some("export_html") {
        return Ok(());
    }
    let output_path = payload
        .get("outputPath")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            "Choisissez la destination de l’export HTML depuis Prime Orbit.".to_string()
        })?;

    let mut exports = state.0.lock();
    remove_expired_exports(&mut exports);
    let pending = exports
        .values_mut()
        .find(|pending| pending.output_path == Path::new(output_path))
        .ok_or_else(|| "Cette destination d’export HTML n’a pas été autorisée.".to_string())?;
    if pending.owner != owner || pending.conversation_id != conversation_id {
        return Err(
            "Cette destination d’export HTML appartient à une autre fenêtre ou conversation."
                .to_string(),
        );
    }
    if pending.dispatched {
        return Err("Cet export HTML a déjà été envoyé à Prime Agent.".to_string());
    }
    pending.dispatched = true;
    Ok(())
}

fn read_validated_html(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Prime Agent n’a pas créé l’export HTML attendu: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("L’export généré doit être un fichier régulier non symbolique".to_string());
    }
    if metadata.len() == 0 {
        return Err("Prime Agent a généré un export HTML vide".to_string());
    }
    if metadata.len() > MAX_HTML_EXPORT_BYTES {
        return Err(format!(
            "L’export HTML dépasse la limite de {} Mio",
            MAX_HTML_EXPORT_BYTES / 1024 / 1024
        ));
    }

    let file = File::open(path)
        .map_err(|error| format!("Impossible de lire l’export HTML généré: {error}"))?;
    let mut limited: Take<File> = file.take(MAX_HTML_EXPORT_BYTES + 1);
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    limited
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Impossible de lire l’export HTML généré: {error}"))?;
    if bytes.len() as u64 > MAX_HTML_EXPORT_BYTES {
        return Err(format!(
            "L’export HTML dépasse la limite de {} Mio",
            MAX_HTML_EXPORT_BYTES / 1024 / 1024
        ));
    }

    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
    if !prefix.contains("<!doctype html") && !prefix.contains("<html") {
        return Err("Prime Agent n’a pas renvoyé un document HTML valide".to_string());
    }
    Ok(bytes)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn complete_html_export(
    window: tauri::WebviewWindow,
    exports: tauri::State<'_, HtmlExportState>,
    token: String,
) -> Result<HtmlExportResult, String> {
    let owner = window.label().to_string();
    let pending = {
        let mut exports = exports.0.lock();
        remove_expired_exports(&mut exports);
        let pending = exports
            .remove(&token)
            .ok_or_else(|| "Cette réservation d’export HTML a expiré.".to_string())?;
        if pending.owner != owner {
            exports.insert(token, pending);
            return Err(
                "Cette réservation d’export HTML appartient à une autre fenêtre.".to_string(),
            );
        }
        pending
    };

    let output_path = pending.output_path.clone();
    let result = crate::run_blocking(move || {
        if !pending.dispatched {
            return Err("L’export HTML n’a pas été envoyé à Prime Agent.".to_string());
        }
        let bytes = read_validated_html(&pending.output_path)?;
        validate_destination(&pending.destination)?;
        write_atomic(&pending.destination, &bytes)?;
        Ok(HtmlExportResult {
            path: pending.destination.to_string_lossy().into_owned(),
        })
    })
    .await;
    let _ = fs::remove_file(output_path);
    result
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cancel_html_export(
    window: tauri::WebviewWindow,
    exports: tauri::State<'_, HtmlExportState>,
    token: String,
) -> Result<(), String> {
    let owner = window.label().to_string();
    let pending = {
        let mut exports = exports.0.lock();
        let Some(pending) = exports.get(&token) else {
            return Ok(());
        };
        if pending.owner != owner {
            return Err(
                "Cette réservation d’export HTML appartient à une autre fenêtre.".to_string(),
            );
        }
        exports.remove(&token)
    };
    if let Some(pending) = pending {
        let _ = fs::remove_file(pending.output_path);
    }
    Ok(())
}

pub fn release_window_exports(state: HtmlExportState, owner: &str) {
    let removed = {
        let mut exports = state.0.lock();
        let tokens = exports
            .iter()
            .filter(|(_, pending)| pending.owner == owner)
            .map(|(token, _)| token.clone())
            .collect::<Vec<_>>();
        tokens
            .into_iter()
            .filter_map(|token| exports.remove(&token))
            .collect::<Vec<_>>()
    };
    for pending in removed {
        let _ = fs::remove_file(pending.output_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn safe_name_removes_path_and_windows_metacharacters() {
        assert_eq!(
            safe_export_file_name("  Audit: ../projet * final?  "),
            "Audit-projet-final.html"
        );
        assert_eq!(safe_export_file_name("CON"), "conversation-CON.html");
        assert_eq!(
            safe_export_file_name("..."),
            "conversation-prime-orbit.html"
        );
    }

    #[test]
    fn html_extension_is_appended_without_hiding_user_text() {
        assert_eq!(
            ensure_html_extension(PathBuf::from("C:/Exports/session.txt")).unwrap(),
            PathBuf::from("C:/Exports/session.txt.html")
        );
        assert_eq!(
            ensure_html_extension(PathBuf::from("C:/Exports/session.HTML")).unwrap(),
            PathBuf::from("C:/Exports/session.HTML")
        );
    }

    #[test]
    fn export_rpc_requires_matching_native_reservation() {
        let state = HtmlExportState::default();
        state.0.lock().insert(
            "token".to_string(),
            PendingHtmlExport {
                owner: "main".to_string(),
                conversation_id: "conversation-1".to_string(),
                output_path: PathBuf::from("C:/cache/token.html"),
                destination: PathBuf::from("C:/exports/session.html"),
                created_at: Instant::now(),
                dispatched: false,
            },
        );

        let arbitrary = json!({ "type": "export_html", "outputPath": "C:/arbitrary.html" });
        assert!(
            validate_export_rpc_payload(&state, "main", "conversation-1", &arbitrary)
                .unwrap_err()
                .contains("pas été autorisée")
        );

        let reserved = json!({ "type": "export_html", "outputPath": "C:/cache/token.html" });
        validate_export_rpc_payload(&state, "main", "conversation-1", &reserved).unwrap();
        assert!(
            validate_export_rpc_payload(&state, "main", "conversation-1", &reserved)
                .unwrap_err()
                .contains("déjà été envoyé")
        );
    }

    #[test]
    fn unrelated_rpc_payload_is_untouched() {
        let state = HtmlExportState::default();
        validate_export_rpc_payload(
            &state,
            "main",
            "conversation-1",
            &json!({ "type": "get_state" }),
        )
        .unwrap();
    }
}
