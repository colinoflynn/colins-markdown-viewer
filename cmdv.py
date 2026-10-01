#!/usr/bin/env python3
"""
cmdv (Colin's Markdown Viewer) - a fast local Markdown viewer.

Usage:
    python cmdv.py [ROOT ...] [--port 8765] [--no-open] [--browser]

Serves a browser UI for browsing directories and reading Markdown files,
with live reload when files change on disk. Only files under the given
ROOT directories (default: the current directory) are accessible.
The server binds to 127.0.0.1 only. No third-party packages required.
"""
import argparse
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"

MD_EXTS = {".md", ".markdown", ".mdown", ".mkd", ".mdx"}
TEXT_EXTS = {".txt", ".rst", ".log", ".json", ".yaml", ".yml", ".toml", ".csv", ".py", ".js", ".ts", ".html", ".css", ".sh", ".ps1"}
IGNORE_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", ".cache", ".tox", ".next",
    ".dropbox.cache", "$RECYCLE.BIN", "System Volume Information",
}
INDEX_TTL = 15.0         # seconds an index of all .md files is considered fresh
INDEX_MAX_FILES = 60000  # safety cap for huge roots

ROOTS = []       # resolved absolute root directories
VERBOSE = False


# --------------------------------------------------------------------------- paths

def is_md(name):
    return os.path.splitext(name)[1].lower() in MD_EXTS


def is_text(name):
    return os.path.splitext(name)[1].lower() in TEXT_EXTS


def resolve_under_roots(path):
    """Return the real path if it lies under one of ROOTS, else None."""
    if not path:
        return None
    real = os.path.realpath(path)
    n = os.path.normcase(real)
    for r in ROOTS:
        rn = os.path.normcase(r)
        if n == rn or n.startswith(rn.rstrip("\\/") + os.sep):
            return real
    return None


def root_of(path):
    n = os.path.normcase(path)
    for r in ROOTS:
        rn = os.path.normcase(r)
        if n == rn or n.startswith(rn.rstrip("\\/") + os.sep):
            return r
    return None


# --------------------------------------------------------------------------- index

class Index:
    """Cached walk of every Markdown file under every root.

    The walk can take seconds on a large tree, so it runs in a background
    thread: callers get the last completed result immediately and a refresh
    is kicked off whenever the cached copy is older than INDEX_TTL.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.built = 0.0
        self.files = None
        self.building = False
        self.ready = threading.Event()

    def refresh(self):
        with self.lock:
            if self.building:
                return
            self.building = True
        threading.Thread(target=self._rebuild, daemon=True).start()

    def get(self):
        with self.lock:
            stale = time.time() - self.built > INDEX_TTL
            have = self.files is not None
        if stale:
            self.refresh()
        if not have:
            self.ready.wait(timeout=120)
        with self.lock:
            return list(self.files or []), self.built

    def _rebuild(self):
        try:
            files = self._walk()
            with self.lock:
                self.files = files
                self.built = time.time()
        finally:
            with self.lock:
                self.building = False
            self.ready.set()

    @staticmethod
    def _walk():
        out = []
        for root in ROOTS:
            stack = [root]
            while stack and len(out) < INDEX_MAX_FILES:
                d = stack.pop()
                try:
                    it = os.scandir(d)
                except OSError:
                    continue
                with it:
                    for e in it:
                        try:
                            if e.is_dir(follow_symlinks=False):
                                if e.name in IGNORE_DIRS:
                                    continue
                                stack.append(e.path)
                            elif e.is_file(follow_symlinks=False) and is_md(e.name):
                                st = e.stat(follow_symlinks=False)
                                out.append({
                                    "path": e.path,
                                    "name": e.name,
                                    "mtime": st.st_mtime,
                                    "size": st.st_size,
                                    "root": root,
                                })
                        except OSError:
                            pass
        return out


INDEX = Index()


# --------------------------------------------------------------------------- handler

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "cmdv/1.0"

    def log_message(self, fmt, *args):
        if VERBOSE:
            super().log_message(fmt, *args)

    # -- helpers
    def send_json(self, obj, status=200):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_bytes(self, data, ctype, cache="no-cache", status=200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def error(self, msg, status=400):
        self.send_json({"error": msg}, status)

    def query(self):
        u = urllib.parse.urlsplit(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        return u.path, q

    # -- routing
    def do_GET(self):
        path, q = self.query()
        try:
            if path.startswith("/api/"):
                self.api(path[5:], q, None)
            else:
                self.static(path)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as e:  # noqa: BLE001
            self.error(f"{type(e).__name__}: {e}", 500)

    do_HEAD = do_GET

    def do_POST(self):
        path, q = self.query()
        try:
            # POSTs have side effects (save, open, reveal): only accept them from
            # our own origin, so a page on another site cannot drive this server.
            origin = self.headers.get("Origin")
            if origin and urllib.parse.urlsplit(origin).hostname not in ("127.0.0.1", "localhost", "::1"):
                return self.error("forbidden origin", 403)
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            try:
                data = json.loads(body or b"{}")
            except ValueError:
                data = {}
            if path.startswith("/api/"):
                self.api(path[5:], q, data)
            else:
                self.error("not found", 404)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as e:  # noqa: BLE001
            self.error(f"{type(e).__name__}: {e}", 500)

    # -- static files
    def static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        rel = urllib.parse.unquote(path).lstrip("/")
        if ".." in rel.split("/"):
            return self.error("bad path", 400)
        f = STATIC / rel
        if not f.is_file():
            return self.error("not found", 404)
        ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        cache = "public, max-age=86400" if rel.startswith("vendor/") else "no-cache"
        self.send_bytes(f.read_bytes(), ctype, cache)

    # -- api
    def api(self, name, q, data):
        fn = getattr(self, "api_" + name.replace("/", "_"), None)
        if fn is None:
            return self.error("unknown api", 404)
        return fn(q, data or {})

    def api_config(self, q, data):
        self.send_json({
            "roots": [{"path": r, "name": os.path.basename(r.rstrip("\\/")) or r} for r in ROOTS],
            "sep": os.sep,
            "platform": sys.platform,
            "cwd": os.getcwd(),
        })

    def api_list(self, q, data):
        real = resolve_under_roots(q.get("path"))
        if real is None or not os.path.isdir(real):
            return self.error("not a directory under the served roots", 404)
        show_all = q.get("all") == "1"
        entries = []
        with os.scandir(real) as it:
            for e in it:
                try:
                    if e.is_dir(follow_symlinks=False):
                        if e.name in IGNORE_DIRS:
                            continue
                        st = e.stat(follow_symlinks=False)
                        entries.append({"name": e.name, "path": e.path, "type": "dir",
                                        "mtime": st.st_mtime, "hidden": e.name.startswith(".")})
                    elif e.is_file():
                        if is_md(e.name) or (show_all and is_text(e.name)):
                            st = e.stat()
                            entries.append({"name": e.name, "path": e.path, "type": "file",
                                            "mtime": st.st_mtime, "size": st.st_size,
                                            "md": is_md(e.name)})
                except OSError:
                    pass
        entries.sort(key=lambda x: (x["type"] != "dir", x["name"].lower()))
        st = os.stat(real)
        self.send_json({"path": real, "mtime": st.st_mtime, "entries": entries})

    def api_file(self, q, data):
        real = resolve_under_roots(q.get("path"))
        if real is None or not os.path.isfile(real):
            return self.error("file not found", 404)
        st = os.stat(real)
        with open(real, "rb") as fh:
            raw = fh.read()
        content = raw.decode("utf-8-sig", errors="replace")
        self.send_json({"path": real, "mtime": st.st_mtime, "size": st.st_size, "content": content})

    def api_save(self, q, data):
        """Write a Markdown or text file under the roots, refusing to clobber
        changes made since the client loaded it unless force is set."""
        real = resolve_under_roots(data.get("path"))
        if real is None or not os.path.isfile(real):
            return self.error("file not found", 404)
        if not (is_md(real) or is_text(real)):
            return self.error("not an editable text file", 400)
        content = data.get("content")
        if not isinstance(content, str):
            return self.error("content missing", 400)
        st = os.stat(real)
        expected = data.get("mtime")
        if expected is not None and abs(st.st_mtime - float(expected)) > 1e-6 and not data.get("force"):
            return self.send_json({"error": "changed on disk", "conflict": True, "mtime": st.st_mtime}, 409)
        with open(real, "rb") as fh:
            raw = fh.read()
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError:
            return self.error("file is not valid UTF-8; edit it in another editor", 400)
        # keep the file's own conventions: BOM and CRLF line endings
        bom = raw.startswith(b"\xef\xbb\xbf")
        crlf = b"\r\n" in raw
        text = content.replace("\r\n", "\n")
        if crlf:
            text = text.replace("\n", "\r\n")
        out = (b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8")
        tmp = real + ".cmdv-tmp"
        try:
            with open(tmp, "wb") as fh:
                fh.write(out)
            os.replace(tmp, real)
        except OSError as e:
            try:
                os.remove(tmp)
            except OSError:
                pass
            return self.error(str(e), 500)
        st = os.stat(real)
        self.send_json({"ok": True, "mtime": st.st_mtime, "size": st.st_size})

    def api_raw(self, q, data):
        real = resolve_under_roots(q.get("path"))
        if real is None or not os.path.isfile(real):
            return self.error("file not found", 404)
        ctype = mimetypes.guess_type(real)[0] or "application/octet-stream"
        with open(real, "rb") as fh:
            self.send_bytes(fh.read(), ctype, "no-cache")

    def api_stat(self, q, data):
        """POST {paths:[...]} -> {results:{path: mtime|null}}"""
        out = {}
        for p in data.get("paths", [])[:2000]:
            real = resolve_under_roots(p)
            if real is None:
                out[p] = None
                continue
            try:
                out[p] = os.stat(real).st_mtime
            except OSError:
                out[p] = None
        self.send_json({"results": out, "now": time.time()})

    def api_index(self, q, data):
        files, built = INDEX.get()
        self.send_json({"files": files, "built": built, "count": len(files)})

    def api_recent(self, q, data):
        n = min(int(q.get("n", 30)), 500)
        files, built = INDEX.get()
        recent = sorted(files, key=lambda f: f["mtime"], reverse=True)[:n]
        self.send_json({"files": recent, "built": built, "now": time.time()})

    def api_reveal(self, q, data):
        """Show the file in the OS file manager."""
        real = resolve_under_roots(data.get("path"))
        if real is None or not os.path.exists(real):
            return self.error("not found", 404)
        try:
            if sys.platform.startswith("win"):
                subprocess.Popen(["explorer", "/select,", real])
            elif sys.platform == "darwin":
                subprocess.Popen(["open", "-R", real])
            else:
                subprocess.Popen(["xdg-open", os.path.dirname(real)])
        except OSError as e:
            return self.error(str(e), 500)
        self.send_json({"ok": True})

    def api_open(self, q, data):
        """Open the file with the OS default application (e.g. your editor)."""
        real = resolve_under_roots(data.get("path"))
        if real is None or not os.path.exists(real):
            return self.error("not found", 404)
        try:
            if sys.platform.startswith("win"):
                os.startfile(real)  # noqa: S606
            elif sys.platform == "darwin":
                subprocess.Popen(["open", real])
            else:
                subprocess.Popen(["xdg-open", real])
        except OSError as e:
            return self.error(str(e), 500)
        self.send_json({"ok": True})


# --------------------------------------------------------------------------- launch

def find_chromium():
    """Locate Edge or Chrome so we can open a chrome-less app window."""
    names = ["msedge", "chrome", "google-chrome", "chromium", "chromium-browser"]
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    candidates = []
    if sys.platform.startswith("win"):
        pf = os.environ.get("ProgramFiles", r"C:\Program Files")
        pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        local = os.environ.get("LOCALAPPDATA", "")
        candidates += [
            os.path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
            os.path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
    elif sys.platform == "darwin":
        candidates += [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def launch(url, app_mode):
    if app_mode:
        exe = find_chromium()
        if exe:
            try:
                subprocess.Popen([exe, f"--app={url}", "--window-size=1500,950"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
            except OSError:
                pass
    webbrowser.open(url)


def main(argv=None):
    global ROOTS, VERBOSE
    ap = argparse.ArgumentParser(description="Local Markdown viewer")
    ap.add_argument("roots", nargs="*", help="directories to serve (default: current directory)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true", help="do not open a browser window")
    ap.add_argument("--browser", action="store_true",
                    help="open in a normal browser tab instead of a chrome-less app window")
    ap.add_argument("--verbose", action="store_true", help="log every request")
    args = ap.parse_args(argv)

    VERBOSE = args.verbose
    roots = args.roots or [os.getcwd()]
    resolved = []
    for r in roots:
        real = os.path.realpath(r)
        if not os.path.isdir(real):
            print(f"error: not a directory: {r}", file=sys.stderr)
            return 2
        if real not in resolved:
            resolved.append(real)
    ROOTS = resolved
    INDEX.refresh()  # start the first walk now so quick-open is instant

    port = args.port
    httpd = None
    for attempt in range(20):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            port += 1
    if httpd is None:
        print("error: could not bind a port", file=sys.stderr)
        return 1
    httpd.daemon_threads = True

    url = f"http://127.0.0.1:{port}/"
    print(f"cmdv serving {len(ROOTS)} root(s) at {url}")
    for r in ROOTS:
        print(f"  - {r}")
    print("Press Ctrl+C to stop.")

    if not args.no_open:
        threading.Timer(0.4, launch, args=(url, not args.browser)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
