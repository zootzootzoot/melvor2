"""Stamp a fresh cache-busting version on every script/style URL in docs/.

GitHub Pages serves files with a 10-minute cache, and ES module imports are cached per URL,
so after a deploy a returning visitor could mix old and new modules. Run this before each
commit that changes docs/js or docs/css:  python -I tools/bump_version.py
"""
import os
import re
import time

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs")
V = time.strftime("%Y%m%d%H%M")
PAT = re.compile(r"""((?:src|href)="(?:js|css)/[\w./-]+\.(?:js|css)|from\s+['"]\./[\w./-]+\.js|import\(\s*['"]\./[\w./-]+\.js)(\?v=\w+)?""")


def stamp(path):
    with open(path, encoding="utf-8") as f:
        s = f.read()
    n = PAT.sub(lambda m: m.group(1) + "?v=" + V, s)
    if n != s:
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(n)
        return True
    return False


changed = [p for p in [os.path.join(ROOT, "index.html")] + [os.path.join(ROOT, "js", f) for f in os.listdir(os.path.join(ROOT, "js")) if f.endswith(".js")] if stamp(p)]
print("version", V, "->", ", ".join(os.path.relpath(p, ROOT) for p in changed) or "nothing to stamp")
