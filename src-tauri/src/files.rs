use crate::{
    paths::canonicalize,
    runtime::{capture_command_output, external_command, find_program},
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use image::ImageFormat;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    fs::{self, File},
    io::{BufRead, BufReader, Cursor, Read},
    path::{Component, Path, PathBuf},
    process::{ExitStatus, Output, Stdio},
    sync::{Arc, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime},
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, WebviewWindow,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

const MAX_IMAGE_ATTACHMENT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_DOCUMENT_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES: u64 = 40 * 1024 * 1024;
const MAX_INLINE_DOCUMENT_BYTES: usize = 1024 * 1024;
const MAX_ATTACHMENT_COUNT: usize = 20;
const MAX_ORBIT_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_ORBIT_MANIFEST_ENCODED_CHARS: usize = 87_382;
const MAX_ATTACHMENT_NAME_BYTES: usize = 2_048;
const MAX_ATTACHMENT_MIME_BYTES: usize = 256;
const MAX_OWNER_CACHED_ATTACHMENT_BYTES: u64 = 40 * 1024 * 1024;
const MAX_OWNER_CACHED_ATTACHMENT_COUNT: usize = 80;
const MAX_CACHED_ATTACHMENT_BYTES: u64 = 160 * 1024 * 1024;
const MAX_CACHED_ATTACHMENT_COUNT: usize = 320;
const CACHED_ATTACHMENT_TTL: Duration = Duration::from_secs(30 * 60);
const FALLBACK_ARTIFACT_TTL: Duration = Duration::from_secs(90 * 24 * 60 * 60);
const FALLBACK_ARTIFACT_ACTIVE_GRACE: Duration = Duration::from_secs(24 * 60 * 60);
const FALLBACK_ARTIFACT_CLEANUP_INTERVAL: Duration = Duration::from_secs(10 * 60);
const MAX_FALLBACK_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_FALLBACK_ARTIFACT_CONVERSATIONS: usize = 256;
const MAX_FALLBACK_ARTIFACT_ENTRIES: usize = 20_000;
const MAX_GIT_DIFF_BYTES: usize = 192 * 1024;
const MAX_GIT_ERROR_BYTES: usize = 32 * 1024;
const MAX_UNTRACKED_STAT_BYTES: u64 = 2 * 1024 * 1024;

fn supported_inline_image(mime_type: &str) -> bool {
    matches!(
        mime_type,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentData {
    pub name: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment_handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_data_url: Option<String>,
    pub size: u64,
    pub is_image: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicAttachmentMetadata {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub is_image: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OrbitAttachmentContext {
    pub context_id: String,
    pub visible_text: String,
    pub attachments: Vec<PublicAttachmentMetadata>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentManifestEntry {
    name: String,
    mime_type: String,
    size: u64,
    is_image: bool,
}

#[derive(Clone)]
pub struct AttachmentCache(Arc<Mutex<AttachmentCacheInner>>);

impl Default for AttachmentCache {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(AttachmentCacheInner {
            attachments: HashMap::new(),
            total_bytes: 0,
        })))
    }
}

struct AttachmentCacheInner {
    attachments: HashMap<String, CachedAttachment>,
    total_bytes: u64,
}

struct CachedAttachment {
    owner: String,
    name: String,
    mime_type: String,
    bytes: Vec<u8>,
    is_image: bool,
    inserted_at: Instant,
    reserved: bool,
}

#[derive(Debug)]
struct PreparedAttachment {
    name: String,
    mime_type: String,
    bytes: Vec<u8>,
    preview_data_url: Option<String>,
    is_image: bool,
}

pub(crate) struct AttachmentReservation {
    cache: AttachmentCache,
    owner: String,
    handles: Vec<String>,
    staged_directories: Vec<PathBuf>,
    staging_context: Option<PathBuf>,
    committed: bool,
}

impl AttachmentReservation {
    pub(crate) fn commit(mut self) {
        self.cache
            .finish_reservation(&self.owner, &self.handles, true);
        self.committed = true;
    }
}

impl Drop for AttachmentReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.cache
                .finish_reservation(&self.owner, &self.handles, false);
            if let Some(context) = self.staging_context.as_ref() {
                let _ = fs::remove_dir_all(context);
            } else {
                for directory in &self.staged_directories {
                    let _ = fs::remove_dir_all(directory);
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub status: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffResult {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub patch: String,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Debug, Default, Clone, Copy)]
struct GitFileStat {
    additions: u64,
    deletions: u64,
    binary: bool,
}

impl GitFileStat {
    fn merge(&mut self, other: Self) {
        self.additions = self.additions.saturating_add(other.additions);
        self.deletions = self.deletions.saturating_add(other.deletions);
        self.binary |= other.binary;
    }
}

struct LimitedOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
}

fn regular_file(path: PathBuf) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Le chemin de la pièce jointe doit être absolu".to_string());
    }
    let link_metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("La pièce jointe sélectionnée est inaccessible: {error}"))?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return Err(
            "La pièce jointe sélectionnée doit être un fichier régulier non symbolique".to_string(),
        );
    }
    canonicalize(&path)
        .map_err(|error| format!("Impossible de résoudre la pièce jointe sélectionnée: {error}"))
}

fn image_signature_matches(mime_type: &str, bytes: &[u8]) -> bool {
    match mime_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

pub(crate) fn image_preview_data_url(mime_type: &str, bytes: &[u8]) -> Result<String, String> {
    let format = match mime_type {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::WebP,
        _ => return Err("Format d’image non pris en charge".to_string()),
    };
    let source = image::load_from_memory_with_format(bytes, format)
        .map_err(|error| format!("Impossible de décoder l’image: {error}"))?;
    let thumbnail = source.thumbnail(320, 220);
    let mut encoded = Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut encoded, ImageFormat::Png)
        .map_err(|error| format!("Impossible de créer l’aperçu de l’image: {error}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(encoded.into_inner())
    ))
}

fn read_selected_attachment(
    path: PathBuf,
    remaining_attachment_bytes: u64,
    remaining_image_bytes: u64,
) -> Result<PreparedAttachment, String> {
    let path = regular_file(path)?;
    let mime_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let is_image = supported_inline_image(&mime_type);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .ok_or_else(|| "Le nom de la pièce jointe n’est pas représentable en UTF-8".to_string())?;
    if name.is_empty() || name.chars().any(char::is_control) {
        return Err("Le nom de la pièce jointe sélectionnée est invalide.".to_string());
    }

    // Open once, then derive both the real byte count and the cached content
    // from that same handle. A bounded max+1 read detects a file that grew
    // after metadata inspection without ever allocating unbounded memory.
    let per_file_limit = if is_image {
        MAX_IMAGE_ATTACHMENT_BYTES
    } else {
        MAX_DOCUMENT_ATTACHMENT_BYTES
    };
    let allowed_bytes = if is_image {
        per_file_limit
            .min(remaining_attachment_bytes)
            .min(remaining_image_bytes)
    } else {
        per_file_limit.min(remaining_attachment_bytes)
    };
    let file = File::open(&path)
        .map_err(|error| format!("Impossible de lire la pièce jointe {name}: {error}"))?;
    let declared_size = file
        .metadata()
        .map_err(|error| format!("Impossible d’inspecter la pièce jointe {name}: {error}"))?
        .len();
    if declared_size > allowed_bytes {
        return Err(format!(
            "La pièce jointe fait {declared_size} octets; elle dépasse le budget restant de {allowed_bytes} octets"
        ));
    }
    let mut bytes = Vec::with_capacity(declared_size.min(allowed_bytes) as usize);
    file.take(allowed_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Impossible de lire la pièce jointe {name}: {error}"))?;
    if bytes.len() as u64 > allowed_bytes {
        return Err(format!(
            "La pièce jointe dépasse le budget restant de {allowed_bytes} octets"
        ));
    }
    if is_image && !image_signature_matches(&mime_type, &bytes) {
        return Err(format!(
            "La pièce jointe {name} ne contient pas une image {mime_type} valide"
        ));
    }
    let preview_data_url = is_image
        .then(|| image_preview_data_url(&mime_type, &bytes))
        .transpose()?;
    Ok(PreparedAttachment {
        name,
        mime_type,
        bytes,
        preview_data_url,
        is_image,
    })
}

fn prepare_attachment_paths(
    paths: Vec<PathBuf>,
    remaining_count: usize,
    remaining_attachment_bytes: u64,
    remaining_image_bytes: u64,
) -> Result<Vec<PreparedAttachment>, String> {
    if remaining_count > MAX_ATTACHMENT_COUNT
        || remaining_attachment_bytes > MAX_TOTAL_ATTACHMENT_BYTES
        || remaining_image_bytes > MAX_TOTAL_IMAGE_BYTES
    {
        return Err("Le budget de pièces jointes demandé est invalide.".to_string());
    }
    if paths.len() > remaining_count {
        return Err(format!(
            "Vous pouvez encore joindre {remaining_count} fichier(s)."
        ));
    }

    let mut prepared = Vec::with_capacity(paths.len());
    let mut total_attachment_bytes = 0_u64;
    let mut total_image_bytes = 0_u64;
    for path in paths {
        let available = remaining_attachment_bytes.saturating_sub(total_attachment_bytes);
        let available_images = remaining_image_bytes.saturating_sub(total_image_bytes);
        let attachment = read_selected_attachment(path, available, available_images)?;
        total_attachment_bytes =
            total_attachment_bytes.saturating_add(attachment.bytes.len() as u64);
        if attachment.is_image {
            total_image_bytes = total_image_bytes.saturating_add(attachment.bytes.len() as u64);
        }
        if total_attachment_bytes > remaining_attachment_bytes {
            return Err(
                "Le total des pièces jointes dépasse 40 Mio; réduisez leur taille ou leur nombre"
                    .to_string(),
            );
        }
        if total_image_bytes > remaining_image_bytes {
            return Err("Le total des images jointes dépasse 10 Mio.".to_string());
        }
        prepared.push(attachment);
    }
    Ok(prepared)
}

fn purge_expired(inner: &mut AttachmentCacheInner, now: Instant) {
    let expired = inner
        .attachments
        .iter()
        .filter(|(_, attachment)| {
            !attachment.reserved
                && now.duration_since(attachment.inserted_at) >= CACHED_ATTACHMENT_TTL
        })
        .map(|(handle, _)| handle.clone())
        .collect::<Vec<_>>();
    for handle in expired {
        if let Some(attachment) = inner.attachments.remove(&handle) {
            inner.total_bytes = inner
                .total_bytes
                .saturating_sub(attachment.bytes.len() as u64);
        }
    }
}

impl AttachmentCache {
    fn insert_prepared(
        &self,
        owner: &str,
        prepared: Vec<PreparedAttachment>,
    ) -> Result<Vec<AttachmentData>, String> {
        let new_count = prepared.len();
        let new_bytes = prepared.iter().fold(0_u64, |total, attachment| {
            total.saturating_add(attachment.bytes.len() as u64)
        });
        let now = Instant::now();
        let mut inner = self.0.lock();
        purge_expired(&mut inner, now);
        let owner_count = inner
            .attachments
            .values()
            .filter(|attachment| attachment.owner == owner)
            .count();
        let owner_bytes = inner
            .attachments
            .values()
            .filter(|attachment| attachment.owner == owner)
            .fold(0_u64, |total, attachment| {
                total.saturating_add(attachment.bytes.len() as u64)
            });
        if owner_count.saturating_add(new_count) > MAX_OWNER_CACHED_ATTACHMENT_COUNT
            || owner_bytes.saturating_add(new_bytes) > MAX_OWNER_CACHED_ATTACHMENT_BYTES
        {
            return Err(
                "Le cache sécurisé de cette fenêtre est plein. Envoyez ou retirez des fichiers avant d’en joindre d’autres."
                    .to_string(),
            );
        }
        if inner.attachments.len().saturating_add(new_count) > MAX_CACHED_ATTACHMENT_COUNT
            || inner.total_bytes.saturating_add(new_bytes) > MAX_CACHED_ATTACHMENT_BYTES
        {
            return Err(
                "Le cache sécurisé des pièces jointes est plein. Envoyez ou retirez des fichiers avant d’en joindre d’autres."
                    .to_string(),
            );
        }

        let mut result = Vec::with_capacity(prepared.len());
        for attachment in prepared {
            let size = attachment.bytes.len() as u64;
            let handle = Uuid::new_v4().to_string();
            result.push(AttachmentData {
                name: attachment.name.clone(),
                mime_type: attachment.mime_type.clone(),
                attachment_handle: Some(handle.clone()),
                preview_data_url: attachment.preview_data_url,
                size,
                is_image: attachment.is_image,
            });
            inner.total_bytes = inner.total_bytes.saturating_add(size);
            inner.attachments.insert(
                handle,
                CachedAttachment {
                    owner: owner.to_string(),
                    name: attachment.name,
                    mime_type: attachment.mime_type,
                    bytes: attachment.bytes,
                    is_image: attachment.is_image,
                    inserted_at: now,
                    reserved: false,
                },
            );
        }
        Ok(result)
    }

    fn reserve_attachments(
        &self,
        owner: &str,
        handles: &[String],
    ) -> Result<Vec<ResolvedAttachment>, String> {
        let mut inner = self.0.lock();
        purge_expired(&mut inner, Instant::now());
        let mut total_bytes = 0_u64;
        let mut total_image_bytes = 0_u64;
        for handle in handles {
            let attachment = inner.attachments.get(handle).ok_or_else(|| {
                "Une pièce jointe a expiré ou n’est plus disponible. Sélectionnez-la de nouveau."
                    .to_string()
            })?;
            if attachment.owner != owner {
                return Err("Cette pièce jointe appartient à une autre fenêtre.".to_string());
            }
            if attachment.reserved {
                return Err("Cette pièce jointe est déjà en cours d’envoi.".to_string());
            }
            total_bytes = total_bytes.saturating_add(attachment.bytes.len() as u64);
            if attachment.is_image {
                total_image_bytes = total_image_bytes.saturating_add(attachment.bytes.len() as u64);
            }
        }
        if total_bytes > MAX_TOTAL_ATTACHMENT_BYTES {
            return Err("Le total des pièces jointes dépasse 40 Mio.".to_string());
        }
        if total_image_bytes > MAX_TOTAL_IMAGE_BYTES {
            return Err("Le total des images jointes dépasse 10 Mio.".to_string());
        }
        let resolved = handles
            .iter()
            .map(|handle| {
                let attachment = inner
                    .attachments
                    .get_mut(handle)
                    .expect("validated attachment handle");
                attachment.reserved = true;
                ResolvedAttachment {
                    name: attachment.name.clone(),
                    mime_type: attachment.mime_type.clone(),
                    bytes: attachment.bytes.clone(),
                    is_image: attachment.is_image,
                }
            })
            .collect();
        Ok(resolved)
    }

    fn finish_reservation(&self, owner: &str, handles: &[String], consume: bool) {
        let mut inner = self.0.lock();
        for handle in handles {
            if consume {
                let removable = inner
                    .attachments
                    .get(handle)
                    .is_some_and(|attachment| attachment.owner == owner && attachment.reserved);
                if removable {
                    if let Some(attachment) = inner.attachments.remove(handle) {
                        inner.total_bytes = inner
                            .total_bytes
                            .saturating_sub(attachment.bytes.len() as u64);
                    }
                }
            } else if let Some(attachment) = inner.attachments.get_mut(handle) {
                if attachment.owner == owner {
                    attachment.reserved = false;
                }
            }
        }
    }

    fn release(&self, owner: &str, handles: &[String]) {
        let mut inner = self.0.lock();
        for handle in handles {
            let removable = inner
                .attachments
                .get(handle)
                .is_some_and(|attachment| attachment.owner == owner && !attachment.reserved);
            if removable {
                if let Some(attachment) = inner.attachments.remove(handle) {
                    inner.total_bytes = inner
                        .total_bytes
                        .saturating_sub(attachment.bytes.len() as u64);
                }
            }
        }
    }

    fn release_owner(&self, owner: &str) {
        let mut inner = self.0.lock();
        let handles = inner
            .attachments
            .iter()
            .filter(|(_, attachment)| attachment.owner == owner)
            .map(|(handle, _)| handle.clone())
            .collect::<Vec<_>>();
        for handle in handles {
            if let Some(attachment) = inner.attachments.remove(&handle) {
                inner.total_bytes = inner
                    .total_bytes
                    .saturating_sub(attachment.bytes.len() as u64);
            }
        }
    }
}

#[derive(Debug)]
struct ResolvedAttachment {
    name: String,
    mime_type: String,
    bytes: Vec<u8>,
    is_image: bool,
}

fn parse_attachment_handles(
    payload: &Value,
    field: &str,
    unique: &mut HashSet<String>,
) -> Result<Vec<String>, String> {
    let Some(value) = payload.get(field) else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .ok_or_else(|| format!("Le champ {field} doit être une liste."))?;
    let mut handles = Vec::with_capacity(items.len());
    for item in items {
        let handle = item
            .as_object()
            .and_then(|object| object.get("attachmentHandle"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Une pièce jointe ne possède pas de handle sécurisé.".to_string())?;
        if Uuid::parse_str(handle).is_err() || !unique.insert(handle.to_string()) {
            return Err("Un handle de pièce jointe est invalide ou dupliqué.".to_string());
        }
        handles.push(handle.to_string());
    }
    Ok(handles)
}

fn escape_file_name(name: &str) -> String {
    name.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn utf8_index_at_utf16_offset(value: &str, wanted: usize) -> Option<usize> {
    let mut offset = 0_usize;
    for (index, character) in value.char_indices() {
        if offset == wanted {
            return Some(index);
        }
        offset = offset.checked_add(character.len_utf16())?;
        if offset > wanted {
            return None;
        }
    }
    (offset == wanted).then_some(value.len())
}

fn valid_manifest_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ATTACHMENT_NAME_BYTES
        && !value.contains(['/', '\\'])
        && !value.chars().any(char::is_control)
}

fn valid_manifest_mime(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ATTACHMENT_MIME_BYTES
        && !value.chars().any(char::is_control)
}

fn attachment_fragments_match_manifest(
    mut fragments: &str,
    manifest: &[AttachmentManifestEntry],
) -> bool {
    for (index, attachment) in manifest.iter().enumerate() {
        let opener = format!(
            "<file name=\"{}\" content_utf16=\"",
            escape_file_name(&attachment.name)
        );
        let Some(after_opener) = fragments.strip_prefix(&opener) else {
            return false;
        };
        let Some((encoded_length, body)) = after_opener.split_once("\">\n") else {
            return false;
        };
        let Ok(content_utf16) = encoded_length.parse::<usize>() else {
            return false;
        };
        if content_utf16.to_string() != encoded_length || content_utf16 > crate::MAX_RPC_BYTES {
            return false;
        }
        let Some(body_end) = utf8_index_at_utf16_offset(body, content_utf16) else {
            return false;
        };
        let Some(after_fragment) = body
            .get(body_end..)
            .and_then(|value| value.strip_prefix("\n</file>"))
        else {
            return false;
        };
        if index + 1 == manifest.len() {
            return after_fragment.is_empty();
        }
        let Some(next_fragment) = after_fragment.strip_prefix('\n') else {
            return false;
        };
        fragments = next_fragment;
    }
    false
}

/// Parses the exact suffix emitted by `hydrate_prompt_attachments` and returns
/// only renderer-safe data. The byte-heavy file fragments and native staging
/// paths deliberately never appear in the result.
pub(crate) fn parse_orbit_attachment_context(value: &str) -> Option<OrbitAttachmentContext> {
    const BOUNDARY_PREFIX: &str = "<prime_orbit_ui_boundary v=\"1\" id=\"";
    const VISIBLE_MARKER: &str = "\" visible_utf16=\"";
    const CONTEXT_CLOSE: &str = "\n</prime_orbit_attachment_context>\n";
    const MANIFEST_PREFIX: &str = "<prime_orbit_manifest encoding=\"base64url\">";
    const MANIFEST_CLOSE: &str = "</prime_orbit_manifest>\n";

    let boundary_start = value.rfind(BOUNDARY_PREFIX)?;
    let boundary = &value[boundary_start..];
    let boundary_fields = boundary.strip_prefix(BOUNDARY_PREFIX)?.strip_suffix("/>")?;
    let (context_id, visible) = boundary_fields.split_once(VISIBLE_MARKER)?;
    let visible = visible.strip_suffix('"')?;
    let uuid = Uuid::parse_str(context_id).ok()?;
    if uuid.get_version_num() != 4 || uuid.to_string() != context_id {
        return None;
    }
    let visible_utf16 = visible.parse::<usize>().ok()?;
    let visible_byte_index = utf8_index_at_utf16_offset(value, visible_utf16)?;
    if visible_byte_index > boundary_start {
        return None;
    }
    let expected_boundary =
        format!("{BOUNDARY_PREFIX}{context_id}{VISIBLE_MARKER}{visible_utf16}\"/>");
    if boundary != expected_boundary {
        return None;
    }

    let separator = if visible_utf16 == 0 { "" } else { "\n\n" };
    let opener =
        format!("{separator}<prime_orbit_attachment_context v=\"1\" id=\"{context_id}\">\n");
    let suffix = &value[visible_byte_index..];
    if !suffix.starts_with(&opener) {
        return None;
    }
    let context_body = value
        .get(visible_byte_index + opener.len()..boundary_start)?
        .strip_suffix(CONTEXT_CLOSE)?;
    let manifest_and_fragments = context_body.strip_prefix(MANIFEST_PREFIX)?;
    let manifest_end = manifest_and_fragments.find(MANIFEST_CLOSE)?;
    let encoded_manifest = &manifest_and_fragments[..manifest_end];
    if encoded_manifest.is_empty()
        || encoded_manifest.len() > MAX_ORBIT_MANIFEST_ENCODED_CHARS
        || !encoded_manifest
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    let fragments = &manifest_and_fragments[manifest_end + MANIFEST_CLOSE.len()..];

    let manifest_bytes = URL_SAFE_NO_PAD.decode(encoded_manifest).ok()?;
    if manifest_bytes.len() > MAX_ORBIT_MANIFEST_BYTES
        || URL_SAFE_NO_PAD.encode(&manifest_bytes) != encoded_manifest
    {
        return None;
    }
    let manifest = serde_json::from_slice::<Vec<AttachmentManifestEntry>>(&manifest_bytes).ok()?;
    if manifest.is_empty() || manifest.len() > MAX_ATTACHMENT_COUNT {
        return None;
    }
    let manifest_total = manifest.iter().try_fold(0_u64, |total, attachment| {
        total.checked_add(attachment.size)
    })?;
    if manifest_total > MAX_TOTAL_ATTACHMENT_BYTES {
        return None;
    }
    if manifest.iter().any(|attachment| {
        attachment.is_image
            || attachment.size > MAX_DOCUMENT_ATTACHMENT_BYTES
            || !valid_manifest_name(&attachment.name)
            || !valid_manifest_mime(&attachment.mime_type)
    }) || !attachment_fragments_match_manifest(fragments, &manifest)
    {
        return None;
    }
    let attachments = manifest
        .into_iter()
        .enumerate()
        .map(|(index, attachment)| PublicAttachmentMetadata {
            id: format!("orbit-attachment:{context_id}:{index}"),
            name: attachment.name,
            mime_type: attachment.mime_type,
            size: attachment.size,
            is_image: false,
        })
        .collect();

    Some(OrbitAttachmentContext {
        context_id: context_id.to_string(),
        visible_text: value[..visible_byte_index].to_string(),
        attachments,
    })
}

fn neutral_staging_extension(name: &str) -> Option<String> {
    let extension = Path::new(name).extension()?.to_str()?;
    (!extension.is_empty()
        && extension.len() <= 16
        && extension
            .chars()
            .all(|character| character.is_ascii_alphanumeric()))
    .then(|| extension.to_ascii_lowercase())
}

fn safe_artifact_component(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_')))
    .then(|| value.to_string())
}

fn safe_session_id_from_header(session_path: &Path) -> Option<String> {
    const MAX_SESSION_HEADER_BYTES: u64 = 64 * 1024;
    let file = File::open(session_path).ok()?;
    let mut reader = BufReader::new(file).take(MAX_SESSION_HEADER_BYTES + 1);
    let mut first_line = String::new();
    reader.read_line(&mut first_line).ok()?;
    if first_line.len() as u64 > MAX_SESSION_HEADER_BYTES {
        return None;
    }
    let header: Value = serde_json::from_str(first_line.trim_end()).ok()?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    safe_artifact_component(header.get("id").and_then(Value::as_str)?)
}

pub(crate) fn attachment_artifact_root(
    session_path: Option<&str>,
    session_id: Option<&str>,
    app_data_dir: &Path,
    conversation_id: &str,
) -> PathBuf {
    if let Some(session_path) = session_path.map(Path::new) {
        let exact_session_id = session_id
            .and_then(safe_artifact_component)
            .or_else(|| safe_session_id_from_header(session_path));
        if let (Some(session_id), Some(session_dir)) = (exact_session_id, session_path.parent()) {
            if let Some(session_root) = session_dir.parent() {
                return session_root
                    .join("session-artifacts")
                    .join(session_id)
                    .join("prime-orbit-attachments");
            }
        }
    }

    // A new RPC session may not have published its file yet. Hash the renderer
    // identifier before using it as a filesystem component and keep this
    // fallback durable so paths already persisted in Prime Agent history stay
    // valid across Orbit restarts.
    cleanup_fallback_attachment_artifacts_throttled(app_data_dir);
    let digest = Sha256::digest(conversation_id.as_bytes());
    let key = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    app_data_dir
        .join("session-attachments")
        .join(key)
        .join("prime-orbit-attachments")
}

#[derive(Debug)]
struct FallbackArtifactCandidate {
    path: PathBuf,
    bytes: u64,
    updated_at: SystemTime,
}

fn orbit_owned_directory_stats(root: &Path) -> Option<(u64, SystemTime)> {
    let mut stack = vec![root.to_path_buf()];
    let mut entries = 0_usize;
    let mut bytes = 0_u64;
    let mut updated_at = fs::symlink_metadata(root).ok()?.modified().ok()?;
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(directory).ok()? {
            let entry = entry.ok()?;
            entries = entries.checked_add(1)?;
            if entries > MAX_FALLBACK_ARTIFACT_ENTRIES {
                return None;
            }
            let metadata = fs::symlink_metadata(entry.path()).ok()?;
            if metadata.file_type().is_symlink() {
                return None;
            }
            if let Ok(modified) = metadata.modified() {
                updated_at = updated_at.max(modified);
            }
            if metadata.is_dir() {
                stack.push(entry.path());
            } else if metadata.is_file() {
                bytes = bytes.checked_add(metadata.len())?;
            } else {
                return None;
            }
        }
    }
    Some((bytes, updated_at))
}

fn prune_fallback_attachment_artifacts(
    app_data_dir: &Path,
    now: SystemTime,
    ttl: Duration,
    active_grace: Duration,
    max_bytes: u64,
    max_conversations: usize,
) -> Result<usize, String> {
    let root = app_data_dir.join("session-attachments");
    let metadata = match fs::symlink_metadata(&root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => {
            return Err(format!(
                "Impossible d’inspecter les pièces jointes Orbit obsolètes: {error}"
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Le stockage de secours des pièces jointes Orbit n’est pas sûr.".to_string());
    }
    let root = canonicalize(&root)
        .map_err(|error| format!("Impossible de sécuriser le stockage Orbit: {error}"))?;
    let mut candidates = Vec::new();
    for entry in fs::read_dir(&root)
        .map_err(|error| format!("Impossible de lire le stockage Orbit: {error}"))?
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.len() != 64
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let Ok(path) = canonicalize(&path) else {
            continue;
        };
        if path.parent() != Some(root.as_path()) {
            continue;
        }
        let Some((bytes, updated_at)) = orbit_owned_directory_stats(&path) else {
            continue;
        };
        candidates.push(FallbackArtifactCandidate {
            path,
            bytes,
            updated_at,
        });
    }
    candidates.sort_by_key(|candidate| candidate.updated_at);
    let mut total_bytes = candidates.iter().fold(0_u64, |total, candidate| {
        total.saturating_add(candidate.bytes)
    });
    let mut retained = candidates.len();
    let mut removed = 0_usize;
    for candidate in candidates {
        let age = now.duration_since(candidate.updated_at).unwrap_or_default();
        let expired = age >= ttl;
        let over_budget = total_bytes > max_bytes || retained > max_conversations;
        if !expired && (!over_budget || age < active_grace) {
            continue;
        }
        if fs::remove_dir_all(&candidate.path).is_ok() {
            total_bytes = total_bytes.saturating_sub(candidate.bytes);
            retained = retained.saturating_sub(1);
            removed = removed.saturating_add(1);
        }
    }
    Ok(removed)
}

pub(crate) fn cleanup_fallback_attachment_artifacts_throttled(app_data_dir: &Path) {
    static LAST_CLEANUP: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    let now = Instant::now();
    let cleanup = LAST_CLEANUP.get_or_init(|| Mutex::new(None));
    {
        let mut last = cleanup.lock();
        if last.is_some_and(|last| now.duration_since(last) < FALLBACK_ARTIFACT_CLEANUP_INTERVAL) {
            return;
        }
        *last = Some(now);
    }
    let _ = prune_fallback_attachment_artifacts(
        app_data_dir,
        SystemTime::now(),
        FALLBACK_ARTIFACT_TTL,
        FALLBACK_ARTIFACT_ACTIVE_GRACE,
        MAX_FALLBACK_ARTIFACT_BYTES,
        MAX_FALLBACK_ARTIFACT_CONVERSATIONS,
    );
}

pub(crate) fn remove_staged_attachment_context(
    artifact_root: &Path,
    context_id: &str,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(context_id)
        .ok()
        .filter(|uuid| uuid.get_version_num() == 4 && uuid.to_string() == context_id)
        .ok_or_else(|| "Identifiant de contexte de pièce jointe invalide.".to_string())?;
    let metadata = match fs::symlink_metadata(artifact_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Impossible d’inspecter le stockage des pièces jointes: {error}"
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Le stockage des pièces jointes n’est pas un dossier Orbit sûr.".to_string());
    }
    let root = canonicalize(artifact_root)
        .map_err(|error| format!("Impossible de sécuriser le stockage Orbit: {error}"))?;
    let target = root.join(uuid.to_string());
    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Impossible d’inspecter le contexte de pièce jointe: {error}"
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Le contexte de pièce jointe n’est pas un dossier Orbit sûr.".to_string());
    }
    let canonical_target = canonicalize(&target)
        .map_err(|error| format!("Impossible de sécuriser le contexte Orbit: {error}"))?;
    if canonical_target.parent() != Some(root.as_path())
        || canonical_target
            .file_name()
            .and_then(|value| value.to_str())
            != Some(context_id)
    {
        return Err("Le contexte de pièce jointe sort du stockage Orbit autorisé.".to_string());
    }
    fs::remove_dir_all(&canonical_target)
        .map_err(|error| format!("Impossible de libérer le contexte de pièce jointe: {error}"))
}

fn materialize_binary_attachment(
    staging_root: &Path,
    attachment: &ResolvedAttachment,
) -> Result<(PathBuf, PathBuf), String> {
    let staging_root = ensure_non_symlink_directory(staging_root)?;
    let directory = staging_root.join(Uuid::new_v4().to_string());
    fs::create_dir(&directory)
        .map_err(|error| format!("Impossible de préparer la pièce jointe binaire: {error}"))?;
    let filename = neutral_staging_extension(&attachment.name)
        .map(|extension| format!("attachment.{extension}"))
        .unwrap_or_else(|| "attachment.bin".to_string());
    let path = directory.join(filename);
    if let Err(error) = fs::write(&path, &attachment.bytes) {
        let _ = fs::remove_dir_all(&directory);
        return Err(format!(
            "Impossible de matérialiser la pièce jointe binaire: {error}"
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700));
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok((directory, path))
}

fn ensure_non_symlink_directory(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Le stockage privé des pièces jointes doit être absolu.".to_string());
    }
    let mut missing = Vec::new();
    let mut cursor = path;
    let existing = loop {
        match fs::symlink_metadata(cursor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(
                        "Le stockage privé des pièces jointes contient un lien symbolique ou un fichier inattendu."
                            .to_string(),
                    );
                }
                break cursor;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let component = cursor.file_name().ok_or_else(|| {
                    "Impossible de préparer le stockage privé des pièces jointes.".to_string()
                })?;
                missing.push(component.to_os_string());
                cursor = cursor.parent().ok_or_else(|| {
                    "Impossible de préparer le stockage privé des pièces jointes.".to_string()
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "Impossible d’inspecter le stockage privé des pièces jointes: {error}"
                ));
            }
        }
    };

    // Continue from the canonical existing ancestor. This prevents a newly
    // created child from following an attacker-controlled link at any missing
    // level in the artifact hierarchy.
    let mut current = canonicalize(existing).map_err(|error| {
        format!("Impossible de sécuriser le stockage privé des pièces jointes: {error}")
    })?;
    for component in missing.into_iter().rev() {
        current.push(component);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "Impossible de préparer le stockage privé des pièces jointes: {error}"
                ));
            }
        }
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            format!("Impossible d’inspecter le stockage privé des pièces jointes: {error}")
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(
                "Le stockage privé des pièces jointes contient un lien symbolique ou un fichier inattendu."
                    .to_string(),
            );
        }
    }
    Ok(current)
}

fn document_prompt_fragment(name: &str, body: &str) -> String {
    let name = escape_file_name(name);
    let content_utf16 = body.encode_utf16().count();
    format!("<file name=\"{name}\" content_utf16=\"{content_utf16}\">\n{body}\n</file>")
}

fn inline_document_prompt_fragment(attachment: &ResolvedAttachment) -> Option<String> {
    if attachment.bytes.len() <= MAX_INLINE_DOCUMENT_BYTES {
        if let Ok(content) = std::str::from_utf8(&attachment.bytes) {
            return Some(document_prompt_fragment(&attachment.name, content));
        }
    }
    None
}

fn staged_document_prompt_fragment(
    staging_root: &Path,
    attachment: &ResolvedAttachment,
) -> Result<(String, PathBuf), String> {
    let (directory, path) = materialize_binary_attachment(staging_root, attachment)?;
    let serialized_path = serde_json::to_string(&path.to_string_lossy())
        .map_err(|error| format!("Impossible de référencer la pièce jointe binaire: {error}"))?;
    let body = format!(
        "[Attachment staged by Prime Orbit at {serialized_path}. Read it with filesystem or Python tools when needed.]"
    );
    Ok((document_prompt_fragment(&attachment.name, &body), directory))
}

fn hydrated_attachment_message(
    visible_message: &str,
    context_id: &str,
    encoded_manifest: &str,
    fragments: &[String],
) -> String {
    let separator = if visible_message.is_empty() {
        ""
    } else {
        "\n\n"
    };
    let visible_utf16 = visible_message.encode_utf16().count();
    format!(
        "{visible_message}{separator}<prime_orbit_attachment_context v=\"1\" id=\"{context_id}\">\n<prime_orbit_manifest encoding=\"base64url\">{encoded_manifest}</prime_orbit_manifest>\n{}\n</prime_orbit_attachment_context>\n<prime_orbit_ui_boundary v=\"1\" id=\"{context_id}\" visible_utf16=\"{visible_utf16}\"/>",
        fragments.join("\n"),
    )
}

fn payload_fits_rpc(payload: &Value) -> Result<bool, String> {
    serde_json::to_vec(payload)
        .map(|bytes| bytes.len() <= crate::MAX_RPC_BYTES)
        .map_err(|error| format!("Impossible de sérialiser le payload RPC: {error}"))
}

pub(crate) fn hydrate_prompt_attachments(
    cache: AttachmentCache,
    owner: &str,
    payload: &mut Value,
    artifact_root: &Path,
) -> Result<Option<AttachmentReservation>, String> {
    if (payload.get("images").is_some() || payload.get("attachments").is_some())
        && payload.get("type").and_then(Value::as_str) != Some("prompt")
    {
        return Err(
            "Les pièces jointes ne sont acceptées que dans une requête prompt.".to_string(),
        );
    }
    if payload.get("images").is_none() && payload.get("attachments").is_none() {
        return Ok(None);
    }
    let mut unique = HashSet::new();
    let image_handles = parse_attachment_handles(payload, "images", &mut unique)?;
    let document_handles = parse_attachment_handles(payload, "attachments", &mut unique)?;
    if image_handles.len().saturating_add(document_handles.len()) > MAX_ATTACHMENT_COUNT {
        return Err(format!(
            "Vous pouvez joindre au maximum {MAX_ATTACHMENT_COUNT} fichiers"
        ));
    }
    if image_handles.is_empty() && document_handles.is_empty() {
        if let Some(object) = payload.as_object_mut() {
            object.remove("attachments");
        }
        return Ok(None);
    }
    if !document_handles.is_empty() && payload.get("message").and_then(Value::as_str).is_none() {
        return Err("Une requête prompt avec pièces jointes doit contenir un message.".to_string());
    }

    let mut handles = image_handles.clone();
    handles.extend(document_handles.iter().cloned());
    let resolved = cache.reserve_attachments(owner, &handles)?;
    let mut reservation = AttachmentReservation {
        cache: cache.clone(),
        owner: owner.to_string(),
        handles,
        staged_directories: Vec::new(),
        staging_context: None,
        committed: false,
    };
    let (resolved_images, resolved_documents) = resolved.split_at(image_handles.len());
    if resolved_images
        .iter()
        .any(|attachment| !attachment.is_image)
        || resolved_documents
            .iter()
            .any(|attachment| attachment.is_image)
    {
        return Err(
            "Le type d’une pièce jointe ne correspond pas au champ RPC utilisé.".to_string(),
        );
    }

    if let Some(images) = payload.get_mut("images").and_then(Value::as_array_mut) {
        for (image, attachment) in images.iter_mut().zip(resolved_images) {
            *image = serde_json::json!({
                "type": "image",
                "data": STANDARD.encode(&attachment.bytes),
                "mimeType": attachment.mime_type,
            });
        }
    }

    let manifest = resolved_documents
        .iter()
        .map(|attachment| {
            serde_json::json!({
                "name": attachment.name,
                "mimeType": attachment.mime_type,
                "size": attachment.bytes.len(),
                "isImage": false,
            })
        })
        .collect::<Vec<_>>();
    let manifest = serde_json::to_vec(&manifest).map_err(|error| {
        format!("Impossible de préparer le manifeste des pièces jointes: {error}")
    })?;
    if manifest.len() > MAX_ORBIT_MANIFEST_BYTES {
        return Err("Le manifeste des pièces jointes dépasse la taille autorisée.".to_string());
    }
    let encoded_manifest = URL_SAFE_NO_PAD.encode(manifest);
    let context_id = Uuid::new_v4().to_string();
    let staging_context = artifact_root.join(&context_id);

    let mut fragments = Vec::with_capacity(resolved_documents.len());
    let mut inline_indices = Vec::new();
    for (index, attachment) in resolved_documents.iter().enumerate() {
        if let Some(fragment) = inline_document_prompt_fragment(attachment) {
            fragments.push(fragment);
            inline_indices.push(index);
        } else {
            let (fragment, directory) =
                staged_document_prompt_fragment(&staging_context, attachment)?;
            fragments.push(fragment);
            reservation.staging_context = directory.parent().map(Path::to_path_buf);
            reservation.staged_directories.push(directory);
        }
    }
    if !fragments.is_empty() {
        let visible_message = payload
            .get("message")
            .and_then(Value::as_str)
            .expect("validated prompt message")
            .to_string();
        payload["message"] = Value::String(hydrated_attachment_message(
            &visible_message,
            &context_id,
            &encoded_manifest,
            &fragments,
        ));

        // The image budget can consume most of Prime Agent's 16 MiB RPC
        // frame after base64 expansion. Start with small UTF-8 documents
        // inline, then stage the largest ones until the real serialized JSON
        // fits; this accounts for JSON escaping instead of relying on a rough
        // byte estimate.
        inline_indices.sort_unstable_by_key(|index| std::cmp::Reverse(fragments[*index].len()));
        for index in inline_indices {
            if payload_fits_rpc(payload)? {
                break;
            }
            let (fragment, directory) =
                staged_document_prompt_fragment(&staging_context, &resolved_documents[index])?;
            fragments[index] = fragment;
            reservation.staging_context = directory.parent().map(Path::to_path_buf);
            reservation.staged_directories.push(directory);
            payload["message"] = Value::String(hydrated_attachment_message(
                &visible_message,
                &context_id,
                &encoded_manifest,
                &fragments,
            ));
        }
    }
    if let Some(object) = payload.as_object_mut() {
        object.remove("attachments");
    }

    if !payload_fits_rpc(payload)? {
        return Err(format!(
            "Le payload RPC dépasse la limite de {} octets, même après la matérialisation sécurisée des documents.",
            crate::MAX_RPC_BYTES
        ));
    }

    Ok(Some(reservation))
}

#[tauri::command]
pub async fn pick_attachments(
    window: WebviewWindow,
    cache: tauri::State<'_, AttachmentCache>,
    remaining_count: usize,
    remaining_attachment_bytes: u64,
    remaining_image_bytes: u64,
) -> Result<Vec<AttachmentData>, String> {
    if remaining_count > MAX_ATTACHMENT_COUNT
        || remaining_attachment_bytes > MAX_TOTAL_ATTACHMENT_BYTES
        || remaining_image_bytes > MAX_TOTAL_IMAGE_BYTES
    {
        return Err("Le budget de pièces jointes demandé est invalide.".to_string());
    }
    let app = window.app_handle().clone();
    let dialog_parent = window.clone();
    let owner = window.label().to_string();
    let cache = cache.inner().clone();
    crate::run_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("Joindre des fichiers")
            .set_parent(&dialog_parent)
            .add_filter("Tous les fichiers", &["*"])
            .add_filter(
                "Images et documents",
                &[
                    "png", "jpg", "jpeg", "webp", "gif", "md", "txt", "json", "ts", "tsx", "js",
                    "jsx", "py", "rs", "toml", "yaml", "yml", "pdf",
                ],
            )
            .blocking_pick_files()
            .unwrap_or_default();
        let paths = selected
            .into_iter()
            .map(|selected_path| {
                selected_path
                    .into_path()
                    .map_err(|_| "La pièce jointe sélectionnée est invalide.".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let prepared = prepare_attachment_paths(
            paths,
            remaining_count,
            remaining_attachment_bytes,
            remaining_image_bytes,
        )?;
        cache.insert_prepared(&owner, prepared)
    })
    .await
}

fn decoded_drop_header(headers: &tauri::http::HeaderMap, name: &str) -> Result<String, String> {
    headers
        .get(name)
        .ok_or_else(|| format!("L’en-tête {name} est absent."))?
        .to_str()
        .map(str::to_string)
        .map_err(|_| format!("L’en-tête {name} est invalide."))
}

fn decode_dropped_attachment_name(encoded: &str) -> Result<String, String> {
    if encoded.len() > 2_048 {
        return Err("Le nom de la pièce jointe déposée est trop long.".to_string());
    }
    let query = format!("name={encoded}");
    let name = url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "name")
        .map(|(_, value)| value.into_owned())
        .ok_or_else(|| "Le nom de la pièce jointe déposée est invalide.".to_string())?;
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
    {
        return Err("Le nom de la pièce jointe déposée est invalide.".to_string());
    }
    Ok(name)
}

fn prepare_dropped_attachment(
    name: String,
    declared_mime_type: String,
    bytes: Vec<u8>,
    remaining_attachment_bytes: u64,
    remaining_image_bytes: u64,
) -> Result<PreparedAttachment, String> {
    if remaining_attachment_bytes > MAX_TOTAL_ATTACHMENT_BYTES
        || remaining_image_bytes > MAX_TOTAL_IMAGE_BYTES
    {
        return Err("Le budget de pièces jointes demandé est invalide.".to_string());
    }
    if declared_mime_type.len() > 256
        || declared_mime_type
            .chars()
            .any(|character| character.is_control())
    {
        return Err("Le type MIME de la pièce jointe est invalide.".to_string());
    }
    let mime_type = if declared_mime_type.trim().is_empty() {
        mime_guess::from_path(&name)
            .first_or_octet_stream()
            .essence_str()
            .to_string()
    } else {
        declared_mime_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
    };
    let is_image = supported_inline_image(&mime_type);
    let allowed_bytes = if is_image {
        MAX_IMAGE_ATTACHMENT_BYTES
            .min(remaining_attachment_bytes)
            .min(remaining_image_bytes)
    } else {
        MAX_DOCUMENT_ATTACHMENT_BYTES.min(remaining_attachment_bytes)
    };
    if bytes.len() as u64 > allowed_bytes {
        return Err(format!(
            "La pièce jointe déposée dépasse le budget restant de {allowed_bytes} octets."
        ));
    }
    if is_image && !image_signature_matches(&mime_type, &bytes) {
        return Err(
            "Le contenu du fichier ne correspond pas à son format d’image déclaré.".to_string(),
        );
    }
    let preview_data_url = is_image
        .then(|| image_preview_data_url(&mime_type, &bytes))
        .transpose()?;
    Ok(PreparedAttachment {
        name,
        mime_type,
        bytes,
        preview_data_url,
        is_image,
    })
}

#[tauri::command]
pub async fn admit_dropped_attachment(
    window: WebviewWindow,
    cache: tauri::State<'_, AttachmentCache>,
    request: Request<'_>,
) -> Result<AttachmentData, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(
            "Le contenu de la pièce jointe déposée doit utiliser le transport binaire natif."
                .to_string(),
        );
    };
    if bytes.len() as u64 > MAX_DOCUMENT_ATTACHMENT_BYTES {
        return Err(format!(
            "La pièce jointe déposée dépasse la limite de {MAX_DOCUMENT_ATTACHMENT_BYTES} octets."
        ));
    }
    let encoded_name = decoded_drop_header(request.headers(), "x-prime-orbit-file-name")?;
    let name = decode_dropped_attachment_name(&encoded_name)?;
    let mime_type = decoded_drop_header(request.headers(), "x-prime-orbit-mime-type")?;
    let remaining_attachment_bytes = decoded_drop_header(
        request.headers(),
        "x-prime-orbit-remaining-attachment-bytes",
    )?
    .parse::<u64>()
    .map_err(|_| "Le budget restant des pièces jointes est invalide.".to_string())?;
    let remaining_image_bytes =
        decoded_drop_header(request.headers(), "x-prime-orbit-remaining-image-bytes")?
            .parse::<u64>()
            .map_err(|_| "Le budget restant des images est invalide.".to_string())?;
    let owner = window.label().to_string();
    let cache = cache.inner().clone();
    let bytes = bytes.clone();
    crate::run_blocking(move || {
        let attachment = prepare_dropped_attachment(
            name,
            mime_type,
            bytes,
            remaining_attachment_bytes,
            remaining_image_bytes,
        )?;
        cache
            .insert_prepared(&owner, vec![attachment])?
            .pop()
            .ok_or_else(|| "La pièce jointe déposée n’a pas pu être préparée.".to_string())
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn release_attachment_handles(
    window: WebviewWindow,
    cache: tauri::State<'_, AttachmentCache>,
    handles: Vec<String>,
) -> Result<(), String> {
    if handles.len() > MAX_CACHED_ATTACHMENT_COUNT
        || handles
            .iter()
            .any(|handle| Uuid::parse_str(handle).is_err())
    {
        return Err("La liste des handles de pièces jointes est invalide.".to_string());
    }
    cache.release(window.label(), &handles);
    Ok(())
}

pub fn release_window_attachments(cache: AttachmentCache, owner: &str) {
    cache.release_owner(owner);
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

fn validated_project_folder(path: String) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("Le chemin du projet doit être absolu".to_string());
    }
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Le projet {} est inaccessible: {error}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!("{} n’est pas un dossier", path.display()));
    }
    canonicalize(&path)
        .map_err(|error| format!("Impossible de résoudre {}: {error}", path.display()))
}

fn containing_git_folder(cwd: String, relative_path: String) -> Result<PathBuf, String> {
    let root = validated_git_cwd(cwd)?;
    let relative = PathBuf::from(relative_path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Le chemin du fichier Git est invalide".to_string());
    }
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let folder = canonicalize(root.join(parent)).map_err(|error| {
        format!(
            "Impossible de résoudre le dossier contenant {}: {error}",
            relative.display()
        )
    })?;
    if !folder.starts_with(&root) || !folder.is_dir() {
        return Err("Le dossier demandé sort du projet Git".to_string());
    }
    Ok(folder)
}

#[tauri::command]
pub async fn open_project_folder(app: AppHandle, path: String) -> Result<(), String> {
    crate::run_blocking(move || {
        let folder = validated_project_folder(path)?;
        app.opener()
            .open_path(folder.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|error| format!("Impossible d’ouvrir {}: {error}", folder.display()))
    })
    .await
}

#[tauri::command]
pub async fn open_git_file_folder(app: AppHandle, cwd: String, path: String) -> Result<(), String> {
    crate::run_blocking(move || {
        let folder = containing_git_folder(cwd, path)?;
        app.opener()
            .open_path(folder.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|error| format!("Impossible d’ouvrir {}: {error}", folder.display()))
    })
    .await
}

fn git_output(git: &Path, cwd: &Path, arguments: &[&str]) -> Result<Output, String> {
    let mut all_arguments = vec![OsString::from("-C"), cwd.as_os_str().to_owned()];
    all_arguments.extend(arguments.iter().map(OsString::from));
    let mut command = external_command(git, &all_arguments);
    capture_command_output(&mut command)
}

#[cfg(test)]
mod attachment_tests {
    use super::{
        attachment_artifact_root, decode_dropped_attachment_name, hydrate_prompt_attachments,
        parse_orbit_attachment_context, prepare_dropped_attachment,
        prune_fallback_attachment_artifacts, read_selected_attachment,
        remove_staged_attachment_context, AttachmentCache, PreparedAttachment,
        CACHED_ATTACHMENT_TTL, MAX_IMAGE_ATTACHMENT_BYTES, MAX_INLINE_DOCUMENT_BYTES,
        MAX_TOTAL_ATTACHMENT_BYTES, MAX_TOTAL_IMAGE_BYTES,
    };
    use image::{DynamicImage, ImageFormat};
    use serde_json::json;
    use std::{
        fs,
        io::Cursor,
        io::Write,
        path::Path,
        time::{Duration, Instant, SystemTime},
    };

    fn prepared_image(name: &str, bytes: &[u8]) -> PreparedAttachment {
        PreparedAttachment {
            name: name.to_string(),
            mime_type: "image/png".to_string(),
            bytes: bytes.to_vec(),
            preview_data_url: Some("data:image/png;base64,cHJldmlldw==".to_string()),
            is_image: true,
        }
    }

    fn prepared_document(name: &str, mime_type: &str, bytes: &[u8]) -> PreparedAttachment {
        PreparedAttachment {
            name: name.to_string(),
            mime_type: mime_type.to_string(),
            bytes: bytes.to_vec(),
            preview_data_url: None,
            is_image: false,
        }
    }

    fn valid_png() -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgba8(1, 1)
            .write_to(&mut bytes, ImageFormat::Png)
            .expect("encode PNG fixture");
        bytes.into_inner()
    }

    #[test]
    fn dropped_attachment_transport_accepts_documents_and_validates_images() {
        assert_eq!(
            decode_dropped_attachment_name("capture%20%C3%A9cran.png").expect("decode name"),
            "capture écran.png"
        );
        assert!(decode_dropped_attachment_name("..%2Fsecret.png").is_err());
        assert!(decode_dropped_attachment_name("..%5Csecret.png").is_err());

        let image = prepare_dropped_attachment(
            "capture.png".to_string(),
            "image/png".to_string(),
            valid_png(),
            MAX_TOTAL_ATTACHMENT_BYTES,
            MAX_IMAGE_ATTACHMENT_BYTES,
        )
        .expect("admit valid dropped PNG");
        assert_eq!(image.mime_type, "image/png");
        assert!(image
            .preview_data_url
            .as_deref()
            .is_some_and(|value| value.starts_with("data:image/png;base64,")));

        let mismatch = prepare_dropped_attachment(
            "capture.png".to_string(),
            "image/jpeg".to_string(),
            valid_png(),
            MAX_TOTAL_ATTACHMENT_BYTES,
            MAX_IMAGE_ATTACHMENT_BYTES,
        )
        .expect_err("reject MIME/signature mismatch");
        assert!(mismatch.contains("format"));

        let document = prepare_dropped_attachment(
            "notes.txt".to_string(),
            "text/plain".to_string(),
            b"dropped document".to_vec(),
            MAX_TOTAL_ATTACHMENT_BYTES,
            MAX_TOTAL_IMAGE_BYTES,
        )
        .expect("admit dropped document");
        assert!(!document.is_image);
        assert!(document.preview_data_url.is_none());
    }

    #[test]
    fn picker_caches_external_document_without_exposing_its_source_path() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("outside-project.txt");
        fs::write(&path, b"external document").expect("write fixture");

        let prepared = read_selected_attachment(
            path.clone(),
            MAX_TOTAL_ATTACHMENT_BYTES,
            MAX_TOTAL_IMAGE_BYTES,
        )
        .expect("read attachment bytes");
        assert!(!prepared.is_image);
        assert_eq!(prepared.bytes, b"external document");

        let cache = AttachmentCache::default();
        let attachment = cache
            .insert_prepared("window-a", vec![prepared])
            .expect("cache document")
            .remove(0);
        let value = serde_json::to_value(&attachment).expect("serialize attachment metadata");
        assert_eq!(value.get("path"), None);
        assert!(value
            .get("attachmentHandle")
            .and_then(|item| item.as_str())
            .is_some());
        assert!(!value
            .to_string()
            .contains(&path.to_string_lossy().to_string()));
    }

    #[test]
    fn svg_is_a_document_handle_without_active_preview_markup() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("diagram.svg");
        fs::write(&path, br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#).expect("write fixture");

        let prepared =
            read_selected_attachment(path, MAX_TOTAL_ATTACHMENT_BYTES, MAX_TOTAL_IMAGE_BYTES)
                .expect("read SVG");
        assert!(!prepared.is_image);
        assert!(prepared.preview_data_url.is_none());
        let attachment = AttachmentCache::default()
            .insert_prepared("window-a", vec![prepared])
            .expect("cache SVG")
            .remove(0);
        assert!(attachment.attachment_handle.is_some());
        assert!(attachment.preview_data_url.is_none());
    }

    #[test]
    fn rejects_an_oversized_image_before_reading_it_into_memory() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("oversized.png");
        let mut file = fs::File::create(&path).expect("create fixture");
        file.write_all(b"png").expect("write fixture prefix");
        file.set_len(MAX_IMAGE_ATTACHMENT_BYTES + 1)
            .expect("extend sparse fixture");

        let error =
            read_selected_attachment(path, MAX_TOTAL_ATTACHMENT_BYTES, MAX_TOTAL_IMAGE_BYTES)
                .expect_err("oversized image must be rejected");
        assert!(error.contains("budget restant"));
    }

    #[test]
    fn exposes_only_opaque_handles_and_bounded_metadata() {
        let cache = AttachmentCache::default();
        let attachments = cache
            .insert_prepared(
                "window-a",
                vec![prepared_image("pixel.png", b"\x89PNG\r\n\x1a\nDATA")],
            )
            .expect("cache image");
        let value = serde_json::to_value(&attachments[0]).expect("serialize metadata");
        assert_eq!(value.get("path"), None);
        assert!(value
            .get("attachmentHandle")
            .and_then(|value| value.as_str())
            .is_some());
        assert_eq!(value.get("dataBase64"), None);
        assert_eq!(value.get("previewUrl"), None);
        assert!(value
            .get("previewDataUrl")
            .and_then(|value| value.as_str())
            .is_some_and(|value| value.starts_with("data:image/png;base64,")));
    }

    #[test]
    fn owner_scoped_image_reservation_is_retryable_until_a_successful_write() {
        let cache = AttachmentCache::default();
        let artifacts = tempfile::tempdir().expect("artifact directory");
        let attachment = cache
            .insert_prepared(
                "window-a",
                vec![prepared_image("pixel.png", b"\x89PNG\r\n\x1a\nDATA")],
            )
            .expect("cache image")
            .remove(0);
        let handle = attachment.attachment_handle.expect("opaque handle");
        let make_payload = || {
            json!({
                "type": "prompt",
                "message": "inspect",
                "images": [{"type": "image", "attachmentHandle": handle}]
            })
        };

        let mut foreign_payload = make_payload();
        let foreign = hydrate_prompt_attachments(
            cache.clone(),
            "window-b",
            &mut foreign_payload,
            artifacts.path(),
        )
        .err()
        .expect("foreign owner must be rejected");
        assert!(foreign.contains("autre fenêtre"));

        let mut failed_write_payload = make_payload();
        let reservation = hydrate_prompt_attachments(
            cache.clone(),
            "window-a",
            &mut failed_write_payload,
            artifacts.path(),
        )
        .expect("reserve image")
        .expect("reservation");
        assert!(failed_write_payload["images"][0]["data"]
            .as_str()
            .is_some_and(|data| !data.is_empty()));
        assert_eq!(
            failed_write_payload["images"][0].get("attachmentHandle"),
            None
        );
        drop(reservation);

        let mut retry_payload = make_payload();
        let reservation = hydrate_prompt_attachments(
            cache.clone(),
            "window-a",
            &mut retry_payload,
            artifacts.path(),
        )
        .expect("retry after failed write")
        .expect("retry reservation");
        reservation.commit();

        let mut consumed_payload = make_payload();
        let consumed =
            hydrate_prompt_attachments(cache, "window-a", &mut consumed_payload, artifacts.path())
                .err()
                .expect("successful write consumes the handle");
        assert!(consumed.contains("expiré") || consumed.contains("disponible"));
    }

    #[test]
    fn cache_rejects_an_unbounded_number_of_pending_attachments() {
        let cache = AttachmentCache::default();
        let prepared = (0..81)
            .map(|index| prepared_image(&format!("{index}.png"), b"\x89PNG\r\n\x1a\n"))
            .collect();
        let error = cache
            .insert_prepared("window-a", prepared)
            .expect_err("bounded cache");
        assert!(error.contains("cache sécurisé"));
    }

    #[test]
    fn one_window_at_its_cache_limit_does_not_block_another_window() {
        let cache = AttachmentCache::default();
        let owner_a = (0..80)
            .map(|index| prepared_document(&format!("{index}.txt"), "text/plain", b""))
            .collect();
        cache
            .insert_prepared("window-a", owner_a)
            .expect("fill first owner cache");
        let owner_a_error = cache
            .insert_prepared(
                "window-a",
                vec![prepared_document("extra.txt", "text/plain", b"")],
            )
            .expect_err("first owner remains bounded");
        assert!(owner_a_error.contains("cette fenêtre"));

        let owner_b = cache
            .insert_prepared(
                "window-b",
                vec![prepared_document("other.txt", "text/plain", b"ok")],
            )
            .expect("second owner has an independent budget");
        assert_eq!(owner_b.len(), 1);
    }

    #[test]
    fn utf8_document_is_inlined_by_name_and_never_by_source_path() {
        let cache = AttachmentCache::default();
        let artifacts = tempfile::tempdir().expect("artifact directory");
        let attachment = cache
            .insert_prepared(
                "window-a",
                vec![prepared_document(
                    "notes & plan.txt",
                    "text/plain",
                    b"hello from the selected file",
                )],
            )
            .expect("cache document")
            .remove(0);
        let handle = attachment.attachment_handle.expect("opaque handle");
        let mut payload = json!({
            "type": "prompt",
            "message": "inspect",
            "attachments": [{"attachmentHandle": handle}]
        });
        let reservation =
            hydrate_prompt_attachments(cache, "window-a", &mut payload, artifacts.path())
                .expect("hydrate document")
                .expect("reservation");
        assert_eq!(payload.get("attachments"), None);
        let message = payload["message"].as_str().expect("hydrated message");
        assert!(message.contains("<file name=\"notes &amp; plan.txt\" content_utf16=\"28\">"));
        assert!(message.contains("hello from the selected file"));
        assert!(!message.contains("outside-project"));
        assert!(message.ends_with(&format!(
            "visible_utf16=\"{}\"/>",
            "inspect".encode_utf16().count()
        )));
        let public = parse_orbit_attachment_context(message).expect("strict Orbit context");
        assert_eq!(public.visible_text, "inspect");
        assert_eq!(public.attachments.len(), 1);
        assert_eq!(public.attachments[0].name, "notes & plan.txt");
        assert_eq!(public.attachments[0].mime_type, "text/plain");
        assert_eq!(public.attachments[0].size, 28);
        assert!(!public.attachments[0].is_image);
        assert!(!serde_json::to_string(&public.attachments)
            .expect("public metadata")
            .contains("hello from the selected file"));
        reservation.commit();
    }

    #[test]
    fn strict_attachment_parser_rejects_fragment_manifest_mismatches() {
        let cache = AttachmentCache::default();
        let artifacts = tempfile::tempdir().expect("artifact directory");
        let attachment = cache
            .insert_prepared(
                "window-a",
                vec![prepared_document("notes.txt", "text/plain", b"hello")],
            )
            .expect("cache document")
            .remove(0);
        let mut payload = json!({
            "type": "prompt",
            "message": "inspect",
            "attachments": [{"attachmentHandle": attachment.attachment_handle.expect("handle")}]
        });
        let _reservation =
            hydrate_prompt_attachments(cache, "window-a", &mut payload, artifacts.path())
                .expect("hydrate document")
                .expect("reservation");
        let message = payload["message"].as_str().expect("hydrated message");
        assert!(parse_orbit_attachment_context(message).is_some());

        let wrong_name =
            message.replacen("<file name=\"notes.txt\"", "<file name=\"other.txt\"", 1);
        assert!(parse_orbit_attachment_context(&wrong_name).is_none());

        let wrong_length = message.replacen("content_utf16=\"5\"", "content_utf16=\"4\"", 1);
        assert!(parse_orbit_attachment_context(&wrong_length).is_none());
    }

    #[test]
    fn stages_inline_text_when_images_and_json_escaping_would_overflow_rpc() {
        let cache = AttachmentCache::default();
        let artifacts = tempfile::tempdir().expect("artifact directory");
        let mut first_image = vec![0_u8; 5 * 1024 * 1024];
        first_image[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let second_image = first_image.clone();
        // NUL expands to six JSON bytes. It is valid UTF-8 and below the
        // per-document inline threshold, but cannot coexist inline with the
        // maximum image budget in a 16 MiB RPC record.
        let escaped_text = vec![0_u8; MAX_INLINE_DOCUMENT_BYTES];
        let attachments = cache
            .insert_prepared(
                "window-a",
                vec![
                    prepared_image("one.png", &first_image),
                    prepared_image("two.png", &second_image),
                    prepared_document("escaped.txt", "text/plain", &escaped_text),
                ],
            )
            .expect("cache max-budget fixtures");
        let mut payload = json!({
            "type": "prompt",
            "message": "inspect",
            "images": [
                {"attachmentHandle": attachments[0].attachment_handle.as_ref().expect("first handle")},
                {"attachmentHandle": attachments[1].attachment_handle.as_ref().expect("second handle")}
            ],
            "attachments": [
                {"attachmentHandle": attachments[2].attachment_handle.as_ref().expect("document handle")}
            ]
        });

        let reservation =
            hydrate_prompt_attachments(cache, "window-a", &mut payload, artifacts.path())
                .expect("hydrate within real RPC budget")
                .expect("reservation");
        assert_eq!(reservation.staged_directories.len(), 1);
        assert!(
            serde_json::to_vec(&payload)
                .expect("serialize payload")
                .len()
                <= crate::MAX_RPC_BYTES
        );
        assert!(!payload["message"].as_str().expect("message").contains('\0'));
    }

    #[test]
    fn artifact_root_uses_the_exact_session_header_id_and_a_hashed_fallback() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let session_dir = directory.path().join("sessions").join("project-key");
        fs::create_dir_all(&session_dir).expect("session directory");
        let session_path = session_dir.join("misleading-stem.jsonl");
        fs::write(
            &session_path,
            b"{\"type\":\"session\",\"id\":\"exact-header-id\",\"cwd\":\"C:/work\"}\n",
        )
        .expect("session header");
        let app_data = directory.path().join("app-data");
        let root = attachment_artifact_root(
            session_path.to_str(),
            None,
            &app_data,
            "renderer/conversation/identifier",
        );
        assert_eq!(
            root,
            directory
                .path()
                .join("sessions")
                .join("session-artifacts")
                .join("exact-header-id")
                .join("prime-orbit-attachments")
        );
        assert!(!root.to_string_lossy().contains("misleading-stem"));

        let missing_session_path = directory
            .path()
            .join("sessions")
            .join("project-key")
            .join("missing.jsonl");
        let exact_state_root = attachment_artifact_root(
            missing_session_path.to_str(),
            Some("state-session-id"),
            &app_data,
            "renderer/conversation/identifier",
        );
        assert!(exact_state_root.ends_with(
            Path::new("session-artifacts")
                .join("state-session-id")
                .join("prime-orbit-attachments")
        ));

        let fallback =
            attachment_artifact_root(None, None, &app_data, "renderer/conversation/identifier");
        assert!(fallback.starts_with(&app_data));
        assert!(!fallback
            .to_string_lossy()
            .contains("renderer/conversation/identifier"));
    }

    #[test]
    fn binary_document_staging_is_retryable_then_retained_after_commit() {
        let cache = AttachmentCache::default();
        let artifacts = tempfile::tempdir().expect("artifact directory");
        let root = artifacts.path().to_path_buf();
        let attachment = cache
            .insert_prepared(
                "window-a",
                vec![prepared_document(
                    "report.pdf",
                    "application/pdf",
                    &[0xff, 0, 1],
                )],
            )
            .expect("cache binary document")
            .remove(0);
        let handle = attachment.attachment_handle.expect("opaque handle");
        let make_payload = || {
            json!({
                "type": "prompt",
                "message": "inspect",
                "attachments": [{"attachmentHandle": handle}]
            })
        };

        let mut failed_payload = make_payload();
        let failed_reservation =
            hydrate_prompt_attachments(cache.clone(), "window-a", &mut failed_payload, &root)
                .expect("stage binary")
                .expect("reservation");
        let failed_directory = failed_reservation.staged_directories[0].clone();
        assert!(failed_directory.join("attachment.pdf").is_file());
        assert!(failed_payload["message"]
            .as_str()
            .is_some_and(|message| message.contains("Prime Orbit")));
        drop(failed_reservation);
        assert!(!failed_directory.exists());

        let mut retry_payload = make_payload();
        let reservation =
            hydrate_prompt_attachments(cache.clone(), "window-a", &mut retry_payload, &root)
                .expect("retry staging")
                .expect("reservation");
        let retained_directory = reservation.staged_directories[0].clone();
        let context_id = parse_orbit_attachment_context(
            retry_payload["message"].as_str().expect("hydrated message"),
        )
        .expect("strict attachment context")
        .context_id;
        let context_root = root.join(&context_id);
        let retained_context_root = retained_directory
            .parent()
            .expect("staged directory belongs to its context");
        assert_eq!(
            crate::paths::canonicalize(retained_context_root)
                .expect("canonical retained context root"),
            crate::paths::canonicalize(&context_root).expect("canonical expected context root")
        );
        reservation.commit();
        assert!(retained_directory.join("attachment.pdf").is_file());
        drop(cache);
        assert!(retained_directory.join("attachment.pdf").is_file());
        remove_staged_attachment_context(&root, &context_id).expect("queue delete cleanup");
        assert!(!retained_directory.exists());
    }

    #[test]
    fn queue_cleanup_removes_only_the_exact_orbit_context_directory() {
        let artifacts = tempfile::tempdir().expect("artifact directory");
        let root = artifacts.path().join("prime-orbit-attachments");
        let context_id = "550e8400-e29b-41d4-a716-446655440000";
        let context = root.join(context_id);
        let sibling = root.join("660e8400-e29b-41d4-a716-446655440000");
        fs::create_dir_all(&context).expect("context");
        fs::create_dir_all(&sibling).expect("sibling");
        fs::write(context.join("attachment.pdf"), b"private").expect("context file");

        remove_staged_attachment_context(&root, context_id).expect("safe cleanup");
        assert!(!context.exists());
        assert!(sibling.is_dir());
        assert!(root.is_dir());
        assert!(remove_staged_attachment_context(&root, "../outside").is_err());
        assert!(sibling.is_dir());
    }

    #[test]
    fn fallback_gc_is_bounded_to_orbit_owned_hashed_conversation_roots() {
        let app_data = tempfile::tempdir().expect("app data");
        let fallback = app_data.path().join("session-attachments");
        let conversation = fallback.join("a".repeat(64));
        let artifact = conversation
            .join("prime-orbit-attachments")
            .join("550e8400-e29b-41d4-a716-446655440000")
            .join("child")
            .join("attachment.pdf");
        fs::create_dir_all(artifact.parent().expect("artifact parent")).expect("artifact tree");
        fs::write(&artifact, b"private").expect("artifact");
        let unrelated = fallback.join("user-named-folder");
        fs::create_dir_all(&unrelated).expect("unrelated folder");
        fs::write(unrelated.join("keep.txt"), b"keep").expect("unrelated file");

        let removed = prune_fallback_attachment_artifacts(
            app_data.path(),
            SystemTime::now() + Duration::from_secs(2 * 24 * 60 * 60),
            Duration::from_secs(24 * 60 * 60),
            Duration::ZERO,
            0,
            0,
        )
        .expect("bounded fallback cleanup");
        assert_eq!(removed, 1);
        assert!(!conversation.exists());
        assert!(unrelated.join("keep.txt").is_file());
        assert!(app_data.path().is_dir());
    }

    #[test]
    fn large_utf8_document_is_staged_instead_of_expanding_the_rpc_payload() {
        let cache = AttachmentCache::default();
        let artifacts = tempfile::tempdir().expect("artifact directory");
        let bytes = vec![b'x'; MAX_INLINE_DOCUMENT_BYTES + 1];
        let attachment = cache
            .insert_prepared(
                "window-a",
                vec![prepared_document("large.txt", "text/plain", &bytes)],
            )
            .expect("cache large document")
            .remove(0);
        let mut payload = json!({
            "type": "prompt",
            "message": "inspect",
            "attachments": [{"attachmentHandle": attachment.attachment_handle.expect("handle")}]
        });
        let reservation =
            hydrate_prompt_attachments(cache, "window-a", &mut payload, artifacts.path())
                .expect("hydrate large text")
                .expect("reservation");
        assert!(payload["message"]
            .as_str()
            .is_some_and(|message| message.len() < 2_000));
        assert_eq!(reservation.staged_directories.len(), 1);
    }

    #[test]
    fn expired_handles_are_purged_before_rpc_hydration() {
        let cache = AttachmentCache::default();
        let artifacts = tempfile::tempdir().expect("artifact directory");
        let attachment = cache
            .insert_prepared(
                "window-a",
                vec![prepared_image("pixel.png", b"\x89PNG\r\n\x1a\nDATA")],
            )
            .expect("cache image")
            .remove(0);
        let handle = attachment.attachment_handle.expect("opaque handle");
        cache
            .0
            .lock()
            .attachments
            .get_mut(&handle)
            .expect("cached attachment")
            .inserted_at = Instant::now() - CACHED_ATTACHMENT_TTL;
        let mut payload = json!({
            "type": "prompt",
            "images": [{"type": "image", "attachmentHandle": handle}]
        });
        let error = match hydrate_prompt_attachments(
            cache.clone(),
            "window-a",
            &mut payload,
            artifacts.path(),
        ) {
            Err(error) => error,
            Ok(_) => panic!("expired handle accepted"),
        };
        assert!(error.contains("expiré"));
        assert!(cache.0.lock().attachments.is_empty());
    }
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
            additions: 0,
            deletions: 0,
            binary: false,
        });
        index += 1;
    }
    files
}

fn parse_numstat_z(bytes: &[u8]) -> HashMap<String, GitFileStat> {
    let mut stats = HashMap::new();
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let mut fields = record.splitn(3, |byte| *byte == b'\t');
        let Some(additions) = fields.next() else {
            continue;
        };
        let Some(deletions) = fields.next() else {
            continue;
        };
        let Some(path) = fields.next() else {
            continue;
        };
        let binary = additions == b"-" || deletions == b"-";
        let stat = GitFileStat {
            additions: if binary {
                0
            } else {
                String::from_utf8_lossy(additions).parse().unwrap_or(0)
            },
            deletions: if binary {
                0
            } else {
                String::from_utf8_lossy(deletions).parse().unwrap_or(0)
            },
            binary,
        };
        stats
            .entry(String::from_utf8_lossy(path).into_owned())
            .or_insert_with(GitFileStat::default)
            .merge(stat);
    }
    stats
}

fn safe_git_relative_path(value: &str) -> Result<PathBuf, String> {
    if value.trim().is_empty() {
        return Err("Le chemin Git ne peut pas être vide".to_string());
    }
    let path = PathBuf::from(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!("Le chemin Git {value} est invalide"));
    }
    Ok(path)
}

fn untracked_file_stat(cwd: &Path, relative: &str) -> GitFileStat {
    let Ok(relative) = safe_git_relative_path(relative) else {
        return GitFileStat {
            binary: true,
            ..GitFileStat::default()
        };
    };
    let path = cwd.join(relative);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return GitFileStat::default();
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return GitFileStat {
            binary: true,
            ..GitFileStat::default()
        };
    }
    let Ok(resolved) = canonicalize(&path) else {
        return GitFileStat::default();
    };
    if !resolved.starts_with(cwd) {
        return GitFileStat {
            binary: true,
            ..GitFileStat::default()
        };
    }
    let Ok(file) = File::open(resolved) else {
        return GitFileStat::default();
    };
    let mut bytes =
        Vec::with_capacity((metadata.len() as usize).min(MAX_UNTRACKED_STAT_BYTES as usize + 1));
    if file
        .take(MAX_UNTRACKED_STAT_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return GitFileStat::default();
    }
    if bytes.len() as u64 > MAX_UNTRACKED_STAT_BYTES {
        return GitFileStat {
            binary: true,
            ..GitFileStat::default()
        };
    }
    if bytes.contains(&0) {
        return GitFileStat {
            binary: true,
            ..GitFileStat::default()
        };
    }
    let additions = if bytes.is_empty() {
        0
    } else {
        bytes.iter().filter(|byte| **byte == b'\n').count() as u64
            + u64::from(!bytes.ends_with(b"\n"))
    };
    GitFileStat {
        additions,
        ..GitFileStat::default()
    }
}

fn read_stream_limited(mut stream: impl Read, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut stored = Vec::with_capacity(limit.min(16 * 1024));
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(stored.len());
        let keep = remaining.min(read);
        stored.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
    }
    Ok((stored, truncated))
}

fn git_output_limited(
    git: &Path,
    cwd: &Path,
    arguments: &[OsString],
) -> Result<LimitedOutput, String> {
    let mut all_arguments = vec![OsString::from("-C"), cwd.as_os_str().to_owned()];
    all_arguments.extend(arguments.iter().cloned());
    let mut command = external_command(git, &all_arguments);
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_PAGER", "cat")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Impossible de lancer Git: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Impossible de lire la sortie Git".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Impossible de lire les erreurs Git".to_string())?;
    let stdout_reader = thread::spawn(move || read_stream_limited(stdout, MAX_GIT_DIFF_BYTES));
    let stderr_reader = thread::spawn(move || read_stream_limited(stderr, MAX_GIT_ERROR_BYTES));
    let status = child
        .wait()
        .map_err(|error| format!("Impossible d’attendre Git: {error}"))?;
    let (stdout, stdout_truncated) = stdout_reader
        .join()
        .map_err(|_| "La lecture de la sortie Git a échoué".to_string())?
        .map_err(|error| format!("Impossible de lire la sortie Git: {error}"))?;
    let (stderr, _) = stderr_reader
        .join()
        .map_err(|_| "La lecture des erreurs Git a échoué".to_string())?
        .map_err(|error| format!("Impossible de lire les erreurs Git: {error}"))?;
    Ok(LimitedOutput {
        status,
        stdout,
        stderr,
        stdout_truncated,
    })
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

    let mut files = parse_porcelain_z(&status.stdout);
    let mut file_stats: HashMap<String, GitFileStat> = HashMap::new();
    let head = git_output(&git, &cwd, &["rev-parse", "--verify", "HEAD"])?;
    let stat_outputs = if head.status.success() {
        vec![git_output(
            &git,
            &cwd,
            &["diff", "HEAD", "--numstat", "--no-renames", "-z", "--"],
        )?]
    } else {
        vec![
            git_output(
                &git,
                &cwd,
                &["diff", "--cached", "--numstat", "--no-renames", "-z", "--"],
            )?,
            git_output(
                &git,
                &cwd,
                &["diff", "--numstat", "--no-renames", "-z", "--"],
            )?,
        ]
    };
    let mut errors = Vec::new();
    for output in stat_outputs {
        if output.status.success() {
            for (path, stat) in parse_numstat_z(&output.stdout) {
                file_stats.entry(path).or_default().merge(stat);
            }
        } else {
            errors.push(format!("Statistiques Git: {}", output_error(&output)));
        }
    }
    for file in &mut files {
        let mut stat = file_stats.get(&file.path).copied().unwrap_or_default();
        if let Some(original_path) = file.original_path.as_ref() {
            if let Some(original_stat) = file_stats.get(original_path).copied() {
                stat.merge(original_stat);
            }
        }
        if file.status.trim() == "??" {
            stat = untracked_file_stat(&cwd, &file.path);
        }
        file.additions = stat.additions;
        file.deletions = stat.deletions;
        file.binary = stat.binary;
    }

    let unstaged = git_output(&git, &cwd, &["diff", "--stat", "--no-color", "--"])?;
    let staged = git_output(
        &git,
        &cwd,
        &["diff", "--cached", "--stat", "--no-color", "--"],
    )?;
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
        files,
        diff_stat: sections.join("\n\n"),
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    })
}

fn limited_output_error(output: &LimitedOutput) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("Git a quitté avec le statut {}", output.status)
    } else {
        stderr
    }
}

fn git_path_is_tracked(git: &Path, cwd: &Path, path: &str, has_head: bool) -> Result<bool, String> {
    let index_arguments = vec![
        OsString::from("ls-files"),
        OsString::from("--error-unmatch"),
        OsString::from("--"),
        OsString::from(path),
    ];
    if git_output_limited(git, cwd, &index_arguments)?
        .status
        .success()
    {
        return Ok(true);
    }
    if !has_head {
        return Ok(false);
    }
    let head_arguments = vec![
        OsString::from("ls-tree"),
        OsString::from("--name-only"),
        OsString::from("HEAD"),
        OsString::from("--"),
        OsString::from(path),
    ];
    let output = git_output_limited(git, cwd, &head_arguments)?;
    Ok(output.status.success() && !output.stdout.is_empty())
}

fn truncate_utf8(value: &mut String, limit: usize) -> bool {
    if value.len() <= limit {
        return false;
    }
    let mut boundary = limit;
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    true
}

fn untracked_file_patch(cwd: &Path, relative: &str) -> Result<(String, bool, bool), String> {
    let relative_path = safe_git_relative_path(relative)?;
    let path = cwd.join(&relative_path);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Impossible d’inspecter {relative}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok((String::new(), true, false));
    }
    let resolved = canonicalize(&path)
        .map_err(|error| format!("Impossible de résoudre {relative}: {error}"))?;
    if !resolved.starts_with(cwd) {
        return Err(format!("Le fichier {relative} sort du projet Git"));
    }
    let file = File::open(&resolved)
        .map_err(|error| format!("Impossible d’ouvrir {relative}: {error}"))?;
    let mut bytes = Vec::with_capacity(MAX_GIT_DIFF_BYTES.min(metadata.len() as usize));
    file.take(MAX_GIT_DIFF_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Impossible de lire {relative}: {error}"))?;
    let truncated = bytes.len() > MAX_GIT_DIFF_BYTES;
    bytes.truncate(MAX_GIT_DIFF_BYTES);
    if bytes.contains(&0) {
        return Ok((String::new(), true, truncated));
    }
    let content = String::from_utf8_lossy(&bytes);
    let line_count = if content.is_empty() {
        0
    } else {
        content.lines().count()
    };
    let mut patch = format!(
        "diff --git a/{relative} b/{relative}\nnew file mode 100644\n--- /dev/null\n+++ b/{relative}\n@@ -0,0 +1,{line_count} @@\n"
    );
    for line in content.lines() {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    let patch_truncated = truncate_utf8(&mut patch, MAX_GIT_DIFF_BYTES);
    Ok((patch, false, truncated || patch_truncated))
}

fn get_git_file_diff_blocking(
    cwd: String,
    path: String,
    original_path: Option<String>,
) -> Result<GitFileDiffResult, String> {
    let cwd = validated_git_cwd(cwd)?;
    let Some(git) = find_program("git") else {
        return Err("Git est introuvable dans PATH".to_string());
    };
    safe_git_relative_path(&path)?;
    if let Some(original) = original_path.as_deref() {
        safe_git_relative_path(original)?;
    }

    let repository = git_output(&git, &cwd, &["rev-parse", "--is-inside-work-tree"])?;
    if !repository.status.success() || output_text(&repository) != "true" {
        return Err("Ce dossier n’appartient pas à un dépôt Git".to_string());
    }
    let head = git_output(&git, &cwd, &["rev-parse", "--verify", "HEAD"])?;
    let has_head = head.status.success();
    let tracked = git_path_is_tracked(&git, &cwd, &path, has_head)?;
    let original_tracked = if tracked {
        false
    } else if let Some(original) = original_path.as_ref() {
        git_path_is_tracked(&git, &cwd, original, has_head)?
    } else {
        false
    };
    if !tracked && !original_tracked {
        let (patch, binary, truncated) = untracked_file_patch(&cwd, &path)?;
        return Ok(GitFileDiffResult {
            path,
            original_path,
            patch,
            binary,
            truncated,
        });
    }

    let mut arguments = vec![
        OsString::from("diff"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-color"),
        OsString::from("--unified=3"),
    ];
    if has_head {
        arguments.push(OsString::from("HEAD"));
    } else {
        arguments.push(OsString::from("--cached"));
    }
    arguments.push(OsString::from("--"));
    if let Some(original) = original_path.as_ref() {
        arguments.push(OsString::from(original));
    }
    arguments.push(OsString::from(&path));
    let output = git_output_limited(&git, &cwd, &arguments)?;
    if !output.status.success() {
        return Err(limited_output_error(&output));
    }
    let patch = String::from_utf8_lossy(&output.stdout).into_owned();
    let binary = patch.contains("Binary files ") || patch.contains("GIT binary patch");
    Ok(GitFileDiffResult {
        path,
        original_path,
        patch,
        binary,
        truncated: output.stdout_truncated,
    })
}

#[tauri::command]
pub async fn list_git_changes(cwd: String) -> Result<GitChangesResult, String> {
    crate::run_blocking(move || list_git_changes_blocking(cwd)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_git_file_diff(
    cwd: String,
    path: String,
    original_path: Option<String>,
) -> Result<GitFileDiffResult, String> {
    crate::run_blocking(move || get_git_file_diff_blocking(cwd, path, original_path)).await
}

#[cfg(test)]
mod tests {
    use super::{
        containing_git_folder, get_git_file_diff_blocking, list_git_changes_blocking,
        parse_numstat_z, parse_porcelain_z, safe_git_relative_path, validated_project_folder,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command,
    };

    fn run_git(cwd: &Path, arguments: &[&str]) {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(arguments)
            .output()
            .expect("run git test command");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

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

    #[test]
    fn parses_text_and_binary_numstat_records() {
        let stats = parse_numstat_z(b"12\t3\tsrc/lib.rs\0-\t-\tassets/logo.png\0");
        assert_eq!(stats["src/lib.rs"].additions, 12);
        assert_eq!(stats["src/lib.rs"].deletions, 3);
        assert!(!stats["src/lib.rs"].binary);
        assert!(stats["assets/logo.png"].binary);
    }

    #[test]
    fn git_paths_stay_relative_to_the_project() {
        assert!(safe_git_relative_path("src/lib.rs").is_ok());
        assert!(safe_git_relative_path("../outside.txt").is_err());
        assert!(safe_git_relative_path("C:\\outside.txt").is_err());
    }

    #[test]
    fn containing_folder_opens_the_exact_git_parent_without_allowing_traversal() {
        let directory = tempfile::tempdir().expect("temporary repository");
        let nested = directory.path().join("src").join("feature");
        fs::create_dir_all(&nested).expect("create nested folder");
        let resolved = containing_git_folder(
            directory.path().to_string_lossy().into_owned(),
            "src/feature/view.tsx".to_string(),
        )
        .expect("resolve containing folder");
        let expected = nested
            .canonicalize()
            .expect("canonical nested folder")
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string();
        assert_eq!(resolved, PathBuf::from(expected));
        assert!(containing_git_folder(
            directory.path().to_string_lossy().into_owned(),
            "../outside.txt".to_string(),
        )
        .is_err());
    }

    #[test]
    fn git_changes_include_per_file_stats_and_clickable_text_diffs() {
        let directory = tempfile::tempdir().expect("temporary repository");
        let root = directory.path();
        run_git(root, &["init"]);
        fs::write(root.join("tracked.txt"), b"one\ntwo\n").expect("tracked fixture");
        fs::write(root.join("deleted.txt"), b"remove me\n").expect("deleted fixture");
        run_git(root, &["add", "."]);
        run_git(
            root,
            &[
                "-c",
                "user.name=Prime Orbit Tests",
                "-c",
                "user.email=tests@example.invalid",
                "commit",
                "-m",
                "initial",
            ],
        );

        fs::write(root.join("tracked.txt"), b"one\nchanged\nthree\n").expect("modify fixture");
        fs::remove_file(root.join("deleted.txt")).expect("delete fixture");
        fs::write(root.join("untracked.txt"), b"alpha\nbeta\n").expect("untracked fixture");

        let result = list_git_changes_blocking(root.to_string_lossy().into_owned())
            .expect("list git changes");
        let tracked = result
            .files
            .iter()
            .find(|file| file.path == "tracked.txt")
            .expect("tracked change");
        assert_eq!((tracked.additions, tracked.deletions), (2, 1));
        let untracked = result
            .files
            .iter()
            .find(|file| file.path == "untracked.txt")
            .expect("untracked change");
        assert_eq!((untracked.additions, untracked.deletions), (2, 0));

        let tracked_diff = get_git_file_diff_blocking(
            root.to_string_lossy().into_owned(),
            "tracked.txt".to_string(),
            None,
        )
        .expect("tracked diff");
        assert!(tracked_diff.patch.contains("+changed"));
        let deleted_diff = get_git_file_diff_blocking(
            root.to_string_lossy().into_owned(),
            "deleted.txt".to_string(),
            None,
        )
        .expect("deleted diff");
        assert!(deleted_diff.patch.contains("-remove me"));
        let untracked_diff = get_git_file_diff_blocking(
            root.to_string_lossy().into_owned(),
            "untracked.txt".to_string(),
            None,
        )
        .expect("untracked diff");
        assert!(untracked_diff.patch.contains("+alpha"));
    }

    #[test]
    fn project_folder_validation_accepts_directories_and_rejects_files() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let validated = validated_project_folder(directory.path().to_string_lossy().into_owned())
            .expect("existing project directory");
        assert_eq!(
            validated,
            crate::paths::canonicalize(directory.path()).unwrap()
        );

        let file = directory.path().join("not-a-project.txt");
        fs::write(&file, b"fixture").expect("write fixture");
        let error = validated_project_folder(file.to_string_lossy().into_owned())
            .expect_err("regular files must be rejected");
        assert!(error.contains("n’est pas un dossier"));
    }
}
