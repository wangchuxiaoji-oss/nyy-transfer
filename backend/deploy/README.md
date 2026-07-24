# 当前生产部署指南

生产拓扑：Nginx TLS 入口，PM2 管理 FastAPI 与 Next.js，PostgreSQL/Redis 提供状态，Postfix + OpenDKIM 负责发信与 `admin@nyy.app` 本机收件。

所有应用进程和维护任务统一使用专用 `nyy` 用户。禁止使用 root 的 PM2，也不要安装本目录中的 legacy Caddyfile 或 `nyy.service.legacy`。

首次部署顺序：系统与账号初始化 → 数据库迁移和摘要回填（暂不执行 PM2 restart）→ PM2 首次初始化 → Nginx/Postfix/systemd timers 安装 → 发布验收。后续发布按后端发布、前端发布、发布验收执行。

## 1. 系统与账号初始化

```bash
sudo apt update
sudo apt install -y nginx certbot logrotate acl curl postfix opendkim postgresql-client redis-tools
id -u nyy >/dev/null 2>&1 || \
  sudo useradd --system --create-home --home-dir /home/nyy --shell /bin/bash nyy

sudo install -d -m 0750 -o nyy -g nyy /data/nyy
# 新机器使用：sudo -u nyy -H git clone <repository-url> /data/nyy
# 已有仓库只在确认没有其他账号需要写入后执行：
sudo chown -R nyy:nyy /data/nyy
sudo chmod 0750 /data/nyy /data/nyy/backend /data/nyy/frontend
sudo test -f /data/nyy/backend/.env || \
  sudo install -m 0600 -o nyy -g nyy /data/nyy/backend/.env.example /data/nyy/backend/.env
sudo chown nyy:nyy /data/nyy/backend/.env
sudo chmod 0600 /data/nyy/backend/.env
sudoedit /data/nyy/backend/.env
```

`/data/nyy` 必须由 `nyy:nyy` 持有且顶层目录权限为 `0750`；`backend/.env` 必须是 `nyy:nyy`、`0600`。新建 `.env` 后必须把 `APP_ENV` 改为 `production`，将 `APP_BASE_URL` 改为 `https://nyy.app`，并替换 `SECRET_KEY`、`JWT_SECRET`、`CAPTCHA_HMAC_SECRET`、`EMAIL_CODE_SECRET` 及数据库、豆包凭据。不得把真实 `.env`、证书或 token 提交到仓库。

安装依赖与 PM2 开机项：

```bash
sudo npm install --global pm2
sudo -u nyy -H bash -lc 'cd /data/nyy/backend && python3 -m venv .venv && .venv/bin/pip install -U pip wheel && .venv/bin/pip install -r requirements.txt && .venv/bin/pip install --no-deps -e .'
sudo -u nyy -H bash -lc 'cd /data/nyy/backend && .venv/bin/python -c "from app.core.config import get_settings; settings = get_settings(); assert settings.app_env == \"production\", \"APP_ENV 必须为 production\"; print(\"生产配置校验通过\")"'
sudo -u nyy -H bash -lc 'cd /data/nyy/frontend && npm ci'
sudo env PATH=/usr/local/bin:/usr/bin:/bin pm2 startup systemd -u nyy --hp /home/nyy
sudo systemctl enable pm2-nyy
```

`pm2 startup` 只用于安装 `pm2-nyy.service`；后续 `pm2 start/restart/save` 全部在 `nyy` 登录会话中执行。

## 2. 后端发布

```bash
# 后续发布先冻结所有可能访问数据库或重启后端的定时任务；首次部署尚未安装时跳过。
sudo systemctl stop \
  nyy-mailbox-import.timer \
  nyy-nginx-access-import.timer \
  nyy-email-outbox.timer \
  nyy-admin-maintenance.timer \
  nyy-geoip-update.timer
sudo systemctl stop \
  nyy-mailbox-import.service \
  nyy-nginx-access-import.service \
  nyy-email-outbox.service \
  nyy-admin-maintenance.service \
  nyy-geoip-update.service

sudo -iu nyy
cd /data/nyy/backend
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install --no-deps -e .
.venv/bin/python -c 'from app.core.config import get_settings; settings = get_settings(); assert settings.app_env == "production", "APP_ENV 必须为 production"'
.venv/bin/pytest -q
.venv/bin/alembic current
# 先记录 users、shares、share_access_events、download_logs 行数
pm2 stop nyy-backend
NYY_ALLOW_OFFLINE_PARTITION_MIGRATION=1 .venv/bin/alembic upgrade head
.venv/bin/python scripts/backfill_share_summaries.py --batch-size 500
.venv/bin/alembic current
pm2 start nyy-backend --update-env
pm2 save
backend_pid="$(pm2 pid nyy-backend)"
test "$backend_pid" != "0"
test "$(ps -o user= -p "$backend_pid" | xargs)" = "nyy"
curl -fsS http://127.0.0.1:8000/healthz
curl -fsS http://127.0.0.1:8000/readyz
curl -fsS https://nyy.app/healthz
curl -fsS https://nyy.app/readyz
exit

sudo systemctl start \
  nyy-mailbox-import.timer \
  nyy-nginx-access-import.timer \
  nyy-email-outbox.timer \
  nyy-admin-maintenance.timer \
  nyy-geoip-update.timer
```

固定执行顺序为：停止全部运营 timers 和仍在运行的 oneshot services → 记录迁移前行数 → 停止后端 → 在命令行显式授权离线迁移并执行 `alembic upgrade head` → 分批回填分享摘要 → 检查 migration head → 启动后端 → 校验 PM2 PID 属于 `nyy` 并依次检查本机、公网健康端点 → 恢复 timers。`NYY_ALLOW_OFFLINE_PARTITION_MIGRATION=1` 必须作为 Alembic 命令的环境变量传入，写入 `.env` 不会授权该迁移。任一步失败时保持后端与 timers 停止，排查并确认迁移状态后再执行 `pm2 start nyy-backend --update-env`；只有 `/healthz`、`/readyz` 均成功后才能恢复 timers。回填可重复执行；数据量较大时可使用 `--start-after <share-uuid>` 续跑。

首次部署尚无 PM2 进程时，跳过 `pm2 stop`、`pm2 start`、`pm2 save` 与公网健康检查；完成迁移、回填和 `alembic current` 后继续执行下一节初始化。

## 3. PM2 首次初始化

部署脚本不会替 root 或空 PM2 自动创建进程。首次部署必须由 `nyy` 用户显式初始化：

如果旧版应用仍由 root PM2 占用 8000/3000 端口，必须先在维护窗口记录进程配置并停止旧实例；不得让 root 与 `nyy` 两套 PM2 同时管理同名应用：

```bash
sudo env PM2_HOME=/root/.pm2 pm2 describe nyy-backend
sudo env PM2_HOME=/root/.pm2 pm2 describe nyy-frontend
sudo env PM2_HOME=/root/.pm2 pm2 delete nyy-backend nyy-frontend
sudo env PM2_HOME=/root/.pm2 pm2 save --force
```

```bash
sudo -iu nyy
export HOME=/home/nyy PM2_HOME=/home/nyy/.pm2

cd /data/nyy/backend
pm2 start .venv/bin/uvicorn --name nyy-backend --cwd /data/nyy/backend \
  --interpreter none -- app.main:app --host 127.0.0.1 --port 8000 \
  --proxy-headers --forwarded-allow-ips=127.0.0.1

cd /data/nyy/frontend
export NODE_ENV=production NEXT_DIST_DIR=.next-production-a
npm run build
pm2 start npm --name nyy-frontend --cwd /data/nyy/frontend -- start
curl --fail --retry 20 --retry-all-errors --retry-delay 2 http://127.0.0.1:3000/
marker_tmp="$(mktemp .next-production-active.tmp.XXXXXX)"
printf '%s\n' "$NEXT_DIST_DIR" > "$marker_tmp"
mv -f "$marker_tmp" .next-production-active
pm2 save
exit

sudo systemctl enable --now pm2-nyy
```

## 4. 前端发布

禁止在生产运行 `next dev`。生产发布使用 A/B 双构建目录，避免构建时删除线上进程仍在引用的 chunk。

```bash
sudo -iu nyy
cd /data/nyy/frontend
npm ci
npx tsc --noEmit
npm run lint
npm run deploy:production
exit
```

Playwright 使用独立目录和端口，不污染生产构建：

```bash
PLAYWRIGHT_WEB_SERVER=1 \
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3010 \
PLAYWRIGHT_WEB_SERVER_COMMAND='NEXT_DIST_DIR=.next-playwright npm run dev -- -H 127.0.0.1 -p 3010' \
npx playwright test
```

发布脚本以 PM2 中实际运行的 `NEXT_DIST_DIR` 为准选择空闲 slot，不会覆盖运行目录。切换后会检查 `http://127.0.0.1:3000/`；失败时回滚原 slot，成功后原子更新 marker 并保存 PM2 进程表。

`pm2-nyy.service` 必须为 enabled/active，`pm2-root.service` 不得承载 nyy 应用。

## 5. Nginx

- `/_next/static/` 使用一年 immutable 缓存。
- `/icons/`、`/patterns/` 稳定文件名资源使用七天缓存，不标记 immutable。
- `/.env` 等 dotfile 路径直接返回 404。
- `/healthz` 与 `/readyz` 精确代理到后端。
- `/api/` 不缓存，并转发真实客户端 IP 与请求 ID。

首次部署先让发行版默认 Nginx 在 80 端口提供 `/var/www/html`，再通过 webroot 签发主站证书。该方式不停止 Nginx，后续自动续期也不会制造周期性停机：

```bash
sudo install -d -m 0755 -o root -g root /var/www/html/.well-known/acme-challenge
sudo certbot certonly --webroot -w /var/www/html \
  -d nyy.app -d www.nyy.app
```

安装主站、JSON access log 和独立 logrotate 配置：

```bash
cd /data/nyy/backend
sudo install -m 0644 deploy/nginx-nyy-site.conf /etc/nginx/sites-available/nyy.app.conf
sudo ln -sfn /etc/nginx/sites-available/nyy.app.conf /etc/nginx/sites-enabled/nyy.app.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo install -m 0644 deploy/nginx-nyy-json-log.conf /etc/nginx/conf.d/nyy-json-log.conf
sudo install -m 0644 deploy/logrotate-nyy-nginx /etc/logrotate.d/nyy-nginx
sudo /usr/sbin/nginx -t
sudo systemctl reload nginx
sudo logrotate --debug /etc/logrotate.d/nyy-nginx
```

`nginx-nyy-json-log.conf` 同时声明 `log_format`、按域名过滤的 `access_log /var/log/nginx/nyy_access.json`，必须通过 `/etc/nginx/nginx.conf` 的 `http {}` 内 `include /etc/nginx/conf.d/*.conf;` 加载，不能 include 到单个 `server {}`。日志轮转模板保留 14 天并向 Nginx 发送 `USR1` 重新打开文件。

修改后执行：

```bash
sudo /usr/sbin/nginx -t
sudo systemctl reload nginx
```

## 6. Admin 邮箱

邮件链路：公网 SMTP 25 → Postfix → `nyy-mail` 用户 Maildir → 每分钟导入 → Admin 收件箱。

- MX：`nyy.app -> mail.nyy.app`
- Maildir：`/data/nyy-runtime/mail/admin/Maildir`
- 归档：`/data/nyy-runtime/mailbox`
- 单封上限：25MB
- 保留策略：默认永久保留；管理员仅可从垃圾箱永久删除
- TLS：`/etc/letsencrypt/live/mail.nyy.app/`
- 续期后自动 `systemctl reload postfix`

安装配置：

```bash
sudo install -d -m 0711 -o root -g root /data/nyy-runtime /data/nyy-runtime/mail
id -u nyy-mail >/dev/null 2>&1 || \
  sudo useradd --system --home-dir /data/nyy-runtime/mail/admin --create-home --shell /usr/sbin/nologin nyy-mail
sudo chmod 0700 /data/nyy-runtime/mail/admin
sudo install -d -m 0700 -o nyy-mail -g nyy-mail \
  /data/nyy-runtime/mail/admin/Maildir/{new,cur,tmp}
# 允许 nyy 导入现有和后续邮件，但不改变 Postfix 投递用户。
sudo setfacl -m u:nyy:--x /data/nyy-runtime/mail/admin
sudo setfacl -R -m u:nyy:rX /data/nyy-runtime/mail/admin/Maildir
sudo setfacl -R -m d:u:nyy:rX /data/nyy-runtime/mail/admin/Maildir

# 逐项合并配置，不覆盖发行版已有的 /etc/postfix/main.cf。
while IFS= read -r setting; do
  case "$setting" in ''|'#'*) continue ;; esac
  sudo postconf -e "$setting"
done < deploy/postfix-main.cf

# 使用独立 alias map 与系统 /etc/aliases 合并，不覆盖已有 aliases。
sudo install -m 0644 -o root -g root deploy/postfix-aliases /etc/postfix/nyy-aliases
sudo postalias /etc/postfix/nyy-aliases
sudo newaliases
sudo postfix check
sudo systemctl restart postfix
```

安装导入 timer：

```bash
sudo install -m 0644 deploy/nyy-mailbox-import.service /etc/systemd/system/
sudo install -m 0644 deploy/nyy-mailbox-import.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nyy-mailbox-import.timer
```

当前入站和出站均为 opportunistic TLS（`smtpd_tls_security_level=may`、`smtp_tls_security_level=may`），未强制所有对端使用 TLS，也不宣称强制验证远端证书；协商 TLS 时最低允许 TLS 1.2。验收时检查 STARTTLS 可用且本机证书匹配 `mail.nyy.app`、本域 `admin@nyy.app` RCPT 返回 250、外部域中继返回 554。

## 7. 运营任务

```bash
sudo install -m 0644 deploy/nyy-runtime-perms.conf /etc/tmpfiles.d/nyy.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/nyy.conf
sudo install -m 0644 deploy/nyy-nginx-access-import.service /etc/systemd/system/
sudo install -m 0644 deploy/nyy-nginx-access-import.timer /etc/systemd/system/
sudo install -m 0644 deploy/nyy-email-outbox.service /etc/systemd/system/
sudo install -m 0644 deploy/nyy-email-outbox.timer /etc/systemd/system/
sudo install -m 0644 deploy/nyy-admin-maintenance.service /etc/systemd/system/
sudo install -m 0644 deploy/nyy-admin-maintenance.timer /etc/systemd/system/
sudo install -m 0644 deploy/nyy-geoip-update.service /etc/systemd/system/
sudo install -m 0644 deploy/nyy-geoip-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemd-analyze verify \
  /etc/systemd/system/nyy-mailbox-import.service \
  /etc/systemd/system/nyy-nginx-access-import.service \
  /etc/systemd/system/nyy-email-outbox.service \
  /etc/systemd/system/nyy-admin-maintenance.service \
  /etc/systemd/system/nyy-geoip-update.service
sudo systemctl enable --now \
  nyy-nginx-access-import.timer \
  nyy-email-outbox.timer \
  nyy-admin-maintenance.timer \
  nyy-geoip-update.timer
```

- Nginx 导入任务按 inode + offset 增量处理 JSON 日志。
- 邮件 outbox 任务每分钟补发请求中断后仍处于 `pending` 的分享邮件；明确失败的邮件保留给管理员审核重试。
- Admin 维护任务创建未来分区、清理过期访问数据并匿名化 180 天前增长事件。
- GeoIP 每月更新后重启 `nyy-backend`。
- 五个新增 service 均以 `User=nyy`、`Group=nyy` 运行，并启用 `NoNewPrivileges`、`PrivateTmp`、`ProtectSystem`、`ProtectHome` 与最小化 `ReadWritePaths`。

## 8. SEO 与 Search Console

完整 GoDaddy DNS 验证、sitemap 提交和排名查看流程见：

`docs/growth/GOOGLE_SEARCH_CONSOLE_GUIDE.md`

不要提交虚假的 Google token。使用 DNS Domain Property；若使用 Meta 验证，只把 Google 提供的 `content` 值放入构建变量 `GOOGLE_SITE_VERIFICATION`。

## 9. 发布验收

```bash
curl -I https://nyy.app/
curl -I https://nyy.app/.env
curl -I https://nyy.app/sitemap.xml
curl -s https://nyy.app/llms.txt
systemctl status postfix pm2-nyy nyy-mailbox-import.timer nyy-email-outbox.timer --no-pager
sudo -u nyy -H env PM2_HOME=/home/nyy/.pm2 pm2 status nyy-backend nyy-frontend
```

预期：首页 200 且不是 `no-store`；dotfile 404；健康检查 200；PM2 两个应用 online；邮箱导入和 outbox timer active。

## 10. Legacy 模板

- `deploy/Caddyfile`：早期 Caddy + Next.js 静态导出模板，仅供历史参考。
- `deploy/nyy.service.legacy`：早期 `/opt/nyy` 直启 FastAPI 模板，已使用非 unit 后缀防止误装。
- 当前唯一生产拓扑是 Nginx TLS 入口 + `pm2-nyy` 管理 FastAPI/Next.js + systemd timers；不要同时启用 legacy 模板。

## 11. 备份与容量

数据库、`/data/nyy-runtime/mail/admin/Maildir` 和 `/data/nyy-runtime/mailbox` 必须进入外部备份。默认永久邮件保留会持续占用磁盘，至少监控 `/data` 使用率、Maildir 大小和附件归档大小。
