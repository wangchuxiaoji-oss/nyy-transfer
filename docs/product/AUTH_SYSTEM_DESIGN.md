# 拿呀呀认证系统最终设计

状态：已确认方案，进入实现前基准文档
最后确认日期：2026-06-07
适用范围：登录、注册、邮箱验证、人机验证码、密码重置、Token/Session、认证审计

## 1. 设计目标

本方案目标是把当前简化认证流程重构为可上线、可审计、可撤销、可扩展的完整认证系统。

核心目标：

- 注册必须完成邮箱验证码校验后才创建或激活账号。
- 发送注册/重置密码邮件前必须先通过自托管人机验证码。
- 登录默认使用邮箱 + 密码；风险触发时要求人机验证码。
- 登录状态在同一浏览器保持 30 天。
- refresh token 不再存入 `localStorage`，改为 `HttpOnly Cookie` + 服务端 session 表。
- 邮箱验证码使用 6 位数字，前端使用 6 个独立输入框并支持整体粘贴。
- 保留现有 `admin@nyy.app` 管理员账号并确保其邮箱已验证。
- 所有关键认证行为落数据库审计表。

非目标：

- 第一版不接入 Turnstile、hCaptcha、reCAPTCHA 等第三方 SaaS 验证码。
- 第一版不引入 Keycloak、Ory Kratos、Supabase Auth 等外部身份系统。
- 第一版不做邮箱登录二次验证码。
- 第一版不做 TOTP、Passkey、社交登录、企业 SSO。
- 第一版不做多租户身份体系。

## 2. 已确认决策

| 决策项 | 最终结论 |
|---|---|
| 人机验证码 | `ALTCHA`，自托管，第一版正式采用 |
| 邮箱验证码长度 | 6 位数字 |
| 邮箱验证码 TTL | 10 分钟 |
| 发送限制 | 同邮箱每小时 5 次；同 IP 每小时 20 次；同 IP 每日 100 次 |
| 登录风险验证码 | 同邮箱登录失败 3 次后要求人机验证码 |
| 密码最小长度 | 8 位 |
| 弱密码字典拦截 | 启用 |
| 生产部署 | 前后端同域部署 |
| 登录保持 | refresh cookie 30 天 |
| 重置密码后 | 撤销该用户所有登录状态 |
| 重置密码成功通知 | 发送通知邮件 |
| 认证审计 | 落数据库表 |
| 旧 `/auth/verify-email` | 删除 |
| 配置命名 | 允许改得更清晰 |
| 现有管理员 | 保留 `admin@nyy.app`，迁移时标记为已验证 |

## 3. 总体架构

认证系统由以下模块组成：

- `captcha_service`：生成和校验 ALTCHA challenge，签发一次性 `captcha_token`。
- `email_code_service`：生成、哈希存储、发送和校验邮箱验证码。
- `auth_session_service`：管理 refresh token、token family、轮换、撤销和复用检测。
- `auth_risk_service`：登录失败计数、风险判断、发送限流。
- `auth_audit_service`：记录认证相关事件。
- `auth API`：注册、登录、刷新、登出、重置密码、当前用户信息。
- `frontend auth client`：内存 access token、cookie refresh、自动 refresh、验证码 UI。

建议模块路径：

| 模块 | 建议路径 |
|---|---|
| 验证码 API | `backend/app/api/v1/captcha.py` |
| 认证 API | `backend/app/api/v1/auth.py` |
| 验证码服务 | `backend/app/services/captcha.py` |
| 邮箱验证码服务 | `backend/app/services/email_code.py` |
| Session 服务 | `backend/app/services/auth_session.py` |
| 风险服务 | `backend/app/services/auth_risk.py` |
| 审计服务 | `backend/app/services/auth_audit.py` |
| 前端验证码组件 | `frontend/src/components/captcha-challenge.tsx` |
| 前端邮箱验证码输入 | `frontend/src/components/email-code-input.tsx` |
| 前端认证客户端 | `frontend/src/lib/auth.ts` |

## 4. 人机验证码方案

### 4.1 选型

第一版采用 `ALTCHA`。

理由：

- 开源核心，许可为 `MIT`。
- 不需要第三方账号，也不需要申请外部 key。
- 不依赖外部 SaaS，用户请求不发送给第三方验证码平台。
- 前端 Web Component 可接入 Next.js。
- 后端有 Python 库，可接入 FastAPI。
- 采用 Proof-of-Work，不依赖识别字符或图片，因此不存在简单 OCR 破解问题。

限制：

- ALTCHA 不是“绝对证明用户是人”，而是显著提高自动化请求成本。
- 必须和 Redis 限流、邮箱维度限流、IP 维度限流、一次性 token、审计结合使用。
- 如果未来 PoW 防护不足，可保留 `CaptchaProvider` 抽象后切换或叠加 `GoCaptcha` 点选/滑块服务。

### 4.2 使用场景

必须使用人机验证码的场景：

- 发送注册邮箱验证码。
- 发送重置密码邮箱验证码。

风险触发使用人机验证码的场景：

- 登录失败达到阈值后的再次登录。

不使用人机验证码的场景：

- 正常首次登录。
- 已登录状态刷新 access token。
- 获取当前用户信息。

### 4.3 API

新增：

- `GET /api/v1/captcha/challenge?purpose=email_send|login`
- `POST /api/v1/captcha/verify`

`GET /api/v1/captcha/challenge` 响应：

```json
{
  "challenge_id": "string",
  "challenge": {},
  "expires_in": 180
}
```

`POST /api/v1/captcha/verify` 请求：

```json
{
  "challenge_id": "string",
  "purpose": "email_send",
  "payload": "ALTCHA payload"
}
```

`POST /api/v1/captcha/verify` 成功响应：

```json
{
  "captcha_token": "string",
  "expires_in": 300
}
```

### 4.4 Redis 数据

Challenge：

- Key：`nyy:captcha:challenge:{challenge_id}`
- TTL：180 秒
- 内容：`purpose`、`created_at`、`expires_at`、`ip_hash`、`ua_hash`、`altcha_metadata`
- 规则：校验成功后立即删除。

Captcha token：

- Key：`nyy:captcha:token:{token_hash}`
- TTL：300 秒
- 内容：`purpose`、`created_at`、`ip_hash`、`ua_hash`
- 规则：业务接口消费后立即删除。

### 4.5 服务端校验规则

服务端必须校验：

- `challenge_id` 存在。
- challenge 未过期。
- ALTCHA payload 签名有效。
- ALTCHA payload 未过期。
- `purpose` 与创建 challenge 时一致。
- 同一 challenge 只能成功一次。
- 成功后签发新的 `captcha_token`。
- `captcha_token` 只存哈希，不存明文。

服务端可以校验：

- IP hash 与 challenge 创建时一致。
- UA hash 与 challenge 创建时一致。

如果 IP/UA 校验误伤用户，可仅作为审计字段，不作为硬性失败条件。

### 4.6 ALTCHA cost

`ALTCHA` 的 PoW cost 需要上线前实测。

目标：

- 桌面浏览器：300ms - 700ms。
- 常见手机浏览器：500ms - 1200ms。
- 最差设备不超过 3 秒。

实现要求：

- cost 必须通过配置项控制。
- 不允许把 cost 写死在代码里。
- 生产上线前必须在桌面和手机各至少一个浏览器实测。

## 5. 邮箱验证码方案

### 5.1 用途

支持用途：

- `register`：注册邮箱验证。
- `reset_password`：重置密码验证。

不支持用途：

- `login`：第一版不做邮箱登录二次验证码。

### 5.2 发送流程

注册或重置密码发送验证码：

1. 前端获取 ALTCHA challenge。
2. 用户完成 ALTCHA PoW。
3. 前端提交 ALTCHA payload 换取 `captcha_token`。
4. 前端调用 `/api/v1/auth/send-code`，提交 `email`、`purpose`、`captcha_token`。
5. 后端消费 `captcha_token`。
6. 后端检查发送限流。
7. 后端生成 6 位数字验证码。
8. 后端存储验证码哈希。
9. 后端通过同机 SMTP/Postfix 发送邮件。
10. 后端返回统一成功信息。

### 5.3 验证码格式

- 6 位数字。
- 允许前导零，例如 `003817`。
- 服务端请求校验必须使用正则：`^\d{6}$`。
- 前端输入限制不能替代服务端校验。

### 5.4 存储策略

Redis key：

- `nyy:auth:email_code:{purpose}:{email_normalized}`

TTL：

- 10 分钟。

内容：

```json
{
  "code_hash": "string",
  "attempts": 0,
  "created_at": "iso datetime",
  "expires_at": "iso datetime",
  "send_ip_hash": "string",
  "send_ua_hash": "string"
}
```

Hash 规则：

- 不允许 Redis 存验证码明文。
- 建议使用 HMAC：`HMAC(email_code_secret, purpose + ":" + normalized_email + ":" + code)`。
- 比较时使用常量时间比较。

### 5.5 尝试次数

- 单个验证码最多尝试 5 次。
- 验证成功后删除验证码。
- 尝试达到 5 次后删除验证码。
- 验证码过期后自然删除。

### 5.6 发送限制

必须执行：

- 同邮箱每小时最多 5 次。
- 同 IP 每小时最多 20 次。
- 同 IP 每日最多 100 次。
- 同邮箱重发冷却 60 秒。

Redis key 建议：

- `nyy:auth:email_send:email_hour:{purpose}:{email_normalized}`
- `nyy:auth:email_send:ip_hour:{ip_hash}`
- `nyy:auth:email_send:ip_day:{ip_hash}`
- `nyy:auth:email_send:cooldown:{purpose}:{email_normalized}`

限流执行顺序：

1. 先消费 `captcha_token`。
2. 再检查发送限流。
3. 再生成验证码。
4. 再发送邮件。

说明：

- 即使请求被限流，`captcha_token` 也应消费，避免同一 token 被反复探测。
- 邮件发送失败时删除本次邮箱验证码，避免用户收到旧码或无邮件可验证。

## 6. 注册流程

### 6.1 前端流程

1. 用户输入邮箱。
2. 用户完成人机验证码。
3. 前端发送邮箱验证码。
4. UI 切换到验证码 + 密码步骤。
5. 验证码区域显示 6 个独立输入框。
6. 用户输入 6 位验证码。
7. 用户输入密码。
8. 用户勾选服务条款。
9. 前端调用 `/api/v1/auth/register`。
10. 注册成功后自动登录。

### 6.2 后端流程

`POST /api/v1/auth/register` 请求：

```json
{
  "email": "user@example.com",
  "password": "password",
  "code": "123456"
}
```

后端必须执行：

1. 归一化邮箱。
2. 校验验证码格式。
3. 校验邮箱验证码，成功后消费验证码。
4. 校验密码长度和弱密码字典。
5. 查询用户。
6. 用户不存在时创建用户并写入 `email_verified_at`。
7. 用户存在且未验证时允许更新密码并写入 `email_verified_at`。
8. 用户存在且已验证时拒绝注册。
9. 记录 `register_success` 或 `register_failed` 审计事件。

### 6.3 已注册邮箱处理

第一版采用明确提示：

- 已验证邮箱再次注册时返回 `409` 和“该邮箱已注册”。

理由：

- 当前产品偏轻量，用户体验优先。
- 发送验证码前已有强制人机验证码和限流，账号枚举风险可控。

如果后续安全要求提高，可切换为统一提示。

## 7. 登录流程

### 7.1 默认登录

`POST /api/v1/auth/login` 请求：

```json
{
  "email": "user@example.com",
  "password": "password"
}
```

成功响应：

```json
{
  "access_token": "string",
  "token_type": "bearer",
  "expires_in": 900,
  "user": {
    "id": "string",
    "email": "user@example.com",
    "plan": "free",
    "email_verified": true
  }
}
```

同时服务端设置 `HttpOnly refresh cookie`。

### 7.2 风险登录

触发条件：

- 同邮箱 15 分钟内登录失败达到 3 次。

建议额外触发条件：

- 同 IP 15 分钟内登录失败达到 10 次。
- 同 IP 1 小时内登录失败达到 30 次。

风险触发响应：

```json
{
  "error": "captcha_required",
  "message": "请先完成人机验证"
}
```

风险登录请求：

```json
{
  "email": "user@example.com",
  "password": "password",
  "captcha_token": "string"
}
```

规则：

- 风险状态下，缺少 `captcha_token` 必须失败。
- `captcha_token` purpose 必须是 `login`。
- 登录成功后清除该邮箱相关失败计数。
- 登录失败继续累计失败计数。
- 不做邮箱二次验证码。

## 8. Token 与 Session

### 8.1 Token 策略

| 项 | 策略 |
|---|---|
| access token | JWT，短期，15 分钟 |
| access token 存储 | 前端内存，不写 `localStorage` |
| refresh token | 高熵随机字符串，不是 JWT |
| refresh token 存储 | `HttpOnly Cookie` + 数据库哈希 |
| refresh token 有效期 | 30 天 |
| refresh token 轮换 | 每次 refresh 都轮换 |
| refresh token 撤销 | 登出、重置密码、复用检测、账号封禁 |

### 8.2 Cookie 策略

Cookie 名称：

- `nyy_refresh_token`

属性：

- `HttpOnly=true`
- `Secure=true`，生产必须 HTTPS。
- `SameSite=Lax`
- `Max-Age=2592000`
- `Path=/api/v1/auth`

同域部署说明：

- 生产环境前后端同域部署，因此不需要跨站 credentials 策略。
- CORS 仍应限制正式域名，不允许任意 Origin。

### 8.3 Refresh 流程

`POST /api/v1/auth/refresh`：

1. 后端从 HttpOnly Cookie 读取 refresh token。
2. 计算 token hash。
3. 查询 `auth_sessions`。
4. 检查是否存在、未过期、未撤销。
5. 撤销旧 session。
6. 创建新 session，沿用同一个 `family_id`。
7. 设置新的 refresh cookie。
8. 返回新的 access token。

### 8.4 Refresh token 复用检测

如果一个已撤销且属于轮换链的 refresh token 再次出现：

- 视为疑似泄漏。
- 撤销同一 `family_id` 下所有未撤销 session。
- 记录 `token_reuse_detected` 审计事件。
- 返回 `401`。

### 8.5 登出

`POST /api/v1/auth/logout`：

- 读取 refresh cookie。
- 撤销当前 session。
- 清除 refresh cookie。
- 前端清除内存 access token。
- 记录 `logout` 审计事件。

### 8.6 页面刷新后恢复登录

前端启动时：

1. 内存中没有 access token。
2. 调用 `/api/v1/auth/refresh`。
3. 浏览器自动带上 HttpOnly refresh cookie。
4. 后端返回新的 access token。
5. 前端保存到内存。
6. 调用 `/auth/me` 获取用户信息。

用户体验：

- 同一浏览器 30 天内不需要重新登录。
- 清 Cookie、换浏览器、无痕模式关闭后需要重新登录。

## 9. CSRF 与请求安全

第一版只有 refresh/logout 使用 Cookie 凭证，业务 API 仍使用 `Authorization: Bearer {access_token}`。

必须执行：

- `/auth/refresh` 校验 `Origin` 或 `Referer`。
- `/auth/logout` 校验 `Origin` 或 `Referer`。
- 生产环境 Cookie 必须 `Secure`。
- CORS 不允许 `*` 携带 credentials。
- 同域部署下，正式域名之外的 Origin 不能 refresh/logout。

暂不引入：

- 双 Cookie CSRF token。

后续如果业务 API 改成纯 Cookie 鉴权，则必须补完整 CSRF token 机制。

## 10. 重置密码流程

### 10.1 前端流程

1. 用户打开忘记密码。
2. 输入邮箱。
3. 完成人机验证码。
4. 发送重置密码邮箱验证码。
5. 输入 6 位验证码。
6. 输入新密码。
7. 调用 `/api/v1/auth/reset-password`。
8. 成功后提示用户重新登录。

### 10.2 后端流程

`POST /api/v1/auth/reset-password` 请求：

```json
{
  "email": "user@example.com",
  "code": "123456",
  "new_password": "password"
}
```

后端必须执行：

1. 校验邮箱验证码。
2. 校验新密码长度和弱密码字典。
3. 更新密码哈希。
4. 撤销该用户所有 `auth_sessions`。
5. 删除验证码。
6. 发送“密码已重置”通知邮件。
7. 记录 `password_reset_success` 审计事件。
8. 不自动登录。

不存在邮箱处理：

- 发送重置密码验证码时，对不存在邮箱返回统一成功信息，但不发送邮件。
- 重置提交时，如果验证码不存在或用户不存在，返回“验证码错误或已过期”。

## 11. 密码策略

必须执行：

- 最小长度 8。
- 最大长度 128。
- 不强制大小写、数字、特殊字符组合。
- 允许用户粘贴密码。
- 前端显示密码强度提示。
- 后端启用弱密码字典拦截。

弱密码字典至少包含：

- 常见密码，如 `12345678`、`password`、`password123`、`qwerty123`。
- 项目名或品牌相关弱密码，如 `nyy123456`、`nayayaya`。
- 邮箱本地部分完全相同或过于接近的密码。

弱密码被拒绝时应提示：

- “密码过于常见，请换一个更安全的密码”。

密码哈希：

- 继续使用 Argon2id。
- 不存明文密码。
- 不在日志中输出密码。

## 12. 邮件系统

邮件发送使用当前服务器上的同机 SMTP/Postfix。

配置：

- `SMTP_HOST=127.0.0.1`
- `SMTP_PORT=25`
- `EMAIL_FROM=noreply@nyy.app`

邮件类型：

- 注册验证码邮件。
- 重置密码验证码邮件。
- 密码重置成功通知邮件。

邮件要求：

- 邮件中不能包含密码。
- 邮件中不能包含 refresh token 或 access token。
- 验证码邮件必须说明有效期为 10 分钟。
- 密码重置通知邮件必须说明如果不是本人操作应尽快联系站点管理员或重新重置密码。

发送失败处理：

- 删除本次生成的邮箱验证码。
- 返回“邮件发送失败，请稍后重试”。
- 记录 `email_code_failed` 审计事件。

## 13. 审计日志

### 13.1 数据库落表

新增 `auth_events` 表。

字段建议：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | UUID | 主键 |
| `user_id` | UUID nullable | 用户 ID |
| `email_hash` | string nullable | 邮箱哈希，不存明文邮箱 |
| `event_type` | string | 事件类型 |
| `success` | bool | 是否成功 |
| `ip` | inet/string nullable | 请求 IP |
| `user_agent` | string nullable | UA，截断存储 |
| `reason` | string nullable | 失败原因或撤销原因 |
| `metadata` | JSONB nullable | 附加信息 |
| `created_at` | timestamptz | 创建时间 |

### 13.2 事件类型

必须记录：

- `captcha_challenge_created`
- `captcha_verified`
- `captcha_failed`
- `email_code_sent`
- `email_code_failed`
- `register_success`
- `register_failed`
- `login_success`
- `login_failed`
- `login_captcha_required`
- `token_refreshed`
- `token_reuse_detected`
- `logout`
- `password_reset_requested`
- `password_reset_success`
- `password_reset_failed`

禁止记录：

- 明文密码。
- 明文邮箱验证码。
- 明文 captcha token。
- 明文 refresh token。
- 明文 access token。

## 14. 数据库模型

### 14.1 `auth_sessions`

字段建议：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | UUID | 主键 |
| `user_id` | UUID | 用户 ID |
| `token_hash` | string | refresh token 哈希，唯一索引 |
| `family_id` | UUID | token family，用于复用检测 |
| `rotated_from_id` | UUID nullable | 上一个 session ID |
| `ip` | inet/string nullable | 创建或最后使用 IP |
| `user_agent` | string nullable | UA，截断存储 |
| `created_at` | timestamptz | 创建时间 |
| `last_used_at` | timestamptz nullable | 最后使用时间 |
| `expires_at` | timestamptz | 过期时间 |
| `revoked_at` | timestamptz nullable | 撤销时间 |
| `revoked_reason` | string nullable | 撤销原因 |

索引：

- `token_hash` 唯一索引。
- `user_id` 索引。
- `family_id` 索引。
- `expires_at` 索引。

### 14.2 `auth_events`

详见第 13 节。

### 14.3 `users`

保留现有表。

迁移要求：

- 找到 `admin@nyy.app`。
- 如果 `email_verified_at` 为空，设置为迁移执行时间。
- 不删除任何用户。

## 15. API 清单

保留并改造：

- `POST /api/v1/auth/send-code`
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/reset-password`
- `GET /api/v1/auth/me`

新增：

- `GET /api/v1/captcha/challenge`
- `POST /api/v1/captcha/verify`

删除：

- `POST /api/v1/auth/verify-email`

## 16. 前端改造

### 16.1 组件

新增：

- `CaptchaChallenge`：封装 ALTCHA challenge 获取、验证、token 返回。
- `EmailCodeInput`：6 格验证码输入。

改造：

- `AuthModal`：注册、登录、忘记密码流程重构。
- `auth.ts`：移除 refresh token 的 `localStorage` 存储。
- `authFetch`：自动 refresh 一次并重试原请求。

### 16.2 `EmailCodeInput` 行为

必须支持：

- 6 个独立输入框。
- 每格只允许 1 位数字。
- 输入数字后自动聚焦下一格。
- Backspace 在空格时回退上一格。
- 粘贴 `123456` 自动填满 6 格。
- 粘贴包含空格或分隔符时，只提取数字。
- 移动端显示数字键盘。
- 支持 `autoComplete="one-time-code"`。

### 16.3 Token 存储

必须删除：

- `localStorage` 中的 `nyy_refresh_token`。

应清理：

- 启动时主动删除旧 `localStorage` token，避免旧状态干扰。

允许保留：

- 短期内可保留 `nyy_access_token` 清理逻辑，但不再写入。

## 17. 配置项

新增或重命名配置：

| 配置 | 默认值 | 说明 |
|---|---|---|
| `AUTH_ACCESS_TOKEN_EXPIRE_MINUTES` | `15` | access token 有效期 |
| `AUTH_REFRESH_TOKEN_EXPIRE_DAYS` | `30` | refresh token 有效期 |
| `AUTH_REFRESH_COOKIE_NAME` | `nyy_refresh_token` | refresh cookie 名称 |
| `AUTH_COOKIE_SECURE` | `true` | 生产环境必须 true |
| `AUTH_COOKIE_SAMESITE` | `lax` | SameSite 策略 |
| `AUTH_COOKIE_DOMAIN` | 空 | 同域部署可为空 |
| `CAPTCHA_HMAC_SECRET` | 必填 | ALTCHA challenge 签名密钥 |
| `CAPTCHA_CHALLENGE_TTL_SECONDS` | `180` | challenge TTL |
| `CAPTCHA_TOKEN_TTL_SECONDS` | `300` | captcha token TTL |
| `ALTCHA_ALGORITHM` | `PBKDF2/SHA-256` | ALTCHA 算法 |
| `ALTCHA_COST` | 待实测 | ALTCHA cost |
| `EMAIL_CODE_SECRET` | 必填 | 邮箱验证码 HMAC 密钥 |
| `EMAIL_CODE_TTL_MINUTES` | `10` | 邮箱验证码有效期 |
| `EMAIL_CODE_MAX_ATTEMPTS` | `5` | 最大尝试次数 |
| `EMAIL_CODE_RESEND_COOLDOWN_SECONDS` | `60` | 重发冷却 |
| `EMAIL_CODE_EMAIL_HOURLY_LIMIT` | `5` | 同邮箱每小时限制 |
| `EMAIL_CODE_IP_HOURLY_LIMIT` | `20` | 同 IP 每小时限制 |
| `EMAIL_CODE_IP_DAILY_LIMIT` | `100` | 同 IP 每日限制 |
| `LOGIN_EMAIL_FAILURE_CAPTCHA_THRESHOLD` | `3` | 同邮箱失败后触发验证码 |
| `LOGIN_IP_FAILURE_CAPTCHA_THRESHOLD` | `10` | 同 IP 失败后触发验证码 |
| `LOGIN_IP_FAILURE_RATE_LIMIT` | `30` | 同 IP 每小时登录失败限制 |

旧配置处理：

- 可删除或废弃 `auth_code_ttl_minutes`、`auth_code_max_attempts`、`auth_code_rate_limit`。
- 新代码统一使用更清晰的 `EMAIL_CODE_*` 命名。

## 18. 迁移策略

### 18.1 数据库迁移

新增：

- `auth_sessions`
- `auth_events`

修改：

- 不修改 `users` 结构。
- 迁移脚本中确保 `admin@nyy.app` 的 `email_verified_at` 非空。

### 18.2 前端状态迁移

启动时清理旧 token：

- 删除 `localStorage.nyy_access_token`。
- 删除 `localStorage.nyy_refresh_token`。

原因：

- 新认证系统不再信任旧本地 token。
- 当前没有真实用户，清理影响可接受。

### 18.3 API 迁移

- 删除 `/auth/verify-email`。
- 前端注册流程直接调用 `/auth/register`，请求中包含邮箱验证码。

## 19. 实施 Harness

本节是实现时的强约束，所有实现、测试、验收必须遵守。若实现与本节冲突，以本节为准；若业务需求变更，必须先更新本文档再改代码。

### 19.1 不可变安全约束

以下约束不得违反：

- 任何日志、数据库、Redis 中不得存储明文密码。
- 任何日志、数据库、Redis 中不得存储明文 refresh token。
- 任何日志、数据库、Redis 中不得存储明文 access token。
- Redis 中不得存储明文邮箱验证码，只能存哈希。
- 邮箱验证码成功验证后必须立即删除。
- 邮箱验证码尝试次数达到 5 次后必须立即删除。
- `captcha_token` 必须一次性消费。
- `/auth/send-code` 没有有效 `captcha_token` 必须失败。
- 风险登录状态下没有有效 `captcha_token` 必须失败。
- refresh token 每次刷新必须轮换。
- refresh token 复用检测必须撤销同一 `family_id` 下所有未撤销 session。
- 重置密码成功后必须撤销该用户所有 session。
- 生产环境 refresh cookie 必须设置 `HttpOnly` 和 `Secure`。
- `access_token` 不得写入 `localStorage`。
- `/auth/verify-email` 必须删除，不能保留旧注册验证路径。

### 19.2 API 行为门禁

以下行为必须由测试覆盖：

- 未通过人机验证码调用 `/auth/send-code` 返回失败。
- 使用错误 purpose 的 `captcha_token` 调用 `/auth/send-code` 返回失败。
- 重复使用同一个 `captcha_token` 返回失败。
- 邮箱每小时第 6 次发送验证码返回限流。
- IP 每小时第 21 次发送验证码返回限流。
- IP 每日第 101 次发送验证码返回限流。
- 注册时验证码错误返回失败且不创建用户。
- 注册时验证码过期返回失败且不创建用户。
- 注册成功后 `email_verified_at` 非空。
- 已验证邮箱再次注册返回 `409`。
- 登录失败 3 次后再次登录返回 `captcha_required`。
- 风险登录携带有效 `captcha_token` 且密码正确时成功。
- 登录成功后设置 refresh cookie。
- refresh 成功后旧 refresh session 被撤销，新 session 被创建。
- 复用旧 refresh token 触发 token family 撤销。
- logout 清除 cookie 并撤销当前 session。
- reset password 成功后撤销该用户所有 session。
- reset password 成功后发送通知邮件。
- `/auth/verify-email` 不再存在。

### 19.3 前端行为门禁

以下行为必须人工或自动验证：

- 注册发送验证码前必须展示并完成 ALTCHA。
- 重置密码发送验证码前必须展示并完成 ALTCHA。
- 邮箱验证码输入框为 6 个独立输入框。
- 逐位输入时自动跳格。
- Backspace 时能回退。
- 粘贴 `123456` 能自动填满。
- 粘贴 `12 34-56` 时只提取数字并填满。
- 不足 6 位时注册/重置按钮不可提交或提交失败。
- 页面刷新后可通过 refresh cookie 恢复登录。
- 退出登录后刷新页面仍保持未登录。
- 浏览器 localStorage 中不存在 refresh token。
- 浏览器 localStorage 中不存在 access token。

### 19.4 配置门禁

生产部署前必须确认：

- `CAPTCHA_HMAC_SECRET` 已设置且不是默认值。
- `EMAIL_CODE_SECRET` 已设置且不是默认值。
- `JWT_SECRET` 已设置且不是默认值。
- `AUTH_COOKIE_SECURE=true`。
- `AUTH_REFRESH_TOKEN_EXPIRE_DAYS=30`。
- `EMAIL_CODE_TTL_MINUTES=10`。
- `SMTP_HOST=127.0.0.1` 或明确指定可用 SMTP 主机。
- `SMTP_PORT=25` 或明确指定可用 SMTP 端口。
- CORS 不允许任意 Origin。

### 19.5 SMTP 验收门禁

上线前必须完成真实邮件验收：

- 注册验证码邮件能发送到至少一个常见邮箱。
- 重置密码验证码邮件能发送到至少一个常见邮箱。
- 密码重置成功通知邮件能发送到至少一个常见邮箱。
- 失败邮件发送不保留可用验证码。
- Postfix 日志无明显投递错误。
- 邮件内容不包含密码、token、内部 Redis key。

### 19.6 审计门禁

以下事件必须能在数据库查到：

- 成功发送邮箱验证码。
- 邮件发送失败。
- 注册成功。
- 登录失败。
- 登录成功。
- 登录要求验证码。
- refresh token 轮换。
- refresh token 复用检测。
- logout。
- 重置密码成功。

审计记录不得包含：

- 明文验证码。
- 明文 token。
- 明文密码。

### 19.7 回归命令建议

后端最小回归：

```bash
cd /data/nyy/backend
.venv/bin/pytest tests/test_auth.py
```

后端新增认证测试完成后应补充运行：

```bash
cd /data/nyy/backend
.venv/bin/pytest tests/test_auth.py tests/test_auth_sessions.py tests/test_captcha.py
```

前端类型检查：

```bash
cd /data/nyy/frontend
npx tsc --noEmit
```

如果新增前端交互测试，建议覆盖 `EmailCodeInput` 和 `AuthModal`。

### 19.8 实现约束

实现过程中必须遵守：

- 不引入第三方 SaaS 验证码。
- 不引入外部身份系统。
- 不新增邮箱二次登录验证码。
- 不修改已确认的 30 天登录保持策略。
- 不降低发送限制阈值以外的安全强度。
- 不绕过人机验证码发送邮件。
- 不为了兼容旧代码保留 `/auth/verify-email`。
- 如果发现本文档未覆盖的产品决策，必须先向用户确认。

## 20. 实施顺序

建议按以下顺序实现：

1. 新增配置项和数据库迁移。
2. 新增 `auth_sessions` 和 `auth_events` 模型。
3. 新增 ALTCHA captcha 服务和 API。
4. 新增邮箱验证码服务，替换旧验证码逻辑。
5. 改造 `/auth/send-code`，强制 `captcha_token`。
6. 改造 `/auth/register`，删除旧 `/auth/verify-email`。
7. 改造 `/auth/login`，加入风险验证码。
8. 改造 refresh/logout，迁移到 HttpOnly refresh cookie。
9. 改造 reset password，增加撤销 session 和通知邮件。
10. 改造前端 `auth.ts`、`AuthModal`、验证码组件。
11. 增加后端和前端测试。
12. 真实 SMTP 投递验收。
13. 清理旧 localStorage token 和旧认证文档描述。

## 21. 最终验收标准

完成后必须满足：

- 新用户无法绕过邮箱验证码注册。
- 发送验证码邮件无法绕过人机验证码。
- 登录风险状态下无法绕过人机验证码。
- 同一浏览器登录状态可保持 30 天。
- refresh token 可撤销、可轮换、可复用检测。
- 重置密码会撤销全部登录状态。
- 所有关键认证事件有数据库审计记录。
- 前端不再把 token 写入 `localStorage`。
- `admin@nyy.app` 保留且邮箱已验证。
- `/auth/verify-email` 已删除。
- 所有 harness 门禁通过。
