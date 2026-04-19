//! Companion Agent: hosts the LLM chat loop on behalf of the extension.
//!
//! Architectural rationale (see audit doc P1-1 in extension repo):
//!   - Chrome MV3 service workers get evicted after 5 minutes of inactivity.
//!     Long agent turns running in the SW silently die mid-stream.
//!   - The companion daemon is a long-lived native process. Hosting the LLM
//!     loop here lets a turn keep advancing even when the extension SW is
//!     suspended; the extension reconnects and resumes via the run_id.
//!   - Tool execution stays in the extension (wallet keys, DOM access,
//!     chrome.storage). Companion never sees private credentials. The only
//!     secret crossing the wire is the LLM provider api_secret, pushed
//!     per-turn and not persisted.
//!
//! Phase 1+2 scope (this PR):
//!   - SSE streaming endpoint
//!   - Tool reverse channel (extension executes, posts result back)
//!   - In-memory run state (no persistence yet)
//!   - 30-min hard cap (covers most long turns; full TTL tier system is
//!     phase 5)
//!
//! Phase 3+ scope (deferred):
//!   - Persistent run state (sled or SQLite) so daemon restarts can replay
//!   - Per-tier TTLs replacing the 30-min cap
//!   - Multi-turn batching for parallel tool calls
//!   - Reconnect-by-run_id handshake (today the extension only does
//!     fresh-stream-or-fallback)
mod handlers;
mod llm;
mod orchestrator;
mod persist;
mod store;
mod types;

pub use handlers::{agent_routes, AgentAuthFn, AgentRouterState, AgentState};
pub use persist::{AgentRunPersistence, PersistedAgentRun, PersistedRunResultSummary};
pub use store::{AgentRunStore, CreateRunMetadata};
pub use types::*;
