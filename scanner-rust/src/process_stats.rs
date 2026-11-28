use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStats {
    pub peak_rss_bytes: u64,
    pub cpu_user_ms: f64,
    pub cpu_system_ms: f64,
}

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;

    use super::ProcessStats;

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    struct MemoryCounters {
        size: u32,
        page_faults: u32,
        peak_working_set: usize,
        working_set: usize,
        quota_peak_paged: usize,
        quota_paged: usize,
        quota_peak_nonpaged: usize,
        quota_nonpaged: usize,
        pagefile: usize,
        peak_pagefile: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn GetProcessTimes(
            process: *mut c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
    }

    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut c_void,
            counters: *mut MemoryCounters,
            size: u32,
        ) -> i32;
    }

    fn file_time(value: FileTime) -> u64 {
        ((value.high as u64) << 32) | value.low as u64
    }

    pub fn current() -> ProcessStats {
        let process = unsafe { GetCurrentProcess() };
        let mut counters = MemoryCounters {
            size: std::mem::size_of::<MemoryCounters>() as u32,
            page_faults: 0,
            peak_working_set: 0,
            working_set: 0,
            quota_peak_paged: 0,
            quota_paged: 0,
            quota_peak_nonpaged: 0,
            quota_nonpaged: 0,
            pagefile: 0,
            peak_pagefile: 0,
        };
        let peak = if unsafe { GetProcessMemoryInfo(process, &mut counters, counters.size) } != 0 {
            counters.peak_working_set as u64
        } else {
            0
        };
        let mut creation = FileTime { low: 0, high: 0 };
        let mut exit = FileTime { low: 0, high: 0 };
        let mut kernel = FileTime { low: 0, high: 0 };
        let mut user = FileTime { low: 0, high: 0 };
        let times = if unsafe {
            GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user)
        } != 0
        {
            (
                file_time(user) as f64 / 10_000.0,
                file_time(kernel) as f64 / 10_000.0,
            )
        } else {
            (0.0, 0.0)
        };
        ProcessStats {
            peak_rss_bytes: peak,
            cpu_user_ms: times.0,
            cpu_system_ms: times.1,
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::ProcessStats;

    pub fn current() -> ProcessStats {
        ProcessStats {
            peak_rss_bytes: 0,
            cpu_user_ms: 0.0,
            cpu_system_ms: 0.0,
        }
    }
}

pub fn current() -> ProcessStats {
    platform::current()
}
