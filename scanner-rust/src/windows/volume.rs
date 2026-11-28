use std::path::Path;

use crate::protocol::Volume;

pub fn validate_volume(volume: &Volume) -> Result<(), String> {
    if volume.mount.trim().is_empty() {
        return Err("volume.mount must not be empty".to_string());
    }
    if !Path::new(&volume.mount).is_absolute() {
        return Err(format!("volume.mount must be absolute: {}", volume.mount));
    }
    if volume.available_bytes > volume.total_bytes {
        return Err("volume.availableBytes cannot exceed totalBytes".to_string());
    }
    Ok(())
}
