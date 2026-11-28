use std::fs::{self, DirEntry, Metadata};
use std::io;
use std::path::{Path, PathBuf};

use super::paths::extended_path;

pub fn read_dir(path: &Path) -> io::Result<fs::ReadDir> {
    fs::read_dir(extended_path(path))
}

pub fn symlink_metadata(path: &Path) -> io::Result<Metadata> {
    fs::symlink_metadata(extended_path(path))
}

pub fn read_link(path: &Path) -> io::Result<PathBuf> {
    fs::read_link(extended_path(path))
}

pub fn entry_path(entry: &DirEntry) -> PathBuf {
    entry.path()
}
