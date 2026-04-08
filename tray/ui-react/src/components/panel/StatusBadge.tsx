interface StatusBadgeProps {
  status: "online" | "offline" | "error" | "checking";
  label: string;
}

const StatusBadge = ({ status, label }: StatusBadgeProps) => {
  const dotColor = {
    online: "bg-success",
    offline: "bg-muted-foreground",
    error: "bg-destructive",
    checking: "bg-amber-400",
  }[status];

  const dotShadow = {
    online: "shadow-success/40",
    offline: "shadow-transparent",
    error: "shadow-destructive/40",
    checking: "shadow-amber-400/40",
  }[status];

  return (
    <div className="flex items-center gap-2.5">
      <span className={`w-2.5 h-2.5 rounded-full ${dotColor} shadow-[0_0_6px_1px] ${dotShadow}`} />
      <span className="text-foreground font-medium">{label}</span>
    </div>
  );
};

export default StatusBadge;
