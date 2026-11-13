"""Generates a synthetic service catalogue.

Nothing in here is real. The *shape* is modelled on a home-services
marketplace — several verticals, each with floors, each floor holding halls
(sub-categories), each hall holding services that come in variants by
treatment line and body area — because that shape is what makes search hard.
The names, prices, brands and order counts are all invented.

Deliberate properties, because the search logic is built to survive them:

  * variant explosion — one treatment sold across many body-part combinations
  * duplicate listings — the same service on more than one floor, different id
  * parent ranges      — treatment lines sold as a range with children
  * long tail          — most services sell very little
  * every vertical     — so search works for nails and makeup, not only waxing
"""
import json, os, random, re

random.seed(20260413)                       # reproducible
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = os.path.join(ROOT, "data")

# ---------------------------------------------------------------- vocabulary
# Invented treatment lines. These play the role real brand names play: they
# are the word a shopper uses to tell two otherwise identical services apart.
LINES = {
    "Aurora":  {"tier": "premium", "mult": 1.9},
    "Verda":   {"tier": "classic", "mult": 1.0},
    "Silk":    {"tier": "premium", "mult": 1.6},
    "Lumen":   {"tier": "classic", "mult": 1.1},
    "Terra":   {"tier": "natural", "mult": 1.2},
    "Nova":    {"tier": "premium", "mult": 1.7},
    "Petal":   {"tier": "classic", "mult": 0.9},
    "Amber":   {"tier": "natural", "mult": 1.3},
}
AREAS_BODY = ["Full Arms", "Half Arms", "Full Legs", "Half Legs", "Underarms",
              "Full Back", "Half Back", "Stomach", "Bikini", "Full Body"]
AREAS_FACE = ["Upper Lips", "Lower Lips", "Chin", "Forehead", "Side Locks",
              "Full Face", "Neck", "Eyebrows"]
COMBOS = ["Full Arms + Full Legs + Underarms",
          "Full Arms + Half Legs + Underarms",
          "Full Arms + Underarms"]
DURATIONS = ["30 mins", "45 mins", "60 mins", "90 mins"]

# ------------------------------------------------------------------ taxonomy
# vertical -> floors -> halls -> how services are built inside that hall
TAXONOMY = {
 "Beauty": {
  "floors": [("HOME SALON", "FEMALE"), ("RAPID SALON", "FEMALE"),
             ("GLOW STUDIO", "FEMALE"), ("MENS GROOMING", "MALE")],
  "halls": {
    "Waxing":        {"kind": "line_area", "areas": AREAS_BODY, "combos": True,  "base": 420},
    "Face Waxing":   {"kind": "area",      "areas": AREAS_FACE, "base": 160},
    "Threading":     {"kind": "area",      "areas": AREAS_FACE, "base": 60},
    "Facial":        {"kind": "line_plain","base": 1100},
    "Clean Up":      {"kind": "line_plain","base": 700},
    "Bleach":        {"kind": "line_plain","base": 450},
    "Detan":         {"kind": "line_area", "areas": AREAS_BODY[:6], "base": 350},
    "Body Polishing":{"kind": "line_area", "areas": AREAS_BODY[:6], "base": 900},
  }},
 "Spa & Therapy": {
  "floors": [("SIGNATURE THERAPY", "FEMALE"), ("HOME THERAPY", "FEMALE"),
             ("MALE MASSAGE", "MALE"), ("CITY SPA", "FEMALE")],
  "halls": {
    "Massage":       {"kind": "line_dur",  "base": 1300},
    "Head Massage":  {"kind": "dur",       "base": 400},
    "Foot Massage":  {"kind": "dur",       "base": 450},
    "Body Scrub":    {"kind": "line_plain","base": 1000},
    "Steam Therapy": {"kind": "dur",       "base": 600},
  }},
 "Hair": {
  "floors": [("HAIR SALON", "FEMALE"), ("HAIR SALON FOR MEN", "MALE")],
  "halls": {
    "Hair Cut":      {"kind": "plain_set", "set": ["Trim", "Layer Cut", "Blunt Cut",
                                                   "Step Cut", "Fringe Cut", "Baby Cut"], "base": 450},
    "Hair Spa":      {"kind": "line_plain","base": 950},
    "Hair Colour":   {"kind": "line_plain","base": 1400},
    "Hair Treatment":{"kind": "line_plain","base": 1800},
    "Head Shave":    {"kind": "plain_set", "set": ["Head Shave", "Beard Trim",
                                                   "Beard Styling"], "base": 250},
  }},
 "Nails": {
  "floors": [("NAIL STUDIO", "FEMALE")],
  "halls": {
    "Manicure":      {"kind": "line_plain","base": 550},
    "Pedicure":      {"kind": "line_plain","base": 650},
    "Nail Extension":{"kind": "plain_set", "set": ["Gel Extension", "Acrylic Extension",
                                                   "Extension Removal", "Nail Refill"], "base": 1200},
    "Nail Art":      {"kind": "plain_set", "set": ["French Tips", "Chrome Finish",
                                                   "Glitter Art", "Ombre Art"], "base": 300},
  }},
 "Makeup": {
  "floors": [("HOME MAKEUP", "FEMALE"), ("STUDIO MAKEUP", "FEMALE")],
  "halls": {
    "Party Makeup":  {"kind": "line_plain","base": 2200},
    "Bridal Makeup": {"kind": "line_plain","base": 7500},
    "Hair Styling":  {"kind": "plain_set", "set": ["Blow Dry", "Curls", "Straightening",
                                                   "Updo", "Braiding"], "base": 500},
    "Mehandi":       {"kind": "plain_set", "set": ["Up to Elbow", "Up to Shoulder",
                                                   "Feet Mehandi", "Bridal Mehandi"], "base": 600},
  }},
 "Laser": {
  "floors": [("LASER CLINIC", "FEMALE"), ("LASER CLINIC FOR MEN", "MALE")],
  "halls": {
    "Laser Hair Reduction": {"kind": "area_sess", "areas": AREAS_BODY + AREAS_FACE[:4], "base": 2200},
    "Laser Skin":           {"kind": "plain_set", "set": ["Pigmentation", "Acne Scars",
                                                          "Skin Tightening", "Tattoo Removal"], "base": 3500},
  }},
 "Body Toning": {
  "floors": [("BODY STUDIO", "FEMALE"), ("BODY STUDIO FOR MEN", "MALE")],
  "halls": {
    "Inch Loss":    {"kind": "area_sess", "areas": ["Stomach", "Full Arms", "Full Legs",
                                                    "Full Body", "Hips"], "base": 1900},
    "Body Wrap":    {"kind": "line_plain","base": 1600},
    "Cupping":      {"kind": "area_sess", "areas": ["Full Back", "Full Legs", "Stomach"], "base": 1400},
  }},
}

# Parent ranges deliberately spread across FIVE different categories, so the
# range cards demo everywhere rather than only on waxing.
RANGES = [
  ("Aurora Waxing Ritual",   "Waxing",    "Aurora"),
  ("Verda Wax (Tin)",        "Waxing",    "Verda"),
  ("Silk Facial Collection", "Facial",    "Silk"),
  ("Lumen Spa Journey",      "Massage",   "Lumen"),
  ("Terra Nail Studio",      "Pedicure",  "Terra"),
  ("Nova Hair Therapy",      "Hair Spa",  "Nova"),
]

SERVICES, SUBCATS, BUCKETS, CATEGORIES = {}, [], {}, {}
nid, hid, cid = 1000, 1, 1

def price(base, mult, scale=1.0):
    p = int(base * mult * scale)
    return int(round(p / 10.0) * 10) - 1          # 449, 1299 …

def demand(rank, hall_pop):
    """Long-tailed. A few services carry most of the orders."""
    v = hall_pop * (0.62 ** rank) * random.uniform(0.7, 1.35)
    return max(1, int(v))

for vert, spec in TAXONOMY.items():
    hall_names = list(spec["halls"])
    for fname, gender in spec["floors"]:
        key = fname if fname not in BUCKETS else fname + " II"
        BUCKETS[key] = {"key": key, "vertical": vert, "gender": gender,
                        "delivery": random.choice(["DNCR", "BHMP", "Instant"]), "n": 0,
                        "siblings": [f for f, _ in spec["floors"] if f != fname]}
        CATEGORIES[str(cid)] = {"id": cid, "name": key, "main": vert,
                                "gender": gender, "status": "Activate"}
        cid += 1
        for hall in hall_names:
            cfg = spec["halls"][hall]
            SUBCATS.append({"id": hid, "name": hall, "cat": key})
            hall_pop = random.choice([900, 2400, 6000, 14000])
            built = []
            k = cfg["kind"]
            # whichever lines a parent range needs from this hall are never
            # left to the sampler, or the range would have nothing to group
            need = [ln for _, h, ln in RANGES if h == hall]
            def lines_for(lo, hi):
                pick = random.sample([l for l in LINES if l not in need],
                                     max(0, random.randint(lo, hi) - len(need)))
                return need + pick
            if k == "line_area":
                for ln in lines_for(3, 5):
                    for a in cfg["areas"]:
                        built.append(("%s %s - %s" % (a, hall, ln), LINES[ln]["mult"], ln, a))
                    if cfg.get("combos"):
                        for c in COMBOS:
                            built.append(("%s %s - %s" % (c, hall, ln), LINES[ln]["mult"] * 2.4, ln, c))
            elif k == "area":
                for a in cfg["areas"]:
                    built.append(("%s %s" % (a, hall), 1.0, "", a))
            elif k == "area_sess":
                for a in cfg["areas"]:
                    for s in ("1 Session", "3 Sessions", "6 Sessions"):
                        m = {"1 Session": 1.0, "3 Sessions": 2.7, "6 Sessions": 5.0}[s]
                        built.append(("%s %s - %s" % (a, hall, s), m, "", a))
            elif k == "line_plain":
                # each line sells in a few grades, which is what gives a range
                # its children — a treatment line is rarely one single SKU
                GRADES = [("", 1.0), ("Express", .72), ("Deluxe", 1.45),
                          ("Signature", 1.8), ("Repair", 1.3), ("Glow", 1.25)]
                for ln in lines_for(4, 6):
                    for g, gm in random.sample(GRADES, random.randint(3, 5)):
                        nm = ("%s %s %s" % (ln, hall, g)).strip()
                        built.append((nm, LINES[ln]["mult"] * gm, ln, ""))
            elif k == "line_dur":
                for ln in lines_for(3, 5):
                    for d in DURATIONS:
                        m = {"30 mins": .7, "45 mins": .9, "60 mins": 1.0, "90 mins": 1.45}[d]
                        built.append(("%s %s (%s)" % (ln, hall, d), LINES[ln]["mult"] * m, ln, ""))
            elif k == "dur":
                for d in DURATIONS:
                    m = {"30 mins": .7, "45 mins": .9, "60 mins": 1.0, "90 mins": 1.45}[d]
                    built.append(("%s (%s)" % (hall, d), m, "", ""))
            elif k == "plain_set":
                for s in cfg["set"]:
                    built.append((s, random.uniform(.8, 1.4), "", ""))

            built.sort(key=lambda b: -b[1])
            for rank, (name, mult, ln, area) in enumerate(built):
                SERVICES[str(nid)] = {
                    "t": name, "c": key, "sc": hall, "b": key, "sid": hid,
                    "p": price(cfg["base"], mult), "g": "F" if gender == "FEMALE" else "M",
                    "sco": random.randint(1, 9000), "tg": ", ".join(x for x in [ln, area] if x),
                    "kid": [], "par": 0, "hot": 0, "vis": 1,
                    "bk": demand(rank, hall_pop), "line": ln, "area": area,
                }
                BUCKETS[key]["n"] += 1
                nid += 1
            hid += 1

print("built %d services, %d halls, %d floors" % (len(SERVICES), len(SUBCATS), len(BUCKETS)))

# ---------------------------------------------------- duplicates across floors
# The same service genuinely sells on more than one floor. Search has to
# collapse these, so the catalogue has to contain them.
dupes = 0
for sid, rec in list(SERVICES.items()):
    sibs = BUCKETS[rec["b"]]["siblings"]
    if sibs and random.random() < 0.34:
        tgt = random.choice(sibs)
        if tgt not in BUCKETS:
            continue
        hall_here = [h for h in SUBCATS if h["name"] == rec["sc"] and h["cat"] == tgt]
        if not hall_here:
            continue
        cp = dict(rec)
        cp["b"] = cp["c"] = tgt
        cp["sid"] = hall_here[0]["id"]
        cp["bk"] = max(1, int(rec["bk"] * random.uniform(0.25, 0.8)))
        cp["p"] = rec["p"] if random.random() < 0.8 else rec["p"] + 100
        SERVICES[str(nid)] = cp
        BUCKETS[tgt]["n"] += 1
        nid += 1
        dupes += 1
print("added %d duplicate listings across floors" % dupes)

# parent ranges are built in step 2, from canonical rows — see the note there.

os.makedirs(OUT, exist_ok=True)
json.dump({"services": SERVICES, "subcats": SUBCATS, "buckets": BUCKETS,
           "categories": CATEGORIES, "ranges": RANGES},
          open(os.path.join(OUT, "_raw.json"), "w"))
print("\nwrote data/_raw.json")
