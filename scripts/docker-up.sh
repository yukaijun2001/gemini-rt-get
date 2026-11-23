#!/usr/bin/env bash
set -euo pipefail

detect_ip() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    local iface
    iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
    ipconfig getifaddr "${iface:-en0}" 2>/dev/null || true
  else
    ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}'
  fi
}

IP="${HOST_IP:-$(detect_ip)}"

if [[ -n "$IP" ]]; then
  echo "检测到服务器 IP: $IP"
  HOST_IP="$IP" docker compose up -d --build
  echo "手机/局域网访问: http://$IP:20000"
else
  echo "未检测到局域网 IP，按默认配置启动"
  docker compose up -d --build
  echo "请使用 http://<服务器IP>:20000 访问"
fi
