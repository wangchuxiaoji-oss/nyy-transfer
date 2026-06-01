# Spike 报告：能否用豆包白嫖通道做视频转码(HLS)与缩略图？

## 结论(先说重点)

| 能力 | 可行性 | 说明 |
|------|--------|------|
| **视频首帧缩略图** | ✅ **已攻克可用** | `get_file_url` 传 `type=image`，豆包返回带签名的 `~tplv-a9rns2rl98-image-qvalue.jpg` URL，直接出图(首帧转 jpg)|
| **HLS 播放/点播** | ✅ **已端到端验证成功** | VPS 用 ffmpeg 切片，`.ts`+`.m3u8` 全部当普通文件白嫖豆包存储，重写 m3u8 指向豆包签名 URL，播放器完整流式播放 |
| **任意时间点截帧** | ⚠️ **白嫖走不通，但 VPS 可做** | 豆包强制签名 + 强制套 `image-qvalue` 图片模板，offset 无法注入；改用 VPS ffmpeg 截任意帧 |
| **服务端调 imageX 转码 API** | ❌ **白嫖走不通** | 需 AK/SK 签名，豆包 STS 只授权 ApplyImageUpload+CommitImageUpload；且 imageX 转码是图片专用，不支持 HLS |

**核心结论(重要逆转)**：最初判断"白嫖做不了 HLS"是错的。HLS 本质是「一堆 .ts 分片 + 一个 .m3u8 文本索引」，**分片和索引都是普通文件，完全可以白嫖豆包存储**。转码这一步用 VPS 的 ffmpeg 完成(CPU 开销，不耗存储/带宽)，HLS 的存储和分发仍然 100% 白嫖豆包 CDN。**这是真正可落地的白嫖 HLS 方案，已端到端验证(10秒视频→4分片→豆包→完整回放，第6秒帧内容精确正确)。**

## 实测时间
2026-06-01

## 关键发现 1：豆包走的是 imageX 通道，STS 权限被锁死

`prepare_upload` 返回的 STS token，其 PolicyString 解码后明确写死：

```json
{"Statement":[
  {"Effect":"Allow",
   "Action":["ImageX:ApplyImageUpload","ImageX:CommitImageUpload"],
   "Resource":["trn:ImageX:*:*:ServiceId/ik7evvg4ik"]},
  {"Effect":"Allow","Action":["PSM"],"Resource":["flow.alice.resource_center"]}
]}
```

- `upload_host: imagex.bytedanceapi.com`、`account_product: imagex`、`is_imagex: true`
- **STS 只授权 `ApplyImageUpload` + `CommitImageUpload` 两个动作**
- 这意味着任何需要 AK/SK 签名的处理类 OpenAPI(转码、提交任务等)都**无权调用**

## 关键发现 2：imageX 视频处理分两类，只有 URL 即时处理不需要 OpenAPI

调研 veImageX 文档(LibraryID=508)后明确：

- **转码(含 HLS)= OpenAPI**：`CreateImageTranscodeTask`，`POST https://imagex.volcengineapi.com/?Action=CreateImageTranscodeTask`，必须 AK/SK 初始化 SDK。豆包 STS 无此权限 → **走不通**。
- **截帧 = URL 即时处理**：两种子模式
  - 模板模式 `~tplv-{serviceid}-{模板名}.{格式}`，需控制台预建模板
  - 免模板模式 `?vframe/jpeg/offset/{秒}`，需控制台开启「自定义处理样式」开关

## 关键发现 3：豆包服务端签名 + 强制模板，锁死了截帧注入

这是任意时间截帧失败的根因。逐步实测：

| 尝试 | 结果 | 原因 |
|------|------|------|
| 直接拼 `~tplv-ik7evvg4ik-TimeOffsetMs-v3:8000.webp` | `2002 fail to get template` | 模板没建 |
| 直接拼 `?vframe/jpeg/offset/1`(无签名) | `2004 fail to handle request` + CDN `403` | 自定义处理样式开关没开 + 域名强制签名 |
| 去签名访问任何 `~tplv` | CDN `403 ACCESS DENIED` | `*-flow-sign.byteimg.com` 域名强制 `x-signature` |
| `get_file_url(uri="视频?vframe/jpeg/offset/N")` | `200` 出图，但**永远是首帧** | 豆包强制在 uri 后追加 `~tplv-a9rns2rl98-image-qvalue.jpg`，该图片模板接管处理，只取首帧 |
| `get_file_url` 传 `tpl`/`template`/`process` 扩展参数 | 全部被忽略，仍追加 `image-qvalue` | 豆包服务端写死 |
| 纯签名 URL 追加 `&vframe/...` | 返回原始 mp4，参数被当 query 忽略 | 处理参数必须在 path，但改 path 破坏签名 |

**核心矛盾**：豆包对所有下载 URL 强制签名(签名锁死 path)，且强制追加 `image-qvalue` 图片模板(锁死处理逻辑)。客户端无法在「合法签名」与「自定义 vframe 处理」之间取得兼容。

## 唯一可落地的成果：视频首帧缩略图

虽然任意时间截帧走不通，但**首帧缩略图是稳定可用的**，对文件分享站的列表/预览场景已经够用。

调用方式(已实测 `200 image/jpeg`)：

```python
# 视频已通过现有 init/commit 流程上传，拿到 store_uri 后：
resp = await client.post(
    f"{base_url}/alice/message/get_file_url?{urlencode(security_params)}",
    json={"uris": [video_store_uri], "type": "image",  # 关键:type=image
          "format": "jpg", "expire_second": 3600},
)
# 返回的 main_url 形如:
# https://p9-flow-sign.byteimg.com/{store_uri}~tplv-a9rns2rl98-image-qvalue.jpg?...&x-signature=...
# 直接 GET 该 URL 即得视频首帧 JPG(本测试为 640x360, 8KB)
thumb_url = resp.json()["data"]["file_urls"][0]["main_url"]
```

要点：
- `type=image` 时豆包自动追加 `~tplv-a9rns2rl98-image-qvalue.jpg`，对视频源取首帧转 jpg
- 模板建在豆包自己的图片处理 service `a9rns2rl98` 上(跨 service 引用，对象在 `ik7evvg4ik`)
- URL 自带签名，前端可直接 `<img src>`，无需 VPS 中转
- 局限：只能首帧，不能指定时间；输出格式/尺寸由 `image-qvalue` 模板固定

## 副产物：火山引擎文档抓取方法(突破 JS 渲染)

火山引擎文档站(Modern.js SSR)前端报「需要 JavaScript」，但正文有两种免渲染获取方式：

1. **内容 API(推荐，无风控)**：
   ```
   GET https://www.volcengine.com/api/doc/getDocDetail?DocumentID={docId}&LibraryID={libId}&lang=zh
   ```
   返回纯 JSON，正文在 `.Result.Content`(markdown)。注意参数是 `DocumentID`/`LibraryID`(大写)，小写 `docId`/`libId` 不识别。
2. **文档树**：`GET /api/doc/getDocList?LibraryID={libId}&lang=zh`，返回该库完整目录树。
3. 备用：原始 HTML 里 `window._ROUTER_DATA` 变量内联了正文 JSON(路径 `loaderData["docs/(libid)/(docid$)/page"].curDoc.Content`)，但 SSR 有降级缓存，不稳定。

抓取脚本见 `/tmp/opencode/fetch_volc_doc.py`（用法 `python fetch_volc_doc.py 508/135772`）。
常用库 ID：TOS=6349，VOD=4，veImageX=508。

## 重大突破：白嫖 HLS 方案(已端到端验证)

最初以为"HLS 必须靠 VOD/imageX 转码 API，白嫖通道做不到"。这个前提是错的——**HLS 不需要云端转码服务，只需要一个能存文件的对象存储**。

### 原理

HLS 流 = N 个 `.ts` 视频分片 + 1 个 `.m3u8` 纯文本索引。索引里逐行列出每个分片的地址。这些**全是普通文件**，豆包白嫖通道能存任意文件，自然也能存 `.ts` 和 `.m3u8`。

唯一要解决的：m3u8 默认用相对路径(`seg_000.ts`)，而豆包返回的是带签名的随机 URL。把 m3u8 里的相对路径**改写成豆包签名 URL** 即可。

### 完整链路(已跑通)

```
1. VPS: ffmpeg 把视频切成 HLS 分片
   ffmpeg -i input.mp4 -c:v libx264 -hls_time 3 -hls_list_size 0 \
          -hls_segment_filename "seg_%03d.ts" index.m3u8
   → 得到 seg_000.ts ... seg_NNN.ts + index.m3u8

2. 把每个 .ts 当普通文件走豆包 init/commit 上传 → 拿 store_uri
3. 对每个 .ts 调 get_file_url(type=file) → 拿带签名的播放 URL
4. 重写 index.m3u8: 把 "seg_000.ts" 替换成对应的豆包签名 URL
5. 改写后的 m3u8 也上传豆包 → 拿它的 URL
6. 播放器(hls.js / video.js / ffmpeg)直接吃这个 m3u8 URL，流式播放
```

### 验证结果

10 秒测试视频(绿底白字逐秒显示 "T 0s"~"T 9s")切成 4 个 3 秒分片：

```
✓ seg_000.ts (20868B) -> tos-cn-i-ik7evvg4ik/8c3de4f2...ts
✓ seg_001.ts (20492B) -> tos-cn-i-ik7evvg4ik/5d96d983...ts
✓ seg_002.ts (20868B) -> tos-cn-i-ik7evvg4ik/39b9afbb...ts
✓ seg_003.ts (7144B)  -> tos-cn-i-ik7evvg4ik/ece38246...ts
✓ m3u8 -> https://p6-flow-sign.byteimg.com/...m3u8?...&x-signature=...

ffprobe: format_name=hls  duration=10.000000   ← 完整识别
ffmpeg 回放: hls_replay.mp4 = 28713B, duration=10, h264 640x360, 250帧
抽第6秒帧 → 画面精确显示 "T 6s"   ← 内容、时间轴完全正确
```

### 注意事项与取舍

- **转码算力**：切片用 VPS 的 ffmpeg(CPU)。如果只转封装不重编码(`-c copy`，源已是 h264)，开销极小；若要转码/转分辨率才吃 CPU。
- **签名有效期**：`get_file_url` 的 `expire_second` 最长实测可设 86400(24h)。HLS 分片 URL 会过期，长期点播需要**播放时动态重新签发 m3u8**(后端按需调 get_file_url 重新生成索引)，而不是存死。这是落地时要处理的核心点。
- **存储与分发全白嫖**：所有 .ts 和 m3u8 都在豆包 TOS + CDN 上，VPS 不承担存储和分发流量，只在切片时用一次 CPU。
- **首帧缩略图**同理：本报告的 `type=image` 首帧方案可继续用；要任意时间缩略图，VPS ffmpeg 截帧后当普通图片上传即可。

## 关于 HLS 的另一条路(VOD)及 AK/SK 获取(非白嫖，供参考)

如果不想在 VPS 切片，想让云端转码，那必须用**视频点播 VOD**(不是 imageX，imageX 的转码是图片专用)：

- 接口：`StartWorkflow`(`https://vod.volcengineapi.com?Action=StartWorkflow&Version=2020-08-01`)，工作流绑定的视频转码模板支持 HLS 封装格式 + 分片时长设置。
- **AK/SK 获取**：注册并实名火山引擎账号 → [IAM 控制台 API 访问密钥页](https://console.volcengine.com/iam/keymanage/) 创建，AccessKeyID + SecretAccessKey。创建密钥免费。
- 签名：火山引擎标准 V4(HMAC-SHA256)，CredentialScope = `{date}/cn-north-1/vod/request`。
- **计费**：VOD 转码按输出时长收费(H.264 1080p 约 0.065 元/分钟，H.265 更贵)，**无转码免费额度**。

结论：VOD 是**自费**方案，且 AK/SK 是你自己账号的正规凭证，与"白嫖豆包"无关。**既然 VPS 切片方案已验证可白嫖 HLS，没必要走 VOD**，除非 VPS 算力不够或要大规模转码。

## 最终建议

1. **HLS 点播** → 用上面验证过的「VPS ffmpeg 切片 + 豆包存储 + 动态重写 m3u8」方案，全程白嫖。
2. **首帧缩略图** → 用 `get_file_url(type=image)` 方案，免费。
3. **任意时间缩略图** → VPS ffmpeg 截帧后当普通图上传豆包。
4. 不建议走 VOD/imageX 转码 OpenAPI(要 AK/SK、要钱、且 imageX 不支持 HLS)。

## 相关文件

> 以下探针脚本均已删除（验证完成后清理），核心结论已沉淀到本文。列出仅供追溯当时的验证手段：
>
> - `backend/probe_channel.py`：打印 prepare_upload + ApplyImageUpload 完整返回(STS 权限分析)
> - `backend/test_frame.py`：上传视频 + 拼 tplv 截帧(签名失效 403 验证)
> - `backend/test_imagex_host.py`：探测 imageX 图片访问域名
> - `backend/test_vframe.py`：免模板 vframe 语法实测(2004 未开启/域名未绑定)
> - `backend/test_steal_tpl.py`：偷豆包模板名(发现 `image-qvalue` + service `a9rns2rl98`)
> - `backend/test_hls.py`：白嫖 HLS 端到端验证脚本(切片→上传→重写m3u8→回放)
- `/tmp/opencode/fetch_volc_doc.py`：火山引擎文档抓取器
