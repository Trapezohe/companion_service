import { useState } from "react";
import { type Lang, useT } from "@/lib/translations";
import PanelHeader from "./PanelHeader";

interface LogsPageProps {
  onBack: () => void;
  lang: Lang;
}

type TabKey = "all" | "blocked" | "failed";

const LogsPage = ({ onBack, lang }: LogsPageProps) => {
  const tr = useT(lang);
  const [tab, setTab] = useState<TabKey>("all");

  const tabs: { key: TabKey; label: string }[] = [
    { key: "all", label: tr.tabAll },
    { key: "blocked", label: tr.tabBlocked },
    { key: "failed", label: tr.tabFailed },
  ];

  return (
    <div className="flex flex-col">
      <PanelHeader title={tr.logsTitle} onBack={onBack} />

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
          {tr.logsEmpty}
        </p>
        <p className="text-[11px] text-muted-foreground/60 text-center mt-1.5 leading-relaxed">
          {tr.logsEmptyHint}
        </p>
      </div>
    </div>
  );
};

export default LogsPage;
