#!/usr/bin/env python3
"""Download the rendering libraries into static/vendor so mdview works offline.

The UI falls back to the CDN automatically if a vendored file is missing,
so running this is optional but recommended.
"""
import os
import sys
import urllib.request
from pathlib import Path

VENDOR = Path(__file__).resolve().parent / "static" / "vendor"

JSD = "https://cdn.jsdelivr.net/npm/"
FILES = {
    "marked.min.js": JSD + "marked@15/marked.min.js",
    "purify.min.js": JSD + "dompurify@3/dist/purify.min.js",
    "highlight.min.js": JSD + "@highlightjs/cdn-assets@11/highlight.min.js",
    "hljs-github.min.css": JSD + "@highlightjs/cdn-assets@11/styles/github.min.css",
    "hljs-github-dark.min.css": JSD + "@highlightjs/cdn-assets@11/styles/github-dark.min.css",
    "katex.min.js": JSD + "katex@0.16/dist/katex.min.js",
    "katex.min.css": JSD + "katex@0.16/dist/katex.min.css",
    "mermaid.min.js": JSD + "mermaid@11/dist/mermaid.min.js",
}
KATEX_FONTS = [
    "KaTeX_AMS-Regular", "KaTeX_Caligraphic-Bold", "KaTeX_Caligraphic-Regular",
    "KaTeX_Fraktur-Bold", "KaTeX_Fraktur-Regular", "KaTeX_Main-Bold",
    "KaTeX_Main-BoldItalic", "KaTeX_Main-Italic", "KaTeX_Main-Regular",
    "KaTeX_Math-BoldItalic", "KaTeX_Math-Italic", "KaTeX_SansSerif-Bold",
    "KaTeX_SansSerif-Italic", "KaTeX_SansSerif-Regular", "KaTeX_Script-Regular",
    "KaTeX_Size1-Regular", "KaTeX_Size2-Regular", "KaTeX_Size3-Regular",
    "KaTeX_Size4-Regular", "KaTeX_Typewriter-Regular",
]
for f in KATEX_FONTS:
    FILES[f"fonts/{f}.woff2"] = JSD + f"katex@0.16/dist/fonts/{f}.woff2"


def fetch(url, dest, force=False):
    if dest.exists() and not force:
        return "cached"
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "mdview-vendor/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    dest.write_bytes(data)
    return f"{len(data) // 1024} KB"


def main():
    force = "--force" in sys.argv
    failed = 0
    for rel, url in FILES.items():
        dest = VENDOR / rel
        try:
            status = fetch(url, dest, force)
            print(f"  ok   {rel:40s} {status}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  FAIL {rel:40s} {e}")
    if failed:
        print(f"{failed} file(s) failed; the UI will fall back to the CDN for those.")
    else:
        print("All vendor files present.")
    return 1 if failed else 0


if __name__ == "__main__":
    os.chdir(Path(__file__).resolve().parent)
    sys.exit(main())
