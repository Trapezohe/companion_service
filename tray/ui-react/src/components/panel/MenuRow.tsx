import { ChevronRight, type LucideIcon } from "lucide-react";

interface MenuRowProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  onClick?: () => void;
}

const MenuRow = ({ icon: Icon, title, subtitle, onClick }: MenuRowProps) => {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-accent/60 transition-colors rounded-lg group"
    >
      <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="flex-1 text-left min-w-0">
        <div className="text-[13px] font-medium text-foreground">{title}</div>
        {subtitle && (
          <div className="text-[11px] text-muted-foreground truncate">{subtitle}</div>
        )}
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors shrink-0" />
    </button>
  );
};

export default MenuRow;
