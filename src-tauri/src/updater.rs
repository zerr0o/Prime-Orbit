use crate::agents::{
    begin_update_installation, running_agent_count, shutdown_all_agents_for_update, AgentsState,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub const UPDATE_STATE_EVENT: &str = "prime-orbit://update-state";

const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const AUTOMATIC_CHECK_TTL_MS: u64 = 24 * 60 * 60 * 1_000;
const AUTOMATIC_ERROR_BACKOFF_MS: u64 = 15 * 60 * 1_000;
const PROGRESS_EMIT_INTERVAL_MS: u64 = 100;
const MAX_UPDATE_NOTES_CHARS: usize = 16 * 1_024;
const MAX_UPDATE_ERROR_CHARS: usize = 2 * 1_024;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateCheckTrigger {
    Automatic,
    Manual,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AppUpdatePhase {
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Ready,
    Installing,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AppUpdateOperation {
    Check,
    Download,
    Install,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateMetadata {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
}

/// The process-wide updater snapshot. Its serialized shape intentionally mirrors
/// `AppUpdateState` in `src/types.ts`; every window receives the same snapshot.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateState {
    /// Monotonic process-local revision used by every window to reject stale
    /// command responses that arrive after a newer broadcast event.
    pub revision: u64,
    pub phase: AppUpdatePhase,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<AppUpdateMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<AppUpdateOperation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<UpdateCheckTrigger>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InstallAppUpdateResult {
    Installing,
    Busy { active_agents: usize },
}

#[derive(Clone)]
pub struct UpdateManager(Arc<Mutex<UpdateManagerInner>>);

struct UpdateManagerInner {
    coordinator: UpdateCoordinator,
    pending_update: Option<Update>,
    verified_bytes: Option<Arc<[u8]>>,
}

impl Default for UpdateManager {
    fn default() -> Self {
        Self::new(env!("CARGO_PKG_VERSION"))
    }
}

impl UpdateManager {
    fn new(current_version: impl Into<String>) -> Self {
        Self(Arc::new(Mutex::new(UpdateManagerInner {
            coordinator: UpdateCoordinator::new(current_version),
            pending_update: None,
            verified_bytes: None,
        })))
    }

    fn snapshot(&self) -> AppUpdateState {
        self.0.lock().coordinator.snapshot.clone()
    }

    fn begin_check(&self, trigger: UpdateCheckTrigger, now_ms: u64) -> BeginOperation {
        let mut inner = self.0.lock();
        let has_pending_update = inner.pending_update.is_some();
        let result = inner
            .coordinator
            .begin_check(trigger, has_pending_update, now_ms);
        if matches!(result, BeginOperation::Started { .. }) {
            inner.pending_update = None;
            inner.verified_bytes = None;
        }
        result
    }

    fn finish_check_available(
        &self,
        token: u64,
        update: Update,
        completed_at_ms: u64,
        completed_at: String,
    ) -> Option<AppUpdateState> {
        let metadata = update_metadata(&update);
        let mut inner = self.0.lock();
        let snapshot = inner.coordinator.finish_check(
            token,
            CheckOutcome::Available(metadata),
            completed_at_ms,
            completed_at,
        )?;
        inner.pending_update = Some(update);
        inner.verified_bytes = None;
        Some(snapshot)
    }

    fn finish_check_up_to_date(
        &self,
        token: u64,
        completed_at_ms: u64,
        completed_at: String,
    ) -> Option<AppUpdateState> {
        let mut inner = self.0.lock();
        let snapshot = inner.coordinator.finish_check(
            token,
            CheckOutcome::UpToDate,
            completed_at_ms,
            completed_at,
        )?;
        inner.pending_update = None;
        inner.verified_bytes = None;
        Some(snapshot)
    }

    fn finish_check_error(
        &self,
        token: u64,
        error: impl ToString,
        completed_at_ms: u64,
    ) -> Option<AppUpdateState> {
        let mut inner = self.0.lock();
        let snapshot = inner.coordinator.finish_check(
            token,
            CheckOutcome::Error(bounded_text(&error.to_string(), MAX_UPDATE_ERROR_CHARS)),
            completed_at_ms,
            rfc3339_now(),
        )?;
        inner.pending_update = None;
        inner.verified_bytes = None;
        Some(snapshot)
    }

    fn begin_download(&self, now_ms: u64) -> BeginDownload {
        let mut inner = self.0.lock();
        let Some(update) = inner.pending_update.clone() else {
            return BeginDownload::Unavailable(inner.coordinator.snapshot.clone());
        };
        match inner.coordinator.begin_download(true, now_ms) {
            BeginOperation::Started { token, snapshot } => {
                inner.verified_bytes = None;
                BeginDownload::Started {
                    token,
                    snapshot,
                    update: Box::new(update),
                }
            }
            BeginOperation::Existing { snapshot } => BeginDownload::Existing(snapshot),
        }
    }

    /// Updates the authoritative byte counters for every chunk, but only returns
    /// a snapshot when an integer percentage changes or the 100 ms throttle elapses.
    fn record_download_progress(
        &self,
        token: u64,
        chunk_length: usize,
        content_length: Option<u64>,
        now_ms: u64,
    ) -> Option<AppUpdateState> {
        self.0.lock().coordinator.record_download_progress(
            token,
            chunk_length,
            content_length,
            now_ms,
        )
    }

    fn finish_download_ready(&self, token: u64, verified_bytes: Vec<u8>) -> Option<AppUpdateState> {
        let verified_bytes: Arc<[u8]> = verified_bytes.into();
        let downloaded_bytes = u64::try_from(verified_bytes.len()).unwrap_or(u64::MAX);
        let mut inner = self.0.lock();
        let snapshot = inner
            .coordinator
            .finish_download(token, DownloadOutcome::Ready(downloaded_bytes))?;
        inner.verified_bytes = Some(verified_bytes);
        Some(snapshot)
    }

    fn finish_download_error(&self, token: u64, error: impl ToString) -> Option<AppUpdateState> {
        self.0.lock().coordinator.finish_download(
            token,
            DownloadOutcome::Error(bounded_text(&error.to_string(), MAX_UPDATE_ERROR_CHARS)),
        )
    }

    fn begin_install(&self) -> BeginInstall {
        let mut inner = self.0.lock();
        let Some(update) = inner.pending_update.clone() else {
            return BeginInstall::NotReady;
        };
        let Some(bytes) = inner.verified_bytes.clone() else {
            return BeginInstall::NotReady;
        };
        match inner.coordinator.begin_install() {
            BeginOperation::Started { snapshot, .. } => BeginInstall::Started {
                snapshot: Box::new(snapshot),
                update: Box::new(update),
                bytes,
            },
            BeginOperation::Existing { snapshot } => {
                if snapshot.phase == AppUpdatePhase::Installing {
                    BeginInstall::AlreadyInstalling
                } else {
                    BeginInstall::NotReady
                }
            }
        }
    }

    fn finish_install_error(&self, error: impl ToString) -> AppUpdateState {
        self.0
            .lock()
            .coordinator
            .finish_install_error(bounded_text(&error.to_string(), MAX_UPDATE_ERROR_CHARS))
    }
}

#[derive(Debug, Clone)]
enum BeginOperation {
    Started {
        token: u64,
        snapshot: AppUpdateState,
    },
    Existing {
        snapshot: AppUpdateState,
    },
}

enum BeginDownload {
    Started {
        token: u64,
        snapshot: AppUpdateState,
        update: Box<Update>,
    },
    Existing(AppUpdateState),
    Unavailable(AppUpdateState),
}

enum BeginInstall {
    Started {
        snapshot: Box<AppUpdateState>,
        update: Box<Update>,
        bytes: Arc<[u8]>,
    },
    AlreadyInstalling,
    NotReady,
}

enum CheckOutcome {
    Available(AppUpdateMetadata),
    UpToDate,
    Error(String),
}

enum DownloadOutcome {
    Ready(u64),
    Error(String),
}

struct UpdateCoordinator {
    current_version: String,
    snapshot: AppUpdateState,
    next_token: u64,
    next_revision: u64,
    active_token: Option<u64>,
    last_checked_at_ms: Option<u64>,
    last_checked_at: Option<String>,
    // Kept separately from a successful check so failures can be backed off
    // without extending the 24-hour freshness TTL.
    last_attempt_at_ms: Option<u64>,
    last_automatic_error_at_ms: Option<u64>,
    last_progress_emit_at_ms: Option<u64>,
    last_progress_percent: Option<u8>,
}

impl UpdateCoordinator {
    fn new(current_version: impl Into<String>) -> Self {
        let current_version = current_version.into();
        Self {
            snapshot: AppUpdateState {
                revision: 0,
                phase: AppUpdatePhase::Idle,
                current_version: current_version.clone(),
                update: None,
                downloaded_bytes: None,
                total_bytes: None,
                last_checked_at: None,
                error: None,
                operation: None,
                trigger: None,
            },
            current_version,
            next_token: 0,
            next_revision: 0,
            active_token: None,
            last_checked_at_ms: None,
            last_checked_at: None,
            last_attempt_at_ms: None,
            last_automatic_error_at_ms: None,
            last_progress_emit_at_ms: None,
            last_progress_percent: None,
        }
    }

    fn state(&self, phase: AppUpdatePhase) -> AppUpdateState {
        AppUpdateState {
            revision: self.snapshot.revision,
            phase,
            current_version: self.current_version.clone(),
            update: None,
            downloaded_bytes: None,
            total_bytes: None,
            last_checked_at: self.last_checked_at.clone(),
            error: None,
            operation: None,
            trigger: None,
        }
    }

    fn commit_state(&mut self, mut state: AppUpdateState) {
        self.next_revision = self.next_revision.saturating_add(1);
        state.revision = self.next_revision;
        self.snapshot = state;
    }

    fn touch_snapshot(&mut self) {
        self.next_revision = self.next_revision.saturating_add(1);
        self.snapshot.revision = self.next_revision;
    }

    fn next_operation_token(&mut self) -> u64 {
        self.next_token = self.next_token.checked_add(1).unwrap_or(1);
        self.next_token
    }

    fn begin_check(
        &mut self,
        trigger: UpdateCheckTrigger,
        has_pending_update: bool,
        now_ms: u64,
    ) -> BeginOperation {
        if has_pending_update
            || matches!(
                self.snapshot.phase,
                AppUpdatePhase::Checking
                    | AppUpdatePhase::Downloading
                    | AppUpdatePhase::Ready
                    | AppUpdatePhase::Installing
            )
            || (trigger == UpdateCheckTrigger::Automatic
                && (within_window(self.last_checked_at_ms, now_ms, AUTOMATIC_CHECK_TTL_MS)
                    || within_window(
                        self.last_automatic_error_at_ms,
                        now_ms,
                        AUTOMATIC_ERROR_BACKOFF_MS,
                    )))
        {
            return BeginOperation::Existing {
                snapshot: self.snapshot.clone(),
            };
        }

        let token = self.next_operation_token();
        self.active_token = Some(token);
        self.last_attempt_at_ms = Some(now_ms);
        let mut state = self.state(AppUpdatePhase::Checking);
        state.trigger = Some(trigger);
        self.commit_state(state);
        BeginOperation::Started {
            token,
            snapshot: self.snapshot.clone(),
        }
    }

    fn finish_check(
        &mut self,
        token: u64,
        outcome: CheckOutcome,
        completed_at_ms: u64,
        completed_at: String,
    ) -> Option<AppUpdateState> {
        if self.active_token != Some(token) || self.snapshot.phase != AppUpdatePhase::Checking {
            return None;
        }
        let trigger = self.snapshot.trigger.unwrap_or(UpdateCheckTrigger::Manual);
        self.active_token = None;

        match outcome {
            CheckOutcome::Available(update) => {
                self.last_checked_at_ms = Some(completed_at_ms);
                self.last_checked_at = Some(completed_at);
                self.last_automatic_error_at_ms = None;
                let mut state = self.state(AppUpdatePhase::Available);
                state.update = Some(update);
                state.trigger = Some(trigger);
                self.commit_state(state);
            }
            CheckOutcome::UpToDate => {
                self.last_checked_at_ms = Some(completed_at_ms);
                self.last_checked_at = Some(completed_at);
                self.last_automatic_error_at_ms = None;
                let mut state = self.state(AppUpdatePhase::UpToDate);
                state.trigger = Some(trigger);
                self.commit_state(state);
            }
            CheckOutcome::Error(error) => {
                if trigger == UpdateCheckTrigger::Automatic {
                    self.last_automatic_error_at_ms = Some(completed_at_ms);
                }
                let mut state = self.state(AppUpdatePhase::Error);
                state.error = Some(error);
                state.operation = Some(AppUpdateOperation::Check);
                state.trigger = Some(trigger);
                self.commit_state(state);
            }
        }
        Some(self.snapshot.clone())
    }

    fn begin_download(&mut self, has_pending_update: bool, now_ms: u64) -> BeginOperation {
        if matches!(
            self.snapshot.phase,
            AppUpdatePhase::Downloading | AppUpdatePhase::Ready | AppUpdatePhase::Installing
        ) {
            return BeginOperation::Existing {
                snapshot: self.snapshot.clone(),
            };
        }
        let can_retry = self.snapshot.phase == AppUpdatePhase::Error
            && self.snapshot.operation == Some(AppUpdateOperation::Download);
        let Some(update) = self
            .snapshot
            .update
            .clone()
            .filter(|_| has_pending_update)
            .filter(|_| self.snapshot.phase == AppUpdatePhase::Available || can_retry)
        else {
            return BeginOperation::Existing {
                snapshot: self.snapshot.clone(),
            };
        };

        let token = self.next_operation_token();
        self.active_token = Some(token);
        self.last_progress_emit_at_ms = Some(now_ms);
        self.last_progress_percent = Some(0);
        let mut state = self.state(AppUpdatePhase::Downloading);
        state.update = Some(update);
        state.downloaded_bytes = Some(0);
        self.commit_state(state);
        BeginOperation::Started {
            token,
            snapshot: self.snapshot.clone(),
        }
    }

    fn record_download_progress(
        &mut self,
        token: u64,
        chunk_length: usize,
        content_length: Option<u64>,
        now_ms: u64,
    ) -> Option<AppUpdateState> {
        if self.active_token != Some(token) || self.snapshot.phase != AppUpdatePhase::Downloading {
            return None;
        }

        let chunk_length = u64::try_from(chunk_length).unwrap_or(u64::MAX);
        let downloaded = self
            .snapshot
            .downloaded_bytes
            .unwrap_or(0)
            .saturating_add(chunk_length);
        self.snapshot.downloaded_bytes = Some(downloaded);

        // The server's first valid content length is authoritative. Keeping it
        // stable prevents a WebView-computed percentage from moving backwards.
        let known_total = self.snapshot.total_bytes.or(content_length);
        self.snapshot.total_bytes = known_total.map(|total| {
            if downloaded >= total {
                downloaded.saturating_add(1)
            } else {
                total
            }
        });
        self.touch_snapshot();

        let percent = self.snapshot.total_bytes.and_then(|total| {
            (total > 0).then(|| {
                let value = downloaded
                    .saturating_mul(100)
                    .checked_div(total)
                    .unwrap_or(0);
                u8::try_from(value.min(99)).unwrap_or(99)
            })
        });
        let percentage_changed = match (self.last_progress_percent, percent) {
            (Some(previous), Some(next)) => next > previous,
            (None, Some(_)) => true,
            _ => false,
        };
        let interval_elapsed = self
            .last_progress_emit_at_ms
            .map(|last| now_ms.saturating_sub(last) >= PROGRESS_EMIT_INTERVAL_MS)
            .unwrap_or(true);

        if percentage_changed || interval_elapsed {
            self.last_progress_emit_at_ms = Some(now_ms);
            if let Some(percent) = percent {
                self.last_progress_percent =
                    Some(self.last_progress_percent.unwrap_or(0).max(percent));
            }
            Some(self.snapshot.clone())
        } else {
            None
        }
    }

    fn finish_download(&mut self, token: u64, outcome: DownloadOutcome) -> Option<AppUpdateState> {
        if self.active_token != Some(token) || self.snapshot.phase != AppUpdatePhase::Downloading {
            return None;
        }
        let update = self.snapshot.update.clone()?;
        self.active_token = None;
        self.last_progress_emit_at_ms = None;
        self.last_progress_percent = None;
        match outcome {
            DownloadOutcome::Ready(downloaded_bytes) => {
                let mut state = self.state(AppUpdatePhase::Ready);
                state.update = Some(update);
                state.downloaded_bytes = Some(downloaded_bytes);
                state.total_bytes = Some(downloaded_bytes);
                self.commit_state(state);
            }
            DownloadOutcome::Error(error) => {
                let mut state = self.state(AppUpdatePhase::Error);
                state.update = Some(update);
                state.error = Some(error);
                state.operation = Some(AppUpdateOperation::Download);
                self.commit_state(state);
            }
        }
        Some(self.snapshot.clone())
    }

    fn begin_install(&mut self) -> BeginOperation {
        if self.snapshot.phase == AppUpdatePhase::Installing {
            return BeginOperation::Existing {
                snapshot: self.snapshot.clone(),
            };
        }
        let can_retry = self.snapshot.phase == AppUpdatePhase::Error
            && self.snapshot.operation == Some(AppUpdateOperation::Install);
        if self.snapshot.phase != AppUpdatePhase::Ready && !can_retry {
            return BeginOperation::Existing {
                snapshot: self.snapshot.clone(),
            };
        }
        let Some(update) = self.snapshot.update.clone() else {
            return BeginOperation::Existing {
                snapshot: self.snapshot.clone(),
            };
        };

        let token = self.next_operation_token();
        self.active_token = Some(token);
        let mut state = self.state(AppUpdatePhase::Installing);
        state.update = Some(update);
        self.commit_state(state);
        BeginOperation::Started {
            token,
            snapshot: self.snapshot.clone(),
        }
    }

    fn finish_install_error(&mut self, error: String) -> AppUpdateState {
        let update = self.snapshot.update.clone();
        self.active_token = None;
        let mut state = self.state(AppUpdatePhase::Error);
        state.update = update;
        state.error = Some(error);
        state.operation = Some(AppUpdateOperation::Install);
        self.commit_state(state);
        self.snapshot.clone()
    }
}

#[tauri::command]
pub fn get_app_update_state(manager: tauri::State<'_, UpdateManager>) -> AppUpdateState {
    manager.snapshot()
}

#[tauri::command(rename_all = "camelCase")]
pub async fn check_for_app_updates(
    app: AppHandle,
    manager: tauri::State<'_, UpdateManager>,
    trigger: UpdateCheckTrigger,
) -> Result<AppUpdateState, String> {
    let manager = manager.inner().clone();
    let BeginOperation::Started { token, snapshot } = manager.begin_check(trigger, now_millis())
    else {
        return Ok(manager.snapshot());
    };
    emit_snapshot(&app, &snapshot);

    let updater = match app.updater_builder().timeout(UPDATE_CHECK_TIMEOUT).build() {
        Ok(updater) => updater,
        Err(error) => {
            let snapshot = manager
                .finish_check_error(token, error, now_millis())
                .unwrap_or_else(|| manager.snapshot());
            emit_snapshot(&app, &snapshot);
            return Ok(snapshot);
        }
    };

    let check_result = updater.check().await;
    let completed_at_ms = now_millis();
    let completed_at = rfc3339_now();
    let snapshot = match check_result {
        Ok(Some(update)) => {
            manager.finish_check_available(token, update, completed_at_ms, completed_at)
        }
        Ok(None) => manager.finish_check_up_to_date(token, completed_at_ms, completed_at),
        Err(error) => manager.finish_check_error(token, error, completed_at_ms),
    }
    .unwrap_or_else(|| manager.snapshot());
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub async fn download_app_update(
    app: AppHandle,
    manager: tauri::State<'_, UpdateManager>,
) -> Result<AppUpdateState, String> {
    let manager = manager.inner().clone();
    let (token, update) = match manager.begin_download(now_millis()) {
        BeginDownload::Started {
            token,
            snapshot,
            update,
        } => {
            emit_snapshot(&app, &snapshot);
            (token, update)
        }
        BeginDownload::Existing(snapshot) | BeginDownload::Unavailable(snapshot) => {
            return Ok(snapshot);
        }
    };

    let progress_manager = manager.clone();
    let progress_app = app.clone();
    let result = tokio::time::timeout(
        UPDATE_DOWNLOAD_TIMEOUT,
        update.download(
            move |chunk_length, content_length| {
                if let Some(snapshot) = progress_manager.record_download_progress(
                    token,
                    chunk_length,
                    content_length,
                    now_millis(),
                ) {
                    emit_snapshot(&progress_app, &snapshot);
                }
            },
            || {},
        ),
    )
    .await
    .map_err(|_| "Le téléchargement de la mise à jour a dépassé 15 minutes.".to_string())
    .and_then(|result| result.map_err(|error| error.to_string()));

    let snapshot = match result {
        Ok(bytes) => manager.finish_download_ready(token, bytes),
        Err(error) => manager.finish_download_error(token, error),
    }
    .unwrap_or_else(|| manager.snapshot());
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn install_app_update(
    app: AppHandle,
    manager: tauri::State<'_, UpdateManager>,
    agents: tauri::State<'_, AgentsState>,
    force: bool,
) -> Result<InstallAppUpdateResult, String> {
    let manager = manager.inner().clone();
    let agents = agents.inner().clone();

    if manager.snapshot().phase == AppUpdatePhase::Installing {
        return Ok(InstallAppUpdateResult::Installing);
    }

    // This process-wide fence is acquired before inspecting the registry and
    // remains held until installation fails or the app exits. Agent starts and
    // emergency restarts re-check it at their final spawn boundary, so the
    // active-agent count below cannot be invalidated by a concurrent window.
    let _installation_guard = match begin_update_installation(&agents) {
        Ok(guard) => guard,
        Err(error) => {
            if manager.snapshot().phase == AppUpdatePhase::Installing {
                return Ok(InstallAppUpdateResult::Installing);
            }
            return Err(error);
        }
    };

    let active_agents = running_agent_count(&agents);
    if active_agents > 0 && !force {
        return Ok(InstallAppUpdateResult::Busy { active_agents });
    }

    let (update, bytes) = match manager.begin_install() {
        BeginInstall::Started {
            snapshot,
            update,
            bytes,
        } => {
            emit_snapshot(&app, &snapshot);
            (update, bytes)
        }
        BeginInstall::AlreadyInstalling => return Ok(InstallAppUpdateResult::Installing),
        BeginInstall::NotReady => {
            return Err("The update must be downloaded and verified before installation.".into());
        }
    };

    let install_app = app.clone();
    let install_result = crate::run_blocking(move || {
        if force {
            shutdown_all_agents_for_update(&install_app, &agents)?;
        }
        update
            .install(bytes.as_ref())
            .map_err(|error| error.to_string())
    })
    .await;

    if let Err(error) = install_result {
        let snapshot = manager.finish_install_error(&error);
        emit_snapshot(&app, &snapshot);
        return Err(error);
    }

    app.restart();
}

fn emit_snapshot(app: &AppHandle, snapshot: &AppUpdateState) {
    let _ = app.emit(UPDATE_STATE_EVENT, snapshot.clone());
}

fn update_metadata(update: &Update) -> AppUpdateMetadata {
    AppUpdateMetadata {
        version: update.version.clone(),
        notes: update
            .body
            .as_deref()
            .map(str::trim)
            .filter(|notes| !notes.is_empty())
            .map(|notes| bounded_text(notes, MAX_UPDATE_NOTES_CHARS)),
        published_at: update
            .date
            .and_then(|date| date.format(&Rfc3339).ok())
            .or_else(|| update.date.map(|date| date.to_string())),
    }
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let mut bounded: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() && max_chars > 0 {
        bounded.pop();
        bounded.push('…');
    }
    bounded
}

fn within_window(timestamp_ms: Option<u64>, now_ms: u64, window_ms: u64) -> bool {
    timestamp_ms
        .map(|timestamp| now_ms.saturating_sub(timestamp) < window_ms)
        .unwrap_or(false)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn rfc3339_now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| now_millis().to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        bounded_text, AppUpdateMetadata, AppUpdateOperation, AppUpdatePhase, BeginOperation,
        CheckOutcome, DownloadOutcome, InstallAppUpdateResult, UpdateCheckTrigger,
        UpdateCoordinator, AUTOMATIC_CHECK_TTL_MS, AUTOMATIC_ERROR_BACKOFF_MS,
        MAX_UPDATE_NOTES_CHARS,
    };

    fn metadata(version: &str) -> AppUpdateMetadata {
        AppUpdateMetadata {
            version: version.to_string(),
            notes: Some("Notes".to_string()),
            published_at: Some("2026-08-20T12:00:00Z".to_string()),
        }
    }

    fn begin_available_download(coordinator: &mut UpdateCoordinator) -> u64 {
        let BeginOperation::Started { token, .. } =
            coordinator.begin_check(UpdateCheckTrigger::Manual, false, 1_000)
        else {
            panic!("check must start");
        };
        coordinator
            .finish_check(
                token,
                CheckOutcome::Available(metadata("0.1.14")),
                1_100,
                "2026-08-20T12:00:00Z".into(),
            )
            .expect("check completion");
        let BeginOperation::Started { token, .. } = coordinator.begin_download(true, 1_200) else {
            panic!("download must start");
        };
        token
    }

    #[test]
    fn check_is_coalesced_across_windows() {
        let mut coordinator = UpdateCoordinator::new("0.1.13");
        let BeginOperation::Started { token, .. } =
            coordinator.begin_check(UpdateCheckTrigger::Automatic, false, 1_000)
        else {
            panic!("first check must start");
        };
        assert!(matches!(
            coordinator.begin_check(UpdateCheckTrigger::Automatic, false, 1_001),
            BeginOperation::Existing { .. }
        ));
        coordinator
            .finish_check(
                token,
                CheckOutcome::Available(metadata("0.1.14")),
                1_100,
                "2026-08-20T12:00:00Z".into(),
            )
            .expect("check completion");
        assert!(matches!(
            coordinator.begin_check(UpdateCheckTrigger::Manual, true, 1_200),
            BeginOperation::Existing { .. }
        ));
    }

    #[test]
    fn automatic_checks_obey_ttl_while_manual_checks_bypass_it() {
        let mut coordinator = UpdateCoordinator::new("0.1.13");
        let BeginOperation::Started { token, .. } =
            coordinator.begin_check(UpdateCheckTrigger::Automatic, false, 1_000)
        else {
            panic!("first check must start");
        };
        coordinator
            .finish_check(
                token,
                CheckOutcome::UpToDate,
                2_000,
                "2026-08-20T12:00:00Z".into(),
            )
            .expect("check completion");
        assert!(matches!(
            coordinator.begin_check(
                UpdateCheckTrigger::Automatic,
                false,
                2_000 + AUTOMATIC_CHECK_TTL_MS - 1,
            ),
            BeginOperation::Existing { .. }
        ));
        assert!(matches!(
            coordinator.begin_check(UpdateCheckTrigger::Manual, false, 2_001),
            BeginOperation::Started { .. }
        ));
    }

    #[test]
    fn automatic_failures_back_off_but_manual_checks_do_not() {
        let mut coordinator = UpdateCoordinator::new("0.1.13");
        let BeginOperation::Started { token, .. } =
            coordinator.begin_check(UpdateCheckTrigger::Automatic, false, 1_000)
        else {
            panic!("first check must start");
        };
        coordinator
            .finish_check(
                token,
                CheckOutcome::Error("offline".into()),
                2_000,
                "unused".into(),
            )
            .expect("error completion");
        assert_eq!(coordinator.last_attempt_at_ms, Some(1_000));
        assert!(matches!(
            coordinator.begin_check(
                UpdateCheckTrigger::Automatic,
                false,
                2_000 + AUTOMATIC_ERROR_BACKOFF_MS - 1,
            ),
            BeginOperation::Existing { .. }
        ));
        assert!(matches!(
            coordinator.begin_check(UpdateCheckTrigger::Manual, false, 2_001),
            BeginOperation::Started { .. }
        ));
    }

    #[test]
    fn stale_operation_completion_cannot_replace_a_newer_snapshot() {
        let mut coordinator = UpdateCoordinator::new("0.1.13");
        let BeginOperation::Started { token, .. } =
            coordinator.begin_check(UpdateCheckTrigger::Manual, false, 1_000)
        else {
            panic!("check must start");
        };
        assert!(coordinator
            .finish_check(
                token + 1,
                CheckOutcome::Available(metadata("9.9.9")),
                1_100,
                "2026-08-20T12:00:00Z".into(),
            )
            .is_none());
        assert_eq!(coordinator.snapshot.phase, AppUpdatePhase::Checking);
    }

    #[test]
    fn download_is_coalesced_progress_is_monotone_and_events_are_throttled() {
        let mut coordinator = UpdateCoordinator::new("0.1.13");
        let token = begin_available_download(&mut coordinator);
        assert!(matches!(
            coordinator.begin_download(true, 1_201),
            BeginOperation::Existing { .. }
        ));

        let first = coordinator
            .record_download_progress(token, 25, Some(100), 1_210)
            .expect("integer percentage change emits");
        assert_eq!(first.downloaded_bytes, Some(25));
        assert_eq!(first.total_bytes, Some(100));
        assert!(coordinator
            .record_download_progress(token, 0, Some(100), 1_220)
            .is_none());
        assert!(coordinator.snapshot.revision > first.revision);
        let second = coordinator
            .record_download_progress(token, 10, Some(80), 1_230)
            .expect("higher integer percentage emits");
        assert_eq!(second.downloaded_bytes, Some(35));
        assert_eq!(second.total_bytes, Some(100));
        assert_eq!(coordinator.last_progress_percent, Some(35));
        assert!(second.revision > first.revision);
    }

    #[test]
    fn ready_is_only_published_after_verified_download_completion() {
        let mut coordinator = UpdateCoordinator::new("0.1.13");
        let token = begin_available_download(&mut coordinator);
        coordinator.record_download_progress(token, 100, Some(100), 1_300);
        assert_eq!(coordinator.snapshot.phase, AppUpdatePhase::Downloading);
        assert_eq!(coordinator.snapshot.total_bytes, Some(101));
        let ready = coordinator
            .finish_download(token, DownloadOutcome::Ready(100))
            .expect("ready transition");
        assert_eq!(ready.phase, AppUpdatePhase::Ready);
        assert_eq!(ready.downloaded_bytes, Some(100));
        assert_eq!(ready.total_bytes, Some(100));
    }

    #[test]
    fn failed_download_can_be_retried_without_a_new_check() {
        let mut coordinator = UpdateCoordinator::new("0.1.13");
        let token = begin_available_download(&mut coordinator);
        let failed = coordinator
            .finish_download(token, DownloadOutcome::Error("offline".to_string()))
            .expect("error transition");
        assert_eq!(failed.phase, AppUpdatePhase::Error);
        assert_eq!(failed.operation, Some(AppUpdateOperation::Download));
        assert!(failed.update.is_some());
        assert!(matches!(
            coordinator.begin_download(true, 1_300),
            BeginOperation::Started { .. }
        ));
    }

    #[test]
    fn public_state_and_install_result_match_the_typescript_contract() {
        let mut coordinator = UpdateCoordinator::new("0.1.13");
        let BeginOperation::Started { token, .. } =
            coordinator.begin_check(UpdateCheckTrigger::Manual, false, 42)
        else {
            panic!("check must start");
        };
        let state = coordinator
            .finish_check(
                token,
                CheckOutcome::UpToDate,
                43,
                "2026-08-20T12:00:00Z".into(),
            )
            .expect("completion");
        let value = serde_json::to_value(state).expect("serialize update state");
        assert_eq!(value["phase"], "upToDate");
        assert_eq!(value["currentVersion"], "0.1.13");
        assert!(value["revision"]
            .as_u64()
            .is_some_and(|revision| revision > 0));
        assert_eq!(value["lastCheckedAt"], "2026-08-20T12:00:00Z");
        assert_eq!(value["trigger"], "manual");
        assert!(value.get("checkedAtMs").is_none());

        let automatic = serde_json::to_value(UpdateCheckTrigger::Automatic).unwrap();
        assert_eq!(automatic, "automatic");
        let busy = serde_json::to_value(InstallAppUpdateResult::Busy { active_agents: 2 })
            .expect("serialize busy result");
        assert_eq!(busy["status"], "busy");
        assert_eq!(busy["activeAgents"], 2);
        assert_eq!(busy.as_object().map(|object| object.len()), Some(2));
    }

    #[test]
    fn release_notes_are_unicode_safe_and_bounded() {
        let input = "é".repeat(MAX_UPDATE_NOTES_CHARS + 20);
        let bounded = bounded_text(&input, MAX_UPDATE_NOTES_CHARS);
        assert_eq!(bounded.chars().count(), MAX_UPDATE_NOTES_CHARS);
        assert!(bounded.ends_with('…'));
    }
}
