use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use serde_json::Value;
use std::{env, fs, path::PathBuf};

const ARTIFACT_ENV: &str = "PRIME_ORBIT_UPDATER_ARTIFACT";
const SIGNATURE_ENV: &str = "PRIME_ORBIT_UPDATER_SIGNATURE";

#[test]
#[ignore = "release gate; requires a built updater artifact and signature"]
fn embedded_public_key_verifies_release_artifact() {
    let artifact = required_path(ARTIFACT_ENV);
    let signature = required_path(SIGNATURE_ENV);
    assert!(
        artifact.is_file(),
        "updater artifact does not exist: {}",
        artifact.display()
    );
    assert!(
        signature.is_file(),
        "updater signature does not exist: {}",
        signature.display()
    );

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let config_path = manifest_dir.join("tauri.conf.json");
    let config: Value = serde_json::from_slice(
        &fs::read(&config_path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", config_path.display())),
    )
    .unwrap_or_else(|error| panic!("invalid {}: {error}", config_path.display()));
    let encoded_public_key = config
        .pointer("/plugins/updater/pubkey")
        .and_then(Value::as_str)
        .expect("plugins.updater.pubkey must be configured");
    let public_key_file = STANDARD
        .decode(encoded_public_key)
        .expect("plugins.updater.pubkey must be canonical base64");
    let public_key_file =
        std::str::from_utf8(&public_key_file).expect("decoded updater public key must be UTF-8");
    let public_key = PublicKey::decode(public_key_file)
        .expect("decoded updater public key must be a valid Minisign public key");
    // Tauri stores the complete Minisign signature file as one base64 string
    // in the adjacent `.sig` asset (the same representation used by
    // `latest.json`), rather than writing the decoded multi-line file.
    let encoded_signature = fs::read_to_string(&signature)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", signature.display()));
    let signature_file = STANDARD
        .decode(encoded_signature.trim())
        .unwrap_or_else(|error| panic!("invalid base64 in {}: {error}", signature.display()));
    let signature_file = std::str::from_utf8(&signature_file)
        .unwrap_or_else(|error| panic!("invalid UTF-8 in {}: {error}", signature.display()));
    let signature = Signature::decode(signature_file)
        .unwrap_or_else(|error| panic!("invalid {}: {error}", signature.display()));
    let artifact_bytes = fs::read(&artifact)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", artifact.display()));

    public_key
        .verify(&artifact_bytes, &signature, false)
        .unwrap_or_else(|error| {
            panic!(
                "{} is not signed by the updater key embedded in tauri.conf.json: {error}",
                artifact.display()
            )
        });
}

fn required_path(name: &str) -> PathBuf {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("{name} must point to a release artifact"))
}
