#!/usr/bin/env bash
#
# 免 root 准备 VS Code(Electron) 缺失的运行库。
# 思路：apt-get download 不需要 root（只下载 .deb），再用 dpkg -x 解到自己的目录，
# 运行时通过 LD_LIBRARY_PATH 指过去。完全不碰系统目录。
#
set -uo pipefail
LIBS="$HOME/.local/vscode-test-libs"
DL="$LIBS/download"
mkdir -p "$DL"
cd "$DL" || exit 1

# 来自 ldd <vscode>/code 的 "not found"；多下几个不影响
PKGS="libnss3 libnspr4 libasound2t64 libasound2"

for p in $PKGS; do
	if ls "$DL"/"${p}"_*.deb >/dev/null 2>&1; then
		echo "已有 $p"
		continue
	fi
	printf '下载 %-16s ' "$p"
	if apt-get download -qq "$p" >/dev/null 2>&1; then
		echo "ok"
	else
		echo "（该发行版无此包名，跳过）"
	fi
done

cd "$LIBS" || exit 1
for f in "$DL"/*.deb; do
	[ -e "$f" ] || continue
	dpkg -x "$f" "$LIBS" && echo "解出 $(basename "$f")"
done

echo
echo "库目录：$LIBS/usr/lib/x86_64-linux-gnu"
ls "$LIBS/usr/lib/x86_64-linux-gnu" 2>/dev/null | head -20
