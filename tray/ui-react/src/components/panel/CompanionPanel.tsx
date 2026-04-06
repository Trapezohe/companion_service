import { useState } from "react";
import HomePage from "./HomePage";
import PermissionsPage from "./PermissionsPage";
import LogsPage from "./LogsPage";
import SettingsPage from "./SettingsPage";

const CompanionPanel = () => {
  const [page, setPage] = useState("home");

  return (
    <div className="h-screen overflow-y-auto bg-background">
      {page === "home" && <HomePage onNavigate={setPage} />}
      {page === "permissions" && <PermissionsPage onBack={() => setPage("home")} />}
      {page === "logs" && <LogsPage onBack={() => setPage("home")} />}
      {page === "settings" && <SettingsPage onBack={() => setPage("home")} />}
      
      {/* Footer */}
      <div className="text-center text-[11px] text-muted-foreground/40 py-2 border-t border-border">
        点面板外即可关闭
      </div>
    </div>
  );
};

export default CompanionPanel;
