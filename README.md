# Image Link Relay

独立的 Cloudflare Workers 图床上传中转项目。

它不使用 R2，不保存图片文件本体。上传流程是：

```text
浏览器选择图片
  -> POST /upload 到 Worker
  -> Worker 转发到外部 Telegraph-Image /upload
  -> Worker 解析返回的图片地址
  -> D1 保存上传记录
  -> 页面显示图片地址，支持复制
```

## 功能

- `GET /`：上传页面。
- `POST /upload`：接收图片并转发到外部 `Telegraph-Image /upload`。
- `GET /api/images`：读取 D1 中最近上传记录。
- `DELETE /api/images/:id`：删除 D1 中指定上传记录，不删除外部图床原图。
- 上传完成后自动显示图片预览和图片地址。
- 点击“复制地址”可复制图片 URL。
- 鼠标右键点击结果图片或历史图片，会复制图片 URL。
- 最近上传记录支持删除，只会删除本项目 D1 历史记录。
- 可选 `UPLOAD_SECRET` 上传密钥保护。

## 文件结构

```text
.
├── migrations
│   └── 0001_initial.sql
├── src
│   └── index.ts
├── package.json
├── tsconfig.json
├── wrangler.example.jsonc
└── README.md
```

## 新 Cloudflare 账号部署步骤

1. 进入项目目录：

```bash
cd image-link-relay
```

2. 安装依赖：

```bash
npm install
```

3. 登录新的 Cloudflare 账号：

```bash
npx wrangler login
```

如果之前登录过旧账号，可以先确认当前账号：

```bash
npx wrangler whoami
```

4. 创建 D1 数据库：

```bash
npx wrangler d1 create image-link-relay
```

5. 复制配置文件：

```bash
copy wrangler.example.jsonc wrangler.jsonc
```

把第 4 步返回的 `database_id` 填入 `wrangler.jsonc`。

6. 修改 `wrangler.jsonc` 里的图床地址：

```jsonc
"vars": {
  "TELEGRAPH_UPLOAD_URL": "https://你的-telegraph-image域名/upload",
  "PUBLIC_IMAGE_BASE_URL": "https://你的-telegraph-image域名",
  "MAX_UPLOAD_BYTES": "5242880",
  "HISTORY_LIMIT": "24",
  "PAGE_TITLE": "图床上传"
}
```

说明：

- `TELEGRAPH_UPLOAD_URL` 是外部 Telegraph-Image 的上传接口。
- `PUBLIC_IMAGE_BASE_URL` 用来把 Telegraph-Image 返回的 `/file/xxx.jpg` 拼成完整 URL。
- `MAX_UPLOAD_BYTES` 默认 5 MB。
- `HISTORY_LIMIT` 是页面显示最近上传记录数量。

7. 可选：设置上传密钥。

```bash
npx wrangler secret put UPLOAD_SECRET
```

设置后，页面右上角需要填写同一个密钥并保存，才能上传和读取历史。

如果不设置 `UPLOAD_SECRET`，页面就是开放上传。

8. 应用 D1 migration：

```bash
npx wrangler d1 migrations apply image-link-relay --local
npx wrangler d1 migrations apply image-link-relay --remote
```

9. 本地运行：

```bash
npm run dev
```

10. 部署：

```bash
npm run deploy
```

## API

### 上传图片

```bash
curl -X POST "https://你的-worker域名/upload" ^
  -H "X-Upload-Secret: 你的 UPLOAD_SECRET" ^
  -F "file=@C:\path\to\image.jpg"
```

成功返回：

```json
{
  "ok": true,
  "image": {
    "id": "uuid",
    "url": "https://你的-telegraph-image域名/file/xxx.jpg",
    "sourcePath": "/file/xxx.jpg",
    "fileName": "image.jpg",
    "contentType": "image/jpeg",
    "sizeBytes": 12345,
    "createdAt": "2026-06-28T00:00:00.000Z"
  }
}
```

### 最近上传记录

```bash
curl "https://你的-worker域名/api/images" ^
  -H "X-Upload-Secret: 你的 UPLOAD_SECRET"
```

### 删除 D1 历史记录

```bash
curl -X DELETE "https://你的-worker域名/api/images/图片记录ID" ^
  -H "X-Upload-Secret: 你的 UPLOAD_SECRET"
```

成功返回：

```json
{
  "ok": true,
  "id": "uuid"
}
```

说明：这个接口只删除 D1 中的历史记录，不删除外部 Telegraph-Image 图床里的原图。

## 注意

- 这个项目不会把图片保存到 Worker、D1、KV 或 R2。
- D1 只保存图片地址和上传记录。
- 页面里的删除按钮只会删除 D1 历史记录。
- 真正的图片文件仍然保存在你配置的外部 Telegraph-Image 图床里。
- `wrangler.jsonc` 和 Cloudflare secret 不要提交到公开仓库。
