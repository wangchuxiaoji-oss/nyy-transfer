#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
active_file="$root_dir/.next-production-active"
health_url="${FRONTEND_HEALTH_URL:-http://127.0.0.1:3000/}"
health_attempts="${FRONTEND_HEALTH_ATTEMPTS:-20}"

if [[ ! "$health_attempts" =~ ^[1-9][0-9]*$ ]]; then
  printf 'FRONTEND_HEALTH_ATTEMPTS 必须是正整数。\n' >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 || "$(id -un)" != "nyy" ]]; then
  printf '发布必须由专用 nyy 用户执行，禁止使用 root。\n' >&2
  exit 1
fi

for required_command in cp curl dirname find flock mkdir node npm pm2 sort; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf '缺少发布依赖命令：%s。\n' "$required_command" >&2
    exit 1
  fi
done

lock_file="$root_dir/.deploy-production.lock"
exec 9>"$lock_file"
if ! flock -n 9; then
  printf '已有前端发布正在进行，拒绝并发发布。\n' >&2
  exit 1
fi

export HOME=/home/nyy
export PM2_HOME=/home/nyy/.pm2
export NODE_ENV=production

if ! pm2 describe nyy-frontend >/dev/null 2>&1; then
  printf '未找到 PM2 进程 nyy-frontend。请先按 backend/deploy/README.md 的“首次初始化”步骤创建进程。\n' >&2
  exit 1
fi

process_state="$(
  pm2 jlist | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const processInfo = JSON.parse(input).find((item) => item.name === "nyy-frontend");
  if (!processInfo) process.exit(2);
  const environment = processInfo.pm2_env || {};
  process.stdout.write(`${environment.status || ""}|${environment.NEXT_DIST_DIR || ""}`);
});
'
)"
IFS='|' read -r process_status running_slot <<< "$process_state"
running_slot="${running_slot##*/}"

if [[ "$process_status" != "online" ]]; then
  printf 'nyy-frontend 当前状态为 %s，拒绝覆盖构建目录。\n' "${process_status:-unknown}" >&2
  exit 1
fi

case "$running_slot" in
  .next-production-a) next_slot=.next-production-b ;;
  .next-production-b) next_slot=.next-production-a ;;
  *)
    printf '无法从 PM2 确认当前 A/B slot（NEXT_DIST_DIR=%s），请先按部署文档初始化。\n' "${running_slot:-unset}" >&2
    exit 1
    ;;
esac

if [[ -f "$active_file" ]]; then
  marker_slot=""
  read -r marker_slot < "$active_file" || true
  if [[ "$marker_slot" != "$running_slot" ]]; then
    printf '警告：marker=%s 与 PM2 运行 slot=%s 不一致，以 PM2 为准。\n' "$marker_slot" "$running_slot" >&2
  fi
fi

check_health() {
  local attempt
  for ((attempt = 1; attempt <= health_attempts; attempt++)); do
    if curl --fail --silent --show-error --max-time 5 "$health_url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

write_active_marker() {
  local slot="$1"
  local marker_tmp
  if ! marker_tmp="$(mktemp "${active_file}.tmp.XXXXXX")"; then
    return 1
  fi
  if ! printf '%s\n' "$slot" > "$marker_tmp" || ! mv -f -- "$marker_tmp" "$active_file"; then
    rm -f -- "$marker_tmp"
    return 1
  fi
}

record_static_manifest() {
  local slot="$1"
  find "$root_dir/$slot/static" -type f -printf '%P\n' | LC_ALL=C sort > "$root_dir/$slot/.nyy-static-files"
}

copy_release_static() {
  local source_slot="$1"
  local target_slot="$2"
  local manifest="$root_dir/$source_slot/.nyy-static-files"
  if [[ ! -d "$root_dir/$source_slot/static" || ! -d "$root_dir/$target_slot/static" ]]; then
    return 0
  fi
  if [[ ! -f "$manifest" ]]; then
    cp -a "$root_dir/$source_slot/static/." "$root_dir/$target_slot/static/"
    return 0
  fi
  while IFS= read -r relative_path; do
    [[ -n "$relative_path" && -f "$root_dir/$source_slot/static/$relative_path" ]] || continue
    mkdir -p "$(dirname "$root_dir/$target_slot/static/$relative_path")"
    cp -a "$root_dir/$source_slot/static/$relative_path" "$root_dir/$target_slot/static/$relative_path"
  done < "$manifest"
}

rollback() {
  printf '发布失败，回滚到 %s。\n' "$running_slot" >&2
  copy_release_static "$next_slot" "$running_slot"
  export NEXT_DIST_DIR="$running_slot"
  if ! pm2 restart nyy-frontend --update-env; then
    printf 'PM2 回滚命令失败，需要人工处理。\n' >&2
    return 1
  fi
  if ! check_health; then
    printf '回滚后健康检查仍失败，需要人工处理。\n' >&2
    return 1
  fi
  if ! pm2 save || ! write_active_marker "$running_slot"; then
    printf '服务已回滚，但 PM2 状态或 marker 保存失败，需要人工检查。\n' >&2
    return 1
  fi
  printf '已回滚到 %s。\n' "$running_slot" >&2
}

switch_attempted=false
deployment_complete=false
handle_exit() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$status" -ne 0 && "$switch_attempted" == true && "$deployment_complete" != true ]]; then
    rollback || true
  fi
  exit "$status"
}
trap handle_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$root_dir"
export NEXT_DIST_DIR="$next_slot"

npm run build
record_static_manifest "$next_slot"

# 保留上一 slot 的哈希静态资源，避免已打开页面在切换后延迟加载旧 chunk 时出现 404。
copy_release_static "$running_slot" "$next_slot"

switch_attempted=true
pm2 restart nyy-frontend --update-env
check_health
pm2 save
write_active_marker "$next_slot"
deployment_complete=true
trap - EXIT INT TERM

printf '前端已发布到 %s\n' "$next_slot"
