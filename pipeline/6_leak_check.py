"""Fails if anything from a private catalogue has survived into this repo.

This exists because the repository began life as a port of a private project,
and the first port leaked in four separate ways: two migration scripts carried
a full mapping table of real brand names, several hard-coded vocabularies kept
their original entries, test fixtures still named real services, and one
substitution replaced a term with a longer string that still contained it.

Run it before every commit. It needs no access to the private data — it looks
for terms that should simply never appear.
"""
import os, re, sys, json, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Terms that belong to the private catalogue this project was ported from.
# Substring match, case-insensitive, deliberately blunt: a term that appears
# inside a longer word is still a leak.
BANNED = [
    "korean", "rica", "honey", "cirepil", "o3+", "swedish", "mcaffeine",
    "waxology", "gluta", "hydraglo", "vit-c", "sikkim", "rudra",
    "yesmadam",
]

# The author's own name is not a leak — it belongs in the licence and the
# commit history. Only the originating company's identifiers are banned.
ALLOWED_IN = {"LICENSE": {"author"}}

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv"}
SKIP_FILES = {os.path.basename(__file__)}          # this file names them by design

def walk():
    for root, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f in SKIP_FILES or f.endswith((".png", ".jpg", ".pdf", ".zip")):
                continue
            yield os.path.join(root, f)

hits = collections.defaultdict(list)
for path in walk():
    try:
        text = open(path, encoding="utf-8", errors="ignore").read()
    except OSError:
        continue
    low = text.lower()
    for term in BANNED:
        if term in low:
            line = low[: low.index(term)].count("\n") + 1
            hits[os.path.relpath(path, ROOT)].append((term, line))

# the data must also declare itself synthetic, in the file and on the page
problems = []
cat = json.load(open(os.path.join(ROOT, "data", "catalogue.json")))
if not cat.get("meta", {}).get("synthetic"):
    problems.append("data/catalogue.json does not carry meta.synthetic = true")
for fn in os.listdir(os.path.join(ROOT, "prototype")):
    if fn.endswith(".html") and ".template." not in fn:
        p = os.path.join(ROOT, "prototype", fn)
        if "synthetic-note" not in open(p, encoding="utf-8", errors="ignore").read():
            problems.append("prototype/%s has no visible synthetic-data notice" % fn)

if hits or problems:
    print("LEAK CHECK FAILED\n")
    for f, found in sorted(hits.items()):
        for term, line in found[:4]:
            print("  %s:%d  contains %r" % (f, line, term))
    for p in problems:
        print("  " + p)
    sys.exit(1)

print("leak check passed")
print("  %d files scanned" % sum(1 for _ in walk()))
print("  %d banned terms, none present" % len(BANNED))
print("  catalogue declares itself synthetic, every built page carries the notice")
