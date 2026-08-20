mod agents;
mod connections;
mod exports;
mod files;
mod install;
#[cfg(windows)]
mod node_compat;
mod paths;
mod runtime;
mod session_history;
mod session_lease;
mod storage;
mod updater;

use agents::AgentsState;
use exports::HtmlExportState;
use files::AttachmentCache;
use install::InstallState;
use serde::Serialize;
use storage::PersistenceLock;
use tauri::{Emitter, Manager};
use updater::UpdateManager;

pub(crate) const MAX_RPC_BYTES: usize = 16 * 1024 * 1024;

/// Moves filesystem and process work off Tauri's command executor. Keeping
/// command futures lightweight is especially important during startup, when
/// Windows uses the same message pump to decide whether the WebView is
/// responsive.
pub(crate) async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Une tâche native s’est interrompue: {error}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecondInstanceEvent {
    arguments: Vec<String>,
    cwd: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // The single-instance plugin must be initialized first so a second
        // launch never races application setup or process state initialization.
        .plugin(tauri_plugin_single_instance::init(|app, arguments, cwd| {
            let _ = app.emit(
                "prime-orbit://second-instance",
                SecondInstanceEvent { arguments, cwd },
            );
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AgentsState::default())
        .manage(AttachmentCache::default())
        .manage(HtmlExportState::default())
        .manage(InstallState::default())
        .manage(PersistenceLock::default())
        .manage(UpdateManager::default())
        .invoke_handler(tauri::generate_handler![
            runtime::detect_prime_agent,
            runtime::diagnose_prerequisites,
            runtime::get_runtime_config,
            runtime::save_runtime_config,
            runtime::open_prime_agent_terminal,
            agents::start_agent,
            agents::release_agent,
            agents::send_rpc,
            agents::mutate_agent_queue,
            agents::reload_agent_resources,
            agents::stop_agent,
            agents::restart_agent,
            agents::list_running_agents,
            session_history::load_session_history,
            session_history::list_prime_agent_sessions,
            storage::load_app_state,
            storage::save_app_state,
            storage::read_models_json,
            storage::save_models_json,
            install::quick_install_prime_agent,
            install::is_prime_agent_installing,
            files::pick_attachments,
            files::admit_dropped_attachment,
            files::release_attachment_handles,
            exports::begin_html_export,
            exports::complete_html_export,
            exports::cancel_html_export,
            files::list_git_changes,
            files::get_git_file_diff,
            files::open_project_folder,
            files::open_git_file_folder,
            connections::inspect_prime_agent_connections,
            connections::check_ollama_health,
            connections::save_mcp_server,
            connections::delete_mcp_server,
            updater::get_app_update_state,
            updater::check_for_app_updates,
            updater::download_app_update,
            updater::install_app_update,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Prime Orbit");

    if let Ok(app_data_dir) = app.path().app_data_dir() {
        tauri::async_runtime::spawn_blocking(move || {
            files::cleanup_fallback_attachment_artifacts_throttled(&app_data_dir);
        });
    }

    app.run(|app, event| match event {
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            // Window destruction can happen without React getting an unmount
            // callback. Release its process leases away from the UI thread;
            // active agents are retained until their agent_end boundary.
            let agents = app.state::<AgentsState>().inner().clone();
            let attachments = app.state::<AttachmentCache>().inner().clone();
            let exports = app.state::<HtmlExportState>().inner().clone();
            let attachment_owner = label.clone();
            tauri::async_runtime::spawn_blocking(move || {
                agents::release_window_agents(agents, label);
                files::release_window_attachments(attachments, &attachment_owner);
                exports::release_window_exports(exports, &attachment_owner);
            });
        }
        tauri::RunEvent::ExitRequested { .. } => {
            let agents = app.state::<AgentsState>();
            agents::shutdown_all_agents(app, &agents);
        }
        _ => {}
    });
}
