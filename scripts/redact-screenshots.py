#!/usr/bin/env python3
"""README 截图脱敏（开源公开前隐私清理）。

对 docs/screenshots/ 的 5 张 PNG + demo.gif 的敏感区域打马赛克：
- /Users/<username> 本机路径、私人项目名 grow、个人用量数值、真实工作会话文本
保留：UI 骨架、功能标签、公开项目名 agent-hub、会话 UUID（无语义）、按钮/图标。

用法：python3 scripts/redact-screenshots.py [--check]
  默认从 docs/screenshots/*.src.png 备份还原后打码并覆盖正式文件；
  --check 只报告将打码的区域，不写文件。
坐标基于 393x873 移动视口；打码用马赛克（色块化），不使用高斯模糊（不可逆性更好）。
"""
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "docs" / "screenshots"

# 每图的敏感区域 (x0, y0, x1, y1)；马赛克块按区域高度自适应
RECTS = {
    # 工作台：两个用量面板整块（数值零泄漏）+ grow 卡（名称/路径/工作文本）+ agent-hub 卡路径与工作文本
    "workbench": [
        (12, 133, 382, 308),     # 用量面板 1（今日概览 tiles）
        (12, 308, 382, 462),     # 用量面板 2（活跃/完成 tiles）
        (12, 500, 382, 665),     # grow 卡整块（项目名 grow + 路径 + 工作文本）
        (12, 725, 382, 848),     # agent-hub 卡 cd /Users/... 与 bash/工作文本
    ],
    # Chat 工作页：思维过程正文 + 工具卡命令/路径（大色带，保 1269 字头部展示）
    "chat": [
        (12, 78, 382, 222),      # 顶部短文本 + 两个 read 路径 chip
        (12, 285, 382, 395),     # 思维过程正文 1269 字
        (12, 398, 382, 448),     # bash 命令 chip 1
        (12, 450, 382, 650),     # 思维过程 485 字头部/正文 + bash chip 2（整带）
    ],
    # 多子代理面板：工具命令/最近工具/结果正文（含模块名与工作文本）
    "subagent-panel": [
        (12, 150, 382, 220),     # 思维过程正文 + 状态文本（保留 169 字头部）
        (12, 222, 382, 270),     # bash sleep && cd /Use... chip
        (12, 468, 382, 515),     # 最近工具 ls -la /Users/... 行
        (12, 530, 382, 690),     # Explore#75fea489 结果正文整块（模块名/导出符号/工作文本）
    ],
    # 双模式弹层页：上层聊天工作文本与路径 chip（弹层本身是公开 UI 文案，保留）
    "feature-dual-mode": [
        (12, 75, 382, 145),      # 思维过程正文 readOnly/校验
        (12, 145, 382, 188),     # bash cd /Users/... chip
        (12, 285, 382, 355),     # 解锁成功…首页图（隐私检查）正文
        (12, 355, 382, 398),     # read /Users/... chip
        (12, 415, 382, 575),     # 工作台抓拍成功…正文
    ],
    # 应用锁页（工作台背景）：用量面板整块 + 两张卡的命令与工作文本
    "feature-lock": [
        (12, 133, 382, 308),
        (12, 308, 382, 462),
        (12, 555, 382, 675),     # grep 命令行 + 工作文本（问题根因…）
        (12, 730, 382, 855),     # cd /Users/... + 工作文本（面板结构…）
    ],
}

# demo.gif 帧 → 同源静态图的区域集（f1 为 chat 变体，区域单独定义）
FRAME_MAP = {
    0: "workbench",
    1: "__custom__",
    2: "feature-dual-mode",
    3: "chat",
    4: "subagent-panel",
}

# f1（chat 变体）文本位置与 chat.png 略有差异，单独覆盖
FRAME1_EXTRA = [
    (12, 80, 382, 150),      # 思维过程 485 字正文
    (12, 150, 382, 240),     # bash chip（cd /Users/...）
    (12, 275, 382, 320),     # 「点了平行继续」正文
    (12, 325, 382, 400),     # read chip
    (12, 480, 382, 660),     # 思维过程 4040 字头部/正文 + bash chip
]


def mosaic(img: Image.Image, box, block: int = 14) -> None:
    x0, y0, x1, y1 = box
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(img.width, x1), min(img.height, y1)
    if x1 <= x0 or y1 <= y0:
        return
    region = img.crop((x0, y0, x1, y1))
    small = region.resize((max(1, (x1 - x0) // block), max(1, (y1 - y0) // block)), Image.BILINEAR)
    img.paste(small.resize((x1 - x0, y1 - y0), Image.NEAREST), (x0, y0))


def redact_png(name: str, check: bool) -> None:
    src = SHOTS / f"{name}.src.png"
    dst = SHOTS / f"{name}.png"
    base = src if src.exists() else dst
    img = Image.open(base).convert("RGB")
    rects = RECTS[name]
    print(f"{name}.png: {len(rects)} rects")
    for r in rects:
        print(f"  {r}")
        if not check:
            mosaic(img, r)
    if not check:
        if not src.exists():
            dst.rename(src)  # 原图备份为 .src.png（不入库）
            img.save(SHOTS / f"{name}.png")
        else:
            img.save(dst)


def redact_gif(check: bool) -> None:
    src = SHOTS / "demo.src.gif"
    dst = SHOTS / "demo.gif"
    base = src if src.exists() else dst
    g = Image.open(base)
    frames, durations = [], []
    for i in range(g.n_frames):
        g.seek(i)
        frame = g.convert("RGB")
        key = FRAME_MAP[i]
        rects = list(FRAME1_EXTRA) if key == "__custom__" else list(RECTS[key])
        print(f"demo.gif frame {i} ({key}): {len(rects)} rects")
        for r in rects:
            print(f"  {r}")
            if not check:
                mosaic(frame, r)
        frames.append(frame)
        durations.append(g.info.get("duration", 200))
    if not check:
        if not src.exists():
            dst.rename(src)
        frames[0].save(
            SHOTS / "demo.gif",
            save_all=True,
            append_images=frames[1:],
            duration=durations,
            loop=0,
            optimize=False,
        )


if __name__ == "__main__":
    check = "--check" in sys.argv
    for name in RECTS:
        redact_png(name, check)
    redact_gif(check)
    print("check only" if check else "done")
