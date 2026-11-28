use std::fs;
use std::path::Path;
use std::time::Instant;

use fix_storage_scanner_rust::windows::native::read_entries;
use serde_json::json;

fn read_dir_only(path: &Path) -> std::io::Result<usize> {
    let mut count = 0;
    for entry in fs::read_dir(path)? {
        entry?;
        count += 1;
    }
    Ok(count)
}

fn read_dir_with_metadata(path: &Path) -> std::io::Result<(usize, u64)> {
    let mut count = 0;
    let mut bytes: u64 = 0;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        let _ = entry.file_type()?;
        count += 1;
        if !metadata.is_dir() {
            bytes = bytes.saturating_add(metadata.len());
        }
    }
    Ok((count, bytes))
}

fn native(path: &Path) -> std::io::Result<(usize, u64)> {
    let entries = read_entries(path)?;
    let mut bytes: u64 = 0;
    for entry in &entries {
        if !entry.is_dir {
            bytes = bytes.saturating_add(entry.logical_bytes);
        }
    }
    Ok((entries.len(), bytes))
}

fn timed<T>(work: impl FnOnce() -> T) -> T {
    work()
}

fn main() {
    let root = std::env::args().nth(1).unwrap_or_else(|| ".".to_string());
    let path = Path::new(&root);
    let mut results = Vec::new();
    for rep in 0..3 {
        let start = Instant::now();
        let count = timed(|| read_dir_only(path)).unwrap_or(0);
        let read_dir_ms = start.elapsed().as_secs_f64() * 1000.0;

        let start = Instant::now();
        let (metadata_count, metadata_bytes) =
            timed(|| read_dir_with_metadata(path)).unwrap_or((0, 0));
        let metadata_ms = start.elapsed().as_secs_f64() * 1000.0;

        let start = Instant::now();
        let (native_count, native_bytes) = timed(|| native(path)).unwrap_or((0, 0));
        let native_ms = start.elapsed().as_secs_f64() * 1000.0;

        results.push(json!({
            "rep": rep,
            "readDirOnlyMs": read_dir_ms,
            "readDirOnlyEntries": count,
            "readDirMetadataMs": metadata_ms,
            "readDirMetadataEntries": metadata_count,
            "readDirMetadataBytes": metadata_bytes,
            "nativeMs": native_ms,
            "nativeEntries": native_count,
            "nativeBytes": native_bytes,
        }));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "root": root,
            "results": results,
        }))
        .unwrap()
    );
}
