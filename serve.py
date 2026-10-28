#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
serve.py — 零依赖本地静态服务器（只用 Python 标准库）。

为什么需要它：
  1. MediaPipe 的 WASM 通过 `instantiateStreaming` 加载，必须收到
     Content-Type: application/wasm；部分静态服务器/系统注册表会把它当成
     application/octet-stream，导致 WASM 编译失败。本脚本显式声明正确 MIME。
  2. ES module 脚本（.js / .mjs）必须返回 JavaScript MIME，否则浏览器拒绝执行。
  3. 浏览器要求通过 http(s) 同源加载，直接用 file:// 打开会因 CORS / 模块
     限制而白屏。

用法：
  python3 serve.py            # 默认 http://127.0.0.1:5173
  python3 serve.py 8080       # 指定端口
  python3 serve.py 8080 0.0.0.0
"""

import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))

EXTRA_TYPES = {
    ".wasm": "application/wasm",
    ".mjs": "text/javascript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".task": "application/octet-stream",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        **EXTRA_TYPES,
    }

    def end_headers(self):
        # 本地开发不做强缓存，避免改了文件看不到变化
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    host = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"

    handler = functools.partial(Handler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer((host, port), handler) as httpd:
        print("Gao Leng Shuishui 本地服务已启动")
        print("  打开:  http://%s:%d/" % ("127.0.0.1" if host == "0.0.0.0" else host, port))
        print("  根目录: %s" % ROOT)
        print("  Ctrl+C 停止")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()
