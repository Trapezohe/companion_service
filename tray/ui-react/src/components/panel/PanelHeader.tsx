import { ChevronLeft } from "lucide-react";

interface PanelHeaderProps {
  title: string;
  onBack?: () => void;
}

const PanelHeader = ({ title, onBack }: PanelHeaderProps) => {
  return (
    <div className="flex items-center gap-2 px-4 pt-3 pb-2">
      {onBack && (
        <button
          onClick={onBack}
          className="flex items-center justify-center text-primary hover:text-primary/80 transition-colors -ml-1"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      )}
      <h1 className="text-[15px] font-semibold text-foreground">{title}</h1>
    </div>
  );
};

export default PanelHeader;
