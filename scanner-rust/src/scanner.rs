use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::json;

use crate::errors::{io_issue, make_issue};
use crate::process_stats;
use crate::protocol::{
    summary_value, Entry, EventSink, ScanIssue, ScanRequest, ScanResult, ScanSummary, Volume,
};
use crate::traversal::Traversal;
use crate::windows::enumeration::symlink_metadata;
use crate::windows::native::read_entries;
use crate::windows::paths::{display_path, normalize_path};
use crate::windows::reparse::is_reparse;

const CATEGORY_NAMES: [&str; 9] = [
    "apps",
    "developer",
    "photos",
    "movies",
    "documents",
    "music",
    "system",
    "caches",
    "trash",
];

struct State {
    volume: Volume,
    entries: Vec<Entry>,
    pending: Vec<Entry>,
    errors: Vec<ScanIssue>,
    category_bytes: BTreeMap<String, u64>,
    measured: u64,
    collect_entries: bool,
    file_entries: usize,
    directory_entries: usize,
}

impl State {
    fn new(volume: Volume, collect_entries: bool) -> Self {
        let mut category_bytes = BTreeMap::new();
        for name in CATEGORY_NAMES {
            category_bytes.insert(name.to_string(), 0);
        }
        Self {
            volume,
            entries: Vec::new(),
            pending: Vec::new(),
            errors: Vec::new(),
            category_bytes,
            measured: 0,
            collect_entries,
            file_entries: 0,
            directory_entries: 0,
        }
    }

    fn add_entry(&mut self, entry: Entry) {
        self.measured = self.measured.saturating_add(entry.logical_bytes);
        *self
            .category_bytes
            .entry(entry.category.clone())
            .or_insert(0) += entry.logical_bytes;
        if entry.kind == "file" {
            self.file_entries += 1;
        } else if entry.kind == "directory" {
            self.directory_entries += 1;
        }
        self.pending.push(entry.clone());
        if self.collect_entries {
            self.entries.push(entry);
        }
    }

    fn add_issue(&mut self, issue: ScanIssue, sink: &mut dyn EventSink) -> io::Result<()> {
        let event = if issue.kind == "reparse" {
            "scan_warning"
        } else {
            "scan_error"
        };
        sink.emit(
            event,
            json!({
                "displayPath": issue.display_path,
                "pathKey": issue.path_key,
                "kind": issue.kind,
                "message": issue.message,
            }),
        )?;
        self.errors.push(issue);
        Ok(())
    }

    fn flush_entries(
        &mut self,
        sink: &mut dyn EventSink,
        batch_size: usize,
        force: bool,
    ) -> io::Result<()> {
        if !force && self.pending.len() < batch_size {
            return Ok(());
        }
        while !self.pending.is_empty() {
            let end = batch_size.min(self.pending.len());
            let batch: Vec<Entry> = self.pending.drain(..end).collect();
            sink.emit("entries_batch", json!({ "entries": batch }))?;
        }
        Ok(())
    }

    fn finish(
        self,
        phase: &str,
        error: Option<String>,
        sink: &mut dyn EventSink,
        batch_size: usize,
    ) -> io::Result<ScanResult> {
        let mut state = self;
        state.flush_entries(sink, batch_size, true)?;
        let unmeasured = state.volume.used_bytes.saturating_sub(state.measured);
        if phase == "completed" {
            *state
                .category_bytes
                .entry("system".to_string())
                .or_insert(0) += unmeasured;
        }
        let summary = ScanSummary {
            measured_bytes: state.measured,
            unmeasured_bytes: unmeasured,
            category_bytes: state.category_bytes,
            file_entries: state.file_entries,
            directory_entries: state.directory_entries,
            error_count: state.errors.len(),
        };
        let event = match phase {
            "completed" => "scan_completed",
            "cancelled" => "scan_cancelled",
            _ => "scan_failed",
        };
        sink.emit(
            event,
            json!({
                "summary": summary_value(&summary),
                "error": error,
                "runtime": process_stats::current(),
            }),
        )?;
        Ok(ScanResult {
            phase: phase.to_string(),
            partial: phase != "completed",
            error,
            entries: state.entries,
            errors: state.errors,
            summary,
            volume: state.volume,
        })
    }
}

pub fn scan(
    request: &ScanRequest,
    sink: &mut dyn EventSink,
    cancel: &AtomicBool,
) -> io::Result<ScanResult> {
    let batch_size = request.options.batch_size.clamp(1, 1_000);
    let mut state = State::new(request.volume.clone(), request.options.collect_entries);
    sink.emit(
        "scan_started",
        json!({
            "rootCount": request.roots.len(),
            "batchSize": batch_size,
            "threads": request.options.threads.max(1),
        }),
    )?;

    let traversal = Traversal::new(request, cancel);
    for root in &request.roots {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let path = PathBuf::from(&root.path);
        if traversal.is_foreign_root(&path) {
            continue;
        }
        scan_root(
            &mut state,
            &traversal,
            &path,
            &root.category,
            sink,
            batch_size,
            request.options.threads.max(1),
        )?;
        state.flush_entries(sink, batch_size, true)?;
        sink.emit(
            "progress",
            json!({
                "root": root.path,
                "category": root.category,
                "measuredBytes": state.measured,
                "entries": state.entries.len(),
                "errors": state.errors.len(),
            }),
        )?;
    }

    let phase = if cancel.load(Ordering::Relaxed) {
        "cancelled"
    } else {
        "completed"
    };
    state.finish(phase, None, sink, batch_size)
}

fn scan_root(
    state: &mut State,
    traversal: &Traversal<'_>,
    path: &Path,
    category: &str,
    sink: &mut dyn EventSink,
    batch_size: usize,
    threads: usize,
) -> io::Result<()> {
    if traversal.cancelled() {
        return Ok(());
    }
    let metadata = match symlink_metadata(path) {
        Ok(value) => value,
        Err(error) => {
            state.add_issue(io_issue(path, &error), sink)?;
            return Ok(());
        }
    };
    if is_reparse(&metadata) {
        state.add_issue(
            make_issue(
                path,
                "reparse",
                "reparse point was not traversed".to_string(),
            ),
            sink,
        )?;
        return Ok(());
    }
    if !metadata.is_dir() {
        if metadata.len() > 0 {
            state.add_entry(Entry {
                display_path: display_path(path),
                path_key: normalize_path(path),
                kind: "file".to_string(),
                logical_bytes: metadata.len(),
                category: category.to_string(),
            });
            state.flush_entries(sink, batch_size, false)?;
        }
        return Ok(());
    }

    let entries = match read_entries(path) {
        Ok(value) => value,
        Err(error) => {
            state.add_issue(io_issue(path, &error), sink)?;
            return Ok(());
        }
    };
    let mut directories = Vec::new();
    for entry in entries {
        if traversal.cancelled() {
            break;
        }
        if traversal.should_skip(&entry.path) {
            continue;
        }
        if entry.is_dir {
            directories.push(entry.path);
            continue;
        }
        if entry.is_reparse {
            // Keep the reparse entry visible even when Windows reports a
            // zero-length link record, so callers can see the exclusion.
            state.add_entry(Entry {
                display_path: display_path(&entry.path),
                path_key: normalize_path(&entry.path),
                kind: "reparse".to_string(),
                logical_bytes: entry.logical_bytes,
                category: category.to_string(),
            });
            state.flush_entries(sink, batch_size, false)?;
        } else if entry.logical_bytes > 0 {
            state.add_entry(Entry {
                display_path: display_path(&entry.path),
                path_key: normalize_path(&entry.path),
                kind: "file".to_string(),
                logical_bytes: entry.logical_bytes,
                category: category.to_string(),
            });
            state.flush_entries(sink, batch_size, false)?;
        }
    }

    let measured = traversal.measure_dirs(&directories, threads);
    for (index, result) in measured.into_iter().enumerate() {
        if traversal.cancelled() {
            break;
        }
        for issue in result.errors {
            state.add_issue(issue, sink)?;
        }
        if result.bytes > 0 {
            let directory = &directories[index];
            state.add_entry(Entry {
                display_path: display_path(directory),
                path_key: normalize_path(directory),
                kind: "directory".to_string(),
                logical_bytes: result.bytes,
                category: category.to_string(),
            });
            state.flush_entries(sink, batch_size, false)?;
        }
    }
    Ok(())
}
