use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use super::enumeration::read_link;
#[cfg(not(windows))]
use super::paths::extended_path;

#[derive(Debug, Clone)]
pub struct NativeEntry {
    pub path: PathBuf,
    pub name: OsString,
    pub is_dir: bool,
    pub is_reparse: bool,
    pub logical_bytes: u64,
}

#[cfg(windows)]
mod platform {
    use std::ffi::{c_void, OsString};
    use std::io;
    use std::os::windows::ffi::OsStringExt;
    use std::path::Path;

    use super::super::paths::extended_path;
    use super::NativeEntry;

    const INVALID_HANDLE_VALUE: *mut c_void = usize::MAX as *mut c_void;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    const FIND_FIRST_EX_LARGE_FETCH: u32 = 0x2;
    const ERROR_NO_MORE_FILES: u32 = 18;

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    struct Win32FindDataW {
        attributes: u32,
        creation: FileTime,
        access: FileTime,
        write_time: FileTime,
        size_high: u32,
        size_low: u32,
        reserved0: u32,
        reserved1: u32,
        file_name: [u16; 260],
        alternate_name: [u16; 14],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn FindFirstFileExW(
            file_name: *const u16,
            info_level: u32,
            find_data: *mut Win32FindDataW,
            search_op: u32,
            search_filter: *mut c_void,
            additional_flags: u32,
        ) -> *mut c_void;
        fn FindNextFileW(handle: *mut c_void, find_data: *mut Win32FindDataW) -> i32;
        fn FindClose(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }

    fn name_from(value: &[u16]) -> OsString {
        let end = value
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(value.len());
        OsString::from_wide(&value[..end])
    }

    pub fn read_entries(path: &Path) -> io::Result<Vec<NativeEntry>> {
        let search = search_path_units(path);
        let mut data = Win32FindDataW {
            attributes: 0,
            creation: FileTime { low: 0, high: 0 },
            access: FileTime { low: 0, high: 0 },
            write_time: FileTime { low: 0, high: 0 },
            size_high: 0,
            size_low: 0,
            reserved0: 0,
            reserved1: 0,
            file_name: [0; 260],
            alternate_name: [0; 14],
        };
        let handle = unsafe {
            FindFirstFileExW(
                search.as_ptr(),
                1,
                &mut data,
                0,
                std::ptr::null_mut(),
                FIND_FIRST_EX_LARGE_FETCH,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::from_raw_os_error(
                unsafe { GetLastError() } as i32
            ));
        }
        let mut entries = Vec::new();
        loop {
            let attributes = data.attributes;
            let name = name_from(&data.file_name);
            if name != OsString::from(".") && name != OsString::from("..") {
                let child = path.join(&name);
                let is_reparse = attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
                let is_dir = attributes & FILE_ATTRIBUTE_DIRECTORY != 0 && !is_reparse;
                let logical_bytes = if is_reparse {
                    super::target_length(&child)
                        .unwrap_or_else(|| ((data.size_high as u64) << 32) | data.size_low as u64)
                } else {
                    ((data.size_high as u64) << 32) | data.size_low as u64
                };
                entries.push(NativeEntry {
                    path: child,
                    name,
                    is_dir,
                    is_reparse,
                    logical_bytes,
                });
            }
            if unsafe { FindNextFileW(handle, &mut data) } == 0 {
                let error = unsafe { GetLastError() };
                if error == ERROR_NO_MORE_FILES {
                    break;
                }
                unsafe { FindClose(handle) };
                return Err(io::Error::from_raw_os_error(error as i32));
            }
        }
        unsafe { FindClose(handle) };
        Ok(entries)
    }

    fn search_path_units(path: &Path) -> Vec<u16> {
        let mut search = extended_path(path).to_string_lossy().to_string();
        if !search.ends_with('\\') {
            search.push('\\');
        }
        search.push('*');
        let mut units: Vec<u16> = search.encode_utf16().collect();
        units.push(0);
        units
    }
}

fn target_length(path: &Path) -> Option<u64> {
    read_link(path)
        .ok()
        .map(|target| target.to_string_lossy().len() as u64)
}

#[cfg(windows)]
pub fn read_entries(path: &Path) -> io::Result<Vec<NativeEntry>> {
    platform::read_entries(path)
}

#[cfg(not(windows))]
pub fn read_entries(path: &Path) -> io::Result<Vec<NativeEntry>> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(extended_path(path))? {
        let entry = entry?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(extended_path(&path))?;
        let is_reparse = metadata.file_type().is_symlink();
        let is_dir = metadata.is_dir() && !is_reparse;
        let logical_bytes = if is_reparse {
            target_length(&path).unwrap_or(metadata.len())
        } else {
            metadata.len()
        };
        entries.push(NativeEntry {
            name: entry.file_name(),
            path,
            is_dir,
            is_reparse,
            logical_bytes,
        });
    }
    Ok(entries)
}
