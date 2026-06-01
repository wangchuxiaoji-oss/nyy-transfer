# 大文件上传迁移方案：自研多对象 → 官方 imagex Multipart

> 本文档是给实施者（DeepSeek V4 PRO 或其他）的**可直接照做的施工手册**。
> 每处改动都给出文件路径、行号锚点、改前/改后代码骨架、验收标准。
> 配套阅读：`docs/spikes/spike-multipart-upload.md`（协议真相 + 实测结论）。
>
> **实施前必读**：
> 1. 行号是编写本文档时（基于当前 HEAD）的锚点，实施时以**函数名/代码上下文**为准定位，行号仅供参考。
> 2. 所有协议参数（part 大小、阈值、并发、CRC、partNumber 规则）均经过真机实测，见第 1 节，**不要擅自更改**。
> 3. 改动遵循 AGENTS.md：代码注释用中文。
> 4. 每完成一个阶段，运行对应验收命令（第 7 节），通过后再进入下一阶段。

---

## 0. 背景与目标

### 0.1 现状（自研多对象方案）

一个大文件（>512MB）被前端切成 N 个 512MB 分片，**每个分片作为独立的 TOS 对象**单独走 `init → POST 直传 → commit` 全流程。数据库用 1 行 `ShareLogicalFile`（逻辑文件）+ N 行 `ShareFile`（物理对象）记录归属。下载时前端用 File System Access API（`showSaveFilePicker`）把 N 个对象顺序拼接还原。

**硬伤**：合并出来的不是一个文件，下载依赖 `chunked-download.ts` 的前端拼接，而该 API **仅桌面 Chrome/Edge 支持**。Safari、Firefox、所有手机浏览器、微信/QQ 内置浏览器都无法下载大文件。在线播放也必须靠 Service Worker 虚拟拼接。

### 0.2 目标（官方 imagex multipart）

大文件改用火山引擎 imagex 私有分片协议：同一个 `uploadID` 下传 N 个 part，服务端 merge 成**单个 TOS 对象**。最终是单个普通直链，全平台可下载，原生 `<video>` 可直接播放（SDP 播放器也天然兼容）。

数据库每个逻辑文件只存 **1 行 ShareFile**（单 `tos_uri`）。

### 0.3 已确认的关键决策（实施者不得擅自更改）

| 项 | 决策 | 依据 |
|----|------|------|
| 上传时序 | **后端代理 Init + Merge，前端直传 Part** | 协议细节集中在后端 |
| Part 大小 | **64MB**（`PART_SIZE = 64 * 1024 * 1024`） | 实测可行 + 流媒体权衡（第 1 节） |
| 分片触发阈值 | **>20MB 走 multipart，≤20MB 单 PUT 直传** | 对齐官方 `segmentedUpload` |
| 单文件内 part 并发 | **3 并发**（实测可行），失败率高时降级为串行 | 实测第 1 节场景 C |
| Merge 时机 | **某逻辑文件所有 part 传完即调 `/uploads/merge`** | 失败早发现 |
| 断点续传 | **保留**，续传单位从「已完成对象」改为「已传 partNumber + uploadID」 | |
| 存量旧分享 | **不管旧数据**，但 `shares.py` 多片下载分支保留作兜底（不删） | |
| 默认播放器 | **SDP 设为默认**，清理原生播放（media-player 多分片分支 + virtual-media SW）死代码 | |
| ac3-lab 页 | **保留不动** | |

---

## 1. 实测结论与最终参数（协议真相）

以下参数全部经真机实测（2026-06-01，详见 `docs/spikes/spike-multipart-upload.md` 的「参数验证补充」节），**不是推断**：

### 1.1 实测事实

| 事实 | 验证场景 | 结论 |
|------|---------|------|
| 64MB part 被服务端接受 | Init/Part/Merge/Commit 全成功，合并后 128MB 精确匹配 | ✓ |
| 128MB part 被接受 | 合并后 256MB 精确匹配 | ✓ |
| 单 uploadID 下 3 并发 UploadPart | 3 个 part 乱序返回、全 success、merge 后字节精确匹配 | ✓ |
| 合并后单对象支持 Range 206 | `content-range` 头返回正确总大小 | ✓（SDP 播放硬依赖） |

### 1.2 官方 Go SDK 确认的协议常量（`service/imagex/config.go` / `storage.go`）

- `MinChunkSize = 20MB`：**分片 vs 直传的真实分界**。`size <= 20MB` 走 `directUpload`（单 PUT）；`> 20MB` 走 `chunkUpload`（分片）。
- `LargeFileSize = 1GB`：**不是是否分片的开关**，是 `isLargeFile` 标志。仅控制：partNumber 起点（≤1GB 从 0，>1GB 从 1）+ 是否带 `X-Storage-Mode: gateway` 头。
- `UploadRoutines = 4`：官方**跨文件**并发数（单文件内官方是串行，但实测单文件内并发可行）。

### 1.3 最终参数（写进代码常量）

```
PART_SIZE              = 64 * 1024 * 1024   # 64MB，每个 part 大小
MULTIPART_THRESHOLD    = 20 * 1024 * 1024   # >20MB 触发 multipart
LARGE_FILE_SIZE        = 1024 * 1024 * 1024 # 1GB，isLargeFile 分界
PART_CONCURRENCY       = 3                  # 单文件内 part 并发
```

切分规则：文件 `size > 20MB` → 按 64MB 切成 `ceil(size/64MB)` 个 part（末片为余数）；`size <= 20MB` → 不分片，走原单次 PUT 直传。

> partNumber 规则：`isLargeFile = size > 1GB`。partNumber 上传时 `isLargeFile ? i+1 : i`（i 从 0）。**merge body 的索引始终从 0 连续写**（`0:crc,1:crc,...`），与上传 partNumber 是否偏移无关。

---

## 2. 目标上传时序

```
前端                              后端 /uploads/*               TOS (imagex)
 │                                                                  │
 │ 大文件 size > 20MB:                                              │
 │                                                                  │
 │ POST /uploads/multipart-init ──▶ prepare + ApplyImageUpload ────▶│ 申请 store_uri
 │   {file_name,file_size,...}      PUT /{uri}?uploads ────────────▶│ 拿 uploadID
 │                                  Redis 存 multipart 会话          │
 │ ◀── {multipart_token, tos_host,  (multipart_token → 会话)        │
 │      store_uri, tos_auth,                                        │
 │      upload_id, part_size,                                       │
 │      part_number_base,                                           │
 │      part_count}                                                 │
 │                                                                  │
 │ 前端按 64MB 切片, 3 并发:                                         │
 │ PUT https://{tos_host}/{store_uri}?partNumber=N&uploadID=X ─────▶│ 直传 part
 │   头: Authorization=tos_auth, Content-CRC32=<crc>                │ 返回 success:0
 │   body: 分片字节                                                  │
 │   (记录每片 crc32 → crcList[i])                                   │
 │                                                                  │
 │ POST /uploads/multipart-merge ─▶ PUT /{uri}?uploadID=X ─────────▶│ 合并为单对象
 │   {multipart_token, crc_list}    body="0:crc,1:crc,..."          │ 返回 success:0
 │ ◀── {commit_token}               Redis 更新会话(已 merge)         │
 │                                                                  │
 │ POST /uploads/commit ──────────▶ CommitImageUpload + 落库 ───────▶│ 确认
 │   {files:[{commit_token,...}],   (每逻辑文件 1 行 ShareFile)      │
 │    logical_files:[...]}                                          │
 │ ◀── {share_code, share_url}                                      │
```

小文件（≤20MB）路径不变：仍走现有 `POST /uploads/init` → 单 PUT/POST 直传 → `POST /uploads/commit`。

### 2.1 凭证复用要点

`tos_auth`（imagex 签名串）对同一 `store_uri` 的 Init/UploadPart/Merge **三步通用**（实测已验证）。后端在 multipart-init 时把 `tos_auth`、`tos_host`、`store_uri`、`upload_id`、commit 所需的 `service_id/session_key/access_key/secret_key/session_token` 全部存入 Redis 会话，前端直传 part 只需 `tos_host + store_uri + upload_id + tos_auth`。

---

## 3. 后端改动

涉及 4 个文件：`doubao_client.py`（新增 multipart 协议方法）、`schemas/upload.py`（协议字段）、`uploads.py`（init/merge/commit）、`shares.py`（下载组装，仅小改）。

### 3.0 import 与路由挂载前置（照做前先处理，避免 NameError）

- **`uploads.py` 顶部加 `import re`**：现有 import 块（line 9-12）有 `json/logging/secrets/uuid`，**没有 `re`**。3.3.3 的 `_is_valid_crc32` 需要它。在 line 9 附近补 `import re`。
- **`uploads.py` 的 schemas import 块（line 20-25）扩充**：现有为
  ```python
  from app.schemas.upload import (
      UploadCommitRequest, UploadCommitResponse,
      UploadInitRequest, UploadInitResponse,
  )
  ```
  改为追加 4 个新 schema：
  ```python
  from app.schemas.upload import (
      MultipartInitRequest, MultipartInitResponse,
      MultipartMergeRequest, MultipartMergeResponse,
      UploadCommitRequest, UploadCommitResponse,
      UploadInitRequest, UploadInitResponse,
  )
  ```
- **路由无需手动挂载**：新端点用 `@router.post(...)` 装饰器加在现有 `router`（`uploads.py:34` 的 `APIRouter(prefix="/uploads")`）上，而 `router` 已在 `app/api/v1/__init__.py:22` 通过 `include_router(uploads_router)` 注册。新端点自动生效，**不要改 `__init__.py`**。
- **`doubao_client.py` 无需新增 import**：`init_multipart`/`merge_multipart` 只用到已有的 `httpx`（通过 `self.http`）和 `log`。

### 3.1 `backend/app/services/doubao_client.py`

#### 3.1.1 `UploadInitResult` 增加 `tos_host` 字段（约 line 89-101）

当前把 host 拼进 `upload_url` 后丢弃了裸 host，multipart 三个 URL 都需要裸 host。

改后：

```python
@dataclass
class UploadInitResult:
    """init_upload 返回值，前端用来直传 TOS。"""
    upload_url: str
    authorization: str  # TOS SpaceKey auth（Init/UploadPart/Merge 三步通用）
    store_uri: str
    session_key: str
    tos_host: str  # 新增：裸 host，multipart 拼 ?uploads/?partNumber/?uploadID 用
    # 以下用于 commit 阶段
    service_id: str
    access_key: str
    secret_key: str
    session_token: str
```

#### 3.1.2 `init_upload` 返回时带上 `tos_host`（约 line 233-252）

```python
        upload_hosts = upload_addr.get("UploadHosts", [])
        tos_host = upload_hosts[0] if upload_hosts else "tos-mya2lf.vodupload.com"
        upload_url = f"https://{tos_host}/upload/v1/{store_uri}"

        log.info("init_upload OK: store_uri=%s size=%d", store_uri, file_size)
        return UploadInitResult(
            upload_url=upload_url,
            authorization=tos_auth,
            store_uri=store_uri,
            session_key=session_key,
            tos_host=tos_host,  # 新增
            service_id=service_id,
            access_key=access_key,
            secret_key=secret_key,
            session_token=session_token,
        )
```

#### 3.1.3 新增 `init_multipart` 方法（接在 `init_upload` 之后）

发起 multipart 上传，拿 `uploadID`。参考 `test_multipart.py`（已删除，协议细节见 `docs/spikes/spike-multipart-upload.md`）的 Init 步骤。

```python
    async def init_multipart(
        self,
        store_uri: str,
        tos_auth: str,
        tos_host: str,
        is_large_file: bool,
    ) -> str:
        """发起 multipart 上传（PUT ?uploads），返回 uploadID。

        is_large_file（>1GB）时需带 X-Storage-Mode: gateway 头。
        """
        url = f"https://{tos_host}/{store_uri}?uploads"
        headers = {"Authorization": tos_auth}
        if is_large_file:
            headers["X-Storage-Mode"] = "gateway"
        resp = await self.http.put(url, headers=headers)
        try:
            body = resp.json()
        except Exception as exc:  # noqa: BLE001
            raise DoubaoClientError(f"init_multipart 响应非 JSON: {resp.text[:200]}") from exc
        upload_id = (body.get("payload") or {}).get("uploadID")
        if resp.status_code != 200 or not upload_id:
            raise DoubaoClientError(f"init_multipart 失败: {resp.status_code} {resp.text[:200]}")
        log.info("init_multipart OK: store_uri=%s upload_id=%s", store_uri, upload_id)
        return upload_id
```

#### 3.1.4 新增 `merge_multipart` 方法

合并所有 part 为单对象（PUT ?uploadID，纯文本 body）。参考 `test_multipart.py`（已删除，协议细节见 `docs/spikes/spike-multipart-upload.md`）的 Merge 步骤。

```python
    async def merge_multipart(
        self,
        store_uri: str,
        tos_auth: str,
        tos_host: str,
        upload_id: str,
        crc_list: list[str],
        is_large_file: bool,
    ) -> None:
        """合并 multipart（PUT ?uploadID），body 为纯文本 "0:crc,1:crc,..."。

        注意：merge body 索引始终从 0 连续，与上传时 partNumber 是否偏移无关。
        body 不是 JSON（发 JSON 会得到 InvalidMergeParts）。
        """
        if not crc_list:
            raise DoubaoClientError("merge_multipart: crc_list 为空")
        merge_body = ",".join(f"{i}:{crc}" for i, crc in enumerate(crc_list))
        url = f"https://{tos_host}/{store_uri}?uploadID={upload_id}"
        headers = {"Authorization": tos_auth}
        if is_large_file:
            headers["X-Storage-Mode"] = "gateway"
        resp = await self.http.put(url, content=merge_body.encode(), headers=headers)
        ok = resp.status_code == 200 and '"success":0' in resp.text.replace(" ", "")
        if not ok:
            raise DoubaoClientError(f"merge_multipart 失败: {resp.status_code} {resp.text[:300]}")
        log.info("merge_multipart OK: store_uri=%s parts=%d", store_uri, len(crc_list))
```

`commit_upload`（line 258）和 `get_download_url`（line 292）**不需要改动**：merge 后是单对象，各调一次即可。

### 3.2 `backend/app/schemas/upload.py`

新增 multipart 的 init/merge 请求响应 schema。现有 `UploadInitRequest`/`UploadInitResponse`/`CommitFileItem` 保留（小文件路径仍用），仅在 `CommitFileItem` 语义上明确：multipart 文件 commit 时 `chunk_index=0/chunk_total=1`。

新增（追加到文件末尾，`ErrorResponse` 之前）：

```python
class MultipartInitRequest(BaseModel):
    """POST /api/v1/uploads/multipart-init 请求体（每个大文件调一次）。"""
    file_name: str = Field(..., min_length=1, max_length=255)
    file_size: int = Field(..., gt=0, le=10 * 1024 * 1024 * 1024)
    file_ext: str = Field(default="", max_length=16)
    content_type: str = Field(default="", max_length=127)
    captcha_token: str = Field(default="", max_length=4096)
    logical_file_id: str = Field(..., min_length=1, max_length=36)
    # 文件请求上传场景
    request_code: str = Field(default="", max_length=16)
    request_password: str = Field(default="", max_length=4)


class MultipartInitResponse(BaseModel):
    """POST /api/v1/uploads/multipart-init 响应体。"""
    multipart_token: str       # 后端 Redis 会话键，merge/commit 时回传
    tos_host: str              # 前端直传 part 用
    store_uri: str
    tos_auth: str              # Init/UploadPart/Merge 三步通用签名
    upload_id: str
    part_size: int             # 64MB，前端按此切片
    part_number_base: int      # 0 或 1（isLargeFile 时 1）
    part_count: int            # ceil(file_size / part_size)
    commit_token: str          # merge 成功后才有效，commit 时回传
    commit_token_expires_at: datetime


class MultipartMergeRequest(BaseModel):
    """POST /api/v1/uploads/multipart-merge 请求体。"""
    multipart_token: str = Field(..., min_length=1, max_length=512)
    # 每个 part 的 CRC32（8位小写hex），按 partNumber 顺序（索引 0..N-1）
    crc_list: list[str] = Field(..., min_length=1, max_length=2000)


class MultipartMergeResponse(BaseModel):
    """POST /api/v1/uploads/multipart-merge 响应体。"""
    commit_token: str
    commit_token_expires_at: datetime
```

> 设计说明：`commit_token` 在 init 时即生成并随会话存 Redis，但前端只有在 merge 成功后才会拿到「可用的」commit_token（merge 响应里返回）。也可设计成 merge 成功后才生成 commit_token——二选一，本方案选 init 时生成、merge 后下发，减少一次 Redis 写。

### 3.3 `backend/app/api/v1/uploads.py`

#### 3.3.1 新增常量（约 line 40 附近）

```python
_PART_SIZE = 64 * 1024 * 1024            # 64MB 每片
_MULTIPART_THRESHOLD = 20 * 1024 * 1024  # >20MB 走 multipart
_LARGE_FILE_SIZE = 1024 * 1024 * 1024    # 1GB，isLargeFile 分界
```

#### 3.3.2 新增 `POST /uploads/multipart-init` 端点

复用 `upload_init` 的鉴权/配额逻辑（建议抽成共享函数 `_check_upload_permission_and_quota(...)`，避免重复）。

> **抽取契约**：把 `upload_init` 现有的 line 222-276 逻辑（hCaptcha 校验 + request_code 分支校验 + 活跃分享数限制 + 配额预检）抽成一个 async 函数，**返回 `request_owner_id`（str | None）**。注意原逻辑中：
> - request_code 非空 → 校验 FileRequest 存在/未过期/密码，返回其 `owner_id` 作为 `request_owner_id`
> - 否则按 user/guest 走活跃分享数 + 配额预检
> - multipart 场景按 `body.file_size` 做配额预检（整文件大小，不分片预检）
>
> 抽取后 `upload_init` 与 `multipart_init` 共用，避免两份配额逻辑漂移。

核心新增：

```python
@router.post("/multipart-init", response_model=MultipartInitResponse, summary="发起 multipart 上传")
async def multipart_init(
    body: MultipartInitRequest,
    request: Request,
    user: User | None = Depends(get_current_user_optional),
):
    settings = get_settings()
    ip = _get_client_ip(request)
    redis = request.app.state.redis
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "缓存服务暂时不可用，请稍后重试")

    # 大文件权限：>1GB 需登录（与现有 upload_init 一致）
    is_large_file = body.file_size > _LARGE_FILE_SIZE
    if is_large_file and not user:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "上传超过 1GB 的文件需要登录")

    # hCaptcha + 配额预检（复用 upload_init 的逻辑，按 file_size 预检）
    # ... 见 upload_init line 222-276，建议抽共享函数 ...
    request_owner_id = await _check_upload_permission_and_quota(
        body, request, user, ip, quota_size=body.file_size,
    )

    # 调豆包：prepare/apply 拿 store_uri，再 init_multipart 拿 upload_id
    try:
        client = await get_doubao_client()
        file_ext = body.file_ext or (body.file_name.rsplit(".", 1)[-1] if "." in body.file_name else "")
        init_result = await client.init_upload(file_size=body.file_size, file_ext=file_ext)
        upload_id = await client.init_multipart(
            store_uri=init_result.store_uri,
            tos_auth=init_result.authorization,
            tos_host=init_result.tos_host,
            is_large_file=is_large_file,
        )
    except DoubaoClientError as e:
        log.error("multipart_init failed: %s", e)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "上传服务暂时不可用，请稍后重试")
```

接着生成 commit_token + 存 Redis 会话 + 返回：

```python
    part_count = (body.file_size + _PART_SIZE - 1) // _PART_SIZE
    part_number_base = 1 if is_large_file else 0
    commit_token = secrets.token_urlsafe(32)
    commit_token_expires_at = datetime.now(timezone.utc) + _COMMIT_TOKEN_TTL

    # multipart 会话（merge 时取 store_uri/tos_auth/upload_id；commit 时取 service_id 等）
    session_data = {
        "ip": ip,
        "user_id": request_owner_id or (str(user.id) if user else None),
        "request_code": body.request_code or None,
        "file_name": body.file_name,
        "file_size": body.file_size,
        "file_ext": body.file_ext,
        "content_type": body.content_type,
        "logical_file_id": body.logical_file_id,
        "store_uri": init_result.store_uri,
        "tos_host": init_result.tos_host,
        "tos_auth": init_result.authorization,
        "upload_id": upload_id,
        "is_large_file": is_large_file,
        "session_key": init_result.session_key,
        "service_id": init_result.service_id,
        "access_key": init_result.access_key,
        "secret_key": init_result.secret_key,
        "session_token": init_result.session_token,
        "merged": False,
        # commit 阶段沿用现有 token_data 字段约定
        "is_empty": False,
        "chunk_index": 0,
        "chunk_total": 1,
        "logical_file_size": body.file_size,
    }
    # multipart 会话用独立前缀，避免与小文件 commit token 混淆
    await redis.setex(f"nyy:mpu:{commit_token}", int(_COMMIT_TOKEN_TTL.total_seconds()), json.dumps(session_data))

    return MultipartInitResponse(
        multipart_token=commit_token,  # 同一个 token 串起 init→merge→commit
        tos_host=init_result.tos_host,
        store_uri=init_result.store_uri,
        tos_auth=init_result.authorization,
        upload_id=upload_id,
        part_size=_PART_SIZE,
        part_number_base=part_number_base,
        part_count=part_count,
        commit_token=commit_token,
        commit_token_expires_at=commit_token_expires_at,
    )
```

> 关键设计：`multipart_token` 与 `commit_token` 用**同一个串**（`nyy:mpu:{token}`）。init 写会话，merge 标记 `merged=True` 并写入 crc_list，commit 时校验 `merged` 为真后落库。这样 commit 阶段能同时支持小文件（`nyy:commit:`）和 multipart（`nyy:mpu:`）两种 token 来源。

#### 3.3.3 新增 `POST /uploads/multipart-merge` 端点

```python
@router.post("/multipart-merge", response_model=MultipartMergeResponse, summary="合并 multipart 分片")
async def multipart_merge(
    body: MultipartMergeRequest,
    request: Request,
):
    redis = request.app.state.redis
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "缓存服务暂时不可用，请稍后重试")

    raw = await redis.get(f"nyy:mpu:{body.multipart_token}")
    if not raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传会话已过期，请重新上传")
    session = json.loads(raw)

    # 幂等：已 merge 直接返回（前端重试 merge 不应重复合并）
    if session.get("merged"):
        return MultipartMergeResponse(
            commit_token=body.multipart_token,
            commit_token_expires_at=datetime.now(timezone.utc) + _COMMIT_TOKEN_TTL,
        )

    # 校验 part 数量与 init 时一致
    expected = (int(session["file_size"]) + _PART_SIZE - 1) // _PART_SIZE
    if len(body.crc_list) != expected:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"分片数量不匹配，期望 {expected} 实际 {len(body.crc_list)}")
    if any(not _is_valid_crc32(c) for c in body.crc_list):  # 8位hex校验，需自行实现
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "分片校验值格式错误")

    try:
        client = await get_doubao_client()
        await client.merge_multipart(
            store_uri=session["store_uri"],
            tos_auth=session["tos_auth"],
            tos_host=session["tos_host"],
            upload_id=session["upload_id"],
            crc_list=body.crc_list,
            is_large_file=bool(session.get("is_large_file")),
        )
    except DoubaoClientError as e:
        log.error("multipart_merge failed: %s", e)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "分片合并失败，请稍后重试")

    session["merged"] = True
    await redis.setex(f"nyy:mpu:{body.multipart_token}", int(_COMMIT_TOKEN_TTL.total_seconds()), json.dumps(session))
    return MultipartMergeResponse(
        commit_token=body.multipart_token,
        commit_token_expires_at=datetime.now(timezone.utc) + _COMMIT_TOKEN_TTL,
    )
```

辅助函数 `_is_valid_crc32`（加到文件工具区）：

```python
import re
_CRC32_RE = re.compile(r"^[0-9a-f]{8}$")
def _is_valid_crc32(value: str) -> bool:
    return bool(_CRC32_RE.match(value or ""))
```

#### 3.3.4 改造 `upload_commit`（line 357-588）

只需两处改动，**落库逻辑天然兼容**（因为 multipart commit 的 token_data 里 `chunk_index=0/chunk_total=1`，走的就是单行 ShareFile 分支）。

**改动 A**：token 查找支持两种前缀（line 406-422 的循环）。**只改循环开头的取值部分，循环体后半段（`_logical_file_id` / `_chunk_index` / `_chunk_total` / `file_infos.append`）原样保留。**

改前（line 406-422 完整循环，注意后半段要保留）：

```python
    for item in body.files:
        token_key = f"nyy:commit:{item.commit_token}"
        raw = await redis.get(token_key)
        if not raw:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传会话已过期，请重新选择文件上传")
        token_data = json.loads(raw)
        if token_data["store_uri"] != item.store_uri:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传文件校验失败，请重新上传")
        # ↓↓↓ 以下后半段保持不变 ↓↓↓
        stored_logical_file_id = token_data.get("logical_file_id")
        if stored_logical_file_id and item.logical_file_id and stored_logical_file_id != item.logical_file_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传文件校验失败，请重新上传")
        logical_file_id = item.logical_file_id or stored_logical_file_id or str(uuid.uuid4())
        token_data["_logical_file_id"] = str(_parse_uuid(logical_file_id, "logical_file_id"))
        token_data["_chunk_index"] = item.chunk_index
        token_data["_chunk_total"] = item.chunk_total
        file_infos.append(token_data)
```

改后（**仅替换前 7 行的取值 + 校验**，后半段 `stored_logical_file_id...append` 完全不动）：

```python
    for item in body.files:
        raw = await redis.get(f"nyy:commit:{item.commit_token}")
        is_mpu = False
        if not raw:
            raw = await redis.get(f"nyy:mpu:{item.commit_token}")
            is_mpu = True
        if not raw:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传会话已过期，请重新选择文件上传")
        token_data = json.loads(raw)
        if is_mpu and not token_data.get("merged"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "分片尚未合并，请先调用 merge")
        if token_data["store_uri"] != item.store_uri:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传文件校验失败，请重新上传")
        token_data["_token_redis_key"] = f"nyy:mpu:{item.commit_token}" if is_mpu else f"nyy:commit:{item.commit_token}"
        # ↓↓↓ 原后半段（stored_logical_file_id ... file_infos.append）保持不变 ↓↓↓
```

> multipart 文件的 `CommitFileItem` 由前端构造为 `chunk_index=0/chunk_total=1`，因此 `token_data["_chunk_index"]=0`、`_chunk_total=1`，与会话里 init 时写入的值一致。

**改动 B**：删除 token 时用记录的 key（line 581-583）。

```python
    for info in file_infos:
        key = info.get("_token_redis_key")
        if key:
            await redis.delete(key)
```

> 落库循环（line 515-554）**不用改**：multipart 文件 `_chunk_index=0`、`_chunk_total=1`，`chunk_indexes == range(1)` 校验通过，每逻辑文件插 1 行 ShareFile，`tos_uri` = merge 后的单一 store_uri。`commit_upload`（豆包 CommitImageUpload）每文件调一次也不变。

### 3.4 `backend/app/api/v1/shares.py`

**不需要改动**。`_get_download_urls`（line 66-133）的单对象分支（line 76-106，`len==1 and chunk_total==1`）对新 multipart 数据天然适用：返回 `is_chunked=False` + 单 `download_url` + `chunks=[]`。多片分支（line 108-131）保留作旧分享兜底。

> 验证点：新分享下载时必须命中单对象分支，返回的 `download_url` 必须支持 HTTP Range 206（已实测合并后对象支持）。

### 3.5 数据模型与迁移

**不需要新迁移**。

- `ShareFile`（`models/share.py:108-143`）：字段全保留，新数据 `chunk_index=0/chunk_total=1`，与旧多行数据共存。
- `ShareLogicalFile`（`models/share.py:74-105`）：保留抽象层（多文件打包分享仍需要），新数据 `files` 关系从 N 行变 1 行，`chunk_total=1`。
- 现有 schema 已能表达「1 逻辑文件 → 1 物理对象」（`chunk_total=1`），无需 DDL 变更。

### 3.6 后端改动文件清单

| 文件 | 改动 | 类型 |
|------|------|------|
| `services/doubao_client.py` | `UploadInitResult` 加 `tos_host`；`init_upload` 回填；新增 `init_multipart`/`merge_multipart` | 新增方法 |
| `schemas/upload.py` | 新增 `MultipartInitRequest/Response`、`MultipartMergeRequest/Response` | 新增 schema |
| `api/v1/uploads.py` | 新增常量；新增 `multipart-init`/`multipart-merge` 端点；`upload_commit` 改 token 查找+删除 | 新增端点 + 小改 |
| `api/v1/shares.py` | 无 | — |
| `models/share.py` / migrations | 无 | — |

---

## 4. 前端改动

涉及：`lib/api.ts`（新增 multipart 接口类型与函数）、`lib/upload-state.ts`（断点续传结构）、`components/file-uploader.tsx`（大文件上传重写）。**小文件（≤512MB，实际改为 ≤20MB 判定）路径保持现有逻辑不变。**

> 注意当前前端 `CHUNK_SIZE=512MB`、`isLargeFile = fileSize > CHUNK_SIZE`（line 32/611）。迁移后大文件判定阈值要改为「是否走 multipart」，但为减少改动面，**建议保留「≤512MB 走现有单次直传，>512MB 走 multipart」的前端分界**，而不是严格用 20MB——因为现有单次直传对 20MB-512MB 文件工作良好，没必要全改成 multipart。这是前端的工程取舍，与后端 20MB 阈值不冲突（后端 multipart-init 接受任意 >0 大小）。
>
> **需实施者确认**：前端 multipart 触发阈值用 512MB（保守，改动小）还是 20MB（激进，全对齐）。本方案默认 **512MB**。

### 4.1 `frontend/src/lib/api.ts`

新增类型（接在 `UploadInitResponse` 后，line 17 附近）：

```typescript
export interface MultipartInitResponse {
  multipart_token: string;
  tos_host: string;
  store_uri: string;
  tos_auth: string;
  upload_id: string;
  part_size: number;
  part_number_base: number;  // 0 或 1
  part_count: number;
  commit_token: string;
  commit_token_expires_at: string;
}

export interface MultipartMergeResponse {
  commit_token: string;
  commit_token_expires_at: string;
}
```

新增请求函数（与现有 `uploadInit`/`uploadCommit` 同风格——api.ts 顶部已 `import { getToken } from "./auth"`，鉴权头用内联写法，**没有 `authHeader()` 辅助函数**）：

```typescript
export async function multipartInit(body: {
  file_name: string; file_size: number; file_ext: string; content_type: string;
  logical_file_id: string; captcha_token?: string;
  request_code?: string; request_password?: string;
}): Promise<MultipartInitResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/v1/uploads/multipart-init`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  return handleResponse<MultipartInitResponse>(res, "发起分片上传失败");
}

export async function multipartMerge(body: {
  multipart_token: string; crc_list: string[];
}): Promise<MultipartMergeResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/v1/uploads/multipart-merge`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  return handleResponse<MultipartMergeResponse>(res, "分片合并失败");
}
```

### 4.2 `frontend/src/lib/upload-state.ts`（断点续传结构）

续传单位从「已完成的物理对象（commit_items）」改为「已传 partNumber + uploadID + 各片 crc」。给 `UploadSessionFile` 增加 multipart 字段：

```typescript
export interface MultipartPartState {
  part_index: number;   // 0-based，对应切片序号
  crc32: string;        // 已上传成功的该片 CRC32
}

export interface UploadSessionFile {
  file_key: string;
  upload_name: string;
  file_name: string;
  file_size: number;
  last_modified: number;
  logical_file_id: string;
  chunk_total: number;
  commit_items: Array<StoredCommitItem | null>;   // 小文件路径仍用
  // --- 新增：multipart 续传状态 ---
  multipart?: {
    multipart_token: string;
    store_uri: string;
    tos_host: string;
    tos_auth: string;
    upload_id: string;
    part_size: number;
    part_number_base: number;
    part_count: number;
    commit_token: string;
    commit_token_expires_at: string;
    parts: Array<MultipartPartState | null>;  // 长度 = part_count，已传的非 null
    merged: boolean;                          // merge 是否完成
  };
}
```

新增写状态函数（完整实现，照抄 `markUploadChunkComplete` line 129-165 的事务结构。`MultipartSessionState` 即 §4.2 给 `UploadSessionFile.multipart` 定义的对象类型，建议抽成独立 interface 导出）：

```typescript
// 内部 helper：在事务里取出 session + 对应 file，回调修改后 put 回去
async function mutateSessionFile(
  uploadBatchId: string, fileKey: string,
  mutate: (file: UploadSessionFile) => void,
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(uploadBatchId);
      request.onsuccess = () => {
        const session = request.result as UploadSession | undefined;
        if (!session) { tx.abort(); return; }
        const file = session.files.find((c) => c.file_key === fileKey);
        if (!file) { tx.abort(); return; }
        mutate(file);
        session.updated_at = Date.now();
        store.put(session);
      };
      request.onerror = () => tx.abort();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("断点续传状态保存失败"));
      tx.onabort = () => reject(tx.error || new Error("断点续传状态保存失败"));
    });
  } finally {
    db.close();
  }
}

export async function markMultipartInit(
  uploadBatchId: string, fileKey: string, mpu: NonNullable<UploadSessionFile["multipart"]>,
): Promise<void> {
  return mutateSessionFile(uploadBatchId, fileKey, (file) => { file.multipart = mpu; });
}

export async function markMultipartPartComplete(
  uploadBatchId: string, fileKey: string, partIndex: number, part: MultipartPartState,
): Promise<void> {
  return mutateSessionFile(uploadBatchId, fileKey, (file) => {
    if (file.multipart) file.multipart.parts[partIndex] = part;
  });
}

export async function markMultipartMerged(
  uploadBatchId: string, fileKey: string, commitToken: string, commitTokenExpiresAt: string,
): Promise<void> {
  return mutateSessionFile(uploadBatchId, fileKey, (file) => {
    if (file.multipart) {
      file.multipart.merged = true;
      file.multipart.commit_token = commitToken;
      file.multipart.commit_token_expires_at = commitTokenExpiresAt;
    }
  });
}
```

> 注意 `markMultipartMerged` 比 §4.3.3 调用处多了 `commitToken/expiresAt` 两个参数——因为 merge 后 commit_token 会更新，需持久化以支持「merge 后刷新页面直接 commit」。§4.3.3 的调用要相应改为 `markMultipartMerged(batchId, fileKey, mergeRes.commit_token, mergeRes.commit_token_expires_at)`。

>
> **续传语义**：
> - 若 `multipart` 不存在或 `multipart_token` 已过期（`commit_token_expires_at < now + 安全余量`）→ 重新 multipart-init，重传所有 part。
> - 若 `multipart` 存在且未过期 → 跳过 `parts[i] != null` 的片，只传缺失片。
> - 若所有 part 已传但 `merged=false` → 直接调 merge。
> - 若 `merged=true` → 直接进入 commit。
>
> **注意**：uploadID 有服务端有效期（通常较长，但非永久）。续传前若 part 上传返回 uploadID 失效错误，应丢弃会话重新 init。

#### 4.2.1 续传进度提示的 UX 取舍（line 893-902）

现有 `startUpload` 恢复会话时，进度提示用 `chunk_total` 求和算总数（line 897）、用 `commit_items` 计数算已完成（line 893-895）：

```typescript
const total = existingSession.files.reduce((sum, file) => sum + file.chunk_total, 0);
const completed = existingSession.files.reduce(
  (t, file) => t + file.commit_items.filter(isStoredCommitItemFresh).length, 0);
window.confirm(`发现未完成的上传进度（已完成 ${completed}/${total} 个分片）...`);
```

因 4.4.2 把 `chunk_total` 统一改为 1，大文件的进度提示会从「已完成 3/6 个分片」**退化为文件级「已完成 0/1」**，不再反映 part 级进度。两种处理方式：

- **方案 A（推荐，改动小）**：接受退化，提示语改为按「文件数」描述（`已完成 X/Y 个文件`），语义更准确。
- **方案 B（保留 part 级进度）**：把 `total` 改为对 multipart 文件用 `file.multipart?.part_count ?? 1` 求和、`completed` 用 `file.multipart?.parts.filter(Boolean).length ?? (commit_items 计数)` 求和。改动稍大但进度更细。

本方案默认 **A**。无论哪种，都不影响上传正确性，仅影响提示文案。


### 4.3 `frontend/src/components/file-uploader.tsx`（大文件上传重写）

> **import 扩充（先做）**：
> - 从 `@/lib/api`（现 line 12）追加 `multipartInit, multipartMerge, type MultipartInitResponse`。
> - 从 `@/lib/upload-state`（现 line 16-27 的 import 块）追加 `markMultipartInit, markMultipartPartComplete, markMultipartMerged`。
> - `uploadPart`/`uploadMultipartFile`/`chunkSizeAtPart` 与现有 `uploadChunk`/`uploadSingleFile` 一样定义在 `FileUploader` 组件函数内部（它们用到 `abortRef`/`updateFile`/`recordFileLoaded`/`cancelledRef` 等闭包变量）。`chunkSizeAtPart` 是纯函数，可放组件外或内。

#### 4.3.1 新增常量（line 28-40 附近）

```typescript
const MULTIPART_THRESHOLD = 512 * 1024 * 1024; // >512MB 走 multipart（前端工程取舍，见 §4 注）
const MULTIPART_PART_CONCURRENCY = 3;          // 单文件内 part 并发（实测可行）
const PART_XHR_TIMEOUT = 30 * 60 * 1000;       // 单 part 30 分钟超时（64MB 慢网余量）
```

`CHUNK_SIZE`（512MB）保留给「旧逻辑判定」，但实际切片大小由后端返回的 `part_size`（64MB）决定。

> **并发叠加须知**：`startUpload` 的全局 worker 以 `GLOBAL_UPLOAD_CONCURRENCY=2`（line 38）并发跑 `uploadSingleFile`。multipart 文件内部又有 `MULTIPART_PART_CONCURRENCY=3` 的 part 并发。**最坏情况是 2 个大文件同时上传 × 各 3 个 part = 6 个并发 PUT**，内存峰值约 6 × 64MB = **384MB**（每个 part 的 Blob 切片 + CRC 计算缓冲）。若担心慢网/低端设备内存，可：(a) 把 `MULTIPART_PART_CONCURRENCY` 降为 2，或 (b) 在 multipart 文件上传时临时降低全局并发。本方案默认接受 384MB 峰值（现代设备可承受）。


#### 4.3.2 新增 `uploadPart`：直传单个 part 到 TOS

替代原 `uploadChunk`（line 487-606）。关键差异：`PUT ?partNumber&uploadID`、返回 CRC 而非 commit_token。

```typescript
/** 直传单个 part 到 TOS，返回该片 CRC32。 */
const uploadPart = async (
  entry: FileEntry,
  blob: Blob,
  partIndex: number,
  mpu: MultipartInitResponse,
  onProgress: (loaded: number) => void,
): Promise<string> => {
  let lastError = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const crc32 = await computeCRC32(blob); // 复用现有 crc32.ts
      const partNumber = mpu.part_number_base + partIndex;
      const url = `https://${mpu.tos_host}/${mpu.store_uri}?partNumber=${partNumber}&uploadID=${mpu.upload_id}`;
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const xhrKey = `${entry.id}_part_${partIndex}`;
        abortRef.current.set(xhrKey, xhr);
        xhr.open("PUT", url);                       // 注意：PUT 不是 POST
        xhr.timeout = PART_XHR_TIMEOUT;
        xhr.setRequestHeader("Authorization", mpu.tos_auth);
        xhr.setRequestHeader("Content-CRC32", crc32);
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
        xhr.onload = () => {
          abortRef.current.delete(xhrKey);
          if (!isSuccessfulHttpStatus(xhr.status)) {
            reject(new Error(formatXhrStatusError(xhr.status, "分片上传失败"))); return;
          }
          try {
            const body = JSON.parse(xhr.responseText);
            if (body.success !== undefined && body.success !== 0) {
              reject(new Error(body.error?.message || `TOS error`)); return;
            }
          } catch { /* 非 JSON 视为成功 */ }
          resolve();
        };
        xhr.onerror = () => { abortRef.current.delete(xhrKey); reject(new Error("网络错误")); };
        xhr.ontimeout = () => { abortRef.current.delete(xhrKey); reject(new Error("上传超时，正在重试")); };
        xhr.onabort = () => { abortRef.current.delete(xhrKey); reject(new Error("上传已取消")); };
        xhr.send(blob);
      });
      return crc32;
    } catch (err) {
      lastError = getErrorMessage(err, "分片上传失败");
      if (cancelledRef.current) throw new Error("上传已取消");
      if (!isRetryableUploadError(err)) throw new Error(lastError);
      if (attempt < MAX_RETRIES) await delay(2000 * 2 ** attempt);
    }
  }
  throw new Error(lastError);
};
```

#### 4.3.3 新增 `uploadMultipartFile`：init → 3 并发传 part → merge

在 `uploadSingleFile`（line 609）的大文件分支（line 764 起）替换为调用此函数。

```typescript
/** 大文件 multipart 上传：init → 并发传 part → merge。返回 commit 用的 StoredCommitItem。 */
const uploadMultipartFile = async (
  entry: FileEntry, fileKey: string, session: UploadSession, persistSession: boolean,
): Promise<StoredCommitItem> => {
  const fileSize = entry.file.size;
  const contentType = entry.file.type || "";
  const sessionFile = session.files.find((f) => f.file_key === fileKey);
  if (!sessionFile) throw new Error("断点续传状态异常，请重新选择文件上传");
  if (!sessionFile.logical_file_id) sessionFile.logical_file_id = generateUUID();

  // 1. 复用或新建 multipart 会话
  let mpuState = sessionFile.multipart;
  const expired = mpuState && new Date(mpuState.commit_token_expires_at).getTime() < Date.now() + TOKEN_EXPIRY_SAFETY_MS;
  if (!mpuState || expired) {
    const ext = entry.uploadName.includes(".") ? entry.uploadName.split(".").pop() || "" : "";
    const res = await multipartInit({
      file_name: entry.uploadName, file_size: fileSize, file_ext: ext,
      content_type: contentType, logical_file_id: sessionFile.logical_file_id,
    });
    mpuState = { ...res, parts: new Array(res.part_count).fill(null), merged: false };
    sessionFile.multipart = mpuState;
    if (persistSession) await markMultipartInit(session.upload_batch_id, fileKey, mpuState);
  }

  // 2. 切片 + 3 并发上传缺失片
  const partSize = mpuState.part_size;
  const partCount = mpuState.part_count;
  const partLoaded: number[] = mpuState.parts.map((p, i) => p ? chunkSizeAtPart(fileSize, partSize, i) : 0);
  recordFileLoaded(entry.id, partLoaded.reduce((a, b) => a + b, 0), true);

  const queue = Array.from({ length: partCount }, (_, i) => i).filter((i) => !mpuState!.parts[i]);
  const errors: Array<string | null> = new Array(partCount).fill(null);
  const worker = async () => {
    while (queue.length > 0) {
      const i = queue.shift()!;
      const start = i * partSize;
      const blob = entry.file.slice(start, Math.min(start + partSize, fileSize));
      try {
        const crc = await uploadPart(entry, blob, i, mpuState!, (loaded) => {
          partLoaded[i] = loaded;
          updateFile(entry.id, { progress: Math.round((partLoaded.reduce((a, b) => a + b, 0) / fileSize) * 100) });
          recordFileLoaded(entry.id, partLoaded.reduce((a, b) => a + b, 0));
        });
        mpuState!.parts[i] = { part_index: i, crc32: crc };
        partLoaded[i] = chunkSizeAtPart(fileSize, partSize, i);
        if (persistSession) await markMultipartPartComplete(session.upload_batch_id, fileKey, i, mpuState!.parts[i]!);
      } catch (err) {
        errors[i] = getErrorMessage(err, `分片 ${i + 1}/${partCount} 上传失败`);
        if (cancelledRef.current) throw new Error("上传已取消");
        if (!isRetryableUploadError(err)) { abortActiveUploads(); throw new Error(errors[i]!); }
        await delay(2000);
      }
    }
  };
  const concurrency = Math.min(MULTIPART_PART_CONCURRENCY, queue.length || 1);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (mpuState.parts.some((p) => !p)) throw new Error(errors.find(Boolean) || "部分分片上传失败");
```

继续：3. merge + 4. 返回 commit item：

```typescript
  // 3. merge（幂等：后端已 merge 会直接返回）
  if (!mpuState.merged) {
    const crcList = mpuState.parts.map((p) => p!.crc32); // 按 part_index 顺序，索引 0..N-1
    const mergeRes = await multipartMerge({ multipart_token: mpuState.multipart_token, crc_list: crcList });
    mpuState.merged = true;
    mpuState.commit_token = mergeRes.commit_token;
    mpuState.commit_token_expires_at = mergeRes.commit_token_expires_at;
    if (persistSession) await markMultipartMerged(session.upload_batch_id, fileKey, mergeRes.commit_token, mergeRes.commit_token_expires_at);
  }

  // 4. 返回 commit item（单对象：chunk_index=0/chunk_total=1）
  updateFile(entry.id, { state: "done", progress: 100 });
  recordFileLoaded(entry.id, fileSize, true);
  return makeStoredCommitItem({
    commit_token: mpuState.commit_token,
    store_uri: mpuState.store_uri,
    logical_file_id: sessionFile.logical_file_id,
    chunk_index: 0,
    chunk_total: 1,
  }, mpuState.commit_token_expires_at);
};
```

辅助函数 `chunkSizeAtPart`（按 part_size 计算第 i 片大小，替代现有 `chunkSizeAt`）：

```typescript
const chunkSizeAtPart = (fileSize: number, partSize: number, i: number) =>
  Math.min(partSize, fileSize - i * partSize);
```

#### 4.3.4 接入 `uploadSingleFile`（line 609-862）

把判定从 `isLargeFile = fileSize > CHUNK_SIZE`（line 611）改为按阈值分两档：

```typescript
const fileSize = entry.file.size;
if (fileSize <= MULTIPART_THRESHOLD) {
  // ≤512MB：现有单次直传逻辑（line 625-762 原样保留）
  // ... 注意：commit item 不变，仍走 uploadInit/POST ...
} else {
  // >512MB：multipart
  const item = await uploadMultipartFile(entry, fileKey, session, persistSession);
  return [item];
}
```

> 原大文件分支（line 764-862，按 512MB 切多对象）**整段删除**，由 `uploadMultipartFile` 替代。原 `uploadChunk`（line 487-606）若不再被引用可删除。

### 4.4 commit 组装与 session.chunk_total 语义（**关键，不可遗漏**）

> ⚠️ **这是整个前端迁移最容易出错、且必然导致失败的环节。** 现有 commit 收尾逻辑（`startUpload`，约 line 1005-1036）用 `session.files` 的 `chunk_total` 与 `commit_items` 做一致性校验。multipart 文件**对 commit 而言是单对象**，因此其 `sessionFile.chunk_total` 必须为 **1**、`commit_items` 长度必须为 **1**。否则校验必然失败。

#### 4.4.1 现有校验逻辑（理解为什么必须改）

```typescript
// line 1005-1008
const expectedItems = session.files.reduce((sum, file) => sum + file.chunk_total, 0);
const finalResults = session.files.flatMap((file) => file.commit_items).filter(Boolean);
if (hasError || finalResults.length !== expectedItems) { /* 报错 */ }
```

若 multipart 文件 `chunk_total` 仍按旧逻辑设为 512MB 分片数（如 3GB→6），但 `commit_items` 只放 1 项 → `expectedItems` 比 `finalResults` 多 → **上传阶段直接报错**。即使绕过，后端落库时 `chunk_indexes != range(6)`（uploads.py:520）也会再报错。

#### 4.4.2 必改点：`createSessionForCurrentSelection`（line 463-485）

`sessionFile.chunk_total` 的语义从「物理分片数」改为「commit 物理对象数」。无论小文件还是 multipart，commit 物理对象都是 **1**（multipart 的 part 数单独存 `multipart.parts`）。

改前（line 464-477）：
```typescript
const sessionFiles: UploadSessionFile[] = files.map((entry, index) => {
  const isChunked = entry.file.size > CHUNK_SIZE;
  const chunkTotal = isChunked ? Math.ceil(entry.file.size / CHUNK_SIZE) : 1;
  return { ...entry 字段..., chunk_total: chunkTotal, commit_items: new Array(chunkTotal).fill(null) };
});
```

改后（multipart 与小文件统一为单 commit 对象，`chunk_total` 恒为 1）：
```typescript
const sessionFiles: UploadSessionFile[] = files.map((entry, index) => {
  // 迁移后：每个逻辑文件 commit 物理对象恒为 1（multipart 合并成单对象，小文件本就单对象）
  return {
    file_key: fileKeys[index],
    upload_name: entry.uploadName,
    file_name: entry.file.name,
    file_size: entry.file.size,
    last_modified: entry.file.lastModified,
    logical_file_id: generateUUID(),
    chunk_total: 1,
    commit_items: new Array(1).fill(null),
    // multipart 字段在 uploadMultipartFile 内首次 init 时填充（见 §4.3.3）
  };
});
```

#### 4.4.3 必改点：`logicalFiles` 组装（line 1029-1036）

`chunk_total: sessionFile.chunk_total` 现在恒为 1，**正确**。无需额外改动，但要确认改 4.4.2 后此处自然变成 1。后端 `CommitLogicalFileItem.chunk_total=1` → 落库单行 ShareFile。

#### 4.4.4 commit `files` 数组

`finalResults.map(stripStoredCommitItem)`（line 1055）不变：multipart 文件的 `commit_items[0]` 是 `uploadMultipartFile` 返回的单个 `StoredCommitItem`（`chunk_index=0/chunk_total=1`），与小文件结构一致。

> **小结**：4.4 的本质是「`chunk_total` 语义统一为 1」。这一改动同时让小文件、multipart 文件、commit 校验、后端落库四处自洽。**不要漏 4.4.2。**

### 4.5 前端改动文件清单

| 文件 | 改动 | 类型 |
|------|------|------|
| `lib/api.ts` | 新增 `MultipartInitResponse`/`MultipartMergeResponse` 类型 + `multipartInit`/`multipartMerge` 函数 | 新增 |
| `lib/upload-state.ts` | `UploadSessionFile` 加 `multipart` 字段；新增 `markMultipartInit`/`markMultipartPartComplete`/`markMultipartMerged` | 新增 |
| `components/file-uploader.tsx` | 新增常量；新增 `uploadPart`/`uploadMultipartFile`/`chunkSizeAtPart`；`uploadSingleFile` 大文件分支替换；**`createSessionForCurrentSelection` 把 `chunk_total` 统一为 1（§4.4.2，必改）**；续传进度提示文案调整（§4.2.1）；删除旧 `uploadChunk` 与 512MB 多对象分支 | 重写大文件路径 |
| `lib/crc32.ts` | 无（`computeCRC32` 直接复用） | — |

---

## 5. SDP 默认化与死代码清理

### 5.1 前置说明：为什么 SDP 链路不用改

SDP 播放链路（`RangeFileReader → SdpDemuxer → PlayerEngine → mediabunny`）对单对象**天然兼容**：`src/lib/range-file-reader.ts` 的 `RangeFileReader` 构造函数（line 58）已内建分支——`if (file.is_chunked)`（line 59）走多 chunk，否则（line 75）把整文件构造成 `[{index:0, url: download_url, start:0, end: file_size-1, size: file_size}]` 单 chunk。后端 multipart 合并后返回 `is_chunked=false` + 单 `download_url` + `file_size`，SDP **零改动**即可工作。

唯一硬依赖：`download_url` 必须支持 HTTP Range 206——**已实测合并后对象满足**（第 1 节）。`range-file-reader.ts` line 211 附近还内建了「200 表示 CDN 忽略 Range」的检测，进一步印证 Range 206 是该链路的前提。

### 5.2 SDP 设为默认播放器

`frontend/src/app/[code]/page.tsx`：

**改动 A**（line 307-308）：去掉 `?sdp=1` 门控，SDP 支持的类型默认启用。

改前：
```typescript
const sdpParam = searchParams.get("sdp");
setSdpEnabled(sdpParam === "1" || sdpParam === "2");
```

改后（默认开启，保留 `?sdp=0` 作逃生开关）：
```typescript
const sdpParam = searchParams.get("sdp");
setSdpEnabled(sdpParam !== "0");  // 默认开，?sdp=0 强制关
```

**改动 B**（line 715-721）：播放器选择逻辑不变即可——`useSdp` 现在对所有 SDP 支持类型（mp4/mkv/wmv）默认为真，其余类型走 `MediaPlayer`（此时 `MediaPlayer` 只会命中 `NativeDirectMediaPlayer` 单对象直连分支）。

**改动 C**（line 300-302）：移除 `prepareVirtualMediaTransport` 预热（SW 虚拟文件链路将废弃）。

```typescript
// 删除整个 useEffect：
// useEffect(() => { void prepareVirtualMediaTransport().catch(() => {}); }, []);
```

### 5.3 死代码清理

切到单对象后，多分片相关代码变成死代码。**清理范围严格限定在主播放/下载路径，不动 ac3-lab 页**（已确认保留）。

#### 5.3.1 Service Worker 虚拟文件链路（整体废弃）

| 文件/位置 | 操作 | 说明 |
|----------|------|------|
| `frontend/src/lib/virtual-media.ts` | 删除整文件 | 仅服务多对象 Range 合成 |
| `frontend/public/nyy-virtual-media-sw.js` | 删除 | 优化版 SW |
| `frontend/public/nyy-virtual-media-sw-legacy.js` | 删除 | legacy SW |
| `media-player.tsx` 的 `NativeRangeChunkedMediaPlayer`（line 71-477） | 删除该组件 | 多分片原生播放 + SW 注册 |
| `media-player.tsx` 顶部 `virtual-media` import（line 5）及 SW 注册/重注册逻辑（line 123-147, 376-396） | 删除 | |
| `media-player.tsx` 的 `NativeDirectMediaPlayer`（line 37-70） | **保留** | 非 SDP 类型的单对象直连播放 |
| `media-player.tsx` 选择逻辑（line 30-34，`file.is_chunked && chunks.length>0`） | 简化为恒走 `NativeDirectMediaPlayer` | |

> **重要前置检查**：删 `virtual-media.ts` 前，全局搜索 `virtual-media`、`prepareVirtualMediaTransport`、`registerVirtualMediaFile`、`createVirtualMediaFileId`、`setVirtualMediaDebugEnabled` 的引用。**`app/ac3-lab/[code]/page.tsx` 仍引用它们（line 10/572/593）**——由于 ac3-lab 保留，**不能删 `virtual-media.ts`**，除非先解除 ac3-lab 的依赖。
>
> **结论修正**：因 ac3-lab 保留且依赖 virtual-media，**`virtual-media.ts` 与两个 SW 文件不能物理删除**。改为：仅在主路径（`page.tsx` + `media-player.tsx`）解除引用，文件本体保留给 ac3-lab。待将来 ac3-lab 也迁移后再删。

#### 5.3.2 AC-3 sidecar（条件清理）

`frontend/src/lib/ac3-sidecar.ts` 的 `SidecarVirtualFile`：经核查**仅被 `media-player.tsx` 引用**（`grep -rn ac3-sidecar src/` 只命中该文件）。若删除 `NativeRangeChunkedMediaPlayer` 后该 import 失去引用，可一并清理 import。但 `ac3-sidecar.ts` 文件本体是否还有其他价值需确认——**默认保留文件本体，只在 media-player.tsx 内解除不再使用的 import**。

#### 5.3.3 chunked-download.ts（保留）

`frontend/src/lib/chunked-download.ts` 仍被 `page.tsx`（line 17/448/683）用于旧分享兜底下载。新分享 `is_chunked=false` 不触发其多片逻辑（走直链下载分支）。**保留不动**。

---

## 6. 实施顺序（建议分阶段，每阶段独立可验证）

| 阶段 | 内容 | 验收（见第 7 节） |
|------|------|------------------|
| 阶段 1 | `doubao_client.py`：`tos_host` + `init_multipart` + `merge_multipart` | 7.1 协议回归脚本 |
| 阶段 2 | `schemas/upload.py` + `uploads.py`：multipart-init/merge 端点 + commit 改造 | 7.2 后端单测 + 手动 curl |
| 阶段 3 | 验证合并后单对象 Range 206 + moov 偏移一致性 | 7.3 硬依赖验证 |
| 阶段 4 | 前端 `api.ts` + `upload-state.ts` + `file-uploader.tsx` 上传重写 | 7.4 端到端上传 |
| 阶段 5 | SDP 默认化 + 主路径死代码清理 | 7.5 播放回归 |
| 阶段 6 | 全链路回归（上传大 mp4 → SDP 播放 + seek） | 7.6 完整回归 |

> 阶段 1-3 是后端，可独立完成并验证；阶段 4 依赖阶段 1-3 的接口；阶段 5-6 是收尾。**不要跳过阶段 3**——它验证整个迁移的两个硬依赖。

---

## 7. 验收标准与回归命令

### 7.1 阶段 1：协议方法回归

用真实凭证跑一遍 init_multipart + merge_multipart。验证脚本 `test_multipart.py` 已删除（协议流程见 `docs/spikes/spike-multipart-upload.md`），按其思路临时重写一个脚本即可：

```bash
cd /data/nyy/backend && .venv/bin/python <临时脚本>.py
```

**通过标准**：输出 `🎉 Multipart合并成功`，下载验证 `✓ 文件完整`。

### 7.2 阶段 2：后端单测 + 手动验证

```bash
cd /data/nyy/backend && .venv/bin/python -m pytest tests/test_uploads.py -v
cd /data/nyy/backend && .venv/bin/ruff check app/
```

**通过标准**：现有上传测试全绿（不能因改动破坏小文件路径）；ruff 无新增告警。

手动验证 multipart 端点（启动服务后）：
```bash
# multipart-init → 返回 multipart_token/tos_host/upload_id/part_size=67108864/part_count
curl -X POST localhost:8000/api/v1/uploads/multipart-init \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer <token>' \
  -d '{"file_name":"test.mp4","file_size":134217728,"file_ext":"mp4","logical_file_id":"<uuid>"}'
```

**通过标准**：返回 `part_size=67108864`（64MB）、`part_count=2`、`part_number_base=0`（<1GB）。

### 7.3 阶段 3：硬依赖验证（最关键，不可跳过）

**依赖 A — Range 206**：取一个 merge 后对象的 `download_url`，验证支持 Range：
```bash
curl -sI -H 'Range: bytes=0-1023' '<download_url>' | grep -iE 'HTTP|content-range|accept-ranges'
```
**通过标准**：返回 `HTTP/.. 206`、`Content-Range: bytes 0-1023/<total>`。（实测已确认，此处是回归确认。）

**依赖 B — moov 偏移一致性**：上传一个 mp4（faststart，moov 在前），记录前端探测的 `media_metadata.moov_offset`，下载 merge 后对象用 mp4 工具核对 moov box 实际偏移一致。
```bash
# 用 ffprobe 或 mp4dump 核对 moov 位置
ffprobe -v trace '<download_url>' 2>&1 | grep -i moov | head
```
**通过标准**：合并后对象的 moov box 字节偏移与上传时探测值一致（multipart 合并是字节拼接，理论上必然一致，此处是兜底验证）。

### 7.4 阶段 4：端到端上传

前端启动后，上传一个 >512MB 的 mp4：
```bash
cd /data/nyy/frontend && npm run build   # 先确保类型/构建通过
```
**通过标准**：
- 上传过程中开发者工具 Network 看到多个 `PUT ...?partNumber=N&uploadID=X` 请求（64MB 每个，3 个并发）
- 1 次 `POST /uploads/multipart-merge`
- 1 次 `POST /uploads/commit`
- DB 中该分享只有 **1 行 ShareFile**（`chunk_total=1`）
- 上传中刷新页面 → 续传只重传未完成的 part（断点续传生效）

### 7.5 阶段 5：播放回归

```bash
cd /data/nyy/frontend && npm run lint && npm run build
cd /data/nyy/frontend && npm run test:seek-patient && npm run test:seek-rapid
cd /data/nyy/frontend && npm run test:sdp-ac3-stress && npm run test:mkv-drift
```
**通过标准**：lint/build 通过；SDP seek/AC-3/MKV 回归脚本全绿。打开分享页（不带 `?sdp` 参数）默认走 SDP 播放器。

### 7.6 阶段 6：完整回归

手动走查：上传大 mp4 → 分享页默认 SDP 播放 → 快进/快退多次 → 音画同步 → 移动端浏览器能下载（验证单对象全平台下载）。

---

## 8. 风险清单与注意事项

| 风险 | 影响 | 缓解 |
|------|------|------|
| **单 uploadID 并发 UploadPart 在生产高失败** | part 上传失败率升高 | 实测可行；若线上失败率高，把 `MULTIPART_PART_CONCURRENCY` 改为 1（单文件内串行，对齐官方） |
| **uploadID 服务端过期** | 续传时 part 上传失败 | 续传前检测；失败则丢弃会话重新 multipart-init |
| **merge body 索引写错** | InvalidMergeParts | 严格用 `enumerate(crc_list)` 从 0 连续，**不要**用上传时的 partNumber（可能从 1） |
| **发 JSON merge body** | InvalidMergeParts（历史踩坑） | merge body 必须是纯文本 `0:crc,1:crc`，不是 JSON |
| **>1GB 文件漏带 gateway 头** | Init/Part/Merge 失败 | `is_large_file` 时三步都带 `X-Storage-Mode: gateway` |
| **合并后 URL 不支持 Range** | SDP 播放直接失败 | 阶段 3 验证（实测已确认支持） |
| **删 virtual-media.ts 破坏 ac3-lab** | ac3-lab 页编译失败 | **不删该文件**，仅解除主路径引用（见 §5.3.1 修正） |
| **小文件路径被误改** | 中小文件上传回归 | multipart 仅 >512MB 触发，≤512MB 走原逻辑；跑 `test_uploads.py` 回归 |
| **session.chunk_total 未改为 1** | **上传必然失败**（commit 校验 `expectedItems != finalResults`） | 见 §4.4.2，`createSessionForCurrentSelection` 把 `chunk_total` 统一改为 1 |
| **uploads.py 漏 `import re`** | `_is_valid_crc32` NameError | 见 §3.0，顶部补 `import re` |
| **schemas import 未扩充** | 4 个新 schema ImportError | 见 §3.0，扩充 `from app.schemas.upload import (...)` |
| **CommitLogicalFileItem.chunk_total 填错** | 落库 chunk_total 不为 1 | multipart 文件该字段填 1 |
| **旧分享下载** | 存量多对象分享 | `shares.py` 多片分支保留作兜底，不删 |

---

## 9. 改动文件总清单

**后端**（3 个文件有改动）：
- `app/services/doubao_client.py`：`UploadInitResult.tos_host` + `init_multipart` + `merge_multipart`
- `app/schemas/upload.py`：4 个新 schema
- `app/api/v1/uploads.py`：常量 + 2 个新端点 + `upload_commit` 小改

**前端**（3 个文件有改动 + 主路径清理）：
- `src/lib/api.ts`：2 类型 + 2 函数
- `src/lib/upload-state.ts`：`multipart` 字段 + 3 写状态函数
- `src/components/file-uploader.tsx`：multipart 上传重写
- `src/app/[code]/page.tsx`：SDP 默认化 + 移除 SW 预热
- `src/components/media-player.tsx`：删 `NativeRangeChunkedMediaPlayer`，保留 `NativeDirectMediaPlayer`

**不改动**：`shares.py`、`models/share.py`、migrations、`chunked-download.ts`、`virtual-media.ts`（文件本体）、`ac3-sidecar.ts`、所有 SDP 文件、ac3-lab 页。




















