use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const DEFAULT_CONTACT_LIMIT: usize = 50;
const DEFAULT_EVENT_LIMIT: usize = 50;
const DEFAULT_FINDER_LIMIT: usize = 100;
const DEFAULT_NOTE_LIMIT: usize = 30;
#[cfg(target_os = "windows")]
const DEFAULT_PROCESS_LIMIT: usize = 100;
#[cfg(any(target_os = "windows", test))]
const DEFAULT_SERVICE_LIMIT: usize = 100;
#[cfg(any(target_os = "windows", test))]
const DEFAULT_TASK_LIMIT: usize = 100;
const DEFAULT_REMINDER_LIMIT: usize = 50;
const DEFAULT_SAFARI_TAB_LIMIT: usize = 50;
#[cfg(target_os = "windows")]
const DEFAULT_WINDOW_LIMIT: usize = 30;
const MAX_LIST_LIMIT: usize = 200;

#[derive(Debug, thiserror::Error)]
pub enum AppIntegrationError {
    #[error("This app integration is only available on macOS.")]
    UnsupportedPlatform,
    #[error("{0}")]
    InvalidRequest(String),
    #[error("{0}")]
    PermissionDenied(String),
    #[error("{0}")]
    ExecutionFailed(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInfo {
    pub name: String,
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub uid: String,
    pub calendar_name: String,
    pub title: String,
    pub start_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_at: Option<String>,
    pub all_day: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListCalendarEventsRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calendar_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateCalendarEventRequest {
    pub title: String,
    pub start_at: String,
    pub end_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calendar_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default)]
    pub all_day: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReminderList {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReminderItem {
    pub id: String,
    pub list_name: String,
    pub title: String,
    pub completed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub priority: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListRemindersRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_name: Option<String>,
    #[serde(default)]
    pub include_completed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateReminderRequest {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompleteReminderRequest {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReminderCompletion {
    pub id: String,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContactGroup {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContactPerson {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub emails: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub phones: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListContactsRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteFolder {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteItem {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    pub folder_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListNotesRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateNoteRequest {
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FinderItem {
    pub name: String,
    pub path: String,
    pub item_type: String,
    pub is_hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListFinderItemsRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FinderRevealRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FinderRevealResult {
    pub path: String,
    pub revealed: bool,
}

pub type ExplorerItem = FinderItem;
pub type ListExplorerItemsRequest = ListFinderItemsRequest;
pub type ExplorerRevealRequest = FinderRevealRequest;
pub type ExplorerRevealResult = FinderRevealResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardTextResult {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetClipboardTextRequest {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextFileRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextFileContent {
    pub path: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WriteTextFileRequest {
    pub path: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextFileWriteResult {
    pub path: String,
    pub bytes_written: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_set_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_millis: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListProcessesRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminateProcessRequest {
    pub pid: u32,
    #[serde(default = "default_true")]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessTerminationResult {
    pub pid: u32,
    pub terminated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureScreenshotRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotCapture {
    pub display_index: usize,
    pub width: u32,
    pub height: u32,
    pub mime_type: String,
    pub image_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListWindowsRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default)]
    pub include_minimized: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub window_handle: String,
    pub title: String,
    pub process_id: u32,
    pub process_name: String,
    pub is_minimized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowActionRequest {
    pub window_handle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowActionResult {
    pub window_handle: String,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationRequest {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationResult {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub delivered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryWriteRequest {
    pub path: String,
    pub name: String,
    pub value_type: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryWriteResult {
    pub path: String,
    pub name: String,
    pub value_type: String,
    pub value: Value,
    pub updated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListServicesRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub name: String,
    pub display_name: String,
    pub status: String,
    pub can_stop: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceActionRequest {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceActionResult {
    pub name: String,
    pub display_name: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListScheduledTasksRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskInfo {
    pub name: String,
    pub task_path: String,
    pub state: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskActionRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskActionResult {
    pub name: String,
    pub task_path: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminShellRequest {
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arguments: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdminShellResult {
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arguments: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub elevated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafariTab {
    pub window_index: usize,
    pub tab_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListSafariTabsRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenSafariTabRequest {
    pub url: String,
    #[serde(default = "default_true")]
    pub activate: bool,
}

pub fn calendar_supported() -> bool {
    cfg!(target_os = "macos") && app_exists("Calendar")
}

pub fn reminders_supported() -> bool {
    cfg!(target_os = "macos") && app_exists("Reminders")
}

pub fn contacts_supported() -> bool {
    cfg!(target_os = "macos") && app_exists("Contacts")
}

pub fn notes_supported() -> bool {
    cfg!(target_os = "macos") && app_exists("Notes")
}

pub fn finder_supported() -> bool {
    cfg!(target_os = "macos") && app_exists("Finder")
}

pub fn safari_supported() -> bool {
    cfg!(target_os = "macos") && app_exists("Safari")
}

pub fn clipboard_supported() -> bool {
    cfg!(target_os = "windows")
}

pub fn explorer_supported() -> bool {
    cfg!(target_os = "windows")
}

pub fn process_control_supported() -> bool {
    cfg!(target_os = "windows")
}

pub fn screenshot_supported() -> bool {
    cfg!(target_os = "windows")
}

pub fn list_contact_groups() -> Result<Vec<ContactGroup>, AppIntegrationError> {
    run_jxa_json(
        "Contacts",
        r#"
const app = Application("Contacts");
const groups = app.groups().map((group) => ({
  id: String(group.id() || "").trim(),
  name: String(group.name() || "").trim(),
})).filter((group) => group.id && group.name);
groups.sort((left, right) => left.name.localeCompare(right.name));
JSON.stringify(groups);
"#,
    )
}

pub fn list_contacts(
    input: &ListContactsRequest,
) -> Result<Vec<ContactPerson>, AppIntegrationError> {
    let payload = normalize_contact_query(input);
    let query_json = serialize_js_value(&payload)?;
    run_jxa_json(
        "Contacts",
        &format!(
            r#"
const query = {query_json};

function clean(value) {{
  return typeof value === "string" && value.trim() ? value.trim() : null;
}}

function cleanArray(values) {{
  return values
    .map((value) => clean(value))
    .filter((value, index, array) => value && array.indexOf(value) === index);
}}

const app = Application("Contacts");
const groupId = clean(query.groupId);
const groupName = clean(query.groupName);
const search = clean(query.query);
const searchLower = search ? search.toLowerCase() : null;
const limit = Math.max(1, Math.min({MAX_LIST_LIMIT}, Number(query.limit) || {DEFAULT_CONTACT_LIMIT}));

let people = app.people();
if (groupId || groupName) {{
  const group = app.groups().find((candidate) => {{
    const candidateId = String(candidate.id() || "").trim();
    const candidateName = String(candidate.name() || "").trim();
    if (groupId && candidateId === groupId) {{
      return true;
    }}
    return !groupId && groupName && candidateName === groupName;
  }}) || null;
  if (!group) {{
    throw new Error("contact_group_not_found");
  }}
  people = group.people();
}}

const results = [];
for (const person of people) {{
  const id = String(person.id() || "").trim();
  if (!id) {{
    continue;
  }}
  const name = String(person.name() || "").trim();
  const firstName = clean(person.firstName());
  const lastName = clean(person.lastName());
  const organization = clean(person.organization());
  const emails = cleanArray(person.emails().map((item) => item.value()));
  const phones = cleanArray(person.phones().map((item) => item.value()));
  const haystack = [
    name,
    firstName,
    lastName,
    organization,
    ...emails,
    ...phones,
  ].filter(Boolean).join(" ").toLowerCase();
  if (searchLower && !haystack.includes(searchLower)) {{
    continue;
  }}
  results.push({{
    id,
    name,
    firstName,
    lastName,
    organization,
    emails,
    phones,
  }});
}}

results.sort((left, right) => left.name.localeCompare(right.name));
JSON.stringify(results.slice(0, limit));
"#
        ),
    )
}

pub fn list_note_folders() -> Result<Vec<NoteFolder>, AppIntegrationError> {
    run_jxa_json(
        "Notes",
        r#"
const app = Application("Notes");

function clean(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const folders = app.folders().map((folder) => ({
  id: String(folder.id() || "").trim(),
  name: String(folder.name() || "").trim(),
  accountName: folder.container() ? clean(folder.container().name()) : null,
})).filter((folder) => folder.id && folder.name);
folders.sort((left, right) => {
  const accountCompare = String(left.accountName || "").localeCompare(String(right.accountName || ""));
  return accountCompare || left.name.localeCompare(right.name);
});
JSON.stringify(folders);
"#,
    )
}

pub fn list_notes(input: &ListNotesRequest) -> Result<Vec<NoteItem>, AppIntegrationError> {
    let payload = normalize_note_query(input);
    let query_json = serialize_js_value(&payload)?;
    run_jxa_json(
        "Notes",
        &format!(
            r#"
const query = {query_json};

function clean(value) {{
  return typeof value === "string" && value.trim() ? value.trim() : null;
}}

function htmlToText(value) {{
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{{3,}}/g, "\n\n")
    .trim();
}}

const app = Application("Notes");
const folderId = clean(query.folderId);
const folderName = clean(query.folderName);
const search = clean(query.query);
const searchLower = search ? search.toLowerCase() : null;
const limit = Math.max(1, Math.min({MAX_LIST_LIMIT}, Number(query.limit) || {DEFAULT_NOTE_LIMIT}));

let folders = app.folders();
if (folderId || folderName) {{
  folders = folders.filter((candidate) => {{
    const candidateId = String(candidate.id() || "").trim();
    const candidateName = String(candidate.name() || "").trim();
    if (folderId && candidateId === folderId) {{
      return true;
    }}
    return !folderId && folderName && candidateName === folderName;
  }});
  if (!folders.length) {{
    throw new Error("folder_not_found");
  }}
}}

const notes = [];
for (const folder of folders) {{
  const folderIdValue = String(folder.id() || "").trim();
  const folderNameValue = String(folder.name() || "").trim();
  const accountName = folder.container() ? clean(folder.container().name()) : null;
  for (const note of folder.notes()) {{
    const title = clean(note.name()) || "Untitled";
    const bodyHtml = clean(note.body());
    const bodyText = bodyHtml ? htmlToText(bodyHtml) : null;
    const haystack = [
      title,
      folderNameValue,
      accountName,
      bodyText,
    ].filter(Boolean).join(" ").toLowerCase();
    if (searchLower && !haystack.includes(searchLower)) {{
      continue;
    }}
    const createdAt = note.creationDate() ? note.creationDate().toISOString() : null;
    const modifiedAt = note.modificationDate() ? note.modificationDate().toISOString() : null;
    notes.push({{
      id: String(note.id() || "").trim(),
      title,
      folderId: folderIdValue || null,
      folderName: folderNameValue,
      accountName,
      bodyHtml,
      bodyText,
      createdAt,
      modifiedAt,
    }});
  }}
}}

notes.sort((left, right) => {{
  const leftTime = left.modifiedAt ? new Date(left.modifiedAt).getTime() : 0;
  const rightTime = right.modifiedAt ? new Date(right.modifiedAt).getTime() : 0;
  return rightTime - leftTime;
}});
JSON.stringify(notes.slice(0, limit));
"#
        ),
    )
}

pub fn create_note(input: &CreateNoteRequest) -> Result<NoteItem, AppIntegrationError> {
    let payload = normalize_note_create_request(input)?;
    let payload_json = serialize_js_value(&payload)?;
    run_jxa_json(
        "Notes",
        &format!(
            r#"
const payload = {payload_json};

function clean(value) {{
  return typeof value === "string" && value.trim() ? value.trim() : null;
}}

function escapeHtml(value) {{
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}}

function htmlToText(value) {{
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{{3,}}/g, "\n\n")
    .trim();
}}

const app = Application("Notes");
const title = clean(payload.title);
if (!title) {{
  throw new Error("title_required");
}}

const body = clean(payload.body);
if (!body) {{
  throw new Error("body_required");
}}

const folderId = clean(payload.folderId);
const folderName = clean(payload.folderName);
let targetFolder = null;
if (folderId || folderName) {{
  targetFolder = app.folders().find((candidate) => {{
    const candidateId = String(candidate.id() || "").trim();
    const candidateName = String(candidate.name() || "").trim();
    if (folderId && candidateId === folderId) {{
      return true;
    }}
    return !folderId && folderName && candidateName === folderName;
  }}) || null;
  if (!targetFolder) {{
    throw new Error("folder_not_found");
  }}
}} else {{
  targetFolder = app.folders().find((candidate) => {{
    const name = String(candidate.name() || "").trim();
    return name !== "Recently Deleted" && name !== "最近删除";
  }}) || app.folders()[0] || null;
}}

if (!targetFolder) {{
  throw new Error("folder_unavailable");
}}

const bodyHtml = body.startsWith("<") ? body : body
  .split(/\r?\n/)
  .map((line) => `<div>${{escapeHtml(line)}}</div>`)
  .join("");

const note = app.Note({{
  name: title,
  body: bodyHtml,
}});
targetFolder.notes.push(note);

JSON.stringify({{
  id: String(note.id() || "").trim(),
  title: clean(note.name()) || title,
  folderId: String(targetFolder.id() || "").trim() || null,
  folderName: String(targetFolder.name() || "").trim(),
  accountName: targetFolder.container() ? clean(targetFolder.container().name()) : null,
  bodyHtml: clean(note.body()),
  bodyText: clean(note.body()) ? htmlToText(String(note.body())) : null,
  createdAt: note.creationDate() ? note.creationDate().toISOString() : null,
  modifiedAt: note.modificationDate() ? note.modificationDate().toISOString() : null,
}});
"#
        ),
    )
}

pub fn list_finder_items(
    input: &ListFinderItemsRequest,
) -> Result<Vec<FinderItem>, AppIntegrationError> {
    if !cfg!(target_os = "macos") {
        return Err(AppIntegrationError::UnsupportedPlatform);
    }

    let request = normalize_finder_list_request(input);
    let target = resolve_finder_path(request.path.as_deref())?;
    if !target.exists() {
        return Err(AppIntegrationError::InvalidRequest(
            "The requested Finder path does not exist.".to_string(),
        ));
    }
    if !target.is_dir() {
        return Err(AppIntegrationError::InvalidRequest(
            "The requested Finder path is not a directory.".to_string(),
        ));
    }
    list_directory_items(&target, request.include_hidden, request.limit)
}

pub fn reveal_finder_item(
    input: &FinderRevealRequest,
) -> Result<FinderRevealResult, AppIntegrationError> {
    if !cfg!(target_os = "macos") {
        return Err(AppIntegrationError::UnsupportedPlatform);
    }

    let request = normalize_finder_reveal_request(input)?;
    let path = resolve_finder_path(Some(&request.path))?;
    if !path.exists() {
        return Err(AppIntegrationError::InvalidRequest(
            "The requested Finder path does not exist.".to_string(),
        ));
    }

    let output = Command::new("open")
        .args(["-R", &path.to_string_lossy()])
        .output()
        .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppIntegrationError::ExecutionFailed(if stderr.is_empty() {
            "Failed to reveal the requested Finder item.".to_string()
        } else {
            stderr
        }));
    }

    Ok(FinderRevealResult {
        path: path.to_string_lossy().to_string(),
        revealed: true,
    })
}

pub fn get_clipboard_text() -> Result<ClipboardTextResult, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        run_windows_powershell_json(
            r#"
$text = Get-Clipboard -Format Text -Raw -ErrorAction SilentlyContinue
if ($null -eq $text) { $text = "" }
[PSCustomObject]@{
  text = [string]$text
} | ConvertTo-Json -Compress
"#,
            None,
        )
    }
}

pub fn set_clipboard_text(
    input: &SetClipboardTextRequest,
) -> Result<ClipboardTextResult, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        let request = normalize_set_clipboard_request(input)?;
        run_windows_powershell_json(
            r#"
$text = [Console]::In.ReadToEnd()
Set-Clipboard -Value $text -ErrorAction Stop
[PSCustomObject]@{
  text = [string]$text
} | ConvertTo-Json -Compress
"#,
            Some(request.text.as_str()),
        )
    }
}

pub fn read_text_file(input: &ReadTextFileRequest) -> Result<TextFileContent, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        let request = normalize_read_text_file_request(input)?;
        let path = resolve_local_path(Some(&request.path))?;
        if !path.exists() {
            return Err(AppIntegrationError::InvalidRequest(
                "The requested file path does not exist.".to_string(),
            ));
        }
        if !path.is_file() {
            return Err(AppIntegrationError::InvalidRequest(
                "The requested file path is not a file.".to_string(),
            ));
        }

        let text = fs::read_to_string(&path)
            .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
        Ok(TextFileContent {
            path: path.to_string_lossy().to_string(),
            text,
        })
    }
}

pub fn write_text_file(
    input: &WriteTextFileRequest,
) -> Result<TextFileWriteResult, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        let request = normalize_write_text_file_request(input)?;
        let path = resolve_local_path(Some(&request.path))?;
        if path.exists() && path.is_dir() {
            return Err(AppIntegrationError::InvalidRequest(
                "The requested file path points to a directory.".to_string(),
            ));
        }

        let Some(parent) = path.parent() else {
            return Err(AppIntegrationError::InvalidRequest(
                "The requested file path is invalid.".to_string(),
            ));
        };
        if !parent.exists() {
            return Err(AppIntegrationError::InvalidRequest(
                "The parent folder for the requested file path does not exist.".to_string(),
            ));
        }

        fs::write(&path, request.text.as_bytes())
            .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
        Ok(TextFileWriteResult {
            path: path.to_string_lossy().to_string(),
            bytes_written: request.text.as_bytes().len() as u64,
        })
    }
}

pub fn list_explorer_items(
    input: &ListExplorerItemsRequest,
) -> Result<Vec<ExplorerItem>, AppIntegrationError> {
    if !cfg!(target_os = "windows") {
        return Err(AppIntegrationError::UnsupportedPlatform);
    }

    let request = normalize_explorer_list_request(input);
    let target = resolve_local_path(request.path.as_deref())?;
    if !target.exists() {
        return Err(AppIntegrationError::InvalidRequest(
            "The requested Explorer path does not exist.".to_string(),
        ));
    }
    if !target.is_dir() {
        return Err(AppIntegrationError::InvalidRequest(
            "The requested Explorer path is not a directory.".to_string(),
        ));
    }

    list_directory_items(&target, request.include_hidden, request.limit)
}

pub fn reveal_explorer_item(
    input: &ExplorerRevealRequest,
) -> Result<ExplorerRevealResult, AppIntegrationError> {
    if !cfg!(target_os = "windows") {
        return Err(AppIntegrationError::UnsupportedPlatform);
    }

    let request = normalize_explorer_reveal_request(input)?;
    let path = resolve_local_path(Some(&request.path))?;
    if !path.exists() {
        return Err(AppIntegrationError::InvalidRequest(
            "The requested Explorer path does not exist.".to_string(),
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let output = windows_command("explorer.exe")
            .arg(format!("/select,{}", path.to_string_lossy()))
            .output()
            .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
        if !output.status.success() {
            return Err(classify_windows_command_error(
                &output.stderr,
                &output.stdout,
            ));
        }
    }

    Ok(ExplorerRevealResult {
        path: path.to_string_lossy().to_string(),
        revealed: true,
    })
}

pub fn list_processes(
    input: &ListProcessesRequest,
) -> Result<Vec<ProcessInfo>, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        let request = normalize_list_processes_request(input);
        let payload: Value = run_windows_powershell_json(
            r#"
$items = Get-Process -ErrorAction Stop | ForEach-Object {
  [PSCustomObject]@{
    pid = [uint32]$_.Id
    name = [string]$_.ProcessName
    path = if ($_.Path) { [string]$_.Path } else { $null }
    windowTitle = if ($_.MainWindowTitle) { [string]$_.MainWindowTitle } else { $null }
    workingSetBytes = if ($null -ne $_.WorkingSet64) { [uint64]$_.WorkingSet64 } else { $null }
    cpuMillis = if ($null -ne $_.CPU) { [uint64][math]::Round([double]$_.CPU * 1000) } else { $null }
  }
}
$items | ConvertTo-Json -Compress
"#,
            None,
        )?;

        let mut processes = parse_json_vec::<ProcessInfo>(payload)?;
        if let Some(query) = request.query {
            let query_lower = query.to_ascii_lowercase();
            processes.retain(|process| {
                process.name.to_ascii_lowercase().contains(&query_lower)
                    || process
                        .path
                        .as_ref()
                        .map(|value| value.to_ascii_lowercase().contains(&query_lower))
                        .unwrap_or(false)
                    || process
                        .window_title
                        .as_ref()
                        .map(|value| value.to_ascii_lowercase().contains(&query_lower))
                        .unwrap_or(false)
                    || process.pid.to_string().contains(&query_lower)
            });
        }
        processes.sort_by(|left, right| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
                .then_with(|| left.pid.cmp(&right.pid))
        });
        processes.truncate(request.limit.unwrap_or(DEFAULT_PROCESS_LIMIT));
        Ok(processes)
    }
}

pub fn terminate_process(
    input: &TerminateProcessRequest,
) -> Result<ProcessTerminationResult, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        let request = normalize_terminate_process_request(input)?;
        let force_flag = if request.force { "$true" } else { "$false" };
        run_windows_powershell_json::<Value>(
            &format!(
                r#"
$pid = {pid}
Stop-Process -Id $pid -Force:{force_flag} -ErrorAction Stop
[PSCustomObject]@{{
  pid = [uint32]$pid
  terminated = $true
}} | ConvertTo-Json -Compress
"#,
                pid = request.pid,
                force_flag = force_flag,
            ),
            None,
        )?;
        Ok(ProcessTerminationResult {
            pid: request.pid,
            terminated: true,
        })
    }
}

pub fn capture_screenshot(
    input: &CaptureScreenshotRequest,
) -> Result<ScreenshotCapture, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        let request = normalize_capture_screenshot_request(input);
        run_windows_powershell_json(
            &format!(
                r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$displayIndex = {display_index}
$screens = [System.Windows.Forms.Screen]::AllScreens
if ($displayIndex -lt 0 -or $displayIndex -ge $screens.Length) {{
  throw "screen_not_found"
}}
$screen = $screens[$displayIndex]
$bounds = $screen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {{
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $stream = New-Object System.IO.MemoryStream
  try {{
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    [PSCustomObject]@{{
      displayIndex = [int]$displayIndex
      width = [uint32]$bounds.Width
      height = [uint32]$bounds.Height
      mimeType = "image/png"
      imageBase64 = [Convert]::ToBase64String($stream.ToArray())
    }} | ConvertTo-Json -Compress
  }} finally {{
    $stream.Dispose()
  }}
}} finally {{
  $graphics.Dispose()
  $bitmap.Dispose()
}}
"#,
                display_index = request.display_index.unwrap_or(0)
            ),
            None,
        )
    }
}

pub fn list_windows(input: &ListWindowsRequest) -> Result<Vec<WindowInfo>, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        let request = normalize_list_windows_request(input);
        let payload: Value = run_windows_powershell_json(
            r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GhastWindowApi {
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
}
"@
$items = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 0
} | ForEach-Object {
  $handleValue = [Int64]$_.MainWindowHandle
  [PSCustomObject]@{
    windowHandle = ("0x{0:X}" -f $handleValue)
    title = [string]$_.MainWindowTitle
    processId = [uint32]$_.Id
    processName = [string]$_.ProcessName
    isMinimized = [bool][GhastWindowApi]::IsIconic([IntPtr]$_.MainWindowHandle)
  }
}
$items | ConvertTo-Json -Compress
"#,
            None,
        )?;

        let mut windows = parse_json_vec::<WindowInfo>(payload)?;
        if let Some(query) = request.query {
            let query_lower = query.to_ascii_lowercase();
            windows.retain(|window| {
                window.title.to_ascii_lowercase().contains(&query_lower)
                    || window
                        .process_name
                        .to_ascii_lowercase()
                        .contains(&query_lower)
                    || window.process_id.to_string().contains(&query_lower)
                    || window
                        .window_handle
                        .to_ascii_lowercase()
                        .contains(&query_lower)
            });
        }
        if !request.include_minimized {
            windows.retain(|window| !window.is_minimized);
        }
        windows.sort_by(|left, right| {
            left.title
                .to_ascii_lowercase()
                .cmp(&right.title.to_ascii_lowercase())
                .then_with(|| {
                    left.process_name
                        .to_ascii_lowercase()
                        .cmp(&right.process_name.to_ascii_lowercase())
                })
                .then_with(|| left.process_id.cmp(&right.process_id))
        });
        windows.truncate(request.limit.unwrap_or(DEFAULT_WINDOW_LIMIT));
        Ok(windows)
    }
}

pub fn activate_window(
    input: &WindowActionRequest,
) -> Result<WindowActionResult, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        let request = normalize_window_action_request(input)?;
        let handle = parse_window_handle(&request.window_handle)?;
        run_windows_powershell_json::<Value>(
            &format!(
                r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GhastWindowApi {{
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}}
"@
$handleValue = [UInt64]{handle}
$hWnd = [IntPtr]([Int64]$handleValue)
if (-not [GhastWindowApi]::IsWindow($hWnd)) {{
  throw "window_not_found"
}}
if ([GhastWindowApi]::IsIconic($hWnd)) {{
  [void][GhastWindowApi]::ShowWindowAsync($hWnd, 9)
}}
[void][GhastWindowApi]::SetForegroundWindow($hWnd)
[PSCustomObject]@{{
  windowHandle = "{window_handle}"
  success = $true
}} | ConvertTo-Json -Compress
"#,
                handle = handle,
                window_handle = request.window_handle,
            ),
            None,
        )?;
        Ok(WindowActionResult {
            window_handle: request.window_handle,
            success: true,
        })
    }
}

pub fn minimize_window(
    input: &WindowActionRequest,
) -> Result<WindowActionResult, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        let request = normalize_window_action_request(input)?;
        let handle = parse_window_handle(&request.window_handle)?;
        run_windows_powershell_json::<Value>(
            &format!(
                r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GhastWindowApi {{
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}}
"@
$handleValue = [UInt64]{handle}
$hWnd = [IntPtr]([Int64]$handleValue)
if (-not [GhastWindowApi]::IsWindow($hWnd)) {{
  throw "window_not_found"
}}
[void][GhastWindowApi]::ShowWindowAsync($hWnd, 6)
[PSCustomObject]@{{
  windowHandle = "{window_handle}"
  success = $true
}} | ConvertTo-Json -Compress
"#,
                handle = handle,
                window_handle = request.window_handle,
            ),
            None,
        )?;
        Ok(WindowActionResult {
            window_handle: request.window_handle,
            success: true,
        })
    }
}

pub fn show_desktop_notification(
    input: &DesktopNotificationRequest,
) -> Result<DesktopNotificationResult, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        let request = normalize_desktop_notification_request(input)?;
        let payload = serde_json::to_string(&request)
            .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
        run_windows_powershell_json(
            r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
$title = [string]$payload.title
$body = if ($null -ne $payload.body) { [string]$payload.body } else { "" }
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.Visible = $true
$notify.BalloonTipTitle = $title
$notify.BalloonTipText = $body
$notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
try {
  $notify.ShowBalloonTip(4000)
  Start-Sleep -Milliseconds 1500
  [PSCustomObject]@{
    title = $title
    body = if ($body.Length -gt 0) { $body } else { $null }
    delivered = $true
  } | ConvertTo-Json -Compress
} finally {
  $notify.Dispose()
}
"#,
            Some(payload.as_str()),
        )
    }
}

pub fn write_registry_value(
    input: &RegistryWriteRequest,
) -> Result<RegistryWriteResult, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        let request = normalize_registry_write_request(input)?;
        let payload = serde_json::to_string(&request)
            .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
        run_windows_powershell_json(
            r#"
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop

function Resolve-GhastRegistryPath([string]$rawPath) {
  $trimmed = $rawPath.Trim()
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    throw "registry_path_invalid"
  }

  $normalized = $trimmed.Replace('/', '\')
  if ($normalized.StartsWith("Registry::", [System.StringComparison]::OrdinalIgnoreCase)) {
    return $normalized
  }

  $prefixMap = @(
    @{ Target = "Registry::HKEY_LOCAL_MACHINE\"; Prefixes = @("HKLM:\", "HKLM\", "HKEY_LOCAL_MACHINE:\", "HKEY_LOCAL_MACHINE\") },
    @{ Target = "Registry::HKEY_CURRENT_USER\"; Prefixes = @("HKCU:\", "HKCU\", "HKEY_CURRENT_USER:\", "HKEY_CURRENT_USER\") },
    @{ Target = "Registry::HKEY_CLASSES_ROOT\"; Prefixes = @("HKCR:\", "HKCR\", "HKEY_CLASSES_ROOT:\", "HKEY_CLASSES_ROOT\") },
    @{ Target = "Registry::HKEY_USERS\"; Prefixes = @("HKU:\", "HKU\", "HKEY_USERS:\", "HKEY_USERS\") },
    @{ Target = "Registry::HKEY_CURRENT_CONFIG\"; Prefixes = @("HKCC:\", "HKCC\", "HKEY_CURRENT_CONFIG:\", "HKEY_CURRENT_CONFIG\") }
  )

  foreach ($entry in $prefixMap) {
    foreach ($prefix in $entry.Prefixes) {
      if ($normalized.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $entry.Target + $normalized.Substring($prefix.Length)
      }
    }
  }

  throw "registry_path_invalid"
}

$path = Resolve-GhastRegistryPath([string]$payload.path)
$name = [string]$payload.name
if ([string]::IsNullOrWhiteSpace($name)) {
  throw "registry_name_required"
}

$valueType = [string]$payload.valueType
$item = New-Item -Path $path -Force -ErrorAction Stop
$item = Get-Item -Path $path -ErrorAction Stop
$registryKind = switch ($valueType) {
  "string" { [Microsoft.Win32.RegistryValueKind]::String }
  "expand_string" { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  "dword" { [Microsoft.Win32.RegistryValueKind]::DWord }
  "qword" { [Microsoft.Win32.RegistryValueKind]::QWord }
  default { throw "registry_value_type_invalid" }
}
$typedValue = switch ($valueType) {
  "string" { [string]$payload.value }
  "expand_string" { [string]$payload.value }
  "dword" { [UInt32]$payload.value }
  "qword" { [UInt64]$payload.value }
  default { throw "registry_value_type_invalid" }
}
$item.SetValue($name, $typedValue, $registryKind)
$item = Get-Item -Path $path -ErrorAction Stop
$storedValue = $item.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$storedKind = $item.GetValueKind($name).ToString()
$storedType = switch ($storedKind) {
  "String" { "string" }
  "ExpandString" { "expand_string" }
  "DWord" { "dword" }
  "QWord" { "qword" }
  default { $storedKind.ToLowerInvariant() }
}
[PSCustomObject]@{
  path = $path
  name = $name
  valueType = $storedType
  value = $storedValue
  updated = $true
} | ConvertTo-Json -Compress
"#,
            Some(payload.as_str()),
        )
    }
}

pub fn list_services(input: &ListServicesRequest) -> Result<Vec<ServiceInfo>, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        let request = normalize_list_services_request(input);
        let payload: Value = run_windows_powershell_json(
            r#"
$cimLookup = @{}
Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | ForEach-Object {
  $cimLookup[$_.Name] = $_
}
$items = Get-Service -ErrorAction Stop | ForEach-Object {
  $meta = $cimLookup[$_.Name]
  [PSCustomObject]@{
    name = [string]$_.Name
    displayName = [string]$_.DisplayName
    status = [string]$_.Status
    canStop = [bool]$_.CanStop
    startType = if ($null -ne $meta -and $meta.StartMode) { [string]$meta.StartMode } else { $null }
    serviceType = if ($null -ne $meta -and $meta.ServiceType) { [string]$meta.ServiceType } else { $null }
  }
}
$items | ConvertTo-Json -Compress
"#,
            None,
        )?;

        let mut services = parse_json_vec::<ServiceInfo>(payload)?;
        if let Some(query) = request.query {
            let query_lower = query.to_ascii_lowercase();
            services.retain(|service| {
                service.name.to_ascii_lowercase().contains(&query_lower)
                    || service
                        .display_name
                        .to_ascii_lowercase()
                        .contains(&query_lower)
                    || service.status.to_ascii_lowercase().contains(&query_lower)
                    || service
                        .start_type
                        .as_ref()
                        .map(|value| value.to_ascii_lowercase().contains(&query_lower))
                        .unwrap_or(false)
                    || service
                        .service_type
                        .as_ref()
                        .map(|value| value.to_ascii_lowercase().contains(&query_lower))
                        .unwrap_or(false)
            });
        }
        services.sort_by(|left, right| {
            left.display_name
                .to_ascii_lowercase()
                .cmp(&right.display_name.to_ascii_lowercase())
                .then_with(|| {
                    left.name
                        .to_ascii_lowercase()
                        .cmp(&right.name.to_ascii_lowercase())
                })
        });
        services.truncate(request.limit.unwrap_or(DEFAULT_SERVICE_LIMIT));
        Ok(services)
    }
}

pub fn start_service(
    input: &ServiceActionRequest,
) -> Result<ServiceActionResult, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        run_windows_service_action(input, r#"Start-Service -Name $name -ErrorAction Stop"#)
    }
}

pub fn stop_service(
    input: &ServiceActionRequest,
) -> Result<ServiceActionResult, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        run_windows_service_action(
            input,
            r#"Stop-Service -Name $name -Force -ErrorAction Stop"#,
        )
    }
}

pub fn restart_service(
    input: &ServiceActionRequest,
) -> Result<ServiceActionResult, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        run_windows_service_action(
            input,
            r#"Restart-Service -Name $name -Force -ErrorAction Stop"#,
        )
    }
}

pub fn list_scheduled_tasks(
    input: &ListScheduledTasksRequest,
) -> Result<Vec<ScheduledTaskInfo>, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        let request = normalize_list_scheduled_tasks_request(input);
        let payload: Value = run_windows_powershell_json(
            r#"
function Format-GhastTaskDate($value) {
  if ($null -eq $value) {
    return $null
  }
  if ($value -is [DateTime] -and $value.Year -gt 1900) {
    return $value.ToString("o")
  }
  return $null
}

$items = Get-ScheduledTask -ErrorAction Stop | ForEach-Object {
  $info = $null
  try {
    $info = Get-ScheduledTaskInfo -TaskName $_.TaskName -TaskPath $_.TaskPath -ErrorAction Stop
  } catch {
    $info = $null
  }
  [PSCustomObject]@{
    name = [string]$_.TaskName
    taskPath = [string]$_.TaskPath
    state = [string]$_.State
    enabled = if ($null -ne $_.Settings) { [bool]$_.Settings.Enabled } else { $false }
    lastRunAt = Format-GhastTaskDate($info.LastRunTime)
    nextRunAt = Format-GhastTaskDate($info.NextRunTime)
    author = if ($_.Author) { [string]$_.Author } else { $null }
  }
}
$items | ConvertTo-Json -Compress -Depth 4
"#,
            None,
        )?;

        let mut tasks = parse_json_vec::<ScheduledTaskInfo>(payload)?;
        if let Some(query) = request.query {
            let query_lower = query.to_ascii_lowercase();
            tasks.retain(|task| {
                task.name.to_ascii_lowercase().contains(&query_lower)
                    || task.task_path.to_ascii_lowercase().contains(&query_lower)
                    || task.state.to_ascii_lowercase().contains(&query_lower)
                    || task
                        .author
                        .as_ref()
                        .map(|value| value.to_ascii_lowercase().contains(&query_lower))
                        .unwrap_or(false)
            });
        }
        tasks.sort_by(|left, right| {
            left.task_path
                .to_ascii_lowercase()
                .cmp(&right.task_path.to_ascii_lowercase())
                .then_with(|| {
                    left.name
                        .to_ascii_lowercase()
                        .cmp(&right.name.to_ascii_lowercase())
                })
        });
        tasks.truncate(request.limit.unwrap_or(DEFAULT_TASK_LIMIT));
        Ok(tasks)
    }
}

pub fn run_scheduled_task(
    input: &ScheduledTaskActionRequest,
) -> Result<ScheduledTaskActionResult, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        run_windows_scheduled_task_action(
            input,
            r#"Start-ScheduledTask -TaskName $identity.taskName -TaskPath $identity.taskPath -ErrorAction Stop"#,
            false,
        )
    }
}

pub fn delete_scheduled_task(
    input: &ScheduledTaskActionRequest,
) -> Result<ScheduledTaskActionResult, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        run_windows_scheduled_task_action(
            input,
            r#"Unregister-ScheduledTask -TaskName $identity.taskName -TaskPath $identity.taskPath -Confirm:$false -ErrorAction Stop"#,
            true,
        )
    }
}

pub fn run_admin_shell(input: &AdminShellRequest) -> Result<AdminShellResult, AppIntegrationError> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = input;
        Err(AppIntegrationError::UnsupportedPlatform)
    }

    #[cfg(target_os = "windows")]
    {
        if !windows_process_is_elevated()? {
            return Err(AppIntegrationError::PermissionDenied(
                "Companion is not running with administrator rights.".to_string(),
            ));
        }

        let request = normalize_admin_shell_request(input)?;
        let mut command = windows_command(&request.command);
        command.args(&request.arguments);
        if let Some(working_directory) = &request.working_directory {
            command.current_dir(working_directory);
        }
        let output = command
            .output()
            .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;

        Ok(AdminShellResult {
            command: request.command,
            arguments: request.arguments,
            working_directory: request.working_directory,
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            elevated: true,
        })
    }
}

pub fn list_safari_tabs(
    input: &ListSafariTabsRequest,
) -> Result<Vec<SafariTab>, AppIntegrationError> {
    let payload = normalize_safari_tab_query(input);
    let query_json = serialize_js_value(&payload)?;
    run_jxa_json(
        "Safari",
        &format!(
            r#"
const query = {query_json};

function clean(value) {{
  return typeof value === "string" && value.trim() ? value.trim() : null;
}}

const app = Application("Safari");
const limit = Math.max(1, Math.min({MAX_LIST_LIMIT}, Number(query.limit) || {DEFAULT_SAFARI_TAB_LIMIT}));
const tabs = [];

for (let windowIndex = 0; windowIndex < app.windows().length; windowIndex += 1) {{
  const win = app.windows()[windowIndex];
  const currentTab = win.currentTab();
  const currentTabIndex = currentTab ? Number(currentTab.index() || 0) : 0;
  for (const tab of win.tabs()) {{
    tabs.push({{
      windowIndex: windowIndex + 1,
      tabIndex: Number(tab.index() || 0),
      title: clean(tab.name()),
      url: clean(tab.url()),
      active: currentTabIndex > 0 && Number(tab.index() || 0) === currentTabIndex,
    }});
  }}
}}

tabs.sort((left, right) => left.windowIndex - right.windowIndex || left.tabIndex - right.tabIndex);
JSON.stringify(tabs.slice(0, limit));
"#
        ),
    )
}

pub fn open_safari_tab(input: &OpenSafariTabRequest) -> Result<SafariTab, AppIntegrationError> {
    let payload = normalize_safari_open_request(input)?;
    let payload_json = serialize_js_value(&payload)?;
    run_jxa_json(
        "Safari",
        &format!(
            r#"
const payload = {payload_json};

function clean(value) {{
  return typeof value === "string" && value.trim() ? value.trim() : null;
}}

const url = clean(payload.url);
if (!url) {{
  throw new Error("url_required");
}}

const app = Application("Safari");
app.activate();
if (app.windows().length === 0) {{
  app.Document().make();
}}
const win = app.windows()[0];
const tab = app.Tab({{ url }});
win.tabs.push(tab);
if (payload.activate !== false) {{
  win.currentTab = tab;
}}

JSON.stringify({{
  windowIndex: 1,
  tabIndex: Number(tab.index() || 0),
  title: clean(tab.name()),
  url: clean(tab.url()) || url,
  active: payload.activate !== false,
}});
"#
        ),
    )
}

pub fn list_calendars() -> Result<Vec<CalendarInfo>, AppIntegrationError> {
    run_jxa_json(
        "Calendar",
        r#"
const app = Application("Calendar");
const calendars = app.calendars().map((calendar) => ({
  name: String(calendar.name() || "").trim(),
  writable: Boolean(calendar.writable()),
})).filter((calendar) => calendar.name);
JSON.stringify(calendars);
"#,
    )
}

pub fn list_calendar_events(
    input: &ListCalendarEventsRequest,
) -> Result<Vec<CalendarEvent>, AppIntegrationError> {
    let payload = normalize_calendar_event_query(input);
    let query_json = serialize_js_value(&payload)?;
    run_jxa_json(
        "Calendar",
        &format!(
            r#"
const query = {query_json};

function clean(value) {{
  return typeof value === "string" && value.trim() ? value.trim() : null;
}}

function parseDate(value, fieldName) {{
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {{
    throw new Error(fieldName + "_invalid");
  }}
  return date;
}}

const app = Application("Calendar");
const calendarName = clean(query.calendarName);
const fromAt = parseDate(clean(query.fromAt), "fromAt");
const toAt = parseDate(clean(query.toAt), "toAt");
const limit = Math.max(1, Math.min({MAX_LIST_LIMIT}, Number(query.limit) || {DEFAULT_EVENT_LIMIT}));

let calendars = app.calendars();
if (calendarName) {{
  calendars = calendars.filter((calendar) => calendar.name() === calendarName);
}}

const events = [];
for (const calendar of calendars) {{
  const calendarLabel = String(calendar.name() || "").trim();
  for (const event of calendar.events()) {{
    const startDate = event.startDate();
    if (!startDate) {{
      continue;
    }}
    if (fromAt && startDate.getTime() < fromAt.getTime()) {{
      continue;
    }}
    if (toAt && startDate.getTime() > toAt.getTime()) {{
      continue;
    }}
    const endDate = event.endDate();
    const title = String(event.summary() || "").trim();
    events.push({{
      uid: String(event.uid() || "").trim(),
      calendarName: calendarLabel,
      title,
      startAt: startDate.toISOString(),
      endAt: endDate ? endDate.toISOString() : null,
      allDay: Boolean(event.alldayEvent()),
      location: event.location() ? String(event.location()) : null,
      notes: event.description() ? String(event.description()) : null,
    }});
  }}
}}

events.sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime());
JSON.stringify(events.slice(0, limit));
"#
        ),
    )
}

pub fn create_calendar_event(
    input: &CreateCalendarEventRequest,
) -> Result<CalendarEvent, AppIntegrationError> {
    let payload = normalize_calendar_create_request(input)?;
    let payload_json = serialize_js_value(&payload)?;
    run_jxa_json(
        "Calendar",
        &format!(
            r#"
const payload = {payload_json};

function clean(value) {{
  return typeof value === "string" && value.trim() ? value.trim() : null;
}}

function parseRequiredDate(value, fieldName) {{
  const normalized = clean(value);
  if (!normalized) {{
    throw new Error(fieldName + "_required");
  }}
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {{
    throw new Error(fieldName + "_invalid");
  }}
  return date;
}}

const app = Application("Calendar");
const title = clean(payload.title);
if (!title) {{
  throw new Error("title_required");
}}

const startAt = parseRequiredDate(payload.startAt, "startAt");
const endAt = parseRequiredDate(payload.endAt, "endAt");
if (endAt.getTime() <= startAt.getTime()) {{
  throw new Error("end_before_start");
}}

const calendarName = clean(payload.calendarName);
let targetCalendar = null;
if (calendarName) {{
  targetCalendar = app.calendars().find((calendar) => calendar.name() === calendarName) || null;
  if (!targetCalendar) {{
    throw new Error("calendar_not_found");
  }}
}} else {{
  targetCalendar = app.calendars().find((calendar) => calendar.writable()) || null;
}}

if (!targetCalendar) {{
  throw new Error("calendar_unavailable");
}}
if (!targetCalendar.writable()) {{
  throw new Error("calendar_not_writable");
}}

const properties = {{
  summary: title,
  startDate: startAt,
  endDate: endAt,
  alldayEvent: Boolean(payload.allDay),
}};
const location = clean(payload.location);
if (location) {{
  properties.location = location;
}}
const notes = clean(payload.notes);
if (notes) {{
  properties.description = notes;
}}

const event = app.Event(properties);
targetCalendar.events.push(event);

JSON.stringify({{
  uid: String(event.uid() || "").trim(),
  calendarName: String(targetCalendar.name() || "").trim(),
  title: String(event.summary() || "").trim(),
  startAt: event.startDate().toISOString(),
  endAt: event.endDate() ? event.endDate().toISOString() : null,
  allDay: Boolean(event.alldayEvent()),
  location: event.location() ? String(event.location()) : null,
  notes: event.description() ? String(event.description()) : null,
}});
"#
        ),
    )
}

pub fn list_reminder_lists() -> Result<Vec<ReminderList>, AppIntegrationError> {
    run_jxa_json(
        "Reminders",
        r#"
const app = Application("Reminders");
const lists = app.lists().map((list) => ({
  id: String(list.id() || "").trim(),
  name: String(list.name() || "").trim(),
})).filter((list) => list.id && list.name);
JSON.stringify(lists);
"#,
    )
}

pub fn list_reminders(
    input: &ListRemindersRequest,
) -> Result<Vec<ReminderItem>, AppIntegrationError> {
    let payload = normalize_reminder_query(input);
    let query_json = serialize_js_value(&payload)?;
    run_jxa_json(
        "Reminders",
        &format!(
            r#"
const query = {query_json};

function clean(value) {{
  return typeof value === "string" && value.trim() ? value.trim() : null;
}}

const app = Application("Reminders");
const listName = clean(query.listName);
const includeCompleted = Boolean(query.includeCompleted);
const limit = Math.max(1, Math.min({MAX_LIST_LIMIT}, Number(query.limit) || {DEFAULT_REMINDER_LIMIT}));

let lists = app.lists();
if (listName) {{
  lists = lists.filter((list) => list.name() === listName);
}}

const reminders = [];
for (const list of lists) {{
  const listLabel = String(list.name() || "").trim();
  const specifier = list.reminders;
  const ids = specifier.id();
  const names = specifier.name();
  const completedFlags = specifier.completed();
  const dueDates = specifier.dueDate();
  const bodies = specifier.body();
  const priorities = specifier.priority();

  for (let index = 0; index < names.length; index += 1) {{
    if (!includeCompleted && completedFlags[index]) {{
      continue;
    }}
    reminders.push({{
      id: ids[index] ? String(ids[index]).trim() : "",
      listName: listLabel,
      title: names[index] ? String(names[index]).trim() : "",
      completed: Boolean(completedFlags[index]),
      dueAt: dueDates[index] ? dueDates[index].toISOString() : null,
      notes: bodies[index] ? String(bodies[index]) : null,
      priority: Number(priorities[index] || 0),
    }});
  }}
}}

reminders.sort((left, right) => {{
  if (left.completed !== right.completed) {{
    return left.completed ? 1 : -1;
  }}
  if (!left.dueAt && !right.dueAt) {{
    return left.title.localeCompare(right.title);
  }}
  if (!left.dueAt) {{
    return 1;
  }}
  if (!right.dueAt) {{
    return -1;
  }}
  return new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime();
}});

JSON.stringify(reminders.slice(0, limit));
"#
        ),
    )
}

pub fn create_reminder(input: &CreateReminderRequest) -> Result<ReminderItem, AppIntegrationError> {
    let payload = normalize_reminder_create_request(input)?;
    let payload_json = serialize_js_value(&payload)?;
    run_jxa_json(
        "Reminders",
        &format!(
            r#"
const payload = {payload_json};

function clean(value) {{
  return typeof value === "string" && value.trim() ? value.trim() : null;
}}

function parseOptionalDate(value, fieldName) {{
  const normalized = clean(value);
  if (!normalized) {{
    return null;
  }}
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {{
    throw new Error(fieldName + "_invalid");
  }}
  return date;
}}

const app = Application("Reminders");
const title = clean(payload.title);
if (!title) {{
  throw new Error("title_required");
}}

const listName = clean(payload.listName);
let targetList = null;
if (listName) {{
  targetList = app.lists().find((list) => list.name() === listName) || null;
  if (!targetList) {{
    throw new Error("list_not_found");
  }}
}} else {{
  targetList = app.defaultList();
}}

if (!targetList) {{
  throw new Error("list_unavailable");
}}

const properties = {{
  name: title,
}};
const notes = clean(payload.notes);
if (notes) {{
  properties.body = notes;
}}
const dueAt = parseOptionalDate(payload.dueAt, "dueAt");
if (dueAt) {{
  properties.dueDate = dueAt;
}}
if (Number.isInteger(payload.priority)) {{
  properties.priority = payload.priority;
}}

const reminder = app.Reminder(properties);
targetList.reminders.push(reminder);

JSON.stringify({{
  id: String(reminder.id() || "").trim(),
  listName: String(targetList.name() || "").trim(),
  title: String(reminder.name() || "").trim(),
  completed: Boolean(reminder.completed()),
  dueAt: reminder.dueDate() ? reminder.dueDate().toISOString() : null,
  notes: reminder.body() ? String(reminder.body()) : null,
  priority: Number(reminder.priority() || 0),
}});
"#
        ),
    )
}

pub fn complete_reminder(
    input: &CompleteReminderRequest,
) -> Result<ReminderCompletion, AppIntegrationError> {
    let payload = normalize_reminder_complete_request(input)?;
    let payload_json = serialize_js_value(&payload)?;
    run_jxa_json(
        "Reminders",
        &format!(
            r#"
const payload = {payload_json};

function clean(value) {{
  return typeof value === "string" && value.trim() ? value.trim() : null;
}}

const reminderId = clean(payload.id);
if (!reminderId) {{
  throw new Error("id_required");
}}

const app = Application("Reminders");
const reminder = app.reminders.byId(reminderId);
if (!reminder.id()) {{
  throw new Error("reminder_not_found");
}}
reminder.completed = true;

JSON.stringify({{
  id: String(reminder.id() || "").trim(),
  completed: Boolean(reminder.completed()),
}});
"#
        ),
    )
}

fn normalize_calendar_event_query(input: &ListCalendarEventsRequest) -> ListCalendarEventsRequest {
    ListCalendarEventsRequest {
        calendar_name: trim_optional(input.calendar_name.clone()),
        from_at: trim_optional(input.from_at.clone()),
        to_at: trim_optional(input.to_at.clone()),
        limit: Some(clamp_limit(input.limit, DEFAULT_EVENT_LIMIT)),
    }
}

fn normalize_calendar_create_request(
    input: &CreateCalendarEventRequest,
) -> Result<CreateCalendarEventRequest, AppIntegrationError> {
    let title = trim_required(&input.title, "Calendar event title is required.")?;
    let start_at = trim_required(&input.start_at, "Calendar event startAt is required.")?;
    let end_at = trim_required(&input.end_at, "Calendar event endAt is required.")?;
    Ok(CreateCalendarEventRequest {
        title,
        start_at,
        end_at,
        calendar_name: trim_optional(input.calendar_name.clone()),
        location: trim_optional(input.location.clone()),
        notes: trim_optional(input.notes.clone()),
        all_day: input.all_day,
    })
}

fn normalize_reminder_query(input: &ListRemindersRequest) -> ListRemindersRequest {
    ListRemindersRequest {
        list_name: trim_optional(input.list_name.clone()),
        include_completed: input.include_completed,
        limit: Some(clamp_limit(input.limit, DEFAULT_REMINDER_LIMIT)),
    }
}

fn normalize_reminder_create_request(
    input: &CreateReminderRequest,
) -> Result<CreateReminderRequest, AppIntegrationError> {
    let title = trim_required(&input.title, "Reminder title is required.")?;
    let priority = input.priority.map(|value| value.clamp(0, 9));
    Ok(CreateReminderRequest {
        title,
        list_name: trim_optional(input.list_name.clone()),
        due_at: trim_optional(input.due_at.clone()),
        notes: trim_optional(input.notes.clone()),
        priority,
    })
}

fn normalize_reminder_complete_request(
    input: &CompleteReminderRequest,
) -> Result<CompleteReminderRequest, AppIntegrationError> {
    Ok(CompleteReminderRequest {
        id: trim_required(&input.id, "Reminder id is required.")?,
    })
}

fn normalize_contact_query(input: &ListContactsRequest) -> ListContactsRequest {
    ListContactsRequest {
        query: trim_optional(input.query.clone()),
        group_id: trim_optional(input.group_id.clone()),
        group_name: trim_optional(input.group_name.clone()),
        limit: Some(clamp_limit(input.limit, DEFAULT_CONTACT_LIMIT)),
    }
}

fn normalize_note_query(input: &ListNotesRequest) -> ListNotesRequest {
    ListNotesRequest {
        folder_id: trim_optional(input.folder_id.clone()),
        folder_name: trim_optional(input.folder_name.clone()),
        query: trim_optional(input.query.clone()),
        limit: Some(clamp_limit(input.limit, DEFAULT_NOTE_LIMIT)),
    }
}

fn normalize_note_create_request(
    input: &CreateNoteRequest,
) -> Result<CreateNoteRequest, AppIntegrationError> {
    Ok(CreateNoteRequest {
        title: trim_required(&input.title, "Note title is required.")?,
        body: trim_required(&input.body, "Note body is required.")?,
        folder_id: trim_optional(input.folder_id.clone()),
        folder_name: trim_optional(input.folder_name.clone()),
    })
}

fn normalize_finder_list_request(input: &ListFinderItemsRequest) -> ListFinderItemsRequest {
    ListFinderItemsRequest {
        path: trim_optional(input.path.clone()),
        include_hidden: input.include_hidden,
        limit: Some(clamp_limit(input.limit, DEFAULT_FINDER_LIMIT)),
    }
}

fn normalize_finder_reveal_request(
    input: &FinderRevealRequest,
) -> Result<FinderRevealRequest, AppIntegrationError> {
    Ok(FinderRevealRequest {
        path: trim_required(&input.path, "Finder path is required.")?,
    })
}

#[cfg(target_os = "windows")]
fn normalize_set_clipboard_request(
    input: &SetClipboardTextRequest,
) -> Result<SetClipboardTextRequest, AppIntegrationError> {
    Ok(SetClipboardTextRequest {
        text: trim_required(&input.text, "Clipboard text is required.")?,
    })
}

#[cfg(target_os = "windows")]
fn normalize_read_text_file_request(
    input: &ReadTextFileRequest,
) -> Result<ReadTextFileRequest, AppIntegrationError> {
    Ok(ReadTextFileRequest {
        path: trim_required(&input.path, "File path is required.")?,
    })
}

#[cfg(target_os = "windows")]
fn normalize_write_text_file_request(
    input: &WriteTextFileRequest,
) -> Result<WriteTextFileRequest, AppIntegrationError> {
    Ok(WriteTextFileRequest {
        path: trim_required(&input.path, "File path is required.")?,
        text: input.text.clone(),
    })
}

fn normalize_explorer_list_request(input: &ListExplorerItemsRequest) -> ListExplorerItemsRequest {
    ListExplorerItemsRequest {
        path: trim_optional(input.path.clone()),
        include_hidden: input.include_hidden,
        limit: Some(clamp_limit(input.limit, DEFAULT_FINDER_LIMIT)),
    }
}

fn normalize_explorer_reveal_request(
    input: &ExplorerRevealRequest,
) -> Result<ExplorerRevealRequest, AppIntegrationError> {
    Ok(ExplorerRevealRequest {
        path: trim_required(&input.path, "Explorer path is required.")?,
    })
}

#[cfg(target_os = "windows")]
fn normalize_list_processes_request(input: &ListProcessesRequest) -> ListProcessesRequest {
    ListProcessesRequest {
        query: trim_optional(input.query.clone()),
        limit: Some(clamp_limit(input.limit, DEFAULT_PROCESS_LIMIT)),
    }
}

#[cfg(target_os = "windows")]
fn normalize_terminate_process_request(
    input: &TerminateProcessRequest,
) -> Result<TerminateProcessRequest, AppIntegrationError> {
    if input.pid == 0 {
        return Err(AppIntegrationError::InvalidRequest(
            "Process pid is required.".to_string(),
        ));
    }

    Ok(TerminateProcessRequest {
        pid: input.pid,
        force: input.force,
    })
}

#[cfg(target_os = "windows")]
fn normalize_capture_screenshot_request(
    input: &CaptureScreenshotRequest,
) -> CaptureScreenshotRequest {
    CaptureScreenshotRequest {
        display_index: input.display_index,
    }
}

#[cfg(target_os = "windows")]
fn normalize_list_windows_request(input: &ListWindowsRequest) -> ListWindowsRequest {
    ListWindowsRequest {
        query: trim_optional(input.query.clone()),
        include_minimized: input.include_minimized,
        limit: Some(clamp_limit(input.limit, DEFAULT_WINDOW_LIMIT)),
    }
}

#[cfg(target_os = "windows")]
fn normalize_window_action_request(
    input: &WindowActionRequest,
) -> Result<WindowActionRequest, AppIntegrationError> {
    Ok(WindowActionRequest {
        window_handle: trim_required(&input.window_handle, "Window handle is required.")?,
    })
}

#[cfg(target_os = "windows")]
fn normalize_desktop_notification_request(
    input: &DesktopNotificationRequest,
) -> Result<DesktopNotificationRequest, AppIntegrationError> {
    Ok(DesktopNotificationRequest {
        title: trim_required(&input.title, "Notification title is required.")?,
        body: trim_optional(input.body.clone()),
    })
}

#[cfg(any(target_os = "windows", test))]
fn normalize_registry_write_request(
    input: &RegistryWriteRequest,
) -> Result<RegistryWriteRequest, AppIntegrationError> {
    let value_type =
        trim_required(&input.value_type, "Registry valueType is required.")?.to_ascii_lowercase();
    if !matches!(
        value_type.as_str(),
        "string" | "expand_string" | "dword" | "qword"
    ) {
        return Err(AppIntegrationError::InvalidRequest(
            "Registry valueType must be string, expand_string, dword, or qword.".to_string(),
        ));
    }

    let value = normalize_registry_value(&input.value, &value_type)?;
    Ok(RegistryWriteRequest {
        path: trim_required(&input.path, "Registry path is required.")?,
        name: trim_required(&input.name, "Registry name is required.")?,
        value_type,
        value,
    })
}

#[cfg(any(target_os = "windows", test))]
fn normalize_registry_value(value: &Value, value_type: &str) -> Result<Value, AppIntegrationError> {
    match value_type {
        "string" | "expand_string" => match value {
            Value::String(text) => Ok(Value::String(text.clone())),
            Value::Number(_) | Value::Bool(_) => Ok(Value::String(value.to_string())),
            _ => Err(AppIntegrationError::InvalidRequest(
                "Registry string values must be a string, number, or boolean.".to_string(),
            )),
        },
        "dword" => {
            let parsed = parse_registry_integer_value(value, "Registry DWORD value is invalid.")?;
            if parsed > u32::MAX as u64 {
                return Err(AppIntegrationError::InvalidRequest(
                    "Registry DWORD value must be between 0 and 4294967295.".to_string(),
                ));
            }
            Ok(Value::String(parsed.to_string()))
        }
        "qword" => {
            let parsed = parse_registry_integer_value(value, "Registry QWORD value is invalid.")?;
            Ok(Value::String(parsed.to_string()))
        }
        _ => Err(AppIntegrationError::InvalidRequest(
            "Registry valueType is invalid.".to_string(),
        )),
    }
}

#[cfg(any(target_os = "windows", test))]
fn parse_registry_integer_value(value: &Value, message: &str) -> Result<u64, AppIntegrationError> {
    match value {
        Value::Number(number) => number
            .as_u64()
            .or_else(|| number.as_i64().and_then(|value| u64::try_from(value).ok()))
            .ok_or_else(|| AppIntegrationError::InvalidRequest(message.to_string())),
        Value::String(text) => parse_unsigned_integer(text, message),
        _ => Err(AppIntegrationError::InvalidRequest(message.to_string())),
    }
}

#[cfg(any(target_os = "windows", test))]
fn parse_unsigned_integer(value: &str, message: &str) -> Result<u64, AppIntegrationError> {
    let trimmed = value.trim();
    let parsed = if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        u64::from_str_radix(hex, 16)
    } else {
        trimmed.parse::<u64>()
    };

    parsed.map_err(|_| AppIntegrationError::InvalidRequest(message.to_string()))
}

#[cfg(any(target_os = "windows", test))]
fn normalize_list_services_request(input: &ListServicesRequest) -> ListServicesRequest {
    ListServicesRequest {
        query: trim_optional(input.query.clone()),
        limit: Some(clamp_limit(input.limit, DEFAULT_SERVICE_LIMIT)),
    }
}

#[cfg(any(target_os = "windows", test))]
fn normalize_service_action_request(
    input: &ServiceActionRequest,
) -> Result<ServiceActionRequest, AppIntegrationError> {
    Ok(ServiceActionRequest {
        name: trim_required(&input.name, "Service name is required.")?,
    })
}

#[cfg(any(target_os = "windows", test))]
fn normalize_list_scheduled_tasks_request(
    input: &ListScheduledTasksRequest,
) -> ListScheduledTasksRequest {
    ListScheduledTasksRequest {
        query: trim_optional(input.query.clone()),
        limit: Some(clamp_limit(input.limit, DEFAULT_TASK_LIMIT)),
    }
}

#[cfg(any(target_os = "windows", test))]
fn normalize_scheduled_task_action_request(
    input: &ScheduledTaskActionRequest,
) -> Result<ScheduledTaskActionRequest, AppIntegrationError> {
    Ok(ScheduledTaskActionRequest {
        name: trim_required(&input.name, "Scheduled task name is required.")?,
        task_path: trim_optional(input.task_path.clone()),
    })
}

#[cfg(any(target_os = "windows", test))]
fn normalize_admin_shell_request(
    input: &AdminShellRequest,
) -> Result<AdminShellRequest, AppIntegrationError> {
    let working_directory = match trim_optional(input.working_directory.clone()) {
        Some(path) => {
            let resolved = resolve_local_path(Some(&path))?;
            if !resolved.exists() {
                return Err(AppIntegrationError::InvalidRequest(
                    "Admin shell workingDirectory does not exist.".to_string(),
                ));
            }
            if !resolved.is_dir() {
                return Err(AppIntegrationError::InvalidRequest(
                    "Admin shell workingDirectory must be a directory.".to_string(),
                ));
            }
            Some(resolved.to_string_lossy().to_string())
        }
        None => None,
    };

    Ok(AdminShellRequest {
        command: trim_required(&input.command, "Admin shell command is required.")?,
        arguments: input
            .arguments
            .iter()
            .filter_map(|value| trim_optional(Some(value.clone())))
            .collect(),
        working_directory,
    })
}

fn normalize_safari_tab_query(input: &ListSafariTabsRequest) -> ListSafariTabsRequest {
    ListSafariTabsRequest {
        limit: Some(clamp_limit(input.limit, DEFAULT_SAFARI_TAB_LIMIT)),
    }
}

fn normalize_safari_open_request(
    input: &OpenSafariTabRequest,
) -> Result<OpenSafariTabRequest, AppIntegrationError> {
    Ok(OpenSafariTabRequest {
        url: trim_required(&input.url, "Safari URL is required.")?,
        activate: input.activate,
    })
}

fn trim_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn trim_required(value: &str, message: &str) -> Result<String, AppIntegrationError> {
    let normalized = value.trim();
    if normalized.is_empty() {
        Err(AppIntegrationError::InvalidRequest(message.to_string()))
    } else {
        Ok(normalized.to_string())
    }
}

fn clamp_limit(limit: Option<usize>, default_limit: usize) -> usize {
    limit.unwrap_or(default_limit).max(1).min(MAX_LIST_LIMIT)
}

fn serialize_js_value<T: Serialize>(value: &T) -> Result<String, AppIntegrationError> {
    serde_json::to_string(value)
        .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))
}

fn default_true() -> bool {
    true
}

fn app_exists(app_name: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        let system_path = format!("/System/Applications/{app_name}.app");
        let applications_path = format!("/Applications/{app_name}.app");
        let core_services_path = format!("/System/Library/CoreServices/{app_name}.app");
        Path::new(&system_path).exists()
            || Path::new(&applications_path).exists()
            || Path::new(&core_services_path).exists()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_name;
        false
    }
}

fn finder_sort_rank(item_type: &str) -> u8 {
    match item_type {
        "directory" => 0,
        "file" => 1,
        "symlink" => 2,
        _ => 3,
    }
}

fn resolve_finder_path(value: Option<&str>) -> Result<PathBuf, AppIntegrationError> {
    resolve_local_path(value)
}

fn resolve_local_path(value: Option<&str>) -> Result<PathBuf, AppIntegrationError> {
    let raw = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            home_dir()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_else(|| ".".to_string())
        });
    let expanded = expand_home(&raw);
    if expanded.exists() {
        expanded
            .canonicalize()
            .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))
    } else {
        Ok(expanded)
    }
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(
                || match (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH")) {
                    (Some(drive), Some(path)) => {
                        let mut joined = PathBuf::from(drive);
                        joined.push(path);
                        Some(joined)
                    }
                    _ => None,
                },
            )
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn expand_home(value: &str) -> PathBuf {
    if value == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(value));
    }
    if let Some(stripped) = value.strip_prefix("~/") {
        return home_dir()
            .map(|path| path.join(stripped))
            .unwrap_or_else(|| PathBuf::from(value));
    }
    PathBuf::from(value)
}

fn ensure_macos_app_ready(app_name: &str) -> Result<(), AppIntegrationError> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_name;
        return Err(AppIntegrationError::UnsupportedPlatform);
    }

    #[cfg(target_os = "macos")]
    {
        if !app_exists(app_name) {
            return Err(AppIntegrationError::ExecutionFailed(format!(
                "{app_name} is not available on this Mac."
            )));
        }

        let output = Command::new("open")
            .args(["-g", "-a", app_name])
            .output()
            .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let message = if stderr.is_empty() {
                format!("Failed to prepare {app_name}.")
            } else {
                stderr
            };
            Err(AppIntegrationError::ExecutionFailed(message))
        }
    }
}

fn list_directory_items(
    target: &Path,
    include_hidden: bool,
    limit: Option<usize>,
) -> Result<Vec<FinderItem>, AppIntegrationError> {
    let mut items = Vec::new();
    let entries = fs::read_dir(target)
        .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().trim().to_string();
        if name.is_empty() {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
        let is_hidden = item_is_hidden(&name, &metadata);
        if !include_hidden && is_hidden {
            continue;
        }
        let file_type = metadata.file_type();
        let item_type = if file_type.is_dir() {
            "directory"
        } else if file_type.is_file() {
            "file"
        } else if file_type.is_symlink() {
            "symlink"
        } else {
            "other"
        };
        items.push(FinderItem {
            name,
            path: path.to_string_lossy().to_string(),
            item_type: item_type.to_string(),
            is_hidden,
            size: if metadata.is_file() {
                Some(metadata.len())
            } else {
                None
            },
        });
    }

    items.sort_by(|left, right| {
        finder_sort_rank(&left.item_type)
            .cmp(&finder_sort_rank(&right.item_type))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    items.truncate(limit.unwrap_or(DEFAULT_FINDER_LIMIT));
    Ok(items)
}

#[cfg(target_os = "windows")]
fn item_is_hidden(name: &str, metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    name.starts_with('.') || (metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN) != 0
}

#[cfg(not(target_os = "windows"))]
fn item_is_hidden(name: &str, _metadata: &fs::Metadata) -> bool {
    name.starts_with('.')
}

#[cfg(target_os = "windows")]
fn windows_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(target_os = "windows")]
fn run_windows_powershell_json<T: DeserializeOwned>(
    script: &str,
    stdin_text: Option<&str>,
) -> Result<T, AppIntegrationError> {
    let mut command = windows_command("powershell.exe");
    let mut child = command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(if stdin_text.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;

    if let Some(input) = stdin_text {
        if let Some(stdin) = child.stdin.as_mut() {
            stdin
                .write_all(input.as_bytes())
                .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
    if !output.status.success() {
        return Err(classify_windows_command_error(
            &output.stderr,
            &output.stdout,
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    serde_json::from_str::<T>(&stdout).map_err(|error| {
        let message = if stdout.is_empty() {
            error.to_string()
        } else {
            format!("Failed to parse Windows command response: {error}; raw={stdout}")
        };
        AppIntegrationError::ExecutionFailed(message)
    })
}

#[cfg(target_os = "windows")]
fn run_windows_service_action(
    input: &ServiceActionRequest,
    action_script: &str,
) -> Result<ServiceActionResult, AppIntegrationError> {
    let request = normalize_service_action_request(input)?;
    let payload = serde_json::to_string(&request)
        .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
    run_windows_powershell_json(
        &format!(
            r#"
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
$name = [string]$payload.name
$service = Get-Service -Name $name -ErrorAction SilentlyContinue
if ($null -eq $service) {{
  throw "service_not_found"
}}
{action_script}
$service = Get-Service -Name $name -ErrorAction Stop
[PSCustomObject]@{{
  name = [string]$service.Name
  displayName = [string]$service.DisplayName
  status = [string]$service.Status
}} | ConvertTo-Json -Compress
"#,
        ),
        Some(payload.as_str()),
    )
}

#[cfg(target_os = "windows")]
fn run_windows_scheduled_task_action(
    input: &ScheduledTaskActionRequest,
    action_script: &str,
    deleted: bool,
) -> Result<ScheduledTaskActionResult, AppIntegrationError> {
    let request = normalize_scheduled_task_action_request(input)?;
    let payload = serde_json::to_string(&request)
        .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
    let state_block = if deleted {
        "$state = $null".to_string()
    } else {
        r#"
$task = Get-ScheduledTask -TaskName $identity.taskName -TaskPath $identity.taskPath -ErrorAction Stop
$state = [string]$task.State
"#
        .to_string()
    };

    run_windows_powershell_json(
        &format!(
            r#"
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop

function Resolve-GhastTaskIdentity([string]$rawName, [string]$rawPath) {{
  $taskName = $rawName.Trim()
  $taskPath = if ([string]::IsNullOrWhiteSpace($rawPath)) {{ $null }} else {{ $rawPath.Trim().Replace('/', '\') }}
  if ([string]::IsNullOrWhiteSpace($taskPath) -and $taskName.StartsWith("\")) {{
    $normalized = $taskName.Replace('/', '\')
    $lastSlash = $normalized.LastIndexOf('\')
    if ($lastSlash -gt 0) {{
      $taskPath = $normalized.Substring(0, $lastSlash + 1)
      $taskName = $normalized.Substring($lastSlash + 1)
    }}
  }}
  if ([string]::IsNullOrWhiteSpace($taskPath)) {{
    $taskPath = "\"
  }}
  if (-not $taskPath.StartsWith("\")) {{
    $taskPath = "\" + $taskPath
  }}
  if (-not $taskPath.EndsWith("\")) {{
    $taskPath = $taskPath + "\"
  }}
  if ([string]::IsNullOrWhiteSpace($taskName)) {{
    throw "task_not_found"
  }}
  return [PSCustomObject]@{{
    taskName = $taskName
    taskPath = $taskPath
  }}
}}

$identity = Resolve-GhastTaskIdentity([string]$payload.name, [string]$payload.taskPath)
$existing = Get-ScheduledTask -TaskName $identity.taskName -TaskPath $identity.taskPath -ErrorAction SilentlyContinue
if ($null -eq $existing) {{
  throw "task_not_found"
}}
{action_script}
{state_block}
[PSCustomObject]@{{
  name = [string]$identity.taskName
  taskPath = [string]$identity.taskPath
  success = $true
  state = $state
}} | ConvertTo-Json -Compress
"#,
        ),
        Some(payload.as_str()),
    )
}

#[cfg(target_os = "windows")]
fn windows_process_is_elevated() -> Result<bool, AppIntegrationError> {
    let payload: Value = run_windows_powershell_json(
        r#"
[bool]$isElevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
[PSCustomObject]@{
  elevated = $isElevated
} | ConvertTo-Json -Compress
"#,
        None,
    )?;
    Ok(payload
        .get("elevated")
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

#[cfg(target_os = "windows")]
fn parse_json_vec<T: DeserializeOwned>(value: Value) -> Result<Vec<T>, AppIntegrationError> {
    match value {
        Value::Null => Ok(Vec::new()),
        Value::Array(items) => serde_json::from_value(Value::Array(items))
            .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string())),
        other => serde_json::from_value(other)
            .map(|item| vec![item])
            .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string())),
    }
}

#[cfg(target_os = "windows")]
fn parse_window_handle(value: &str) -> Result<u64, AppIntegrationError> {
    let trimmed = value.trim();
    let parsed = if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        u64::from_str_radix(hex, 16)
    } else {
        trimmed.parse::<u64>()
    };

    match parsed {
        Ok(handle) if handle > 0 => Ok(handle),
        _ => Err(AppIntegrationError::InvalidRequest(
            "Window handle is invalid.".to_string(),
        )),
    }
}

#[cfg(target_os = "windows")]
fn classify_windows_command_error(stderr: &[u8], stdout: &[u8]) -> AppIntegrationError {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    let combined = if stderr.is_empty() {
        stdout
    } else if stdout.is_empty() {
        stderr
    } else {
        format!("{stderr} {stdout}")
    };
    let normalized = combined.to_ascii_lowercase();

    if normalized.contains("access is denied")
        || normalized.contains("requested registry access is not allowed")
        || normalized.contains("拒绝访问")
    {
        return AppIntegrationError::PermissionDenied(if combined.is_empty() {
            "Windows denied access to the requested action.".to_string()
        } else {
            combined
        });
    }

    if normalized.contains("cannot find path")
        || normalized.contains("path_not_found")
        || normalized.contains("screen_not_found")
        || normalized.contains("process_not_found")
        || normalized.contains("window_not_found")
        || normalized.contains("service_not_found")
        || normalized.contains("task_not_found")
        || normalized.contains("registry_path_invalid")
        || normalized.contains("registry_name_required")
        || normalized.contains("registry_value_type_invalid")
        || normalized.contains("cannot find a process with the process identifier")
        || normalized.contains("cannot find any service with service name")
        || normalized.contains("no msft_scheduledtask objects found")
    {
        return AppIntegrationError::InvalidRequest(if normalized.contains("screen_not_found") {
            "The requested screen was not found.".to_string()
        } else if normalized.contains("process_not_found")
            || normalized.contains("cannot find a process with the process identifier")
        {
            "The requested process was not found.".to_string()
        } else if normalized.contains("window_not_found") {
            "The requested window was not found.".to_string()
        } else if normalized.contains("service_not_found")
            || normalized.contains("cannot find any service with service name")
        {
            "The requested Windows service was not found.".to_string()
        } else if normalized.contains("task_not_found")
            || normalized.contains("no msft_scheduledtask objects found")
        {
            "The requested scheduled task was not found.".to_string()
        } else if normalized.contains("registry_path_invalid") {
            "The requested registry path is invalid.".to_string()
        } else if normalized.contains("registry_name_required") {
            "Registry name is required.".to_string()
        } else if normalized.contains("registry_value_type_invalid") {
            "The requested registry value type is not supported.".to_string()
        } else {
            "The requested path was not found.".to_string()
        });
    }

    if combined.is_empty() {
        AppIntegrationError::ExecutionFailed("Windows command failed.".to_string())
    } else {
        AppIntegrationError::ExecutionFailed(combined)
    }
}

fn run_jxa_json<T: DeserializeOwned>(
    app_name: &str,
    script: &str,
) -> Result<T, AppIntegrationError> {
    ensure_macos_app_ready(app_name)?;

    let mut child = Command::new("osascript")
        .args(["-l", "JavaScript"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(script.as_bytes())
            .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|error| AppIntegrationError::ExecutionFailed(error.to_string()))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        return Err(classify_script_error(&stderr, &stdout));
    }

    serde_json::from_str::<T>(&stdout).map_err(|error| {
        let message = if stdout.is_empty() {
            error.to_string()
        } else {
            format!("Failed to parse app response: {error}; raw={stdout}")
        };
        AppIntegrationError::ExecutionFailed(message)
    })
}

fn classify_script_error(stderr: &str, stdout: &str) -> AppIntegrationError {
    let combined = if stderr.is_empty() {
        stdout.trim().to_string()
    } else if stdout.trim().is_empty() {
        stderr.trim().to_string()
    } else {
        format!("{} {}", stderr.trim(), stdout.trim())
    };
    let normalized = combined.to_ascii_lowercase();

    if normalized.contains("-1743")
        || normalized.contains("-10004")
        || normalized.contains("not authorized")
        || normalized.contains("not permitted")
        || normalized.contains("没有获得")
        || normalized.contains("未获得")
        || normalized.contains("不允许")
        || normalized.contains("权限")
    {
        return AppIntegrationError::PermissionDenied(if combined.is_empty() {
            "macOS denied access to the requested app data.".to_string()
        } else {
            combined
        });
    }

    let mapped = if normalized.contains("title_required") {
        Some("Title is required.".to_string())
    } else if normalized.contains("startat_required") {
        Some("startAt is required.".to_string())
    } else if normalized.contains("endat_required") {
        Some("endAt is required.".to_string())
    } else if normalized.contains("dueat_invalid") {
        Some("dueAt must be a valid ISO date string.".to_string())
    } else if normalized.contains("fromat_invalid") {
        Some("fromAt must be a valid ISO date string.".to_string())
    } else if normalized.contains("toat_invalid") {
        Some("toAt must be a valid ISO date string.".to_string())
    } else if normalized.contains("startat_invalid") {
        Some("startAt must be a valid ISO date string.".to_string())
    } else if normalized.contains("endat_invalid") {
        Some("endAt must be a valid ISO date string.".to_string())
    } else if normalized.contains("end_before_start") {
        Some("endAt must be after startAt.".to_string())
    } else if normalized.contains("calendar_not_found") {
        Some("The requested calendar was not found.".to_string())
    } else if normalized.contains("calendar_not_writable") {
        Some("The requested calendar cannot be modified.".to_string())
    } else if normalized.contains("calendar_unavailable") {
        Some("No writable calendar is available.".to_string())
    } else if normalized.contains("contact_group_not_found") {
        Some("The requested contact group was not found.".to_string())
    } else if normalized.contains("folder_not_found") {
        Some("The requested note folder was not found.".to_string())
    } else if normalized.contains("folder_unavailable") {
        Some("No writable note folder is available.".to_string())
    } else if normalized.contains("body_required") {
        Some("Body is required.".to_string())
    } else if normalized.contains("list_not_found") {
        Some("The requested reminder list was not found.".to_string())
    } else if normalized.contains("list_unavailable") {
        Some("No reminder list is available.".to_string())
    } else if normalized.contains("reminder_not_found") {
        Some("The requested reminder was not found.".to_string())
    } else if normalized.contains("url_required") {
        Some("Safari URL is required.".to_string())
    } else if normalized.contains("id_required") {
        Some("Reminder id is required.".to_string())
    } else {
        None
    };

    if let Some(message) = mapped {
        AppIntegrationError::InvalidRequest(message)
    } else if combined.is_empty() {
        AppIntegrationError::ExecutionFailed("App integration command failed.".to_string())
    } else {
        AppIntegrationError::ExecutionFailed(combined)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clamps_limits_into_supported_range() {
        assert_eq!(clamp_limit(None, 50), 50);
        assert_eq!(clamp_limit(Some(0), 50), 1);
        assert_eq!(clamp_limit(Some(999), 50), MAX_LIST_LIMIT);
    }

    #[test]
    fn trims_calendar_create_request() {
        let request = normalize_calendar_create_request(&CreateCalendarEventRequest {
            title: "  Team sync  ".to_string(),
            start_at: " 2026-04-07T10:00:00+08:00 ".to_string(),
            end_at: " 2026-04-07T11:00:00+08:00 ".to_string(),
            calendar_name: Some(" 工作 ".to_string()),
            location: Some(" 会议室 ".to_string()),
            notes: Some(" 记得带材料 ".to_string()),
            all_day: false,
        })
        .expect("request should normalize");

        assert_eq!(request.title, "Team sync");
        assert_eq!(request.calendar_name.as_deref(), Some("工作"));
        assert_eq!(request.location.as_deref(), Some("会议室"));
        assert_eq!(request.notes.as_deref(), Some("记得带材料"));
    }

    #[test]
    fn trims_note_create_request() {
        let request = normalize_note_create_request(&CreateNoteRequest {
            title: "  Daily plan  ".to_string(),
            body: "  Call Alice  ".to_string(),
            folder_id: Some(" note-folder-id ".to_string()),
            folder_name: Some(" Work ".to_string()),
        })
        .expect("request should normalize");

        assert_eq!(request.title, "Daily plan");
        assert_eq!(request.body, "Call Alice");
        assert_eq!(request.folder_id.as_deref(), Some("note-folder-id"));
        assert_eq!(request.folder_name.as_deref(), Some("Work"));
    }

    #[test]
    fn expands_tilde_paths_for_finder_requests() {
        let path = resolve_finder_path(Some("~/Desktop")).expect("path should resolve");
        assert!(path.is_absolute());
        assert!(path.to_string_lossy().contains("/Desktop"));
    }

    #[test]
    fn classifies_permission_denied_errors() {
        let error = classify_script_error(
            "execution error: Not authorized to send Apple events to Calendar. (-1743)",
            "",
        );
        assert!(matches!(error, AppIntegrationError::PermissionDenied(_)));
    }

    #[test]
    fn classifies_known_invalid_request_markers() {
        let error = classify_script_error("execution error: Error: calendar_not_found", "");
        assert!(matches!(error, AppIntegrationError::InvalidRequest(_)));
        assert_eq!(error.to_string(), "The requested calendar was not found.");
    }

    #[test]
    fn classifies_note_folder_errors() {
        let error = classify_script_error("execution error: Error: folder_not_found", "");
        assert!(matches!(error, AppIntegrationError::InvalidRequest(_)));
        assert_eq!(
            error.to_string(),
            "The requested note folder was not found."
        );
    }

    #[test]
    fn serializes_js_payload_safely() {
        let payload = CreateReminderRequest {
            title: "\"quoted\"\nline".to_string(),
            list_name: None,
            due_at: None,
            notes: Some("path C:\\tmp".to_string()),
            priority: Some(5),
        };
        let encoded = serialize_js_value(&payload).expect("payload should encode");
        assert!(encoded.contains("\\\"quoted\\\"\\nline"));
        assert!(encoded.contains("C:\\\\tmp"));
    }

    #[test]
    fn normalizes_registry_write_request() {
        let request = normalize_registry_write_request(&RegistryWriteRequest {
            path: " HKCU\\Software\\Ghast ".to_string(),
            name: " Example ".to_string(),
            value_type: " DWORD ".to_string(),
            value: json!("0x10"),
        })
        .expect("request should normalize");

        assert_eq!(request.path, "HKCU\\Software\\Ghast");
        assert_eq!(request.name, "Example");
        assert_eq!(request.value_type, "dword");
        assert_eq!(request.value, json!("16"));
    }

    #[test]
    fn rejects_invalid_registry_value_type() {
        let error = normalize_registry_write_request(&RegistryWriteRequest {
            path: "HKCU\\Software\\Ghast".to_string(),
            name: "Example".to_string(),
            value_type: "binary".to_string(),
            value: json!("test"),
        })
        .expect_err("binary should be rejected");

        assert!(matches!(error, AppIntegrationError::InvalidRequest(_)));
    }

    #[test]
    fn trims_service_and_task_requests() {
        let service = normalize_service_action_request(&ServiceActionRequest {
            name: "  Spooler  ".to_string(),
        })
        .expect("service should normalize");
        let task = normalize_scheduled_task_action_request(&ScheduledTaskActionRequest {
            name: "  Nightly Job  ".to_string(),
            task_path: Some("  \\Custom  ".to_string()),
        })
        .expect("task should normalize");

        assert_eq!(service.name, "Spooler");
        assert_eq!(task.name, "Nightly Job");
        assert_eq!(task.task_path.as_deref(), Some("\\Custom"));
    }

    #[test]
    fn normalizes_service_and_task_list_requests() {
        let services = normalize_list_services_request(&ListServicesRequest {
            query: Some("  sql  ".to_string()),
            limit: Some(0),
        });
        let tasks = normalize_list_scheduled_tasks_request(&ListScheduledTasksRequest {
            query: Some("  nightly  ".to_string()),
            limit: Some(999),
        });

        assert_eq!(services.query.as_deref(), Some("sql"));
        assert_eq!(services.limit, Some(1));
        assert_eq!(tasks.query.as_deref(), Some("nightly"));
        assert_eq!(tasks.limit, Some(MAX_LIST_LIMIT));
    }

    #[test]
    fn normalizes_admin_shell_request_directory() {
        let current_dir = std::env::current_dir().expect("current dir should exist");
        let request = normalize_admin_shell_request(&AdminShellRequest {
            command: "  cmd.exe  ".to_string(),
            arguments: vec![
                " /c ".to_string(),
                " echo test ".to_string(),
                "".to_string(),
            ],
            working_directory: Some(current_dir.to_string_lossy().to_string()),
        })
        .expect("admin shell request should normalize");

        assert_eq!(request.command, "cmd.exe");
        assert_eq!(
            request.arguments,
            vec!["/c".to_string(), "echo test".to_string()]
        );
        assert_eq!(
            request.working_directory.as_deref(),
            Some(current_dir.to_string_lossy().as_ref())
        );
    }
}
