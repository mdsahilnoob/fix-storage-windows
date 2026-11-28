use std::path::{Path, PathBuf};

/// Normalize a path for comparison while preserving the display path.
pub fn normalize_path(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('/', "\\");
    if value.starts_with("\\\\?\\UNC\\") {
        value = format!("\\\\{}", &value[8..]);
    } else if let Some(rest) = value.strip_prefix("\\\\?\\") {
        value = rest.to_string();
    }
    while value.len() > 3 && value.ends_with('\\') {
        value.pop();
    }
    value.to_lowercase()
}

pub fn display_path(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('/', "\\");
    if value.starts_with("\\\\?\\UNC\\") {
        value = format!("\\\\{}", &value[8..]);
    } else if let Some(rest) = value.strip_prefix("\\\\?\\") {
        value = rest.to_string();
    }
    value
}

pub fn is_same_path(left: &Path, right: &Path) -> bool {
    normalize_path(left) == normalize_path(right)
}

pub fn is_inside_path(path: &Path, parent: &Path) -> bool {
    let target = normalize_path(path);
    let root = normalize_path(parent);
    target.starts_with(&(root + "\\"))
}

pub fn is_at_or_inside(path: &Path, parent: &Path) -> bool {
    is_same_path(path, parent) || is_inside_path(path, parent)
}

/// Windows filesystem calls need the extended-length spelling for long paths.
pub fn extended_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if value.starts_with("\\\\?\\") || value.len() < 240 {
            return path.to_path_buf();
        }
        if value.starts_with("\\\\") {
            return PathBuf::from(format!("\\\\?\\UNC\\{}", &value[2..]));
        }
        return PathBuf::from(format!("\\\\?\\{}", value));
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

pub fn require_absolute(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("path is not absolute: {}", path.display()));
    }
    Ok(())
}
