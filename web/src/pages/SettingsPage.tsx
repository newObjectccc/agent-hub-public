/**
 * 设置页（/settings）：主题三态 + 声音/震动/横幅开关 + 关于/版本（SettingsPanel 内容集中）。
 */
import { SettingsPanel } from "../components/SettingsPanel";

export function SettingsPage() {
  return (
    <div className="page settings-page">
      <SettingsPanel />
    </div>
  );
}
