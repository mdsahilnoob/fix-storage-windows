use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use fix_storage_scanner_rust::metadata::EntryKind;
use fix_storage_scanner_rust::protocol::{
    EventSink, NullSink, RootRequest, ScanOptions, ScanRequest, Volume,
};
use fix_storage_scanner_rust::scanner::scan;
use fix_storage_scanner_rust::windows::paths::{display_path, extended_path, normalize_path};

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "fix-storage-rust-{name}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    fn write(&self, relative: &str, bytes: usize) -> PathBuf {
        let path = self.path(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, vec![7u8; bytes]).unwrap();
        path
    }

    fn dir(&self, relative: &str) -> PathBuf {
        let path = self.path(relative);
        fs::create_dir_all(&path).unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(extended_path(&self.root));
    }
}

fn request(
    _root: &Path,
    roots: Vec<RootRequest>,
    skip: Vec<String>,
    foreign: Vec<String>,
    used: u64,
) -> ScanRequest {
    ScanRequest {
        kind: "scan_request".to_string(),
        schema_version: "1.0".to_string(),
        request_id: "test-request".to_string(),
        roots,
        skip_paths: skip,
        foreign_paths: foreign,
        volume: Volume {
            id: "test-volume".to_string(),
            mount: "C:\\".to_string(),
            total_bytes: 1_000_000_000,
            used_bytes: used,
            available_bytes: 100_000_000,
        },
        options: ScanOptions {
            batch_size: 2,
            threads: 1,
            collect_entries: true,
        },
    }
}

fn root(path: &Path, category: &str) -> RootRequest {
    RootRequest {
        path: path.to_string_lossy().to_string(),
        category: category.to_string(),
    }
}

#[derive(Default)]
struct RecordingSink {
    events: Vec<Value>,
}

impl EventSink for RecordingSink {
    fn emit(&mut self, event_type: &str, payload: Value) -> std::io::Result<()> {
        self.events
            .push(serde_json::json!({ "type": event_type, "payload": payload }));
        Ok(())
    }
}

#[test]
fn traverses_and_aggregates_logical_sizes() {
    let fixture = Fixture::new("traversal");
    let a = fixture.write("a.bin", 1000);
    fixture.write("sub/b.bin", 2048);
    fixture.write("sub/nested/c.bin", 300);
    fixture.write("empty.bin", 0);
    let request = request(
        &fixture.root,
        vec![root(&fixture.root, "documents")],
        vec![],
        vec![],
        1_000_000,
    );
    let result = scan(&request, &mut NullSink, &AtomicBool::new(false)).unwrap();

    assert_eq!(result.phase, "completed");
    assert_eq!(result.summary.measured_bytes, 3348);
    assert_eq!(result.summary.category_bytes["documents"], 3348);
    assert_eq!(result.summary.category_bytes["system"], 1_000_000 - 3348);
    assert_eq!(result.summary.unmeasured_bytes, 1_000_000 - 3348);
    assert_eq!(result.entries.len(), 2);
    let directory = result
        .entries
        .iter()
        .find(|entry| entry.path_key == normalize_path(&fixture.path("sub")))
        .unwrap();
    assert_eq!(directory.kind, "directory");
    assert_eq!(directory.logical_bytes, 2348);
    let file = result
        .entries
        .iter()
        .find(|entry| entry.path_key == normalize_path(&a))
        .unwrap();
    assert_eq!(file.kind, EntryKind::File.as_str());
    assert_eq!(file.logical_bytes, 1000);
}

#[test]
fn nested_roots_are_not_double_counted() {
    let fixture = Fixture::new("nested");
    fixture.write("parent/a.bin", 1000);
    fixture.write("parent/child/b.bin", 2000);
    let child = fixture.path("parent/child");
    let request = request(
        &fixture.root,
        vec![
            root(&fixture.path("parent"), "documents"),
            root(&child, "apps"),
        ],
        vec![],
        vec![],
        1_000_000,
    );
    let result = scan(&request, &mut NullSink, &AtomicBool::new(false)).unwrap();

    assert_eq!(result.summary.measured_bytes, 3000);
    assert_eq!(result.summary.category_bytes["documents"], 1000);
    assert_eq!(result.summary.category_bytes["apps"], 2000);
}

#[test]
fn skip_and_foreign_boundaries_are_excluded() {
    let fixture = Fixture::new("boundaries");
    fixture.write("local.bin", 100);
    fixture.write("skip/ignored.bin", 500);
    fixture.write("foreign/ignored.bin", 700);
    let request = request(
        &fixture.root,
        vec![root(&fixture.root, "documents")],
        vec![fixture.path("skip").to_string_lossy().to_string()],
        vec![fixture.path("foreign").to_string_lossy().to_string()],
        1_000_000,
    );
    let result = scan(&request, &mut NullSink, &AtomicBool::new(false)).unwrap();

    assert_eq!(result.summary.measured_bytes, 100);
    assert_eq!(result.entries.len(), 1);
    assert_eq!(
        result.entries[0].display_path,
        display_path(&fixture.path("local.bin"))
    );
}

#[test]
fn cancellation_keeps_partial_results_and_no_system_inflation() {
    let fixture = Fixture::new("cancel");
    for index in 0..40 {
        fixture.write(&format!("bulk/{index}.bin"), 200);
    }
    let cancel = AtomicBool::new(true);
    let request = request(
        &fixture.root,
        vec![root(&fixture.root, "documents")],
        vec![],
        vec![],
        1_000_000,
    );
    let result = scan(&request, &mut NullSink, &cancel).unwrap();

    assert_eq!(result.phase, "cancelled");
    assert!(result.partial);
    assert_eq!(result.summary.category_bytes["system"], 0);
    assert_eq!(result.summary.unmeasured_bytes, 1_000_000);
}

#[test]
fn missing_roots_are_reported_as_errors_not_completion_successes() {
    let fixture = Fixture::new("missing");
    let missing = fixture.path("does-not-exist");
    let request = request(
        &missing,
        vec![root(&missing, "documents")],
        vec![],
        vec![],
        1_000_000,
    );
    let result = scan(&request, &mut NullSink, &AtomicBool::new(false)).unwrap();

    assert_eq!(result.phase, "completed");
    assert_eq!(result.summary.measured_bytes, 0);
    assert_eq!(result.summary.error_count, 1);
    assert!(result.errors[0].path_key.contains("does-not-exist"));
}

#[test]
fn unicode_paths_are_preserved() {
    let fixture = Fixture::new("unicode");
    let file = fixture.write("unicodé-文件-😀/résumé.txt", 777);
    let request = request(
        &fixture.root,
        vec![root(&fixture.root, "documents")],
        vec![],
        vec![],
        1_000_000,
    );
    let result = scan(&request, &mut NullSink, &AtomicBool::new(false)).unwrap();

    assert_eq!(result.summary.measured_bytes, 777);
    let entry = result
        .entries
        .iter()
        .find(|entry| entry.kind == "directory")
        .unwrap();
    assert_eq!(
        entry.display_path,
        display_path(&fixture.path("unicodé-文件-😀"))
    );
    assert_eq!(entry.logical_bytes, 777);
    assert!(file.to_string_lossy().contains("résumé.txt"));
}

#[test]
fn batches_are_bounded_and_protocol_emits_terminal_event() {
    let fixture = Fixture::new("batches");
    for index in 0..5 {
        fixture.write(&format!("file-{index}.bin"), 100);
    }
    let request = request(
        &fixture.root,
        vec![root(&fixture.root, "documents")],
        vec![],
        vec![],
        1_000_000,
    );
    let mut sink = RecordingSink::default();
    let result = scan(&request, &mut sink, &AtomicBool::new(false)).unwrap();

    assert_eq!(result.phase, "completed");
    let batches: Vec<&Value> = sink
        .events
        .iter()
        .filter(|event| event["type"] == "entries_batch")
        .collect();
    assert!(!batches.is_empty());
    for batch in batches {
        assert!(batch["payload"]["entries"].as_array().unwrap().len() <= 2);
    }
    assert!(sink
        .events
        .iter()
        .any(|event| event["type"] == "scan_completed"));
    assert_eq!(result.entries.len(), 5);
}

#[test]
fn long_paths_are_scanned_with_extended_io() {
    let fixture = Fixture::new("long");
    let mut deep = fixture.root.clone();
    for index in 0..8 {
        deep = deep.join(format!("segment-{index}-{}", "x".repeat(32)));
    }
    fs::create_dir_all(extended_path(&deep)).unwrap();
    let file = deep.join("long.bin");
    fs::write(extended_path(&file), vec![7u8; 1234]).unwrap();
    let request = request(
        &deep,
        vec![root(&deep, "documents")],
        vec![],
        vec![],
        1_000_000,
    );
    let result = scan(&request, &mut NullSink, &AtomicBool::new(false)).unwrap();

    assert_eq!(result.phase, "completed");
    assert_eq!(result.summary.measured_bytes, 1234);
    assert_eq!(result.entries[0].display_path, display_path(&file));
}

#[cfg(windows)]
#[test]
fn junction_entries_are_reparse_items_and_not_traversed() {
    let fixture = Fixture::new("junction");
    let target = fixture.dir("target");
    fixture.write("target/inside.bin", 4096);
    let link = fixture.path("junction");
    if std::os::windows::fs::symlink_dir(&target, &link).is_err() {
        return;
    }
    let link_size = fs::read_link(&link).unwrap().to_string_lossy().len() as u64;
    let request = request(
        &fixture.root,
        vec![root(&fixture.root, "documents")],
        vec![],
        vec![],
        1_000_000,
    );
    let result = scan(&request, &mut NullSink, &AtomicBool::new(false)).unwrap();

    let link_entry = result
        .entries
        .iter()
        .find(|entry| entry.path_key == normalize_path(&link))
        .unwrap();
    assert_eq!(link_entry.kind, "reparse");
    assert_eq!(link_entry.logical_bytes, link_size);
    assert_eq!(result.summary.measured_bytes, 4096 + link_size);
}
