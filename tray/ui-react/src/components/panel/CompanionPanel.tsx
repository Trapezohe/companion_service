import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Lang, useT } from "@/lib/translations";
import HomePage from "./HomePage";
import PermissionsPage from "./PermissionsPage";
import LogsPage from "./LogsPage";
import SettingsPage from "./SettingsPage";

const CompanionPanel = () => {
  const [page, setPage] = useState("home");
  const [lang, setLang] = useState<Lang>("en");
  const tr = useT(lang);

  // Fetch initial language from backend snapshot
  useEffect(() => {
    invoke<{ language: Lang }>("get_status_snapshot")
      .then((snapshot) => {
        if (snapshot?.language === "en" || snapshot?.language === "zh") {
          setLang(snapshot.language);
        }
      })
      .catch(() => {
        // fallback to "en" if invoke fails (e.g. dev mode outside Tauri)
      });
  }, []);

  const handleLangChange = (next: Lang) => {
    setLang(next);
    invoke("set_display_language", { language: next }).catch(() => {});
  };

  return (
    <div className="p-[5px] h-screen box-border">
      <div className="w-full h-full overflow-y-auto rounded-[12px] bg-background panel-scrollbar">
        {page === "home" && <HomePage onNavigate={setPage} lang={lang} />}
        {page === "permissions" && (
          <PermissionsPage onBack={() => setPage("home")} lang={lang} />
        )}
        {page === "logs" && <LogsPage onBack={() => setPage("home")} lang={lang} />}
        {page === "settings" && (
          <SettingsPage
            onBack={() => setPage("home")}
            lang={lang}
            onLangChange={handleLangChange}
          />
        )}

        {/* Footer */}
        <div className="text-center text-[11px] text-muted-foreground/40 py-2">
          {tr.footer}
        </div>
      </div>
    </div>
  );
};

export default CompanionPanel;
