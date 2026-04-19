// Wire types — exact mirror of utils/companion-agent-protocol/types.ts in the
// extension repo. Keeping the JSON shape identical is what allows the SSE
// stream to be consumed by the existing TypeScript client without translation.
//
// Field naming is camelCase to match the extension; we use serde rename_all on
// each struct rather than a single global default so the line of sight from
// rust field → wire field stays explicit at every site.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    #[serde(default = "default_tool_type")]
    #[serde(rename = "type")]
    pub kind: String,
    pub function: ToolDefinitionFunction,
}

fn default_tool_type() -> String {
    "function".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinitionFunction {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub parameters: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAgentTurnRequest {
    #[serde(default)]
    pub conversation_id: Option<String>,
    pub system_prompt: String,
    #[serde(default)]
    pub post_system_messages: Option<Vec<ChatMessage>>,
    pub history: Vec<ChatMessage>,
    pub prompt: String,
    pub provider_url: String,
    pub model: String,
    pub api_secret: ApiSecretInput,
    pub tool_definitions: Vec<ToolDefinition>,
    #[serde(default)]
    pub max_turns: Option<u32>,
}

/// Mirror of ApiSecretInput in the extension. May be a single string OR an
/// object with a `pool` array. We accept either form and normalize on use.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ApiSecretInput {
    Single(String),
    Pool {
        #[serde(default)]
        pool: Vec<String>,
    },
}

impl ApiSecretInput {
    pub fn first(&self) -> Option<&str> {
        match self {
            ApiSecretInput::Single(s) => Some(s.as_str()),
            ApiSecretInput::Pool { pool } => pool.first().map(|s| s.as_str()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolCallEventPayload {
    pub run_id: String,
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolResultRequest {
    pub call_id: String,
    pub result: String,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolResultAck {
    pub ok: bool,
    pub run_id: String,
    pub call_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAssistantDeltaEventPayload {
    pub run_id: String,
    pub chunk: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeDiagnosticEventPayload {
    pub run_id: String,
    pub event: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageEventPayload {
    pub run_id: String,
    pub usage: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedRunPiAgentLoopResult {
    pub assistant_text: String,
    #[serde(default)]
    pub assistant_turns: Vec<Value>,
    pub context_report: Option<Value>,
    pub tool_outputs: Vec<String>,
    pub invoked_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_diagnostics: Option<Vec<Value>>,
    pub aborted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCompleteEventPayload {
    pub run_id: String,
    pub result: SerializedRunPiAgentLoopResult,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnErrorDetail {
    pub code: AgentTurnErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTurnErrorCode {
    BadRequest,
    ProviderError,
    ToolResultTimeout,
    ToolResultRejected,
    Cancelled,
    InternalError,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentErrorEventPayload {
    pub run_id: String,
    pub error: AgentTurnErrorDetail,
}

/// SSE event envelope. The TypeScript client parses `{ type, payload }`
/// directly, so we use serde tagged-union to match.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum AgentTurnSseEvent {
    AssistantDelta(AgentAssistantDeltaEventPayload),
    ToolCall(AgentToolCallEventPayload),
    RuntimeDiagnostic(AgentRuntimeDiagnosticEventPayload),
    Usage(AgentUsageEventPayload),
    Complete(AgentCompleteEventPayload),
    Error(AgentErrorEventPayload),
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTurnStatus {
    Running,
    WaitingToolResult,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAgentTurnStatusResponse {
    pub ok: bool,
    pub run_id: String,
    pub status: AgentTurnStatus,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<SerializedRunPiAgentLoopResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<AgentTurnErrorDetail>,
}
