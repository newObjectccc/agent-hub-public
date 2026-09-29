// ANSI 彩色输出（Windows 10+ 控制台原生支持 VT 序列）。零依赖。
// NO_COLOR 环境变量或非 TTY 时自动降级为纯文本；FORCE_COLOR 强制开启。

function colorSupported(env = process.env, isTTY = Boolean(process.stdout.isTTY)) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  return isTTY;
}

const wrap = (open, close) => (enabled) => (text) =>
  enabled ? `\u001b[${open}m${text}\u001b[${close}m` : String(text);

const paint = {
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  bold: wrap(1, 22),
  dim: wrap(2, 22),
};

/**
 * 创建着色器集合。任何平台都输出 ASCII 状态标签，避免 Windows 控制台乱码。
 */
export function createColors(options = {}) {
  const enabled = options.enabled ?? colorSupported(options.env, options.isTTY);
  const colors = { enabled };
  for (const [name, make] of Object.entries(paint)) colors[name] = make(enabled);
  colors.ok = colors.green('[OK]');
  colors.warn = colors.yellow('[建议]');
  colors.fail = colors.red('[失败]');
  colors.info = colors.blue('[信息]');
  return colors;
}
