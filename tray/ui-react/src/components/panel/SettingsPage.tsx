import { useState } from "react";
import PanelHeader from "./PanelHeader";

interface SettingsPageProps {
  onBack: () => void;
}

const SettingsPage = ({ onBack }: SettingsPageProps) => {
  const [lang, setLang] = useState<"en" | "zh">("zh");

  return (
    <div className="flex flex-col">
      <PanelHeader title="设置" onBack={onBack} />

      {/* Language */}
      <div className="px-4 pt-1 pb-2">
        <div className="text-[11px] text-muted-foreground font-medium mb-2">语言</div>
        <div className="flex rounded-lg overflow-hidden border border-border">
          <button
            onClick={() => setLang("en")}
            className={`flex-1 py-2.5 text-center transition-colors ${
              lang === "en"
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-accent"
            }`}
          >
            <div className="text-[13px] font-medium">English</div>
            <div className="text-[10px] opacity-70 mt-0.5">默认</div>
          </button>
          <button
            onClick={() => setLang("zh")}
            className={`flex-1 py-2.5 text-center transition-colors ${
              lang === "zh"
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-accent"
            }`}
          >
            <div className="text-[13px] font-medium">中文</div>
            <div className="text-[10px] opacity-70 mt-0.5">简体中文</div>
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-2 divide-y divide-border border-t border-border">
        {[
          { label: "关闭开机启动", destructive: false },
          { label: "打开日志文件夹", destructive: false },
          { label: "打开发布页", destructive: false },
          { label: "停止服务", destructive: false },
        ].map((item) => (
          <button
            key={item.label}
            className="w-full px-4 py-3 text-left text-[13px] text-foreground hover:bg-accent/60 transition-colors"
          >
            {item.label}
          </button>
        ))}
        <button className="w-full px-4 py-3 text-left text-[13px] text-destructive hover:bg-destructive/10 transition-colors font-medium">
          退出 Companion
        </button>
      </div>
    </div>
  );
};

export default SettingsPage;
