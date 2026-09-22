#!/usr/bin/env python3
"""Small allowlisted CONNECT proxy for the NNModelling W&B worker network."""

from __future__ import annotations

import select
import socket
import socketserver
from urllib.parse import urlsplit


LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 3128
ALLOWED_HOSTS = frozenset({"api.wandb.ai", "storage.googleapis.com"})
BUFFER_SIZE = 64 * 1024


def _target(value: str) -> tuple[str, int] | None:
    parsed = urlsplit(f"//{value}")
    host = (parsed.hostname or "").rstrip(".").lower()
    if host not in ALLOWED_HOSTS:
        return None
    try:
        port = parsed.port or 443
    except ValueError:
        return None
    if not 1 <= port <= 65535:
        return None
    return host, port


def _relay(left: socket.socket, right: socket.socket) -> None:
    sockets = (left, right)
    while True:
        readable, _, exceptional = select.select(sockets, (), sockets)
        if exceptional:
            return
        for source in readable:
            payload = source.recv(BUFFER_SIZE)
            if not payload:
                return
            destination = right if source is left else left
            destination.sendall(payload)


class ProxyHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        request_line = self.rfile.readline(8192)
        if not request_line:
            return
        try:
            method, authority, _version = request_line.decode("ascii").split()
        except (UnicodeDecodeError, ValueError):
            self.wfile.write(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            return

        # Consume headers before opening any upstream connection.
        while self.rfile.readline(8192) not in (b"\r\n", b"\n", b""):
            pass

        if method.upper() != "CONNECT":
            self.wfile.write(b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n")
            return

        target = _target(authority)
        if target is None:
            self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
            return

        try:
            upstream = socket.create_connection(target, timeout=10)
        except OSError:
            self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
            return

        with upstream:
            self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            self.wfile.flush()
            _relay(self.connection, upstream)


class ThreadedProxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with ThreadedProxy((LISTEN_HOST, LISTEN_PORT), ProxyHandler) as server:
        server.serve_forever()
