# 指南：基于豆包白嫖通道的 HLS 点播方案（自包含）

> 状态：**已端到端验证成功**（2026-06-01）。10 秒视频 → ffmpeg 切 4 片 → 全部存豆包 →
> 重写 m3u8 → 播放器完整回放，抽帧验证时间轴与画面内容精确正确。
> 配套验证脚本 `backend/test_hls.py`、`backend/test_multipart.py` 已删除（验证完成后清理），核心结论已沉淀到本文与 `docs/spikes/`。

## 这是什么

用豆包（火山引擎 imageX）的免费上传通道做 **HLS 点播**：把视频切成 HLS 分片后，
分片（`.ts`）和索引（`.m3u8`）都当作**普通文件**白嫖豆包对象存储 + CDN，
播放时用豆包签名 URL 流式播放。**存储和分发 100% 白嫖，只有切片用一次 VPS CPU。**

## 核心原理（为什么这能成）

1. **HLS 的本质** = N 个 `.ts` 视频分片 + 1 个 `.m3u8` 纯文本索引。索引逐行列出分片地址。
2. 这些**全是普通文件**。豆包白嫖通道能上传任意文件，自然能存 `.ts` 和 `.m3u8`。
3. **不需要任何云端转码服务**。"转码/切片"在 VPS 用 ffmpeg 完成：
   - 源已是 H.264 时用 `-c copy` 只做**转封装**，几乎零 CPU。
   - 需要改分辨率/编码时才真正吃 CPU。
4. m3u8 默认用相对路径（`seg_000.ts`），把它**改写成豆包签名 URL** 即可让播放器找到分片。

## 整体架构

```
┌─────────┐  1.ffmpeg切片   ┌──────────────┐  2.逐个上传(init/commit)  ┌──────────┐
│ 源视频  │ ──────────────> │ seg_*.ts +   │ ────────────────────────> │ 豆包 TOS │
│  .mp4   │   (VPS CPU)     │ index.m3u8   │  3.get_file_url签发URL     │  + CDN   │
└─────────┘                 └──────────────┘ <──────────────────────── └──────────┘
                                   │ 4.重写m3u8: seg_000.ts -> 豆包签名URL
                                   v
                            ┌──────────────┐  5.上传重写后的m3u8        ┌──────────┐
                            │index_db.m3u8 │ ────────────────────────> │ 豆包 TOS │
                            └──────────────┘                            └──────────┘
                                   │ 6.播放器(hls.js/ffmpeg)吃 m3u8 URL
                                   v  全程流式播放，VPS 不碰存储/带宽
                            ┌──────────────┐
                            │   播放器     │
                            └──────────────┘
```

## 前置条件

- **ffmpeg**（VPS 上，切片用）：`ffmpeg -version` 确认可用。
- **Python 3.10+** + `httpx`：`pip install httpx`。
- **豆包 session**：`backend/.doubao_session.json`，结构如下（cookies 来自登录态）：
  ```json
  {
    "cookies": { "...": "登录态cookie" },
    "params": {
      "device_id": "714003710229497",
      "web_id": "7604137868021548590",
      "fp": "verify_xxx..."
    }
  }
  ```
- 安全参数 `aid=582478` 是豆包 Web 端固定值。

## 关键背景：豆包上传走的是 imageX 私有分片协议

豆包文件上传底层是**火山引擎 imageX**，不是标准 S3。上传一个文件的完整三段式：

1. **拿凭证**：`POST /alice/resource/prepare_upload` → 拿 `service_id` + STS（ak/sk/session_token）。
2. **申请存储**：`GET /top/v1?Action=ApplyImageUpload`（AWS V4 签名，service=`imagex`）
   → 拿 `StoreUri` + `Auth`(JWT) + `UploadHost` + `SessionKey`。
3. **上传到 TOS**：imageX 私有分片协议（**注意：非 S3**）：
   - Init： `PUT https://{host}/{store_uri}?uploads` → 返回 `payload.uploadID`
   - Part： `PUT .../{store_uri}?partNumber=N&uploadID=X`，头带 `Content-CRC32`（partNumber 从 0）
   - Merge：`PUT .../{store_uri}?uploadID=X`，body 是**纯文本** `0:crc32a,1:crc32b`（非 JSON）
4. **确认**：`POST /top/v1?Action=CommitImageUpload`（V4 签名）+ `SessionKey`。
5. **取播放 URL**：`POST /alice/message/get_file_url`，传 `uris`/`type`/`format`/`expire_second`
   → 返回带 `x-signature` 的签名直链。

CRC32 用标准 IEEE（等价 `zlib.crc32`），8 位小写 hex。小文件（如 HLS 分片）单片走
"1 个 part" 即可，不必真分片。详见 `docs/spikes/spike-multipart-upload.md`。

## 完整代码

下面的代码可整体保存为一个 Python 文件直接运行。为便于阅读分模块给出，
拼接顺序即为：工具函数 → 上传/签发 → HLS 切片与重写 → 主流程。

### 模块 1：CRC32 + AWS V4 签名（上传基础）

```python
import asyncio
import json
import os
import subprocess
import zlib
from urllib.parse import urlencode, parse_qs, quote, urlparse
from datetime import datetime, timezone

import httpx


def compute_crc32(data: bytes) -> str:
    """标准 IEEE CRC32，8 位小写 hex（等价 Go crc32.ChecksumIEEE）。"""
    return format(zlib.crc32(data) & 0xFFFFFFFF, "08x")


def aws_sign_v4(method, url, body, access_key, secret_key, session_token,
                region="cn-north-1", service="imagex"):
    """火山引擎 V4 签名（ApplyImageUpload / CommitImageUpload 用）。"""
    parsed = urlparse(url)
    host = parsed.hostname or ""
    path = parsed.path or "/"
    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")

    query_params = parse_qs(parsed.query, keep_blank_values=True)
    sorted_params = sorted((k, v[0] if v else "") for k, v in query_params.items())
    canonical_qs = "&".join(f"{quote(k, safe='~')}={quote(v, safe='~')}"
                            for k, v in sorted_params)

    headers_to_sign = {"host": host, "x-amz-date": amz_date}
    if session_token:
        headers_to_sign["x-amz-security-token"] = session_token
    signed_headers = ";".join(sorted(headers_to_sign.keys()))
    canonical_headers = "".join(f"{k}:{v}\n" for k, v in sorted(headers_to_sign.items()))
```

```python
    import hashlib
    import hmac

    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    payload_hash = hashlib.sha256(body_bytes).hexdigest()
    canonical_request = (f"{method}\n{path}\n{canonical_qs}\n{canonical_headers}\n"
                         f"{signed_headers}\n{payload_hash}")
    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
    cr_hash = hashlib.sha256(canonical_request.encode()).hexdigest()
    string_to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{cr_hash}"

    def _sign(key, msg):
        return hmac.new(key, msg.encode(), hashlib.sha256).digest()

    k_date = _sign(f"AWS4{secret_key}".encode(), date_stamp)
    k_signing = _sign(_sign(_sign(k_date, region), service), "aws4_request")
    signature = hmac.new(k_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()

    authorization = (f"AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, "
                     f"SignedHeaders={signed_headers}, Signature={signature}")
    result = {"Authorization": authorization, "X-Amz-Date": amz_date}
    if session_token:
        result["X-Amz-Security-Token"] = session_token
    return result


def load_session(path="/data/nyy/backend/.doubao_session.json"):
    """加载豆包 session，返回 (cookies, security_params)。"""
    s = json.load(open(path))
    params = s.get("params", {})
    sp = {
        "aid": "582478",
        "device_id": params.get("device_id", "714003710229497"),
        "web_id": params.get("web_id", "7604137868021548590"),
        "fp": params.get("fp", "verify_mlcfw5f7_TPq0YmFD_NrsC_4RuQ_BJPg_M5W7i58I7wV0"),
    }
    return s.get("cookies", {}), sp


BASE_URL = "https://www.doubao.com"
```

### 模块 2：上传单文件 + 签发播放 URL

```python
async def upload_file(client, sp, data: bytes, ext: str) -> str:
    """走豆包 imageX 私有分片协议上传一个文件，返回 store_uri。

    小文件单 part 即可（HLS 分片通常几 MB）。
    """
    # 1. prepare_upload 拿 STS
    url = f"{BASE_URL}/alice/resource/prepare_upload?{urlencode(sp)}"
    r = await client.post(url, json={"tenant_id": "5", "scene_id": "5", "resource_type": 1})
    d = r.json()["data"]
    sid = d["service_id"]
    a = d["upload_auth_token"]
    ak, sk, st = a["access_key"], a["secret_key"], a["session_token"]

    # 2. ApplyImageUpload 申请存储
    apply_url = (f"{BASE_URL}/top/v1?Action=ApplyImageUpload&Version=2018-08-01"
                 f"&ServiceId={sid}&NeedFallback=true&FileSize={len(data)}"
                 f"&FileExtension=.{ext}&s=jdnfglwfkl")
    sh = aws_sign_v4("GET", apply_url, "", ak, sk, st, service="imagex")
    r = await client.get(apply_url, headers=sh)
    addr = r.json()["Result"]["UploadAddress"]
    store = addr["StoreInfos"][0]
    uri, tos_auth = store["StoreUri"], store["Auth"]
    host, skey = addr["UploadHosts"][0], addr["SessionKey"]

    # 3. imageX 分片协议：Init -> Part(0) -> Merge
    rr = await client.put(f"https://{host}/{uri}?uploads",
                          headers={"Authorization": tos_auth})
    uid = rr.json()["payload"]["uploadID"]
    c = compute_crc32(data)
    await client.put(f"https://{host}/{uri}?partNumber=0&uploadID={uid}", content=data,
                     headers={"Authorization": tos_auth, "Content-CRC32": c})
    await client.put(f"https://{host}/{uri}?uploadID={uid}", content=f"0:{c}".encode(),
                     headers={"Authorization": tos_auth})

    # 4. CommitImageUpload 确认
    cu = f"{BASE_URL}/top/v1?Action=CommitImageUpload&Version=2018-08-01&ServiceId={sid}"
    cb = json.dumps({"SessionKey": skey})
    sh = aws_sign_v4("POST", cu, cb, ak, sk, st)
    sh["Content-Type"] = "application/json"
    await client.post(cu, content=cb, headers=sh)
    return uri


async def get_play_url(client, sp, uri: str, fmt: str, expire_second: int = 86400) -> str:
    """对 store_uri 签发带签名的播放直链。expire_second 最长实测 86400(24h)。"""
    url = f"{BASE_URL}/alice/message/get_file_url?{urlencode(sp)}"
    r = await client.post(url, json={"uris": [uri], "type": "file",
                                     "format": fmt, "expire_second": expire_second})
    return r.json()["data"]["file_urls"][0]["main_url"]
```

### 模块 3：HLS 切片 + 上传 + 重写 m3u8

```python
def slice_to_hls(input_path: str, out_dir: str, hls_time: int = 6,
                 recode: bool = False) -> str:
    """用 ffmpeg 把视频切成 HLS。返回 index.m3u8 路径。

    recode=False: 源已是 H.264 时只转封装(-c copy)，几乎零 CPU。
    recode=True:  重新编码(改分辨率/兼容性)，吃 CPU。
    """
    os.makedirs(out_dir, exist_ok=True)
    seg_tmpl = os.path.join(out_dir, "seg_%03d.ts")
    m3u8 = os.path.join(out_dir, "index.m3u8")
    if recode:
        codec = ["-c:v", "libx264", "-g", "48", "-c:a", "aac"]
    else:
        codec = ["-c", "copy"]
    cmd = ["ffmpeg", "-y", "-i", input_path, *codec,
           "-hls_time", str(hls_time), "-hls_list_size", "0",
           "-hls_segment_filename", seg_tmpl, m3u8]
    subprocess.run(cmd, check=True, capture_output=True)
    return m3u8


async def publish_hls(client, sp, m3u8_path: str, expire_second: int = 86400) -> str:
    """把一个本地 HLS 目录发布到豆包，返回可播放的 m3u8 URL。"""
    out_dir = os.path.dirname(m3u8_path)
    text = open(m3u8_path).read()

    # 1. 上传所有 .ts 分片，记录 文件名 -> 豆包URL
    seg_urls = {}
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):  # 分片行
            seg_path = os.path.join(out_dir, line)
            data = open(seg_path, "rb").read()
            uri = await upload_file(client, sp, data, "ts")
            seg_urls[line] = await get_play_url(client, sp, uri, "ts", expire_second)

    # 2. 重写 m3u8：相对路径 -> 豆包签名 URL
    for fn, url in seg_urls.items():
        text = text.replace(fn, url)

    # 3. 上传重写后的 m3u8 本身，签发它的 URL
    m3u8_uri = await upload_file(client, sp, text.encode(), "m3u8")
    return await get_play_url(client, sp, m3u8_uri, "m3u8", expire_second)
```

### 模块 4：主流程（端到端）

```python
async def main():
    import sys
    input_video = sys.argv[1] if len(sys.argv) > 1 else "/tmp/input.mp4"
    out_dir = "/tmp/hls_out"

    cookies, sp = load_session()
    # 1. 本地切片（VPS CPU）
    m3u8_path = slice_to_hls(input_video, out_dir, hls_time=6, recode=False)
    print(f"切片完成: {m3u8_path}")

    # 2. 发布到豆包
    async with httpx.AsyncClient(timeout=120.0, cookies=cookies,
                                 follow_redirects=True) as client:
        play_url = await publish_hls(client, sp, m3u8_path, expire_second=86400)
    print(f"\n可播放的 HLS m3u8 URL:\n{play_url}")

    # 3. 本地用 ffprobe 验证（需放开协议白名单）
    r = subprocess.run(
        ["ffprobe", "-v", "error",
         "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
         "-show_entries", "format=duration,format_name",
         "-of", "default=nw=1", play_url],
        capture_output=True, text=True, timeout=120)
    print(f"\nffprobe 验证:\n{r.stdout or r.stderr[:300]}")


if __name__ == "__main__":
    asyncio.run(main())
```

运行：

```bash
python doubao_hls.py /path/to/video.mp4
```

预期输出（已实测）：

```
切片完成: /tmp/hls_out/index.m3u8
可播放的 HLS m3u8 URL:
https://p6-flow-sign.byteimg.com/tos-cn-i-ik7evvg4ik/xxxx.m3u8?...&x-signature=...
ffprobe 验证:
duration=10.000000
format_name=hls
```

## 必须注意的点（踩坑全记录）

### 1. 签名 URL 会过期（最重要）

`get_file_url` 的 `expire_second` 最长实测 **86400 秒（24h）**。HLS 里每个 `.ts` 的 URL
都带 `x-expires` + `x-signature`，过期后 403。因此：

- **不要把重写后的 m3u8 当静态文件长期存储**。分片 URL 会失效，存死的 m3u8 几小时后就播不了。
- **正确做法**：只持久化「分片的 `store_uri` 列表 + 时长信息」到数据库；播放时由后端
  **按需实时调 `get_file_url` 重签所有分片 URL，动态拼出 m3u8** 返回给播放器。
- 等价方案：做一个 `GET /hls/{video_id}/index.m3u8` 接口，每次请求时现场签发。

### 2. ffmpeg/ffprobe 的协议白名单

m3u8 里是 https 分片时，ffmpeg/ffprobe 默认拒绝（`Protocol 'https' not on whitelist`）。
必须加 `-protocol_whitelist "file,http,https,tcp,tls,crypto"`。浏览器播放器（hls.js）无此问题。

### 3. keepalive 告警可忽略

ffmpeg 拉豆包分片时可能打印 `keepalive request failed ... retrying with new connection`，
这是 CDN 连接复用告警，会自动重连，**不影响最终结果**。

### 4. `-c copy` vs 重新编码

- 源是标准 H.264/AAC → 用 `-c copy` 只转封装，VPS 几乎不耗 CPU，速度极快。
- 源是 H.265/VP9/异常编码，或要改分辨率/码率 → 必须 `recode=True` 重新编码，吃 CPU。
- 转封装要求关键帧间隔合理，否则分片切点可能不准；重编码时用 `-g` 控制 GOP。

### 5. CRC32 是上传强制项

imageX 的 UploadPart/Merge 必须带正确 CRC32（IEEE，8 位小写 hex），否则 TOS 返回
CRC mismatch。Merge 的 body 是**纯文本** `0:crc`，不是 JSON——这是和标准 S3 最大的区别。

### 6. 截帧/缩略图不能靠豆包处理

豆包 `get_file_url(type=image)` 只能拿**视频首帧**（它强制套 `image-qvalue` 图片模板）。
任意时间点截帧、自定义尺寸缩略图，豆包服务端签名锁死，参数注入全部无效（详见
`docs/spikes/spike-video-processing.md`）。要任意时间缩略图：**VPS 用 ffmpeg 截帧后当普通图上传**：

```bash
ffmpeg -ss 8 -i input.mp4 -frames:v 1 -q:v 3 thumb.jpg
# 然后 upload_file(client, sp, open("thumb.jpg","rb").read(), "jpg")
```

### 7. HLS 不要用豆包/imageX 的转码 API

imageX 的 `CreateImageTranscodeTask` 是**图片专用**，不支持 HLS。云端转 HLS 只能用
**视频点播 VOD** 的 `StartWorkflow`，但那需要你**自己账号的 AK/SK**（IAM 控制台免费创建）
且**按转码时长收费、无免费额度**——属于自费，不是白嫖。既然 VPS 切片方案已验证白嫖可行，
**没必要走 VOD**，除非 VPS 算力不足或要大规模并发转码。

### 8. 并发与限流

- 上传每个分片是独立的 prepare/apply/commit，分片多时请求量大。建议控制并发
  （如 `asyncio.Semaphore(4)`），避免触发豆包风控。
- `prepare_upload` 拿到的 STS 约 1 小时有效；单个视频的所有分片应在有效期内传完，
  或每个分片各自 prepare（当前代码就是每片独立 prepare，最稳）。

### 9. 文件大小与分片

- 单个 `.ts` 通常几 MB，单 part 上传足够。若某分片 > 20MB（`hls_time` 设很大 + 高码率），
  仍可单 part（imageX 单 part 无 20MB 下限要求，下限只对"是否需要多 part"有意义）。
- `hls_time` 推荐 4~10 秒：太小则分片/请求过多，太大则首屏起播慢、seek 不流畅。

### 10. 安全与合规

- **session 凭证**：`.doubao_session.json` 含登录态，等同账号密码，**不要进 git、不要外泄**。
- **这是利用豆包免费额度的非官方用法**，可能违反豆包服务条款，且接口随时可能变更或封禁。
  生产环境务必有**降级预案**（如可切换到自有 TOS/VOD）。
- **不要存放违法违规内容**，风险自负。

## 验证证据（实测日志）

10 秒测试视频（绿底白字逐秒显示 "T 0s"~"T 9s"），`hls_time=3` 切成 4 片：

```
✓ seg_000.ts (20868B) -> tos-cn-i-ik7evvg4ik/8c3de4f2...ts
✓ seg_001.ts (20492B) -> tos-cn-i-ik7evvg4ik/5d96d983...ts
✓ seg_002.ts (20868B) -> tos-cn-i-ik7evvg4ik/39b9afbb...ts
✓ seg_003.ts (7144B)  -> tos-cn-i-ik7evvg4ik/ece38246...ts
✓ m3u8 -> https://p6-flow-sign.byteimg.com/...m3u8?...&x-signature=...

ffprobe: format_name=hls  duration=10.000000        ← 完整识别
ffmpeg 回放: hls_replay.mp4 = 28713B, h264 640x360, 250帧, duration=10
抽第6秒帧 -> 画面精确显示 "T 6s"                      ← 内容、时间轴完全正确
```

重写后的 m3u8 实际内容（节选）：

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:3
#EXTINF:3.000000,
https://p26-flow-sign.byteimg.com/tos-cn-i-ik7evvg4ik/8c3de4f2...ts?lk3s=...&x-signature=...
#EXTINF:3.000000,
https://...seg_001...ts?...&x-signature=...
...
#EXT-X-ENDLIST
```

## 生产集成建议（针对本项目）

1. **数据模型**：新增 HLS 资源表，存 `video_id`、有序的分片 `store_uri[]`、每片 `EXTINF` 时长、
   总时长、原始视频 `store_uri`。**不存签名 URL**（会过期）。
2. **发布流程**：上传原视频后，后台任务（VPS）`slice_to_hls` + 上传分片，落库分片 store_uri 列表。
3. **播放接口**：`GET /api/hls/{video_id}.m3u8` —— 请求时遍历分片 store_uri，
   实时 `get_file_url` 重签，动态拼 m3u8 文本返回（`Content-Type: application/vnd.apple.mpegurl`）。
   这样签名永不过期问题。
4. **前端**：用 hls.js（或原生 Safari）指向该 m3u8 接口即可播放。
5. **缩略图**：首帧用 `get_file_url(type=image)`；任意帧用 VPS ffmpeg 截后上传。
6. **降级**：保留直接下载原视频的能力，HLS 失败时回退。

## 相关文件

- `backend/test_hls.py`（已删除）：本方案端到端验证脚本（切片→上传→重写→回放），结论已并入本文
- `backend/test_multipart.py`（已删除）：imageX 分片协议验证（Init/Part/Merge），结论见下方两篇 spike
- `docs/spikes/spike-multipart-upload.md`：imageX 私有分片协议详解
- `docs/spikes/spike-video-processing.md`：视频处理能力调研（截帧/转码可行性结论）
- `/tmp/opencode/fetch_volc_doc.py`：火山引擎文档抓取器（突破 JS 渲染）
