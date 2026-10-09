/**
 * 上传路由测试（契约 §11）：POST /api/uploads + prompt 图片附件（images 传给 hub 的通道 b）。
 * fake hub 捕获 prompt 第 4 参（PromptImageAttachment[]），验证 server 侧读盘/校验全链路。
 */
import { makeFakeDashboard } from "./fakeDashboard.js";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_CONFIG, type HubConfig } from "../config.js";
import { createApp } from "../index.js";
import type { SessionHubLike } from "../routes.js";
import type { PromptResult } from "../sessions/hub.js";
import type {
  MessageDto,
  PromptImageAttachment,
  SearchResultDto,
  SessionListItem,
  SessionTreeDto,
  SystemInfo,
} from "../types.js";
import { ErrorCodes } from "../errors.js";
import { MAX_UPLOAD_BYTES, UPLOAD_DIR_NAME } from "../uploads.js";
import { fakeUnlockedAppLock } from "./fakeAppLock.js";

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

const systemFixture: SystemInfo = {
  platform: "darwin",
  pi: { available: true, version: "0.87.1" },
  claude: { available: true, version: "2.1.267" },
  tmux: { available: false, version: null },
  ttyd: { available: false, version: null },
  tailscale: { available: false, version: null, loggedIn: false, hostname: null },
  sessionDir: "/tmp/sessions",
  workspaceRoot: "/tmp/ws",
  metrics: {
    cpu: { usagePercent: 1, cores: 8 },
    memory: { usedBytes: 1, totalBytes: 2, usagePercent: 50 },
    disk: { usedBytes: 1, totalBytes: 2, usagePercent: 50, mount: "/" },
    loadavg: [1, 1, 1],
    uptimeSeconds: 1,
    sampledAt: "2026-02-18T12:00:00.000Z",
  },
};

interface CapturedPrompt {
  id: string;
  text: unknown;
  modeRaw: unknown;
  images?: PromptImageAttachment[];
}

describe("uploads 路由：POST /api/uploads + prompt images", () => {
  let cwd: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  const captured: CapturedPrompt[] = [];
  const sessionFixture: SessionListItem = {
    id: "sess-up",
    source: "pi",
    name: null,
    cwd: "",
    updatedAt: "2026-02-18T12:00:00.000Z",
    messageCount: 0,
    status: "idle",
    lastUserMessage: null,
    lastAssistantMessage: null,
    sessionFile: "/tmp/sess-up.jsonl",
    isSubAgent: false,
  };

  function makeHub(): SessionHubLike {
    return {
      getStatus: () => "idle",
      listSessions: async () => [sessionFixture],
      findSession: async (id: string) => (id === "sess-up" ? sessionFixture : null),
      loadMessages: async (): Promise<MessageDto[]> => [],
      search: async (): Promise<SearchResultDto[]> => [],
      loadTree: async (): Promise<SessionTreeDto | null> => ({ entries: [], activePath: [] }),
      createSession: async () => sessionFixture,
      forkSession: async () => sessionFixture,
      prompt: async (id: string, text: unknown, modeRaw: unknown, images?: PromptImageAttachment[]): Promise<PromptResult> => {
        captured.push({ id, text, modeRaw, images });
        return { accepted: true, mode: "prompt" };
      },
      abort: async () => undefined,
      compact: async () => undefined,
    };
  }

  before(async () => {
    cwd = await mkdtemp(join(tmpdir(), "agent-hub-route-"));
    (sessionFixture as { cwd: string }).cwd = cwd;
    const config: HubConfig = { ...DEFAULT_CONFIG };
    app = await createApp({
      hub: makeHub(),
      dashboard: makeFakeDashboard(),
      kpi: { getCards: () => [] },
      config,
      systemInfo: async () => systemFixture,
      webRoot: null, appLock: fakeUnlockedAppLock(),
    });
  });

  after(async () => {
    await app.close();
    await rm(cwd, { recursive: true, force: true });
  });

  it("sessionId 上传成功：落盘 cwd/.agent-hub-uploads/，201 返回引用路径", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: { sessionId: "sess-up", name: "截图.png", mimeType: "image/png", data: PNG_BASE64 },
    });
    assert.equal(res.statusCode, 201);
    const { upload } = res.json() as {
      upload: { name: string; path: string; absPath: string; mimeType: string; size: number; isImage: boolean };
    };
    assert.equal(upload.name, "截图.png");
    assert.equal(upload.path, `${UPLOAD_DIR_NAME}/截图.png`);
    assert.equal(upload.mimeType, "image/png");
    assert.equal(upload.size, 8);
    assert.equal(upload.isImage, true);
    assert.ok(existsSync(upload.absPath));
    assert.ok(upload.absPath.startsWith(join(cwd, UPLOAD_DIR_NAME)));
  });

  it("显式 cwd 上传成功（无 sessionId）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: { cwd, name: "notes.md", mimeType: "text/markdown", data: Buffer.from("# hi").toString("base64") },
    });
    assert.equal(res.statusCode, 201);
    const { upload } = res.json() as { upload: { path: string; isImage: boolean } };
    assert.equal(upload.path, `${UPLOAD_DIR_NAME}/notes.md`);
    assert.equal(upload.isImage, false);
  });

  it("非法 base64 → 400 INVALID_REQUEST；非法类型 → 415；未知会话 → 404；相对 cwd → 400", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: { sessionId: "sess-up", name: "x.png", mimeType: "image/png", data: "not base64!!" },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal((bad.json() as { error: { code: string } }).error.code, ErrorCodes.INVALID_REQUEST);

    const badType = await app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: { sessionId: "sess-up", name: "evil.exe", mimeType: "application/x-msdownload", data: PNG_BASE64 },
    });
    assert.equal(badType.statusCode, 415);
    assert.equal((badType.json() as { error: { code: string } }).error.code, ErrorCodes.UNSUPPORTED_MEDIA_TYPE);

    const noSession = await app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: { sessionId: "nope", name: "x.png", mimeType: "image/png", data: PNG_BASE64 },
    });
    assert.equal(noSession.statusCode, 404);

    const relCwd = await app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: { cwd: "relative/dir", name: "x.png", mimeType: "image/png", data: PNG_BASE64 },
    });
    assert.equal(relCwd.statusCode, 400);
    assert.equal((relCwd.json() as { error: { code: string } }).error.code, ErrorCodes.INVALID_CWD);
  });

  it("body.cwd 收紧到 workspaceRoot / 已知会话 cwd：越界拒绝任意目录写入（审计 P1）", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agent-hub-outside-"));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/uploads",
        payload: { cwd: outside, name: "x.png", mimeType: "image/png", data: PNG_BASE64 },
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { error: { code: string } }).error.code, ErrorCodes.INVALID_CWD);
      assert.equal(existsSync(join(outside, UPLOAD_DIR_NAME)), false, "不得写入任意目录");

      // 已知会话 cwd 的子目录仍允许
      await mkdir(join(cwd, "sub"), { recursive: true });
      const ok = await app.inject({
        method: "POST",
        url: "/api/uploads",
        payload: { cwd: join(cwd, "sub"), name: "y.png", mimeType: "image/png", data: PNG_BASE64 },
      });
      assert.equal(ok.statusCode, 201);
      const { upload } = ok.json() as { upload: { absPath: string } };
      assert.ok(upload.absPath.startsWith(join(cwd, "sub", UPLOAD_DIR_NAME)), "落在会话 cwd 内");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("超大文件 → 413 UPLOAD_TOO_LARGE（bodyLimit 内、业务上限外）", async () => {
    const data = Buffer.alloc(MAX_UPLOAD_BYTES + 1024).toString("base64");
    const res = await app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: { sessionId: "sess-up", name: "big.png", mimeType: "image/png", data },
    });
    assert.equal(res.statusCode, 413);
    assert.equal((res.json() as { error: { code: string } }).error.code, ErrorCodes.UPLOAD_TOO_LARGE);
    assert.ok(!existsSync(join(cwd, UPLOAD_DIR_NAME, "big.png")));
  });

  it("prompt 带 images：上传图片以 PromptImageAttachment 传给 hub（pi 通道 b）", async () => {
    captured.length = 0;
    const upRes = await app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: { sessionId: "sess-up", name: "pic.png", mimeType: "image/png", data: PNG_BASE64 },
    });
    const { upload } = upRes.json() as { upload: { path: string } };
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-up/prompt",
      payload: { text: `看下这张图 @${upload.path}`, mode: "prompt", images: [upload.path] },
    });
    assert.equal(res.statusCode, 202);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].text, `看下这张图 @${upload.path}`);
    assert.equal(captured[0].images?.length, 1);
    assert.equal(captured[0].images?.[0].mimeType, "image/png");
    assert.equal(captured[0].images?.[0].path, upload.path);
    assert.equal(captured[0].images?.[0].data, PNG_BASE64);
  });

  it("prompt images 越界 / 非图片 / 超量 → 400/415（不进 hub）", async () => {
    captured.length = 0;
    const escape = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-up/prompt",
      payload: { text: "x", images: ["../secret.png"] },
    });
    assert.equal(escape.statusCode, 400);
    assert.equal((escape.json() as { error: { code: string } }).error.code, ErrorCodes.INVALID_PATH);

    const textFile = await app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: { sessionId: "sess-up", name: "note.txt", mimeType: "text/plain", data: Buffer.from("hi").toString("base64") },
    });
    const { upload } = textFile.json() as { upload: { path: string } };
    const notImage = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-up/prompt",
      payload: { text: "x", images: [upload.path] },
    });
    assert.equal(notImage.statusCode, 415);

    const tooMany = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-up/prompt",
      payload: { text: "x", images: new Array(9).fill(upload.path) },
    });
    assert.equal(tooMany.statusCode, 400);

    const notArray = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-up/prompt",
      payload: { text: "x", images: "pic.png" },
    });
    assert.equal(notArray.statusCode, 400);
    assert.equal(captured.length, 0);
  });

  it("prompt 不带 images：行为不变（images 为 undefined）", async () => {
    captured.length = 0;
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-up/prompt",
      payload: { text: "普通消息", mode: "steer" },
    });
    assert.equal(res.statusCode, 202);
    assert.equal(captured[0].images, undefined);
  });

  it("上传文件可读回原字节（落盘完整性）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: { sessionId: "sess-up", name: "bytes.bin.md", mimeType: "text/markdown", data: PNG_BASE64 },
    });
    const { upload } = res.json() as { upload: { absPath: string; name: string } };
    const buf = await readFile(upload.absPath);
    assert.equal(buf.toString("base64"), PNG_BASE64);
    assert.equal(upload.name, "bytes.bin.md");
    assert.ok((await stat(upload.absPath)).size === 8);
  });
});
