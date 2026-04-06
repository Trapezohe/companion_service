import { useState } from "react";
import PanelHeader from "./PanelHeader";
import ToggleRow from "./ToggleRow";

interface PermissionsPageProps {
  onBack: () => void;
}

const PermissionsPage = ({ onBack }: PermissionsPageProps) => {
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
      <PanelHeader title="权限与安全" onBack={onBack} />
      
      <div className="flex items-center gap-2 px-4 pb-2">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium">
          0 已启用 · 6 须处理
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
          3 项高风险能力已关闭
        </span>
      </div>

      {/* System Permissions */}
      <div className="px-4 pt-3 pb-1">
        <div className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">系统权限</div>
      </div>
      <div className="divide-y divide-border">
        <ToggleRow title="屏幕录制" description="允许捕获屏幕内容以提供视觉上下文。" enabled={permissions.screenCapture} onToggle={() => toggle("screenCapture")} systemStatus="unauthorized" companionStatus="closed" />
        <ToggleRow title="辅助功能" description="允许读取和操作界面元素。" enabled={permissions.accessibility} onToggle={() => toggle("accessibility")} systemStatus="unauthorized" companionStatus="closed" />
        <ToggleRow title="自动化" description="允许通过脚本控制其他应用程序。" enabled={permissions.automation} onToggle={() => toggle("automation")} systemStatus="unauthorized" companionStatus="closed" />
        <ToggleRow title="相机" description="允许访问相机获取视觉输入。" enabled={permissions.camera} onToggle={() => toggle("camera")} systemStatus="unauthorized" companionStatus="closed" />
        <ToggleRow title="麦克风" description="允许访问麦克风获取音频输入。" enabled={permissions.microphone} onToggle={() => toggle("microphone")} systemStatus="unauthorized" companionStatus="closed" />
        <ToggleRow title="定位" description="允许获取设备位置信息。" enabled={permissions.location} onToggle={() => toggle("location")} systemStatus="unauthorized" companionStatus="closed" />
        <ToggleRow title="通知" description="允许发送系统通知。" enabled={permissions.notification} onToggle={() => toggle("notification")} systemStatus="authorized" companionStatus="closed" />
      </div>

      {/* High Risk */}
      <div className="px-4 pt-4 pb-1">
        <div className="text-[11px] text-warning font-medium uppercase tracking-wider">高风险能力</div>
      </div>
      <div className="divide-y divide-border">
        <ToggleRow title="本地命令执行" description="能执行本地命令和脚本。可能修改文件、读取环境、启动进程。" enabled={permissions.localCommand} onToggle={() => toggle("localCommand")} systemStatus="authorized" companionStatus="closed" risk="high" />
        <ToggleRow title="浏览器控制 / UI 自动化" description="能控制浏览器、点击元素、输入内容、读取页面信息。" enabled={permissions.browserControl} onToggle={() => toggle("browserControl")} systemStatus="authorized" companionStatus="closed" risk="high" />
        <ToggleRow title="管理员动作" description="涉及更高系统权限的敏感操作。每次执行均需单独确认。" enabled={permissions.adminAction} onToggle={() => toggle("adminAction")} systemStatus="authorized" companionStatus="closed" risk="high" requireConfirm />
      </div>
      <div className="h-4" />
    </div>
  );
};

export default PermissionsPage;
