/**
 * i18n React 层：Provider（Context）+ useT() / useLocale()。
 * - I18nProvider 挂载即从 localStorage 恢复偏好（initLocale），并把 setting/locale/t 下发全树；
 *   切语言通过 Context value 变化全树重渲染。
 * - useT() 无 Provider 时回落模块级 store 订阅（useSyncExternalStore），
 *   既有单测直接裸挂组件也能翻译/随切换更新，无需逐个包 Provider。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createT,
  getLocale,
  getLocaleSetting,
  initLocale,
  loadLocaleSetting,
  setLocaleSetting,
  subscribeLocale,
  type Locale,
  type LocaleRuntime,
  type LocaleSetting,
  type TFunction,
} from "./index";

export interface I18nContextValue {
  locale: Locale;
  setting: LocaleSetting;
  setSetting: (setting: LocaleSetting) => void;
  t: TFunction;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export interface I18nProviderProps extends LocaleRuntime {
  children: ReactNode;
}

export function I18nProvider({ children, storage, doc, nav }: I18nProviderProps) {
  const [setting, setSettingState] = useState<LocaleSetting>(() =>
    loadLocaleSetting(storage !== undefined ? storage : typeof localStorage !== "undefined" ? localStorage : null),
  );
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);

  // 挂载即恢复：localStorage 偏好 → 检测/解析 → <html lang> 同步
  useEffect(() => {
    initLocale({ storage, doc, nav });
    // 挂载一次性恢复（storage/doc/nav 为稳定的可选注入，测试场景固定）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setSetting = useCallback(
    (next: LocaleSetting) => {
      setSettingState(next);
      setLocaleSetting(next, { storage, doc, nav });
    },
    [storage, doc, nav],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setting, setSetting, t: createT(locale) }),
    [locale, setting, setSetting],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** 当前语言 + 切换 API（设置页语言选择用）；无 Provider 时回落模块级 store */
export function useLocale(): Pick<I18nContextValue, "locale" | "setting" | "setSetting"> {
  const ctx = useContext(I18nContext);
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  const setting = useSyncExternalStore(subscribeLocale, getLocaleSetting, getLocaleSetting);
  const fallback = useMemo<I18nContextValue>(
    () => ({
      locale,
      setting,
      setSetting: (next: LocaleSetting) => {
        setLocaleSetting(next);
      },
      t: createT(locale),
    }),
    [locale, setting],
  );
  return ctx ?? fallback;
}

/** 翻译函数（绑定当前语言，切语言全树更新） */
export function useT(): TFunction {
  const { locale } = useLocale();
  return useMemo(() => createT(locale), [locale]);
}
