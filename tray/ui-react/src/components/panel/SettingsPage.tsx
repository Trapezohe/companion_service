import { invoke } from "@tauri-apps/api/core";
import { type Lang, useT } from "@/lib/translations";
import PanelHeader from "./PanelHeader";

interface SettingsPageProps {
  onBack: () => void;
  lang: Lang;
  onLangChange: (lang: Lang) => void;
  onAfterAction?: () => void;
}

const SettingsPage = ({ onBack, lang, onLangChange, onAfterAction }: SettingsPageProps) => {
  const tr = useT(lang);

  const actions: { key: string; label: string; handler?: () => void }[] = [
    {
      key: "check-update",
      label: tr.checkUpdateAction,
      handler: () => invoke("check_update").then(onAfterAction).catch(() => {}),
    },
    {
      key: "restart",
      label: tr.restartService,
      handler: () => invoke("restart_service").then(onAfterAction).catch(() => {}),
    },
    {
      key: "autostart",
      label: tr.disableAutostart,
      handler: () => invoke("set_autostart_enabled", { enabled: false }).catch(() => {}),
    },
    {
      key: "logs",
      label: tr.openLogsFolder,
      handler: () => invoke("open_logs").catch(() => {}),
    },
    {
      key: "release",
      label: tr.openReleasePage,
      handler: () => invoke("open_release_page").catch(() => {}),
    },
    {
      key: "stop",
      label: tr.stopService,
      handler: () => invoke("stop_service").catch(() => {}),
    },
  ];

  return (
    <div className="flex flex-col">
      <PanelHeader title={tr.settingsTitle} onBack={onBack} />

      {/* Language */}
      <div className="px-4 pt-1 pb-2">
        <div className="text-[11px] text-muted-foreground font-medium mb-2">{tr.language}</div>
        <div className="flex rounded-lg overflow-hidden border border-border">
          <button
            onClick={() => onLangChange("en")}
            className={`flex-1 py-2.5 text-center transition-colors ${
              lang === "en"
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-accent"
            }`}
          >
            <div className="text-[13px] font-medium">English</div>
            <div className="text-[10px] opacity-70 mt-0.5">{tr.englishSubLabel}</div>
          </button>
          <button
            onClick={() => onLangChange("zh")}
            className={`flex-1 py-2.5 text-center transition-colors ${
              lang === "zh"
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-accent"
            }`}
          >
            <div className="text-[13px] font-medium">中文</div>
            <div className="text-[10px] opacity-70 mt-0.5">{tr.chineseSubLabel}</div>
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-2 divide-y divide-border border-t border-border">
        {actions.map((item) => (
          <button
            key={item.key}
            onClick={item.handler}
            className="w-full px-4 py-3 text-left text-[13px] text-foreground hover:bg-accent/60 transition-colors"
          >
            {item.label}
          </button>
        ))}
        <button
          onClick={() => invoke("quit_tray").catch(() => {})}
          className="w-full px-4 py-3 text-left text-[13px] text-destructive hover:bg-destructive/10 transition-colors font-medium"
        >
          {tr.quitCompanion}
        </button>
      </div>
    </div>
  );
};

export default SettingsPage;
