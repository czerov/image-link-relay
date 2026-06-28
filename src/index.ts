export interface Env {
  DB: D1Database;
  TELEGRAPH_UPLOAD_URL: string;
  PUBLIC_IMAGE_BASE_URL?: string;
  MAX_UPLOAD_BYTES?: string;
  HISTORY_LIMIT?: string;
  PAGE_TITLE?: string;
  UPLOAD_SECRET?: string;
}

type UploadRecord = {
  id: string;
  url: string;
  source_path: string | null;
  file_name: string | null;
  content_type: string;
  size_bytes: number;
  created_at: string;
};

type ClientUploadRecord = {
  id: string;
  url: string;
  sourcePath?: string;
  fileName?: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return renderApp(env);
      }

      if (request.method === "POST" && url.pathname === "/upload") {
        return handleUpload(request, env, ctx);
      }

      if (request.method === "GET" && url.pathname === "/api/images") {
        return getImages(request, env);
      }

      const imageDeleteMatch = url.pathname.match(/^\/api\/images\/([^/]+)$/);
      if (request.method === "DELETE" && imageDeleteMatch) {
        return deleteImage(request, env, imageDeleteMatch[1]);
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "Unhandled request error",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return json({ ok: false, error: "Internal server error" }, 500);
    }
  },
};

async function handleUpload(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const auth = await authorize(request, env);
    if (!auth.ok) {
      return json({ ok: false, error: auth.error }, auth.status);
    }

    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return json({ ok: false, error: "Use multipart/form-data with field name file" }, 400);
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!isFileLike(file)) {
      return json({ ok: false, error: "Missing image file" }, 400);
    }

    const normalizedType = normalizeContentType(file.type);
    if (!IMAGE_TYPES.has(normalizedType)) {
      return json({ ok: false, error: "Only jpg, png, gif, webp, and avif images are allowed" }, 415);
    }

    const maxBytes = parsePositiveInt(env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024);
    if (file.size <= 0) {
      return json({ ok: false, error: "Image file is empty" }, 400);
    }
    if (file.size > maxBytes) {
      return json({ ok: false, error: `Image is too large; max ${formatBytes(maxBytes)}` }, 413);
    }

    const uploaded = await uploadToTelegraph(file, normalizedType, env);
    const record: UploadRecord = {
      id: crypto.randomUUID(),
      url: uploaded.url,
      source_path: uploaded.sourcePath,
      file_name: file.name || null,
      content_type: normalizedType,
      size_bytes: file.size,
      created_at: new Date().toISOString(),
    };

    await env.DB.prepare(
      `INSERT INTO uploaded_images (
        id,
        url,
        source_path,
        file_name,
        content_type,
        size_bytes,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        record.id,
        record.url,
        record.source_path,
        record.file_name,
        record.content_type,
        record.size_bytes,
        record.created_at,
      )
      .run();

    ctx.waitUntil(
      Promise.resolve().then(() => {
        console.log(
          JSON.stringify({
            level: "info",
            message: "Image uploaded through Telegraph",
            id: record.id,
            sizeBytes: record.size_bytes,
            contentType: record.content_type,
          }),
        );
      }),
    );

    return json({ ok: true, image: toClientRecord(record) }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        level: "error",
        message: "Upload failed",
        error: message,
      }),
    );
    return json({ ok: false, error: message }, 500);
  }
}

async function getImages(request: Request, env: Env): Promise<Response> {
  const auth = await authorize(request, env);
  if (!auth.ok) {
    return json({ ok: false, error: auth.error }, auth.status);
  }

  const limit = Math.min(parsePositiveInt(env.HISTORY_LIMIT, 24), 100);
  const result = await env.DB.prepare(
    `SELECT
      id,
      url,
      source_path,
      file_name,
      content_type,
      size_bytes,
      created_at
    FROM uploaded_images
    ORDER BY created_at DESC
    LIMIT ?`,
  )
    .bind(limit)
    .all<UploadRecord>();

  return json({
    ok: true,
    images: (result.results ?? []).map(toClientRecord),
  });
}

async function deleteImage(request: Request, env: Env, rawId: string): Promise<Response> {
  const auth = await authorize(request, env);
  if (!auth.ok) {
    return json({ ok: false, error: auth.error }, auth.status);
  }

  const id = decodeURIComponent(rawId).trim();
  if (!id) {
    return json({ ok: false, error: "Missing image id" }, 400);
  }

  const result = await env.DB.prepare("DELETE FROM uploaded_images WHERE id = ?").bind(id).run();
  if ((result.meta.changes ?? 0) === 0) {
    return json({ ok: false, error: "Image record not found" }, 404);
  }

  return json({ ok: true, id });
}

async function uploadToTelegraph(
  file: File,
  contentType: string,
  env: Env,
): Promise<{ url: string; sourcePath: string | null }> {
  const formData = new FormData();
  formData.append("file", new Blob([await file.arrayBuffer()], { type: contentType }), file.name || "image");

  const response = await fetch(env.TELEGRAPH_UPLOAD_URL, {
    method: "POST",
    body: formData,
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Telegraph upload failed with HTTP ${response.status}`);
  }

  const result = await response.json<unknown>();
  const parsed = parseTelegraphImageUrl(result, env.PUBLIC_IMAGE_BASE_URL);
  const uploadedUrl = parsed.url;
  if (!uploadedUrl) {
    throw new Error("Telegraph upload response did not include an image URL");
  }

  return {
    url: uploadedUrl,
    sourcePath: parsed.sourcePath,
  };
}

function parseTelegraphImageUrl(
  result: unknown,
  publicImageBaseUrl: string | undefined,
): { url: string | null; sourcePath: string | null } {
  const first = Array.isArray(result) ? result[0] : result;
  if (!first || typeof first !== "object") {
    return { url: null, sourcePath: null };
  }

  const record = first as Record<string, unknown>;
  const raw = record.url ?? record.src ?? record.path;
  if (typeof raw !== "string" || raw.length === 0) {
    return { url: null, sourcePath: null };
  }

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return { url: raw, sourcePath: raw };
  }

  if (!publicImageBaseUrl) {
    return { url: raw, sourcePath: raw };
  }

  const base = publicImageBaseUrl.replace(/\/+$/, "");
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return {
    url: `${base}${path}`,
    sourcePath: raw,
  };
}

async function authorize(
  request: Request,
  env: Env,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!env.UPLOAD_SECRET) {
    return { ok: true };
  }

  const url = new URL(request.url);
  const provided = request.headers.get("x-upload-secret") ?? url.searchParams.get("secret") ?? "";
  const matched = await constantTimeEqual(provided, env.UPLOAD_SECRET);
  if (!matched) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return { ok: true };
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }

  const aDigest = await crypto.subtle.digest("SHA-256", aBytes);
  const bDigest = await crypto.subtle.digest("SHA-256", bBytes);
  const aHash = new Uint8Array(aDigest);
  const bHash = new Uint8Array(bDigest);
  let diff = 0;
  for (let index = 0; index < aHash.length; index += 1) {
    diff |= aHash[index] ^ bHash[index];
  }

  return diff === 0;
}

function toClientRecord(record: UploadRecord): ClientUploadRecord {
  return {
    id: record.id,
    url: record.url,
    sourcePath: record.source_path ?? undefined,
    fileName: record.file_name ?? undefined,
    contentType: record.content_type,
    sizeBytes: record.size_bytes,
    createdAt: record.created_at,
  };
}

function normalizeContentType(value: string): string {
  const normalized = value.toLowerCase().split(";")[0].trim();
  if (normalized === "image/jpg") {
    return "image/jpeg";
  }
  return normalized || "application/octet-stream";
}

function isFileLike(value: unknown): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "size" in value &&
    "type" in value &&
    "arrayBuffer" in value
  );
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function renderApp(env: Env): Response {
  const title = escapeHtml(env.PAGE_TITLE ?? "图床上传");
  const maxBytes = parsePositiveInt(env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024);
  const maxBytesLabel = escapeHtml(formatBytes(maxBytes));

  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f9fb;
      --surface: #ffffff;
      --surface-soft: #f2f6f8;
      --surface-tint: #eef8f7;
      --line: #dde6ea;
      --line-strong: #bfd0d8;
      --text: #17222b;
      --muted: #64727f;
      --quiet: #8b99a5;
      --accent: #0b8f83;
      --accent-strong: #076b63;
      --accent-soft: #dff4f1;
      --blue: #2563eb;
      --blue-soft: #e8f0ff;
      --danger: #c83d4a;
      --danger-soft: #fff0f2;
      --success: #13795b;
      --success-soft: #e4f7ef;
      --shadow: 0 22px 70px rgba(28, 45, 58, 0.12);
      --shadow-soft: 0 10px 28px rgba(28, 45, 58, 0.08);
      --radius: 8px;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    button,
    input,
    a {
      font: inherit;
    }

    a {
      text-decoration: none;
    }

    .shell {
      width: min(100% - 32px, 1120px);
      margin: 0 auto;
      padding: 26px 0 34px;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 18px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .brand-mark,
    .upload-glyph {
      display: inline-grid;
      place-items: center;
      flex: 0 0 auto;
    }

    h1 {
      margin: 0;
      font-size: clamp(25px, 4vw, 34px);
      line-height: 1.08;
      font-weight: 780;
      letter-spacing: 0;
    }

    .subline {
      margin-top: 3px;
      color: var(--muted);
      font-size: 13px;
    }

    .secret-box {
      display: grid;
      grid-template-columns: minmax(190px, 260px) auto auto;
      gap: 8px;
      align-items: center;
      max-width: 560px;
    }

    .secret-box input {
      width: 100%;
      height: 40px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 12px;
      background: var(--surface);
      color: var(--text);
      outline: none;
      box-shadow: inset 0 1px 0 rgba(23, 34, 43, 0.02);
    }

    .secret-box input:focus,
    .url-input:focus {
      border-color: rgba(11, 143, 131, 0.65);
      box-shadow: 0 0 0 3px rgba(11, 143, 131, 0.12);
    }

    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      height: 40px;
      min-width: 40px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 14px;
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
      box-shadow: 0 1px 0 rgba(23, 34, 43, 0.03);
      transition: transform 160ms ease, border-color 160ms ease, background 160ms ease, box-shadow 160ms ease;
    }

    .button:hover {
      transform: translateY(-1px);
      border-color: var(--line-strong);
      background: #fbfcfd;
      box-shadow: var(--shadow-soft);
    }

    .button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #ffffff;
    }

    .button.ghost {
      background: var(--surface-soft);
      color: var(--muted);
    }

    .button.danger {
      border-color: #f1c4ca;
      background: var(--danger-soft);
      color: var(--danger);
    }

    .button svg {
      width: 16px;
      height: 16px;
      stroke-width: 2;
    }

    .button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
      transform: none;
      box-shadow: none;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 352px;
      gap: 16px;
      align-items: start;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: var(--shadow-soft);
      overflow: hidden;
    }

    .upload-panel {
      display: grid;
      grid-template-rows: auto auto 1fr auto;
    }

    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }

    .panel-title {
      margin: 0;
      font-size: 14px;
      font-weight: 760;
    }

    .panel-kicker {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .hint {
      color: var(--muted);
      font-size: 12px;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 26px;
      border-radius: 999px;
      padding: 0 10px;
      background: var(--surface-soft);
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .pill.ok {
      background: var(--success-soft);
      color: var(--success);
    }

    .dropzone {
      display: grid;
      place-items: center;
      min-height: 206px;
      margin: 14px 16px;
      border: 1px dashed #a9c9d1;
      border-radius: var(--radius);
      background:
        linear-gradient(180deg, rgba(238, 248, 247, 0.75), rgba(255, 255, 255, 0.86)),
        var(--surface);
      text-align: center;
      padding: 22px;
      cursor: pointer;
      transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
    }

    .dropzone.is-locked {
      cursor: not-allowed;
      background: linear-gradient(180deg, #f5f7f9, #ffffff);
      border-color: var(--line);
    }

    .dropzone.is-drag {
      border-color: var(--accent);
      background: var(--accent-soft);
      transform: translateY(-1px);
    }

    .drop-inner {
      display: grid;
      justify-items: center;
      gap: 10px;
    }

    .upload-glyph {
      width: 50px;
      height: 50px;
      border-radius: 16px;
      background: #ffffff;
      color: var(--accent);
      box-shadow: 0 9px 24px rgba(11, 143, 131, 0.14);
    }

    .dropzone strong {
      display: block;
      margin-bottom: 3px;
      font-size: 17px;
      line-height: 1.2;
    }

    .dropzone span {
      color: var(--muted);
      font-size: 13px;
    }

    .file-input {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }

    .result {
      display: none;
      gap: 12px;
      padding: 0 16px 14px;
    }

    .result.is-visible {
      display: grid;
    }

    .result-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--success);
      font-weight: 720;
    }

    .preview {
      width: 100%;
      max-height: 250px;
      border-radius: var(--radius);
      border: 1px solid var(--line);
      object-fit: contain;
      background: var(--surface-soft);
    }

    .url-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
    }

    .url-input {
      min-width: 0;
      height: 40px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 12px;
      background: var(--surface);
      color: var(--text);
      outline: none;
    }

    .history-list {
      display: grid;
      gap: 8px;
      padding: 10px;
      max-height: 560px;
      overflow: auto;
    }

    .history-item {
      display: grid;
      grid-template-columns: 56px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 8px;
      background: var(--surface);
      transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
    }

    .history-item:hover {
      border-color: var(--line-strong);
      box-shadow: var(--shadow-soft);
      transform: translateY(-1px);
    }

    .history-item img {
      width: 56px;
      height: 56px;
      object-fit: cover;
      border-radius: 6px;
      background: var(--surface-soft);
    }

    .history-meta {
      min-width: 0;
      display: grid;
      gap: 5px;
    }

    .history-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 720;
    }

    .history-url {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-size: 11px;
    }

    .history-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .small-button {
      height: 30px;
      padding: 0 10px;
      border-radius: 5px;
      font-size: 12px;
    }

    .status {
      min-height: 38px;
      padding: 0 16px 14px;
      color: var(--muted);
      font-size: 13px;
    }

    .status.error {
      color: var(--danger);
    }

    .status.ok {
      color: var(--accent);
    }

    .auth-note {
      grid-column: 1 / -1;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
    }

    .auth-note.is-ok {
      color: var(--accent);
    }

    .empty {
      padding: 28px 12px;
      color: var(--muted);
      text-align: center;
      border: 1px dashed var(--line);
      border-radius: var(--radius);
      background: var(--surface-soft);
      font-size: 13px;
    }

    .security-strip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 10px 12px;
      background: var(--surface);
      box-shadow: 0 1px 0 rgba(23, 34, 43, 0.02);
    }

    .security-strip strong {
      display: block;
      font-size: 13px;
    }

    .security-strip span {
      color: var(--muted);
      font-size: 12px;
    }

    .mobile-only {
      display: none;
    }

    @media (max-width: 860px) {
      .topbar {
        align-items: stretch;
        flex-direction: column;
      }

      .layout {
        display: flex;
        flex-direction: column;
      }

      .secret-box {
        width: 100%;
        max-width: none;
        grid-template-columns: minmax(0, 1fr) auto auto;
      }

      .panel {
        width: 100%;
      }

      .security-strip {
        align-items: flex-start;
        flex-direction: column;
      }
    }

    @media (max-width: 560px) {
      .shell {
        width: min(100% - 20px, 1080px);
        padding-top: 18px;
      }

      .brand {
        align-items: flex-start;
      }

      .secret-box {
        grid-template-columns: 1fr 1fr;
      }

      .secret-box input,
      .auth-note {
        grid-column: 1 / -1;
      }

      .button {
        padding: 0 10px;
      }

      .url-row {
        grid-template-columns: 1fr;
      }

      .dropzone {
        min-height: 176px;
        margin: 12px;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
            <rect width="40" height="40" rx="8" fill="#0b8f83"></rect>
            <path d="M12 25.5h16M15 18.5l5-5 5 5M20 14v15" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path>
          </svg>
        </span>
        <div>
          <h1>${title}</h1>
          <div class="subline">上传后生成图片地址，右键可复制</div>
        </div>
      </div>
      <div class="secret-box">
        <input id="secretInput" type="password" placeholder="上传密钥" autocomplete="off">
        <button id="saveSecretButton" class="button primary" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"></path><path d="M17 21v-8H7v8"></path><path d="M7 3v5h8"></path></svg>
          保存
        </button>
        <button id="logoutSecretButton" class="button danger" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="M16 17l5-5-5-5"></path><path d="M21 12H9"></path></svg>
          退出
        </button>
        <div id="authNote" class="auth-note">输入密钥后才能上传和查看最近上传。退出会清除当前浏览器保存的密钥，并锁定上传与历史列表。</div>
      </div>
    </header>

    <div class="security-strip">
      <div>
        <strong>密钥保存在当前浏览器</strong>
        <span>退出只清除本机密钥，不会删除已上传图片或历史记录。</span>
      </div>
      <span id="authState" class="pill">未解锁</span>
    </div>

    <section class="layout">
      <section class="panel upload-panel">
        <div class="panel-head">
          <div class="panel-kicker">
            <h2 class="panel-title">上传图片</h2>
            <span class="pill">最大 ${maxBytesLabel}</span>
          </div>
          <span class="hint">jpg / png / gif / webp / avif</span>
        </div>
        <label id="dropzone" class="dropzone">
          <input id="fileInput" class="file-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/avif">
          <span class="drop-inner">
            <span class="upload-glyph" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M17 8l-5-5-5 5"></path><path d="M12 3v12"></path></svg>
            </span>
            <span><strong id="dropTitle">先输入密钥</strong><span id="dropHint">保存密钥后可上传图片</span></span>
          </span>
        </label>
        <div id="result" class="result">
          <div class="result-title">
            <span>图片地址已生成</span>
            <span class="hint">右键预览图也可复制</span>
          </div>
          <img id="preview" class="preview" alt="上传后的图片预览">
          <div class="url-row">
            <input id="urlInput" class="url-input" readonly>
            <button id="copyButton" class="button primary" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>
              复制地址
            </button>
          </div>
        </div>
        <div id="status" class="status" aria-live="polite"></div>
      </section>

      <aside class="panel">
        <div class="panel-head">
          <h2 class="panel-title">最近上传</h2>
          <button id="refreshButton" class="button small-button" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"></path><path d="M3 21v-5h5"></path><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"></path><path d="M21 3v5h-5"></path></svg>
            刷新
          </button>
        </div>
        <div id="history" class="history-list"></div>
      </aside>
    </section>
  </main>

  <script>
    const fileInput = document.querySelector("#fileInput");
    const dropzone = document.querySelector("#dropzone");
    const result = document.querySelector("#result");
    const preview = document.querySelector("#preview");
    const urlInput = document.querySelector("#urlInput");
    const copyButton = document.querySelector("#copyButton");
    const statusEl = document.querySelector("#status");
    const historyEl = document.querySelector("#history");
    const refreshButton = document.querySelector("#refreshButton");
    const secretInput = document.querySelector("#secretInput");
    const saveSecretButton = document.querySelector("#saveSecretButton");
    const logoutSecretButton = document.querySelector("#logoutSecretButton");
    const authNote = document.querySelector("#authNote");
    const authState = document.querySelector("#authState");
    const dropTitle = document.querySelector("#dropTitle");
    const dropHint = document.querySelector("#dropHint");

    secretInput.value = localStorage.getItem("uploadSecret") || "";
    let hasSecret = Boolean(secretInput.value.trim());

    function setStatus(message, type = "") {
      statusEl.textContent = message;
      statusEl.className = "status" + (type ? " " + type : "");
    }

    function secretHeaders() {
      const secret = localStorage.getItem("uploadSecret") || "";
      return secret ? { "x-upload-secret": secret } : {};
    }

    function syncAuthState(message) {
      hasSecret = Boolean((localStorage.getItem("uploadSecret") || "").trim());
      fileInput.disabled = !hasSecret;
      dropzone.classList.toggle("is-locked", !hasSecret);
      refreshButton.disabled = !hasSecret;
      logoutSecretButton.disabled = !hasSecret;
      authNote.classList.toggle("is-ok", hasSecret);
      authState.classList.toggle("ok", hasSecret);

      if (hasSecret) {
        dropTitle.textContent = "拖入图片，或点击选择";
        dropHint.textContent = "支持 jpg / png / gif / webp / avif";
        authState.textContent = "已解锁";
        authNote.textContent = "密钥已保存到当前浏览器。退出后会清除密钥，上传和最近上传会重新锁定。";
        if (message) setStatus(message, "ok");
      } else {
        dropTitle.textContent = "先输入密钥";
        dropHint.textContent = "保存密钥后可上传图片";
        authState.textContent = "未解锁";
        authNote.textContent = "输入密钥后才能上传和查看最近上传。退出会清除当前浏览器保存的密钥，并锁定上传与历史列表。";
        historyEl.innerHTML = '<div class="empty">输入密钥后显示最近上传</div>';
        result.classList.remove("is-visible");
        urlInput.value = "";
        preview.removeAttribute("src");
        setStatus(message || "请先输入密钥", "");
      }
    }

    function formatBytes(value) {
      if (value >= 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + " MB";
      if (value >= 1024) return (value / 1024).toFixed(1) + " KB";
      return value + " B";
    }

    function escapeText(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);
    }

    async function copyText(value) {
      await navigator.clipboard.writeText(value);
      setStatus("已复制图片地址", "ok");
    }

    async function uploadFile(file) {
      if (!hasSecret) {
        setStatus("请先输入并保存密钥", "error");
        return;
      }
      if (!file) return;
      setStatus("正在上传到 Telegraph-Image...");

      const data = new FormData();
      data.append("file", file);

      try {
        const response = await fetch("/upload", {
          method: "POST",
          body: data,
          headers: secretHeaders()
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "上传失败");
        }

        showResult(payload.image);
        prependHistory(payload.image);
        setStatus("上传成功，图片地址已经生成", "ok");
      } catch (error) {
        setStatus(error.message || "上传失败", "error");
      }
    }

    function showResult(image) {
      preview.src = image.url;
      urlInput.value = image.url;
      result.classList.add("is-visible");
    }

    function historyItem(image) {
      const article = document.createElement("article");
      article.className = "history-item";
      article.innerHTML = \`
        <img src="\${escapeText(image.url)}" alt="">
        <div class="history-meta">
          <div class="history-name">\${escapeText(image.fileName || "image")}</div>
          <div class="history-url">\${escapeText(image.url)}</div>
          <div class="hint">\${escapeText(formatBytes(image.sizeBytes || 0))}</div>
          <div class="history-actions">
            <button class="button small-button" type="button" data-copy>复制</button>
            <a class="button small-button" href="\${escapeText(image.url)}" target="_blank" rel="noreferrer">打开</a>
            <button class="button small-button danger" type="button" data-delete>删除</button>
          </div>
        </div>
      \`;
      article.querySelector("[data-copy]").addEventListener("click", () => copyText(image.url));
      article.querySelector("[data-delete]").addEventListener("click", () => deleteHistoryItem(image.id, article));
      article.querySelector("img").addEventListener("contextmenu", async (event) => {
        event.preventDefault();
        await copyText(image.url);
      });
      return article;
    }

    function prependHistory(image) {
      const empty = historyEl.querySelector(".empty");
      if (empty) empty.remove();
      historyEl.prepend(historyItem(image));
    }

    async function deleteHistoryItem(id, itemEl) {
      if (!hasSecret) {
        setStatus("请先输入并保存密钥", "error");
        return;
      }
      if (!window.confirm("只删除 D1 历史记录，不会删除外部图床原图。确定删除这条记录吗？")) {
        return;
      }

      setStatus("正在删除历史记录...");
      try {
        const response = await fetch("/api/images/" + encodeURIComponent(id), {
          method: "DELETE",
          headers: secretHeaders()
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "删除失败");
        }

        itemEl.remove();
        if (!historyEl.querySelector(".history-item")) {
          historyEl.innerHTML = '<div class="empty">还没有上传记录</div>';
        }
        setStatus("已删除 D1 历史记录", "ok");
      } catch (error) {
        setStatus(error.message || "删除失败", "error");
      }
    }

    async function loadHistory() {
      if (!hasSecret) {
        historyEl.innerHTML = '<div class="empty">输入密钥后显示最近上传</div>';
        return;
      }
      historyEl.innerHTML = '<div class="empty">正在读取最近上传...</div>';
      try {
        const response = await fetch("/api/images", { headers: secretHeaders() });
        const payload = await response.json();
        if (response.status === 401) {
          localStorage.removeItem("uploadSecret");
          syncAuthState("密钥不正确或已失效，请重新输入");
          secretInput.focus();
          return;
        }
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "读取失败");
        }

        historyEl.innerHTML = "";
        const images = Array.isArray(payload.images) ? payload.images : [];
        if (images.length === 0) {
          historyEl.innerHTML = '<div class="empty">还没有上传记录</div>';
          return;
        }
        for (const image of images) {
          historyEl.append(historyItem(image));
        }
      } catch (error) {
        historyEl.innerHTML = '<div class="empty">读取失败，请检查密钥或稍后重试</div>';
      }
    }

    fileInput.addEventListener("change", () => uploadFile(fileInput.files?.[0]));
    copyButton.addEventListener("click", () => {
      if (urlInput.value) copyText(urlInput.value);
    });
    preview.addEventListener("contextmenu", async (event) => {
      if (!urlInput.value) return;
      event.preventDefault();
      await copyText(urlInput.value);
    });
    refreshButton.addEventListener("click", loadHistory);
    saveSecretButton.addEventListener("click", () => {
      const nextSecret = secretInput.value.trim();
      if (!nextSecret) {
        localStorage.removeItem("uploadSecret");
        syncAuthState("请输入密钥后再保存");
        return;
      }
      localStorage.setItem("uploadSecret", nextSecret);
      syncAuthState("密钥已保存，可以上传图片");
      loadHistory();
    });
    logoutSecretButton.addEventListener("click", () => {
      localStorage.removeItem("uploadSecret");
      secretInput.value = "";
      syncAuthState("已退出密钥，上传和最近上传已锁定");
    });

    for (const eventName of ["dragenter", "dragover"]) {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.add("is-drag");
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.remove("is-drag");
      });
    }
    dropzone.addEventListener("drop", (event) => {
      uploadFile(event.dataTransfer?.files?.[0]);
    });

    syncAuthState();
    if (hasSecret) {
      loadHistory();
    }
  </script>
</body>
</html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}
