# 核云 VPS 媒体中心自动化方案（Emby + Wizarr + MoviePilot + ImageX Gateway）

## 一、文档目标

本文档只落盘当前已经明确的 3 个开源基线项目，并结合**参考源码**与核云 VPS 部署目标给出可执行方案：

1. `Wizarr`：Emby 邀请链接与临时账号 UI
2. `embyExternalUrl / MediaLinker`：Emby 直链重定向层的改造基线
3. `MoviePilot`：中文自动化下载 / 整理 / 刮削 / 刷库基线

同时明确一个事实：

**这 3 个项目都不能直接解决「豆包 ImageX 不是标准 S3/TOS」的问题。**

因此，本方案不是“纯拼装”，而是：

```text
现成轮子：Wizarr + Emby + MoviePilot + embyExternalUrl
必须自研：ImageX Upload Worker + ImageX Gateway
```

本文档只覆盖：

- Emby 作为媒体分发入口
- Wizarr 作为邀请 / 临时账号 UI
- MoviePilot 作为自动化下载与整理层
- embyExternalUrl 作为未来重定向改造基线
- ImageX Gateway 作为必要自研适配层

本文档暂不覆盖：

- 发卡系统
- 支付系统
- 按天/月/年售卖流程
- 商业化风控

## 二、已确认前提

### 2.1 服务器现状

| 项目 | 详情 |
|------|------|
| IP | `103.231.56.106` |
| 系统 | `Ubuntu 24.04.1 LTS` |
| CPU | 16 核 |
| 内存 | 16 GB |
| 磁盘 | 68 GB（可用约 65 GB） |
| 带宽 | 标称 700 Mbps |
| 域名 | `media.nyy.app` |
| 现有豆包 Session | 项目内已有 `.doubao_session.json` 与状态机逻辑 |

### 2.2 ImageX 实测结论

已经完成源码阅读与 VPS 实测，结论如下：

1. 豆包上传链路使用的是 **ImageX 专有 API + 专有鉴权**，不是标准 S3。
2. 大文件上传必须遵循**参考源码**中已经验证过的参数：
   - 分片大小：`64MB`
   - 分片并发：`3`
   - 单片重试：`3` 次
   - 单片超时：`30 分钟`
   - CRC32：本地计算 + 服务端回传双重校验
3. 在核云 VPS 上，按项目源码参数实测 2GB 文件上传成功：
   - `32` 片 × `64MB`
   - `3` 并发
   - 耗时 `40.2 秒`
   - 平均上传速度约 `417 Mbps / 52.17 MB/s`
4. **ImageX 不兼容标准 S3/TOS API**，无法被 Alist / rclone 直接当作 S3 后端挂载。

因此旧方案中的：

```text
Jellyfin + Alist + rclone 直接挂 TOS
```

已经被证伪，不能继续作为当前方案基线。

## 三、3 个上游项目的源码级确认结果

本节不是 README 摘抄，而是结合源码阅读后给出的“能不能直接用”的判断。

### 3.1 Wizarr

仓库：`wizarrrr/wizarr`

#### 已确认能力

通过源码确认：

- 支持 `server_type="emby"`
- 支持邀请链接注册
- 支持用户过期时间 `User.expires`
- 支持定时任务检查过期用户
- 支持 **过期后禁用或删除用户**
- 提供完整 Web UI

关键源码位置：

- `app/models.py`
  - `Invitation.duration`
  - `Invitation.expires`
  - `User.expires`
- `app/services/invites.py`
  - 创建 invitation
  - 处理 `expires` 与 `duration`
- `app/services/expiry.py`
  - 计算用户到期时间
  - 到期后 `disable` 或 `delete`
- `app/tasks/maintenance.py`
  - 定时处理过期用户
- `app/services/media/emby.py`
  - `EmbyClient.join()`
  - `EnableContentDownloading / EnableLiveTvAccess / AllowCameraUpload`
  - Emby 用户策略写入
- `app/templates/modals/invite.html`
  - 管理员创建邀请 UI

#### 对当前需求的匹配度

当前你的需求是：

- 需要 UI
- 需要生成 Emby 邀请
- 需要临时账号
- 需要 1 天 / 1 个月 / 1 季度 / 1 年账号
- 暂不接支付

`Wizarr` 的匹配情况：

| 能力 | 是否原生支持 | 说明 |
|------|--------------|------|
| Emby 服务器接入 | 是 | 已确认源码存在 Emby client |
| 邀请链接注册 | 是 | 原生能力 |
| 临时账号到期 | 是 | 通过 `duration` + `User.expires` |
| 到期后自动禁用/删除 | 是 | `expiry_action` 控制 |
| Web UI | 是 | 原生管理界面 |
| 1天账号 | 是 | `duration=1` |
| 1个月账号 | 是 | `duration=30` |
| 1季度账号 | 是 | `duration=90` |
| 1年账号 | 是 | `duration=365` |
| 固定套餐按钮 | 否 | 原生是“数字天数输入框”，不是 4 个固定按钮 |

#### 结论

`Wizarr` **本阶段可以直接采用**，作为：

```text
Emby 邀请 + 临时账号 UI
```

但要明确：

- 当前原生 UI 是“输入天数”，不是“1天 / 1月 / 1季度 / 1年”4 个固定按钮。
- 如果你后续要求管理员界面必须出现固定套餐按钮，那是一个**小定制项**，不是原生能力。

### 3.2 embyExternalUrl / MediaLinker

仓库：

- `chen3861229/embyExternalUrl`
- `thsrite/MediaLinker`

#### 已确认能力

通过 README、FAQ、njs 代码确认：

- 核心工作方式是：

```text
Emby 扫描 rclone 挂载的媒体路径
  ↓
nginx + njs 拦截 PlaybackInfo / stream
  ↓
查询 Alist API
  ↓
取到 raw_url
  ↓
302 重定向给客户端
```

- 关键依赖是：
  - **rclone 挂载路径存在**
  - **Alist `/api/fs/get` 与 `/api/fs/list` 可用**
- `emby2Alist/nginx/conf.d/emby.js` 中直接写死了：
  - `alistAddr`
  - `alistToken`
  - `/api/fs/get`
  - `/api/fs/list`
- `MediaLinker` 只是它的 Docker 封装版，不改变这个根假设。

#### 对当前需求的匹配度

| 能力 | 是否原生匹配 ImageX | 说明 |
|------|--------------------|------|
| Emby 播放拦截 | 是 | 机制成熟 |
| 302 直链重定向 | 是 | 机制成熟 |
| 适配标准网盘/对象存储 | 是 | 依赖 Alist |
| 适配豆包 ImageX | 否 | 因为它假设 Alist 可列目录、可返回 raw_url |

#### 结论

`embyExternalUrl / MediaLinker` **不能本阶段直接拿来就跑**，但它依然值得采用，角色应明确为：

```text
未来的 Emby 直链重定向改造基线
```

要让它适配 ImageX，必须把“查 Alist 直链”的部分替换成我们自己的 `ImageX Resolver`。

因此在本方案里，它的定位是：

- **现在不作为开箱即用组件部署**
- **作为后续改造基线保留**
- 等 `ImageX Gateway` 的 Resolver API 完成后再接入

### 3.3 MoviePilot

仓库：`jxxghp/MoviePilot`

#### 已确认能力

通过源码确认：

- 原生支持 `qBittorrent`
  - `app/modules/qbittorrent/qbittorrent.py`
- 原生支持 `Emby`
  - `app/modules/emby/emby.py`
- 原生支持 Emby 刷库
  - `refresh_root_library()`
  - `refresh_library_by_items()`
- 原生定位就是：
  - 搜索
  - 订阅
  - 下载
  - 整理
  - 刮削
  - 媒体库刷新

#### 对当前需求的匹配度

| 能力 | 是否匹配 | 说明 |
|------|----------|------|
| 中文资源自动化 | 是 | 这是它的强项 |
| qBittorrent 接入 | 是 | 已有模块 |
| Emby 刷库 | 是 | 已有模块 |
| 整理 / 刮削 | 是 | 已有完整链路 |
| 直接支持 ImageX | 否 | 仍需要我们自研上传 Worker / Gateway |

#### 重要边界

MoviePilot README 明确写了：

```text
仅用于学习交流使用，请勿在任何国内平台宣传该项目！
```

所以必须写清楚：

- **本阶段（不售卖、不商业化）可作为内部自动化引擎使用**
- **未来如果进入正式收费分发，不建议继续把它作为商业对外核心系统宣传**

#### 结论

`MoviePilot` **本阶段可以直接采用**，作为：

```text
中文影视自动化下载 / 整理 / 刮削 / Emby 刷库引擎
```

## 四、本阶段的最终结论

### 4.0 仓库组织前提

本方案的仓库组织方式已经明确为：

```text
全新独立仓库
+ monorepo 结构
+ 最终部署到核云 VPS
```

这意味着：

1. 不把本系统并入当前工作区已有项目。
2. 当前工作区已有项目只作为参考源码来源。
3. 后续实现的 `admin-portal`、`imagex-gateway`、`upload-worker`、`deploy`、`docs` 都收敛到一个新仓库中。

### 4.0.0 推荐技术栈

当前最匹配、也最符合开源社区最佳实践的技术栈建议为：

| 层 | 推荐技术栈 | 原因 |
|----|------------|------|
| 管理后台前端 | `Vue 3 + Vite + TypeScript` | 后台管理界面开发效率高，适合表格/表单/状态面板 |
| 管理后台后端 | `Python 3.12 + FastAPI` | 方便聚合 Wizarr / MoviePilot / qB / ImageX API |
| ImageX Gateway | `Python 3.12 + FastAPI` | 最利于复用参考源码中的 ImageX/session 逻辑 |
| Upload Worker | `Python 3.12` | 最利于复用 multipart 上传、重试、分类逻辑 |
| 数据库 | `PostgreSQL` | 适合用户、邀请、索引、任务等核心业务数据 |
| 反向代理 | `nginx` | 与未来 `embyExternalUrl` 方向一致 |
| 编排 | `Docker Compose` | 单 VPS 场景最佳实践 |
| 宿主机任务 | `systemd` | 适合 rclone mount、worker、巡检 |

### 4.0.1 推荐的 monorepo 顶层结构

```text
nyy-media-platform/
├── apps/
│   ├── admin-portal/
│   ├── admin-api/
│   ├── imagex-gateway/
│   └── upload-worker/
├── deploy/
│   ├── docker/
│   ├── nginx/
│   ├── systemd/
│   └── env/
├── docs/
├── scripts/
├── fixtures/
└── README.md
```

### 4.0.2 各目录职责

| 目录 | 作用 |
|------|------|
| `apps/admin-portal` | `admin.nyy.app` 的前端界面 |
| `apps/admin-api` | `admin.nyy.app` 的聚合后端 |
| `apps/imagex-gateway` | ImageX 索引、WebDAV、Resolver、Session 适配层 |
| `apps/upload-worker` | 上传任务执行器 |
| `deploy/docker` | `docker-compose`、镜像构建、服务编排 |
| `deploy/nginx` | 站点配置、反代、TLS |
| `deploy/systemd` | rclone mount、worker、巡检任务 |
| `deploy/env` | 环境变量模板，不放真实密钥 |
| `docs` | 架构、部署、运维、排障文档 |
| `scripts` | 初始化、迁移、运维辅助脚本 |
| `fixtures` | 示例配置、假数据、接口样本 |

### 4.1 直接采用的项目

| 项目 | 本阶段是否部署 | 角色 |
|------|----------------|------|
| Wizarr | 是 | Emby 邀请与临时账号 UI |
| MoviePilot | 是 | 自动化下载 / 整理 / 刮削 / 刷库 |
| qBittorrent | 是 | BT 下载器与下载管理 UI |
| Emby | 是 | 用户播放入口与媒体库服务 |

### 4.2 作为改造基线保留的项目

| 项目 | 本阶段是否直接部署 | 角色 |
|------|--------------------|------|
| embyExternalUrl / MediaLinker | 否（不开箱即用） | 未来直链重定向层改造基线 |

### 4.3 必须自研补位的组件

| 组件 | 原因 |
|------|------|
| ImageX Upload Worker | 把本地下载完成文件上传到 ImageX |
| ImageX 媒体索引 | ImageX 无法像 S3 一样列目录，必须自己记 `path → store_uri` |
| ImageX Gateway | 提供 WebDAV 只读出口 + Resolver API |
| Session 守护服务 | 复用参考源码里已验证的 session 心跳 / 刷新状态机逻辑 |

## 五、本阶段推荐架构

```text
MoviePilot
  ↓ 搜索 / 订阅 / 下载任务编排
qBittorrent
  ↓ 下载完成
ImageX Upload Worker（自研）
  ↓
豆包 ImageX
  ↓
ImageX 媒体索引（PostgreSQL）
  ↓
ImageX Gateway（自研）
  ├── WebDAV 只读出口
  ├── Resolver API（下一阶段给 embyExternalUrl 用）
  └── Session 刷新守护
  ↓
rclone mount WebDAV
  ↓
Emby
  ↑
Wizarr（邀请链接 / 临时账号 / 到期处理 UI）
```

## 六、本阶段与下一阶段的边界

### 6.1 本阶段立即落地

1. Emby
2. Wizarr
3. MoviePilot
4. qBittorrent
5. ImageX Upload Worker
6. ImageX Gateway WebDAV
7. rclone mount WebDAV → Emby 扫库

### 6.2 下一阶段再接入

1. `embyExternalUrl / MediaLinker` 改造版
2. ImageX Resolver → Emby 播放直链重定向
3. 账号售卖 / 支付 / 发卡

原因：

当前 `embyExternalUrl` 直接依赖 Alist API，而我们还没有 ImageX Resolver 替代层，强上会埋坑。

### 6.3 第一阶段实际部署清单

第一阶段不是“全量最终态”，而是先把用户可登录、管理员可邀请、下载可自动化、ImageX 可入库跑通。

#### 必装服务

| 服务 | 是否第一阶段部署 | 说明 |
|------|------------------|------|
| Emby | 是 | 用户播放入口 |
| Wizarr | 是 | 邀请 / 临时账号 UI |
| MoviePilot | 是 | 中文资源自动化引擎 |
| qBittorrent | 是 | 实际下载器 |
| nginx | 是 | 统一反向代理与 HTTPS 入口 |
| rclone | 是 | 挂载 Gateway 暴露的 WebDAV |
| ImageX Upload Worker | 是 | 下载完成后上传 ImageX |
| ImageX Gateway | 是 | WebDAV + 索引 + Session 守护 |

#### 第一阶段不部署

| 服务 | 原因 |
|------|------|
| Alist | 当前不需要，且不能直接解决 ImageX 问题 |
| Jellyfin | 已明确本阶段以 Emby 为分发入口 |
| embyExternalUrl / MediaLinker | 先不直接部署，保留为下一阶段改造基线 |
| 支付 / 发卡系统 | 当前不做 |

#### 第一阶段成功标准

第一阶段完成后，应满足：

1. 管理员可登录 Emby 管理后台。
2. 管理员可登录 Wizarr，并创建 Emby 邀请。
3. 受邀用户可通过 Wizarr 链接注册 Emby 账号。
4. 账号可设置 `1 / 30 / 90 / 365` 天有效期。
5. 过期账号可按配置自动 `disable` 或 `delete`。
6. MoviePilot 能将资源发送给 qBittorrent 下载。
7. 下载完成后，Upload Worker 能上传到 ImageX 并写入索引。
8. Emby 能通过 WebDAV 挂载路径扫描到媒体库。
9. 新媒体入库后，MoviePilot 或 Worker 能触发 Emby 刷库。

## 七、组件职责与部署建议

### 7.1 Emby

角色：

- 用户登录入口
- 媒体库浏览
- 海报、元数据、进度记录
- 多端客户端兼容

本阶段使用方式：

- Emby 读取 `/mnt/imagex-media`
- `/mnt/imagex-media` 由 `rclone mount webdav:` 提供
- Emby 暂时走正常文件流读取，不做直链重定向

重要设置建议：

- 禁用用户下载
- 禁用共享
- 禁用删除
- 默认关闭转码（可后续按需打开）
- 建议关闭缩略图 / 图像提取类重任务

### 7.2 Wizarr

角色：

- 管理员 UI 创建 Emby 邀请
- 用户通过邀请链接完成注册
- 账号自动按到期时间禁用 / 删除

本阶段写法必须明确：

- 使用原生 UI 的 **Duration（天数输入）** 生成账号时长
- 可以支持：
  - 1 天：填 `1`
  - 1 个月：填 `30`
  - 1 季度：填 `90`
  - 1 年：填 `365`

### 7.3 MoviePilot

角色：

- 中文资源搜索 / 订阅 / 下载编排
- 下载完成后的识别、整理、刮削
- 通知 Emby 刷新媒体库

本阶段接法：

- 下载器接 `qBittorrent`
- 媒体服务器接 `Emby`
- MoviePilot 负责完成下载侧自动化
- 上传到 ImageX 不走 MoviePilot 原生能力，交给我们自己的 Upload Worker

### 7.4 qBittorrent

角色：

- 实际 BT 下载器
- 下载管理 UI

本阶段建议：

- 保留它自己的 Web UI
- 不用强行把“所有下载管理”都塞给 MoviePilot

### 7.5 nginx

角色：

- 统一域名入口
- HTTPS 证书终止
- 各服务路径反代
- 下一阶段承接 `embyExternalUrl` 的 njs 重定向改造

本阶段建议：

- 即使暂不接入 `embyExternalUrl`，也应先使用 nginx 作为统一入口。
- 不建议本阶段使用 Caddy 替代，因为后续 `embyExternalUrl` 的落地基线是 nginx + njs。

## 八、ImageX Gateway 的最低职责

这是本方案最关键的自研件。

### 8.1 最低必须实现

1. 记录媒体索引
   - 逻辑路径
   - store_uri
   - 文件大小
   - 文件类型
   - 创建时间
   - 电影 / 剧集分类

2. 提供只读 WebDAV
   - `PROPFIND`
   - `GET`
   - `HEAD`
   - `Range`

3. 提供上传后写索引能力

4. 提供 Session 心跳 / 刷新守护

5. 提供最小管理 API
   - 查看媒体索引
   - 查看上传任务状态
   - 查看 session 状态
   - 手动重试失败任务

### 8.2 先不要求实现

1. S3 兼容层
2. Alist 兼容层
3. 支付系统
4. 对外开放 WebDAV 给终端用户

### 8.3 Gateway 最小接口定义

以下是第一阶段建议实现的最小接口集合。

#### 上传与任务接口

| 方法 | 路径 | 作用 |
|------|------|------|
| `POST` | `/api/v1/tasks/upload` | 提交本地文件上传任务 |
| `GET` | `/api/v1/tasks/upload` | 查看上传任务列表 |
| `POST` | `/api/v1/tasks/upload/{id}/retry` | 重试失败任务 |
| `GET` | `/api/v1/tasks/upload/{id}` | 查看单个任务详情 |

#### 媒体索引接口

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/api/v1/media` | 按目录/分类分页查询索引 |
| `GET` | `/api/v1/media/{id}` | 查询单条媒体索引 |
| `POST` | `/api/v1/media/scan` | 触发索引一致性检查 |

#### Session 状态接口

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/api/v1/session/status` | 查看 session 状态 |
| `POST` | `/api/v1/session/heartbeat` | 手动心跳 |
| `POST` | `/api/v1/session/refresh/start` | 手动触发刷新流程 |

#### 未来预留接口

| 方法 | 路径 | 作用 |
|------|------|------|
| `POST` | `/api/v1/resolve` | 未来给 `embyExternalUrl` 使用，输入逻辑路径或 store_uri，返回短期播放直链 |

### 8.4 WebDAV 最小能力定义

第一阶段 WebDAV 只要求满足 Emby 扫库与读取，能力如下：

| 能力 | 是否必须 | 说明 |
|------|----------|------|
| `OPTIONS` | 建议 | 兼容更多客户端探测 |
| `PROPFIND` | 必须 | 列目录 |
| `HEAD` | 必须 | 获取大小/类型 |
| `GET` | 必须 | 文件读取 |
| `Range` | 必须 | 拖动进度条与断点读取 |
| `PUT/DELETE/MKCOL` | 禁用 | 只读媒体库 |

### 8.5 ImageX 索引最小数据模型

第一阶段建议至少落 3 张表。

#### `media_items`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID / bigint | 主键 |
| `logical_path` | text unique | 对外逻辑路径，例如 `Movies/.../file.mkv` |
| `category` | varchar | `movie` / `tv` / `doc` / `other` |
| `store_uri` | text | ImageX commit 后的 URI |
| `file_name` | text | 文件名 |
| `file_size` | bigint | 字节数 |
| `mime_type` | varchar | MIME |
| `sha1` | varchar nullable | 可选，用于幂等判重 |
| `created_at` | timestamptz | 创建时间 |
| `updated_at` | timestamptz | 更新时间 |

#### `upload_tasks`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID / bigint | 主键 |
| `source_path` | text | 本地源文件路径 |
| `target_logical_path` | text | 目标逻辑路径 |
| `status` | varchar | `pending/running/success/failed` |
| `attempts` | int | 已重试次数 |
| `error_message` | text nullable | 失败原因 |
| `store_uri` | text nullable | 成功后写入 |
| `created_at` | timestamptz | 创建时间 |
| `updated_at` | timestamptz | 更新时间 |

#### `session_status`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | int | 固定单行或多行历史 |
| `session_file` | text | session 文件路径 |
| `last_heartbeat_at` | timestamptz nullable | 最近心跳 |
| `last_heartbeat_success_at` | timestamptz nullable | 最近成功心跳 |
| `last_probe_at` | timestamptz nullable | 最近上传能力探测 |
| `last_probe_success_at` | timestamptz nullable | 最近成功探测 |
| `last_error` | text nullable | 最近错误 |

### 8.6 上传 Worker 最小行为

第一阶段 Upload Worker 必须遵守：

1. 只处理 `qBittorrent` 已完成文件。
2. 上传前先计算目标逻辑路径。
3. 成功上传并 `commit` 后才删除本地文件。
4. 任一失败只记录任务，不得误删本地源文件。
5. 失败任务必须保留重试入口。
6. 上传并落索引成功后，再触发 Emby 刷库。

## 九、目录规划

```text
/opt/media-server/
  docker/
  configs/
  scripts/
  logs/

/data/
  downloads/
    incomplete/
    complete/
  emby/
    config/
    cache/
    transcode/
  moviepilot/
  wizarr/
  imagex-gateway/
    db/
    cache/
    logs/
  uploads/
    .doubao_session.json

/mnt/imagex-media/
  # rclone mount 的 WebDAV 媒体视图
```

### 9.1 docker-compose 拓扑建议

第一阶段建议拆成 2 层：

1. **业务容器层**
2. **宿主机集成层**

#### 业务容器层

| 服务 | 建议容器名 | 依赖 |
|------|------------|------|
| nginx | `media-nginx` | emby / wizarr / moviepilot / qbittorrent / gateway |
| emby | `media-emby` | 挂载 `/mnt/imagex-media` |
| wizarr | `media-wizarr` | emby |
| moviepilot | `media-moviepilot` | qbittorrent / emby |
| qbittorrent | `media-qbittorrent` | 无 |
| gateway | `media-imagex-gateway` | session 文件 / 数据库 |

#### 宿主机集成层

| 组件 | 角色 |
|------|------|
| `rclone mount webdav:` | 把 Gateway WebDAV 挂成 Emby 本地目录 |
| `systemd service` | 持久化 rclone mount |
| `systemd timer/cron` | session 心跳、磁盘监控、失败重试 |

### 9.2 服务依赖关系

```text
nginx
  ├── emby
  ├── wizarr
  ├── moviepilot
  ├── qbittorrent
  ├── admin-portal
  ├── admin-api
  └── imagex-gateway

moviepilot
  ├── qbittorrent
  └── emby

emby
  └── /mnt/imagex-media (由 rclone mount 提供)

imagex-gateway
  ├── 豆包 session 文件
  ├── 索引数据库
  └── 上传任务状态
```

### 9.3 第一阶段 docker-compose 草案

这一节不是最终可执行文件，而是第一阶段服务编排基线，用于后续正式写 `docker-compose.yml`。

#### 业务编排目标

```text
1. 所有用户侧入口都经过 nginx
2. Emby / Wizarr / MoviePilot / qBittorrent 都容器化
3. Admin Portal / Admin API / ImageX Gateway 都容器化
4. rclone mount 仍在宿主机执行
5. Emby 通过宿主机挂载目录读取媒体库
```

#### 建议编排草案

```yaml
services:
  nginx:
    image: nginx:stable-alpine
    container_name: media-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /opt/media-server/nginx/conf.d:/etc/nginx/conf.d:ro
      - /opt/media-server/nginx/certs:/etc/nginx/certs:ro
      - /opt/media-server/nginx/logs:/var/log/nginx
    depends_on:
      - emby
      - wizarr
      - moviepilot
      - qbittorrent
      - admin-portal
      - admin-api
      - imagex-gateway

  emby:
    image: emby/embyserver:latest
    container_name: media-emby
    restart: unless-stopped
    network_mode: bridge
    volumes:
      - /data/emby/config:/config
      - /data/emby/cache:/cache
      - /data/emby/transcode:/transcode
      - /mnt/imagex-media:/media/imagex:ro

  wizarr:
    image: ghcr.io/wizarrrr/wizarr:latest
    container_name: media-wizarr
    restart: unless-stopped
    environment:
      - PUID=0
      - PGID=0
      - TZ=Asia/Shanghai
      - DISABLE_BUILTIN_AUTH=false
    volumes:
      - /data/wizarr:/data

  moviepilot:
    image: jxxghp/moviepilot-v2:latest
    container_name: media-moviepilot
    restart: unless-stopped
    environment:
      - TZ=Asia/Shanghai
    volumes:
      - /data/moviepilot:/config
      - /data/downloads:/downloads

  qbittorrent:
    image: lscr.io/linuxserver/qbittorrent:latest
    container_name: media-qbittorrent
    restart: unless-stopped
    environment:
      - PUID=0
      - PGID=0
      - TZ=Asia/Shanghai
      - WEBUI_PORT=8080
      - TORRENTING_PORT=6881
    volumes:
      - /data/qbittorrent/config:/config
      - /data/downloads:/downloads

  admin-portal:
    image: local/admin-portal:dev
    container_name: media-admin-portal
    restart: unless-stopped

  admin-api:
    image: local/admin-api:dev
    container_name: media-admin-api
    restart: unless-stopped
    environment:
      - TZ=Asia/Shanghai
      - DATABASE_URL=postgresql://REDACTED

  postgres:
    image: postgres:16-alpine
    container_name: media-postgres
    restart: unless-stopped
    environment:
      - POSTGRES_DB=media_platform
      - POSTGRES_USER=media_platform
      - POSTGRES_PASSWORD=REDACTED
    volumes:
      - /data/postgres:/var/lib/postgresql/data

  imagex-gateway:
    image: local/imagex-gateway:dev
    container_name: media-imagex-gateway
    restart: unless-stopped
    environment:
      - TZ=Asia/Shanghai
      - DATABASE_URL=postgresql://REDACTED
      - DOUBAO_SESSION_FILE=/data/session/.doubao_session.json
      - BARK_PUSH_URL=https://bark.nyy.app/<device-key>
    volumes:
      - /data/imagex-gateway:/data
      - /data/uploads/.doubao_session.json:/data/session/.doubao_session.json:ro
      - /data/downloads:/downloads
```

#### 编排说明

1. `nginx`：唯一公网入口。
2. `emby`：不直接暴露 8096 到公网，由 nginx 反代。
3. `wizarr`：不直接暴露 5690 到公网，由 nginx 反代。
4. `moviepilot`：不直接暴露内部端口，由 nginx 反代。
5. `qbittorrent`：不直接暴露 8080 到公网，由 nginx 反代。
6. `imagex-gateway`：不对公网普通用户开放，只允许 nginx 或内网使用。
7. `postgres`：只在内部网络提供服务，不对公网开放。

### 9.4 宿主机 systemd 草案

第一阶段除了容器，还需要至少 3 个宿主机服务：

| 服务 | 说明 |
|------|------|
| `rclone-imagex-media.service` | 挂载 Gateway WebDAV 到 `/mnt/imagex-media` |
| `imagex-upload-worker.service` | 处理下载完成文件上传 |
| `imagex-upload-worker.timer` 或 cron | 重试失败任务 / 定时巡检 |

建议：

- `rclone mount` 不放到容器里，而放到宿主机 systemd。
- Upload Worker 可以做成：
  - 容器内长期进程；或
  - 宿主机 Python 服务。

第一阶段更建议：

```text
Gateway 做 API + WebDAV
Upload Worker 独立服务
```

这样职责更清晰。

## 十、域名规划

本阶段建议：

```text
media.nyy.app   → Emby 用户入口
invite.nyy.app  → Wizarr 邀请注册入口
admin.nyy.app   → 管理员统一入口
```

说明：

- 普通用户只需要 `media.nyy.app`
- 受邀用户使用 `invite.nyy.app` 完成邀请码注册
- 管理员只需要记住一个域名：`admin.nyy.app`

### 10.1 反向代理路径与子域建议

当前采用 **双入口 + 单管理员入口** 方案：

| 域名 | 指向服务 | 是否对普通用户开放 |
|------|----------|-------------------|
| `media.nyy.app` | Emby | 是 |
| `invite.nyy.app` | Wizarr | 是（仅邀请注册入口） |
| `admin.nyy.app` | 管理员统一入口 | 否 |

其中管理员统一入口不再假设服务本身兼容路径前缀，而是直接做成一个原生一体化管理员后台：

```text
admin.nyy.app
  ├── 原生账号管理
  ├── 原生自动化管理
  ├── 原生下载管理
  ├── 原生 ImageX 管理
  └── 原生系统总览
```

这意味着：

- 管理员只记住一个域名：`admin.nyy.app`
- 管理页本身承担主要后台能力，不再把“深跳转原后台”作为默认交互方式
- 但为了排障与兜底，仍保留原系统的**隐藏维护入口**，不对普通管理员开放，且仅限内网 / 本机访问

### 10.2 nginx 基线职责

本阶段 nginx 至少负责：

1. TLS 终止
2. 子域名反代
3. 基础访问控制
4. 管理端 Basic Auth 或 IP 白名单
5. 统一日志

管理端建议增加的保护：

- `admin.nyy.app`

至少应加：

- Basic Auth
- 或 IP 白名单
- 或两者同时使用

### 10.3 第一阶段反向代理关系

建议的反代目标如下：

| 域名 | 上游服务 | 访问控制 |
|------|----------|----------|
| `media.nyy.app` | `media-emby` | 普通用户登录入口 |
| `invite.nyy.app` | `media-wizarr` | 普通受邀用户可访问（仅注册入口） |
| `admin.nyy.app` | 自研统一管理页 | Basic Auth / IP 白名单 |

说明：

1. `invite.nyy.app` 不能整体套 Basic Auth，否则用户无法打开邀请注册链接。
2. `invite.nyy.app` 只承担邀请码注册入口，不承担管理员日常后台职责。
3. `admin.nyy.app` 是管理员唯一入口。
4. `admin.nyy.app` 内部以原生后台方式聚合 MoviePilot / qBittorrent / Gateway 的核心能力。
5. 原始后台保留隐藏维护入口，仅供排障和对照，不作为日常管理入口。

### 10.4 `admin.nyy.app` 信息架构

`admin.nyy.app` 第一阶段的定位已经明确为：

```text
统一管理员后台
  + 原生状态面板
  + 原生账号管理
  + 原生自动化管理
  + 原生下载管理
  + 原生 ImageX 管理
```

不是：

- 统一 SSO 后台
- 强依赖路径前缀兼容的多系统合并页
- 纯跳转式工作台

第一阶段建议的标签结构：

| 标签 | 作用 | 首屏内容 | 第一阶段要求 |
|------|------|----------|--------------|
| 总览 | 看整体健康状态 | Session、上传任务、Emby 在线数、磁盘、下载速率 | 原生实现 |
| 账号 | 管理 Emby 临时账号 | 最近邀请、即将到期账号、到期策略 | 原生实现，调用 Wizarr / Emby 能力 |
| 自动化 | 管理 MoviePilot | 最近订阅任务、整理任务、刮削任务 | 原生实现，调用 MoviePilot API |
| 下载 | 管理 qBittorrent | 当前下载数、速率、完成数、失败数 | 原生实现，调用 qB API |
| ImageX | 管理 Gateway | session 状态、上传队列、失败任务、索引数量 | 原生实现 |
| 系统 | 管理 VPS 与容器 | CPU、内存、磁盘、容器状态 | 原生实现 |

第一阶段交互原则：

1. `admin.nyy.app` 负责统一展示状态。
2. `admin.nyy.app` 负责统一承载日常管理操作。
3. 原始后台仅保留为隐藏维护入口，不作为日常入口。

第一阶段认证原则：

1. `admin.nyy.app` 自己做一层管理员访问保护。
2. **不做 SSO**。
3. 隐藏维护入口仍保留各自登录态，但只允许内网 / 本机访问。

### 10.5 `admin.nyy.app` 页面与接口设计草案

这一节只定义信息架构与接口来源，不预设前端框架。

#### 页面结构草案

```text
admin.nyy.app
├── /login
├── /dashboard
├── /accounts
├── /automation
├── /downloads
├── /imagex
└── /system
```

#### 页面职责

| 页面 | 主要作用 | 第一阶段是否必须 |
|------|----------|------------------|
| `/login` | 管理员入口认证 | 是 |
| `/dashboard` | 全局状态总览 | 是 |
| `/accounts` | Emby 临时账号与邀请管理 | 是 |
| `/automation` | MoviePilot 自动化任务管理 | 是 |
| `/downloads` | qBittorrent 下载任务管理 | 是 |
| `/imagex` | ImageX Gateway 与上传任务管理 | 是 |
| `/system` | VPS / Docker / nginx 状态 | 建议 |

#### 每页数据来源矩阵

| 页面 | 上游数据来源 | 第一阶段接法 |
|------|-------------|-------------|
| `/dashboard` | Wizarr API + MoviePilot API + qB API + Gateway API + 系统探针 | 聚合读取 |
| `/accounts` | Wizarr API + Emby API | 原生页面 + API 编排 |
| `/automation` | MoviePilot REST API | 原生页面 + API 编排 |
| `/downloads` | qBittorrent Web API | 原生页面 + API 编排 |
| `/imagex` | Gateway 自己的 API | 原生页面 |
| `/system` | 自己的系统探针 / Docker / nginx 状态 | 原生页面 |

#### 标签级最小功能

##### A. `/dashboard`

建议第一阶段展示：

- 豆包 Session 状态
- 最近上传成功 / 失败数
- Emby 在线用户数
- 邀请总数 / 未使用邀请数 / 已过期邀请数
- qB 当前下载数 / 下载速率 / 上传速率
- MoviePilot 连通状态
- VPS CPU / 内存 / 磁盘

##### B. `/accounts`

建议第一阶段支持：

- 查看账号列表
- 查看到期时间
- 查看邀请列表
- 创建邀请
- 创建 1 / 30 / 90 / 365 天账号
- 禁用用户
- 删除用户
- 延长用户到期时间
- 修改用户到期时间

建议在这个页面做 4 个快捷动作按钮：

- `创建 1 天账号`
- `创建 30 天账号`
- `创建 90 天账号`
- `创建 365 天账号`

底层并不是写死套餐系统，而是调用 API 时填不同的 `duration`。

##### C. `/automation`

建议第一阶段支持：

- 按标题搜索资源
- 按媒体 ID 搜索资源
- 查询最近搜索结果
- 添加下载任务
- 查看 MoviePilot 状态
- 查看可用下载器
- 查看下载保存路径

##### D. `/downloads`

建议第一阶段支持：

- 查看当前下载任务
- 查看下载速度 / 上传速度
- 暂停任务
- 恢复任务
- 删除任务
- 按 hash 查询单任务

##### E. `/imagex`

建议第一阶段支持：

- 查看 Session 状态
- 查看心跳状态
- 查看 probe 状态
- 查看上传任务队列
- 手动重试失败上传
- 查看媒体索引
- 查看 WebDAV / rclone 挂载状态

### 10.6 `admin.nyy.app` 与上游 API 的映射

#### 账号页与 Wizarr API 映射

已确认可直接复用的 Wizarr API 能力：

| 功能 | 上游 API |
|------|----------|
| 获取统计 | `GET /api/status` |
| 获取用户列表 | `GET /api/users` |
| 禁用用户 | `POST /api/users/{id}/disable` |
| 启用用户 | `POST /api/users/{id}/enable` |
| 删除用户 | `DELETE /api/users/{id}` |
| 延长到期时间 | `POST /api/users/{id}/extend` |
| 直接更新到期时间 | `PUT /api/users/{id}/update-expiry` |
| 获取邀请列表 | `GET /api/invitations` |
| 创建邀请 | `POST /api/invitations` |
| 删除邀请 | `DELETE /api/invitations/{id}` |
| 获取服务器列表 | `GET /api/servers` |

说明：

- 账号页第一阶段可以不直接复用 Wizarr 后台 UI。
- 优先用 API 做自己的原生界面。

#### 自动化页与 MoviePilot API 映射

已确认可直接复用的 MoviePilot REST API 能力：

| 功能 | 上游 API |
|------|----------|
| 标题搜索资源 | `GET /api/v1/search/title` |
| 媒体 ID 搜索资源 | `GET /api/v1/search/media/{mediaid}` |
| 获取最近搜索结果 | `GET /api/v1/search/last` |
| 添加下载任务 | `POST /api/v1/download/` |
| 添加无媒体信息下载 | `POST /api/v1/download/add` |
| 查询下载任务 | `GET /api/v1/download/` |
| 暂停下载 | `GET /api/v1/download/stop/{hashString}` |
| 恢复下载 | `GET /api/v1/download/start/{hashString}` |
| 删除下载 | `DELETE /api/v1/download/{hashString}` |
| 获取下载器列表 | `GET /api/v1/download/clients` |
| 获取下载路径列表 | `GET /api/v1/download/paths` |
| 服务存活检测 | `GET /api/v1/system/ping` |

说明：

- 第一阶段自动化页也可以做成自己的原生页面。
- 复杂高级功能如果未收编，可通过隐藏维护入口兜底。

#### 下载页与 qBittorrent API 映射

qBittorrent 使用其标准 Web API，第一阶段建议至少覆盖：

- 任务列表
- 任务状态
- 速度信息
- 暂停
- 恢复
- 删除

这里不强依赖 qB 原始 WebUI。

### 10.7 隐藏维护入口策略

虽然 `admin.nyy.app` 第一阶段按原生一体化后台建设，但仍建议保留以下隐藏维护入口：

- 原始 Wizarr 后台（管理员维护用，不对普通受邀用户暴露）
- 原始 MoviePilot 后台
- 原始 qBittorrent WebUI

这些入口的用途仅限：

- 排障
- 对照 API 行为
- 弥补第一阶段原生后台未完全覆盖的高级功能

这些入口：

- 不作为日常管理入口
- 不对普通管理员公开
- 明确只内网 / 本机访问

### 10.8 nginx 反代与隐藏入口草案

第一阶段 nginx 建议拆成两类站点：

#### A. 对外站点

| 域名 | 目标 |
|------|------|
| `media.nyy.app` | Emby |
| `invite.nyy.app` | Wizarr 邀请页 / 注册页 |
| `admin.nyy.app` | 自研统一管理员后台 |

#### B. 隐藏维护入口

隐藏维护入口已经明确收敛为：

1. 仅内网 / 本机端口直连
2. 不配置隐藏公网子域名
3. 不作为日常管理入口

#### 内部 upstream 建议

```nginx
upstream emby_upstream {
  server media-emby:8096;
}

upstream wizarr_upstream {
  server media-wizarr:5690;
}

upstream moviepilot_upstream {
  server media-moviepilot:3000;
}

upstream qbittorrent_upstream {
  server media-qbittorrent:8080;
}

upstream imagex_gateway_upstream {
  server media-imagex-gateway:8000;
}

upstream admin_portal_upstream {
  server media-admin-portal:3001;
}

upstream admin_api_upstream {
  server media-admin-api:8001;
}
```

#### 反代职责拆分

| 站点 | nginx 角色 |
|------|------------|
| `media.nyy.app` | 直接反代 Emby |
| `invite.nyy.app` | 直接反代 Wizarr |
| `admin.nyy.app` | 反代自研管理员后台（前端 + 聚合 API） |
| 隐藏维护入口 | 仅用于原始后台调试 |

#### 安全要求

1. `invite.nyy.app` 不能整体套 Basic Auth。
2. `admin.nyy.app` 必须有管理员访问保护。
3. 隐藏维护入口必须只允许内网 / 本机访问。

### 10.9 `admin.nyy.app` 后台接口分层建议

为了让后台真正可维护，建议不要让前端直接散打到 4 个上游系统，而是在 `admin.nyy.app` 后端统一做一层聚合 API。

建议分层：

```text
admin frontend
  ↓
admin backend / admin api facade
  ├── wizarr adapter
  ├── moviepilot adapter
  ├── qbittorrent adapter
  ├── imagex-gateway adapter
  └── system monitor adapter
```

这样做的原因：

1. 前端不需要知道 4 套不同认证方式。
2. 后端可以做统一权限校验。
3. 后端可以做字段归一化。
4. 后续如果替换某个上游系统，前端影响最小。

### 10.10 `admin.nyy.app` 最小后端接口草案

建议自研后台先暴露自己的聚合接口，而不是把上游接口原样转发给前端。

#### 总览

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/api/admin/dashboard` | 聚合总览数据 |

#### 账号

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/api/admin/accounts/users` | 获取 Emby 临时账号列表 |
| `GET` | `/api/admin/accounts/invitations` | 获取邀请列表 |
| `POST` | `/api/admin/accounts/invitations` | 创建邀请/临时账号 |
| `POST` | `/api/admin/accounts/users/{id}/disable` | 禁用账号 |
| `POST` | `/api/admin/accounts/users/{id}/enable` | 启用账号 |
| `DELETE` | `/api/admin/accounts/users/{id}` | 删除账号 |
| `POST` | `/api/admin/accounts/users/{id}/extend` | 延长天数 |
| `PUT` | `/api/admin/accounts/users/{id}/expiry` | 直接修改到期时间 |

#### 自动化

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/api/admin/automation/status` | MoviePilot 状态 |
| `GET` | `/api/admin/automation/search` | 统一资源搜索入口 |
| `POST` | `/api/admin/automation/download` | 添加下载任务 |
| `GET` | `/api/admin/automation/tasks` | 查看自动化任务/下载任务 |

#### 下载

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/api/admin/downloads` | 获取 qB 任务列表 |
| `POST` | `/api/admin/downloads/{hash}/pause` | 暂停 |
| `POST` | `/api/admin/downloads/{hash}/resume` | 恢复 |
| `DELETE` | `/api/admin/downloads/{hash}` | 删除 |

#### ImageX

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/api/admin/imagex/session` | Session 状态 |
| `GET` | `/api/admin/imagex/uploads` | 上传任务列表 |
| `POST` | `/api/admin/imagex/uploads/{id}/retry` | 重试失败上传 |
| `GET` | `/api/admin/imagex/media` | 媒体索引列表 |
| `GET` | `/api/admin/imagex/storage` | WebDAV / rclone / 索引状态 |

#### 系统

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/api/admin/system/health` | 系统健康状态 |
| `GET` | `/api/admin/system/containers` | 容器状态 |
| `GET` | `/api/admin/system/resources` | CPU/内存/磁盘 |

虽然 `admin.nyy.app` 第一阶段按原生一体化后台建设，但仍建议保留以下隐藏维护入口：

- 原始 Wizarr 后台
- 原始 MoviePilot 后台
- 原始 qBittorrent WebUI

这些入口的用途仅限：

- 排障
- 对照 API 行为
- 弥补第一阶段原生后台未完全覆盖的高级功能

这些入口：

- 不作为日常管理入口
- 不对普通管理员公开
- 明确只内网 / 本机访问

## 十一、本阶段实施顺序

### Phase 1：基础服务

1. Docker / Compose
2. GoDaddy DNS
3. Emby
4. qBittorrent
5. nginx 统一入口
6. 申请与部署 `media.nyy.app`、`invite.nyy.app`、`admin.nyy.app`

### Phase 2：自动化层

1. MoviePilot
2. qBittorrent 接入 MoviePilot
3. Emby 接入 MoviePilot
4. 验证下载 → 整理 → Emby 刷库链路
5. 确认 MoviePilot 不直接接触 ImageX 上传逻辑

### Phase 3：账号层

1. Wizarr
2. Emby 接入 Wizarr
3. 验证邀请码注册与到期禁用 / 删除流程
4. 验证 Emby 用户文件夹权限是否按邀请生效
5. 在 Wizarr 后台验证 `expiry_action` 行为是否符合预期

### Phase 4：ImageX 适配层

1. Upload Worker
2. 媒体索引 DB
3. WebDAV 只读出口
4. rclone mount 到 Emby
5. 验证上传成功后 Emby 可见新媒体
6. 验证 Emby 扫库、播放、拖动进度条是否正常

### Phase 5：下一阶段预留

1. embyExternalUrl 改造
2. ImageX Resolver 直链重定向

### 第一阶段默认配置建议

这一节只给建议，不在本文档中强行拍板。

| 配置项 | 建议值 | 说明 |
|--------|--------|------|
| Wizarr `expiry_action` | `disable` | 比 `delete` 更利于后续恢复 |
| Emby 转码 | 先关闭 | 减少复杂度 |
| Emby 下载权限 | 关闭 | 降低内容扩散风险 |
| Emby 共享权限 | 关闭 | 降低账号外扩风险 |
| qBittorrent WebUI | 仅反代访问 | 不直出公网 |
| rclone VFS 缓存 | 适中 | 保证 Emby 扫库稳定 |

### 第一阶段验收清单

第一阶段完成后，建议按以下顺序验收：

#### A. Emby 验收

1. 能通过 `media.nyy.app` 访问 Emby 登录页。
2. 管理员能正常登录。
3. Emby 媒体库路径已指向 `/mnt/imagex-media`。
4. Emby 扫库无路径权限错误。

#### B. Wizarr 验收

1. 能通过 `invite.nyy.app` 访问邀请与注册入口。
2. 能连接 Emby 并读取媒体库列表。
3. 能创建邀请。
4. 邀请链接可注册 Emby 用户。
5. `duration=1/30/90/365` 可正确写入账号过期时间。
6. 过期清理策略可选 `disable` 或 `delete`。

#### C. MoviePilot 验收

1. MoviePilot 能连接 qBittorrent。
2. MoviePilot 能连接 Emby。
3. 任务能正常下发到 qBittorrent。
4. 整理后能触发 Emby 刷库。

#### D. ImageX 验收

1. Upload Worker 能上传小文件和大文件。
2. 大文件上传遵循 `64MB × 3并发 × 3重试`。
3. 上传成功后写入索引。
4. 失败任务不会误删本地文件。

#### E. WebDAV 验收

1. `rclone lsf webdav:` 能列出媒体目录。
2. Emby 能从挂载路径看到同样结构。
3. WebDAV 支持 `Range`，视频拖动不报错。

### 健康检查与告警建议

#### 服务级健康检查

| 服务 | 健康检查方式 |
|------|-------------|
| nginx | `GET /` 或子域首页 200 |
| Emby | `GET /System/Info/Public` 200 |
| Wizarr | `GET /` 200 |
| MoviePilot | 登录页或健康接口 200 |
| qBittorrent | WebUI 200 |
| ImageX Gateway | `GET /api/v1/session/status` 200 |

#### 任务级告警

| 事件 | 动作 |
|------|------|
| Upload Worker 连续失败 3 次 | Bark 通知 |
| Session 心跳失败 | Bark 通知 |
| Session probe 失败 | Bark 通知 |
| 磁盘剩余 < 5GB | Bark 通知 |
| rclone mount 丢失 | Bark 通知 + 自动重挂尝试 |

### 管理员操作说明（Wizarr 临时账号）

这一节非常重要，防止管理员把“邀请码有效期”和“账号有效期”混淆。

#### 创建 1 天账号

- `Expiration`：建议选 `1 day` 或 `1 week`
- `Duration`：填 `1`
- `Unlimited usages`：关闭

#### 创建 1 个月账号

- `Expiration`：建议选 `1 week` 或 `1 month`
- `Duration`：填 `30`
- `Unlimited usages`：关闭

#### 创建 1 季度账号

- `Expiration`：建议选 `1 month`
- `Duration`：填 `90`
- `Unlimited usages`：关闭

#### 创建 1 年账号

- `Expiration`：建议选 `1 month`
- `Duration`：填 `365`
- `Unlimited usages`：关闭

说明：

- `Expiration` 控制的是**邀请链接多久失效**。
- `Duration` 控制的是**注册成功后的账号有效天数**。
- 这两个概念不能混用。

## 十二、第一阶段配置占位清单

这一节列出后续真正实施时必须填写的配置项。

### 12.1 Emby

| 项目 | 占位 |
|------|------|
| 管理员用户名 | `待初始化` |
| 管理员密码 | `待初始化` |
| 媒体库路径 | `/media/imagex` |
| 是否允许转码 | `待确认` |

### 12.2 Wizarr

| 项目 | 占位 |
|------|------|
| Server URL | `http://media-emby:8096` 或反代地址 |
| API Key | `待从 Emby 获取` |
| Expiry Action | `disable`（建议）/ `delete`（待确认） |

### 12.3 MoviePilot

| 项目 | 占位 |
|------|------|
| qBittorrent 地址 | `http://media-qbittorrent:8080` |
| qBittorrent 用户名 | `待设置` |
| qBittorrent 密码 | `待设置` |
| Emby 地址 | `http://media-emby:8096` |
| Emby API Key | `待从 Emby 获取` |

### 12.4 Admin API

| 项目 | 占位 |
|------|------|
| `DATABASE_URL` | `postgresql://.../media_platform` |
| 管理员认证密钥/会话密钥 | `待初始化` |

### 12.5 ImageX Gateway

| 项目 | 占位 |
|------|------|
| Session 文件路径 | `/data/uploads/.doubao_session.json` |
| `DATABASE_URL` | `postgresql://.../media_platform` |
| Bark Push URL | `https://bark.nyy.app/<device-key>` |
| WebDAV 根目录 | `/` 或 `/media`（待最终实现确定） |

### 12.6 PostgreSQL

| 项目 | 占位 |
|------|------|
| 数据库名 | `media_platform` |
| 用户名 | `media_platform` |
| 密码 | `待初始化` |
| 数据目录 | `/data/postgres` |

### 12.7 nginx

| 项目 | 占位 |
|------|------|
| `media.nyy.app` | Emby |
| `invite.nyy.app` | Wizarr |
| `admin.nyy.app` | 统一管理页（聚合 MoviePilot / qBittorrent / Gateway） |

### 12.8 项目骨架建议

这一节先定义逻辑结构，不强行绑定到某个具体框架实现。

#### A. `admin.nyy.app` 项目骨架

建议至少拆成：

```text
admin-portal/
  src/
    routes/
      login
      dashboard
      accounts
      automation
      downloads
      imagex
      system
    components/
      layout/
      cards/
      tables/
      forms/
      dialogs/
    api/
    stores/
    types/
    utils/
```

admin-api/
  app/
    api/
      dashboard
      accounts
      automation
      downloads
      imagex
      system
    adapters/
      wizarr
      moviepilot
      qbittorrent
      imagex_gateway
      emby
    auth/
    models/
    services/
    db/
  tests/
```

#### B. `ImageX Gateway` 项目骨架

```text
imagex-gateway/
  app/
    api/
      media
      uploads
      session
      resolve
      webdav
    services/
      upload
      session
      index
      resolver
      health
    repositories/
    models/
    tasks/
  data/
    db/
    cache/
    logs/
```

#### C. `Upload Worker` 项目骨架

```text
imagex-upload-worker/
  app/
    runner/
    scanners/
    uploaders/
    retries/
    hooks/
    notifiers/
  logs/
```

设计原则：

1. `admin-portal` 只做前端页面与交互，不直接承担跨系统认证与适配。
2. `admin-api` 负责聚合上游 API、统一权限校验、字段归一化。
3. `imagex-gateway` 只做 ImageX 协议适配、索引、WebDAV、Resolver。
4. `upload-worker` 只做上传任务执行，不混进前台管理页。

### 12.9 第一版实施文件清单

为了让后续进入“开始创建仓库文件”时不散，建议第一批就创建以下文件：

#### 仓库根目录

```text
README.md
.gitignore
.env.example
docker-compose.yml
```

#### `deploy/nginx/`

```text
deploy/nginx/
├── nginx.conf
├── conf.d/
│   ├── media.nyy.app.conf
│   ├── invite.nyy.app.conf
│   ├── admin.nyy.app.conf
│   └── internal-maintenance.conf
└── snippets/
    ├── proxy-common.conf
    ├── basic-auth.conf
    └── security-headers.conf
```

#### `deploy/systemd/`

```text
deploy/systemd/
├── rclone-imagex-media.service
├── imagex-upload-worker.service
├── imagex-upload-worker.timer
└── imagex-gateway-healthcheck.service
```

#### `deploy/env/`

```text
deploy/env/
├── emby.env.example
├── wizarr.env.example
├── moviepilot.env.example
├── qbittorrent.env.example
├── imagex-gateway.env.example
└── admin-portal.env.example
```

#### `apps/admin-portal/`

```text
apps/admin-portal/
├── src/
├── tests/
├── Dockerfile
└── README.md
```

#### `apps/admin-api/`

```text
apps/admin-api/
├── app/
├── tests/
├── Dockerfile
└── README.md
```

#### `apps/imagex-gateway/`

```text
apps/imagex-gateway/
├── app/
├── tests/
├── Dockerfile
└── README.md
```

#### `apps/upload-worker/`

```text
apps/upload-worker/
├── app/
├── tests/
├── Dockerfile
└── README.md
```

#### `docs/`

```text
docs/
├── architecture.md
├── deployment.md
├── operations.md
├── troubleshooting.md
└── api.md
```

### 12.10 第一版内部服务命名建议

这部分是为了让 docker、nginx、systemd 命名一致。

| 组件 | 建议名称 |
|------|----------|
| 仓库目录 | `nyy-media-platform` |
| Emby 容器 | `media-emby` |
| Wizarr 容器 | `media-wizarr` |
| MoviePilot 容器 | `media-moviepilot` |
| qB 容器 | `media-qbittorrent` |
| Gateway 容器 | `media-imagex-gateway` |
| Admin Portal 容器 | `media-admin-portal` |
| Admin API 容器 | `media-admin-api` |
| Upload Worker 容器 / 服务 | `media-upload-worker` |

### 12.11 `nyy-media-platform` 仓库创建方案

建议按以下顺序真正创建新仓库：

#### Step 1. 创建仓库根目录

```text
nyy-media-platform/
```

#### Step 2. 先创建最小目录骨架

```text
nyy-media-platform/
├── apps/
│   ├── admin-portal/
│   ├── imagex-gateway/
│   └── upload-worker/
├── deploy/
│   ├── docker/
│   ├── nginx/
│   ├── systemd/
│   └── env/
├── docs/
├── scripts/
└── fixtures/
```

#### Step 3. 先创建根级基础文件

第一批先创建：

```text
nyy-media-platform/
├── README.md
├── .gitignore
├── .env.example
└── docker-compose.yml
```

#### Step 4. 再创建 3 个应用的 README 和空骨架

```text
apps/admin-portal/README.md
apps/imagex-gateway/README.md
apps/upload-worker/README.md
```

#### Step 5. 再创建部署骨架

```text
deploy/nginx/nginx.conf
deploy/nginx/conf.d/
deploy/systemd/
deploy/env/
```

这样做的好处：

1. 能先让仓库结构稳定。
2. 能先写部署文件，再写应用代码。
3. 文档、配置、代码不会互相等待。

### 12.12 第一批建议创建的空文件

下面这些文件，是我建议下一步真正开始建仓库时就先落的第一批文件。

#### 根目录

```text
README.md
.gitignore
.env.example
docker-compose.yml
```

#### `apps/admin-portal`

```text
apps/admin-portal/README.md
apps/admin-portal/frontend/.gitkeep
apps/admin-portal/backend/.gitkeep
apps/admin-portal/tests/.gitkeep
```

#### `apps/imagex-gateway`

```text
apps/imagex-gateway/README.md
apps/imagex-gateway/app/.gitkeep
apps/imagex-gateway/tests/.gitkeep
apps/imagex-gateway/Dockerfile
```

#### `apps/upload-worker`

```text
apps/upload-worker/README.md
apps/upload-worker/app/.gitkeep
apps/upload-worker/tests/.gitkeep
apps/upload-worker/Dockerfile
```

#### `deploy/docker`

```text
deploy/docker/compose.base.yml
deploy/docker/compose.override.example.yml
```

#### `deploy/nginx`

```text
deploy/nginx/nginx.conf
deploy/nginx/conf.d/media.nyy.app.conf
deploy/nginx/conf.d/invite.nyy.app.conf
deploy/nginx/conf.d/admin.nyy.app.conf
deploy/nginx/conf.d/internal-maintenance.conf
deploy/nginx/snippets/proxy-common.conf
deploy/nginx/snippets/basic-auth.conf
deploy/nginx/snippets/security-headers.conf
```

#### `deploy/systemd`

```text
deploy/systemd/rclone-imagex-media.service
deploy/systemd/imagex-upload-worker.service
deploy/systemd/imagex-upload-worker.timer
deploy/systemd/imagex-gateway-healthcheck.service
```

#### `deploy/env`

```text
deploy/env/emby.env.example
deploy/env/wizarr.env.example
deploy/env/moviepilot.env.example
deploy/env/qbittorrent.env.example
deploy/env/imagex-gateway.env.example
deploy/env/admin-portal.env.example
```

#### `docs`

```text
docs/architecture.md
docs/deployment.md
docs/operations.md
docs/troubleshooting.md
docs/api.md
```

### 12.13 新仓库创建后的第一批优先级

仓库创建后，真正写文件时建议按这个优先级：

#### Priority 1：先让部署结构可见

1. `README.md`
2. `docker-compose.yml`
3. `deploy/nginx/*`
4. `deploy/systemd/*`

#### Priority 2：先让 Gateway 跑起来

1. `apps/imagex-gateway`
2. `apps/upload-worker`

原因：

- 没有 Gateway，就没有 WebDAV
- 没有 Worker，就没有 ImageX 入库
- 没有这两块，Emby 只是空壳

#### Priority 3：再做 `admin-portal`

原因：

- 管理后台必须有数据源
- 数据源先来自 Gateway / Wizarr / MoviePilot / qB
- 所以门户应排在 Gateway 之后

### 12.14 第一版基础文件设计草案

这一节定义“第一版文件应该至少包含什么”，方便下一步真正开始创建仓库文件。

#### A. `README.md`

第一版 README 建议至少包含：

1. 项目定位
   - `nyy-media-platform` 是什么
   - 目标用户是谁
2. 系统架构图
3. 域名规划
4. 服务组成
5. 第一阶段能力范围
6. 快速启动说明
7. 目录结构说明
8. 风险和限制

建议章节：

```text
# nyy-media-platform
## What is this
## Architecture
## Services
## Domains
## Quick Start
## Repository Layout
## Phase 1 Scope
## Known Limitations
```

#### B. 根级 `docker-compose.yml`

第一版建议：

- 根级 `docker-compose.yml` 只作为总入口
- 实际服务可先全部写在一个文件里
- 后续再拆成 `deploy/docker/compose.*.yml`

第一版必须覆盖：

| 服务 | 必须包含 |
|------|----------|
| nginx | 是 |
| emby | 是 |
| wizarr | 是 |
| moviepilot | 是 |
| qbittorrent | 是 |
| imagex-gateway | 是 |

第一版可先不包含：

| 服务 | 说明 |
|------|------|
| upload-worker | 可先做宿主机 systemd 服务 |
| rclone mount | 必须宿主机执行，不放 compose |

#### C. `deploy/nginx/nginx.conf`

第一版 `nginx.conf` 建议只做：

1. 基础 worker / events / http 配置
2. `include /etc/nginx/conf.d/*.conf`
3. 基础日志配置
4. 基础超时配置

不建议一开始就塞太多复杂逻辑。

#### D. `deploy/nginx/conf.d/media.nyy.app.conf`

第一版作用：

- 反代 Emby
- 保证用户登录和媒体访问

最小职责：

1. `server_name media.nyy.app`
2. `location /` → `media-emby:8096`
3. 透传常见代理头
4. 支持 WebSocket / 长连接

#### E. `deploy/nginx/conf.d/invite.nyy.app.conf`

第一版作用：

- 仅提供邀请码注册入口

最小职责：

1. `server_name invite.nyy.app`
2. `location /` → `media-wizarr:5690`
3. **不能统一加 Basic Auth**
4. 保持用户注册链接可访问

#### F. `deploy/nginx/conf.d/admin.nyy.app.conf`

第一版作用：

- 反代自研 `admin-portal` 与 `admin-api`

最小职责：

1. `server_name admin.nyy.app`
2. `location /` → `media-admin-portal:3001`
3. `location /api/admin/` → `media-admin-api:8001`
4. 增加管理员访问保护
5. 不直接暴露上游后台

#### G. `deploy/nginx/conf.d/internal-maintenance.conf`

第一版作用：

- 只保留隐藏维护入口策略说明
- 明确不启用隐藏公网域名

建议做法：

1. 只监听内网地址或宿主机回环
2. 反代到：
   - 原始 Wizarr
   - 原始 MoviePilot
   - 原始 qBittorrent
3. 不面向公网开放

#### H. `deploy/systemd/rclone-imagex-media.service`

第一版职责：

- 将 Gateway 的 WebDAV 挂载到 `/mnt/imagex-media`

最低要求：

1. 开机自启动
2. 异常自动重启
3. 挂载前确保目录存在
4. 失败记录日志

#### I. `deploy/systemd/imagex-upload-worker.service`

第一版职责：

- 长期运行 Upload Worker
- 监听下载完成文件，或定时扫描 `complete/` 目录

最低要求：

1. 能读取 session 文件
2. 能访问本地下载目录
3. 能写入 Gateway 索引 / 任务状态
4. 失败可重启

#### J. `deploy/systemd/imagex-upload-worker.timer`

第一版职责：

- 处理失败任务重试
- 做定时巡检

建议承担：

1. 每 5 分钟重试失败任务
2. 每 30 分钟检查磁盘空间
3. 每 10 分钟检查 session 心跳状态

### 12.15 第一版实施顺序（文件级）

如果下一步真正开始创建仓库文件，我建议严格按下面顺序：

#### 第 1 批：只建空壳

1. 根目录
2. `apps/`
3. `deploy/`
4. `docs/`

#### 第 2 批：先写部署文件

1. `docker-compose.yml`
2. `deploy/nginx/nginx.conf`
3. `deploy/nginx/conf.d/*.conf`
4. `deploy/systemd/*.service`

#### 第 3 批：再写 Gateway

1. `apps/imagex-gateway`
2. `apps/upload-worker`

#### 第 4 批：最后写 admin portal

原因：

- `admin-portal` 需要调用 Gateway / Wizarr / MoviePilot / qB 的接口
- 如果这些服务和接口都还没落地，后台页面容易空转

### 12.16 `imagex-gateway` 第一版文件树建议

建议第一版就细化到文件级，而不是只停留在空目录。

```text
apps/imagex-gateway/
├── Dockerfile
├── README.md
├── pyproject.toml / requirements.txt
├── app/
│   ├── main.py
│   ├── api/
│   │   ├── uploads.py
│   │   ├── media.py
│   │   ├── session.py
│   │   ├── storage.py
│   │   ├── resolve.py
│   │   └── webdav.py
│   ├── services/
│   │   ├── imagex_client.py
│   │   ├── media_index_service.py
│   │   ├── session_service.py
│   │   ├── health_service.py
│   │   └── webdav_service.py
│   ├── repositories/
│   │   ├── media_repository.py
│   │   ├── upload_task_repository.py
│   │   └── session_repository.py
│   ├── models/
│   │   ├── media_item.py
│   │   ├── upload_task.py
│   │   └── session_status.py
│   └── db/
│       ├── base.py
│       └── init_db.py
└── tests/
    ├── test_session_api.py
    ├── test_media_api.py
    ├── test_uploads_api.py
    └── test_webdav.py
```

#### 第一版必须先实现的文件

1. `app/main.py`
2. `app/api/session.py`
3. `app/api/media.py`
4. `app/api/uploads.py`
5. `app/services/imagex_client.py`
6. `app/services/session_service.py`
7. `app/repositories/media_repository.py`
8. `app/repositories/upload_task_repository.py`

### 12.17 `upload-worker` 第一版文件树建议

```text
apps/upload-worker/
├── Dockerfile
├── README.md
├── pyproject.toml / requirements.txt
├── app/
│   ├── main.py
│   ├── runner/
│   │   └── loop.py
│   ├── scanners/
│   │   └── completed_dir_scanner.py
│   ├── classifiers/
│   │   └── media_classifier.py
│   ├── uploaders/
│   │   └── imagex_uploader.py
│   ├── retries/
│   │   └── retry_policy.py
│   ├── hooks/
│   │   └── emby_refresh_hook.py
│   ├── notifiers/
│   │   └── bark_notifier.py
│   └── clients/
│       ├── gateway_client.py
│       └── emby_client.py
└── tests/
    ├── test_classifier.py
    ├── test_retry_policy.py
    └── test_uploader.py
```

#### 第一版必须先实现的文件

1. `app/main.py`
2. `app/runner/loop.py`
3. `app/scanners/completed_dir_scanner.py`
4. `app/uploaders/imagex_uploader.py`
5. `app/clients/gateway_client.py`
6. `app/hooks/emby_refresh_hook.py`

### 12.18 第一版“先不写”的文件

为了控制复杂度，下面这些能力建议先不做：

1. `resolve.py` 的完整播放直链路由
2. S3 兼容层
3. 对外开放 WebDAV 用户访问
4. 支付 / 发卡集成
5. 高级权限体系

### 12.19 `nyy-media-platform` 第一版创建步骤

当真正开始建新仓库时，建议按以下顺序执行。

#### Step 0：仓库初始化

目标：

- 创建全新独立仓库 `nyy-media-platform`
- 初始化默认分支
- 只先提交目录与空文件骨架

#### Step 1：先创建目录

建议第一批目录：

```text
nyy-media-platform/
├── apps/
│   ├── admin-portal/
│   ├── admin-api/
│   ├── imagex-gateway/
│   └── upload-worker/
├── deploy/
│   ├── docker/
│   ├── nginx/
│   ├── systemd/
│   └── env/
├── docs/
├── scripts/
└── fixtures/
```

#### Step 2：先创建根级文件

建议第一批文件：

```text
README.md
.gitignore
.env.example
docker-compose.yml
```

#### Step 3：先创建部署文件空壳

建议第一批部署文件：

```text
deploy/nginx/nginx.conf
deploy/nginx/conf.d/media.nyy.app.conf
deploy/nginx/conf.d/invite.nyy.app.conf
deploy/nginx/conf.d/admin.nyy.app.conf
deploy/nginx/conf.d/internal-maintenance.conf
deploy/systemd/rclone-imagex-media.service
deploy/systemd/imagex-upload-worker.service
deploy/systemd/imagex-upload-worker.timer
```

#### Step 4：再创建应用空壳

建议第一批应用文件：

```text
apps/admin-portal/README.md
apps/admin-api/README.md
apps/imagex-gateway/README.md
apps/upload-worker/README.md
```

#### Step 5：优先开始实现的应用

实现优先级：

1. `imagex-gateway`
2. `upload-worker`
3. `admin-api`
4. `admin-portal`

原因：

- 没有 Gateway 就没有 WebDAV / 索引 / Session API
- 没有 Worker 就没有 ImageX 入库
- 没有 `admin-api`，管理后台无法聚合上游系统
- `admin-portal` 最后做，才能基于真实 API 开发

#### Step 6：第一版通路目标

第一版创建完后，先求打通这条最小闭环：

```text
qBittorrent 完成下载
  ↓
upload-worker 上传 ImageX
  ↓
imagex-gateway 写索引
  ↓
rclone mount WebDAV
  ↓
Emby 扫库可见
  ↓
Wizarr 邀请注册账号
  ↓
admin.nyy.app 能看到状态
```

## 十三、风险与边界

### 13.1 Wizarr 风险

- 原生 UI 没有“1天 / 1月 / 1季度 / 1年”四个固定按钮
- 只能通过“天数输入框”表达时长

### 13.2 MoviePilot 风险

- README 明确写了“仅用于学习交流使用，请勿在任何国内平台宣传”
- 因此本阶段可内部使用
- 如果以后要正式商业化，应提前评估替换或隔离它

### 13.3 embyExternalUrl 风险

- 不能直接接 ImageX
- 必须等 ImageX Resolver 完成后再接

### 13.4 ImageX Gateway 风险

- 这是本方案唯一不可避免的自研核心
- 如果 WebDAV 设计不当，会影响 Emby 扫库和播放

### 13.5 admin 原生一体化后台风险

- `admin.nyy.app` 不是现成开源项目，而是需要我们自己做一个原生一体化后台
- 它至少需要原生覆盖：
  - Emby 临时账号管理
  - MoviePilot 自动化任务管理
  - qBittorrent 下载任务管理
  - ImageX Gateway 管理
- 第一阶段已明确采用：
  - 原生后台页面
  - API 聚合
  - 隐藏维护入口兜底
- 不采用：
  - SSO
  - iframe 大量内嵌后台
- 风险点在于：统一后台需要我们自己实现状态聚合、操作编排和异常兜底逻辑

## 十四、当前未完全拍板的事项

以下内容**不在本文档中擅自决定**：

1. Wizarr 是否需要定制为“四个固定套餐按钮”
   - 现状：原生支持数字天数输入
   - 如果你要固定按钮，需要小改模板/UI

2. Emby 过期账号默认动作
   - `disable`
   - `delete`

3. Emby 默认是否允许转码

4. MoviePilot 在未来是否保留到商业阶段

## 十五、最终结论

当前最稳妥、最少重造轮子的方案是：

```text
本阶段直接采用：
  Emby + Wizarr + MoviePilot + qBittorrent

本阶段必须自研：
  ImageX Upload Worker + ImageX Gateway

下一阶段改造采用：
  embyExternalUrl / MediaLinker
```

其中：

- `Wizarr`：现在就能承担 Emby 邀请与临时账号 UI
- `MoviePilot`：现在就能承担下载自动化与 Emby 刷库
- `embyExternalUrl`：现在只能作为“未来重定向改造基线”，不能写成开箱即用
- `admin.nyy.app`：第一阶段明确为**原生一体化管理员后台**，不做 SSO，但保留原系统隐藏维护入口
