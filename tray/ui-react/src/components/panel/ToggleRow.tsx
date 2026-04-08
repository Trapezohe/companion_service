import { Switch } from "@/components/ui/switch";
import { type Lang, useT } from "@/lib/translations";

interface ToggleRowProps {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (val: boolean) => void;
  systemStatus?:
    | "authorized"
    | "unauthorized"
    | "implicit"
    | "unknown"
    | "unsupported";
  companionStatus?: "open" | "closed";
  risk?: "high" | null;
  requireConfirm?: boolean;
  hint?: string | null;
  disabled?: boolean;
  lang: Lang;
}

const ToggleRow = ({
  title,
  description,
  enabled,
  onToggle,
  systemStatus,
  companionStatus,
  risk,
  requireConfirm,
  hint,
  disabled,
  lang,
}: ToggleRowProps) => {
  const tr = useT(lang);
  const systemStatusClass =
    systemStatus === "authorized" || systemStatus === "implicit"
      ? "bg-success/15 text-success"
      : systemStatus === "unauthorized"
        ? "bg-warning/15 text-warning"
        : "bg-secondary text-muted-foreground";

  const systemStatusLabel =
    systemStatus === "authorized"
      ? tr.systemAuthorized
      : systemStatus === "implicit"
        ? tr.systemImplicit
        : systemStatus === "unauthorized"
          ? tr.systemUnauthorized
          : systemStatus === "unsupported"
            ? tr.systemUnsupported
            : tr.systemUnknown;

  return (
    <div className="flex items-start justify-between gap-3 py-3 px-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-foreground">{title}</span>
          {risk === "high" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/20 text-destructive font-medium">
              {tr.highRisk}
            </span>
          )}
          {requireConfirm && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/20 text-warning font-medium">
              {tr.requireConfirm}
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
        <div className="flex items-center gap-2 mt-1.5">
          {systemStatus && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${systemStatusClass}`}>
              {systemStatusLabel}
            </span>
          )}
          {companionStatus && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
              {companionStatus === "open" ? tr.companionOpen : tr.companionClosed}
            </span>
          )}
        </div>
        {hint ? (
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        className="shrink-0 mt-0.5"
        disabled={disabled}
      />
    </div>
  );
};

export default ToggleRow;
