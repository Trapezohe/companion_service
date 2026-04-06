use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use companion_config::{ensure_token, init_config, load_config, read_pid, CompanionConfig};
use companion_daemon::{probe_health, request_shutdown, serve_with_signals};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

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
    #[command(hide = true)]
    Daemon,
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
        CommandKind::Daemon => daemon_command().await,
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

async fn daemon_command() -> Result<()> {
    let mut config = load_config()?;
    ensure_token(&mut config)?;
    serve_with_signals(config).await
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
