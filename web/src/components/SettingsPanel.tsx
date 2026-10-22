/**
 * 设置面板内容（设置页主体）：提醒通道开关（声音/震动/横幅，localStorage 可静音）
 * + 主题三态 + 关于/版本。原 header 齿轮下拉 SettingsMenu 的内容全部迁移至此。
 * 与 NoticeBanner 解耦：写入 localStorage，提醒发生时读取。
 */
import { useEffect, useState } from "react";
import {
  DEFAULT_NOTIFY_SETTINGS,
  loadNotifySettings,
  saveNotifySettings,
  type NotifySettings,
} from "../utils/notify";
import { applyTheme, loadTheme, saveTheme, type ThemeSetting } from "../utils/theme";
import { useLocale, useT } from "../i18n/provider";
import type { LocaleSetting } from "../i18n";
import { AppLockSettings } from "./AppLockSettings";
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

export function SettingsPanel() {
  const [settings, setSettings] = useState<NotifySettings>(DEFAULT_NOTIFY_SETTINGS);
  const [theme, setTheme] = useState<ThemeSetting>("system");
  const t = useT();
  const { setting: localeSetting, setSetting: setLocale } = useLocale();

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
    <div className="settings-panel-page">
      <section className="card settings-section" aria-label="主题">
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
      </section>

      {/* 语言三态（i18n）：跟随系统 / 中文 / English，localStorage 持久化 + <html lang> 同步 */}
      <section className="card settings-section" aria-label={t("settings.locale")}>
        <div className="notif-panel-head">
          <span className="notif-panel-title">{t("settings.locale")}</span>
        </div>
        <select
          className="locale-select"
          value={localeSetting}
          onChange={(e) => setLocale(e.target.value as LocaleSetting)}
          aria-label={t("settings.locale")}
        >
          <option value="system">{t("settings.locale.system")}</option>
          <option value="zh">{t("settings.locale.zh")}</option>
          <option value="en">{t("settings.locale.en")}</option>
        </select>
      </section>

      <section className="card settings-section" aria-label="提醒">
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
      </section>

      <AppLockSettings />

      <section className="card settings-section" aria-label="关于">
        <div className="notif-panel-head">
          <span className="notif-panel-title">关于</span>
        </div>
        <div className="settings-about">
          <div className="settings-about-name">Agent Hub</div>
          <div className="hint-text">pi / Claude Code / Codex 会话中枢</div>
          <div className="settings-about-version">
            版本 v{typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"}
            {typeof __GIT_SHA__ === "string" && __GIT_SHA__ !== "unknown" ? ` (${__GIT_SHA__})` : ""}
          </div>
        </div>
      </section>
    </div>
  );
}
