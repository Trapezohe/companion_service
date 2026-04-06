import { Shield, ScrollText, Settings } from "lucide-react";
import { type Lang, useT } from "@/lib/translations";
import StatusBadge from "./StatusBadge";
import MenuRow from "./MenuRow";

interface HomePageProps {
  onNavigate: (page: string) => void;
  lang: Lang;
}

const HomePage = ({ onNavigate, lang }: HomePageProps) => {
  const tr = useT(lang);

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="px-4 pt-4 pb-1">
        <h1 className="text-[15px] font-bold text-foreground">GhastAI Companion</h1>
        <p className="text-[11px] text-muted-foreground mt-0.5">{tr.appSubtitle}</p>
      </div>

      {/* Status Card */}
      <div className="mx-3 mt-3 p-3 rounded-xl bg-card border border-border">
        <div className="flex items-center justify-between">
          <StatusBadge status="online" label={tr.statusOnline} />
          <button className="text-[11px] px-2.5 py-1 rounded-md bg-secondary hover:bg-secondary/80 text-secondary-foreground transition-colors border border-border">
            {tr.checkUpdate}
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          {tr.daemonReady}
        </p>
        <div className="flex items-center gap-4 mt-2.5 text-[11px] text-muted-foreground">
          <span>{tr.pid} <span className="text-foreground font-mono">3593</span></span>
          <span>{tr.approvals} <span className="text-foreground font-mono">0</span></span>
          <span>{tr.updatedAt} <span className="text-foreground">{tr.justNow}</span></span>
        </div>
        <button className="mt-2.5 text-[11px] px-2.5 py-1 rounded-md bg-secondary hover:bg-secondary/80 text-secondary-foreground transition-colors border border-border">
          {tr.restart}
        </button>
      </div>

      {/* MCP Services */}
      <div className="mx-3 mt-3 p-3 rounded-xl bg-card border border-border">
        <div className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
          {tr.mcpServices}
        </div>
        <div className="text-[11px] text-muted-foreground mt-1">
          1 {tr.mcpOnline} / 29 {tr.mcpTools}
        </div>
        <div className="mt-2.5 flex items-center justify-between py-2 px-2.5 rounded-lg bg-secondary/50">
          <div>
            <div className="text-[13px] font-medium text-foreground">chrome-devtools</div>
            <div className="text-[11px] text-muted-foreground">29 {tr.mcpTools}</div>
          </div>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-success/15 text-success font-medium">
            {tr.connected}
          </span>
        </div>
      </div>

      {/* Menu */}
      <div className="mt-3 border-t border-border pt-1">
        <MenuRow
          icon={Shield}
          title={tr.permissionsTitle}
          subtitle={tr.permissionsSubtitle(0, 6)}
          onClick={() => onNavigate("permissions")}
        />
        <MenuRow
          icon={ScrollText}
          title={tr.logsTitle}
          subtitle={tr.logsNoRecent}
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
        {tr.version} v0.1.18
      </div>
    </div>
  );
};

export default HomePage;
