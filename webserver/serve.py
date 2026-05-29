#!/usr/bin/env python3
"""nana app server — serves ~/apps over a unix socket for the nanabox v2 web substrate.

Caddy reverse-proxies https://<box>.nanabot.me/<handle>/* to
/run/nanabox/agents/<handle>.sock with the FULL PATH PRESERVED (the /<handle>
prefix is NOT stripped by Caddy). This server strips that prefix itself and maps
the remainder onto static files + CGI scripts under apps/, following the
publish-web layout:

  /<h>/                       -> apps/index.html                  (root app)
  /<h>/<file>                 -> apps/<file>                      (root app static)
  /<h>/api/<cgi>[/<extra>]    -> apps/api/<cgi>          (CGI, PATH_INFO=/<extra>)
  /<h>/<name>/                -> apps/<name>/public/index.html    (named app)
  /<h>/<name>/<file>          -> apps/<name>/public/<file>
  /<h>/<name>/api/<cgi>[/...] -> apps/<name>/api/<cgi>   (CGI)

A path segment maps to a "named app" when apps/<seg0>/ is a directory; otherwise
it falls back to the root app. CGI matches the old Caddy exec contract: the script
receives standard CGI env vars + HTTP_* headers + the request body on stdin, and
writes "Header: val\\n...\\n\\n<body>" (optionally a "Status: NNN msg" line) to stdout.
"""
import argparse
import mimetypes
import os
import socket
import socketserver
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

AGENT = os.environ.get("AGENT_NAME") or os.environ.get("USER") or "nana"
PREFIX = "/" + AGENT
REPO = Path(__file__).resolve().parent.parent
APPS = REPO / "apps"
CGI_TIMEOUT = 120  # seconds; ai-edit proxies Anthropic, so give it room


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "nana-appserver/1.0"

    # Route every method through one handler.
    def do_GET(self):    self.handle_any()
    def do_POST(self):   self.handle_any()
    def do_PUT(self):    self.handle_any()
    def do_DELETE(self): self.handle_any()
    def do_PATCH(self):  self.handle_any()
    def do_HEAD(self):   self.handle_any()
    def do_OPTIONS(self): self.handle_any()

    def log_message(self, fmt, *args):
        # NB: don't use address_string() — client_address is "" on AF_UNIX and
        # indexing it raises IndexError, which would abort the response.
        log(fmt % args)

    # ---- request body --------------------------------------------------
    def read_body(self) -> bytes:
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in te:
            chunks = []
            while True:
                line = self.rfile.readline().strip()
                if not line:
                    continue
                try:
                    size = int(line.split(b";")[0], 16)
                except ValueError:
                    break
                if size == 0:
                    self.rfile.readline()  # trailing CRLF
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.readline()      # CRLF after each chunk
            return b"".join(chunks)
        cl = self.headers.get("Content-Length")
        if cl:
            try:
                n = int(cl)
            except ValueError:
                return b""
            return self.rfile.read(n) if n > 0 else b""
        return b""

    # ---- routing -------------------------------------------------------
    def handle_any(self):
        try:
            raw_path, _, query = self.path.partition("?")
            body = self.read_body()  # always drain so keep-alive stays in sync

            # Strip the /<handle> prefix Caddy preserves.
            if raw_path == PREFIX:
                sub = "/"
            elif raw_path.startswith(PREFIX + "/"):
                sub = raw_path[len(PREFIX):]
            else:
                sub = raw_path  # no prefix (direct/local hit) — serve from root

            # Decode + sanitize segments (block traversal).
            try:
                from urllib.parse import unquote
                segs = [unquote(s) for s in sub.split("/") if s]
            except Exception:
                return self.send_simple(400, "bad path")
            if any(s == ".." or "\x00" in s or "/" in s for s in segs):
                return self.send_simple(400, "bad path")

            named = bool(segs) and (APPS / segs[0]).is_dir()
            if named:
                name = segs[0]
                rest = segs[1:]
                app_dir = APPS / name
                if rest and rest[0] == "api":
                    return self.serve_cgi(app_dir / "api", rest[1:],
                                          PREFIX + "/" + name + "/api", query, body)
                return self.serve_static(app_dir / "public", rest)
            else:
                if segs and segs[0] == "api":
                    return self.serve_cgi(APPS / "api", segs[1:],
                                          PREFIX + "/api", query, body)
                return self.serve_static(APPS, segs)
        except BrokenPipeError:
            pass
        except Exception as e:  # never let the handler thread die silently
            log("handler error on %s: %r" % (self.path, e))
            try:
                self.send_simple(500, "internal error")
            except Exception:
                pass

    # ---- static --------------------------------------------------------
    def serve_static(self, base: Path, relsegs):
        target = base.joinpath(*relsegs) if relsegs else base
        try:
            resolved = target.resolve()
            base_resolved = base.resolve()
        except OSError:
            return self.send_simple(404, "not found")
        if base_resolved != resolved and base_resolved not in resolved.parents:
            return self.send_simple(403, "forbidden")
        if resolved.is_dir():
            resolved = resolved / "index.html"
        if not resolved.is_file():
            return self.send_simple(404, "not found")

        ctype, _ = mimetypes.guess_type(str(resolved))
        ctype = ctype or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        size = resolved.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(resolved, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)

    # ---- CGI -----------------------------------------------------------
    def serve_cgi(self, api_dir: Path, cgi_segs, script_name_prefix, query, body):
        if not cgi_segs:
            return self.send_simple(404, "not found")
        script = api_dir / cgi_segs[0]
        path_info_segs = cgi_segs[1:]
        try:
            resolved = script.resolve()
            api_resolved = api_dir.resolve()
        except OSError:
            return self.send_simple(404, "not found")
        if api_resolved not in resolved.parents:
            return self.send_simple(403, "forbidden")
        if not (resolved.is_file() and os.access(str(resolved), os.X_OK)):
            return self.send_simple(404, "not found")

        env = dict(os.environ)
        env.update({
            "GATEWAY_INTERFACE": "CGI/1.1",
            "SERVER_PROTOCOL": "HTTP/1.1",
            "SERVER_SOFTWARE": self.server_version,
            "SERVER_NAME": (self.headers.get("Host") or "localhost").split(":")[0],
            "REQUEST_METHOD": self.command,
            "QUERY_STRING": query,
            "REQUEST_URI": self.path,
            "SCRIPT_NAME": script_name_prefix + "/" + cgi_segs[0],
            "PATH_INFO": ("/" + "/".join(path_info_segs)) if path_info_segs else "",
            "REMOTE_ADDR": (self.headers.get("X-Forwarded-For") or "127.0.0.1").split(",")[0].strip(),
        })
        if self.headers.get("Content-Type"):
            env["CONTENT_TYPE"] = self.headers.get("Content-Type")
        env["CONTENT_LENGTH"] = str(len(body))
        for k, v in self.headers.items():
            env["HTTP_" + k.upper().replace("-", "_")] = v

        try:
            proc = subprocess.run(
                [str(resolved)], input=body, cwd=str(resolved.parent),
                env=env, capture_output=True, timeout=CGI_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            return self.send_simple(504, "cgi timeout")
        except Exception as e:
            log("cgi exec failed %s: %r" % (resolved, e))
            return self.send_simple(500, "cgi error")

        if proc.returncode != 0:
            log("cgi %s exit=%s stderr=%s" % (resolved, proc.returncode,
                                              proc.stderr.decode("utf-8", "replace")[:500]))
        out = proc.stdout
        status_code, status_msg, headers, payload = self.parse_cgi(out)
        if proc.returncode != 0 and not out:
            return self.send_simple(500, "cgi error")

        self.send_response_only(status_code, status_msg or None)
        have_ct = False
        for k, v in headers:
            kl = k.lower()
            if kl == "content-length":
                continue  # we set our own
            if kl == "content-type":
                have_ct = True
            self.send_header(k, v)
        if not have_ct:
            self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    @staticmethod
    def parse_cgi(out: bytes):
        status_code, status_msg, headers = 200, "OK", []
        idx = out.find(b"\r\n\r\n")
        sep_len = 4
        if idx == -1:
            idx = out.find(b"\n\n")
            sep_len = 2
        if idx == -1:
            return status_code, status_msg, headers, out  # no headers -> all body
        header_block = out[:idx]
        payload = out[idx + sep_len:]
        for line in header_block.replace(b"\r\n", b"\n").split(b"\n"):
            if not line or b":" not in line:
                continue
            k, _, v = line.partition(b":")
            key = k.strip().decode("latin-1")
            val = v.strip().decode("latin-1")
            if key.lower() == "status":
                parts = val.split(None, 1)
                try:
                    status_code = int(parts[0])
                    status_msg = parts[1] if len(parts) > 1 else ""
                except ValueError:
                    pass
            else:
                headers.append((key, val))
        return status_code, status_msg, headers, payload

    def send_simple(self, code, text):
        body = (text + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)


class UnixHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    address_family = socket.AF_UNIX
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self):
        # Bypass HTTPServer.server_bind's host:port logic, invalid for AF_UNIX.
        socketserver.TCPServer.server_bind(self)
        self.server_name = AGENT
        self.server_port = 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--unix", required=True, help="unix socket path to bind")
    args = ap.parse_args()

    sock_path = args.unix
    try:
        os.unlink(sock_path)
    except FileNotFoundError:
        pass

    server = UnixHTTPServer(sock_path, Handler)
    os.chmod(sock_path, 0o660)  # owner+agents-group; the dir (2770) gates the rest
    log("nana-appserver listening on %s (handle=%s, apps=%s)" % (sock_path, AGENT, APPS))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            os.unlink(sock_path)
        except OSError:
            pass


if __name__ == "__main__":
    main()
