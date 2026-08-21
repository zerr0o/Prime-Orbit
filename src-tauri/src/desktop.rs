use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, WebviewWindow,
};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ID: &str = "prime-orbit-tray";
const TRAY_OPEN_ID: &str = "prime-orbit-tray-open";
const TRAY_QUIT_ID: &str = "prime-orbit-tray-quit";

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "La fenêtre principale de Prime Orbit est introuvable.".to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

pub(crate) fn setup_tray(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app)
        .text(TRAY_OPEN_ID, "Ouvrir Prime Orbit")
        .separator()
        .text(TRAY_QUIT_ID, "Quitter Prime Orbit")
        .build()?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Prime Orbit")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_OPEN_ID => {
                let _ = show_main_window(app);
            }
            TRAY_QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                let _ = show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn hide_window_to_tray(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn quit_prime_orbit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub(crate) fn set_tray_language(app: AppHandle, language: String) -> Result<(), String> {
    let (open_label, quit_label) = if language.eq_ignore_ascii_case("en") {
        ("Open Prime Orbit", "Quit Prime Orbit")
    } else {
        ("Ouvrir Prime Orbit", "Quitter Prime Orbit")
    };
    let menu = MenuBuilder::new(&app)
        .text(TRAY_OPEN_ID, open_label)
        .separator()
        .text(TRAY_QUIT_ID, quit_label)
        .build()
        .map_err(|error| error.to_string())?;
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "L’icône de notification Prime Orbit est introuvable.".to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())
}
