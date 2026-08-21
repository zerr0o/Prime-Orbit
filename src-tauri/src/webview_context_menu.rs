use parking_lot::Mutex;
use serde::Serialize;
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
use tauri::{Emitter, EventTarget};
use webview2_com::{
    take_pwstr, ContextMenuRequestedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ContextMenuItem, ICoreWebView2ContextMenuItemCollection,
        ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2Deferral, ICoreWebView2_11,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU,
    },
};
use windows::{
    core::{Interface, BOOL, PWSTR},
    Win32::Foundation::POINT,
};

const CONTEXT_MENU_EVENT: &str = "prime-orbit://webview-context-menu";
const MAX_CONTEXT_MENU_ITEMS: usize = 32;
const MAX_CONTEXT_MENU_NAME_CHARS: usize = 64;
const MAX_CONTEXT_MENU_LABEL_CHARS: usize = 160;
const MAX_CONTEXT_MENU_SHORTCUT_CHARS: usize = 48;
const CONTEXT_MENU_WATCHDOG: Duration = Duration::from_secs(30);
const INSTALL_REGISTRATION_TIMEOUT: Duration = Duration::from_secs(5);
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub(crate) struct ContextMenuRegistry {
    installed_windows: Mutex<HashSet<String>>,
}

impl ContextMenuRegistry {
    fn reserve(&self, label: &str) -> bool {
        self.installed_windows.lock().insert(label.to_owned())
    }

    fn release(&self, label: &str) {
        self.installed_windows.lock().remove(label);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextMenuItemPayload {
    command_id: i32,
    name: String,
    label: String,
    shortcut: String,
    enabled: bool,
    group: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextMenuPayload {
    request_id: String,
    x: i32,
    y: i32,
    items: Vec<ContextMenuItemPayload>,
}

struct PendingContextMenu {
    request_id: String,
    allowed_command_ids: HashSet<i32>,
    args: ICoreWebView2ContextMenuRequestedEventArgs,
    deferral: ICoreWebView2Deferral,
}

impl PendingContextMenu {
    fn complete(self, command_id: Option<i32>) {
        unsafe {
            if let Some(command_id) = validated_command_id(&self.allowed_command_ids, command_id) {
                let _ = self.args.SetSelectedCommandId(command_id);
            }
            let _ = self.deferral.Complete();
        }
    }
}

fn validated_command_id(allowed: &HashSet<i32>, requested: Option<i32>) -> Option<i32> {
    requested.filter(|command_id| allowed.contains(command_id))
}

// WebView2's context-menu objects are apartment-bound COM interfaces. Keeping
// pending deferrals on the WebView UI thread avoids moving them through
// Tauri's async command threads. `with_webview` resolves selections back on
// that same thread.
thread_local! {
    static PENDING_CONTEXT_MENUS: RefCell<HashMap<String, PendingContextMenu>> =
        RefCell::new(HashMap::new());
}

fn is_editing_menu_item(name: &str) -> bool {
    matches!(
        name,
        "undo" | "redo" | "cut" | "copy" | "paste" | "pasteAndMatchStyle" | "delete" | "selectAll"
    )
}

fn normalize_native_label(label: &str) -> String {
    let mut normalized = String::with_capacity(label.len());
    let mut characters = label.chars().peekable();
    while let Some(character) = characters.next() {
        if character != '&' {
            normalized.push(character);
            continue;
        }
        if characters.peek() == Some(&'&') {
            normalized.push('&');
            characters.next();
        }
    }
    normalized
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

unsafe fn read_string(
    read: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>,
) -> windows::core::Result<String> {
    let mut value = PWSTR::null();
    read(&mut value)?;
    Ok(take_pwstr(value))
}

unsafe fn append_context_menu_item(
    item: &ICoreWebView2ContextMenuItem,
    inherited_spellcheck: bool,
    payloads: &mut Vec<ContextMenuItemPayload>,
) -> windows::core::Result<()> {
    if payloads.len() >= MAX_CONTEXT_MENU_ITEMS {
        return Ok(());
    }

    let name = bounded_text(
        &unsafe { read_string(|value| item.Name(value))? },
        MAX_CONTEXT_MENU_NAME_CHARS,
    );
    let is_spellcheck = inherited_spellcheck || name.eq_ignore_ascii_case("spellcheck");
    let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
    unsafe { item.Kind(&mut kind)? };

    if kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU {
        if is_spellcheck {
            let children = unsafe { item.Children()? };
            unsafe { append_context_menu_items(&children, true, payloads)? };
        }
        return Ok(());
    }
    if kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR
        || (!is_spellcheck && !is_editing_menu_item(&name))
    {
        return Ok(());
    }

    let label = bounded_text(
        &normalize_native_label(&unsafe { read_string(|value| item.Label(value))? }),
        MAX_CONTEXT_MENU_LABEL_CHARS,
    );
    // WebView2 151 exposes asynchronous spelling placeholders here with empty
    // labels. Windows' spell checker supplies their actual text separately.
    if label.trim().is_empty() {
        return Ok(());
    }
    let shortcut = bounded_text(
        &unsafe { read_string(|value| item.ShortcutKeyDescription(value))? },
        MAX_CONTEXT_MENU_SHORTCUT_CHARS,
    );
    let mut command_id = -1;
    let mut enabled = BOOL::default();
    unsafe {
        item.CommandId(&mut command_id)?;
        item.IsEnabled(&mut enabled)?;
    }
    payloads.push(ContextMenuItemPayload {
        command_id,
        name,
        label,
        shortcut,
        enabled: enabled.as_bool(),
        group: if is_spellcheck { "spelling" } else { "edit" },
    });
    Ok(())
}

unsafe fn append_context_menu_items(
    items: &ICoreWebView2ContextMenuItemCollection,
    inherited_spellcheck: bool,
    payloads: &mut Vec<ContextMenuItemPayload>,
) -> windows::core::Result<()> {
    let mut count = 0;
    unsafe { items.Count(&mut count)? };
    for index in 0..count {
        if payloads.len() >= MAX_CONTEXT_MENU_ITEMS {
            break;
        }
        let item = unsafe { items.GetValueAtIndex(index)? };
        unsafe { append_context_menu_item(&item, inherited_spellcheck, payloads)? };
    }
    Ok(())
}

fn finish_pending(label: &str, request_id: Option<&str>, command_id: Option<i32>) {
    let pending = PENDING_CONTEXT_MENUS.with(|menus| {
        let mut menus = menus.borrow_mut();
        let matches_request = menus
            .get(label)
            .is_some_and(|pending| request_id.is_none_or(|id| pending.request_id == id));
        matches_request.then(|| menus.remove(label)).flatten()
    });
    if let Some(pending) = pending {
        pending.complete(command_id);
    }
}

fn schedule_context_menu_watchdog(window: tauri::WebviewWindow, label: String, request_id: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CONTEXT_MENU_WATCHDOG).await;
        let _ = window.with_webview(move |_| {
            finish_pending(&label, Some(&request_id), None);
        });
    });
}

unsafe fn register_context_menu_bridge(
    controller: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    window: tauri::WebviewWindow,
) -> windows::core::Result<()> {
    let webview = unsafe { controller.CoreWebView2()? };
    let webview: ICoreWebView2_11 = webview.cast()?;
    let label = window.label().to_owned();
    let handler = ContextMenuRequestedEventHandler::create(Box::new(move |_sender, args| {
        let Some(args) = args else {
            return Ok(());
        };
        unsafe {
            let target = args.ContextMenuTarget()?;
            let mut is_editable = BOOL::default();
            target.IsEditable(&mut is_editable)?;
            if !is_editable.as_bool() {
                return Ok(());
            }

            let mut items = Vec::new();
            append_context_menu_items(&args.MenuItems()?, false, &mut items)?;
            if items.is_empty() {
                return Ok(());
            }

            let mut location = POINT::default();
            args.Location(&mut location)?;
            let request_id = format!(
                "{}:{}",
                label,
                NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
            );
            let deferral = args.GetDeferral()?;
            args.SetHandled(true)?;
            let allowed_command_ids = items
                .iter()
                .filter(|item| item.enabled)
                .map(|item| item.command_id)
                .collect();

            let previous = PENDING_CONTEXT_MENUS.with(|menus| {
                menus.borrow_mut().insert(
                    label.clone(),
                    PendingContextMenu {
                        request_id: request_id.clone(),
                        allowed_command_ids,
                        args: args.clone(),
                        deferral,
                    },
                )
            });
            if let Some(previous) = previous {
                previous.complete(None);
            }
            schedule_context_menu_watchdog(window.clone(), label.clone(), request_id.clone());

            let payload = ContextMenuPayload {
                request_id: request_id.clone(),
                x: location.x,
                y: location.y,
                items,
            };
            if window
                .emit_to(
                    EventTarget::webview_window(label.clone()),
                    CONTEXT_MENU_EVENT,
                    payload,
                )
                .is_err()
            {
                finish_pending(&label, Some(&request_id), None);
            }
        }
        Ok(())
    }));
    let mut token = 0;
    unsafe { webview.add_ContextMenuRequested(&handler, &mut token)? };
    Ok(())
}

#[tauri::command]
pub(crate) async fn install_webview_context_menu(
    window: tauri::WebviewWindow,
    registry: tauri::State<'_, ContextMenuRegistry>,
) -> Result<(), String> {
    let label = window.label().to_owned();
    if !registry.reserve(&label) {
        return Ok(());
    }

    let (registration_sender, registration_receiver) = mpsc::sync_channel(1);
    let cancelled = Arc::new(AtomicBool::new(false));
    let webview_cancelled = cancelled.clone();
    let event_window = window.clone();
    if let Err(error) = window.with_webview(move |webview| {
        if webview_cancelled.load(Ordering::Acquire) {
            let _ = registration_sender.send(Err(
                "L’installation du menu contextuel WebView2 a expiré.".to_owned(),
            ));
            return;
        }
        let result = unsafe { register_context_menu_bridge(webview.controller(), event_window) }
            .map_err(|error| error.to_string());
        let _ = registration_sender.send(result);
    }) {
        registry.release(&label);
        return Err(format!(
            "Prime Orbit could not access the WebView2 context menu: {error}"
        ));
    }

    let registration = tauri::async_runtime::spawn_blocking(move || {
        registration_receiver.recv_timeout(INSTALL_REGISTRATION_TIMEOUT)
    })
    .await
    .map_err(|error| format!("L’installation du menu contextuel s’est interrompue: {error}"));

    match registration {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => {
            registry.release(&label);
            Err(format!(
                "Prime Orbit could not bridge the WebView2 context menu: {error}"
            ))
        }
        Ok(Err(mpsc::RecvTimeoutError::Timeout)) => {
            cancelled.store(true, Ordering::Release);
            registry.release(&label);
            Err("L’installation du menu contextuel WebView2 a dépassé 5 secondes.".to_owned())
        }
        Ok(Err(mpsc::RecvTimeoutError::Disconnected)) => {
            cancelled.store(true, Ordering::Release);
            registry.release(&label);
            Err("L’installation du menu contextuel WebView2 a été interrompue.".to_owned())
        }
        Err(error) => {
            cancelled.store(true, Ordering::Release);
            registry.release(&label);
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) fn resolve_webview_context_menu(
    window: tauri::WebviewWindow,
    request_id: String,
    command_id: Option<i32>,
) -> Result<(), String> {
    let label = window.label().to_owned();
    window
        .with_webview(move |_| {
            finish_pending(&label, Some(&request_id), command_id);
        })
        .map_err(|error| format!("Prime Orbit could not close the context menu: {error}"))
}

pub(crate) fn discard_window(label: &str, registry: &ContextMenuRegistry) {
    finish_pending(label, None, None);
    registry.release(label);
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{
        bounded_text, is_editing_menu_item, normalize_native_label, validated_command_id,
        MAX_CONTEXT_MENU_ITEMS, MAX_CONTEXT_MENU_LABEL_CHARS, MAX_CONTEXT_MENU_SHORTCUT_CHARS,
    };

    #[test]
    fn keeps_only_standard_text_editing_commands() {
        for name in [
            "undo",
            "redo",
            "cut",
            "copy",
            "paste",
            "pasteAndMatchStyle",
            "delete",
            "selectAll",
        ] {
            assert!(is_editing_menu_item(name), "expected {name} to remain");
        }
        for name in [
            "inspectElement",
            "castMediaRoute",
            "share",
            "sendTabToSelf",
            "searchWebFor",
            "extension",
            "emoji",
        ] {
            assert!(
                !is_editing_menu_item(name),
                "expected {name} to be excluded"
            );
        }
    }

    #[test]
    fn converts_windows_accelerators_to_visible_labels() {
        assert_eq!(normalize_native_label("&Couper"), "Couper");
        assert_eq!(normalize_native_label("R&&D"), "R&D");
        assert_eq!(
            normalize_native_label("&Ajouter au dictionnaire"),
            "Ajouter au dictionnaire"
        );
    }

    #[test]
    fn bounds_native_menu_payloads() {
        assert_eq!(MAX_CONTEXT_MENU_ITEMS, 32);
        assert_eq!(
            bounded_text(
                &"é".repeat(MAX_CONTEXT_MENU_LABEL_CHARS + 20),
                MAX_CONTEXT_MENU_LABEL_CHARS
            )
            .chars()
            .count(),
            MAX_CONTEXT_MENU_LABEL_CHARS
        );
        assert_eq!(
            bounded_text(&"Ctrl+TrèsLong".repeat(20), MAX_CONTEXT_MENU_SHORTCUT_CHARS)
                .chars()
                .count(),
            MAX_CONTEXT_MENU_SHORTCUT_CHARS
        );
    }

    #[test]
    fn executes_only_commands_exposed_by_the_current_menu() {
        let allowed = HashSet::from([7, 11]);
        assert_eq!(validated_command_id(&allowed, Some(11)), Some(11));
        assert_eq!(validated_command_id(&allowed, Some(99)), None);
        assert_eq!(validated_command_id(&allowed, None), None);
    }
}
