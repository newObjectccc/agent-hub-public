import { useRef } from "react";

export interface UploadButtonProps {
  /** 选中文件（相册/文件选择器）：调用方负责上传与插入引用 */
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  /** 上传进行中（显示忙碌态） */
  busy?: boolean;
}

/**
 * 📎 上传按钮（替代原 ⚡快捷指令）：点击唤起系统选择器（相册/文件），
 * `accept="image/*,*"` 图片优先但不设限（server 端白名单校验）。
 */
export function UploadButton({ onFiles, disabled, busy }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,*"
        multiple
        className="composer-file-input"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // 清空 value：同一文件可再次选择（不触发 change 的重复上传由调用方去重）
          e.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      <button
        type="button"
        className={`composer-btn upload-btn${busy ? " busy" : ""}`}
        aria-label="上传图片或文件"
        title="上传图片或文件（也支持直接粘贴图片）"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? <span className="spinner" /> : "📎"}
      </button>
    </>
  );
}
