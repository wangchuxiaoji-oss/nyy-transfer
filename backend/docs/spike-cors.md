# Spike 报告：浏览器直传豆包 TOS 是否可行？

## 结论

**完全可行。** 豆包 TOS 对所有 origin 开放 CORS，浏览器可以直接 POST 上传，不需要 Cloudflare Worker / VPS 中转 / 任何中继。

## 实测时间
2026-05-26

## 测试方法

1. 启动 `scripts/cors_spike_server.py`（端口 9290），暴露 `/sign?file_size=...&file_ext=...`
   - 服务端复刻 `DoubaoFileStationClient.upload_file_from_fileobj` 前半段：调 `prepare_upload` + `ApplyImageUpload` 拿 TOS 上传地址
2. 用 PowerShell `Invoke-WebRequest -Method Options` 模拟浏览器 CORS 预检，向 TOS 发 OPTIONS 请求

## 实测响应

```
URL=https://tos-mya2lq.vodupload.com/upload/v1/<store_uri>
STATUS=200
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, OPTIONS, PUT, GET, DELETE
Access-Control-Allow-Headers: Authorization,Content-Type,Content-Range,Accept,
                              Content-Disposition,Content-MD5,Content-CRC32,
                              X-Upload-Content-CRC32,X-TT-LogID,X-TT-TraceID,
                              X-Upload-Request-Id,X-Upload-Response-Time,...
```

关键点：

- `Allow-Origin: *` 而非白名单，nyy.app 不需要任何注册即可使用
- `Allow-Headers` 包含所有上传需要的头（`Authorization`、`Content-CRC32`、`Content-Type`）
- `Allow-Methods` 包含 `POST`，匹配豆包 TOS 上传协议

服务端 POST 8 字节假数据测试也成功：HTTP 200，TOS 业务码 2000，CRC32 校验通过。

## 架构含义

`v1` 上传链路确认走以下路径，VPS 不参与文件传输：

```
浏览器 ──(1) GET /api/v1/uploads/init──> nyy（鉴权 + captcha + 配额检查）
       <──upload_url + tos_auth + commit_token─── nyy（调豆包 prepare/apply）

浏览器 ──(2) POST upload_url──> 豆包 TOS（直传，CORS 已放行）
       <──HTTP 200──── 豆包 TOS

浏览器 ──(3) POST /api/v1/uploads/commit──> nyy（凭 commit_token + store_uri）
       <──share_code──── nyy（调豆包 CommitImageUpload + 入库 Share/ShareFile）
```

nyy 后端在整个上传过程中只发出 3 次小请求（prepare / apply / commit），文件本体完全不经过 VPS。

## 后续注意事项

1. **Auth token 时效**：从 ApplyImageUpload 拿到的 `tos_auth` 是 JWT，当前实测过期时间约为签发后 + 15 分钟。若用户大文件上传慢，可能需要在 init 阶段允许多次续签或预留长 TTL（v1.5 多分片场景需要重点处理）。
2. **CRC32 必须前端算好再发**：浏览器原生没有 CRC32 API，需要引入轻量库（如 `crc-32` npm 包，4KB）或在 Web Worker 里实现。这部分在 Week 2 上传组件落地。
3. **上传超时**：浏览器 fetch 默认无超时，配合 `AbortController` 实现失败重试（已写在 PRD §2 上传体验里）。
4. **是否要 sticky CORS**：TOS 已 `Allow-Origin: *`，无需再做特殊配置；nyy 自身的 `/api/v1/*` 在 prod 限制 origin 即可。
