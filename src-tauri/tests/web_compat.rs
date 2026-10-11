//! The web version (`web/`) and this app must read each other's workspaces.
//!
//! 1. Codec vectors, always run. The real codec source
//!    (`src/compat/notebook_v1.rs`) is compiled into this test, which checks
//!    `tests/web/fixtures/notebook-v1-rust.json` (written by this codec; set
//!    `NOTEBOOK_WRITE_WEB_VECTORS=1` to rewrite it) and decrypts
//!    `tests/web/fixtures/notebook-v1-web.json` (written by the TypeScript
//!    codec, `node tests/web/write-vectors.mjs`). `tests/web/codec.test.mjs`
//!    checks the same two files from the other side.
//! 2. Cross-app documents on a throwaway MinIO, skipped unless
//!    `NOTEBOOK_WEB_MINIO_URL` is set (`scripts/web-e2e.sh` sets it): the
//!    desktop command code opens what the web app wrote, and writes a document
//!    the web app then opens.

#[allow(dead_code)]
#[path = "../src/compat/notebook_v1.rs"]
mod notebook_v1;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use notebook_v1::NotebookV1Codec;
use secrecy::SecretString;
use serde_json::{Value, json};
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/web/fixtures")
        .join(name)
}

fn codec(phrase: &str) -> NotebookV1Codec {
    NotebookV1Codec::new(SecretString::from(phrase.to_owned())).unwrap()
}

/// Phrases that pin the trimming rule: Rust `str::trim` removes Unicode
/// White_Space (U+0085 and U+00A0 included) but keeps U+FEFF, unlike
/// JavaScript's `String.prototype.trim`; nothing is normalized.
const PHRASES: [&str; 4] = [
    "correct horse battery staple",
    " \t\u{85}padded\u{a0}phrase\u{3000}\n",
    "\u{feff}bom stays",
    "Cafe\u{301} \u{1f510} фраза",
];

const PATHS: [&str; 9] = [
    "note.md",
    "projects/roadmap/todo.md",
    "Ünïcode/名前/ファイル.md",
    "Cafe\u{301}.md",
    "Café.md",
    "a/b/c/d/e/f/g.md",
    "folder/.notebook_dir",
    "_deleted/items/1712000000123-note.md/item/note.md",
    "/lead//double/trail/",
];

const BODIES: [&str; 6] = [
    "",
    "# Title\n\nhello",
    "\u{feff}BOM first, then text",
    "line one\r\nline two\r\n",
    "emoji \u{1f510} and Cafe\u{301}",
    "0123456789abcdef",
];

fn write_rust_vectors() {
    let cases = PHRASES
        .iter()
        .map(|phrase| {
            let codec = codec(phrase);
            let paths = PATHS
                .iter()
                .map(|path| json!({ "logical": path, "stored": codec.encode_path(path).unwrap() }))
                .collect::<Vec<_>>();
            let bodies = BODIES
                .iter()
                .map(|text| {
                    let payload = codec.encode_content(text).unwrap();
                    json!({ "text": text, "payload": STANDARD.encode(payload.as_slice()) })
                })
                .collect::<Vec<_>>();
            json!({
                "phrase": phrase,
                "key_reference": codec.key_reference(),
                "paths": paths,
                "bodies": bodies,
            })
        })
        .collect::<Vec<_>>();
    let document = json!({
        "about": "Written by src-tauri/tests/web_compat.rs from the desktop codec (src-tauri/src/compat/notebook_v1.rs). Test data only; the phrases are not secrets.",
        "cases": cases,
    });
    std::fs::write(
        fixture("notebook-v1-rust.json"),
        serde_json::to_string_pretty(&document).unwrap() + "\n",
    )
    .unwrap();
}

fn read_fixture(name: &str) -> Value {
    let bytes = std::fs::read(fixture(name))
        .unwrap_or_else(|error| panic!("tests/web/fixtures/{name}: {error}"));
    serde_json::from_slice(&bytes).unwrap()
}

fn text(value: &Value, field: &str) -> String {
    value[field]
        .as_str()
        .unwrap_or_else(|| panic!("{field} missing"))
        .to_owned()
}

/// Paths decode to their non-empty segments joined by "/".
fn canonical(path: &str) -> String {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// Every case of `name`: the key reference, paths and bodies must match.
fn check_vectors(name: &str) -> usize {
    let document = read_fixture(name);
    let cases = document["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "{name} has no cases");
    let mut checked = 0;
    for case in cases {
        let codec = codec(&text(case, "phrase"));
        assert_eq!(codec.key_reference(), text(case, "key_reference"));
        for path in case["paths"].as_array().expect("paths") {
            let logical = text(path, "logical");
            let stored = text(path, "stored");
            assert_eq!(codec.encode_path(&logical).unwrap(), stored, "{logical}");
            assert_eq!(codec.decode_path(&stored).unwrap(), canonical(&logical));
            checked += 1;
        }
        for body in case["bodies"].as_array().expect("bodies") {
            let payload = STANDARD.decode(text(body, "payload")).unwrap();
            assert_eq!(
                codec.decode_content(&payload).unwrap().as_str(),
                text(body, "text")
            );
            checked += 1;
        }
    }
    checked
}

#[test]
fn desktop_codec_matches_its_web_fixture() {
    if std::env::var_os("NOTEBOOK_WRITE_WEB_VECTORS").is_some() {
        write_rust_vectors();
    }
    assert!(check_vectors("notebook-v1-rust.json") > 0);
}

#[test]
fn desktop_codec_reads_what_the_web_codec_wrote() {
    let document = read_fixture("notebook-v1-web.json");
    assert!(
        document["about"]
            .as_str()
            .is_some_and(|about| about.contains("web/src/codec.ts")),
        "notebook-v1-web.json must be written by the TypeScript codec"
    );
    // The web fixture's phrases are this file's, so both sides cover the trim rule.
    let phrases = document["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| text(case, "phrase"))
        .collect::<Vec<_>>();
    assert_eq!(phrases, PHRASES);
    assert!(check_vectors("notebook-v1-web.json") > 0);
}

// ---------------------------------------------------------------------------
// Cross-app documents on MinIO

struct Minio {
    endpoint: String,
    bucket: String,
    prefix: String,
    access_key_id: String,
    secret_access_key: String,
    phrase: String,
}

fn minio() -> Option<Minio> {
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
    Some(Minio {
        endpoint: std::env::var("NOTEBOOK_WEB_MINIO_URL").ok()?,
        bucket: var("NOTEBOOK_WEB_MINIO_BUCKET"),
        prefix: std::env::var("NOTEBOOK_WEB_MINIO_PREFIX").unwrap_or_default(),
        access_key_id: var("NOTEBOOK_WEB_MINIO_ACCESS_KEY_ID"),
        secret_access_key: var("NOTEBOOK_WEB_MINIO_SECRET_ACCESS_KEY"),
        phrase: var("NOTEBOOK_WEB_MINIO_PHRASE"),
    })
}

async fn open_workspace(
    minio: &Minio,
    directory: &std::path::Path,
) -> notebook_app::notebook::testing::Workspace {
    let workspace = notebook_app::notebook::testing::Workspace::new(
        directory,
        &minio.endpoint,
        &minio.bucket,
        &minio.prefix,
        &minio.access_key_id,
        &minio.secret_access_key,
    );
    workspace
        .unlock(&minio.phrase)
        .await
        .unwrap_or_else(|error| panic!("unlock failed: {}", error.code()));
    workspace
}

/// `NOTEBOOK_WEB_EXPECT` names a JSON file: `{"documents": {path: text},
/// "folders": [path]}`, what the web app wrote. The desktop must list and
/// decrypt all of it.
#[tokio::test]
async fn desktop_opens_documents_the_web_app_wrote() {
    let Some(minio) = minio() else {
        eprintln!("skipped: NOTEBOOK_WEB_MINIO_URL is not set (scripts/web-e2e.sh)");
        return;
    };
    let Ok(expect) = std::env::var("NOTEBOOK_WEB_EXPECT") else {
        eprintln!("skipped: NOTEBOOK_WEB_EXPECT is not set");
        return;
    };
    let expected: Value = serde_json::from_slice(&std::fs::read(expect).unwrap()).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let workspace = open_workspace(&minio, scratch.path()).await;
    let paths = workspace.paths();
    for folder in expected["folders"].as_array().unwrap() {
        let folder = format!("{}/", folder.as_str().unwrap());
        assert!(paths.contains(&folder), "folder {folder} missing");
    }
    let documents = expected["documents"].as_object().unwrap();
    assert!(!documents.is_empty());
    for (path, text) in documents {
        assert!(paths.contains(path), "document {path} missing");
        let read = workspace
            .read(path)
            .await
            .unwrap_or_else(|error| panic!("{path}: {}", error.code()));
        assert_eq!(read, text.as_str().unwrap(), "{path}");
    }
    println!(
        "desktop opened {} web documents and {} web folders",
        documents.len(),
        expected["folders"].as_array().unwrap().len()
    );
}

/// `NOTEBOOK_WEB_DESKTOP_DOC` names a JSON file `{"folder", "name", "text"}`:
/// the desktop writes that document for the web app to open.
#[tokio::test]
async fn desktop_writes_a_document_for_the_web_app() {
    let Some(minio) = minio() else {
        eprintln!("skipped: NOTEBOOK_WEB_MINIO_URL is not set (scripts/web-e2e.sh)");
        return;
    };
    let Ok(spec) = std::env::var("NOTEBOOK_WEB_DESKTOP_DOC") else {
        eprintln!("skipped: NOTEBOOK_WEB_DESKTOP_DOC is not set");
        return;
    };
    let spec: Value = serde_json::from_slice(&std::fs::read(spec).unwrap()).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let workspace = open_workspace(&minio, scratch.path()).await;
    let folder = text(&spec, "folder");
    let name = workspace
        .create_at(
            "",
            &[folder.as_str()],
            &text(&spec, "name"),
            &text(&spec, "text"),
        )
        .await
        .unwrap_or_else(|error| panic!("create failed: {}", error.code()));
    let path = format!("{folder}/{name}");
    assert_eq!(workspace.read(&path).await.unwrap(), text(&spec, "text"));
    println!("desktop wrote {path}");
}
