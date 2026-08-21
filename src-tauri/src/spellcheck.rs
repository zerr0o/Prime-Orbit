use serde::{Deserialize, Serialize};

const MAX_WORD_CHARS: usize = 128;
const MAX_LANGUAGE_TAG_CHARS: usize = 64;
const MAX_SUGGESTIONS: usize = 6;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpellingSuggestionsInput {
    word: String,
    language: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpellingSuggestionsResult {
    language: Option<String>,
    suggestions: Vec<String>,
}

fn validate_input(input: SpellingSuggestionsInput) -> Result<(String, String), String> {
    let word = input.word.trim();
    if word.is_empty() {
        return Ok((String::new(), String::new()));
    }
    if word.chars().count() > MAX_WORD_CHARS || word.chars().any(char::is_control) {
        return Err("Le mot à vérifier est trop long ou contient des caractères invalides.".into());
    }

    let language = input.language.trim().replace('_', "-");
    if language.is_empty()
        || language.chars().count() > MAX_LANGUAGE_TAG_CHARS
        || !language
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("La langue du correcteur orthographique est invalide.".into());
    }

    Ok((word.to_owned(), language))
}

fn choose_supported_language(requested: &str, supported: &[String]) -> Option<String> {
    if let Some(exact) = supported
        .iter()
        .find(|candidate| candidate.eq_ignore_ascii_case(requested))
    {
        return Some(exact.clone());
    }

    let primary = requested.split('-').next()?.trim();
    if primary.is_empty() {
        return None;
    }
    let preferred_region = match primary.to_ascii_lowercase().as_str() {
        "fr" => Some("fr-FR"),
        "en" => Some("en-US"),
        _ => None,
    };
    if let Some(preferred_region) = preferred_region {
        if let Some(preferred) = supported
            .iter()
            .find(|candidate| candidate.eq_ignore_ascii_case(preferred_region))
        {
            return Some(preferred.clone());
        }
    }
    supported
        .iter()
        .find(|candidate| {
            candidate
                .split('-')
                .next()
                .is_some_and(|part| part.eq_ignore_ascii_case(primary))
        })
        .cloned()
}

#[cfg(windows)]
mod platform {
    use super::{choose_supported_language, SpellingSuggestionsResult, MAX_SUGGESTIONS};
    use std::ffi::c_void;
    use windows::{
        core::{IUnknown, HRESULT, PCWSTR, PWSTR},
        Win32::{
            Globalization::{ISpellCheckerFactory, SpellCheckerFactory},
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IEnumString,
                CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
            },
        },
    };

    const RPC_E_CHANGED_MODE: HRESULT = HRESULT(0x8001_0106_u32 as i32);

    struct ComApartment {
        should_uninitialize: bool,
    }

    impl ComApartment {
        fn initialize() -> Result<Self, String> {
            let status = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if status.is_err() && status != RPC_E_CHANGED_MODE {
                return Err(format!(
                    "Initialisation du correcteur Windows impossible: {status:?}"
                ));
            }
            Ok(Self {
                should_uninitialize: status.0 == 0 || status.0 == 1,
            })
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.should_uninitialize {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn read_enum_strings(values: &IEnumString, limit: usize) -> Result<Vec<String>, String> {
        let mut result = Vec::new();
        while result.len() < limit {
            let mut item = [PWSTR(std::ptr::null_mut())];
            let mut fetched = 0_u32;
            let status = unsafe { values.Next(&mut item, Some(&mut fetched)) };
            if status.is_err() {
                return Err(format!(
                    "Lecture du dictionnaire Windows impossible: {status:?}"
                ));
            }
            if fetched == 0 {
                break;
            }

            let pointer = item[0];
            let decoded = unsafe { pointer.to_string() };
            unsafe { CoTaskMemFree(Some(pointer.0.cast::<c_void>())) };
            let decoded = decoded
                .map_err(|error| format!("Suggestion Windows invalide: {error}"))?
                .trim()
                .to_owned();
            if !decoded.is_empty() && !result.iter().any(|current| current == &decoded) {
                result.push(decoded);
            }
        }
        Ok(result)
    }

    pub(super) fn suggestions(
        word: &str,
        requested_language: &str,
    ) -> Result<SpellingSuggestionsResult, String> {
        if word.is_empty() {
            return Ok(SpellingSuggestionsResult {
                language: None,
                suggestions: Vec::new(),
            });
        }

        let _apartment = ComApartment::initialize()?;
        let factory: ISpellCheckerFactory = unsafe {
            CoCreateInstance(
                &SpellCheckerFactory,
                None::<&IUnknown>,
                CLSCTX_INPROC_SERVER,
            )
        }
        .map_err(|error| format!("Correcteur Windows indisponible: {error}"))?;

        let supported = unsafe { factory.SupportedLanguages() }
            .map_err(|error| format!("Langues du correcteur Windows indisponibles: {error}"))?;
        let supported = unsafe { read_enum_strings(&supported, 256) }?;
        let Some(language) = choose_supported_language(requested_language, &supported) else {
            return Ok(SpellingSuggestionsResult {
                language: None,
                suggestions: Vec::new(),
            });
        };

        let language_wide = wide(&language);
        let checker = unsafe { factory.CreateSpellChecker(PCWSTR(language_wide.as_ptr())) }
            .map_err(|error| format!("Correcteur {language} indisponible: {error}"))?;
        let word_wide = wide(word);
        let errors = unsafe { checker.Check(PCWSTR(word_wide.as_ptr())) }
            .map_err(|error| format!("Vérification orthographique indisponible: {error}"))?;
        let mut first_error = None;
        let check_status = unsafe { errors.Next(&mut first_error) };
        if check_status.is_err() {
            return Err(format!(
                "Lecture du résultat orthographique impossible: {check_status:?}"
            ));
        }
        if first_error.is_none() {
            return Ok(SpellingSuggestionsResult {
                language: Some(language),
                suggestions: Vec::new(),
            });
        }

        let suggestions = unsafe { checker.Suggest(PCWSTR(word_wide.as_ptr())) }
            .map_err(|error| format!("Suggestions orthographiques indisponibles: {error}"))?;
        let suggestions = unsafe { read_enum_strings(&suggestions, MAX_SUGGESTIONS * 2) }?
            .into_iter()
            .filter(|suggestion| !suggestion.eq_ignore_ascii_case(word))
            .take(MAX_SUGGESTIONS)
            .collect();

        Ok(SpellingSuggestionsResult {
            language: Some(language),
            suggestions,
        })
    }
}

#[cfg(not(windows))]
mod platform {
    use super::SpellingSuggestionsResult;

    pub(super) fn suggestions(
        _word: &str,
        _requested_language: &str,
    ) -> Result<SpellingSuggestionsResult, String> {
        Ok(SpellingSuggestionsResult {
            language: None,
            suggestions: Vec::new(),
        })
    }
}

#[tauri::command]
pub(crate) async fn get_spelling_suggestions(
    input: SpellingSuggestionsInput,
) -> Result<SpellingSuggestionsResult, String> {
    let (word, language) = validate_input(input)?;
    crate::run_blocking(move || platform::suggestions(&word, &language)).await
}

#[cfg(test)]
mod tests {
    use super::{choose_supported_language, validate_input, SpellingSuggestionsInput};

    #[test]
    fn chooses_the_installed_regional_dictionary_for_a_base_language() {
        let supported = vec![
            "en-US".into(),
            "fr-015".into(),
            "fr-FR".into(),
            "fr-CA".into(),
        ];
        assert_eq!(
            choose_supported_language("fr", &supported).as_deref(),
            Some("fr-FR")
        );
        assert_eq!(
            choose_supported_language("fr-CA", &supported).as_deref(),
            Some("fr-CA")
        );
    }

    #[test]
    fn rejects_unbounded_or_invalid_spellcheck_input() {
        let invalid_language = validate_input(SpellingSuggestionsInput {
            word: "rafinement".into(),
            language: "fr FR".into(),
        });
        assert!(invalid_language.is_err());

        let oversized = validate_input(SpellingSuggestionsInput {
            word: "x".repeat(129),
            language: "fr".into(),
        });
        assert!(oversized.is_err());
    }
}
