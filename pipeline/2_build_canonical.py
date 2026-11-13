"""Turns the raw synthetic catalogue into what the prototype embeds.

Three jobs: collapse duplicate listings to one canonical row with aliases,
build the term vectors that stand in for a learned embedding, and write the
curated suggestion table, the order counts and the shopper histories.
"""
import json, os, math, random, re, collections

random.seed(7731)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = os.path.join(ROOT, "data")
raw  = json.load(open(os.path.join(OUT, "_raw.json")))
S, SUBCATS, BUCKETS, CATEGORIES = (raw["services"], raw["subcats"],
                                   raw["buckets"], raw["categories"])

# ------------------------------------------------------- collapse duplicates
groups = collections.defaultdict(list)
for k, v in S.items():
    groups[(v["b"], v["t"])].append(k)

canon, alias = {}, {}
for (_b, _t), ids in groups.items():
    ids.sort(key=lambda k: (-S[k]["bk"], int(k)))
    c = ids[0]
    rec = dict(S[c])
    rec["bkAll"]  = sum(S[k]["bk"] for k in ids)
    rec["alias"]  = ids[1:]
    rec["prices"] = sorted({S[k]["p"] for k in ids if S[k]["p"]})
    canon[c] = rec
    for k in ids:
        alias[k] = c

# a parent's kid list has to point at surviving rows
for k, v in canon.items():
    if v.get("kid"):
        v["kid"] = sorted({int(alias.get(str(x), str(x))) for x in v["kid"]})
    if v.get("par"):
        v["par"] = int(alias.get(str(v["par"]), str(v["par"])))
print("canonical services: %d  (from %d rows)  aliases: %d"
      % (len(canon), len(S), len(alias)))

# -------------------------------------------------------------- parent ranges
# Built here rather than in step 1, because a range's children are DISTINCT
# SERVICES, and step 1 still holds the same service once per floor. Grouping
# before the merge gave a card thirteen rows long that collapsed to three.
nid = max(int(k) for k in canon) + 1
made = 0
for pname, hall, line in raw.get("ranges", []):
    kids = [k for k, v in canon.items()
            if v["sc"] == hall and v.get("tg", "").startswith(line) and v["vis"]]
    seen_names, uniq = set(), []
    for k in sorted(kids, key=lambda k: -canon[k]["bk"]):
        if canon[k]["t"] in seen_names:
            continue
        seen_names.add(canon[k]["t"]); uniq.append(k)
    uniq = uniq[:13]
    if len(uniq) < 4:
        print("  SKIPPED %s — only %d distinct options" % (pname, len(uniq)))
        continue
    anyk = canon[uniq[0]]
    canon[str(nid)] = {
        "t": pname, "c": anyk["c"], "sc": hall, "b": anyk["b"], "sid": anyk["sid"],
        "p": min(canon[k]["p"] for k in uniq), "g": anyk["g"], "sco": 9500,
        "tg": line, "kid": [int(k) for k in uniq], "par": 0, "hot": 0, "vis": 1,
        "bk": random.randint(600, 2600), "bkAll": 0, "alias": [], "prices": [],
    }
    for k in uniq:
        canon[k]["par"] = nid
    print("  range %-26s %2d options   (%s)" % (pname, len(uniq), hall))
    nid += 1; made += 1
print("parent ranges: %d across %d categories"
      % (made, len({r[1] for r in raw.get("ranges", [])})))

# ---------------------------------------------------------------- the vectors
# TF-IDF folded to a small dense space. This stands in for a learned
# embedding: good enough to show the architecture, not good enough to ship.
def toks(t):
    return [w for w in re.split(r"[^a-z0-9]+", t.lower()) if len(w) > 1]

docs = {k: toks(v["t"] + " " + v["sc"] + " " + (v.get("tg") or "")) for k, v in canon.items()}
df = collections.Counter()
for d in docs.values():
    df.update(set(d))
N = len(docs)
terms = sorted(t for t, c in df.items() if 2 <= c <= N * 0.45)
tix = {t: i for i, t in enumerate(terms)}
DIMS = 48
proj = [[random.gauss(0, 1) for _ in range(DIMS)] for _ in terms]
vec = {}
for k, d in docs.items():
    acc = [0.0] * DIMS
    tf = collections.Counter(d)
    for t, c in tf.items():
        i = tix.get(t)
        if i is None:
            continue
        w = (1 + math.log(c)) * math.log(N / df[t])
        for j in range(DIMS):
            acc[j] += w * proj[i][j]
    n = math.sqrt(sum(x * x for x in acc)) or 1.0
    vec[k] = [round(x / n, 4) for x in acc]
print("vectors: %d services x %d dims  (vocabulary %d)" % (len(vec), DIMS, len(terms)))

# ---------------------------------------------------- curated suggestion table
# Mirrors a real one: hand-written phrases mapped to service ids, some of
# which have gone stale and point at nothing live.
sug, sid = [], 1
by_hall = collections.defaultdict(list)
for k, v in canon.items():
    by_hall[v["sc"]].append(k)
for hall, ids in sorted(by_hall.items()):
    ids = sorted(ids, key=lambda k: -canon[k]["bk"])
    sug.append({"id": sid, "n": hall, "ids": [int(i) for i in ids[:10]],
                "cats": [], "ch": "", "g": 1}); sid += 1
    seen = set()
    for k in ids[:40]:
        v = canon[k]
        for phrase in filter(None, [
                ("%s %s" % (v["line"], hall)).strip() if v.get("line") else "",
                ("%s %s" % (v["area"], hall)).strip() if v.get("area") else "",
                v["t"] if len(v["t"].split()) <= 4 else ""]):
            if phrase.lower() in seen:
                continue
            seen.add(phrase.lower())
            hits = [int(x) for x in ids if phrase.lower() in canon[x]["t"].lower()][:8]
            if hits:
                sug.append({"id": sid, "n": phrase, "ids": hits,
                            "cats": [], "ch": "", "g": 1}); sid += 1
# stale rows, because a real curated table always has some
for i in range(18):
    sug.append({"id": sid, "n": "Seasonal Offer %d" % (i + 1),
                "ids": [999900 + i], "cats": [], "ch": "", "g": 1}); sid += 1
print("curated suggestions: %d  (%d of them stale by design)" % (len(sug), 18))

# ------------------------------------------------------------- order counts
# A separate "completed orders" feed, as the real build has: the catalogue's
# own bk is the fallback, this is what ranking actually reads.
orders = {}
for k, v in canon.items():
    if random.random() < 0.88:                      # a few never match, as in life
        orders[k] = max(1, int(v["bk"] * random.uniform(2.6, 4.4)))
print("order feed: %d of %d services, %s orders"
      % (len(orders), len(canon), format(sum(orders.values()), ",")))

# ----------------------------------------------------------------- personas
def top_in(hall, line=None, n=3):
    c = [k for k, v in canon.items() if v["sc"] == hall and (not line or v.get("line") == line)]
    return sorted(c, key=lambda k: -canon[k]["bk"])[:n]

reg = {}
for h, ln, times in [("Waxing", "Aurora", 10), ("Threading", None, 8),
                     ("Pedicure", "Terra", 7), ("Facial", "Aurora", 4),
                     ("Hair Spa", "Nova", 3)]:
    for k in top_in(h, ln, 2):
        reg[k] = times
        times = max(2, times - 4)
occ = {}
for h, ln in [("Waxing", "Verda"), ("Massage", None), ("Manicure", None)]:
    k = top_in(h, ln, 1)
    if k:
        occ[k[0]] = 2 if ln else 1
new1 = {top_in("Body Polishing", "Aurora", 1)[0]: 1} if top_in("Body Polishing", "Aurora", 1) else {}

PERSONAS = {
 "amara": {"label": "Amara — regular · %d lines / 4 months" % sum(reg.values()),
           "note": "Books monthly. Strongly Aurora.", "counts": reg},
 "kiara": {"label": "Kiara — occasional · %d lines / 4 months" % sum(occ.values()),
           "note": "A couple of waxing visits, tried a few things.", "counts": occ},
 "alia":  {"label": "Alia — new · %d line / 4 months" % sum(new1.values()),
           "note": "One booking. Effectively unknown.", "counts": new1},
 "new":   {"label": "No history at all", "note": "First-time visitor.", "counts": {}},
}
for p, d in PERSONAS.items():
    print("  %-6s %2d lines across %d services" % (p, sum(d["counts"].values()), len(d["counts"])))

for k in canon:
    canon[k].pop("line", None)
    canon[k].pop("area", None)

json.dump({"services": canon, "subcats": SUBCATS, "buckets": BUCKETS,
           "categories": CATEGORIES, "suggestions": sug, "alias": alias,
           "vec": vec, "terms": terms, "dims": DIMS, "hasBookings": True,
           "meta": {"synthetic": True, "generated": "2026-11-13",
                    "note": "Entirely synthetic. No real customer or catalogue data."}},
          open(os.path.join(OUT, "catalogue.json"), "w"))
json.dump({"orders": orders, "months": ["May-2026", "Jun-2026", "Jul-2026",
                                        "Aug-2026", "Sep-2026"],
           "source": "synthetic_orders.csv", "synthetic": True},
          open(os.path.join(OUT, "orders.json"), "w"))
json.dump(PERSONAS, open(os.path.join(OUT, "personas.json"), "w"), indent=1)
print("\nwrote catalogue.json, orders.json, personas.json")
