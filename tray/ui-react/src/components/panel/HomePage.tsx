import { ArrowDownCircle, ScrollText, Settings, Shield } from "lucide-react";
import type { StatusSnapshot } from "@/lib/companion";
import { type Lang, useT } from "@/lib/translations";
import StatusBadge from "./StatusBadge";
import MenuRow from "./MenuRow";

interface HomePageProps {
  onNavigate: (page: string) => void;
  lang: Lang;
  snapshot: StatusSnapshot | null;
  port?: string;
  update?: {
    available: boolean;
    latest_version: string;
    can_install: boolean;
  };
  onInstallUpdate?: () => void;
}

const HomePage = ({
  onNavigate,
  lang,
  snapshot,
  port,
  update,
  onInstallUpdate,
}: HomePageProps) => {
  const tr = useT(lang);
  const stateKind = snapshot?.state?.kind ?? "checking";
  const health = snapshot?.health;
  const diagnostics = snapshot?.diagnostics;
  const pid = health?.pid ?? snapshot?.state?.pid;
  const approvals = diagnostics?.pending_approvals ?? 0;
  const version =
    health?.version ??
    snapshot?.state?.version ??
    snapshot?.update?.current_version ??
    "0.1.19";
  const connectedMcp = diagnostics?.connected_mcp_servers ?? health?.mcp_servers ?? 0;
  const configuredMcp = diagnostics?.configured_mcp_servers ?? health?.mcp_servers ?? 0;
  const totalMcpTools = diagnostics?.total_mcp_tools ?? health?.mcp_tools ?? 0;
  const mcpServers = diagnostics?.servers ?? [];
  const visibleMcpServers = mcpServers.slice(0, 3);
  const recentAction = diagnostics?.action_logs?.[0];

  const badgeStatus =
    stateKind === "healthy"
      ? "online"
      : stateKind === "degraded" || stateKind === "misconfigured"
        ? "error"
        : stateKind === "stopped"
          ? "offline"
          : "checking";
  const badgeLabel =
    stateKind === "healthy"
      ? tr.statusOnline
      : stateKind === "degraded" || stateKind === "misconfigured"
        ? tr.statusError
        : stateKind === "stopped"
          ? tr.statusOffline
          : tr.statusChecking;
  const statusMessage =
    stateKind === "healthy"
      ? tr.daemonReady
      : stateKind === "stopped"
        ? tr.daemonStopped
        : stateKind === "checking"
          ? tr.daemonChecking
          : snapshot?.state?.reason || tr.daemonNeedsAttention;

  return (
    <div className="flex flex-col">
      {/* Update Banner */}
      {update?.available && (
        <div className="mx-3 mt-3 px-3 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <ArrowDownCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="text-[12px] text-amber-300 font-medium truncate">
              {tr.updateAvailable(update.latest_version)}
            </span>
          </div>
          {update.can_install && (
            <button
              onClick={onInstallUpdate}
              className="text-[11px] px-2.5 py-1 rounded-md bg-amber-500 hover:bg-amber-400 text-black font-medium transition-colors shrink-0"
            >
              {tr.updateNow}
            </button>
          )}
        </div>
      )}

      {/* Header */}
      <div className="px-4 pt-4 pb-1">
        <h1 className="text-[15px] font-bold text-foreground">GhastAI Companion</h1>
        <p className="text-[11px] text-muted-foreground mt-0.5">{tr.appSubtitle}</p>
      </div>

      {/* Status Card */}
      <div className="mx-3 mt-3 p-3 rounded-xl bg-card border border-border">
        <StatusBadge status={badgeStatus} label={badgeLabel} />
        <p className="text-[11px] text-muted-foreground mt-2">
          {statusMessage}
        </p>
        <div className="flex items-center gap-4 mt-2.5 text-[11px] text-muted-foreground flex-wrap">
          {pid && (
            <span>{tr.pid} <span className="text-foreground font-mono">{pid}</span></span>
          )}
          <span>{tr.approvals} <span className="text-foreground font-mono">{approvals}</span></span>
          {port && (
            <span>{tr.port} <span className="text-foreground font-mono">{port}</span></span>
          )}
          <span>{tr.updatedAt} <span className="text-foreground">{tr.justNow}</span></span>
        </div>
      </div>

      {/* MCP Services */}
      <button
        onClick={() => onNavigate("mcp")}
        className="mx-3 mt-3 rounded-xl bg-card border border-border p-3 text-left transition-colors hover:bg-accent/30"
      >
        <div className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
          {tr.mcpServices}
        </div>
        <div className="text-[11px] text-muted-foreground mt-1">
          {tr.mcpSummary(connectedMcp, configuredMcp, totalMcpTools)}
        </div>
        {mcpServers.length === 0 ? (
          <div className="mt-2.5 rounded-lg bg-secondary/40 px-2.5 py-2 text-[11px] text-muted-foreground">
            {tr.mcpConfiguredEmpty}
          </div>
        ) : (
          <>
            {visibleMcpServers.map((server) => (
              <div
                key={server.name}
                className="mt-2.5 flex items-center justify-between rounded-lg bg-secondary/50 px-2.5 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-foreground">{server.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {server.tool_count} {tr.mcpTools}
                  </div>
                </div>
                <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-success/15 text-success font-medium">
                  {server.status === "connected" ? tr.connected : server.status}
                </span>
              </div>
            ))}
            {mcpServers.length > visibleMcpServers.length && (
              <div className="mt-2 text-[11px] text-muted-foreground">
                {tr.mcpMore(mcpServers.length - visibleMcpServers.length)}
              </div>
            )}
          </>
        )}
      </button>

      {/* Menu */}
      <div className="mt-3 border-t border-border pt-1">
        <MenuRow
          icon={Shield}
          title={tr.permissionsTitle}
          onClick={() => onNavigate("permissions")}
        />
        <MenuRow
          icon={ScrollText}
          title={tr.logsTitle}
          subtitle={recentAction ? recentAction.action_name : tr.logsNoRecent}
          onClick={() => onNavigate("logs")}
        />
        <MenuRow
          icon={Settings}
          title={tr.settingsTitle}
          onClick={() => onNavigate("settings")}
        />
      </div>

      {/* Version */}
      <div className="text-center text-[11px] text-muted-foreground py-3">
        {tr.version} v{version}
      </div>
    </div>
  );
};

export default HomePage;
