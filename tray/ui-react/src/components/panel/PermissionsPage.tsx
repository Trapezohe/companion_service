import { useState } from "react";
import { type Lang, useT } from "@/lib/translations";
import PanelHeader from "./PanelHeader";
import ToggleRow from "./ToggleRow";

interface PermissionsPageProps {
  onBack: () => void;
  lang: Lang;
}

const PermissionsPage = ({ onBack, lang }: PermissionsPageProps) => {
  const tr = useT(lang);
  const [permissions, setPermissions] = useState({
    screenCapture: true,
    accessibility: true,
    automation: true,
    camera: false,
    microphone: false,
    location: false,
    notification: true,
    localCommand: false,
    browserControl: false,
    adminAction: true,
  });

  const toggle = (key: keyof typeof permissions) => {
    setPermissions((p) => ({ ...p, [key]: !p[key] }));
  };

  return (
    <div className="flex flex-col">
      <PanelHeader title={tr.permissionsTitle} onBack={onBack} />

      <div className="flex items-center gap-2 px-4 pb-2">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium">
          {tr.enabledBadge(0, 6)}
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
          {tr.highRiskBadge(3)}
        </span>
      </div>

      {/* System Permissions */}
      <div className="px-4 pt-3 pb-1">
        <div className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">{tr.systemPermissions}</div>
      </div>
      <div className="divide-y divide-border">
        <ToggleRow title={tr.screenCapture} description={tr.screenCaptureDesc} enabled={permissions.screenCapture} onToggle={() => toggle("screenCapture")} systemStatus="unauthorized" companionStatus="closed" lang={lang} />
        <ToggleRow title={tr.accessibility} description={tr.accessibilityDesc} enabled={permissions.accessibility} onToggle={() => toggle("accessibility")} systemStatus="unauthorized" companionStatus="closed" lang={lang} />
        <ToggleRow title={tr.automation} description={tr.automationDesc} enabled={permissions.automation} onToggle={() => toggle("automation")} systemStatus="unauthorized" companionStatus="closed" lang={lang} />
        <ToggleRow title={tr.camera} description={tr.cameraDesc} enabled={permissions.camera} onToggle={() => toggle("camera")} systemStatus="unauthorized" companionStatus="closed" lang={lang} />
        <ToggleRow title={tr.microphone} description={tr.microphoneDesc} enabled={permissions.microphone} onToggle={() => toggle("microphone")} systemStatus="unauthorized" companionStatus="closed" lang={lang} />
        <ToggleRow title={tr.location} description={tr.locationDesc} enabled={permissions.location} onToggle={() => toggle("location")} systemStatus="unauthorized" companionStatus="closed" lang={lang} />
        <ToggleRow title={tr.notification} description={tr.notificationDesc} enabled={permissions.notification} onToggle={() => toggle("notification")} systemStatus="authorized" companionStatus="closed" lang={lang} />
      </div>

      {/* High Risk */}
      <div className="px-4 pt-4 pb-1">
        <div className="text-[11px] text-warning font-medium uppercase tracking-wider">{tr.highRiskCapabilities}</div>
      </div>
      <div className="divide-y divide-border">
        <ToggleRow title={tr.localCommand} description={tr.localCommandDesc} enabled={permissions.localCommand} onToggle={() => toggle("localCommand")} systemStatus="authorized" companionStatus="closed" risk="high" lang={lang} />
        <ToggleRow title={tr.browserControl} description={tr.browserControlDesc} enabled={permissions.browserControl} onToggle={() => toggle("browserControl")} systemStatus="authorized" companionStatus="closed" risk="high" lang={lang} />
        <ToggleRow title={tr.adminAction} description={tr.adminActionDesc} enabled={permissions.adminAction} onToggle={() => toggle("adminAction")} systemStatus="authorized" companionStatus="closed" risk="high" requireConfirm lang={lang} />
      </div>
      <div className="h-4" />
    </div>
  );
};

export default PermissionsPage;
