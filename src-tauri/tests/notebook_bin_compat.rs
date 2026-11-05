//! Deleted-items compatibility with the real Notebook app, end to end on a
//! throwaway MinIO. Skipped unless `NOTEBOOK_MINIO_URL` is set; run it with
//! `scripts/notebook-compat.sh`, which starts MinIO, creates the bucket and
//! builds the Notebook harness (`tests/notebook-harness`).

use notebook_app::notebook::testing::{TrashItem, Workspace};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const PHRASE: &str = "compat test phrase, not a secret";

struct Minio {
    endpoint: String,
    bucket: String,
    access_key_id: String,
    secret_access_key: String,
    harness: PathBuf,
}

fn minio() -> Option<Minio> {
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
    Some(Minio {
        endpoint: std::env::var("NOTEBOOK_MINIO_URL").ok()?,
        bucket: var("NOTEBOOK_MINIO_BUCKET"),
        access_key_id: var("NOTEBOOK_MINIO_ACCESS_KEY_ID"),
        secret_access_key: var("NOTEBOOK_MINIO_SECRET_ACCESS_KEY"),
        harness: var("NOTEBOOK_HARNESS_BIN").into(),
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Notebook's own code, one action per process, with an empty environment so
/// it cannot read any real AWS profile or Notebook setting.
struct Notebook<'a> {
    minio: &'a Minio,
    prefix: &'a str,
    home: PathBuf,
}

impl Notebook<'_> {
    fn run(&self, args: &[&str]) -> Result<String, String> {
        let output = Command::new(&self.minio.harness)
            .args(args)
            .env_clear()
            .env("HOME", &self.home)
            .env("AWS_CONFIG_FILE", self.home.join("aws-config"))
            .env(
                "AWS_SHARED_CREDENTIALS_FILE",
                self.home.join("aws-credentials"),
            )
            .env("AWS_EC2_METADATA_DISABLED", "true")
            .env("NB_ENDPOINT", &self.minio.endpoint)
            .env("NB_BUCKET", &self.minio.bucket)
            .env("NB_PREFIX", self.prefix)
            .env("NB_ACCESS_KEY_ID", &self.minio.access_key_id)
            .env("NB_SECRET_ACCESS_KEY", &self.minio.secret_access_key)
            .env("NB_PHRASE", PHRASE)
            .output()
            .expect("the Notebook harness runs");
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
        }
    }

    fn ok(&self, args: &[&str]) -> String {
        self.run(args)
            .unwrap_or_else(|error| panic!("Notebook {args:?} failed: {error}"))
    }

    fn catalog(&self) -> Vec<Value> {
        serde_json::from_str(&self.ok(&["catalog"])).unwrap()
    }

    fn tree(&self) -> Vec<String> {
        serde_json::from_str(&self.ok(&["tree"])).unwrap()
    }

    fn item(&self, original_path: &str) -> Option<Value> {
        self.catalog()
            .into_iter()
            .find(|item| item["original_path"] == original_path)
    }
}

fn find<'a>(items: &'a [TrashItem], original_path: &str) -> &'a TrashItem {
    items
        .iter()
        .find(|item| item.original_path == original_path)
        .unwrap_or_else(|| panic!("{original_path} is not in this app's Trash: {items:#?}"))
}

fn print_catalog(label: &str, catalog: &[Value]) {
    println!("{label}:");
    for item in catalog {
        println!(
            "  {:<34} {:<18} {:<20} deleted_at={}",
            item["id"].as_str().unwrap_or_default(),
            item["name"].as_str().unwrap_or_default(),
            item["list_annotation"].as_str().unwrap_or_default(),
            item["deleted_at_unix_ms"]
        );
    }
}

fn print_trash(label: &str, items: &[TrashItem]) {
    println!("{label}:");
    for item in items {
        println!(
            "  {:<38} {:<18} from /{:<14} {} deleted_at={:?}",
            item.key,
            item.name,
            item.location,
            if item.is_folder {
                format!("{} items", item.item_count)
            } else {
                String::from("document")
            },
            item.deleted_at_ms
        );
    }
}

#[tokio::test]
async fn deleted_items_are_shared_with_notebook() {
    let Some(minio) = minio() else {
        eprintln!("skipped: NOTEBOOK_MINIO_URL is not set (see scripts/notebook-compat.sh)");
        return;
    };
    let scratch = tempfile::tempdir().unwrap();
    let prefix = format!("compat-{}", now_ms());
    let notebook = Notebook {
        minio: &minio,
        prefix: &prefix,
        home: scratch.path().join("notebook-home"),
    };
    std::fs::create_dir_all(&notebook.home).unwrap();

    // 1. Notebook creates content and deletes part of it with its own delete.
    notebook.ok(&["write", "Projects/alpha.md", "alpha body"]);
    notebook.ok(&["write", "Projects/Drafts/idea.md", "idea body"]);
    notebook.ok(&["mkdir", "Projects/Drafts/Empty"]);
    notebook.ok(&["write", "todo.md", "todo body"]);
    notebook.ok(&["write", "Archive/2024/old.md", "old body"]);
    let started = now_ms();
    for path in ["Projects/alpha.md", "Projects/Drafts", "todo.md", "Archive"] {
        notebook.ok(&["delete", path]);
    }
    let finished = now_ms();
    let catalog = notebook.catalog();
    print_catalog("Notebook bin after Notebook deleted 4 items", &catalog);
    assert_eq!(catalog.len(), 4);

    // 2. This app lists exactly Notebook's entries, in Notebook's order.
    let app = Workspace::new(
        &scratch.path().join("app"),
        &minio.endpoint,
        &minio.bucket,
        &prefix,
        &minio.access_key_id,
        &minio.secret_access_key,
    );
    app.unlock(PHRASE).await.unwrap();
    let trash = app.trash_items();
    print_trash("This app's Trash", &trash);
    assert_eq!(app.paths(), ["Projects/"]);
    assert_eq!(trash.len(), catalog.len());
    for (ours, theirs) in trash.iter().zip(&catalog) {
        assert_eq!(ours.key, format!("bin:{}", theirs["id"].as_str().unwrap()));
        assert_eq!(ours.name, theirs["name"]);
        assert_eq!(ours.original_path, theirs["original_path"]);
        assert_eq!(ours.location, theirs["original_parent_path"]);
        assert_eq!(ours.deleted_at_ms, theirs["deleted_at_unix_ms"].as_u64());
        assert_eq!(ours.is_folder, theirs["is_directory"]);
        assert_eq!(ours.item_count as u64, theirs["descendant_count"]);
        assert!(!ours.legacy);
        let deleted_at = ours.deleted_at_ms.unwrap();
        assert!((started..=finished).contains(&deleted_at));
    }
    let expected = [
        ("Archive", "", true, 2),
        ("todo.md", "", false, 0),
        ("Projects/Drafts", "Projects", true, 2),
        ("Projects/alpha.md", "Projects", false, 0),
    ];
    for (item, (path, location, folder, count)) in trash.iter().zip(expected) {
        assert_eq!(
            (item.original_path.as_str(), item.location.as_str()),
            (path, location)
        );
        assert_eq!((item.is_folder, item.item_count), (folder, count));
    }
    let summary = app.snapshot_summary();
    assert_eq!(
        summary
            .iter()
            .filter(|(_, _, kind)| *kind == "TrashEntry")
            .count(),
        4
    );
    assert!(summary.iter().all(|(_, name, _)| name != "_deleted"));
    let plaintext = [
        "_deleted",
        "items",
        "item",
        "parent",
        ".notebook_dir",
        "Projects",
        "alpha.md",
        "todo.md",
        "Archive",
    ];
    for key in app.stored_keys() {
        let relative = key.strip_prefix(&format!("{prefix}/")).unwrap();
        assert!(
            relative
                .split('/')
                .all(|segment| !plaintext.contains(&segment)),
            "plaintext segment in an S3 key"
        );
    }

    // 3. Restore here; Notebook sees the result and the container is gone.
    let alpha = find(&trash, "Projects/alpha.md").key.clone();
    assert_eq!(app.restore(&alpha).await.unwrap(), "Projects/alpha.md");
    let drafts = find(&trash, "Projects/Drafts").key.clone();
    assert_eq!(app.restore(&drafts).await.unwrap(), "Projects/Drafts");
    let tree = notebook.tree();
    for path in [
        "Projects/alpha.md",
        "Projects/Drafts/",
        "Projects/Drafts/Empty/",
        "Projects/Drafts/idea.md",
    ] {
        assert!(
            tree.contains(&path.to_owned()),
            "{path} missing in {tree:?}"
        );
    }
    assert_eq!(notebook.ok(&["read", "Projects/alpha.md"]), "alpha body");
    assert!(notebook.item("Projects/alpha.md").is_none());
    assert!(notebook.item("Projects/Drafts").is_none());
    for key in [&alpha, &drafts] {
        let container = format!("_deleted/items/{}/", key.trim_start_matches("bin:"));
        assert!(
            app.objects()
                .iter()
                .all(|path| !path.starts_with(&container))
        );
    }
    println!("Restored here, Notebook tree: {tree:?}");

    // 4. An occupied original path is refused by both apps, never overwritten.
    notebook.ok(&["write", "todo.md", "new todo"]);
    app.refresh().await.unwrap();
    let todo = find(&app.trash_items(), "todo.md").key.clone();
    let conflict = app.restore(&todo).await.unwrap_err();
    assert_eq!(conflict.code(), "RESTORE_CONFLICT");
    let notebook_conflict = notebook
        .run(&["restore", todo.trim_start_matches("bin:")])
        .unwrap_err();
    assert!(notebook_conflict.contains("already exists"));
    println!("Both refuse an occupied original path; Notebook says: {notebook_conflict}");
    let restored = app
        .restore_to(&todo, "Projects", Some("todo (restored).md"))
        .await
        .unwrap();
    assert_eq!(restored, "Projects/todo (restored).md");
    assert_eq!(notebook.ok(&["read", "todo.md"]), "new todo");
    assert_eq!(
        notebook.ok(&["read", "Projects/todo (restored).md"]),
        "todo body"
    );

    // 5. Purge here removes only that entry's objects.
    let archive = find(&app.trash_items(), "Archive").key.clone();
    let before = app.objects();
    app.purge(&archive).await.unwrap();
    let container = format!("_deleted/items/{}/", archive.trim_start_matches("bin:"));
    let removed = before
        .iter()
        .filter(|path| !app.objects().contains(path))
        .cloned()
        .collect::<Vec<_>>();
    assert!(!removed.is_empty());
    assert!(removed.iter().all(|path| path.starts_with(&container)));
    assert!(notebook.catalog().is_empty());
    assert!(app.trash_items().is_empty());

    // 6. Deleted here: Notebook lists it with the right origin, restores and
    //    purges it.
    app.create_folder("", "Inbox").await.unwrap();
    app.create_document("Inbox", "today.md", "today body")
        .await
        .unwrap();
    app.create_folder("Inbox", "Sub").await.unwrap();
    app.create_document("Inbox/Sub", "deep.md", "deep body")
        .await
        .unwrap();
    let started = now_ms();
    let today = app.trash("Inbox/today.md").await.unwrap();
    let sub = app.trash("Inbox/Sub").await.unwrap();
    let finished = now_ms();
    let catalog = notebook.catalog();
    print_catalog("Notebook bin after this app deleted 2 items", &catalog);
    let today_item = notebook.item("Inbox/today.md").expect("Notebook lists it");
    assert_eq!(today_item["id"], today.trim_start_matches("bin:"));
    assert_eq!(today_item["original_parent_path"], "Inbox");
    assert_eq!(today_item["list_annotation"], "/Inbox");
    assert_eq!(today_item["is_directory"], false);
    let sub_item = notebook.item("Inbox/Sub").expect("Notebook lists it");
    assert_eq!(sub_item["id"], sub.trim_start_matches("bin:"));
    assert_eq!(sub_item["list_annotation"], "/Inbox | 1 item");
    assert_eq!(sub_item["is_directory"], true);
    for item in [&today_item, &sub_item] {
        let deleted_at = item["deleted_at_unix_ms"].as_u64().unwrap();
        assert!((started..=finished).contains(&deleted_at));
    }
    notebook.ok(&["restore", today.trim_start_matches("bin:")]);
    notebook.ok(&["purge", sub.trim_start_matches("bin:")]);
    app.refresh().await.unwrap();
    assert!(app.paths().contains(&"Inbox/today.md".to_owned()));
    assert!(!app.paths().iter().any(|path| path.starts_with("Inbox/Sub")));
    assert_eq!(app.read("Inbox/today.md").await.unwrap(), "today body");
    assert!(app.trash_items().is_empty());
    let leftover = format!("_deleted/items/{}/", sub.trim_start_matches("bin:"));
    assert!(
        app.objects()
            .iter()
            .all(|path| !path.starts_with(&leftover))
    );

    // 7. Bin names are reserved here as in Notebook.
    for name in ["_deleted", "_delete", ".secure-vault-trash"] {
        assert_eq!(
            app.create_folder("", name).await.unwrap_err().code(),
            "INVALID_INPUT"
        );
    }
    assert!(notebook.run(&["mkdir", "_deleted"]).is_err());

    // 8. Legacy `.secure-vault-trash` entries of earlier builds stay
    //    restorable and purgeable; Empty Trash removes every bin entry.
    app.put_raw(".secure-vault-trash/0d1e/Inbox/legacy.md", "legacy body")
        .await
        .unwrap();
    app.put_raw(".secure-vault-trash/7a2b/Old/.notebook_dir", "")
        .await
        .unwrap();
    app.put_raw(".secure-vault-trash/7a2b/Old/a.md", "a")
        .await
        .unwrap();
    notebook.ok(&["write", "gone.md", "gone"]);
    notebook.ok(&["delete", "gone.md"]);
    app.refresh().await.unwrap();
    let trash = app.trash_items();
    print_trash("This app's Trash with legacy entries", &trash);
    assert_eq!(trash.len(), 3);
    assert_eq!(trash[0].original_path, "gone.md");
    assert!(trash[1..].iter().all(|item| item.legacy));
    assert_eq!(app.restore("legacy:0d1e").await.unwrap(), "Inbox/legacy.md");
    assert_eq!(notebook.ok(&["read", "Inbox/legacy.md"]), "legacy body");
    app.empty().await.unwrap();
    assert!(app.trash_items().is_empty());
    assert!(notebook.catalog().is_empty());
    assert!(app.objects().iter().all(|path| {
        !path.starts_with(".secure-vault-trash/") && !path.starts_with("_deleted/items/1")
    }));
    println!("Final tree in Notebook: {:?}", notebook.tree());
    println!("Final tree here: {:?}", app.paths());
}
