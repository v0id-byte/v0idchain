#!/bin/bash
# v0idChain 一键挖矿（macOS）—— 在 Finder 里双击本文件即可。
cd "$(dirname "$0")" || exit 1
echo "════════════════════════════════════════"
echo "   v0idChain 矿工 ⛏   \$V0ID"
echo "════════════════════════════════════════"
if ! command -v corepack >/dev/null 2>&1; then
  echo "❌ 没检测到 Node.js。先去 https://nodejs.org 装 LTS 版，再双击本文件。"
  read -r -p "按回车关闭…"; exit 1
fi
echo "▶ 安装依赖（首次几分钟，之后很快）…"
corepack pnpm install || { echo "依赖安装失败"; read -r -p "回车关闭"; exit 1; }
echo "▶ 启动仪表盘…"
corepack pnpm dev:web >/tmp/v0id-web.log 2>&1 &
WEB_PID=$!
trap 'kill $WEB_PID 2>/dev/null' EXIT
sleep 3
open http://localhost:5173 2>/dev/null
echo "▶ 开始挖矿，连接种子 mc.void1211.com … 关闭此窗口即停止挖矿。"
echo
corepack pnpm mine
