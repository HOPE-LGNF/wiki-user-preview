#!/usr/bin/env bash
#
# 在 WSL 里跑集成测试的包装脚本。两件事必须在这里做，因为本沙箱的 /tmp 每次命令都是新的 tmpfs：
#   1. 让 X 客户端能找到 WSLg 的 X socket（默认路径 /tmp/.X11-unix/X<n> 不存在）
#   2. 把免 root 解出来的 Electron 运行库加进 LD_LIBRARY_PATH
#
set -uo pipefail
cd "$(dirname "$0")/.."

mkdir -p /tmp/.X11-unix
ln -sfn /mnt/wslg/.X11-unix/X0 /tmp/.X11-unix/X0
export DISPLAY="${DISPLAY:-:0}"

# VS Code 主进程会在 $XDG_RUNTIME_DIR 下建 IPC socket，而本沙箱里 /run/user/1000 是只读的
export XDG_RUNTIME_DIR="$HOME/.local/xdg-runtime"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

LIBS="$HOME/.local/vscode-test-libs"
if [ -d "$LIBS/usr/lib/x86_64-linux-gnu" ]; then
	export LD_LIBRARY_PATH="$LIBS/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
else
	echo "警告：$LIBS 不存在，先跑 scripts/setup-electron-libs.sh" >&2
fi

echo "DISPLAY=$DISPLAY"
echo "X socket: $(ls -l /tmp/.X11-unix/ 2>/dev/null | tail -1)"
mkdir -p out-test
node scripts/runIntegration.mjs 2>&1 | tee out-test/integration-run.log
exit "${PIPESTATUS[0]}"
