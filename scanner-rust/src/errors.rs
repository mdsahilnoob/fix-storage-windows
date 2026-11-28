use std::io;

use crate::protocol::ScanIssue;
use crate::windows::paths::{display_path, normalize_path};

pub fn error_kind(_error: &io::Error) -> &'static str {
    // The TypeScript blocked-path list carries no errno; normalized reports
    // use the same broad kind for permission, lock and missing-path failures.
    "unreadable"
}

pub fn make_issue(path: &std::path::Path, kind: &str, message: String) -> ScanIssue {
    ScanIssue {
        display_path: display_path(path),
        path_key: normalize_path(path),
        kind: kind.to_string(),
        message,
    }
}

pub fn io_issue(path: &std::path::Path, error: &io::Error) -> ScanIssue {
    make_issue(path, error_kind(error), error.to_string())
}
