import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  PermissionItem,
  PermissionsSnapshot,
  SystemAuthStatus,
} from "@/lib/companion";
import { type Lang, useT } from "@/lib/translations";
import PanelHeader from "./PanelHeader";
import ToggleRow from "./ToggleRow";

interface PermissionsPageProps {
  onBack: () => void;
  lang: Lang;
}

const permissionCopy = (
  item: PermissionItem,
  tr: ReturnType<typeof useT>,
) => {
  switch (item.id) {
    case "screen_recording":
      return { title: tr.screenCapture, description: tr.screenCaptureDesc };
    case "accessibility":
      return { title: tr.accessibility, description: tr.accessibilityDesc };
    case "automation":
      return { title: tr.automation, description: tr.automationDesc };
    case "camera":
      return { title: tr.camera, description: tr.cameraDesc };
    case "microphone":
      return { title: tr.microphone, description: tr.microphoneDesc };
    case "location":
      return { title: tr.location, description: tr.locationDesc };
    case "notifications":
      return { title: tr.notification, description: tr.notificationDesc };
    case "desktop_notification":
      return {
        title: tr.desktopNotification,
        description: tr.desktopNotificationDesc,
      };
    case "calendar":
      return { title: tr.calendar, description: tr.calendarDesc };
    case "reminders":
      return { title: tr.reminders, description: tr.remindersDesc };
    case "contacts":
      return { title: tr.contacts, description: tr.contactsDesc };
    case "photos":
      return { title: tr.photos, description: tr.photosDesc };
    case "notes":
      return { title: tr.notes, description: tr.notesDesc };
    case "mail":
      return { title: tr.mail, description: tr.mailDesc };
    case "messages":
      return { title: tr.messages, description: tr.messagesDesc };
    case "finder":
      return { title: tr.finder, description: tr.finderDesc };
    case "safari":
      return { title: tr.safari, description: tr.safariDesc };
    case "clipboard":
      return { title: tr.clipboard, description: tr.clipboardDesc };
    case "filesystem":
      return { title: tr.filesystem, description: tr.filesystemDesc };
    case "explorer":
      return { title: tr.explorer, description: tr.explorerDesc };
    case "process_control":
      return { title: tr.processControl, description: tr.processControlDesc };
    case "screenshot":
      return { title: tr.screenshot, description: tr.screenshotDesc };
    case "window_automation":
      return { title: tr.windowAutomation, description: tr.windowAutomationDesc };
    case "registry_write":
      return { title: tr.registryWrite, description: tr.registryWriteDesc };
    case "service_control":
      return { title: tr.serviceControl, description: tr.serviceControlDesc };
    case "task_scheduler":
      return { title: tr.taskScheduler, description: tr.taskSchedulerDesc };
    case "admin_shell":
      return { title: tr.adminShell, description: tr.adminShellDesc };
    case "local_command":
      return { title: tr.localCommand, description: tr.localCommandDesc };
    case "browser_control":
      return { title: tr.browserControl, description: tr.browserControlDesc };
    case "admin_action":
      return { title: tr.adminAction, description: tr.adminActionDesc };
    default:
      return { title: item.id, description: item.description_key };
  }
};

const mapSystemStatus = (
  status: SystemAuthStatus,
): "authorized" | "unauthorized" | "implicit" | "unknown" | "unsupported" => {
  switch (status) {
    case "authorized":
      return "authorized";
    case "implicitly_allowed":
      return "implicit";
    case "not_authorized":
      return "unauthorized";
    case "not_supported":
      return "unsupported";
    default:
      return "unknown";
  }
};

const isSystemPermissionReady = (item: PermissionItem) =>
  item.system_auth === "authorized" || item.system_auth === "implicitly_allowed";

const PermissionsPage = ({ onBack, lang }: PermissionsPageProps) => {
  const tr = useT(lang);
  const [snapshot, setSnapshot] = useState<PermissionsSnapshot | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  const loadSnapshot = () => {
    invoke<PermissionsSnapshot>("get_permissions_snapshot")
      .then((next) => {
        setSnapshot(next);
        setLoadError(false);
      })
      .catch(() => {
        setLoadError(true);
      });
  };

  useEffect(() => {
    loadSnapshot();
    const interval = setInterval(loadSnapshot, 2000);
    return () => clearInterval(interval);
  }, []);

  const items = snapshot?.items ?? [];
  const systemItems = useMemo(
    () => items.filter((item) => item.group === "system"),
    [items],
  );
  const applicationItems = useMemo(
    () => items.filter((item) => item.group === "application"),
    [items],
  );
  const highRiskItems = useMemo(
    () => items.filter((item) => item.group === "high_risk"),
    [items],
  );
  const enabledCount = useMemo(
    () => items.filter((item) => item.companion_enabled).length,
    [items],
  );
  const reviewCount = useMemo(
    () =>
      systemItems.filter(
        (item) => item.platform_supported && !isSystemPermissionReady(item),
      ).length,
    [systemItems],
  );
  const highRiskDisabledCount = useMemo(
    () =>
      highRiskItems.filter((item) => !item.companion_enabled).length,
    [highRiskItems],
  );

  const updateCapability = async (id: string, enabled: boolean) => {
    setBusyId(id);
    try {
      const next = await invoke<PermissionsSnapshot>("toggle_companion_permission", {
        id,
        enabled,
      });
      setSnapshot(next);
      setLoadError(false);
    } finally {
      setBusyId(null);
    }
  };

  const openSystemSettings = async (id: string) => {
    setBusyId(id);
    try {
      await invoke("open_system_permission_settings", { id });
    } finally {
      setBusyId(null);
      window.setTimeout(loadSnapshot, 800);
    }
  };

  const handleToggle = async (item: PermissionItem, nextEnabled: boolean) => {
    if (!item.platform_supported) {
      return;
    }

    if (nextEnabled && item.system_auth === "not_authorized") {
      if (nextEnabled) {
        await openSystemSettings(item.id);
      }
      return;
    }

    await updateCapability(item.id, nextEnabled);
  };

  return (
    <div className="flex flex-col">
      <PanelHeader title={tr.permissionsTitle} onBack={onBack} />

      <div className="flex items-center gap-2 px-4 pb-2">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium">
          {tr.enabledBadge(enabledCount, reviewCount)}
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
          {tr.highRiskBadge(highRiskDisabledCount)}
        </span>
      </div>

      {!snapshot && !loadError ? (
        <div className="px-4 py-3 text-[12px] text-muted-foreground">
          {tr.permissionLoading}
        </div>
      ) : null}

      {loadError ? (
        <div className="px-4 py-3 text-[12px] text-warning">
          {tr.permissionLoadFailed}
        </div>
      ) : null}

      {systemItems.length > 0 ? (
        <>
          <div className="px-4 pt-3 pb-1">
            <div className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
              {tr.systemPermissions}
            </div>
          </div>
          <div className="divide-y divide-border">
            {systemItems.map((item) => {
              const copy = permissionCopy(item, tr);
              const systemStatus = mapSystemStatus(item.system_auth);
              const ready = isSystemPermissionReady(item);
              const showCompanionStatus = ready || item.companion_enabled;
              const hint =
                item.system_auth === "not_authorized" && item.platform_supported
                  ? `${tr.permissionOpenSystemSettings} ${tr.permissionRefreshHint}`
                  : null;
              return (
                <ToggleRow
                  key={item.id}
                  title={copy.title}
                  description={copy.description}
                  enabled={item.companion_enabled}
                  onToggle={(enabled) => {
                    void handleToggle(item, enabled);
                  }}
                  systemStatus={systemStatus}
                  companionStatus={
                    showCompanionStatus
                      ? item.companion_enabled
                        ? "open"
                        : "closed"
                      : undefined
                  }
                  hint={hint}
                  disabled={busyId === item.id || !item.platform_supported}
                  lang={lang}
                />
              );
            })}
          </div>
        </>
      ) : null}

      {applicationItems.length > 0 ? (
        <>
          <div className="px-4 pt-4 pb-1">
            <div className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
              {tr.applicationAccess}
            </div>
          </div>
          <div className="divide-y divide-border">
            {applicationItems.map((item) => {
              const copy = permissionCopy(item, tr);
              const hint =
                item.system_auth === "not_authorized" && item.platform_supported
                  ? `${tr.permissionOpenSystemSettings} ${tr.permissionRefreshHint}`
                  : null;
              return (
                <ToggleRow
                  key={item.id}
                  title={copy.title}
                  description={copy.description}
                  enabled={item.companion_enabled}
                  onToggle={(enabled) => {
                    void handleToggle(item, enabled);
                  }}
                  systemStatus={
                    item.platform_supported
                      ? mapSystemStatus(item.system_auth)
                      : "unsupported"
                  }
                  companionStatus={item.companion_enabled ? "open" : "closed"}
                  hint={hint}
                  disabled={busyId === item.id || !item.platform_supported}
                  lang={lang}
                />
              );
            })}
          </div>
        </>
      ) : null}

      {highRiskItems.length > 0 ? (
        <>
          <div className="px-4 pt-4 pb-1">
            <div className="text-[11px] text-warning font-medium uppercase tracking-wider">
              {tr.highRiskCapabilities}
            </div>
          </div>
          <div className="divide-y divide-border">
            {highRiskItems.map((item) => {
              const copy = permissionCopy(item, tr);
              return (
                <ToggleRow
                  key={item.id}
                  title={copy.title}
                  description={copy.description}
                  enabled={item.companion_enabled}
                  onToggle={(enabled) => {
                    void handleToggle(item, enabled);
                  }}
                  companionStatus={item.companion_enabled ? "open" : "closed"}
                  risk={item.is_high_risk ? "high" : null}
                  requireConfirm={item.requires_per_action_confirm}
                  disabled={busyId === item.id}
                  lang={lang}
                />
              );
            })}
          </div>
        </>
      ) : null}
      <div className="h-4" />
    </div>
  );
};

export default PermissionsPage;
