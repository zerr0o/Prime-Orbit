use crate::{
    paths::canonicalize,
    runtime::{capture_command_output, external_command, find_program},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::Output,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

const MAX_IMAGE_ATTACHMENT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT: usize = 20;
const MAX_CACHED_IMAGE_BYTES: u64 = 40 * 1024 * 1024;
const MAX_CACHED_IMAGE_COUNT: usize = 80;
const CACHED_IMAGE_TTL: Duration = Duration::from_secs(30 * 60);

fn supported_inline_image(mime_type: &str) -> bool {
    matches!(
        mime_type,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub name: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment_handle: Option<String>,
    pub size: u64,
    pub is_image: bool,
}

#[derive(Clone)]
pub struct AttachmentCache(Arc<Mutex<AttachmentCacheInner>>);

impl Default for AttachmentCache {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(AttachmentCacheInner::default())))
    }
}

#[derive(Default)]
struct AttachmentCacheInner {
    images: HashMap<String, CachedImage>,
    total_bytes: u64,
}

struct CachedImage {
    owner: String,
    mime_type: String,
    bytes: Vec<u8>,
    inserted_at: Instant,
    reserved: bool,
}

struct PreparedImage {
    name: String,
    mime_type: String,
    bytes: Vec<u8>,
}

enum PreparedAttachment {
    Image(PreparedImage),
    Document(AttachmentData),
}

pub(crate) struct ImageReservation {
    cache: AttachmentCache,
    owner: String,
    handles: Vec<String>,
    committed: bool,
}

impl ImageReservation {
    pub(crate) fn commit(mut self) {
        self.cache
            .finish_reservation(&self.owner, &self.handles, true);
        self.committed = true;
    }
}

impl Drop for ImageReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.cache
                .finish_reservation(&self.owner, &self.handles, false);
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

fn regular_file(path: PathBuf) -> Result<PathBuf, String> {
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

fn image_signature_matches(mime_type: &str, bytes: &[u8]) -> bool {
    match mime_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn read_selected_attachment(
    path: PathBuf,
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

    // Non-image documents deliberately remain external path references. Their
    // contents never cross the native/WebView boundary.
    if !is_image {
        let size = fs::metadata(&path)
            .map_err(|error| format!("Impossible d’inspecter {}: {error}", path.display()))?
            .len();
        return Ok(PreparedAttachment::Document(AttachmentData {
            path: Some(path.to_string_lossy().into_owned()),
            name,
            mime_type,
            attachment_handle: None,
            size,
            is_image: false,
        }));
    }

    // Open once, then derive both the real byte count and the cached content
    // from that same handle. A bounded max+1 read detects a file that grew
    // after metadata inspection without ever allocating unbounded memory.
    let allowed_bytes = MAX_IMAGE_ATTACHMENT_BYTES.min(remaining_image_bytes);
    let file = File::open(&path)
        .map_err(|error| format!("Impossible de lire {}: {error}", path.display()))?;
    let declared_size = file
        .metadata()
        .map_err(|error| format!("Impossible d’inspecter {}: {error}", path.display()))?
        .len();
    if declared_size > allowed_bytes {
        return Err(format!(
            "L’image fait {declared_size} octets; elle dépasse le budget restant de {allowed_bytes} octets"
        ));
    }
    let mut bytes = Vec::with_capacity(declared_size.min(allowed_bytes) as usize);
    file.take(allowed_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Impossible de lire {}: {error}", path.display()))?;
    if bytes.len() as u64 > allowed_bytes {
        return Err(format!(
            "L’image dépasse le budget restant de {allowed_bytes} octets"
        ));
    }
    if !image_signature_matches(&mime_type, &bytes) {
        return Err(format!(
            "{} ne contient pas une image {} valide",
            path.display(),
            mime_type
        ));
    }
    Ok(PreparedAttachment::Image(PreparedImage {
        name,
        mime_type,
        bytes,
    }))
}

fn purge_expired(inner: &mut AttachmentCacheInner, now: Instant) {
    let expired = inner
        .images
        .iter()
        .filter(|(_, image)| {
            !image.reserved && now.duration_since(image.inserted_at) >= CACHED_IMAGE_TTL
        })
        .map(|(handle, _)| handle.clone())
        .collect::<Vec<_>>();
    for handle in expired {
        if let Some(image) = inner.images.remove(&handle) {
            inner.total_bytes = inner.total_bytes.saturating_sub(image.bytes.len() as u64);
        }
    }
}

impl AttachmentCache {
    fn insert_prepared(
        &self,
        owner: &str,
        prepared: Vec<PreparedAttachment>,
    ) -> Result<Vec<AttachmentData>, String> {
        let new_count = prepared
            .iter()
            .filter(|attachment| matches!(attachment, PreparedAttachment::Image(_)))
            .count();
        let new_bytes = prepared
            .iter()
            .fold(0_u64, |total, attachment| match attachment {
                PreparedAttachment::Image(image) => total.saturating_add(image.bytes.len() as u64),
                PreparedAttachment::Document(_) => total,
            });
        let now = Instant::now();
        let mut inner = self.0.lock();
        purge_expired(&mut inner, now);
        if inner.images.len().saturating_add(new_count) > MAX_CACHED_IMAGE_COUNT
            || inner.total_bytes.saturating_add(new_bytes) > MAX_CACHED_IMAGE_BYTES
        {
            return Err(
                "Le cache sécurisé des images est plein. Envoyez ou retirez des images avant d’en joindre d’autres."
                    .to_string(),
            );
        }

        let mut result = Vec::with_capacity(prepared.len());
        for attachment in prepared {
            match attachment {
                PreparedAttachment::Document(document) => result.push(document),
                PreparedAttachment::Image(image) => {
                    let size = image.bytes.len() as u64;
                    let handle = Uuid::new_v4().to_string();
                    result.push(AttachmentData {
                        path: None,
                        name: image.name,
                        mime_type: image.mime_type.clone(),
                        attachment_handle: Some(handle.clone()),
                        size,
                        is_image: true,
                    });
                    inner.total_bytes = inner.total_bytes.saturating_add(size);
                    inner.images.insert(
                        handle,
                        CachedImage {
                            owner: owner.to_string(),
                            mime_type: image.mime_type,
                            bytes: image.bytes,
                            inserted_at: now,
                            reserved: false,
                        },
                    );
                }
            }
        }
        Ok(result)
    }

    fn reserve_images(
        &self,
        owner: &str,
        handles: &[String],
    ) -> Result<Vec<(String, String, Vec<u8>)>, String> {
        let mut inner = self.0.lock();
        purge_expired(&mut inner, Instant::now());
        let mut total_bytes = 0_u64;
        for handle in handles {
            let image = inner.images.get(handle).ok_or_else(|| {
                "Une image jointe a expiré ou n’est plus disponible. Sélectionnez-la de nouveau."
                    .to_string()
            })?;
            if image.owner != owner {
                return Err("Cette image jointe appartient à une autre fenêtre.".to_string());
            }
            if image.reserved {
                return Err("Cette image jointe est déjà en cours d’envoi.".to_string());
            }
            total_bytes = total_bytes.saturating_add(image.bytes.len() as u64);
        }
        if total_bytes > MAX_TOTAL_IMAGE_BYTES {
            return Err("Le total des images jointes dépasse 10 Mio.".to_string());
        }
        let resolved = handles
            .iter()
            .map(|handle| {
                let image = inner
                    .images
                    .get_mut(handle)
                    .expect("validated image handle");
                image.reserved = true;
                (handle.clone(), image.mime_type.clone(), image.bytes.clone())
            })
            .collect();
        Ok(resolved)
    }

    fn finish_reservation(&self, owner: &str, handles: &[String], consume: bool) {
        let mut inner = self.0.lock();
        for handle in handles {
            if consume {
                let removable = inner
                    .images
                    .get(handle)
                    .is_some_and(|image| image.owner == owner && image.reserved);
                if removable {
                    if let Some(image) = inner.images.remove(handle) {
                        inner.total_bytes =
                            inner.total_bytes.saturating_sub(image.bytes.len() as u64);
                    }
                }
            } else if let Some(image) = inner.images.get_mut(handle) {
                if image.owner == owner {
                    image.reserved = false;
                }
            }
        }
    }

    fn release(&self, owner: &str, handles: &[String]) {
        let mut inner = self.0.lock();
        for handle in handles {
            let removable = inner
                .images
                .get(handle)
                .is_some_and(|image| image.owner == owner && !image.reserved);
            if removable {
                if let Some(image) = inner.images.remove(handle) {
                    inner.total_bytes = inner.total_bytes.saturating_sub(image.bytes.len() as u64);
                }
            }
        }
    }

    fn release_owner(&self, owner: &str) {
        let mut inner = self.0.lock();
        let handles = inner
            .images
            .iter()
            .filter(|(_, image)| image.owner == owner)
            .map(|(handle, _)| handle.clone())
            .collect::<Vec<_>>();
        for handle in handles {
            if let Some(image) = inner.images.remove(&handle) {
                inner.total_bytes = inner.total_bytes.saturating_sub(image.bytes.len() as u64);
            }
        }
    }
}

pub(crate) fn hydrate_prompt_images(
    cache: AttachmentCache,
    owner: &str,
    payload: &mut Value,
) -> Result<Option<ImageReservation>, String> {
    if payload.get("images").is_some()
        && payload.get("type").and_then(Value::as_str) != Some("prompt")
    {
        return Err("Les images ne sont acceptées que dans une requête prompt.".to_string());
    }
    let Some(images_value) = payload.get_mut("images") else {
        return Ok(None);
    };
    let images = images_value
        .as_array_mut()
        .ok_or_else(|| "Le champ images doit être une liste.".to_string())?;
    if images.len() > MAX_ATTACHMENT_COUNT {
        return Err(format!(
            "Vous pouvez joindre au maximum {MAX_ATTACHMENT_COUNT} images"
        ));
    }
    if images.is_empty() {
        return Ok(None);
    }

    let mut unique = HashSet::with_capacity(images.len());
    let mut handles = Vec::with_capacity(images.len());
    for image in images.iter() {
        let object = image
            .as_object()
            .ok_or_else(|| "Chaque image jointe doit être un objet.".to_string())?;
        let handle = object
            .get("attachmentHandle")
            .and_then(Value::as_str)
            .ok_or_else(|| "Une image jointe ne possède pas de handle sécurisé.".to_string())?;
        if Uuid::parse_str(handle).is_err() || !unique.insert(handle.to_string()) {
            return Err("Un handle d’image jointe est invalide ou dupliqué.".to_string());
        }
        handles.push(handle.to_string());
    }

    let resolved = cache.reserve_images(owner, &handles)?;
    for (image, (_, mime_type, bytes)) in images.iter_mut().zip(resolved) {
        *image = serde_json::json!({
            "type": "image",
            "data": STANDARD.encode(bytes),
            "mimeType": mime_type,
        });
    }
    Ok(Some(ImageReservation {
        cache,
        owner: owner.to_string(),
        handles,
        committed: false,
    }))
}

#[tauri::command]
pub async fn pick_attachments(
    window: WebviewWindow,
    cache: tauri::State<'_, AttachmentCache>,
    remaining_count: usize,
    remaining_image_bytes: u64,
) -> Result<Vec<AttachmentData>, String> {
    if remaining_count > MAX_ATTACHMENT_COUNT || remaining_image_bytes > MAX_TOTAL_IMAGE_BYTES {
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
                    "png", "jpg", "jpeg", "webp", "gif", "md", "txt", "json", "ts",
                    "tsx", "js", "jsx", "py", "rs", "toml", "yaml", "yml", "pdf",
                ],
            )
            .blocking_pick_files()
            .unwrap_or_default();
        if selected.len() > remaining_count {
            return Err(format!(
                "Vous pouvez encore joindre {remaining_count} fichier(s)"
            ));
        }

        let mut prepared = Vec::with_capacity(selected.len());
        let mut total_image_bytes = 0_u64;
        for selected_path in selected {
            let path = selected_path
                .into_path()
                .map_err(|error| format!("Chemin de pièce jointe invalide: {error}"))?;
            let available = remaining_image_bytes.saturating_sub(total_image_bytes);
            let attachment = read_selected_attachment(path, available)?;
            if let PreparedAttachment::Image(image) = &attachment {
                total_image_bytes = total_image_bytes.saturating_add(image.bytes.len() as u64);
                if total_image_bytes > remaining_image_bytes {
                    return Err(
                        "Le total des images jointes dépasse 10 Mio; réduisez leur taille ou leur nombre"
                            .to_string(),
                    );
                }
            }
            prepared.push(attachment);
        }
        cache.insert_prepared(&owner, prepared)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn release_attachment_handles(
    window: WebviewWindow,
    cache: tauri::State<'_, AttachmentCache>,
    handles: Vec<String>,
) -> Result<(), String> {
    if handles.len() > MAX_CACHED_IMAGE_COUNT
        || handles
            .iter()
            .any(|handle| Uuid::parse_str(handle).is_err())
    {
        return Err("La liste des handles d’images est invalide.".to_string());
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

fn git_output(git: &Path, cwd: &Path, arguments: &[&str]) -> Result<Output, String> {
    let mut all_arguments = vec![OsString::from("-C"), cwd.as_os_str().to_owned()];
    all_arguments.extend(arguments.iter().map(OsString::from));
    let mut command = external_command(git, &all_arguments);
    capture_command_output(&mut command)
}

#[cfg(test)]
mod attachment_tests {
    use super::{
        hydrate_prompt_images, read_selected_attachment, AttachmentCache, PreparedAttachment,
        PreparedImage, CACHED_IMAGE_TTL, MAX_IMAGE_ATTACHMENT_BYTES,
    };
    use serde_json::json;
    use std::{fs, io::Write, time::Instant};

    fn prepared_image(name: &str, bytes: &[u8]) -> PreparedAttachment {
        PreparedAttachment::Image(PreparedImage {
            name: name.to_string(),
            mime_type: "image/png".to_string(),
            bytes: bytes.to_vec(),
        })
    }

    #[test]
    fn keeps_explicit_external_document_as_a_path_without_copying_its_contents() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("outside-project.txt");
        fs::write(&path, b"external document").expect("write fixture");

        let PreparedAttachment::Document(attachment) =
            read_selected_attachment(path, MAX_IMAGE_ATTACHMENT_BYTES)
                .expect("read attachment metadata")
        else {
            panic!("expected document")
        };
        assert!(!attachment.is_image);
        assert_eq!(attachment.size, 17);
        assert!(attachment.attachment_handle.is_none());
        assert!(attachment
            .path
            .as_deref()
            .is_some_and(|path| path.ends_with("outside-project.txt")));
    }

    #[test]
    fn keeps_svg_as_a_path_instead_of_embedding_active_markup() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("diagram.svg");
        fs::write(&path, br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#).expect("write fixture");

        let PreparedAttachment::Document(attachment) =
            read_selected_attachment(path, MAX_IMAGE_ATTACHMENT_BYTES).expect("read SVG metadata")
        else {
            panic!("expected document")
        };
        assert!(!attachment.is_image);
        assert!(attachment.attachment_handle.is_none());
    }

    #[test]
    fn rejects_an_oversized_image_before_reading_it_into_memory() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("oversized.png");
        let mut file = fs::File::create(&path).expect("create fixture");
        file.write_all(b"png").expect("write fixture prefix");
        file.set_len(MAX_IMAGE_ATTACHMENT_BYTES + 1)
            .expect("extend sparse fixture");

        let error = read_selected_attachment(path, MAX_IMAGE_ATTACHMENT_BYTES)
            .err()
            .expect("oversized image must be rejected");
        assert!(error.contains("budget restant"));
    }

    #[test]
    fn exposes_only_an_opaque_handle_and_metadata_for_images() {
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
    }

    #[test]
    fn owner_scoped_reservation_is_retryable_until_a_successful_write() {
        let cache = AttachmentCache::default();
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
        let foreign = hydrate_prompt_images(cache.clone(), "window-b", &mut foreign_payload)
            .err()
            .expect("foreign owner must be rejected");
        assert!(foreign.contains("autre fenêtre"));

        let mut failed_write_payload = make_payload();
        let reservation =
            hydrate_prompt_images(cache.clone(), "window-a", &mut failed_write_payload)
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
        let reservation = hydrate_prompt_images(cache.clone(), "window-a", &mut retry_payload)
            .expect("retry after failed write")
            .expect("retry reservation");
        reservation.commit();

        let mut consumed_payload = make_payload();
        let consumed = hydrate_prompt_images(cache, "window-a", &mut consumed_payload)
            .err()
            .expect("successful write consumes the handle");
        assert!(consumed.contains("expiré") || consumed.contains("disponible"));
    }

    #[test]
    fn cache_rejects_an_unbounded_number_of_pending_images() {
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
    fn expired_handles_are_purged_before_rpc_hydration() {
        let cache = AttachmentCache::default();
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
            .images
            .get_mut(&handle)
            .expect("cached image")
            .inserted_at = Instant::now() - CACHED_IMAGE_TTL;
        let mut payload = json!({
            "type": "prompt",
            "images": [{"type": "image", "attachmentHandle": handle}]
        });
        let error = match hydrate_prompt_images(cache.clone(), "window-a", &mut payload) {
            Err(error) => error,
            Ok(_) => panic!("expired handle accepted"),
        };
        assert!(error.contains("expiré"));
        assert!(cache.0.lock().images.is_empty());
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
    use super::{parse_porcelain_z, validated_project_folder};
    use std::fs;

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
