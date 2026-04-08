import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Lang, useT } from "@/lib/translations";
import type { StatusSnapshot } from "@/lib/companion";
import HomePage from "./HomePage";
import McpPage from "./McpPage";
import PermissionsPage from "./PermissionsPage";
import LogsPage from "./LogsPage";
import SettingsPage from "./SettingsPage";

const CompanionPanel = () => {
  const [page, setPage] = useState("home");
  const [lang, setLang] = useState<Lang>("en");
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const tr = useT(lang);

  const fetchSnapshot = () => {
    invoke<StatusSnapshot>("get_status_snapshot")
      .then((s) => {
        setSnapshot(s);
        if (s?.language === "en" || s?.language === "zh") {
          setLang(s.language);
        }
      })
      .catch(() => {});
  };

  // Initial fetch + hourly update check via check_update invoke
  useEffect(() => {
    fetchSnapshot();
    const runUpdateCheck = () => {
      invoke<StatusSnapshot>("check_update")
        .then((s) => {
          setSnapshot(s);
          if (s?.language === "en" || s?.language === "zh") setLang(s.language);
        })
        .catch(() => {});
    };
    runUpdateCheck();
    const interval = setInterval(runUpdateCheck, 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = setInterval(fetchSnapshot, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleLangChange = (next: Lang) => {
    setLang(next);
    invoke("set_display_language", { language: next }).catch(() => {});
  };

  // Parse port from endpoint (e.g. "http://127.0.0.1:41591" → "41591")
  const port = snapshot?.endpoint
    ? snapshot.endpoint.split(":").pop()
    : undefined;

  const update = snapshot?.update?.available ? snapshot.update : undefined;

  return (
    <div className="p-[5px] h-screen box-border">
      <div className="w-full h-full overflow-y-auto rounded-[12px] bg-background panel-scrollbar">
        {page === "home" && (
          <HomePage
            onNavigate={setPage}
            lang={lang}
            snapshot={snapshot}
            port={port}
            update={update}
            onInstallUpdate={() => {
              invoke<StatusSnapshot>("install_update")
                .then((s) => { if (s) setSnapshot(s); })
                .catch(() => {});
            }}
          />
        )}
        {page === "mcp" && (
          <McpPage
            onBack={() => setPage("home")}
            lang={lang}
            onAfterAction={fetchSnapshot}
          />
        )}
        {page === "permissions" && (
          <PermissionsPage onBack={() => setPage("home")} lang={lang} />
        )}
        {page === "logs" && <LogsPage onBack={() => setPage("home")} lang={lang} />}
        {page === "settings" && (
          <SettingsPage
            onBack={() => setPage("home")}
            lang={lang}
            onLangChange={handleLangChange}
            onAfterAction={fetchSnapshot}
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
