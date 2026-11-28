use std::fs::{FileType, Metadata};
use std::io;
use std::path::Path;

use crate::windows::enumeration::{read_link, symlink_metadata};
use crate::windows::reparse::{is_reparse, is_reparse_type};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Directory,
    Reparse,
}

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EntryKind::File => "file",
            EntryKind::Directory => "directory",
            EntryKind::Reparse => "reparse",
        }
    }
}

#[derive(Debug, Clone)]
pub struct EntryInfo {
    pub kind: EntryKind,
    pub logical_bytes: u64,
}

pub fn inspect_entry(path: &Path, file_type: &FileType) -> io::Result<EntryInfo> {
    let metadata: Metadata = symlink_metadata(path)?;
    if is_reparse(&metadata) || is_reparse_type(file_type) {
        // Node's lstat reports the reparse target length as the link size.
        // Windows Rust metadata often reports zero, so derive the same
        // read-only logical value from the link target when possible.
        let logical_bytes = read_link(path)
            .map(|target| target.to_string_lossy().len() as u64)
            .unwrap_or_else(|_| metadata.len());
        return Ok(EntryInfo {
            kind: EntryKind::Reparse,
            logical_bytes,
        });
    }
    if file_type.is_dir() {
        return Ok(EntryInfo {
            kind: EntryKind::Directory,
            logical_bytes: 0,
        });
    }
    Ok(EntryInfo {
        kind: EntryKind::File,
        logical_bytes: metadata.len(),
    })
}
