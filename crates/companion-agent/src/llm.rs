// OpenAI-compatible streaming chat completions. Ghast's extension talks to
// providers via the same /v1/proxy/chat/completions shape (see
// utils/ai/ai-engine.ts:946) so we mirror that contract here.
//
// What this module does NOT do:
//   - No retry policy. The extension client is the orchestrator; if the
//     upstream returns 429/5xx we surface an error event and let the
//     extension decide whether to fall back to local loop.
//   - No prompt-template munging. Whatever messages the extension sends are
//     forwarded verbatim — the daemon is a transport layer for the LLM
//     loop, not a content rewriter.
//   - No tool execution. We surface tool_call events to the extension and
//     wait for the tool_result POST. Tool execution is extension-only by
//     design (wallet keys, DOM, chrome.storage all live there).
//
// Logging policy (audit doc P1-1 hard requirement): the assistant deltas,
// tool arguments, and tool results MUST NOT enter tracing logs. Only
// metadata — duration, token count, tool name, error code — is loggable.
use crate::types::{ChatMessage, ToolDefinition};
use anyhow::{anyhow, Result};
use bytes::Bytes;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const STREAM_BUFFER_LIMIT_BYTES: usize = 1_048_576; // 1 MiB hard ceiling per chunk

#[derive(Debug, Clone)]
pub struct LlmCallSpec {
    pub provider_url: String,
    pub api_secret: String,
    pub model: String,
    pub messages: Vec<Value>,
    pub tools: Vec<ToolDefinition>,
}

#[derive(Debug, Clone, Default)]
pub struct LlmStreamSnapshot {
    pub assistant_text: String,
    pub tool_calls: Vec<AggregatedToolCall>,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AggregatedToolCall {
    pub id: String,
    pub name: String,
    pub arguments_raw: String,
}

impl AggregatedToolCall {
    pub fn parsed_arguments(&self) -> Value {
        serde_json::from_str(&self.arguments_raw).unwrap_or(json!({}))
    }
}

/// Each callback receives the latest delta. The orchestrator turns these
/// into SSE events on the wire. The final snapshot is returned by
/// stream_chat_completion itself, so this enum doesn't need a Done variant.
#[derive(Debug, Clone)]
pub enum LlmStreamEvent {
    AssistantDelta(String),
    Usage(Value),
}

pub fn build_messages(
    system_prompt: &str,
    post_system_messages: &[ChatMessage],
    history: &[ChatMessage],
    prompt: &str,
) -> Vec<Value> {
    let mut out = Vec::with_capacity(history.len() + post_system_messages.len() + 2);
    out.push(json!({
        "role": "system",
        "content": system_prompt,
    }));
    for msg in post_system_messages {
        out.push(serialize_chat_message(msg));
    }
    for msg in history {
        out.push(serialize_chat_message(msg));
    }
    out.push(json!({
        "role": "user",
        "content": prompt,
    }));
    out
}

fn serialize_chat_message(msg: &ChatMessage) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("role".to_string(), json!(msg.role));
    obj.insert("content".to_string(), json!(msg.content));
    if let Some(tcid) = &msg.tool_call_id {
        obj.insert("tool_call_id".to_string(), json!(tcid));
    }
    if let Some(tcs) = &msg.tool_calls {
        obj.insert("tool_calls".to_string(), tcs.clone());
    }
    if let Some(name) = &msg.name {
        obj.insert("name".to_string(), json!(name));
    }
    Value::Object(obj)
}

pub fn build_tools_payload(defs: &[ToolDefinition]) -> Vec<Value> {
    defs.iter()
        .map(|def| {
            json!({
                "type": "function",
                "function": {
                    "name": def.function.name,
                    "description": def.function.description,
                    "parameters": def.function.parameters,
                }
            })
        })
        .collect()
}

pub fn endpoint_for_provider(provider_url: &str) -> String {
    let trimmed = provider_url.trim_end_matches('/');
    if trimmed.contains("/v1/") || trimmed.ends_with("/v1") {
        // Already includes a versioned path; let caller pre-shape if needed.
        format!("{}/chat/completions", trimmed.trim_end_matches('/'))
    } else {
        format!("{}/v1/proxy/chat/completions", trimmed)
    }
}

#[derive(Default)]
struct ToolCallAggregator {
    by_index: BTreeMap<usize, ToolCallSlot>,
}

#[derive(Default, Clone)]
struct ToolCallSlot {
    id: String,
    name: String,
    arguments: String,
}

impl ToolCallAggregator {
    fn observe(&mut self, index: usize, id: Option<&str>, name: Option<&str>, args_chunk: Option<&str>) {
        let slot = self.by_index.entry(index).or_default();
        if let Some(id) = id {
            if !id.is_empty() {
                slot.id = id.to_string();
            }
        }
        if let Some(name) = name {
            if !name.is_empty() {
                slot.name = name.to_string();
            }
        }
        if let Some(args) = args_chunk {
            slot.arguments.push_str(args);
        }
    }

    fn into_aggregated(self) -> Vec<AggregatedToolCall> {
        self.by_index
            .into_values()
            .filter(|slot| !slot.name.is_empty())
            .map(|slot| AggregatedToolCall {
                id: if slot.id.is_empty() {
                    format!("auto-{}", uuid::Uuid::new_v4())
                } else {
                    slot.id
                },
                name: slot.name,
                arguments_raw: if slot.arguments.is_empty() {
                    "{}".to_string()
                } else {
                    slot.arguments
                },
            })
            .collect()
    }
}

#[derive(Debug, Deserialize)]
struct ChatCompletionChunk {
    #[serde(default)]
    choices: Vec<ChunkChoice>,
    #[serde(default)]
    usage: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ChunkChoice {
    #[serde(default)]
    delta: Option<ChunkDelta>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChunkDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<DeltaToolCall>>,
}

#[derive(Debug, Deserialize)]
struct DeltaToolCall {
    #[serde(default)]
    index: Option<usize>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<DeltaToolCallFunction>,
}

#[derive(Debug, Deserialize)]
struct DeltaToolCallFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequestBody<'a> {
    model: &'a str,
    messages: &'a [Value],
    stream: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<&'a str>,
}

pub async fn stream_chat_completion<F>(
    client: &Client,
    spec: &LlmCallSpec,
    mut on_event: F,
) -> Result<LlmStreamSnapshot>
where
    F: FnMut(LlmStreamEvent),
{
    let endpoint = endpoint_for_provider(&spec.provider_url);
    let body = ChatCompletionRequestBody {
        model: &spec.model,
        messages: &spec.messages,
        stream: true,
        tools: build_tools_payload(&spec.tools),
        tool_choice: if spec.tools.is_empty() { None } else { Some("auto") },
    };

    let response = client
        .post(&endpoint)
        .bearer_auth(&spec.api_secret)
        .header("accept", "text/event-stream")
        .json(&body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response
            .text()
            .await
            .unwrap_or_else(|_| String::from("(no body)"));
        return Err(anyhow!(
            "Upstream LLM provider returned {} — {}",
            status,
            truncate_for_error(&body_text)
        ));
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut snapshot = LlmStreamSnapshot::default();
    let mut aggregator = ToolCallAggregator::default();

    while let Some(chunk_result) = stream.next().await {
        let chunk: Bytes = chunk_result?;
        if buffer.len() + chunk.len() > STREAM_BUFFER_LIMIT_BYTES {
            return Err(anyhow!(
                "Stream buffer exceeded {} bytes; aborting to avoid runaway memory.",
                STREAM_BUFFER_LIMIT_BYTES
            ));
        }
        buffer.extend_from_slice(&chunk);
        // SSE frames are separated by blank lines. Process complete frames
        // and keep the tail in the buffer.
        loop {
            let Some(boundary) = find_frame_boundary(&buffer) else { break };
            let frame = buffer.drain(..boundary).collect::<Vec<u8>>();
            // Drop the boundary itself.
            let drop_len = boundary_separator_len(&buffer);
            if drop_len > 0 {
                buffer.drain(..drop_len);
            }
            let frame_str = std::str::from_utf8(&frame).unwrap_or_default();
            for data in extract_data_lines(frame_str) {
                if data == "[DONE]" {
                    snapshot.tool_calls = aggregator.into_aggregated();
                    return Ok(snapshot);
                }
                let parsed: ChatCompletionChunk = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(usage) = parsed.usage {
                    on_event(LlmStreamEvent::Usage(usage));
                }
                for choice in parsed.choices {
                    if let Some(delta) = choice.delta {
                        if let Some(text) = delta.content {
                            if !text.is_empty() {
                                snapshot.assistant_text.push_str(&text);
                                on_event(LlmStreamEvent::AssistantDelta(text));
                            }
                        }
                        if let Some(tool_calls) = delta.tool_calls {
                            for entry in tool_calls {
                                let index = entry.index.unwrap_or(0);
                                let (name, args) = match entry.function {
                                    Some(f) => (f.name, f.arguments),
                                    None => (None, None),
                                };
                                aggregator.observe(
                                    index,
                                    entry.id.as_deref(),
                                    name.as_deref(),
                                    args.as_deref(),
                                );
                            }
                        }
                    }
                    if let Some(reason) = choice.finish_reason {
                        snapshot.finish_reason = Some(reason);
                    }
                }
            }
        }
    }

    snapshot.tool_calls = aggregator.into_aggregated();
    Ok(snapshot)
}

fn find_frame_boundary(buffer: &[u8]) -> Option<usize> {
    // Match LF-LF (Unix) or CRLF-CRLF (some intermediaries normalize this way).
    if let Some(pos) = find_subslice(buffer, b"\n\n") {
        return Some(pos);
    }
    if let Some(pos) = find_subslice(buffer, b"\r\n\r\n") {
        return Some(pos);
    }
    None
}

fn boundary_separator_len(buffer: &[u8]) -> usize {
    // Detect which boundary just got drained off and skip the separator.
    if buffer.starts_with(b"\n\n") {
        2
    } else if buffer.starts_with(b"\r\n\r\n") {
        4
    } else if buffer.starts_with(b"\n") {
        1
    } else {
        0
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn extract_data_lines(frame: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for raw in frame.split('\n') {
        let line = raw.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("data:") {
            out.push(rest.trim_start());
        }
    }
    out
}

fn truncate_for_error(text: &str) -> String {
    let max = 240;
    if text.len() <= max {
        text.to_string()
    } else {
        let cutoff = text.char_indices().nth(max).map(|(idx, _)| idx).unwrap_or(max);
        format!("{}…", &text[..cutoff])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_keeps_versioned_paths_intact() {
        assert_eq!(
            endpoint_for_provider("https://example.com/v1"),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint_for_provider("https://example.com/"),
            "https://example.com/v1/proxy/chat/completions"
        );
    }

    #[test]
    fn extract_data_lines_handles_crlf_and_comments() {
        let frame = "event: message\r\ndata: hello\r\ndata: world\r\n";
        let lines = extract_data_lines(frame);
        assert_eq!(lines, vec!["hello", "world"]);
    }

    #[test]
    fn aggregator_collapses_streamed_chunks() {
        let mut agg = ToolCallAggregator::default();
        agg.observe(0, Some("call_1"), Some("foo"), Some("{\"a\":"));
        agg.observe(0, None, None, Some("1}"));
        let collected = agg.into_aggregated();
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].id, "call_1");
        assert_eq!(collected[0].name, "foo");
        assert_eq!(collected[0].arguments_raw, "{\"a\":1}");
    }
}
