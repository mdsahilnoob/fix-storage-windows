use std::collections::BTreeMap;
use std::io::{self, BufWriter, Stdout, Write};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const SCHEMA_VERSION: &str = "1.0";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanRequest {
    #[serde(rename = "type")]
    pub kind: String,
    pub schema_version: String,
    pub request_id: String,
    pub roots: Vec<RootRequest>,
    #[serde(default)]
    pub skip_paths: Vec<String>,
    #[serde(default)]
    pub foreign_paths: Vec<String>,
    pub volume: Volume,
    #[serde(default)]
    pub options: ScanOptions,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootRequest {
    pub path: String,
    pub category: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Volume {
    pub id: String,
    pub mount: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanOptions {
    #[serde(default = "default_batch_size")]
    pub batch_size: usize,
    #[serde(default = "default_threads")]
    pub threads: usize,
    /// Keep the full normalized entry list for report/differential mode.
    /// Protocol streaming mode can disable this to bound memory.
    #[serde(default = "default_collect_entries")]
    pub collect_entries: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            batch_size: default_batch_size(),
            threads: default_threads(),
            collect_entries: default_collect_entries(),
        }
    }
}

fn default_batch_size() -> usize {
    200
}

fn default_threads() -> usize {
    1
}

fn default_collect_entries() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelMessage {
    #[serde(rename = "type")]
    pub kind: String,
    pub schema_version: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub display_path: String,
    pub path_key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub logical_bytes: u64,
    pub category: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanIssue {
    pub display_path: String,
    pub path_key: String,
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub measured_bytes: u64,
    pub unmeasured_bytes: u64,
    pub category_bytes: BTreeMap<String, u64>,
    pub file_entries: usize,
    pub directory_entries: usize,
    pub error_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub phase: String,
    pub partial: bool,
    pub error: Option<String>,
    pub entries: Vec<Entry>,
    pub errors: Vec<ScanIssue>,
    pub summary: ScanSummary,
    pub volume: Volume,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedReport {
    pub schema_version: String,
    pub implementation: Implementation,
    pub scan: ReportScan,
    pub volume: Volume,
    pub totals: ReportTotals,
    pub entries: Vec<Entry>,
    pub errors: Vec<ScanIssue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Implementation {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportScan {
    pub phase: String,
    pub partial: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportTotals {
    pub measured_bytes: u64,
    pub unmeasured_bytes: u64,
    pub category_bytes: BTreeMap<String, u64>,
    pub file_entries: usize,
    pub directory_entries: usize,
    pub error_count: usize,
}

pub trait EventSink {
    fn emit(&mut self, event_type: &str, payload: Value) -> io::Result<()>;
}

pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&mut self, _event_type: &str, _payload: Value) -> io::Result<()> {
        Ok(())
    }
}

pub struct StdoutSink {
    out: BufWriter<Stdout>,
    request_id: String,
    sequence: u64,
}

impl StdoutSink {
    pub fn new(request_id: String) -> Self {
        Self {
            out: BufWriter::new(io::stdout()),
            request_id,
            sequence: 0,
        }
    }
}

impl EventSink for StdoutSink {
    fn emit(&mut self, event_type: &str, payload: Value) -> io::Result<()> {
        self.sequence += 1;
        let mut object = Map::new();
        object.insert(
            "schemaVersion".to_string(),
            Value::String(SCHEMA_VERSION.to_string()),
        );
        object.insert(
            "requestId".to_string(),
            Value::String(self.request_id.clone()),
        );
        object.insert("sequence".to_string(), Value::from(self.sequence));
        object.insert("type".to_string(), Value::String(event_type.to_string()));
        if let Value::Object(extra) = payload {
            for (key, value) in extra {
                object.insert(key, value);
            }
        }
        serde_json::to_writer(&mut self.out, &Value::Object(object))?;
        self.out.write_all(b"\n")?;
        self.out.flush()
    }
}

pub fn summary_value(summary: &ScanSummary) -> Value {
    serde_json::to_value(summary).unwrap_or(Value::Null)
}
