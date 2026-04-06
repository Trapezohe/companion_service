interface StatusBadgeProps {
  status: "online" | "offline" | "error";
  label: string;
}

const StatusBadge = ({ status, label }: StatusBadgeProps) => {
  const dotColor = {
    online: "bg-success",
    offline: "bg-muted-foreground",
    error: "bg-destructive",
  }[status];

  return (
    <div className="flex items-center gap-2.5">
      <span className={`w-2.5 h-2.5 rounded-full ${dotColor} shadow-[0_0_6px_1px] shadow-success/40`} />
      <span className="text-foreground font-medium">{label}</span>
    </div>
  );
};

export default StatusBadge;
