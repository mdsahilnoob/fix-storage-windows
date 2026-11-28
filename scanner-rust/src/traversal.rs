use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use crate::errors::io_issue;
use crate::protocol::{ScanIssue, ScanRequest};
use crate::windows::native::read_entries;
use crate::windows::paths::normalize_path;

pub struct DirMeasurement {
    pub bytes: u64,
    pub errors: Vec<ScanIssue>,
}

pub struct Traversal<'a> {
    pub root_keys: HashSet<String>,
    skip_keys: HashSet<String>,
    foreign_keys: HashSet<String>,
    cancel: &'a AtomicBool,
}

impl<'a> Traversal<'a> {
    pub fn new(request: &ScanRequest, cancel: &'a AtomicBool) -> Self {
        Self {
            root_keys: request
                .roots
                .iter()
                .map(|root| normalize_path(Path::new(&root.path)))
                .collect(),
            skip_keys: request
                .skip_paths
                .iter()
                .map(|path| normalize_path(Path::new(path)))
                .collect(),
            foreign_keys: request
                .foreign_paths
                .iter()
                .map(|path| normalize_path(Path::new(path)))
                .collect(),
            cancel,
        }
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub fn should_skip(&self, path: &Path) -> bool {
        let key = normalize_path(path);
        self.root_keys.contains(&key)
            || self.skip_keys.contains(&key)
            || self.foreign_keys.contains(&key)
    }

    pub fn is_foreign_root(&self, path: &Path) -> bool {
        self.foreign_keys.contains(&normalize_path(path))
    }

    pub fn measure_dir(&self, path: &Path) -> DirMeasurement {
        let mut result = DirMeasurement {
            bytes: 0,
            errors: Vec::new(),
        };
        if self.cancelled() {
            return result;
        }
        let entries = match read_entries(path) {
            Ok(entries) => entries,
            Err(error) => {
                result.errors.push(io_issue(path, &error));
                return result;
            }
        };
        for entry in entries {
            if self.cancelled() {
                break;
            }
            if self.should_skip(&entry.path) {
                continue;
            }
            if entry.is_dir {
                let nested = self.measure_dir(&entry.path);
                result.bytes = result.bytes.saturating_add(nested.bytes);
                result.errors.extend(nested.errors);
            } else {
                result.bytes = result.bytes.saturating_add(entry.logical_bytes);
            }
        }
        result
    }

    /// Measure direct child directories with a bounded worker pool. Each
    /// worker recursively measures one directory; workers never recurse into
    /// a shared mutable tree, so aggregation remains deterministic.
    pub fn measure_dirs(&self, paths: &[PathBuf], threads: usize) -> Vec<DirMeasurement> {
        if paths.is_empty() {
            return Vec::new();
        }
        let workers = threads.clamp(1, paths.len());
        if workers == 1 {
            return paths.iter().map(|path| self.measure_dir(path)).collect();
        }
        let next = AtomicUsize::new(0);
        let results: Mutex<Vec<Option<DirMeasurement>>> =
            Mutex::new((0..paths.len()).map(|_| None).collect());
        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    if index >= paths.len() || self.cancelled() {
                        break;
                    }
                    let measured = self.measure_dir(&paths[index]);
                    if let Ok(mut slots) = results.lock() {
                        slots[index] = Some(measured);
                    }
                });
            }
        });
        results
            .into_inner()
            .unwrap_or_default()
            .into_iter()
            .map(|slot| {
                slot.unwrap_or(DirMeasurement {
                    bytes: 0,
                    errors: Vec::new(),
                })
            })
            .collect()
    }
}
