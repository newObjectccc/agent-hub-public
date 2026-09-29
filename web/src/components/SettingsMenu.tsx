/**
 * 设置/主题菜单：提醒通道开关（声音/震动/横幅，localStorage 可静音）+ 主题三态。
 * 与 NoticeBanner 解耦：写入 localStorage，提醒发生时读取。
 */
import { useEffect, useRef, useState } from "react";
import { useDismissable } from "../hooks/useDismissable";
import {
  DEFAULT_NOTIFY_SETTINGS,
  loadNotifySettings,
  saveNotifySettings,
  type NotifySettings,
} from "../utils/notify";
import { applyTheme, loadTheme, saveTheme, type ThemeSetting } from "../utils/theme";
import { GearIcon } from "./icons";
import { Button } from "./ui/button";

const THEME_OPTIONS: Array<{ value: ThemeSetting; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="settings-row">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
    </label>
  );
}

export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<NotifySettings>(DEFAULT_NOTIFY_SETTINGS);
  const [theme, setTheme] = useState<ThemeSetting>("system");
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点外部/Esc 关闭 + 与其他弹层（通知铃铛/⋯菜单等）互斥
  useDismissable({ open, onDismiss: () => setOpen(false), rootRef });

  useEffect(() => {
    const storage = typeof localStorage !== "undefined" ? localStorage : null;
    setSettings(loadNotifySettings(storage));
    setTheme(loadTheme(storage));
  }, []);

  const updateSettings = (next: NotifySettings): void => {
    setSettings(next);
    saveNotifySettings(typeof localStorage !== "undefined" ? localStorage : null, next);
  };

  const updateTheme = (next: ThemeSetting): void => {
    setTheme(next);
    saveTheme(typeof localStorage !== "undefined" ? localStorage : null, next);
    applyTheme(next);
  };

  return (
    <div className="settings-root" ref={rootRef}>
      <Button
        type="button"
        variant="secondary"
        size="icon"
        className="min-h-[44px] min-w-[44px]"
        aria-label="设置"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <GearIcon />
      </Button>
      {open && (
        <div className="card settings-panel" role="dialog" aria-label="设置">
          <div className="notif-panel-head">
            <span className="notif-panel-title">提醒</span>
          </div>
          <ToggleRow
            label="提示音"
            checked={settings.sound}
            onChange={(sound) => updateSettings({ ...settings, sound })}
          />
          <ToggleRow
            label="震动"
            checked={settings.vibrate}
            onChange={(vibrate) => updateSettings({ ...settings, vibrate })}
          />
          <ToggleRow
            label="完结横幅"
            checked={settings.banner}
            onChange={(banner) => updateSettings({ ...settings, banner })}
          />
          <div className="notif-panel-head">
            <span className="notif-panel-title">主题</span>
          </div>
          <div className="theme-row" role="radiogroup" aria-label="主题">
            {THEME_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant={theme === option.value ? "default" : "outline"}
                size="sm"
                role="radio"
                aria-checked={theme === option.value}
                onClick={() => updateTheme(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
