# Spike 报告：豆包 TOS 是否支持官方 Multipart Upload？

## 结论

**完全支持。** 豆包白嫖的火山引擎 TOS 支持真正的分片上传（多片共享一个 `uploadID`，合并成单个 TOS 对象）。此前"豆包不支持 multipart、只能自研多对象方案"的判断是**错误的**——失败的根因是用了**标准 S3 协议**去调用，而豆包走的是**火山引擎 imagex 私有分片协议**（PUT + 纯文本 body + CRC32 校验，非 S3 的 POST + JSON + ETag）。

## 实测时间
2026-06-01

## 背景：为什么会误判

项目 v1.5 的大文件分片采用"自研多对象方案"——把一个大文件切成 N 个 512MB 分片，每个分片作为**独立的 TOS 对象**单独 `init/upload/commit`，DB 用 `ShareLogicalFile`(逻辑文件) + N 个 `ShareFile`(物理分片) 记录归属，下载时前端再把 N 个对象拼接还原。

当初放弃官方 multipart 的依据是：尝试 `CompleteMultipartUpload` 始终返回
`{"code":400,"error":"InvalidMergeParts","error_code":4019,"message":"invalid merge parts"}`，
于是认定"豆包 TOS 的 multipart 实现不完整、不返回 ETag、无法合并"。

## 排查经过

### 1. 验证前三步本就成功

用豆包 session（`.doubao_session.json`）凭证，复刻 `init_upload` 流程拿到 `store_uri` + `tos_auth` 后，依次测试：

| 步骤 | 结果 | 关键观察 |
|------|------|---------|
| CreateMultipartUpload | ✓ 200 | 返回 `payload.uploadID` |
| UploadPart | ✓ 200 | 响应体 `{"success":0,...}`，**无 ETag header**，只有 `x-tos-crc32` |
| ListParts | ✓ 200 | `partList[].etag` **恒为空字符串**，只有 `crc32` |
| CompleteMultipartUpload | ✗ 400 | `InvalidMergeParts` |

"UploadPart 不返回 ETag、ListParts 的 etag 为空"这两个现象，正是把人误导向"实现不完整"结论的陷阱。

### 2. 试错合并格式（全部失败）

按标准 S3 协议（`ve-tos-python-sdk` 格式）反复试 `CompleteMultipartUpload`：
`POST ?uploadID=X` + JSON body，试过 `{"Parts":[{"ETag","PartNumber"}]}`、
`partList/crc32`、`payload.parts`、空 body、partNumber 字符串/数字、空 etag——**全部 400**。

### 3. 关键转折：域名暴露了真实协议

注意到上传域名是 `*.vodupload.com`，凭证流程走的是 **`ApplyImageUpload`**（imagex 接口），
这根本不是标准 S3/TOS，而是**火山引擎 imagex/VOD 的私有上传协议**。S3 那套 POST+JSON+ETag 自然全错。

### 4. 从官方 Go SDK 确认正确协议

克隆 `volcengine/volc-sdk-golang`，读 `service/imagex/upload.go` 的 `segmentedUploadParam`，
确认了与 S3 完全不同的真实协议（见下）。

## 正确的 imagex 分片协议

来源：`volcengine/volc-sdk-golang` → `service/imagex/upload.go`（`chunkUpload` / `uploadPart` / `uploadMergePart` / `genMergeBody`）。

| 步骤 | 请求 | 说明 |
|------|------|------|
| Init | `PUT /{store_uri}?uploads` | 返回 `payload.uploadID`（注意是 **PUT** 不是 POST）|
| UploadPart | `PUT /{store_uri}?partNumber=N&uploadID=X` | body 为分片数据；头带 `Content-CRC32`；**partNumber 从 0 开始** |
| Merge | `PUT /{store_uri}?uploadID=X` | body 是**纯文本** `0:crc32a,1:crc32b`（逗号分隔，**非 JSON**）|
| Commit | `CommitImageUpload` + `SessionKey` | 确认文件，与现有 `commit_upload` 一致 |

踩过的坑（与标准 S3 的全部差异）：

1. **方法是 `PUT`**，不是 S3 的 POST。
2. **合并 body 是纯文本** `partNumber:crc32` 逗号拼接，不是 JSON `{"Parts":[...]}`。
3. **完全不用 ETag**，只用 **CRC32**（IEEE 标准，等价 Python `zlib.crc32`、Go `crc32.ChecksumIEEE`，8 位小写 hex）。所以 UploadPart 不返回 ETag、ListParts 的 etag 为空都是正常的——它压根不走 ETag 体系。
4. **partNumber 从 0 开始**（文件 ≤ 1GB 时）。仅当 `isLargeFile`（> 1GB）时上传的 partNumber 才从 1 开始，但 merge body 里的索引**始终从 0 写起**（Go SDK `genMergeBody` 用 range 索引）——这是个易错的不一致点。
5. **分片约束**：`MinChunkSize = 20MB`（最小分片），`LargeFileSize = 1GB`（超过才算大文件）。文件 ≤ 20MB 直接普通上传，不分片。

之前的 `InvalidMergeParts` 就是因为发了 S3 的 JSON body。

## 端到端验证

测试脚本 `backend/test_multipart.py`（已删除，完整代码见下方「完整验证脚本」节）：40MB 文件 → 切 2×20MB 分片 → Init/UploadPart×2/Merge → CommitImageUpload → 获取下载 URL → 下载回本地。

```
1. InitUploadPart (PUT ?uploads)        → uploadID=5bcb7c48-...
2. UploadPart partNumber=0/1            → 均 success:0，CRC32=0296d1a9 / dfbe15c0
3. MergePart (PUT, body=0:0296d1a9,1:dfbe15c0) → success:0, payload.key=35162ac2
4. CommitImageUpload                    → UriStatus=2000
5. 下载验证                              → HTTP 200，41943040 bytes (40.0MB)，完全一致
```

合并后是**单个 TOS 对象**，下载是**单个普通直链**，任意浏览器/设备/下载器均可直接下载。

## 参数验证补充（2026-06-01 实测）

为给「迁移到 multipart」选定 part 大小与并发策略，用真实豆包凭证额外做了一轮参数探针验证（脚本基于 `test_multipart.py` 的凭证/签名逻辑，验证后已删除）。结论全部为实测事实，非推断：

| 场景 | part 配置 | 上传方式 | 结果 | 合并后对象 |
|------|----------|---------|------|-----------|
| A | 64MB × 2 | 单文件内串行 | ✓ Init/Part/Merge/Commit 全成功 | 134217728 字节（精确 128MB），Range 206 |
| B | 128MB × 2 | 单文件内串行 | ✓ 全成功 | 268435456 字节（精确 256MB），Range 206 |
| C | 64MB × 3 | **单 uploadID 下 3 并发** | ✓ 全成功 | 201326592 字节（精确 192MB），Range 206 |

三条关键实测结论：

1. **part 大小不限于 20MB**。官方 Go SDK `chunkUpload` 固定用 `MinChunkSize`（20MB）只是 SDK 的实现选择，常量名 `MinChunkSize`（最小分片）即暗示 20MB 是下限。实测 **64MB、128MB 的 part 服务端均正常接受并能正确合并**。
2. **单 uploadID 下并发 UploadPart 可行**。官方 SDK 单文件内 parts 是串行 for 循环（`UploadRoutines=4` 仅用于跨文件并发），但实测证明同一 `uploadID` 下 3 个 part（partNumber=0/1/2）**并发上传**时：3 个请求乱序返回（日志中 pn=1 先于 pn=0 完成）、全部 `success:0`、merge 后字节数精确匹配、数据无错乱。即服务端不要求 part 串行上传。
3. **合并后单对象全部支持 HTTP Range（返回 206）**。这正是 SDP 软解播放器的硬依赖（`range-file-reader.ts` 对返回 200 的 URL 会判定为不可重试错误）。本轮实测等于提前验证了切换后的播放链路前提成立。

补充确认官方 Go SDK 的两个关键事实（来自 `service/imagex/storage.go` 的 `segmentedUpload` dispatcher）：

- **分片 vs 直传的真实分界是 20MB**：`item.size <= MinChunkSize(20MB)` 走 `directUpload`（单 PUT 普通上传）；`> 20MB` 走 `chunkUpload`（分片）。
- **`LargeFileSize`（1GB）不是「是否分片」的开关**，而是 `isLargeFile` 标志：仅控制两件事——partNumber 是否从 1 起（≤1GB 从 0，>1GB 从 1），以及 Init/UploadPart/Merge 是否带 `X-Storage-Mode: gateway` 头。merge body 的索引**始终从 0 连续**。
- 官方跨文件并发常量 `UploadRoutines = 4`（`config.go`）。

> 上行带宽备注：本次实测环境上行约 2.2MB/s，3 并发未体现提速是因为该服务器上行带宽已打满；并发的价值在于多 TCP 连接更充分利用高带宽客户端（如家宽）的上行能力。

## 与自研方案的优劣对比

| 维度 | 自研多对象方案 | 官方 Multipart |
|------|---------------|---------------|
| 下载兼容性 | **仅桌面 Chrome/Edge**（依赖 File System Access API 前端拼接）| 全平台全浏览器 |
| 下载 URL 数 | N 个（每分片一个）| 1 个 |
| TOS 对象数 | N 个 | 1 个 |
| 媒体在线播放 | 需 `media-player.tsx` 虚拟拼接 | 原生 `<video src>` 直接播放 |
| 凭证调用 | 每分片调一次 prepare/apply | 仅 1 次 |
| 代码复杂度 | 高（双表 + 前端拼接 + 虚拟播放器）| 低（单文件，无拼接）|

**自研方案的硬伤**：合并出来的不是一个文件，下载必须靠 `chunked-download.ts` 的 `showSaveFilePicker`（File System Access API）在浏览器端顺序写盘拼接，而该 API **仅桌面 Chrome/Edge 支持**——Safari、Firefox、所有手机浏览器、微信/QQ 内置浏览器都无法下载分片大文件。对文件分享站是产品级缺陷。

## 完整验证脚本

以下是本次验证用的完整可复现脚本（原 `backend/test_multipart.py`，文件已删除，代码原样保留于此）。依赖 `httpx`，凭证取自 `backend/.doubao_session.json`，把下面代码存成临时脚本运行 `.venv/bin/python <临时脚本>.py` 即可复现 40MB 文件分片→合并→下载全流程。

### 工具函数：CRC32 与 AWS V4 签名

```python
"""测试豆包TOS官方Multipart - 使用imagex协议(PUT + 文本body + partNumber从0)"""

import asyncio
import json
import hashlib
import hmac
import zlib
from datetime import datetime, timezone
from urllib.parse import parse_qs, quote, urlencode, urlparse

import httpx


def compute_crc32(data: bytes) -> str:
    """标准IEEE CRC32, 8位小写hex (等价Go crc32.ChecksumIEEE)"""
    return format(zlib.crc32(data) & 0xFFFFFFFF, "08x")


def aws_sign_v4(method, url, body, access_key, secret_key, session_token,
                region="cn-north-1", service="imagex"):
    parsed = urlparse(url)
    host = parsed.hostname or ""
    path = parsed.path or "/"
    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")

    query_params = parse_qs(parsed.query, keep_blank_values=True)
    sorted_params = sorted((k, v[0] if v else "") for k, v in query_params.items())
    canonical_qs = "&".join(f"{quote(k, safe='~')}={quote(v, safe='~')}" for k, v in sorted_params)

    headers_to_sign = {"host": host, "x-amz-date": amz_date}
    if session_token:
        headers_to_sign["x-amz-security-token"] = session_token
    signed_headers = ";".join(sorted(headers_to_sign.keys()))
    canonical_headers = "".join(f"{k}:{v}\n" for k, v in sorted(headers_to_sign.items()))

    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    payload_hash = hashlib.sha256(body_bytes).hexdigest()
    canonical_request = f"{method}\n{path}\n{canonical_qs}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
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
```

### 凭证获取：prepare_upload + ApplyImageUpload

```python
async def get_credentials(client, base_url, security_params):
    """获取TOS凭证和store_uri"""
    prepare_url = f"{base_url}/alice/resource/prepare_upload?{urlencode(security_params)}"
    resp = await client.post(prepare_url, json={"tenant_id": "5", "scene_id": "5", "resource_type": 1})
    body = resp.json()
    if body.get("code") != 0:
        raise RuntimeError(f"prepare_upload failed: {body}")
    data = body["data"]
    service_id = data["service_id"]
    auth = data["upload_auth_token"]
    ak, sk, st = auth["access_key"], auth["secret_key"], auth["session_token"]
    print(f"✓ 凭证: service_id={service_id}")

    file_size = 40 * 1024 * 1024  # 40MB -> 触发分片(>20MB)
    apply_url = (f"{base_url}/top/v1?Action=ApplyImageUpload&Version=2018-08-01"
                 f"&ServiceId={service_id}&NeedFallback=true&FileSize={file_size}"
                 f"&FileExtension=.bin&s=jdnfglwfkl")
    sign_headers = aws_sign_v4("GET", apply_url, "", ak, sk, st, service="imagex")
    resp = await client.get(apply_url, headers=sign_headers)
    body = resp.json()
    result = body.get("Result")
    if not result:
        raise RuntimeError(f"ApplyImageUpload failed: {body}")
    addr = result["UploadAddress"]
    store = addr["StoreInfos"][0]
    hosts = addr.get("UploadHosts", [])
    host = hosts[0] if hosts else "tos-mya2lf.vodupload.com"
    print(f"✓ store_uri={store['StoreUri']}  host={host}")
    return {
        "store_uri": store["StoreUri"], "tos_auth": store["Auth"], "host": host,
        "service_id": service_id, "session_key": addr["SessionKey"],
        "ak": ak, "sk": sk, "st": st,
    }
```

### 合并后确认与下载验证：CommitImageUpload + get_file_url

```python
async def commit_and_download(client, base_url, security_params, cred):
    """CommitImageUpload确认 + 获取下载URL验证"""
    commit_url = (f"{base_url}/top/v1?Action=CommitImageUpload&Version=2018-08-01"
                  f"&ServiceId={cred['service_id']}")
    commit_body = json.dumps({"SessionKey": cred["session_key"]})
    sh = aws_sign_v4("POST", commit_url, commit_body, cred["ak"], cred["sk"], cred["st"])
    sh["Content-Type"] = "application/json"
    resp = await client.post(commit_url, content=commit_body, headers=sh)
    body = resp.json()
    results = body.get("Result", {}).get("Results", [])
    print(f"\n4. CommitImageUpload: {results[0] if results else body}")
    if not results or results[0].get("UriStatus") != 2000:
        print("   ✗ commit失败"); return
    uri = results[0]["Uri"]
    print(f"   ✓ commit成功 uri={uri}")

    # 获取下载URL
    ext = uri.rsplit(".", 1)[-1] if "." in uri else ""
    url = f"{base_url}/alice/message/get_file_url?{urlencode(security_params)}"
    resp = await client.post(url, json={"uris": [uri], "type": "file",
                                        "format": ext, "expire_second": 3600})
    body = resp.json()
    file_urls = body.get("data", {}).get("file_urls", [])
    if not file_urls:
        print(f"   ✗ 无下载URL: {body}"); return
    dl_url = file_urls[0]["main_url"]
    print(f"\n5. 下载验证: {dl_url[:80]}...")
    r = await client.get(dl_url)
    size = len(r.content)
    print(f"   Status={r.status_code}  下载大小={size} bytes ({size/1024/1024:.1f}MB)")
    expected = 40 * 1024 * 1024
    print(f"   {'✓ 文件完整(40MB)!' if size == expected else f'⚠ 大小不符,期望{expected}'}")
```

### 主流程：Init / UploadPart / Merge 三步（imagex 协议核心）

```python
async def main():
    with open("/data/nyy/backend/.doubao_session.json") as f:
        session = json.load(f)
    cookies = session.get("cookies", {})
    params = session.get("params", {})
    base_url = "https://www.doubao.com"
    security_params = {
        "aid": "582478",
        "device_id": params.get("device_id", "714003710229497"),
        "web_id": params.get("web_id", "7604137868021548590"),
        "fp": params.get("fp", "verify_mlcfw5f7_TPq0YmFD_NrsC_4RuQ_BJPg_M5W7i58I7wV0"),
    }

    async with httpx.AsyncClient(cookies=cookies, timeout=120.0) as client:
        cred = await get_credentials(client, base_url, security_params)
        store_uri, tos_auth, host = cred["store_uri"], cred["tos_auth"], cred["host"]
        endpoint = f"https://{host}"

        # 1. InitUploadPart: PUT ?uploads
        print("\n1. InitUploadPart (PUT ?uploads)...")
        resp = await client.put(f"{endpoint}/{store_uri}?uploads",
                                headers={"Authorization": tos_auth})
        print(f"   Status={resp.status_code}  Body={resp.text[:200]}")
        upload_id = resp.json().get("payload", {}).get("uploadID")
        if not upload_id:
            print("   ✗ 无uploadID")
            return
        print(f"   ✓ uploadID={upload_id}")

        # 2. UploadPart: PUT ?partNumber=N&uploadID, partNumber从0开始
        part_size = 20 * 1024 * 1024  # 20MB
        parts_data = [b"A" * part_size, b"B" * part_size]
        crc_list = []
        print("\n2. UploadPart (partNumber从0)...")
        for part_number, data in enumerate(parts_data):
            crc = compute_crc32(data)
            crc_list.append(crc)
            url = f"{endpoint}/{store_uri}?partNumber={part_number}&uploadID={upload_id}"
            resp = await client.put(url, content=data, headers={
                "Authorization": tos_auth, "Content-CRC32": crc})
            print(f"   Part {part_number}: Status={resp.status_code} CRC32={crc} Body={resp.text[:120]}")

        # 3. MergePart: PUT ?uploadID, body=纯文本 "0:crc,1:crc"
        merge_body = ",".join(f"{i}:{c}" for i, c in enumerate(crc_list))
        print(f"\n3. MergePart (PUT, body={merge_body})...")
        resp = await client.put(f"{endpoint}/{store_uri}?uploadID={upload_id}",
                                content=merge_body.encode(),
                                headers={"Authorization": tos_auth})
        print(f"   Status={resp.status_code}")
        print(f"   Response: {resp.text[:400]}")
        if resp.status_code == 200 and '"success":0' in resp.text.replace(" ", ""):
            print(f"\n🎉 Multipart合并成功! store_uri={store_uri}")
            await commit_and_download(client, base_url, security_params, cred)


if __name__ == "__main__":
    asyncio.run(main())
```

## 后续建议

1. 在 `doubao_client.py` 增加 `init_multipart` / `upload_part` / `complete_multipart` 三个方法。
2. 改造 `uploads.py`：大文件走原生 multipart，DB 落库只存**单个** store_uri。
3. 前端 `file-uploader.tsx` 分片直传改为 `PUT ?partNumber=N&uploadID` + `Content-CRC32`，结束后调合并接口。
4. **保留 `ShareLogicalFile` 抽象层**（对多文件打包分享仍有价值），只把底层 N 个物理对象换成 1 个 multipart 对象。
5. 重构后下载侧可删除 `chunked-download.ts` 的前端拼接逻辑与 `media-player.tsx` 的虚拟分片播放逻辑。

## Go SDK 参考源码（协议真相来源）

来自 `volcengine/volc-sdk-golang` → `service/imagex/upload.go`，`segmentedUploadParam` 的分片实现。这是确认 imagex 私有协议的权威依据。

```go
// 关键常量（config.go）
// MinChunkSize  = 1024 * 1024 * 20   // 20MB 最小分片
// LargeFileSize = 1024 * 1024 * 1024 // 1GB，超过才算大文件

// Init：PUT /{uri}?uploads
func (c *segmentedUploadParam) initUploadPart() (string, error) {
    url := fmt.Sprintf("https://%s/%s?uploads", c.host, getEscapePath(c.StoreUri))
    req, _ := http.NewRequest("PUT", url, nil)
    req.Header.Set("Authorization", c.Auth)
    if c.isLargeFile {
        req.Header.Set("X-Storage-Mode", "gateway")
    }
    // ... 解析 res.PayLoad.UploadID
}

// UploadPart：PUT /{uri}?partNumber=N&uploadID=X，返回值是 CRC32（非 ETag）
func (c *segmentedUploadParam) uploadPart(uploadID string, partNumber int, data []byte) (string, error) {
    url := fmt.Sprintf("https://%s/%s?partNumber=%d&uploadID=%s",
        c.host, getEscapePath(c.StoreUri), partNumber, uploadID)
    checkSum := fmt.Sprintf("%08x", crc32.ChecksumIEEE(data))
    req, _ := http.NewRequest("PUT", url, bytes.NewReader(data))
    req.Header.Set("Content-CRC32", checkSum)
    req.Header.Set("Authorization", c.Auth)
    // ... 成功后 return checkSum（即把 CRC32 当作 part 标识）
}
```

```go
// Merge：PUT /{uri}?uploadID=X，body 是纯文本（非 JSON）
func (c *segmentedUploadParam) uploadMergePart(uploadID string, checkSum []string) error {
    url := fmt.Sprintf("https://%s/%s?uploadID=%s",
        c.host, getEscapePath(c.StoreUri), uploadID)
    body, _ := c.genMergeBody(checkSum)
    req, _ := http.NewRequest("PUT", url, bytes.NewReader([]byte(body)))
    req.Header.Set("Authorization", c.Auth)
    // ...
}

// genMergeBody：把每片拼成 "partNumber:crc32"，逗号连接；索引始终从 0 起
func (c *segmentedUploadParam) genMergeBody(checkSum []string) (string, error) {
    if len(checkSum) == 0 {
        return "", fmt.Errorf("body crc32 empty")
    }
    s := make([]string, len(checkSum))
    for partNumber, crc := range checkSum {
        s[partNumber] = fmt.Sprintf("%d:%s", partNumber, crc)
    }
    return strings.Join(s, ","), nil // 例如 "0:0296d1a9,1:dfbe15c0"
}

// chunkUpload：分片调度——注意 partNumber 默认从 0，仅 isLargeFile 时 ++（从 1）
//   for i := 0; i < lastNum; i++ {
//       partNumber := i
//       if c.isLargeFile { partNumber++ }   // >1GB 才从 1 开始
//       part, _ = c.uploadPart(uploadID, partNumber, cur)
//       parts = append(parts, part)
//   }
//   return c.uploadMergePart(uploadID, parts)
```

## 相关文件

- `backend/test_multipart.py`（已删除）：本次验证脚本（imagex 协议完整流程），完整代码见上方「完整验证脚本」节
- `backend/app/services/doubao_client.py`：现有 TOS 封装（`init_upload` / `commit_upload` / `get_download_url`）
- `backend/app/api/v1/uploads.py`：自研分片上传逻辑
- `backend/app/api/v1/shares.py`：下载逻辑（`_get_download_urls` 返回多 chunk URL）
- `frontend/src/lib/chunked-download.ts`：前端分片拼接（File System Access API，兼容性硬伤所在）
- 参考：`volcengine/volc-sdk-golang` → `service/imagex/upload.go`
