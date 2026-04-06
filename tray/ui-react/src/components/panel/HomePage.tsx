import { Shield, ScrollText, Settings } from "lucide-react";
import StatusBadge from "./StatusBadge";
import MenuRow from "./MenuRow";

interface HomePageProps {
  onNavigate: (page: string) => void;
}

const HomePage = ({ onNavigate }: HomePageProps) => {
  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="px-4 pt-4 pb-1">
        <h1 className="text-[15px] font-bold text-foreground">GhastAI Companion</h1>
        <p className="text-[11px] text-muted-foreground mt-0.5">浏览器插件使用的本地桥接服务</p>
      </div>

      {/* Status Card */}
      <div className="mx-3 mt-3 p-3 rounded-xl bg-card border border-border">
        <div className="flex items-center justify-between">
          <StatusBadge status="online" label="正常" />
          <button className="text-[11px] px-2.5 py-1 rounded-md bg-secondary hover:bg-secondary/80 text-secondary-foreground transition-colors border border-border">
            检查更新
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          本地 companion 已就绪，可以响应插件请求。
        </p>
        <div className="flex items-center gap-4 mt-2.5 text-[11px] text-muted-foreground">
          <span>PID <span className="text-foreground font-mono">3593</span></span>
          <span>审批 <span className="text-foreground font-mono">0</span></span>
          <span>更新时间 <span className="text-foreground">刚刚</span></span>
        </div>
        <button className="mt-2.5 text-[11px] px-2.5 py-1 rounded-md bg-secondary hover:bg-secondary/80 text-secondary-foreground transition-colors border border-border">
          重启
        </button>
      </div>

      {/* MCP Services */}
      <div className="mx-3 mt-3 p-3 rounded-xl bg-card border border-border">
        <div className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
          MCP 服务
        </div>
        <div className="text-[11px] text-muted-foreground mt-1">
          1 在线 / 29 个工具
        </div>
        <div className="mt-2.5 flex items-center justify-between py-2 px-2.5 rounded-lg bg-secondary/50">
          <div>
            <div className="text-[13px] font-medium text-foreground">chrome-devtools</div>
            <div className="text-[11px] text-muted-foreground">29 个工具</div>
          </div>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-success/15 text-success font-medium">
            已连接
          </span>
        </div>
      </div>

      {/* Menu */}
      <div className="mt-3 border-t border-border pt-1">
        <MenuRow
          icon={Shield}
          title="权限与安全"
          subtitle="0 已启用 · 6 须处理"
          onClick={() => onNavigate("permissions")}
        />
        <MenuRow
          icon={ScrollText}
          title="插件动作日志"
          subtitle="最近还没有插件动作记录。"
          onClick={() => onNavigate("logs")}
        />
        <MenuRow
          icon={Settings}
          title="设置"
          onClick={() => onNavigate("settings")}
        />
      </div>

      {/* Version */}
      <div className="text-center text-[11px] text-muted-foreground py-3">
        版本 v0.1.18
      </div>
    </div>
  );
};

export default HomePage;
