#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/yukaijun2001/gemini-rt-get.git}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-20000}"
APP_DIR="${APP_DIR:-}"
APP_DIR_EXPLICIT="${APP_DIR:+1}"
APP_DIR="${APP_DIR:-$HOME/gemini-rt-get}"
SKIP_PULL="${SKIP_PULL:-0}"

info() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[deploy] %s\033[0m\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"
}

detect_ip() {
  local ip=""
  if [[ "$(uname -s)" == "Darwin" ]]; then
    local iface
    iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
    ip="$(ipconfig getifaddr "${iface:-en0}" 2>/dev/null || true)"
    [[ -n "$ip" ]] || ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
  else
    ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
    [[ -n "$ip" ]] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  printf '%s' "$ip"
}

install_git() {
  warn "未找到 git，尝试自动安装"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    command -v brew >/dev/null 2>&1 || die "请先安装 Xcode Command Line Tools 或 Homebrew"
    brew install git
  elif command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -y && $SUDO apt-get install -y git
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y git
  elif command -v yum >/dev/null 2>&1; then
    $SUDO yum install -y git
  else
    die "无法自动安装 git，请手动安装后重试"
  fi
}

install_docker() {
  warn "未找到 Docker，尝试自动安装"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    command -v brew >/dev/null 2>&1 || die "请先安装 Docker Desktop: https://www.docker.com/products/docker-desktop/"
    brew install --cask docker
    open -a Docker || true
    warn "Docker Desktop 首次启动需要授权，完成后请重新运行本脚本"
    exit 0
  fi
  need_cmd curl
  $SUDO sh -c 'curl -fsSL https://get.docker.com | sh'
  $SUDO systemctl enable --now docker 2>/dev/null || true
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$APP_DIR_EXPLICIT" && -f "$SCRIPT_DIR/docker-compose.yml" && -d "$SCRIPT_DIR/.git" ]]; then
  APP_DIR="$SCRIPT_DIR"
fi
export APP_DIR

SUDO=""
if [[ "${EUID:-$(id -u)}" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

if ! command -v git >/dev/null 2>&1; then
  install_git
fi

if ! command -v curl >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -y && $SUDO apt-get install -y curl
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y curl
  else
    die "缺少 curl，请手动安装后重试"
  fi
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  info "克隆仓库到 $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"
elif [[ "$SKIP_PULL" != "1" ]]; then
  info "拉取 $BRANCH 最新代码"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
fi

if ! command -v docker >/dev/null 2>&1; then
  install_docker
fi

if ! docker info >/dev/null 2>&1; then
  if [[ "$(uname -s)" != "Darwin" && "$EUID" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
    info "Docker 需要更高权限，切换为 sudo 执行"
    exec sudo -E bash "$0" "$@"
  fi
  die "Docker 守护进程未运行，请先启动 Docker"
fi

if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    die "检测到 docker-compose v1，请安装 Docker Compose v2（docker compose）"
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    $SUDO apt-get install -y docker-compose-plugin 2>/dev/null || true
  fi
  docker compose version >/dev/null 2>&1 || die "缺少 docker compose 插件"
fi

ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
CONCURRENCY=${CONCURRENCY:-2}
EOF
  chmod 600 "$ENV_FILE"
fi

if [[ -n "${GOOGLE_CLIENT_ID:-}" && -n "${GOOGLE_CLIENT_SECRET:-}" ]]; then
  sed -i.bak '/^GOOGLE_CLIENT_ID=/d; /^GOOGLE_CLIENT_SECRET=/d' "$ENV_FILE"
  printf 'GOOGLE_CLIENT_ID=%s\nGOOGLE_CLIENT_SECRET=%s\n' "$GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_SECRET" >> "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
fi

if grep -qE '^PORT=' "$ENV_FILE"; then
  sed -i.bak "s/^PORT=.*/PORT=$PORT/" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
else
  printf 'PORT=%s\n' "$PORT" >> "$ENV_FILE"
fi

if ! grep -qE '^CONCURRENCY=' "$ENV_FILE"; then
  printf 'CONCURRENCY=%s\n' "${CONCURRENCY:-2}" >> "$ENV_FILE"
fi

IP="$(detect_ip)"
if [[ -n "$IP" ]]; then
  info "服务器 IP: $IP"
else
  warn "未探测到局域网 IP，请稍后用 http://<服务器IP>:$PORT 访问"
fi

if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
  $SUDO ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
  info "已放行防火墙端口 $PORT/tcp"
fi

info "构建并启动容器"
cd "$APP_DIR"
HOST_IP="$IP" PORT="$PORT" docker compose up -d --build

info "等待服务就绪"
READY=0
for _ in $(seq 1 60); do
  if curl --noproxy '*' -fsS --max-time 3 "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done

if [[ "$READY" != "1" ]]; then
  die "服务启动超时，请执行: cd $APP_DIR && docker compose logs --tail 100"
fi

echo
info "部署完成"
echo "  本机访问:   http://localhost:$PORT"
[[ -n "$IP" ]] && echo "  手机/局域网: http://$IP:$PORT"
echo "  查看日志:   cd $APP_DIR && docker compose logs -f"
echo "  停止服务:   cd $APP_DIR && docker compose down"
