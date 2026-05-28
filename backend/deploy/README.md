# 部署指南（VPS / Ubuntu 22.04 或 24.04）

> v1 单进程 FastAPI + Caddy 反代 + Next.js 静态导出。

## 1. 系统准备

```bash
sudo apt update && sudo apt install -y \
    python3.11 python3.11-venv python3-pip \
    postgresql postgresql-contrib \
    redis-server \
    caddy \
    git
sudo systemctl enable --now postgresql redis-server caddy
```

## 2. 数据库

```bash
sudo -u postgres psql -c "CREATE USER nyy WITH PASSWORD '强密码';"
sudo -u postgres psql -c "CREATE DATABASE nyy OWNER nyy;"
```

## 3. 应用账号 + 代码

```bash
sudo useradd -m -s /bin/bash nyy
sudo mkdir -p /opt/nyy /var/www/nyy /opt/nyy/var
sudo chown -R nyy:nyy /opt/nyy /var/www/nyy

sudo -u nyy bash <<'EOS'
cd /opt/nyy
git clone https://github.com/<you>/nyy.git .
python3.11 -m venv .venv
.venv/bin/pip install -U pip wheel
.venv/bin/pip install -r requirements.txt
cp .env.example .env
EOS

sudo -u nyy nano /opt/nyy/.env  # 填入真实 DATABASE_URL/SECRET_KEY 等
sudo -u nyy /opt/nyy/.venv/bin/alembic upgrade head
```

## 4. Caddy + systemd

```bash
sudo cp /opt/nyy/deploy/Caddyfile /etc/caddy/Caddyfile
sudo cp /opt/nyy/deploy/nyy.service /etc/systemd/system/nyy.service
sudo systemctl daemon-reload
sudo systemctl enable --now nyy
sudo systemctl reload caddy
```

## 5. 前端（待 Week 1 末填充）

```bash
cd frontend
pnpm install
pnpm build
# 静态导出
pnpm export
sudo cp -r out/* /var/www/nyy/
```

## 6. 备份（每日 cron）

```bash
sudo -u nyy crontab -e
# 加入
0 3 * * * /opt/nyy/scripts/pg_dump_to_r2.sh
```

参见 `scripts/pg_dump_to_r2.sh`（Week 5 落地）。
