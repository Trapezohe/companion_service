use anyhow::{Context, Result};
use clap::{ArgAction, Parser, Subcommand};
use companion_config::{
    ensure_token, generate_token, get_config_dir, get_config_path, init_config, load_config,
    read_pid, save_config, CompanionConfig,
};
use companion_daemon::{probe_health, request_shutdown, serve_with_signals};
use companion_shared::{
    version_string, PermissionPolicy, FIXED_EXTENSION_ID, FIXED_EXTENSION_ORIGIN,
    PERMISSION_MODE_FULL, PERMISSION_MODE_WORKSPACE,
};
use serde_json::{json, Value};
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const NATIVE_HOST_NAMES: &[&str] = &["com.ghast.companion", "com.trapezohe.companion"];
const NATIVE_HOST_DESCRIPTION: &str =
    "GhastAI Companion — local runtime bridge for the Ghast browser extension";
#[cfg(target_os = "linux")]
const AUTOSTART_SERVICE_NAME: &str = "trapezohe-companion";
#[cfg(windows)]
const AUTOSTART_WIN_TASK_NAME: &str = "TrapezoheCompanion";

#[derive(Debug, Parser)]
#[command(name = "trapezohe-companion")]
#[command(about = "GhastAI Companion Rust CLI")]
struct Cli {
    #[command(subcommand)]
    command: CommandKind,
}

#[derive(Debug, Subcommand)]
enum CommandKind {
    Start {
        #[arg(short = 'd', long = "daemon")]
        daemon: bool,
    },
    Restart {
        #[arg(long)]
        force: bool,
    },
    Cleanup {
        #[arg(long, action = ArgAction::SetTrue)]
        json: bool,
    },
    Doctor {
        #[arg(long, action = ArgAction::SetTrue)]
        json: bool,
    },
    SelfCheck {
        #[arg(long, action = ArgAction::SetTrue)]
        json: bool,
    },
    Repair {
        action: Option<String>,
        #[arg(long, action = ArgAction::SetTrue)]
        json: bool,
        #[arg(long = "ext-id", hide = true, action = ArgAction::Append)]
        _ext_ids: Vec<String>,
        #[arg(long = "extension-id", hide = true, action = ArgAction::Append)]
        _extension_ids: Vec<String>,
    },
    Register {
        #[arg(long, action = ArgAction::SetTrue)]
        json: bool,
        #[arg(long, action = ArgAction::SetTrue)]
        quiet: bool,
        #[arg(long = "ext-id", hide = true, action = ArgAction::Append)]
        _ext_ids: Vec<String>,
        #[arg(long = "extension-id", hide = true, action = ArgAction::Append)]
        _extension_ids: Vec<String>,
    },
    Unregister {
        #[arg(long, action = ArgAction::SetTrue)]
        json: bool,
        #[arg(long, action = ArgAction::SetTrue)]
        quiet: bool,
    },
    Bootstrap {
        #[arg(long, action = ArgAction::SetTrue)]
        json: bool,
        #[arg(long = "no-autostart", action = ArgAction::SetTrue)]
        no_autostart: bool,
        #[arg(long = "no-start", action = ArgAction::SetTrue)]
        no_start: bool,
        #[arg(long, default_value = PERMISSION_MODE_WORKSPACE)]
        mode: String,
        #[arg(long = "workspace", action = ArgAction::Append)]
        workspace_roots: Vec<String>,
        #[arg(long = "ext-id", hide = true, action = ArgAction::Append)]
        _ext_ids: Vec<String>,
        #[arg(long = "extension-id", hide = true, action = ArgAction::Append)]
        _extension_ids: Vec<String>,
    },
    #[command(hide = true)]
    Daemon,
    #[command(hide = true)]
    NativeHost {
        #[arg(hide = true)]
        _origin: Option<String>,
    },
    Stop {
        #[arg(long)]
        force: bool,
    },
    Status,
    Config,
    Token,
    Init,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    match cli.command {
        CommandKind::Start { daemon } => start_command(daemon).await,
        CommandKind::Restart { force } => restart_command(force).await,
        CommandKind::Cleanup { json } => cleanup_command(json),
        CommandKind::Doctor { json } => doctor_command(json).await,
        CommandKind::SelfCheck { json } => self_check_command(json),
        CommandKind::Repair { action, json, .. } => {
            repair_command(action.as_deref().unwrap_or("repair_config"), json)
        }
        CommandKind::Register { json, quiet, .. } => register_command(json, quiet),
        CommandKind::Unregister { json, quiet } => unregister_command(json, quiet),
        CommandKind::Bootstrap {
            json,
            no_autostart,
            no_start,
            mode,
            workspace_roots,
            ..
        } => bootstrap_command(json, no_autostart, no_start, &mode, &workspace_roots).await,
        CommandKind::Daemon => daemon_command().await,
        CommandKind::NativeHost { .. } => native_host_command().await,
        CommandKind::Stop { force } => stop_command(force).await,
        CommandKind::Status => status_command().await,
        CommandKind::Config => {
            println!("{}", companion_config::get_config_path().display());
            Ok(())
        }
        CommandKind::Token => {
            let mut config = load_config()?;
            ensure_token(&mut config)?;
            println!("{}", config.token);
            Ok(())
        }
        CommandKind::Init => {
            let config = init_config()?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "ok": true,
                    "configPath": companion_config::get_config_path(),
                    "port": config.port,
                }))?
            );
            Ok(())
        }
    }
}

async fn start_command(daemon: bool) -> Result<()> {
    let mut config = load_config()?;
    ensure_token(&mut config)?;

    if probe_health(&config).await?.is_some() {
        println!(
            "Companion daemon is already running on 127.0.0.1:{}",
            config.port
        );
        return Ok(());
    }

    if daemon {
        spawn_detached_daemon()?;
        wait_for_ready(&config, Duration::from_secs(5)).await?;
        println!("Companion daemon started on 127.0.0.1:{}", config.port);
        return Ok(());
    }

    serve_with_signals(config).await
}

async fn restart_command(force: bool) -> Result<()> {
    let config = load_config()?;
    if probe_health(&config).await?.is_some() {
        if request_shutdown(&config).await? {
            wait_for_exit(Duration::from_secs(5)).await?;
        } else if force {
            force_kill_from_pid()?;
        } else {
            anyhow::bail!("Companion daemon is not responding. Retry with --force if needed.");
        }
    } else if read_pid()?.is_some() {
        if force {
            force_kill_from_pid()?;
        } else {
            let _ = companion_config::remove_pid();
        }
    }

    spawn_detached_daemon()?;
    wait_for_ready(&config, Duration::from_secs(5)).await?;
    println!("Companion daemon restarted on 127.0.0.1:{}", config.port);
    Ok(())
}

async fn doctor_command(json_mode: bool) -> Result<()> {
    let config = load_config()?;
    if probe_health(&config).await?.is_none() {
        let pid = read_pid()?;
        let payload = json!({
            "ok": false,
            "status": if pid.is_some() { "stale" } else { "stopped" },
            "pid": pid,
        });

        if json_mode {
            println!("{}", serde_json::to_string(&payload)?);
            return Ok(());
        }

        match pid {
            Some(pid) => {
                println!("[trapezohe-companion] Doctor: unknown (PID file points to {pid})");
            }
            None => {
                println!("[trapezohe-companion] Doctor: stopped");
            }
        }
        return Ok(());
    }

    let diagnostics = fetch_daemon_json(&config, "/api/system/diagnostics")
        .await?
        .unwrap_or_else(|| json!({ "ok": false, "status": "unreachable" }));

    if json_mode {
        println!("{}", serde_json::to_string(&diagnostics)?);
        return Ok(());
    }

    if diagnostics
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status == "unreachable")
    {
        println!("[trapezohe-companion] Doctor: unreachable");
        println!("  Failed to fetch /api/system/diagnostics from the running daemon.");
        return Ok(());
    }

    let doctor = diagnostics
        .get("doctor")
        .cloned()
        .unwrap_or_else(|| build_doctor_summary_from_diagnostics(&diagnostics));
    let summary = doctor.get("summary").cloned().unwrap_or_else(|| json!({}));

    println!(
        "[trapezohe-companion] Doctor: {}",
        doctor
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
    );
    println!(
        "  Pending approvals:   {}",
        summary
            .get("pendingApprovals")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    );
    println!(
        "  Recent failed runs:  {}",
        summary
            .get("recentFailedRuns")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    );
    println!(
        "  Running ACP:         {}",
        summary
            .get("runningAcpSessions")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    );
    println!(
        "  Stalled ACP:         {}",
        summary
            .get("stalledAcpSessions")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    );
    println!(
        "  Active workflows:    {}",
        summary
            .get("activeWorkflowRuns")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    );
    let browser_loaded = match summary.get("browserLoaded") {
        Some(Value::Bool(value)) => value.to_string(),
        _ => "unknown".to_string(),
    };
    println!("  Browser loaded:      {browser_loaded}");

    if let Some(issues) = doctor.get("issues").and_then(Value::as_array) {
        if !issues.is_empty() {
            println!("  Issues:");
            for issue in issues {
                let code = issue
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let message = issue
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown issue.");
                println!("    - {code}: {message}");
            }
        }
    }

    Ok(())
}

fn cleanup_command(json_mode: bool) -> Result<()> {
    let native_host = unregister_native_host(true)?;
    let autostart = remove_autostart()?;
    let payload = json!({
        "ok": true,
        "nativeHost": native_host,
        "autostart": autostart,
    });

    if json_mode {
        println!("{}", serde_json::to_string(&payload)?);
        return Ok(());
    }

    let removed = value_string_array(&native_host, "removed");
    println!("[trapezohe-companion] Local cleanup completed.");
    println!(
        "  Native host: {}",
        if removed.is_empty() {
            "nothing to remove"
        } else {
            "registration removed"
        }
    );
    println!(
        "  Auto-start:  {}",
        autostart
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
    );
    Ok(())
}

fn self_check_command(json_mode: bool) -> Result<()> {
    let payload = build_self_check_payload()?;
    if json_mode {
        println!("{}", serde_json::to_string(&payload)?);
        return Ok(());
    }

    println!(
        "[trapezohe-companion] Self-check: {}",
        if payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            "ok"
        } else {
            "needs attention"
        }
    );
    println!(
        "  Config:      {} ({})",
        if payload
            .pointer("/checks/configReadable/ok")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "ok"
        } else {
            "missing"
        },
        payload
            .pointer("/checks/configReadable/path")
            .and_then(Value::as_str)
            .unwrap_or("n/a")
    );
    println!(
        "  Token:       {}",
        if payload
            .pointer("/checks/tokenPresent/ok")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "present"
        } else {
            "missing"
        }
    );
    println!(
        "  Policy:      {} ({})",
        if payload
            .pointer("/checks/workspacePolicy/ok")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "ok"
        } else {
            "invalid"
        },
        payload
            .pointer("/checks/workspacePolicy/mode")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
    );
    println!(
        "  Native host: {}",
        if payload
            .pointer("/checks/nativeHostRegistration/ok")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "registered"
        } else {
            "missing"
        }
    );
    if let Some(actions) = payload.get("repairActions").and_then(Value::as_array) {
        if !actions.is_empty() {
            println!("  Repairs:");
            for action in actions {
                let id = action
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let description = action
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("No description.");
                println!("    - {id}: {description}");
            }
        }
    }
    Ok(())
}

fn repair_command(action: &str, json_mode: bool) -> Result<()> {
    let action = action.trim();
    if action.is_empty() {
        anyhow::bail!("Repair action is required.");
    }

    let result = match action {
        "repair_config" => repair_config_defaults()?,
        "register_native_host" => register_native_host(true)?,
        _ => anyhow::bail!("Unsupported repair action. Use: repair_config | register_native_host"),
    };
    let self_check = build_self_check_payload()?;
    let payload = json!({
        "ok": true,
        "action": action,
        "result": result,
        "selfCheck": self_check,
    });

    if json_mode {
        println!("{}", serde_json::to_string(&payload)?);
        return Ok(());
    }

    match action {
        "repair_config" => {
            println!("[trapezohe-companion] Config defaults repaired.");
            println!(
                "  Path:        {}",
                result
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            );
            println!(
                "  MCP servers: {}",
                result
                    .get("mcpServerCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            );
            println!(
                "  Token:       {}",
                if result
                    .get("generatedToken")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    "generated"
                } else {
                    "preserved"
                }
            );
        }
        "register_native_host" => {
            println!("[trapezohe-companion] Native host registration repaired.");
            println!(
                "  Hosts:       {}",
                value_string_array(&result, "hostNames").join(", ")
            );
            println!(
                "  Origins:     {}",
                value_string_array(&result, "allowedOrigins").join(", ")
            );
        }
        _ => {}
    }

    Ok(())
}

fn register_command(json_mode: bool, quiet: bool) -> Result<()> {
    let result = register_native_host(quiet)?;
    if json_mode {
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }

    if quiet {
        return Ok(());
    }

    let manifest_paths = value_string_array(&result, "manifestPaths");
    let host_names = value_string_array(&result, "hostNames");
    let allowed_origins = value_string_array(&result, "allowedOrigins");
    let native_host_script = result
        .get("nativeHostScript")
        .and_then(Value::as_str)
        .unwrap_or("");

    println!("[trapezohe-companion] Native messaging host registered.");
    println!("  Hosts:    {}", host_names.join(", "));
    println!("  Manifests ({}):", manifest_paths.len());
    for manifest_path in &manifest_paths {
        println!("    - {manifest_path}");
    }
    println!("  Host:     {native_host_script}");
    println!("  Origins:  {}", allowed_origins.join(", "));
    println!();
    println!("  Restart Chrome for changes to take effect.");
    Ok(())
}

fn unregister_command(json_mode: bool, quiet: bool) -> Result<()> {
    let result = unregister_native_host(quiet)?;
    if json_mode {
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }

    if quiet {
        return Ok(());
    }

    let removed = value_string_array(&result, "removed");
    if removed.is_empty() {
        println!("[trapezohe-companion] No native messaging host registration found.");
        return Ok(());
    }

    println!("[trapezohe-companion] Native messaging host unregistered.");
    for manifest_path in removed {
        println!("  Removed: {manifest_path}");
    }
    Ok(())
}

async fn bootstrap_command(
    json_mode: bool,
    disable_autostart: bool,
    disable_start: bool,
    mode: &str,
    workspace_roots: &[String],
) -> Result<()> {
    let result =
        bootstrap_companion(disable_autostart, disable_start, mode, workspace_roots).await?;

    if json_mode {
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }

    println!("[trapezohe-companion] Bootstrap complete.");
    println!(
        "  Config:      {}",
        result
            .get("configPath")
            .and_then(Value::as_str)
            .unwrap_or_default()
    );
    println!(
        "  Mode:        {}",
        result
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or_default()
    );

    let output_mode = result
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if output_mode == PERMISSION_MODE_WORKSPACE {
        let workspace_roots = value_string_array(&result, "workspaceRoots");
        println!("  Workspace:   {}", workspace_roots.join(", "));
    }

    let native_host_registered = result
        .get("nativeHostRegistered")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if native_host_registered {
        let extension_ids = value_string_array(&result, "extensionIds");
        println!("  Native host: registered ({})", extension_ids.join(", "));
    } else {
        let reason = result
            .get("nativeHost")
            .and_then(|value| value.get("reason"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        println!("  Native host: skipped ({reason})");
    }

    let autostart_ok = result
        .get("autostart")
        .and_then(|value| value.get("ok"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let autostart_strategy = result
        .get("autostart")
        .and_then(|value| value.get("strategy"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if autostart_ok {
        println!("  Auto-start:  enabled ({autostart_strategy})");
    } else {
        println!("  Auto-start:  {autostart_strategy}");
    }

    let daemon_ok = result
        .get("daemon")
        .and_then(|value| value.get("ok"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let daemon_message = result
        .get("daemon")
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if daemon_ok {
        println!("  Daemon:      running");
    } else {
        println!("  Daemon:      not started ({daemon_message})");
    }
    Ok(())
}

async fn daemon_command() -> Result<()> {
    let mut config = load_config()?;
    ensure_token(&mut config)?;
    serve_with_signals(config).await
}

async fn native_host_command() -> Result<()> {
    let request = match read_native_host_message(&mut std::io::stdin().lock()) {
        Ok(Some(request)) => request,
        Ok(None) => return Ok(()),
        Err(error) => {
            write_native_host_message(
                &mut std::io::stdout().lock(),
                &json!({
                    "error": error.to_string(),
                }),
            )?;
            return Ok(());
        }
    };
    let response = native_host_handle_request(&request).await;
    let payload = match response {
        Ok(value) => value,
        Err(error) => json!({
            "error": error.to_string(),
        }),
    };
    write_native_host_message(&mut std::io::stdout().lock(), &payload)?;
    Ok(())
}

async fn stop_command(force: bool) -> Result<()> {
    let config = load_config()?;
    if request_shutdown(&config).await? {
        wait_for_exit(Duration::from_secs(5)).await?;
        println!("Companion daemon stopped.");
        return Ok(());
    }

    if force {
        force_kill_from_pid()?;
        println!("Companion daemon force stopped.");
        return Ok(());
    }

    anyhow::bail!("Companion daemon is not responding. Retry with --force if needed.");
}

async fn status_command() -> Result<()> {
    let config = load_config()?;
    if let Some(health) = probe_health(&config).await? {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "state": "running",
                "pid": health.pid,
                "port": config.port,
                "version": health.version,
                "protocolVersion": health.protocol_version,
            }))?
        );
        return Ok(());
    }

    let pid = read_pid()?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "state": if pid.is_some() { "stale" } else { "stopped" },
            "pid": pid,
            "port": config.port,
        }))?
    );
    Ok(())
}

async fn fetch_daemon_json(config: &CompanionConfig, path: &str) -> Result<Option<Value>> {
    let token = config.token.trim();
    if token.is_empty() {
        return Ok(None);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;
    let response = client
        .get(format!("http://127.0.0.1:{}{path}", config.port))
        .bearer_auth(token)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(_) => return Ok(None),
    };

    if !response.status().is_success() {
        return Ok(None);
    }

    Ok(Some(response.json::<Value>().await?))
}

fn build_self_check_payload() -> Result<Value> {
    let config = load_config().unwrap_or_default();
    let native_host_registration = native_host_registration_payload()?;
    let mcp_executables = config
        .mcp_servers
        .iter()
        .map(|(name, server_config)| {
            json!({
                "name": name,
                "command": server_config.command,
                "ok": command_resolves_on_path(&server_config.command),
            })
        })
        .collect::<Vec<_>>();

    let checks = json!({
        "configReadable": {
            "ok": get_config_path().exists(),
            "path": get_config_path().display().to_string(),
        },
        "tokenPresent": {
            "ok": !config.token.trim().is_empty(),
        },
        "workspacePolicy": {
            "ok": config.permission_policy.mode != PERMISSION_MODE_WORKSPACE
                || config
                    .permission_policy
                    .workspace_roots
                    .iter()
                    .all(|root| !root.trim().is_empty()),
            "mode": config.permission_policy.mode,
            "workspaceRoots": config.permission_policy.workspace_roots,
        },
        "nativeHostRegistration": native_host_registration,
        "mcpExecutables": mcp_executables,
    });

    let workspace_ok = checks
        .pointer("/workspacePolicy/ok")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let config_ok = checks
        .pointer("/configReadable/ok")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let token_ok = checks
        .pointer("/tokenPresent/ok")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let native_host_required = checks
        .pointer("/nativeHostRegistration/required")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let native_host_ok = checks
        .pointer("/nativeHostRegistration/ok")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mcp_all_ok = checks
        .get("mcpExecutables")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .all(|item| item.get("ok").and_then(Value::as_bool).unwrap_or(false))
        })
        .unwrap_or(true);

    let mut repair_actions = Vec::new();
    if !config_ok || !token_ok || !workspace_ok {
        repair_actions.push(json!({
            "id": "repair_config",
            "title": "Repair config defaults",
            "description": "Rewrite missing config defaults while preserving MCP servers and extension ids where possible.",
        }));
    }
    if native_host_required && !native_host_ok {
        repair_actions.push(json!({
            "id": "register_native_host",
            "title": "Re-register native host",
            "description": "Restore Chrome native messaging registration for the fixed Ghast extension id.",
        }));
    }

    Ok(json!({
        "ok": config_ok && token_ok && workspace_ok && (!native_host_required || native_host_ok) && mcp_all_ok,
        "checks": checks,
        "repairActions": repair_actions,
    }))
}

fn repair_config_defaults() -> Result<Value> {
    let mut config = load_config().unwrap_or_default();
    let generated_token = config.token.trim().is_empty();
    if generated_token {
        config.token = generate_token();
    }
    save_config(&config)?;
    Ok(json!({
        "ok": true,
        "path": get_config_path().display().to_string(),
        "token": config.token,
        "generatedToken": generated_token,
        "mcpServerCount": config.mcp_servers.len(),
        "extensionIds": config.extension_ids,
    }))
}

fn native_host_registration_payload() -> Result<Value> {
    let manifest_targets = native_host_manifest_targets()?;
    let mut manifests = Vec::new();
    let mut missing_manifests = Vec::new();
    for target in &manifest_targets {
        let manifest_path = target.manifest_path.display().to_string();
        if target.manifest_path.exists() {
            manifests.push(manifest_path);
        } else {
            missing_manifests.push(manifest_path);
        }
    }

    let required = true;
    Ok(json!({
        "ok": !manifests.is_empty() && (!required || missing_manifests.is_empty()),
        "required": required,
        "repairable": required,
        "extensionIds": fixed_extension_ids(),
        "hostNames": NATIVE_HOST_NAMES,
        "expectedManifests": manifest_targets
            .iter()
            .map(|target| target.manifest_path.display().to_string())
            .collect::<Vec<_>>(),
        "manifests": manifests,
        "missingManifests": missing_manifests,
    }))
}

fn build_doctor_summary_from_diagnostics(diagnostics: &Value) -> Value {
    let pending_approvals = diagnostics
        .pointer("/approvals/pending")
        .and_then(Value::as_array)
        .map(|items| items.len() as u64)
        .unwrap_or(0);
    let recent_failed_runs = diagnostics
        .pointer("/runs/recentFailed")
        .and_then(Value::as_array)
        .map(|items| items.len() as u64)
        .unwrap_or(0);
    let running_acp_sessions = diagnostics
        .pointer("/acp/runningSessions")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let stalled_acp_sessions = diagnostics
        .pointer("/acp/stallSummary/totalStalledSessions")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let active_workflow_runs = diagnostics
        .pointer("/automation/activeWorkflowRuns")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let browser_loaded = diagnostics
        .pointer("/browser/loaded")
        .and_then(Value::as_bool)
        .map(Value::Bool)
        .unwrap_or(Value::Null);

    let mut issues = Vec::new();
    if pending_approvals > 0 {
        issues.push(json!({
            "code": "pending_approvals",
            "severity": "warn",
            "message": "There are pending approvals waiting for user action.",
        }));
    }
    if recent_failed_runs > 0 {
        issues.push(json!({
            "code": "recent_failed_runs",
            "severity": "warn",
            "message": "Recent companion runs have failed.",
        }));
    }
    if stalled_acp_sessions > 0 {
        issues.push(json!({
            "code": "stalled_acp_sessions",
            "severity": "warn",
            "message": "One or more ACP sessions appear stalled.",
        }));
    }
    if browser_loaded == Value::Bool(false) {
        issues.push(json!({
            "code": "browser_not_loaded",
            "severity": "warn",
            "message": "Browser runtime support is enabled but not loaded.",
        }));
    }

    json!({
        "status": if issues.is_empty() { "ok" } else { "needs_attention" },
        "summary": {
            "pendingApprovals": pending_approvals,
            "recentFailedRuns": recent_failed_runs,
            "runningAcpSessions": running_acp_sessions,
            "stalledAcpSessions": stalled_acp_sessions,
            "activeWorkflowRuns": active_workflow_runs,
            "browserLoaded": browser_loaded,
        },
        "issues": issues,
    })
}

fn command_resolves_on_path(command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return false;
    }

    let command_path = Path::new(trimmed);
    if command_path.is_absolute() || trimmed.contains(std::path::MAIN_SEPARATOR) {
        return command_path.exists();
    }

    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };

    for directory in std::env::split_paths(&path_var) {
        let candidate = directory.join(trimmed);
        if candidate.exists() {
            return true;
        }

        #[cfg(windows)]
        {
            let pathext =
                std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
            for extension in pathext.split(';') {
                let extension = extension.trim();
                if extension.is_empty() {
                    continue;
                }
                let candidate = directory.join(format!("{trimmed}{extension}"));
                if candidate.exists() {
                    return true;
                }
            }
        }
    }

    false
}

fn register_native_host(quiet: bool) -> Result<Value> {
    #[cfg(not(windows))]
    let _ = quiet;

    let launcher_path = resolve_native_host_launcher()?;
    let allowed_origins = vec![format!("{FIXED_EXTENSION_ORIGIN}/")];
    let manifest_targets = native_host_manifest_targets()?;
    let manifest_paths = manifest_targets
        .iter()
        .map(|target| target.manifest_path.display().to_string())
        .collect::<Vec<_>>();

    for target in &manifest_targets {
        if let Some(parent) = target.manifest_path.parent().map(Path::to_path_buf) {
            fs::create_dir_all(&parent).with_context(|| {
                format!(
                    "Failed to create native host manifest dir: {}",
                    parent.display()
                )
            })?;
        }
        let manifest = json!({
            "name": target.host_name,
            "description": NATIVE_HOST_DESCRIPTION,
            "path": launcher_path.display().to_string(),
            "type": "stdio",
            "allowed_origins": allowed_origins,
        });
        fs::write(
            &target.manifest_path,
            serde_json::to_string_pretty(&manifest)? + "\n",
        )
        .with_context(|| {
            format!(
                "Failed to write native host manifest: {}",
                target.manifest_path.display()
            )
        })?;
    }

    #[cfg(windows)]
    {
        for host_name in NATIVE_HOST_NAMES {
            let manifest_path = manifest_targets
                .iter()
                .find(|target| target.host_name == *host_name)
                .map(|target| target.manifest_path.display().to_string())
                .unwrap_or_default();
            let reg_key =
                format!("HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\{host_name}");
            let status = Command::new("reg")
                .args([
                    "add",
                    &reg_key,
                    "/ve",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &manifest_path,
                    "/f",
                ])
                .status();
            match status {
                Ok(status) if status.success() => {}
                Ok(status) if !quiet => {
                    eprintln!(
                        "[trapezohe-companion] Warning: failed to register Windows registry key {reg_key}: {status}"
                    );
                }
                Err(error) if !quiet => {
                    eprintln!(
                        "[trapezohe-companion] Warning: failed to register Windows registry key {reg_key}: {error}"
                    );
                }
                _ => {}
            }
        }
    }

    let mut config = load_config()?;
    let fixed_ids = fixed_extension_ids();
    if config.extension_ids != fixed_ids {
        config.extension_ids = fixed_ids.clone();
        save_config(&config)?;
    }

    Ok(json!({
        "manifestPaths": manifest_paths,
        "nativeHostScript": launcher_path.display().to_string(),
        "allowedOrigins": allowed_origins,
        "extensionIds": fixed_ids,
        "hostNames": NATIVE_HOST_NAMES,
    }))
}

fn unregister_native_host(quiet: bool) -> Result<Value> {
    #[cfg(not(windows))]
    let _ = quiet;

    let targets = native_host_manifest_targets()?;
    let mut removed = Vec::new();
    for target in targets {
        match fs::remove_file(&target.manifest_path) {
            Ok(()) => removed.push(target.manifest_path.display().to_string()),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "Failed to remove native host manifest: {}",
                        target.manifest_path.display()
                    )
                })
            }
        }
    }

    #[cfg(windows)]
    {
        for host_name in NATIVE_HOST_NAMES {
            let reg_key =
                format!("HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\{host_name}");
            let status = Command::new("reg")
                .args(["delete", &reg_key, "/f"])
                .status();
            match status {
                Ok(status) if status.success() => {}
                Ok(_status) => {}
                Err(error) if !quiet => {
                    eprintln!(
                        "[trapezohe-companion] Warning: failed to remove Windows registry key {reg_key}: {error}"
                    );
                }
                _ => {}
            }
        }
    }

    Ok(json!({ "removed": removed }))
}

async fn bootstrap_companion(
    disable_autostart: bool,
    disable_start: bool,
    mode: &str,
    workspace_roots: &[String],
) -> Result<Value> {
    let normalized_mode = normalize_bootstrap_mode(mode);
    let resolved_workspace_roots =
        resolve_bootstrap_workspace_roots(normalized_mode, workspace_roots)?;

    if normalized_mode == PERMISSION_MODE_WORKSPACE {
        for root in &resolved_workspace_roots {
            let target = expand_tilde_path(root);
            fs::create_dir_all(&target)
                .with_context(|| format!("Failed to create workspace dir: {}", target.display()))?;
        }
    }

    let created_config = !get_config_path().exists();
    let _ = init_config()?;

    let mut config = load_config()?;
    ensure_token(&mut config)?;
    config.permission_policy = PermissionPolicy {
        mode: normalized_mode.to_string(),
        workspace_roots: resolved_workspace_roots,
        policy_reason: String::new(),
    };
    config.extension_ids = fixed_extension_ids();
    save_config(&config)?;

    let config = load_config()?;
    let register_result = register_native_host(true)?;
    let registered_extension_ids = value_string_array(&register_result, "extensionIds");

    let native_host_result = if registered_extension_ids.is_empty() {
        json!({
            "status": "skipped",
            "reason": "missing_extension_id",
            "extensionIds": [],
        })
    } else {
        json!({
            "status": "registered",
            "reason": Value::Null,
            "extensionIds": registered_extension_ids,
        })
    };

    let autostart_result = if disable_autostart {
        json!({
            "ok": false,
            "strategy": "disabled",
            "target": "",
        })
    } else {
        install_autostart()?
    };

    let daemon_result = if disable_start {
        json!({
            "ok": false,
            "message": "skipped",
        })
    } else {
        match start_daemon_for_bootstrap().await {
            Ok(()) => json!({
                "ok": true,
                "message": "started",
            }),
            Err(error) => json!({
                "ok": false,
                "message": error.to_string(),
            }),
        }
    };

    Ok(json!({
        "ok": true,
        "createdConfig": created_config,
        "configPath": get_config_path().display().to_string(),
        "token": config.token,
        "mode": config.permission_policy.mode,
        "workspaceRoots": config.permission_policy.workspace_roots,
        "nativeHostRegistered": !value_string_array(&native_host_result, "extensionIds").is_empty(),
        "extensionIds": value_string_array(&native_host_result, "extensionIds"),
        "nativeHost": native_host_result,
        "autostart": autostart_result,
        "daemon": daemon_result,
    }))
}

fn install_autostart() -> Result<Value> {
    let launch_spec = resolve_cli_launch_spec()?;
    let config_dir = get_config_dir();
    let stdout_log = config_dir.join("companion.log");
    let stderr_log = config_dir.join("companion.error.log");

    #[cfg(target_os = "macos")]
    {
        let home = home_dir()?;
        let plist_dir = home.join("Library").join("LaunchAgents");
        let plist_path = plist_dir.join("ai.trapezohe.companion.plist");
        fs::create_dir_all(&plist_dir)
            .with_context(|| format!("Failed to create {}", plist_dir.display()))?;

        let mut arguments = String::new();
        for argument in &launch_spec.args {
            arguments.push_str(&format!("  <string>{argument}</string>\n"));
        }

        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.trapezohe.companion</string>
  <key>ProgramArguments</key>
  <array>
    <string>{program}</string>
{arguments}  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{stdout_log}</string>
  <key>StandardErrorPath</key>
  <string>{stderr_log}</string>
</dict>
</plist>
"#,
            program = launch_spec.program.display(),
            arguments = arguments,
            stdout_log = stdout_log.display(),
            stderr_log = stderr_log.display(),
        );
        fs::write(&plist_path, plist)
            .with_context(|| format!("Failed to write {}", plist_path.display()))?;
        let _ = Command::new("launchctl")
            .arg("unload")
            .arg(&plist_path)
            .status();
        let _ = Command::new("launchctl")
            .arg("load")
            .arg(&plist_path)
            .status();
        return Ok(json!({
            "ok": true,
            "strategy": "launchd",
            "target": plist_path.display().to_string(),
        }));
    }

    #[cfg(target_os = "linux")]
    {
        let home = home_dir()?;
        let service_dir = home.join(".config").join("systemd").join("user");
        let service_path = service_dir.join(format!("{AUTOSTART_SERVICE_NAME}.service"));
        fs::create_dir_all(&service_dir)
            .with_context(|| format!("Failed to create {}", service_dir.display()))?;
        let command = std::iter::once(shell_quote_path(&launch_spec.program))
            .chain(launch_spec.args.iter().map(|arg| shell_quote(arg)))
            .collect::<Vec<_>>()
            .join(" ");
        let service = format!(
            "[Unit]\nDescription=GhastAI Companion - Local MCP Server Host\nAfter=network.target\n\n[Service]\nExecStart={command}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n"
        );
        fs::write(&service_path, service)
            .with_context(|| format!("Failed to write {}", service_path.display()))?;
        let _ = Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .status();
        let _ = Command::new("systemctl")
            .args([
                "--user",
                "enable",
                &format!("{AUTOSTART_SERVICE_NAME}.service"),
            ])
            .status();
        let _ = Command::new("systemctl")
            .args([
                "--user",
                "restart",
                &format!("{AUTOSTART_SERVICE_NAME}.service"),
            ])
            .status();
        return Ok(json!({
            "ok": true,
            "strategy": "systemd",
            "target": service_path.display().to_string(),
        }));
    }

    #[cfg(windows)]
    {
        let task_command = format!("\"{}\" start", launch_spec.program.display());
        let status = Command::new("schtasks")
            .args([
                "/Create",
                "/TN",
                AUTOSTART_WIN_TASK_NAME,
                "/SC",
                "ONLOGON",
                "/TR",
                &task_command,
                "/F",
            ])
            .status()
            .context("Failed to register Windows scheduled task")?;
        if !status.success() {
            anyhow::bail!("schtasks exited with status {status}");
        }
        let _ = Command::new("schtasks")
            .args(["/Run", "/TN", AUTOSTART_WIN_TASK_NAME])
            .status();
        return Ok(json!({
            "ok": true,
            "strategy": "schtasks",
            "target": AUTOSTART_WIN_TASK_NAME,
        }));
    }

    #[allow(unreachable_code)]
    Ok(json!({
        "ok": false,
        "strategy": "unsupported",
        "target": std::env::consts::OS,
    }))
}

fn remove_autostart() -> Result<Value> {
    #[cfg(target_os = "macos")]
    {
        let home = home_dir()?;
        let plist_path = home
            .join("Library")
            .join("LaunchAgents")
            .join("ai.trapezohe.companion.plist");
        let _ = Command::new("launchctl")
            .arg("unload")
            .arg(&plist_path)
            .status();
        let existed = plist_path.exists();
        if existed {
            let _ = fs::remove_file(&plist_path);
        }
        return Ok(json!({
            "ok": true,
            "strategy": "launchd",
            "target": plist_path.display().to_string(),
            "status": if existed { "removed" } else { "missing" },
        }));
    }

    #[cfg(target_os = "linux")]
    {
        let home = home_dir()?;
        let service_name = format!("{AUTOSTART_SERVICE_NAME}.service");
        let service_path = home
            .join(".config")
            .join("systemd")
            .join("user")
            .join(&service_name);
        let _ = Command::new("systemctl")
            .args(["--user", "disable", &service_name])
            .status();
        let _ = Command::new("systemctl")
            .args(["--user", "stop", &service_name])
            .status();
        let existed = service_path.exists();
        if existed {
            let _ = fs::remove_file(&service_path);
        }
        return Ok(json!({
            "ok": true,
            "strategy": "systemd",
            "target": service_path.display().to_string(),
            "status": if existed { "removed" } else { "missing" },
        }));
    }

    #[cfg(windows)]
    {
        let status = Command::new("schtasks")
            .args(["/Delete", "/TN", AUTOSTART_WIN_TASK_NAME, "/F"])
            .status();
        let removed = matches!(status, Ok(result) if result.success());
        return Ok(json!({
            "ok": true,
            "strategy": "schtasks",
            "target": AUTOSTART_WIN_TASK_NAME,
            "status": if removed { "removed" } else { "missing" },
        }));
    }

    #[allow(unreachable_code)]
    Ok(json!({
        "ok": false,
        "strategy": "unsupported",
        "target": std::env::consts::OS,
        "status": "unsupported",
    }))
}

async fn start_daemon_for_bootstrap() -> Result<()> {
    let mut config = load_config()?;
    ensure_token(&mut config)?;
    if probe_health(&config).await?.is_some() {
        return Ok(());
    }
    spawn_detached_daemon()
}

fn fixed_extension_ids() -> Vec<String> {
    vec![FIXED_EXTENSION_ID.to_string()]
}

fn normalize_bootstrap_mode(mode: &str) -> &'static str {
    match mode.trim().to_lowercase().as_str() {
        PERMISSION_MODE_FULL => PERMISSION_MODE_FULL,
        _ => PERMISSION_MODE_WORKSPACE,
    }
}

fn resolve_bootstrap_workspace_roots(
    mode: &str,
    workspace_roots: &[String],
) -> Result<Vec<String>> {
    if mode != PERMISSION_MODE_WORKSPACE {
        return Ok(Vec::new());
    }

    let roots = if workspace_roots.is_empty() {
        vec![home_dir()?
            .join("trapezohe-workspace")
            .display()
            .to_string()]
    } else {
        workspace_roots
            .iter()
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
    };

    Ok(roots)
}

fn spawn_detached_daemon() -> Result<()> {
    let current_exe = std::env::current_exe().context("Failed to resolve current executable")?;
    let mut command = Command::new(current_exe);
    command.arg("daemon");
    command.stdin(Stdio::null());
    command.stdout(Stdio::null());
    command.stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
    }

    command.spawn().context("Failed to spawn detached daemon")?;
    Ok(())
}

async fn wait_for_ready(config: &CompanionConfig, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if probe_health(config).await?.is_some() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            anyhow::bail!("Timed out waiting for the companion daemon to become ready");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn wait_for_exit(timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let pid = read_pid()?;
        if pid.is_none() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            anyhow::bail!("Timed out waiting for the companion daemon to stop");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn force_kill_from_pid() -> Result<()> {
    let Some(pid) = read_pid()? else {
        return Ok(());
    };

    #[cfg(unix)]
    {
        let status = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .context("Failed to invoke kill")?;
        if !status.success() {
            anyhow::bail!("kill exited with status {}", status);
        }
    }

    #[cfg(windows)]
    {
        let status = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .status()
            .context("Failed to invoke taskkill")?;
        if !status.success() {
            anyhow::bail!("taskkill exited with status {}", status);
        }
    }

    let _ = companion_config::remove_pid();
    Ok(())
}

fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_target(false)
        .compact()
        .try_init();
}

async fn native_host_handle_request(request: &Value) -> Result<Value> {
    let Some(request_type) = request
        .as_object()
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(json!({ "error": "Invalid request" }));
    };

    match request_type {
        "ping" => Ok(json!({
            "ok": true,
            "version": version_string(),
        })),
        "get_config" => native_host_config_response(),
        "start" => native_host_start_response().await,
        other => Ok(json!({
            "error": format!("Unknown request type: {other}"),
        })),
    }
}

fn native_host_config_response() -> Result<Value> {
    if !get_config_path().exists() {
        return Ok(json!({
            "error": "Companion config not found. Run \"trapezohe-companion init\" first.",
        }));
    }

    let config = load_config()?;
    if config.token.trim().is_empty() {
        return Ok(json!({
            "error": "No token configured. Run \"trapezohe-companion init\" first.",
        }));
    }

    Ok(config_payload(&config))
}

async fn native_host_start_response() -> Result<Value> {
    if !get_config_path().exists() {
        return Ok(json!({
            "error": "Companion config not found. Run \"trapezohe-companion init\" first.",
        }));
    }

    let config = load_config()?;
    if config.token.trim().is_empty() {
        return Ok(json!({
            "error": "No token configured. Run \"trapezohe-companion init\" first.",
        }));
    }

    if probe_health(&config).await?.is_some() {
        return Ok(json!({
            "url": companion_url(&config),
            "token": config.token,
            "version": version_string(),
            "started": false,
            "already_running": true,
        }));
    }

    if spawn_detached_daemon().is_err() {
        return Ok(json!({
            "url": companion_url(&config),
            "token": config.token,
            "version": version_string(),
            "started": false,
            "error": "Failed to start companion daemon",
        }));
    }

    let ready = wait_for_ready(&config, Duration::from_secs(3))
        .await
        .is_ok();
    Ok(json!({
        "url": companion_url(&config),
        "token": config.token,
        "version": version_string(),
        "started": true,
        "ready": ready,
    }))
}

fn companion_url(config: &CompanionConfig) -> String {
    format!("http://127.0.0.1:{}", config.port)
}

fn config_payload(config: &CompanionConfig) -> Value {
    json!({
        "url": companion_url(config),
        "token": config.token,
        "version": version_string(),
    })
}

fn resolve_native_host_launcher() -> Result<PathBuf> {
    let current_exe = std::env::current_exe().context("Failed to resolve current executable")?;
    let config_dir = get_config_dir();
    let bin_dir = config_dir.join("bin");
    fs::create_dir_all(&bin_dir)
        .with_context(|| format!("Failed to create {}", bin_dir.display()))?;

    #[cfg(windows)]
    let staged_cli_path = bin_dir.join("trapezohe-companion.exe");
    #[cfg(not(windows))]
    let staged_cli_path = bin_dir.join("trapezohe-companion");

    let command_path = if is_bundled_macos_cli(&current_exe) {
        current_exe
    } else {
        copy_cli_binary_if_needed(&current_exe, &staged_cli_path)?;
        staged_cli_path
    };

    #[cfg(windows)]
    {
        let launcher_path = config_dir.join("native-host-launcher.cmd");
        let contents = format!(
            "@echo off\r\n\"{}\" native-host %*\r\n",
            command_path.display()
        );
        fs::write(&launcher_path, contents)
            .with_context(|| format!("Failed to write {}", launcher_path.display()))?;
        return Ok(launcher_path);
    }

    #[cfg(not(windows))]
    {
        let launcher_path = config_dir.join("native-host-launcher.sh");
        let contents = format!(
            "#!/bin/sh\nexec \"{}\" native-host \"$@\"\n",
            command_path.display()
        );
        fs::write(&launcher_path, contents)
            .with_context(|| format!("Failed to write {}", launcher_path.display()))?;
        set_executable(&launcher_path)?;
        Ok(launcher_path)
    }
}

fn copy_cli_binary_if_needed(source: &Path, target: &Path) -> Result<()> {
    if paths_match(source, target) {
        if target.exists() {
            set_executable(target)?;
            return Ok(());
        }
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create {}", parent.display()))?;
    }
    fs::copy(source, target).with_context(|| {
        format!(
            "Failed to stage Rust CLI from {} to {}",
            source.display(),
            target.display()
        )
    })?;
    set_executable(target)?;
    Ok(())
}

fn paths_match(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn native_host_manifest_targets() -> Result<Vec<ManifestTarget>> {
    let mut targets = Vec::new();
    for host_name in NATIVE_HOST_NAMES {
        for dir in native_host_manifest_dirs()? {
            targets.push(ManifestTarget {
                host_name,
                manifest_path: dir.join(format!("{host_name}.json")),
            });
        }
    }
    Ok(targets)
}

fn native_host_manifest_dirs() -> Result<Vec<PathBuf>> {
    let home = home_dir()?;

    #[cfg(target_os = "macos")]
    {
        return Ok(vec![
            home.join("Library")
                .join("Application Support")
                .join("Google")
                .join("Chrome")
                .join("NativeMessagingHosts"),
            home.join("Library")
                .join("Application Support")
                .join("BraveSoftware")
                .join("Brave-Browser")
                .join("NativeMessagingHosts"),
            home.join("Library")
                .join("Application Support")
                .join("Chromium")
                .join("NativeMessagingHosts"),
            home.join("Library")
                .join("Application Support")
                .join("Microsoft Edge")
                .join("NativeMessagingHosts"),
        ]);
    }

    #[cfg(target_os = "linux")]
    {
        return Ok(vec![
            home.join(".config")
                .join("google-chrome")
                .join("NativeMessagingHosts"),
            home.join(".config")
                .join("BraveSoftware")
                .join("Brave-Browser")
                .join("NativeMessagingHosts"),
            home.join(".config")
                .join("chromium")
                .join("NativeMessagingHosts"),
            home.join(".config")
                .join("microsoft-edge")
                .join("NativeMessagingHosts"),
        ]);
    }

    #[cfg(windows)]
    {
        return Ok(vec![home.join(".trapezohe")]);
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        anyhow::bail!("Unsupported platform for native host registration")
    }
}

fn resolve_cli_launch_spec() -> Result<LaunchSpec> {
    let current_exe = std::env::current_exe().context("Failed to resolve current executable")?;
    Ok(LaunchSpec {
        program: current_exe,
        args: vec!["start".to_string()],
    })
}

fn home_dir() -> Result<PathBuf> {
    if let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(home));
    }

    if let Some(home) = std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(home));
    }

    let home_drive = std::env::var_os("HOMEDRIVE").unwrap_or_default();
    let home_path = std::env::var_os("HOMEPATH").unwrap_or_default();
    if !home_drive.is_empty() && !home_path.is_empty() {
        let mut combined = PathBuf::from(home_drive);
        combined.push(home_path);
        return Ok(combined);
    }

    anyhow::bail!("Failed to resolve home directory");
}

fn expand_tilde_path(input: &str) -> PathBuf {
    if let Some(rest) = input.strip_prefix("~/") {
        if let Ok(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(input)
}

#[cfg(target_os = "macos")]
fn is_bundled_macos_cli(path: &Path) -> bool {
    let Some(bin_dir) = path.parent() else {
        return false;
    };
    let Some(companion_dir) = bin_dir.parent() else {
        return false;
    };
    let Some(resources_dir) = companion_dir.parent() else {
        return false;
    };
    let Some(contents_dir) = resources_dir.parent() else {
        return false;
    };
    let Some(app_dir) = contents_dir.parent() else {
        return false;
    };

    bin_dir.file_name().and_then(|value| value.to_str()) == Some("bin")
        && companion_dir.file_name().and_then(|value| value.to_str()) == Some("companion")
        && resources_dir.file_name().and_then(|value| value.to_str()) == Some("Resources")
        && contents_dir.file_name().and_then(|value| value.to_str()) == Some("Contents")
        && app_dir
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.ends_with(".app"))
            .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn is_bundled_macos_cli(_path: &Path) -> bool {
    false
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .with_context(|| format!("Failed to read metadata for {}", path.display()))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .with_context(|| format!("Failed to set permissions for {}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<()> {
    Ok(())
}

fn read_native_host_message<R: Read>(reader: &mut R) -> Result<Option<Value>> {
    let mut header = [0_u8; 4];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }

    let body_len = u32::from_le_bytes(header) as usize;
    if body_len == 0 || body_len > 1024 * 1024 {
        anyhow::bail!("Invalid message length: {body_len}");
    }

    let mut body = vec![0_u8; body_len];
    reader.read_exact(&mut body)?;
    let payload = serde_json::from_slice::<Value>(&body).context("Invalid JSON message")?;
    Ok(Some(payload))
}

fn write_native_host_message<W: Write>(writer: &mut W, payload: &Value) -> Result<()> {
    let body = serde_json::to_vec(payload)?;
    let header = (body.len() as u32).to_le_bytes();
    writer.write_all(&header)?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}

fn value_string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '_' | '-' | '.' | ':'))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(target_os = "linux")]
fn shell_quote_path(path: &Path) -> String {
    shell_quote(&path.display().to_string())
}

struct ManifestTarget {
    host_name: &'static str,
    manifest_path: PathBuf,
}

struct LaunchSpec {
    program: PathBuf,
    args: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use companion_config::save_config;
    use std::collections::BTreeMap;
    use std::sync::{Mutex, OnceLock};
    use tempfile::TempDir;

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn with_temp_env(run: impl FnOnce(&TempDir, &Path)) {
        let _guard = env_lock().lock().expect("env lock");
        let temp_home = TempDir::new().expect("temp home");
        let config_dir = temp_home.path().join(".trapezohe");

        let original_home = std::env::var_os("HOME");
        let original_userprofile = std::env::var_os("USERPROFILE");
        let original_config_dir = std::env::var_os("TRAPEZOHE_CONFIG_DIR");

        std::env::set_var("HOME", temp_home.path());
        std::env::set_var("USERPROFILE", temp_home.path());
        std::env::set_var("TRAPEZOHE_CONFIG_DIR", &config_dir);

        run(&temp_home, &config_dir);

        match original_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        match original_userprofile {
            Some(value) => std::env::set_var("USERPROFILE", value),
            None => std::env::remove_var("USERPROFILE"),
        }
        match original_config_dir {
            Some(value) => std::env::set_var("TRAPEZOHE_CONFIG_DIR", value),
            None => std::env::remove_var("TRAPEZOHE_CONFIG_DIR"),
        }
    }

    #[test]
    fn native_host_protocol_round_trip_preserves_payload() {
        let payload = json!({
            "type": "ping",
            "meta": {
                "nested": true,
            }
        });
        let mut buffer = Vec::new();
        write_native_host_message(&mut buffer, &payload).expect("write");
        let decoded = read_native_host_message(&mut std::io::Cursor::new(buffer))
            .expect("read")
            .expect("payload");
        assert_eq!(decoded, payload);
    }

    #[test]
    fn native_host_get_config_reports_missing_config() {
        with_temp_env(|_temp_home, _config_dir| {
            let payload = native_host_config_response().expect("response");
            assert_eq!(
                payload.get("error").and_then(Value::as_str),
                Some("Companion config not found. Run \"trapezohe-companion init\" first.")
            );
        });
    }

    #[test]
    fn native_host_get_config_returns_url_token_and_version() {
        with_temp_env(|_temp_home, _config_dir| {
            let mut config = CompanionConfig::default();
            config.port = 43123;
            config.token = "native-token".to_string();
            config.mcp_servers = BTreeMap::new();
            save_config(&config).expect("save config");

            let payload = native_host_config_response().expect("response");
            assert_eq!(
                payload.get("url").and_then(Value::as_str),
                Some("http://127.0.0.1:43123")
            );
            assert_eq!(
                payload.get("token").and_then(Value::as_str),
                Some("native-token")
            );
            assert_eq!(
                payload.get("version").and_then(Value::as_str),
                Some(env!("CARGO_PKG_VERSION"))
            );
        });
    }

    #[test]
    fn register_native_host_writes_fixed_origin_manifests_and_config() {
        with_temp_env(|_temp_home, _config_dir| {
            let result = register_native_host(true).expect("register");
            let manifest_paths = value_string_array(&result, "manifestPaths");
            assert!(!manifest_paths.is_empty());

            for manifest_path in manifest_paths {
                let raw = fs::read_to_string(&manifest_path).expect("read manifest");
                let payload: Value = serde_json::from_str(&raw).expect("parse manifest");
                assert_eq!(
                    payload
                        .get("allowed_origins")
                        .and_then(Value::as_array)
                        .and_then(|items| items.first())
                        .and_then(Value::as_str),
                    Some("chrome-extension://nnhdkkgpoeojjddikcjadgpkbfbjhcal/")
                );
            }

            let config = load_config().expect("load config");
            assert_eq!(config.extension_ids, vec![FIXED_EXTENSION_ID.to_string()]);
        });
    }

    #[test]
    fn self_check_reports_missing_native_host_when_not_registered() {
        with_temp_env(|_temp_home, _config_dir| {
            let mut config = CompanionConfig::default();
            config.token = "self-check-token".to_string();
            save_config(&config).expect("save config");

            let payload = build_self_check_payload().expect("self check");
            assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
            assert_eq!(
                payload
                    .pointer("/checks/nativeHostRegistration/ok")
                    .and_then(Value::as_bool),
                Some(false)
            );
            let repair_ids = payload
                .get("repairActions")
                .and_then(Value::as_array)
                .expect("repair actions")
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>();
            assert!(repair_ids.contains(&"register_native_host"));
        });
    }

    #[test]
    fn repair_config_defaults_generates_token_and_preserves_mcp_servers() {
        with_temp_env(|_temp_home, _config_dir| {
            let mut config = CompanionConfig::default();
            config.mcp_servers.insert(
                "echo".to_string(),
                companion_config::McpServerConfig {
                    command: "node".to_string(),
                    args: vec!["-e".to_string(), "console.log('ok')".to_string()],
                    env: BTreeMap::new(),
                    cwd: None,
                    request_timeout_ms: None,
                    restartable: None,
                    write_capable: None,
                },
            );
            save_config(&config).expect("save config");

            let result = repair_config_defaults().expect("repair config");
            assert_eq!(
                result.get("generatedToken").and_then(Value::as_bool),
                Some(true)
            );
            assert_eq!(
                result.get("mcpServerCount").and_then(Value::as_u64),
                Some(1)
            );

            let repaired = load_config().expect("load config");
            assert!(!repaired.token.is_empty());
            assert!(repaired.mcp_servers.contains_key("echo"));
        });
    }

    #[test]
    fn bootstrap_sets_workspace_policy_and_registers_native_host() {
        with_temp_env(|temp_home, _config_dir| {
            let runtime = tokio::runtime::Runtime::new().expect("runtime");
            let output = runtime
                .block_on(bootstrap_companion(
                    true,
                    true,
                    PERMISSION_MODE_WORKSPACE,
                    &[],
                ))
                .expect("bootstrap");

            assert_eq!(output.get("ok").and_then(Value::as_bool), Some(true));
            assert_eq!(
                value_string_array(&output, "extensionIds"),
                vec![FIXED_EXTENSION_ID.to_string()]
            );

            let workspace_roots = value_string_array(&output, "workspaceRoots");
            assert_eq!(workspace_roots.len(), 1);
            let expected_workspace = temp_home
                .path()
                .join("trapezohe-workspace")
                .canonicalize()
                .expect("canonical workspace");
            assert_eq!(workspace_roots[0], expected_workspace.display().to_string());

            let config = load_config().expect("load config");
            assert_eq!(config.permission_policy.mode, PERMISSION_MODE_WORKSPACE);
            assert_eq!(
                config.permission_policy.workspace_roots,
                vec![expected_workspace.display().to_string()]
            );
            assert!(!config.token.is_empty());
        });
    }

    #[tokio::test]
    async fn native_host_ping_matches_current_version() {
        let response = native_host_handle_request(&json!({ "type": "ping" }))
            .await
            .expect("ping");
        assert_eq!(response.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            response.get("version").and_then(Value::as_str),
            Some(env!("CARGO_PKG_VERSION"))
        );
    }

    #[tokio::test]
    async fn native_host_rejects_unknown_request_type() {
        let response = native_host_handle_request(&json!({ "type": "mystery" }))
            .await
            .expect("response");
        assert_eq!(
            response.get("error").and_then(Value::as_str),
            Some("Unknown request type: mystery")
        );
    }

    #[test]
    fn native_host_cli_accepts_browser_origin_argument() {
        let cli =
            Cli::try_parse_from(["trapezohe-companion", "native-host", FIXED_EXTENSION_ORIGIN])
                .expect("native host cli parses browser origin");

        assert!(matches!(cli.command, CommandKind::NativeHost { .. }));
    }
}
