//! Plan-mode attention notifications.
//!
//! When Plan mode needs an answer in the background, this subsystem raises one
//! OS toast so the user returns to Prime Orbit and can continue the workflow. The copy is generic on
//! purpose: it never embeds transcript content or conversation identifiers,
//! and no click callback is registered. Delivery is skipped when at least one
//! webview is both visible and focused, then deduplicated process-wide per
//! request key over a short TTL window. A failed toast is returned as an
//! error result instead of panicking.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

/// Time window during which repeating the same request key stays silent.
pub(crate) const DEDUP_TTL: Duration = Duration::from_secs(30);
/// Upper bound of tracked request keys so a chatty caller cannot grow memory.
const MAX_TRACKED_KEYS: usize = 256;
/// Shared length bound applied to conversation and request identifiers.
const MAX_IDENTIFIER_CHARS: usize = 128;
const PLAN_NOTIFICATION_SOUND: &str = "Default";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanAttentionInput {
    conversation_id: String,
    request_key: String,
    language: PlanLanguage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PlanLanguage {
    Fr,
    En,
    Bilingual,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanAttentionResult {
    status: PlanAttentionStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PlanAttentionStatus {
    Shown,
    Deduped,
    SuppressedFocused,
}

/// Process-wide registry of recently shown request keys.
#[derive(Default)]
pub(crate) struct PlanAttentionState {
    recent_requests: Mutex<HashMap<String, Instant>>,
}

fn is_identifier_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
}

fn validate_identifier(field: &str, value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("L'identifiant « {field} » est requis."));
    }
    if trimmed.chars().count() > MAX_IDENTIFIER_CHARS {
        return Err(format!(
            "L'identifiant « {field} » dépasse la limite de {MAX_IDENTIFIER_CHARS} caractères."
        ));
    }
    if !trimmed.chars().all(is_identifier_char) {
        return Err(format!(
            "L'identifiant « {field} » contient des caractères non autorisés."
        ));
    }
    Ok(trimmed.to_owned())
}

fn validate_input(input: PlanAttentionInput) -> Result<(String, String, PlanLanguage), String> {
    let conversation_id = validate_identifier("conversationId", &input.conversation_id)?;
    let request_key = validate_identifier("requestKey", &input.request_key)?;
    Ok((conversation_id, request_key, input.language))
}

/// Generic localized toast copy. Deliberately free of transcript excerpts,
/// project paths, and conversation identifiers.
fn plan_attention_copy(language: PlanLanguage) -> (&'static str, &'static str) {
    match language {
        PlanLanguage::Fr => (
            "Prime Orbit — Réponse attendue",
            "Le mode Plan attend votre réponse pour continuer.",
        ),
        PlanLanguage::En => (
            "Prime Orbit — Response needed",
            "Plan mode is waiting for your response to continue.",
        ),
        PlanLanguage::Bilingual => (
            "Prime Orbit — Réponse attendue / Response needed",
            "Le mode Plan attend une réponse. Plan mode is waiting for a response.",
        ),
    }
}

/// Pure decision over collected `(visible, focused)` window states: at least
/// one webview must satisfy both conditions for the toast to be suppressed.
fn any_visible_and_focused<I>(windows: I) -> bool
where
    I: IntoIterator<Item = (bool, bool)>,
{
    windows
        .into_iter()
        .any(|(visible, focused)| visible && focused)
}

fn collect_window_focus_states<R: Runtime>(app: &impl Manager<R>) -> Option<Vec<(bool, bool)>> {
    app.webview_windows()
        .values()
        .map(|webview| Some((webview.is_visible().ok()?, webview.is_focused().ok()?)))
        .collect()
}

fn should_suppress_notification(windows: Option<Vec<(bool, bool)>>) -> bool {
    // A focus-query failure cannot prove that every window is unfocused. Fail
    // closed and stay silent rather than violating the notification contract.
    windows.map(any_visible_and_focused).unwrap_or(true)
}

fn is_expired(inserted_at: Instant, now: Instant, ttl: Duration) -> bool {
    match inserted_at.checked_add(ttl) {
        Some(deadline) => deadline <= now,
        None => true,
    }
}

enum Reservation {
    First,
    Duplicate,
}

/// Reserves `request_key` for one TTL window. Expired entries are pruned on
/// each call; once the map reaches `capacity`, the oldest reservation is
/// evicted so the registry stays bounded.
fn reserve_request(
    recent: &mut HashMap<String, Instant>,
    request_key: &str,
    now: Instant,
    ttl: Duration,
    capacity: usize,
) -> Reservation {
    recent.retain(|_, inserted_at| !is_expired(*inserted_at, now, ttl));
    if recent.contains_key(request_key) {
        return Reservation::Duplicate;
    }
    if recent.len() >= capacity {
        if let Some((oldest_key, _)) = recent.iter().min_by_key(|(_, inserted_at)| **inserted_at) {
            let oldest_key = oldest_key.clone();
            recent.remove(&oldest_key);
        }
    }
    recent.insert(request_key.to_owned(), now);
    Reservation::First
}

fn show_plan_toast(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    // notify-rust treats an omitted Windows sound as silent. Request the
    // documented "Default" system event explicitly.
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .sound(PLAN_NOTIFICATION_SOUND)
        .show()
        .map_err(|error| format!("Notification système indisponible : {error}"))
}

fn notify_plan_attention_sync(
    app: &AppHandle,
    state: &PlanAttentionState,
    conversation_id: &str,
    request_key: &str,
    language: PlanLanguage,
) -> Result<PlanAttentionResult, String> {
    if should_suppress_notification(collect_window_focus_states(app)) {
        return Ok(PlanAttentionResult {
            status: PlanAttentionStatus::SuppressedFocused,
        });
    }

    let reservation_key = format!("{conversation_id}:{request_key}");
    let now = Instant::now();
    let reservation = {
        let mut recent = state.recent_requests.lock();
        reserve_request(
            &mut recent,
            &reservation_key,
            now,
            DEDUP_TTL,
            MAX_TRACKED_KEYS,
        )
    };
    if matches!(reservation, Reservation::Duplicate) {
        return Ok(PlanAttentionResult {
            status: PlanAttentionStatus::Deduped,
        });
    }

    let (title, body) = plan_attention_copy(language);
    match show_plan_toast(app, title, body) {
        Ok(()) => Ok(PlanAttentionResult {
            status: PlanAttentionStatus::Shown,
        }),
        Err(error) => {
            state.recent_requests.lock().remove(&reservation_key);
            Err(error)
        }
    }
}

/// Fallback used directly by the native RPC reader when no renderer owns the
/// blocking Plan request or its target window disappeared during delivery.
pub(crate) fn notify_plan_attention_from_runtime(
    app: &AppHandle,
    conversation_id: &str,
    request_key: &str,
) -> Result<PlanAttentionResult, String> {
    let conversation_id = validate_identifier("conversationId", conversation_id)?;
    let request_key = validate_identifier("requestKey", request_key)?;
    let state = app.state::<PlanAttentionState>();
    notify_plan_attention_sync(
        app,
        state.inner(),
        &conversation_id,
        &request_key,
        PlanLanguage::Bilingual,
    )
}

#[tauri::command]
pub(crate) async fn notify_plan_attention(
    app: AppHandle,
    input: PlanAttentionInput,
) -> Result<PlanAttentionResult, String> {
    let (conversation_id, request_key, language) = validate_input(input)?;
    crate::run_blocking(move || {
        let state = app.state::<PlanAttentionState>();
        notify_plan_attention_sync(
            &app,
            state.inner(),
            &conversation_id,
            &request_key,
            language,
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        any_visible_and_focused, is_expired, plan_attention_copy, reserve_request,
        should_suppress_notification, validate_input, PlanAttentionInput, PlanAttentionStatus,
        PlanLanguage, Reservation, DEDUP_TTL, MAX_TRACKED_KEYS, PLAN_NOTIFICATION_SOUND,
    };
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    fn sample_input(conversation_id: &str, request_key: &str, language: &str) -> serde_json::Value {
        serde_json::json!({
            "conversationId": conversation_id,
            "requestKey": request_key,
            "language": language,
        })
    }

    #[test]
    fn parses_camel_case_input_and_known_languages() {
        let parsed: PlanAttentionInput =
            serde_json::from_value(sample_input("conv-1", "req.1:a", "fr")).unwrap();
        assert_eq!(parsed.conversation_id, "conv-1");
        assert_eq!(parsed.request_key, "req.1:a");
        assert_eq!(parsed.language, PlanLanguage::Fr);

        let english: PlanAttentionInput =
            serde_json::from_value(sample_input("conv_1", "req-1", "en")).unwrap();
        assert_eq!(english.language, PlanLanguage::En);
    }

    #[test]
    fn rejects_unknown_language_and_malformed_input() {
        let unknown_language =
            serde_json::from_value::<PlanAttentionInput>(sample_input("conv", "req", "de"));
        assert!(unknown_language.is_err());

        let missing_key = serde_json::from_value::<PlanAttentionInput>(serde_json::json!({}));
        assert!(missing_key.is_err());
    }

    #[test]
    fn validates_bounds_and_identifier_charset() {
        let valid = validate_input(PlanAttentionInput {
            conversation_id: "  conv-01 ".into(),
            request_key: "plan:abc-123".into(),
            language: PlanLanguage::Fr,
        });
        let (conversation_id, request_key, _) = valid.unwrap();
        assert_eq!(conversation_id, "conv-01");
        assert_eq!(request_key, "plan:abc-123");

        for invalid in [
            ("", "req"),
            ("   ", "req"),
            (&*"x".repeat(129), "req"),
            ("conv\tid", "req"),
            ("conv\nid", "req"),
            ("conv id", "req"),
            ("conv", ""),
            ("conv", "req é"),
            ("conv", &*"k".repeat(129)),
        ] {
            let rejected = validate_input(PlanAttentionInput {
                conversation_id: invalid.0.into(),
                request_key: invalid.1.into(),
                language: PlanLanguage::En,
            });
            assert!(rejected.is_err(), "expected rejection for {invalid:?}");
        }
    }

    #[test]
    fn focus_suppression_requires_visible_and_focused() {
        assert!(!any_visible_and_focused(Vec::<(bool, bool)>::new()));
        assert!(!any_visible_and_focused([(false, false)]));
        assert!(!any_visible_and_focused([(true, false), (false, true)]));
        assert!(!any_visible_and_focused([(false, true), (false, false)]));
        assert!(any_visible_and_focused([(false, true), (true, true)]));
        assert!(any_visible_and_focused([(true, true)]));
        assert!(!should_suppress_notification(Some(vec![(true, false)])));
        assert!(should_suppress_notification(Some(vec![(true, true)])));
        assert!(should_suppress_notification(None));
    }

    #[test]
    fn dedup_reserves_once_then_expires_after_ttl() {
        let start = Instant::now();
        let mut recent = HashMap::new();

        assert!(matches!(
            reserve_request(&mut recent, "key", start, DEDUP_TTL, MAX_TRACKED_KEYS),
            Reservation::First
        ));
        assert!(matches!(
            reserve_request(
                &mut recent,
                "key",
                start + Duration::from_millis(1),
                DEDUP_TTL,
                MAX_TRACKED_KEYS
            ),
            Reservation::Duplicate
        ));

        // Just before the deadline the key still mutes repeat requests.
        let almost_expired = start + DEDUP_TTL - Duration::from_millis(1);
        assert!(matches!(
            reserve_request(
                &mut recent,
                "key",
                almost_expired,
                DEDUP_TTL,
                MAX_TRACKED_KEYS
            ),
            Reservation::Duplicate
        ));

        // At the deadline the entry expires and the request may notify again.
        let expired_boundary = start + DEDUP_TTL;
        assert!(is_expired(start, expired_boundary, DEDUP_TTL));
        assert!(matches!(
            reserve_request(
                &mut recent,
                "key",
                expired_boundary,
                DEDUP_TTL,
                MAX_TRACKED_KEYS
            ),
            Reservation::First
        ));
    }

    #[test]
    fn dedup_tracks_keys_independently() {
        let start = Instant::now();
        let mut recent = HashMap::new();

        assert!(matches!(
            reserve_request(&mut recent, "a", start, DEDUP_TTL, MAX_TRACKED_KEYS),
            Reservation::First
        ));
        assert!(matches!(
            reserve_request(&mut recent, "b", start, DEDUP_TTL, MAX_TRACKED_KEYS),
            Reservation::First
        ));
        assert!(matches!(
            reserve_request(&mut recent, "a", start, DEDUP_TTL, MAX_TRACKED_KEYS),
            Reservation::Duplicate
        ));
        assert_eq!(recent.len(), 2);
    }

    #[test]
    fn dedup_capacity_evicts_the_oldest_reservation() {
        let start = Instant::now();
        let mut recent = HashMap::new();
        let capacity = 2;

        assert!(matches!(
            reserve_request(&mut recent, "old", start, DEDUP_TTL, capacity),
            Reservation::First
        ));
        assert!(matches!(
            reserve_request(
                &mut recent,
                "newer",
                start + Duration::from_secs(1),
                DEDUP_TTL,
                capacity
            ),
            Reservation::First
        ));
        // Third distinct key must evict "old" instead of growing unbounded.
        assert!(matches!(
            reserve_request(
                &mut recent,
                "latest",
                start + Duration::from_secs(2),
                DEDUP_TTL,
                capacity
            ),
            Reservation::First
        ));
        assert_eq!(recent.len(), capacity);
        assert!(!recent.contains_key("old"));
        assert!(recent.contains_key("newer"));
        assert!(recent.contains_key("latest"));

        // The evicted key becomes eligible again immediately.
        assert!(matches!(
            reserve_request(
                &mut recent,
                "old",
                start + Duration::from_secs(2),
                DEDUP_TTL,
                capacity
            ),
            Reservation::First
        ));
    }

    #[test]
    fn expired_entries_are_pruned_before_reserving() {
        let start = Instant::now();
        let mut recent = HashMap::new();

        assert!(matches!(
            reserve_request(&mut recent, "stale", start, DEDUP_TTL, MAX_TRACKED_KEYS),
            Reservation::First
        ));
        let later = start + DEDUP_TTL + Duration::from_secs(1);
        assert!(is_expired(recent["stale"], later, DEDUP_TTL));
        assert!(matches!(
            reserve_request(&mut recent, "fresh", later, DEDUP_TTL, MAX_TRACKED_KEYS),
            Reservation::First
        ));
        assert!(!recent.contains_key("stale"));
        assert_eq!(recent.len(), 1);
    }

    #[test]
    fn toast_copy_is_generic_localized_and_distinct() {
        let (fr_title, fr_body) = plan_attention_copy(PlanLanguage::Fr);
        let (en_title, en_body) = plan_attention_copy(PlanLanguage::En);
        let (bi_title, bi_body) = plan_attention_copy(PlanLanguage::Bilingual);

        assert_eq!(PLAN_NOTIFICATION_SOUND, "Default");
        assert!(!bi_title.is_empty() && !bi_body.is_empty());
        assert!(!fr_title.is_empty() && !fr_body.is_empty());
        assert!(!en_title.is_empty() && !en_body.is_empty());
        assert_ne!((fr_title, fr_body), (en_title, en_body));

        for (title, body) in [(fr_title, fr_body), (en_title, en_body)] {
            let combined = format!("{title}\n{body}");
            assert!(combined.to_lowercase().contains("plan"));
            // No transcript content, braces placeholders, or identifiers.
            assert!(!combined.contains('{'));
            assert!(!combined.contains("conv"));
            assert!(!combined.contains("req"));
        }
    }

    #[test]
    fn result_statuses_serialize_to_typed_outcomes() {
        use super::PlanAttentionResult;

        let shown = serde_json::to_value(PlanAttentionResult {
            status: PlanAttentionStatus::Shown,
        })
        .unwrap();
        assert_eq!(shown, serde_json::json!({ "status": "shown" }));

        let deduped = serde_json::to_value(PlanAttentionResult {
            status: PlanAttentionStatus::Deduped,
        })
        .unwrap();
        assert_eq!(deduped, serde_json::json!({ "status": "deduped" }));

        let suppressed = serde_json::to_value(PlanAttentionResult {
            status: PlanAttentionStatus::SuppressedFocused,
        })
        .unwrap();
        assert_eq!(
            suppressed,
            serde_json::json!({ "status": "suppressedFocused" })
        );
    }
}
