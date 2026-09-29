/**
 * 上传模块单测（契约 §11）：文件名清洗防穿越、类型白名单、大小限制、
 * 落盘位置（cwd/.agent-hub-uploads/ 与临时目录兜底）、prompt 附件装载。
 */
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { ErrorCodes, HubError } from "../errors.js";
import {
  appendAttachmentHints,
  decodeUploadData,
  loadImageAttachments,
  MAX_UPLOAD_BYTES,
  resolveUploadType,
  sanitizeSessionId,
  sanitizeUploadName,
  saveUpload,
  UPLOAD_DIR_NAME,
} from "../uploads.js";
import type { PromptImageAttachment } from "../types.js";

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

function expectHubError(fn: () => unknown, code: string, status: number): void {
  try {
    fn();
    assert.fail(`应当抛出 ${code}`);
  } catch (err) {
    assert.ok(err instanceof HubError, `期望 HubError，实际 ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.statusCode, status);
  }
}

async function expectHubErrorAsync(fn: () => Promise<unknown>, code: string, status: number): Promise<void> {
  try {
    await fn();
    assert.fail(`应当抛出 ${code}`);
  } catch (err) {
    assert.ok(err instanceof HubError, `期望 HubError，实际 ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.statusCode, status);
  }
}

describe("uploads: sanitizeUploadName（文件名清洗防穿越）", () => {
  it("Unix 路径穿越只留最后一段", () => {
    assert.equal(sanitizeUploadName("../../etc/passwd"), "passwd");
    assert.equal(sanitizeUploadName("a/b/c.png"), "c.png");
    assert.equal(sanitizeUploadName("/abs/path/x.txt"), "x.txt");
  });

  it("Windows 路径分隔与 UNC 同样清洗", () => {
    assert.equal(sanitizeUploadName("..\\..\\win.ini"), "win.ini");
    assert.equal(sanitizeUploadName("C:\\Users\\a\\b.png"), "b.png");
    assert.equal(sanitizeUploadName("dir\\sub\\c.log"), "c.log");
  });

  it("`..` 段被压平，清洗后不含 .. 与分隔符", () => {
    const name = sanitizeUploadName("a..b..c.png");
    assert.equal(name, "a.b.c.png");
    for (const raw of ["..", "../", "..%2f..%2fx.png", "....//evil.png"]) {
      const out = sanitizeUploadName(raw);
      assert.ok(!out.includes(".."), raw);
      assert.ok(!out.includes("/") && !out.includes("\\"), raw);
    }
  });

  it("控制字符 / 非法文件名字符剔除", () => {
    assert.equal(sanitizeUploadName("a\u0000b\u001f<c>:"), "abc");
    assert.equal(sanitizeUploadName("a|b?c*d.png"), "abcd.png");
  });

  it("空输入回退 upload.bin；伪装隐藏文件加前缀", () => {
    assert.equal(sanitizeUploadName(""), "upload.bin");
    assert.equal(sanitizeUploadName("   "), "upload.bin");
    assert.equal(sanitizeUploadName("..."), "upload.bin");
    assert.equal(sanitizeUploadName(".env"), "upload.env");
    assert.equal(sanitizeUploadName(null), "upload.bin");
    assert.equal(sanitizeUploadName(123), "upload.bin");
  });

  it("尾部点/空格剔除，中文等合法字符保留", () => {
    assert.equal(sanitizeUploadName("报告 2026.pdf  "), "报告 2026.pdf");
    assert.equal(sanitizeUploadName("截图.png."), "截图.png");
  });

  it("超长文件名限长且保留扩展名", () => {
    const long = `${"长".repeat(300)}.png`;
    const out = sanitizeUploadName(long);
    assert.ok(out.length <= 100, `实际 ${out.length}`);
    assert.ok(out.endsWith(".png"));
    assert.ok(!out.includes("/"));
  });
});

describe("uploads: resolveUploadType（MIME + 扩展名白名单）", () => {
  it("白名单 MIME 通过并规范化扩展名", () => {
    const t = resolveUploadType("a.png", "image/png");
    assert.equal(t.mimeType, "image/png");
    assert.equal(t.extension, "png");
    assert.equal(t.name, "a.png");
    assert.equal(resolveUploadType("a.jpeg", "image/jpg").mimeType, "image/jpeg");
  });

  it("MIME 与扩展名不一致时以 MIME 为准（防伪装）", () => {
    const t = resolveUploadType("evil.exe", "image/png");
    assert.equal(t.name, "evil.png");
    assert.equal(t.mimeType, "image/png");
    const t2 = resolveUploadType("payload.bin", "application/pdf");
    assert.equal(t2.name, "payload.pdf");
  });

  it("octet-stream / 空 MIME 走扩展名兜底", () => {
    assert.equal(resolveUploadType("notes.md", "application/octet-stream").mimeType, "text/markdown");
    assert.equal(resolveUploadType("app.log", "").mimeType, "text/plain");
    assert.equal(resolveUploadType("data.json", "application/octet-stream; charset=binary").mimeType, "application/json");
    assert.equal(resolveUploadType("photo.JPEG", null).mimeType, "image/jpeg");
  });

  it("白名单之外的类型拒绝（415 UNSUPPORTED_MEDIA_TYPE）", () => {
    expectHubError(() => resolveUploadType("evil.exe", "application/x-msdownload"), ErrorCodes.UNSUPPORTED_MEDIA_TYPE, 415);
    expectHubError(() => resolveUploadType("evil.exe", ""), ErrorCodes.UNSUPPORTED_MEDIA_TYPE, 415);
    expectHubError(() => resolveUploadType("noext", "application/x-sh"), ErrorCodes.UNSUPPORTED_MEDIA_TYPE, 415);
  });
});

describe("uploads: decodeUploadData（base64 与大小限制）", () => {
  it("合法 base64 解码回原字节", () => {
    const buf = decodeUploadData(PNG_BASE64);
    assert.equal(buf.length, 8);
  });

  it("非 base64 / 空值拒绝（400）", () => {
    expectHubError(() => decodeUploadData(""), ErrorCodes.INVALID_REQUEST, 400);
    expectHubError(() => decodeUploadData("not base64!!"), ErrorCodes.INVALID_REQUEST, 400);
    expectHubError(() => decodeUploadData(123), ErrorCodes.INVALID_REQUEST, 400);
    expectHubError(() => decodeUploadData(Buffer.alloc(0).toString("base64")), ErrorCodes.INVALID_REQUEST, 400);
  });

  it("超过大小上限拒绝（413，含 base64 长度预估阶段）", () => {
    const big = Buffer.alloc(64).toString("base64");
    expectHubError(() => decodeUploadData(big, 16), ErrorCodes.UPLOAD_TOO_LARGE, 413);
    assert.ok(MAX_UPLOAD_BYTES === 10 * 1024 * 1024);
  });
});

describe("uploads: saveUpload（落盘与路径安全）", () => {
  let cwd: string;
  before(async () => {
    cwd = await mkdtemp(join(tmpdir(), "agent-hub-up-"));
  });
  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("落盘到 cwd/.agent-hub-uploads/，返回相对引用路径", async () => {
    const up = await saveUpload({ cwd, name: "截图.png", mimeType: "image/png", data: PNG_BASE64 });
    assert.equal(up.path, `${UPLOAD_DIR_NAME}/截图.png`);
    assert.equal(up.name, "截图.png");
    assert.equal(up.mimeType, "image/png");
    assert.equal(up.size, 8);
    assert.equal(up.isImage, true);
    assert.ok(up.absPath.startsWith(resolve(cwd, UPLOAD_DIR_NAME)));
    const written = await readFile(up.absPath);
    assert.equal(written.toString("base64"), PNG_BASE64);
  });

  it("穿越文件名被清洗，文件仍在上传目录内", async () => {
    const up = await saveUpload({ cwd, name: "../../escape.png", mimeType: "image/png", data: PNG_BASE64 });
    assert.equal(up.name, "escape.png");
    assert.ok(up.absPath.startsWith(resolve(cwd, UPLOAD_DIR_NAME) + "/"));
    assert.ok(!existsSync(join(cwd, "..", "escape.png")));
  });

  it("重名自动加序号（不覆盖）", async () => {
    const a = await saveUpload({ cwd, name: "dup.txt", mimeType: "text/plain", data: Buffer.from("a").toString("base64") });
    const b = await saveUpload({ cwd, name: "dup.txt", mimeType: "text/plain", data: Buffer.from("b").toString("base64") });
    assert.equal(a.name, "dup.txt");
    assert.equal(b.name, "dup-1.txt");
    assert.equal(await readFile(a.absPath, "utf8"), "a");
    assert.equal(await readFile(b.absPath, "utf8"), "b");
  });

  it("cwd 不可用退临时目录（sessionId 清洗后入路径），返回绝对路径", async () => {
    const up = await saveUpload({
      cwd: join(cwd, "not-exist"),
      sessionId: "../../evil/../sess 1",
      name: "x.png",
      mimeType: "image/png",
      data: PNG_BASE64,
    });
    assert.ok(up.absPath.includes("agent-hub-uploads"));
    assert.ok(up.absPath.includes("sess-1"), up.absPath);
    assert.ok(up.path.startsWith("/"), "临时目录兜底返回绝对路径");
    assert.ok(!up.path.includes(".."));
    assert.ok(existsSync(up.absPath));
    await rm(up.absPath, { force: true });
  });

  it("超过大小上限拒绝（413）不落盘", async () => {
    await expectHubErrorAsync(
      async () =>
        saveUpload({ cwd, name: "big.png", mimeType: "image/png", data: Buffer.alloc(32).toString("base64"), maxBytes: 8 }),
      ErrorCodes.UPLOAD_TOO_LARGE,
      413,
    );
    assert.ok(!existsSync(join(cwd, UPLOAD_DIR_NAME, "big.png")));
  });

  it("非法类型拒绝（415）不落盘", async () => {
    await expectHubErrorAsync(
      async () => saveUpload({ cwd, name: "evil.exe", mimeType: "application/x-msdownload", data: PNG_BASE64 }),
      ErrorCodes.UNSUPPORTED_MEDIA_TYPE,
      415,
    );
  });

  it("sanitizeSessionId 只留安全字符", () => {
    assert.equal(sanitizeSessionId("../../x"), "x");
    assert.equal(sanitizeSessionId("a b/c"), "a-b-c");
    assert.equal(sanitizeSessionId(""), "misc");
  });
});

describe("uploads: loadImageAttachments（prompt 附件，通道 b）", () => {
  let cwd: string;
  before(async () => {
    cwd = await mkdtemp(join(tmpdir(), "agent-hub-att-"));
    await mkdir(join(cwd, UPLOAD_DIR_NAME), { recursive: true });
  });
  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("上传目录内图片 → { path, mimeType, data } base64 原样", async () => {
    const file = join(cwd, UPLOAD_DIR_NAME, "pic.png");
    await writeFile(file, Buffer.from([1, 2, 3]));
    const out = await loadImageAttachments(cwd, [`${UPLOAD_DIR_NAME}/pic.png`]);
    assert.equal(out.length, 1);
    assert.equal(out[0].path, `${UPLOAD_DIR_NAME}/pic.png`);
    assert.equal(out[0].mimeType, "image/png");
    assert.equal(Buffer.from(out[0].data, "base64").length, 3);
  });

  it("路径穿越 / 目录外绝对路径拒绝（400 INVALID_PATH）", async () => {
    const outside = join(cwd, "..", "outside.png");
    await writeFile(outside, Buffer.from([1]));
    try {
      await expectHubErrorAsync(
        async () => loadImageAttachments(cwd, ["../outside.png"]),
        ErrorCodes.INVALID_PATH,
        400,
      );
      await expectHubErrorAsync(
        async () => loadImageAttachments(cwd, [outside]),
        ErrorCodes.INVALID_PATH,
        400,
      );
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("附件不存在 404；非图片 415；条目非法 400", async () => {
    await expectHubErrorAsync(
      async () => loadImageAttachments(cwd, [`${UPLOAD_DIR_NAME}/missing.png`]),
      ErrorCodes.FILE_NOT_FOUND,
      404,
    );
    await writeFile(join(cwd, UPLOAD_DIR_NAME, "note.txt"), "hi");
    await expectHubErrorAsync(
      async () => loadImageAttachments(cwd, [`${UPLOAD_DIR_NAME}/note.txt`]),
      ErrorCodes.UNSUPPORTED_MEDIA_TYPE,
      415,
    );
    await expectHubErrorAsync(async () => loadImageAttachments(cwd, [""]), ErrorCodes.INVALID_REQUEST, 400);
    await expectHubErrorAsync(async () => loadImageAttachments(cwd, [123]), ErrorCodes.INVALID_REQUEST, 400);
    await expectHubErrorAsync(async () => loadImageAttachments(cwd, "nope" as unknown as string[]), ErrorCodes.INVALID_REQUEST, 400);
  });

  it("超过 8 张 / 超大文件拒绝（400 / 413）", async () => {
    await expectHubErrorAsync(
      async () => loadImageAttachments(cwd, new Array(9).fill(`${UPLOAD_DIR_NAME}/pic.png`)),
      ErrorCodes.INVALID_REQUEST,
      400,
    );
    const big = join(cwd, UPLOAD_DIR_NAME, "big.png");
    await writeFile(big, Buffer.alloc(0));
    await truncate(big, MAX_UPLOAD_BYTES + 1);
    assert.ok((await stat(big)).size > MAX_UPLOAD_BYTES);
    await expectHubErrorAsync(
      async () => loadImageAttachments(cwd, [`${UPLOAD_DIR_NAME}/big.png`]),
      ErrorCodes.UPLOAD_TOO_LARGE,
      413,
    );
    await rm(big, { force: true });
  });

  it("appendAttachmentHints：文本未引用时补 @path 提示（claude 通道 a）", () => {
    const imgs: PromptImageAttachment[] = [
      { path: `${UPLOAD_DIR_NAME}/a.png`, mimeType: "image/png", data: PNG_BASE64 },
      { path: `${UPLOAD_DIR_NAME}/b.png`, mimeType: "image/png", data: PNG_BASE64 },
    ];
    assert.equal(appendAttachmentHints("你好", undefined), "你好");
    assert.equal(appendAttachmentHints("你好", []), "你好");
    const hinted = appendAttachmentHints("看下这张图", imgs);
    assert.ok(hinted.startsWith("看下这张图\n\n"));
    assert.ok(hinted.includes(`@${UPLOAD_DIR_NAME}/a.png`));
    assert.ok(hinted.includes(`@${UPLOAD_DIR_NAME}/b.png`));
    // 已引用的路径不重复提示
    const once = appendAttachmentHints(`看下 @${UPLOAD_DIR_NAME}/a.png`, imgs);
    assert.ok(!once.includes(`@${UPLOAD_DIR_NAME}/a.png（`));
    assert.ok(once.includes(`@${UPLOAD_DIR_NAME}/b.png`));
    assert.equal(appendAttachmentHints("", [imgs[0]]), `[附件图片] @${UPLOAD_DIR_NAME}/a.png（请用 Read 工具查看）`);
  });
});
