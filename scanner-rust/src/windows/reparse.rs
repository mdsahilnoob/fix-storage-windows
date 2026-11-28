use std::fs::{FileType, Metadata};

pub const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

pub fn is_reparse(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        (metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

pub fn is_reparse_type(file_type: &FileType) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        file_type.is_symlink() || file_type.is_symlink_dir() || file_type.is_symlink_file()
    }
    #[cfg(not(windows))]
    {
        file_type.is_symlink()
    }
}
