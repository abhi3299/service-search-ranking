"""Embeds the catalogue and the order feed into each prototype."""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "catalogue.json")
ORD  = os.path.join(ROOT, "data", "orders.json")
P    = os.path.join(ROOT, "prototype")

raw = open(DATA, encoding="utf-8").read()
json.loads(raw)
embed = raw.replace("</", "<\\/")
oraw = open(ORD, encoding="utf-8").read() if os.path.exists(ORD) else "{}"
json.loads(oraw)
oembed = oraw.replace("</", "<\\/")

cat = json.loads(raw)
print("catalogue  %d services · %d halls · %d floors · %d aliases"
      % (len(cat["services"]), len(cat["subcats"]), len(cat["buckets"]), len(cat["alias"])))
print("orders     %d services · %s orders"
      % (len(json.loads(oraw).get("orders", {})),
         format(sum(json.loads(oraw).get("orders", {}).values()), ",")))

n = 0
for fn in sorted(os.listdir(P)):
    if not fn.endswith(".template.html"):
        continue
    tpl = open(os.path.join(P, fn), encoding="utf-8").read()
    if "__DATA__" not in tpl:
        sys.exit("%s has no __DATA__ placeholder" % fn)
    out = tpl.replace("__DATA__", embed).replace("__REAL__", oembed)
    dest = os.path.join(P, fn.replace(".template", ""))
    open(dest, "w", encoding="utf-8").write(out)
    print("  wrote %-28s %6d KB" % (os.path.basename(dest), len(out) // 1024))
    n += 1
print("built %d prototypes" % n)
