import { useState } from "react";
import PanelHeader from "./PanelHeader";

interface LogsPageProps {
  onBack: () => void;
}

type TabKey = "all" | "blocked" | "failed";

const LogsPage = ({ onBack }: LogsPageProps) => {
  const [tab, setTab] = useState<TabKey>("all");

  const tabs: { key: TabKey; label: string }[] = [
    { key: "all", label: "全部" },
    { key: "blocked", label: "被拦截" },
    { key: "failed", label: "失败" },
  ];

  return (
    <div className="flex flex-col">
      <PanelHeader title="插件动作日志" onBack={onBack} />

      {/* Tabs */}
      <div className="flex items-center gap-1 px-4 pb-3">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`text-[12px] px-2.5 py-1 rounded-md transition-colors ${
              tab === t.key
                ? "bg-primary/15 text-primary font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Empty State */}
      <div className="flex flex-col items-center justify-center py-16 px-6">
        <p className="text-[13px] text-muted-foreground text-center">
          最近没有插件动作记录。
        </p>
        <p className="text-[11px] text-muted-foreground/60 text-center mt-1.5 leading-relaxed">
          当浏览器插件请求 companion 执行动作时，日志将显示在这里。
        </p>
      </div>
    </div>
  );
};

export default LogsPage;
