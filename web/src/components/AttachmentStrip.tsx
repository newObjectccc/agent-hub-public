import { useState } from "react";
import type { Attachment } from "../utils/uploads";
import { formatBytes, uploadRef } from "../utils/uploads";

export interface AttachmentStripProps {
  attachments: Attachment[];
  /** 删除附件（同步移除输入框内对应 `@path` 引用） */
  onRemove: (id: string) => void;
}

/**
 * 附件预览条（输入框上方）：图片缩略图 + 文件名，逐个可删除。
 * 图片懒加载：默认只渲染占位块（不解码大体积 preview data URL），点击缩略图
 * 才加载原图预览（图片解码/内存开销推迟到真正需要时）。
 * 野兽派：硬边框、44px 触控；reduced-motion 下无动画（样式层处理）。
 */
export function AttachmentStrip({ attachments, onRemove }: AttachmentStripProps) {
  const [loadedThumbs, setLoadedThumbs] = useState<Record<string, boolean>>({});
  if (attachments.length === 0) return null;
  return (
    <div className="attach-strip" aria-label="附件预览" role="list">
      {attachments.map((a) => (
        <div className="attach-chip" role="listitem" key={a.id} title={`${uploadRef(a.path)} · ${formatBytes(a.size)}`}>
          {a.isImage && a.preview ? (
            <img
              className={`attach-thumb${loadedThumbs[a.id] ? "" : " pending"}`}
              src={loadedThumbs[a.id] ? a.preview : undefined}
              alt={loadedThumbs[a.id] ? a.name : ""}
              aria-label={loadedThumbs[a.id] ? a.name : `加载 ${a.name} 预览`}
              title={loadedThumbs[a.id] ? a.name : "点击加载原图预览"}
              loading="lazy"
              decoding="async"
              onClick={() => setLoadedThumbs((prev) => ({ ...prev, [a.id]: true }))}
            />
          ) : (
            <span className="attach-thumb file" aria-hidden="true">
              📄
            </span>
          )}
          <span className="attach-name">{a.name}</span>
          <button
            type="button"
            className="attach-remove"
            aria-label={`移除附件 ${a.name}`}
            onClick={() => onRemove(a.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
