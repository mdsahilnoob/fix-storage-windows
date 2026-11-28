use std::io::{self, BufRead, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use fix_storage_scanner_rust::protocol::NullSink;
use fix_storage_scanner_rust::protocol::{
    CancelMessage, EventSink, Implementation, NormalizedReport, ReportScan, ReportTotals,
    ScanRequest, StdoutSink, SCHEMA_VERSION,
};
use fix_storage_scanner_rust::scanner::scan;
use fix_storage_scanner_rust::windows::volume::validate_volume;

fn validate_request(request: &ScanRequest) -> Result<(), String> {
    if request.kind != "scan_request" {
        return Err("request type must be scan_request".to_string());
    }
    if request.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "unsupported schemaVersion: {}",
            request.schema_version
        ));
    }
    if request.request_id.trim().is_empty() {
        return Err("requestId must not be empty".to_string());
    }
    if request.roots.is_empty() {
        return Err("request must include at least one root".to_string());
    }
    for root in &request.roots {
        if root.path.trim().is_empty() || !Path::new(&root.path).is_absolute() {
            return Err(format!("root path must be absolute: {}", root.path));
        }
        if ![
            "apps",
            "developer",
            "photos",
            "movies",
            "documents",
            "music",
            "system",
            "caches",
            "trash",
        ]
        .contains(&root.category.as_str())
        {
            return Err(format!("unsupported category: {}", root.category));
        }
    }
    for path in request
        .skip_paths
        .iter()
        .chain(request.foreign_paths.iter())
    {
        if !Path::new(path).is_absolute() {
            return Err(format!("boundary path must be absolute: {path}"));
        }
    }
    validate_volume(&request.volume)
}

fn read_request() -> Result<ScanRequest, String> {
    let stdin = io::stdin();
    let mut line = String::new();
    stdin
        .lock()
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    if line.trim().is_empty() {
        return Err("expected a scan_request line on stdin".to_string());
    }
    serde_json::from_str(&line).map_err(|error| format!("invalid request JSON: {error}"))
}

fn report(request: &ScanRequest) -> Result<NormalizedReport, String> {
    validate_request(request)?;
    let cancel = AtomicBool::new(false);
    let mut sink = NullSink;
    let result = scan(request, &mut sink, &cancel).map_err(|error| error.to_string())?;
    Ok(NormalizedReport {
        schema_version: SCHEMA_VERSION.to_string(),
        implementation: Implementation {
            name: "rust-reference-prototype".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
        scan: ReportScan {
            phase: result.phase.clone(),
            partial: result.partial,
            error: result.error,
        },
        volume: result.volume,
        totals: ReportTotals {
            measured_bytes: result.summary.measured_bytes,
            unmeasured_bytes: result.summary.unmeasured_bytes,
            category_bytes: result.summary.category_bytes,
            file_entries: result.summary.file_entries,
            directory_entries: result.summary.directory_entries,
            error_count: result.summary.error_count,
        },
        entries: result.entries,
        errors: result.errors,
    })
}

fn run_protocol(mut request: ScanRequest) -> Result<(), String> {
    if let Err(error) = validate_request(&request) {
        let mut sink = StdoutSink::new(request.request_id.clone());
        let _ = sink.emit("scan_failed", serde_json::json!({ "error": error }));
        return Err(error);
    }
    // Streaming mode sends entries as bounded batches and does not retain the
    // full list in memory. Report mode uses the default true.
    request.options.collect_entries = false;
    let request_id = request.request_id.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let cancel_for_scan = cancel.clone();
    let finished_for_scan = finished.clone();
    let scan_request = request.clone();

    let scan_thread = thread::spawn(move || {
        let mut sink = StdoutSink::new(request_id);
        let result = scan(&scan_request, &mut sink, &cancel_for_scan);
        if let Err(error) = result {
            eprintln!("fix-storage-scanner-rust: scan output failed: {error}");
        }
        finished_for_scan.store(true, Ordering::SeqCst);
    });

    // Read cancellation lines independently so the scanner can finish even if
    // the parent keeps the stdin pipe open.
    let cancel_for_input = cancel.clone();
    let finished_for_input = finished.clone();
    let request_id_for_input = request.request_id.clone();
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut lock = stdin.lock();
        let mut line = String::new();
        loop {
            line.clear();
            match lock.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Ok(message) = serde_json::from_str::<CancelMessage>(&line) {
                        if message.kind == "cancel"
                            && message.schema_version == SCHEMA_VERSION
                            && message.request_id == request_id_for_input
                        {
                            cancel_for_input.store(true, Ordering::SeqCst);
                            let finished = finished_for_input.clone();
                            thread::spawn(move || {
                                thread::sleep(Duration::from_secs(5));
                                if !finished.load(Ordering::SeqCst) {
                                    eprintln!("fix-storage-scanner-rust: cancellation timeout");
                                    std::process::exit(3);
                                }
                            });
                        }
                    }
                }
            }
        }
    });

    let _ = scan_thread.join();
    Ok(())
}

fn main() {
    let report_mode = std::env::args()
        .skip(1)
        .any(|argument| argument == "--report");
    let request = match read_request() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("fix-storage-scanner-rust: {error}");
            std::process::exit(2);
        }
    };
    if report_mode {
        match report(&request) {
            Ok(value) => {
                let stdout = io::stdout();
                let mut lock = stdout.lock();
                if serde_json::to_writer_pretty(&mut lock, &value).is_err() {
                    std::process::exit(1);
                }
                let _ = writeln!(lock);
            }
            Err(error) => {
                eprintln!("fix-storage-scanner-rust: {error}");
                std::process::exit(2);
            }
        }
        return;
    }
    if let Err(error) = run_protocol(request) {
        eprintln!("fix-storage-scanner-rust: {error}");
        std::process::exit(2);
    }
}
