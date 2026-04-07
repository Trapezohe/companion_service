import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ConfiguredMcpServer,
  DiscoveredMcpCandidate,
  McpDiscoverySnapshot,
} from "@/lib/companion";
import { type Lang, useT } from "@/lib/translations";
import PanelHeader from "./PanelHeader";
import { Switch } from "@/components/ui/switch";

interface McpPageProps {
  onBack: () => void;
  lang: Lang;
  onAfterAction?: () => void;
}

const McpPage = ({ onBack, lang, onAfterAction }: McpPageProps) => {
  const tr = useT(lang);
  const [snapshot, setSnapshot] = useState<McpDiscoverySnapshot | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const renderCommandLine = (command: string, args: string[]) =>
    [command, ...args].filter(Boolean).join(" ");

  const loadSnapshot = () => {
    invoke<McpDiscoverySnapshot>("get_mcp_discovery_snapshot")
      .then(setSnapshot)
      .catch(() => {});
  };

  useEffect(() => {
    loadSnapshot();
  }, []);

  const availableCandidates = useMemo(
    () => snapshot?.discovered.filter((item) => !item.configured) ?? [],
    [snapshot],
  );
  const discoveredCount = snapshot?.discovered.length ?? 0;

  const detectedHint =
    discoveredCount === 0
      ? tr.mcpDetectedEmpty
      : availableCandidates.length === 0
        ? tr.mcpDetectedAllEnabled
        : tr.mcpDetectedHint(availableCandidates.length);

  const handleEnable = (candidate: DiscoveredMcpCandidate) => {
    setBusyKey(`enable:${candidate.id}`);
    invoke<McpDiscoverySnapshot>("enable_mcp_server", {
      name: candidate.name,
      command: candidate.command,
      args: candidate.args,
      env: candidate.env,
      cwd: candidate.cwd ?? null,
    })
      .then((next) => {
        setSnapshot(next);
        onAfterAction?.();
      })
      .catch(() => {})
      .finally(() => setBusyKey(null));
  };

  const handleDisable = (server: ConfiguredMcpServer) => {
    setBusyKey(`disable:${server.name}`);
    invoke<McpDiscoverySnapshot>("disable_mcp_server", {
      name: server.name,
    })
      .then((next) => {
        setSnapshot(next);
        onAfterAction?.();
      })
      .catch(() => {})
      .finally(() => setBusyKey(null));
  };

  const handleConfiguredToggle = (
    server: ConfiguredMcpServer,
    nextEnabled: boolean,
  ) => {
    if (nextEnabled) {
      return;
    }
    handleDisable(server);
  };

  const handleDiscoveredToggle = (
    candidate: DiscoveredMcpCandidate,
    nextEnabled: boolean,
  ) => {
    if (!nextEnabled) {
      return;
    }
    handleEnable(candidate);
  };

  return (
    <div className="flex flex-col">
      <PanelHeader title={tr.mcpManageTitle} onBack={onBack} />

      <div className="px-4 pb-3">
        <div className="rounded-xl border border-border bg-card px-3 py-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {tr.mcpServices}
          </div>
          <div className="mt-1 text-[13px] font-medium text-foreground">
            {tr.mcpSummary(
              snapshot?.connectedServers ?? 0,
              snapshot?.configuredServers ?? 0,
              snapshot?.totalTools ?? 0,
            )}
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            {detectedHint}
          </div>
        </div>
      </div>

      <div className="px-4 pb-2">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {tr.mcpConfiguredSection}
        </div>
        <div className="space-y-2">
          {(snapshot?.configured ?? []).length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-3 py-3 text-[12px] text-muted-foreground">
              {tr.mcpConfiguredEmpty}
            </div>
          ) : (
            snapshot?.configured.map((server) => (
              <div
                key={server.name}
                className="rounded-xl border border-border bg-card px-3 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-foreground">
                      {server.name}
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted-foreground">
                      {renderCommandLine(server.command, server.args)}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {tr.mcpServerMeta(server.toolCount, server.status)}
                    </div>
                  </div>
                  <div className="shrink-0 pt-0.5">
                    <Switch
                      checked
                      onCheckedChange={(checked) =>
                        handleConfiguredToggle(server, checked)
                      }
                      disabled={busyKey === `disable:${server.name}`}
                    />
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {tr.mcpDetectedSection}
        </div>
        <div className="space-y-2">
          {availableCandidates.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-3 py-3 text-[12px] text-muted-foreground">
              {tr.mcpDetectedEmpty}
            </div>
          ) : (
            availableCandidates.map((candidate) => (
              <div
                key={candidate.id}
                className="rounded-xl border border-border bg-card px-3 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-foreground">
                      {candidate.name}
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted-foreground">
                      {renderCommandLine(candidate.command, candidate.args)}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {tr.mcpSourceLabel(candidate.source)}
                    </div>
                  </div>
                  <div className="shrink-0 pt-0.5">
                    <Switch
                      checked={false}
                      onCheckedChange={(checked) =>
                        handleDiscoveredToggle(candidate, checked)
                      }
                      disabled={busyKey === `enable:${candidate.id}`}
                    />
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default McpPage;
