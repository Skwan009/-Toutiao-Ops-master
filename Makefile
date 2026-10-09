# 常用任务。面向 Linux / macOS；Windows 下直接用 cli/ 目录里的 npm 命令即可。
CLI := cli

.PHONY: help install browser test check

help:
	@echo "make install   安装依赖（跳过 Chromium 下载）"
	@echo "make browser   安装 Chromium（首次运行必须）"
	@echo "make test      运行离线冒烟测试（不联网、不开浏览器）"
	@echo "make check     对 cli/ 下全部脚本做语法检查"

install:
	cd $(CLI) && npm install --ignore-scripts

browser:
	npx playwright install chromium

test:
	cd $(CLI) && npm test

check:
	@cd $(CLI) && find src tools test -type f \( -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check && echo "语法检查通过"
