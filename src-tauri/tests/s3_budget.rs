//! S3 request budgets of the save model and the shared client, measured
//! against an in-process fake S3 (no Docker, no network): it counts requests
//! and TCP connections and can hang ("blackhole") or reset connections.

use notebook_app::notebook::testing::Workspace;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PHRASE: &str = "budget phrase, not a secret";
const BUCKET: &str = "budget";

#[derive(Clone, Copy, PartialEq)]
enum Fault {
    None,
    /// Accept the request and never answer, like a dead network path.
    Blackhole,
    /// Close the connection without an answer.
    Reset,
}

struct Shared {
    objects: Mutex<BTreeMap<String, (Vec<u8>, String)>>,
    requests: Mutex<Vec<&'static str>>,
    connections: AtomicUsize,
    versions: AtomicU64,
    fault: Mutex<Fault>,
    delay: Mutex<Duration>,
    /// A listing reads the objects at once but answers this much later.
    slow_list: Mutex<Duration>,
}

struct FakeS3 {
    endpoint: String,
    shared: Arc<Shared>,
}

impl FakeS3 {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let shared = Arc::new(Shared {
            objects: Mutex::default(),
            requests: Mutex::default(),
            connections: AtomicUsize::new(0),
            versions: AtomicU64::new(0),
            fault: Mutex::new(Fault::None),
            delay: Mutex::new(Duration::ZERO),
            slow_list: Mutex::new(Duration::ZERO),
        });
        let server = shared.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                server.connections.fetch_add(1, Ordering::SeqCst);
                let shared = server.clone();
                std::thread::spawn(move || serve(&shared, stream));
            }
        });
        Self { endpoint, shared }
    }

    fn workspace(&self, directory: &Path) -> Workspace {
        Workspace::new(directory, &self.endpoint, BUCKET, "vault", "key", "secret")
    }

    /// Forgets the counts so far.
    fn reset_counts(&self) {
        self.shared.requests.lock().unwrap().clear();
        self.shared.connections.store(0, Ordering::SeqCst);
    }

    fn requests(&self) -> Vec<&'static str> {
        self.shared.requests.lock().unwrap().clone()
    }

    fn connections(&self) -> usize {
        self.shared.connections.load(Ordering::SeqCst)
    }

    fn set_fault(&self, fault: Fault) {
        *self.shared.fault.lock().unwrap() = fault;
    }

    fn set_delay(&self, delay: Duration) {
        *self.shared.delay.lock().unwrap() = delay;
    }

    fn set_slow_list(&self, delay: Duration) {
        *self.shared.slow_list.lock().unwrap() = delay;
    }

    /// Requests since the last reset, counted by kind.
    fn counts(&self) -> BTreeMap<&'static str, usize> {
        let mut counts = BTreeMap::new();
        for kind in self.requests() {
            *counts.entry(kind).or_default() += 1;
        }
        counts
    }

    /// Another device writes `text` at `path` (as Notebook would).
    async fn write_elsewhere(&self, path: &str, text: &str) {
        let directory = tempfile::tempdir().unwrap();
        let other = self.workspace(directory.path());
        other.unlock(PHRASE).await.unwrap();
        if other.paths().iter().any(|known| known == path) {
            other.open(path).await.unwrap();
            other.stage(path, text).unwrap();
            assert_eq!(other.commit(path).await.unwrap(), "Saved");
        } else {
            other.put_raw(path, text).await.unwrap();
        }
    }
}

fn serve(shared: &Shared, stream: TcpStream) {
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);
    loop {
        let mut head = String::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            if line == "\r\n" {
                break;
            }
            head.push_str(&line);
        }
        let mut lines = head.lines();
        let mut first = lines.next().unwrap_or_default().split(' ');
        let method = first.next().unwrap_or_default().to_owned();
        let target = first.next().unwrap_or_default().to_owned();
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
            .collect::<BTreeMap<_, _>>();
        let length = headers
            .get("content-length")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let mut body = vec![0; length];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        let fault = *shared.fault.lock().unwrap();
        match fault {
            Fault::Reset => return,
            Fault::Blackhole => {
                while *shared.fault.lock().unwrap() == Fault::Blackhole {
                    std::thread::sleep(Duration::from_millis(20));
                }
                return;
            }
            Fault::None => {}
        }
        std::thread::sleep(*shared.delay.lock().unwrap());
        let (status, etag, reply) = handle(shared, &method, &target, &headers, body);
        if target.contains("list-type") {
            std::thread::sleep(*shared.slow_list.lock().unwrap());
        }
        let etag = etag.map_or_else(String::new, |etag| format!("ETag: {etag}\r\n"));
        let head = format!(
            "HTTP/1.1 {status} X\r\nContent-Length: {}\r\n{etag}\r\n",
            reply.len()
        );
        if writer.write_all(head.as_bytes()).is_err() || writer.write_all(&reply).is_err() {
            return;
        }
    }
}

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 3 <= bytes.len()
            && let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16)
        {
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).unwrap()
}

fn handle(
    shared: &Shared,
    method: &str,
    target: &str,
    headers: &BTreeMap<String, String>,
    body: Vec<u8>,
) -> (u16, Option<String>, Vec<u8>) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let params = query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(name, value)| (decode(name), decode(value)))
        .collect::<BTreeMap<_, _>>();
    let key = decode(
        path.trim_start_matches('/')
            .split_once('/')
            .map_or("", |(_, key)| key),
    );
    let mut objects = shared.objects.lock().unwrap();
    let log = |kind| shared.requests.lock().unwrap().push(kind);
    if method == "GET" && params.contains_key("list-type") {
        log("LIST");
        let prefix = params.get("prefix").cloned().unwrap_or_default();
        let mut xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>"#,
        );
        for (key, (bytes, etag)) in objects.iter().filter(|(key, _)| key.starts_with(&prefix)) {
            xml.push_str(&format!(
                "<Contents><Key>{key}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>{}</ETag><Size>{}</Size><StorageClass>STANDARD</StorageClass></Contents>",
                etag.replace('"', "&quot;"),
                bytes.len()
            ));
        }
        xml.push_str("</ListBucketResult>");
        return (200, None, xml.into_bytes());
    }
    let current_etag = objects.get(&key).map(|(_, etag)| etag.clone());
    let if_match = headers.get("if-match");
    if method == "POST" && params.contains_key("delete") {
        log("DELETE_OBJECTS");
        // S3 refuses a DeleteObjects request without Content-MD5.
        if !headers.contains_key("content-md5") {
            return (
                400,
                None,
                b"<Error><Code>InvalidRequest</Code></Error>".to_vec(),
            );
        }
        let body = String::from_utf8(body).unwrap();
        for part in body.split("<Key>").skip(1) {
            let key = part.split("</Key>").next().unwrap().replace("&amp;", "&");
            objects.remove(&key);
        }
        return (200, None, b"<DeleteResult></DeleteResult>".to_vec());
    }
    if method == "PUT"
        && let Some(source) = headers.get("x-amz-copy-source")
    {
        log("COPY");
        let source = decode(source.split_once('/').map_or("", |(_, key)| key));
        let Some((bytes, etag)) = objects.get(&source).cloned() else {
            return (404, None, b"<Error><Code>NoSuchKey</Code></Error>".to_vec());
        };
        if headers
            .get("x-amz-copy-source-if-match")
            .is_some_and(|wanted| *wanted != etag)
        {
            return (
                412,
                None,
                b"<Error><Code>PreconditionFailed</Code></Error>".to_vec(),
            );
        }
        // Like S3 for a single-part object: the copy keeps the content's ETag.
        objects.insert(key, (bytes, etag.clone()));
        let reply = format!(
            "<CopyObjectResult><ETag>{}</ETag></CopyObjectResult>",
            etag.replace('"', "&quot;")
        );
        return (200, None, reply.into_bytes());
    }
    match method {
        "GET" => {
            log("GET");
            match objects.get(&key) {
                Some((bytes, etag)) => (200, Some(etag.clone()), bytes.clone()),
                None => (404, None, b"<Error><Code>NoSuchKey</Code></Error>".to_vec()),
            }
        }
        "PUT" => {
            log("PUT");
            let taken = headers.get("if-none-match").is_some() && current_etag.is_some();
            let stale = if_match.is_some_and(|etag| current_etag.as_ref() != Some(etag));
            if taken || stale {
                return (
                    412,
                    None,
                    b"<Error><Code>PreconditionFailed</Code></Error>".to_vec(),
                );
            }
            let etag = format!(
                "\"v{}\"",
                shared.versions.fetch_add(1, Ordering::SeqCst) + 1
            );
            objects.insert(key, (body, etag.clone()));
            (200, Some(etag), Vec::new())
        }
        "DELETE" => {
            log("DELETE");
            if if_match.is_some_and(|etag| current_etag.as_ref() != Some(etag)) {
                return (412, None, Vec::new());
            }
            objects.remove(&key);
            (204, None, Vec::new())
        }
        _ => (400, None, Vec::new()),
    }
}

/// A vault with `a.md` and `b.md`, written by an earlier session.
async fn seeded() -> (FakeS3, tempfile::TempDir) {
    let s3 = FakeS3::start();
    let directory = tempfile::tempdir().unwrap();
    let seed = s3.workspace(&directory.path().join("seed"));
    seed.unlock(PHRASE).await.unwrap();
    seed.put_raw("a.md", "alpha").await.unwrap();
    seed.put_raw("b.md", "beta").await.unwrap();
    seed.lock();
    s3.reset_counts();
    (s3, directory)
}

/// What a fresh unlock on another device reads at `path`.
async fn read_fresh(s3: &FakeS3, path: &str) -> String {
    let directory = tempfile::tempdir().unwrap();
    let other = s3.workspace(directory.path());
    other.unlock(PHRASE).await.unwrap();
    other.open(path).await.unwrap().0
}

#[tokio::test]
async fn one_connection_serves_the_whole_session() {
    let (s3, directory) = seeded().await;
    let app = s3.workspace(directory.path());
    app.unlock(PHRASE).await.unwrap();
    app.open("a.md").await.unwrap();
    app.stage("a.md", "alpha edited").unwrap();
    assert_eq!(app.commit("a.md").await.unwrap(), "Saved");
    app.open("b.md").await.unwrap();
    assert_eq!(s3.requests(), ["LIST", "GET", "PUT", "GET"]);
    // Before the shared client every command opened its own connection (4).
    assert_eq!(s3.connections(), 1);
}

#[tokio::test]
async fn typing_writes_the_journal_and_a_save_uploads_once() {
    let (s3, directory) = seeded().await;
    let app = s3.workspace(directory.path());
    app.unlock(PHRASE).await.unwrap();
    app.open("a.md").await.unwrap();
    s3.reset_counts();
    for text in ["alpha 1", "alpha 12", "alpha 123"] {
        assert_eq!(app.stage("a.md", text).unwrap(), "Staged");
    }
    assert_eq!(app.stage("a.md", "alpha 123").unwrap(), "Staged");
    assert!(s3.requests().is_empty(), "staging never touches S3");
    assert_eq!(app.outbox_entries(), 1);
    assert_eq!(app.open("a.md").await.unwrap(), ("alpha 123".into(), true));
    assert_eq!(app.commit("a.md").await.unwrap(), "Saved");
    assert_eq!(s3.requests(), ["PUT"]);
    assert_eq!(app.outbox_entries(), 0);
    // Cmd+S again, and the same text staged again: nothing to send.
    assert_eq!(app.commit("a.md").await.unwrap(), "Saved");
    assert_eq!(app.stage("a.md", "alpha 123").unwrap(), "Clean");
    assert_eq!(s3.requests(), ["PUT"]);
    assert_eq!(read_fresh(&s3, "a.md").await, "alpha 123");
}

#[tokio::test]
async fn typing_back_to_the_saved_text_is_clean() {
    let (s3, directory) = seeded().await;
    let app = s3.workspace(directory.path());
    app.unlock(PHRASE).await.unwrap();
    app.open("a.md").await.unwrap();
    s3.reset_counts();
    assert_eq!(app.stage("a.md", "alpha?").unwrap(), "Staged");
    assert_eq!(app.outbox_entries(), 1);
    assert_eq!(app.stage("a.md", "alpha").unwrap(), "Clean");
    assert_eq!(app.outbox_entries(), 0);
    assert_eq!(app.commit("a.md").await.unwrap(), "Saved");
    assert!(s3.requests().is_empty());
}

#[tokio::test]
async fn an_edit_staged_during_an_upload_is_rebased_on_the_new_etag() {
    let (s3, directory) = seeded().await;
    let app = s3.workspace(directory.path());
    app.unlock(PHRASE).await.unwrap();
    app.open("a.md").await.unwrap();
    app.stage("a.md", "first").unwrap();
    s3.reset_counts();
    s3.set_delay(Duration::from_millis(300));
    let (committed, staged) = tokio::join!(app.commit("a.md"), async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        app.stage("a.md", "second")
    });
    assert_eq!((committed.unwrap(), staged.unwrap()), ("Saved", "Staged"));
    assert_eq!(app.outbox_entries(), 1, "the newer edit stays queued");
    s3.set_delay(Duration::ZERO);
    // With the old ETag this would be a 412 and a spurious conflict copy.
    assert_eq!(app.commit("a.md").await.unwrap(), "Saved");
    assert_eq!(s3.requests(), ["PUT", "PUT"]);
    assert_eq!(app.outbox_entries(), 0);
    assert_eq!(read_fresh(&s3, "a.md").await, "second");
}

#[tokio::test]
async fn closing_while_s3_hangs_keeps_the_edit_for_the_next_unlock() {
    let (s3, directory) = seeded().await;
    let app = s3.workspace(directory.path());
    app.unlock(PHRASE).await.unwrap();
    app.open("a.md").await.unwrap();
    s3.set_fault(Fault::Blackhole);
    // The page's close: write the outbox, try the upload for 3 s, close.
    let started = Instant::now();
    assert_eq!(
        app.stage("a.md", "written just before closing").unwrap(),
        "Staged"
    );
    let durable = started.elapsed();
    let upload = tokio::time::timeout(Duration::from_secs(3), app.commit("a.md")).await;
    assert!(upload.is_err(), "the upload is still hanging");
    app.lock();
    let closed = started.elapsed();
    assert!(
        durable < Duration::from_millis(500),
        "outbox write took {durable:?}"
    );
    assert!(
        closed < Duration::from_millis(3_100),
        "close took {closed:?}"
    );
    assert_eq!(app.outbox_entries(), 1);

    s3.set_fault(Fault::None);
    s3.reset_counts();
    let next = s3.workspace(directory.path());
    next.unlock(PHRASE).await.unwrap();
    assert_eq!(s3.requests(), ["PUT", "LIST"], "unlock replays the edit");
    assert_eq!(next.outbox_entries(), 0);
    assert_eq!(
        next.open("a.md").await.unwrap(),
        ("written just before closing".into(), false)
    );
}

#[tokio::test]
async fn an_unreachable_s3_is_offline_and_the_journal_stays() {
    let (s3, directory) = seeded().await;
    let app = s3.workspace(directory.path());
    app.unlock(PHRASE).await.unwrap();
    app.open("a.md").await.unwrap();
    app.stage("a.md", "offline edit").unwrap();
    s3.set_fault(Fault::Reset);
    let started = Instant::now();
    assert_eq!(app.commit("a.md").await.unwrap(), "Offline");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(app.outbox_entries(), 1);
    s3.set_fault(Fault::None);
    assert_eq!(app.commit("a.md").await.unwrap(), "Saved");
    assert_eq!(app.outbox_entries(), 0);
    assert_eq!(read_fresh(&s3, "a.md").await, "offline edit");
}

#[tokio::test]
async fn a_version_changed_elsewhere_keeps_both_as_a_conflict_copy() {
    let (s3, directory) = seeded().await;
    let app = s3.workspace(&directory.path().join("app"));
    app.unlock(PHRASE).await.unwrap();
    app.open("a.md").await.unwrap();
    let other = s3.workspace(&directory.path().join("other"));
    other.unlock(PHRASE).await.unwrap();
    other.open("a.md").await.unwrap();
    other.stage("a.md", "theirs").unwrap();
    assert_eq!(other.commit("a.md").await.unwrap(), "Saved");

    app.stage("a.md", "mine").unwrap();
    assert_eq!(app.commit("a.md").await.unwrap(), "ConflictCopy");
    assert_eq!(app.outbox_entries(), 0);
    let copy = app
        .paths()
        .into_iter()
        .find(|path| path.starts_with("a (conflict "))
        .expect("conflict copy");
    assert_eq!(read_fresh(&s3, "a.md").await, "theirs");
    assert_eq!(read_fresh(&s3, &copy).await, "mine");
}

#[tokio::test]
async fn renaming_uploads_a_staged_edit_first() {
    let (s3, directory) = seeded().await;
    let app = s3.workspace(directory.path());
    app.unlock(PHRASE).await.unwrap();
    app.open("a.md").await.unwrap();
    app.stage("a.md", "edited, then renamed").unwrap();
    app.rename("a.md", "c.md").await.unwrap();
    assert_eq!(app.outbox_entries(), 0);
    assert_eq!(read_fresh(&s3, "c.md").await, "edited, then renamed");
}

#[tokio::test]
async fn a_queued_edit_of_an_object_moved_elsewhere_becomes_a_conflict_copy() {
    let (s3, directory) = seeded().await;
    let app = s3.workspace(&directory.path().join("app"));
    app.unlock(PHRASE).await.unwrap();
    app.open("a.md").await.unwrap();
    app.stage("a.md", "queued while closing").unwrap();
    app.lock();
    let other = s3.workspace(&directory.path().join("other"));
    other.unlock(PHRASE).await.unwrap();
    other.rename("a.md", "moved.md").await.unwrap();

    // Before, the replay failed with NOT_FOUND and every unlock failed.
    let next = s3.workspace(&directory.path().join("app"));
    next.unlock(PHRASE).await.unwrap();
    assert_eq!(next.outbox_entries(), 0);
    let copy = next
        .paths()
        .into_iter()
        .find(|path| path.starts_with("a (conflict "))
        .expect("conflict copy");
    assert_eq!(read_fresh(&s3, &copy).await, "queued while closing");
    assert_eq!(read_fresh(&s3, "moved.md").await, "alpha");
}

#[tokio::test]
async fn an_edit_staged_during_a_conflict_never_overwrites_the_other_version() {
    let (s3, directory) = seeded().await;
    let app = s3.workspace(&directory.path().join("app"));
    app.unlock(PHRASE).await.unwrap();
    app.open("a.md").await.unwrap();
    let other = s3.workspace(&directory.path().join("other"));
    other.unlock(PHRASE).await.unwrap();
    other.open("a.md").await.unwrap();
    other.stage("a.md", "theirs").unwrap();
    assert_eq!(other.commit("a.md").await.unwrap(), "Saved");

    app.stage("a.md", "mine").unwrap();
    s3.set_delay(Duration::from_millis(300));
    let (committed, staged) = tokio::join!(app.commit("a.md"), async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        app.stage("a.md", "mine, typed during the upload")
    });
    assert_eq!(
        (committed.unwrap(), staged.unwrap()),
        ("ConflictCopy", "Staged")
    );
    s3.set_delay(Duration::ZERO);
    // The newer edit is still based on the old version: another copy, no overwrite.
    assert_eq!(app.commit("a.md").await.unwrap(), "ConflictCopy");
    assert_eq!(app.outbox_entries(), 0);
    assert_eq!(read_fresh(&s3, "a.md").await, "theirs");
    let copies = app
        .paths()
        .into_iter()
        .filter(|path| path.starts_with("a (conflict "))
        .count();
    assert_eq!(copies, 2);
}

/// A vault like the plan's small one: `Projects/` with 10 documents and a
/// marker, `Archive/`, and loose documents.
async fn seeded_vault() -> (FakeS3, tempfile::TempDir) {
    let s3 = FakeS3::start();
    let directory = tempfile::tempdir().unwrap();
    let seed = s3.workspace(&directory.path().join("seed"));
    seed.unlock(PHRASE).await.unwrap();
    seed.put_raw("Projects/.notebook_dir", "").await.unwrap();
    for index in 0..10 {
        seed.put_raw(&format!("Projects/Spec {index}.md"), "spec")
            .await
            .unwrap();
    }
    seed.put_raw("Archive/.notebook_dir", "").await.unwrap();
    for name in ["Inbox.md", "a.md", "b.md", "c.md", "d.md", "e.md"] {
        seed.put_raw(name, name).await.unwrap();
    }
    seed.lock();
    s3.reset_counts();
    (s3, directory)
}

/// Runs `action` and returns the S3 requests it made, by kind.
async fn requests_of<F: std::future::Future>(
    s3: &FakeS3,
    action: F,
) -> BTreeMap<&'static str, usize> {
    s3.reset_counts();
    action.await;
    s3.counts()
}

fn counts(pairs: &[(&'static str, usize)]) -> BTreeMap<&'static str, usize> {
    pairs.iter().copied().collect()
}

#[tokio::test]
async fn every_change_updates_the_tree_without_listing_again() {
    let (s3, directory) = seeded_vault().await;
    let app = s3.workspace(directory.path());
    app.unlock(PHRASE).await.unwrap();
    let version = app.version();
    let created = requests_of(&s3, async {
        app.create_document("", "New.md", "new").await.unwrap();
    });
    assert_eq!(created.await, counts(&[("PUT", 1)]), "create file");
    assert!(app.version() > version, "the change is a new tree version");
    let opened = requests_of(&s3, async {
        assert_eq!(app.open("New.md").await.unwrap(), ("new".into(), false));
    });
    assert_eq!(opened.await, counts(&[]), "open after create");
    let deep = requests_of(&s3, async {
        let name = app.create_at("", &["Alpha", "Beta"], "Gamma.md", "").await;
        assert_eq!(name.unwrap(), "Gamma.md");
    });
    assert_eq!(
        deep.await,
        counts(&[("PUT", 3)]),
        "create /Alpha/Beta/Gamma.md"
    );
    let folder = requests_of(&s3, async {
        app.create_folder("", "Folder").await.unwrap();
    });
    assert_eq!(folder.await, counts(&[("PUT", 1)]), "create folder");
    let renamed = requests_of(&s3, async {
        app.rename("New.md", "Renamed.md").await.unwrap();
    });
    assert_eq!(
        renamed.await,
        counts(&[("COPY", 1), ("DELETE", 1)]),
        "rename file"
    );
    let reopened = requests_of(&s3, async {
        assert_eq!(app.open("Renamed.md").await.unwrap().0, "new");
    });
    assert_eq!(reopened.await, counts(&[]), "open after rename");
    let moved = requests_of(&s3, async {
        app.move_to("Renamed.md", "Archive").await.unwrap();
    });
    assert_eq!(
        moved.await,
        counts(&[("COPY", 1), ("DELETE", 1)]),
        "move file"
    );
    let folder_renamed = requests_of(&s3, async {
        app.rename("Projects", "Projects 2").await.unwrap();
    });
    assert_eq!(
        folder_renamed.await,
        counts(&[("LIST", 1), ("COPY", 11), ("DELETE", 11)]),
        "rename a folder of 10 and its marker"
    );
    let trashed = requests_of(&s3, async {
        app.trash("a.md").await.unwrap();
    });
    assert_eq!(
        trashed.await,
        counts(&[("PUT", 2), ("COPY", 1), ("DELETE", 1)]),
        "trash file (and create the Trash folder)"
    );
    let trashed = requests_of(&s3, async {
        app.trash("b.md").await.unwrap();
    });
    assert_eq!(
        trashed.await,
        counts(&[("PUT", 1), ("COPY", 1), ("DELETE", 1)]),
        "trash file"
    );
    let folder_trashed = requests_of(&s3, async {
        app.trash("Projects 2").await.unwrap();
    });
    assert_eq!(
        folder_trashed.await,
        counts(&[("LIST", 1), ("PUT", 1), ("COPY", 11), ("DELETE", 11)]),
        "trash a folder of 10 at the root"
    );
    let key = |name: &str| {
        app.trash_items()
            .into_iter()
            .find(|item| item.name == name)
            .unwrap()
            .key
    };
    let restored = requests_of(&s3, async {
        assert_eq!(app.restore(&key("a.md")).await.unwrap(), "a.md");
    });
    assert_eq!(
        restored.await,
        counts(&[("LIST", 1), ("COPY", 1), ("DELETE_OBJECTS", 1)]),
        "restore file"
    );
    let folder_restored = requests_of(&s3, async {
        app.restore(&key("Projects 2")).await.unwrap();
    });
    assert_eq!(
        folder_restored.await,
        counts(&[("LIST", 1), ("COPY", 11), ("DELETE_OBJECTS", 1)]),
        "restore a folder of 10"
    );
    for name in ["c.md", "d.md", "e.md"] {
        app.trash(name).await.unwrap();
    }
    let purged = requests_of(&s3, async {
        app.purge(&key("b.md")).await.unwrap();
    });
    assert_eq!(purged.await, counts(&[("DELETE_OBJECTS", 1)]), "purge");
    let emptied = requests_of(&s3, async { app.empty().await.unwrap() });
    assert_eq!(
        emptied.await,
        counts(&[("DELETE_OBJECTS", 1)]),
        "Empty Trash with 3 entries"
    );
    assert!(app.trash_items().is_empty());
    let imported = requests_of(&s3, async {
        for index in 0..5 {
            app.create_document("", &format!("Imported {index}.md"), "text")
                .await
                .unwrap();
        }
    });
    assert_eq!(imported.await, counts(&[("PUT", 5)]), "import 5 files");
    // The map kept by these changes is exactly what a listing finds.
    assert!(app.matches_listing().await.unwrap());
    // Another device sees the same tree.
    let other = s3.workspace(&directory.path().join("other"));
    other.unlock(PHRASE).await.unwrap();
    assert_eq!(other.paths(), app.paths());
    assert_eq!(other.objects(), app.objects());
}

#[tokio::test]
async fn reopening_and_saving_need_no_download() {
    let (s3, directory) = seeded_vault().await;
    let app = s3.workspace(directory.path());
    app.unlock(PHRASE).await.unwrap();
    let first = requests_of(&s3, async { app.open("Inbox.md").await.unwrap() });
    assert_eq!(first.await, counts(&[("GET", 1)]));
    let again = requests_of(&s3, async {
        app.open("a.md").await.unwrap();
        app.open("Inbox.md").await.unwrap();
        app.stage("Inbox.md", "edited").unwrap();
        assert_eq!(app.commit("Inbox.md").await.unwrap(), "Saved");
        assert_eq!(
            app.open("Inbox.md").await.unwrap(),
            ("edited".into(), false)
        );
    });
    assert_eq!(again.await, counts(&[("GET", 1), ("PUT", 1)]));
    // Another device changes it: Refresh sees the new ETag, so the next open
    // downloads that version instead of showing the cached text.
    s3.write_elsewhere("Inbox.md", "changed elsewhere").await;
    let refreshed = requests_of(&s3, async {
        app.refresh().await.unwrap();
        assert_eq!(app.open("Inbox.md").await.unwrap().0, "changed elsewhere");
    });
    assert_eq!(refreshed.await, counts(&[("LIST", 1), ("GET", 1)]));
}

#[tokio::test]
async fn a_save_during_a_refresh_keeps_its_new_version() {
    let (s3, directory) = seeded_vault().await;
    let app = s3.workspace(directory.path());
    app.unlock(PHRASE).await.unwrap();
    app.open("Inbox.md").await.unwrap();
    // The listing reads S3 before the save and answers after it.
    s3.set_slow_list(Duration::from_millis(400));
    let (refreshed, saved) = tokio::join!(app.refresh(), async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        app.stage("Inbox.md", "saved during the refresh").unwrap();
        app.commit("Inbox.md").await
    });
    refreshed.unwrap();
    assert_eq!(saved.unwrap(), "Saved");
    s3.set_slow_list(Duration::ZERO);
    // With the listing's old ETag, the cache would miss and a rename (copy
    // with If-Match) would fail as a change made elsewhere.
    let after = requests_of(&s3, async {
        assert_eq!(
            app.open("Inbox.md").await.unwrap().0,
            "saved during the refresh"
        );
        app.rename("Inbox.md", "Inbox 2.md").await.unwrap();
    });
    assert_eq!(after.await, counts(&[("COPY", 1), ("DELETE", 1)]));
    assert!(app.matches_listing().await.unwrap());
}

#[tokio::test]
async fn a_move_of_a_document_changed_elsewhere_changes_nothing() {
    let (s3, directory) = seeded_vault().await;
    let app = s3.workspace(directory.path());
    app.unlock(PHRASE).await.unwrap();
    s3.write_elsewhere("Projects/Spec 3.md", "theirs").await;
    // The folder's listing sees the new version; the single document does not.
    app.rename("Projects", "Specs").await.unwrap();
    assert_eq!(read_fresh(&s3, "Specs/Spec 3.md").await, "theirs");
    s3.write_elsewhere("a.md", "theirs too").await;
    let error = app.rename("a.md", "z.md").await.unwrap_err();
    assert_eq!(error.code(), "CONFLICT");
    assert!(app.paths().contains(&"a.md".to_owned()));
    assert!(!app.objects().contains(&"z.md".to_owned()));
    // No copy is left behind in S3.
    let fresh = tempfile::tempdir().unwrap();
    let other = s3.workspace(fresh.path());
    other.unlock(PHRASE).await.unwrap();
    assert!(!other.objects().contains(&"z.md".to_owned()));
    app.refresh().await.unwrap();
    app.rename("a.md", "z.md").await.unwrap();
    assert_eq!(read_fresh(&s3, "z.md").await, "theirs too");
}

#[tokio::test]
async fn a_new_path_reuses_folders_whatever_their_case() {
    let (s3, directory) = seeded_vault().await;
    let app = s3.workspace(directory.path());
    app.unlock(PHRASE).await.unwrap();
    let created = requests_of(&s3, async {
        app.create_at("", &["projects", "New"], "x.md", "x")
            .await
            .unwrap();
    });
    assert_eq!(created.await, counts(&[("PUT", 2)]));
    assert!(app.paths().contains(&"Projects/New/x.md".to_owned()));
    let error = app.create_at("", &["a.md"], "y.md", "").await.unwrap_err();
    assert_eq!(error.code(), "INVALID_INPUT");
    // A name taken by an object this session never listed gets a number.
    s3.write_elsewhere("Inbox 1.md", "elsewhere").await;
    s3.write_elsewhere("Taken.md", "elsewhere").await;
    let name = app.create_document("", "Taken.md", "mine").await.unwrap();
    assert_eq!(name, "Taken 2.md");
    assert_eq!(read_fresh(&s3, "Taken.md").await, "elsewhere");
    assert_eq!(read_fresh(&s3, "Taken 2.md").await, "mine");
}

#[tokio::test]
async fn a_conflict_copy_costs_three_requests_and_no_listing() {
    let (s3, directory) = seeded_vault().await;
    let app = s3.workspace(directory.path());
    app.unlock(PHRASE).await.unwrap();
    app.open("a.md").await.unwrap();
    s3.write_elsewhere("a.md", "theirs").await;
    app.stage("a.md", "mine").unwrap();
    let saved = requests_of(&s3, async {
        assert_eq!(app.commit("a.md").await.unwrap(), "ConflictCopy");
    });
    assert_eq!(saved.await, counts(&[("GET", 1), ("PUT", 2)]));
    // Both versions open without a download.
    let copy = app
        .paths()
        .into_iter()
        .find(|path| path.starts_with("a (conflict "))
        .unwrap();
    let opened = requests_of(&s3, async {
        assert_eq!(app.open(&copy).await.unwrap().0, "mine");
        assert_eq!(app.open("a.md").await.unwrap().0, "theirs");
    });
    assert_eq!(opened.await, counts(&[]));
    assert!(app.matches_listing().await.unwrap());
}

/// Two workspaces (two buckets) with the same phrase, prefix and document
/// path share S3 keys. An upload of workspace A that finishes after the user
/// switched to B and edited the same path never re-bases, stages or replays
/// anything of B: each bucket keeps its own edit.
#[tokio::test]
async fn a_slow_upload_of_one_workspace_never_writes_into_another() {
    let (a, directory) = seeded().await;
    let b = FakeS3::start();
    {
        let seed_dir = tempfile::tempdir().unwrap();
        let seed = b.workspace(seed_dir.path());
        seed.unlock(PHRASE).await.unwrap();
        // Other ETags than bucket A's.
        for name in ["c.md", "d.md", "e.md"] {
            seed.put_raw(name, "filler").await.unwrap();
        }
        seed.put_raw("a.md", "bravo").await.unwrap();
        seed.lock();
    }
    let app = a.workspace(directory.path());
    let a_id = app.active_id();
    let b_id = app.add_workspace(&b.endpoint, BUCKET, "vault");
    app.unlock(PHRASE).await.unwrap();
    app.open("a.md").await.unwrap();
    app.stage("a.md", "edit in A").unwrap();
    // Long enough for B's unlock (key derivation in a debug build) to finish
    // before A's upload answers.
    let delay = Duration::from_secs(8);
    a.set_delay(delay);
    let started = Instant::now();
    let (lingering, ()) = tokio::join!(app.commit("a.md"), async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        // The page gave up waiting and switched.
        app.select(&b_id).unwrap();
        app.unlock(PHRASE).await.unwrap();
        assert_eq!(app.open("a.md").await.unwrap().0, "bravo");
        app.stage("a.md", "edit in B").unwrap();
        assert!(
            started.elapsed() < delay,
            "B was staged before A's upload ended"
        );
    });
    a.set_delay(Duration::ZERO);
    // S3 took A's edit; its session's journal is gone, so nothing else moved.
    assert_eq!(lingering.unwrap(), "Saved");
    assert_eq!(app.open("a.md").await.unwrap(), ("edit in B".into(), true));
    assert_eq!(app.commit("a.md").await.unwrap(), "Saved");
    app.select(&a_id).unwrap();
    app.unlock(PHRASE).await.unwrap();
    assert_eq!(
        app.outbox_entries(),
        0,
        "the next unlock of A settled its outbox"
    );
    assert_eq!(read_fresh(&a, "a.md").await, "edit in A");
    assert_eq!(read_fresh(&b, "a.md").await, "edit in B");
}
