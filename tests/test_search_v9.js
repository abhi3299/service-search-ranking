#!/usr/bin/env node
/**
 * Tests the v9 prototype — grouped results.
 *
 *     node tests/test_search_v9.js
 *
 * v9 keeps v8's retrieval and relevance untouched and changes the unit of a
 * result: a row is a body area, and the wax type is a choice inside it. So the
 * checks here are about the grouping and the two sorts it introduced — one over
 * areas, one over the variants inside an area.
 *
 * As in test_search.js, the logic is lifted out of the built HTML rather than
 * copied. The clustering lives inside run(), so it is re-declared below; change
 * it in the template and change it here.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HTML = path.join(ROOT, "prototype", "search_v9.html");

const html = fs.readFileSync(HTML, "utf8");
const D = JSON.parse(
  html.match(/<script id="DATA" type="application\/json">([\s\S]*?)<\/script>/)[1]
      .split("<\\/").join("</")
);

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let logic = scripts[scripts.length - 1];
const cut = logic.indexOf("var ST={bucket:true");
if (cut < 0) fail("could not find the state marker in the template");
logic = logic.slice(0, cut)
             .replace('var D=JSON.parse(document.getElementById("DATA").textContent);', "");

const M = new Function("D", logic + `
  return {toks,stem,dedupKey,bookings,history,lexHits,semHits,classify,band,
          resolveHall,areaSplit,areaLabel,variantLabel,tier,herVariant,
          SVC,SUBCATS,ALL,PERSONAS};`)(D);

// ------------------------------------------------------- retrieval + sorts
function search(q, seg, bucket) {
  const all = Object.keys(M.SVC);
  const global = bucket === M.ALL;
  const floor = (global ? all : all.filter((k) => M.SVC[k].b === bucket))
                  .filter((k) => M.SVC[k].vis);
  const hres = M.resolveHall(q, global ? M.ALL : bucket);
  const hallIds = {};
  hres.halls.forEach((h) => (hallIds[h.id] = 1));
  const pool = hres.halls.length ? floor.filter((k) => hallIds[M.SVC[k].sid]) : floor;

  const H = M.history(seg);
  const lex = M.lexHits(q, pool);
  const sem = M.semHits(q, pool);
  const cls = M.classify(q, pool);

  const qt = M.toks(q);
  const scopeApplies = cls.spec.length > 0;
  const scope = (k) => {
    if (!scopeApplies) return 0;
    const seen = {};
    let n = 0;
    M.toks(M.SVC[k].t || "").forEach((w) => {
      if (seen[w]) return;
      seen[w] = 1;
      if (!qt.some((t) => M.stem(t, w))) n++;
    });
    return n <= 2 ? 0 : n <= 4 ? 1 : 2;
  };

  const seen = {};
  Object.keys(lex).forEach((k) => (seen[k] = 1));
  Object.keys(sem).forEach((k) => (seen[k] = 1));

  let cand = [];
  Object.keys(seen).forEach((k) => {
    const b = M.band(k, cls, lex, sem);
    if (!b) return;
    const s = M.SVC[k];
    let brand = 0;
    Object.keys(H.brands).forEach((x) => {
      if ((s.t || "").toLowerCase().indexOf(x) >= 0) brand = 1;
    });
    cand.push({ id: k, band: b, scope: scope(k), mine: H.counts[k] || 0,
                brand, bk: M.bookings(k) });
  });

  cand.sort((a, b) =>
    a.band - b.band || a.scope - b.scope || b.mine - a.mine ||
    M.herVariant(b) - M.herVariant(a) || M.tier(b.bk) - M.tier(a.bk) ||
    b.brand - a.brand || b.bk - a.bk || (a.id < b.id ? -1 : 1));

  const kept = [], byName = {};
  cand.forEach((c) => {
    const key = M.dedupKey(M.SVC[c.id].t);
    if (!byName[key]) { byName[key] = 1; kept.push(c); }
  });
  cand = kept;

  // ---- the v9 grouping
  const clusters = [], byArea = {};
  cand.forEach((c) => {
    const sp = M.areaSplit(M.SVC[c.id].t);
    let g = byArea[sp.area];
    if (!g) {
      g = byArea[sp.area] = { area: sp.area, members: [], band: c.band,
                              scope: c.scope, mine: 0, anyVariant: 0, bk: 0, tot: 0 };
      clusters.push(g);
    }
    c.variant = sp.variant;
    g.members.push(c);
    if (c.band < g.band) g.band = c.band;
    if (c.scope < g.scope) g.scope = c.scope;
    if (c.mine > g.mine) g.mine = c.mine;
    if (M.herVariant(c)) g.anyVariant = 1;
    if (c.bk > g.bk) g.bk = c.bk;
    g.tot += c.bk;
  });
  clusters.forEach((g) => {
    g.members.sort((a, b) =>
      (M.SVC[b.id].p ? 1 : 0) - (M.SVC[a.id].p ? 1 : 0) ||
      b.mine - a.mine || M.herVariant(b) - M.herVariant(a) ||
      b.bk - a.bk || (a.id < b.id ? -1 : 1));
    g.pick = g.members[0];
    g.label = M.areaLabel(g.area, M.SVC[g.pick.id].t);
    const seenV = {};
    g.variants = g.members.filter((m) => {
      const v = m.variant || "";
      if (seenV[v]) return false;
      seenV[v] = 1;
      return true;
    });
  });
  clusters.sort((a, b) =>
    a.band - b.band || a.scope - b.scope || b.mine - a.mine ||
    b.anyVariant - a.anyVariant || M.tier(b.bk) - M.tier(a.bk) || b.bk - a.bk ||
    (a.area < b.area ? -1 : 1));

  const personal = clusters.some((g) => g.mine || g.anyVariant);
  return { cls, hres, cand, clusters, personal, cap: personal ? 10 : 6 };
}

// ---------------------------------------------------------------- harness
let pass = 0, failed = 0;
const title = (t) => console.log("\n" + t);
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}
function fail(msg) { console.error("fatal: " + msg); process.exit(1); }
const labels = (r, n) => r.clusters.slice(0, n).map((g) => g.label);
const chips = (g) => g.variants.map((m) => M.variantLabel(m.variant));

// ---------------------------------------------------------------- parsing
title("areaSplit — word order does not make a second row");
const a1 = M.areaSplit("Full Arms + Full Legs + Underarms Verda Waxing").area;
const a2 = M.areaSplit("Full Arms, Underarms & Full Legs - Verda Tin Wax").area;
check("the same three areas in two word orders share one key", a1 === a2,
      a1 + "\n          " + a2);
check("but full and half stay apart",
      M.areaSplit("Full Legs Waxing").area !== M.areaSplit("Half Legs Waxing").area);
check("the wax type comes out of the name",
      M.areaSplit("Full Legs Aurora Waxing").variant === "aurora",
      M.areaSplit("Full Legs Aurora Waxing").variant);
check("a plain service has no wax type",
      M.areaSplit("Full Legs Waxing").variant === "");
check("label drops the wax type",
      M.areaLabel(M.areaSplit("Full Legs Waxing - Verda Wax").area) === "Full Legs",
      M.areaLabel(M.areaSplit("Full Legs Waxing - Verda Wax").area));
const ord1 = M.areaSplit("Full Arms + Full Legs + Underarms Verda Waxing").area;
const ord2 = M.areaSplit("Full Arms, Underarms & Full Legs - Verda Tin Wax").area;
check("the label is built from the key, so it cannot vary by shopper",
      M.areaLabel(ord1) === M.areaLabel(ord2) &&
      M.areaLabel(ord1) === "Full Arms, Full Legs, Underarms", M.areaLabel(ord1));
const pk = (t) => M.areaLabel(M.areaSplit(t).area);
check("a row with no body part is named by its wax type",
      pk("Package Wraps - Verda (Tin Wax) - 2") === "Verda Wax", pk("Package..."));
check("packaging words do not split one offer into two rows",
      M.areaSplit("Amber Wax (Tin)").area === M.areaSplit("Wraps - Amber (Tin Wax)").area,
      M.areaSplit("Amber Wax (Tin)").area + " vs " + M.areaSplit("Wraps - Amber (Tin Wax)").area);
/* two wax words in either order collapse to the same row, with the line
   name read before the shade, so "Gold Verda" and "Verda Gold" are one offer */
check("brand reads before shade, whichever order it was written in",
      pk("Gold Verda Wax") === pk("Verda Gold Wax") && pk("Gold Verda Wax") === "Verda Gold Wax",
      pk("Gold Verda Wax") + " / " + pk("Verda Gold Wax"));
check('a wax type with no name reads "Standard"', M.variantLabel("") === "Standard");

// ------------------------------------------------------------- collapsing
title("the case that started this — legs waxing");
const legs = search("legs waxing", "new", "HOME SALON");
check("the shopper sees a short list, not one row per service",
      legs.cap <= 10 && legs.cand.length > 3 * legs.cap,
      legs.cand.length + " services -> " + legs.clusters.length +
      " areas -> " + Math.min(legs.cap, legs.clusters.length) + " shown");
check("no wax type is a row of its own in the visible list",
      !legs.clusters.slice(0, legs.cap).some((g) => g.area.charAt(0) === "~"),
      labels(legs, legs.cap).join(" | "));
check("the visible rows are the ones the query named",
      labels(legs, 4).every((l) => /Legs/.test(l)), labels(legs, 4).join(" | "));
check("grouping loses nothing",
      legs.clusters.reduce((n, g) => n + g.members.length, 0) === legs.cand.length);
check("every row has a distinct area",
      new Set(legs.clusters.map((g) => g.area)).size === legs.clusters.length);
legs.clusters.slice(0, 6).forEach((g) => {
  check('no repeated wax type inside "' + g.label + '"',
        new Set(chips(g)).size === chips(g).length, chips(g).join(", "));
});

title("relevance still decides the rows — a legs-only area leads, for everyone");
["new", "alia", "kiara", "amara"].forEach((seg) => {
  const l = labels(search("legs waxing", seg, "HOME SALON"), 1)[0];
  check(seg + " leads with a legs-only row", /^(Full|Half) Legs$/.test(l), l);
});

title("personalisation moved inside the row");
const amaraLegs = search("legs waxing", "amara", "HOME SALON");
const newLegs = search("legs waxing", "new", "HOME SALON");
const rel = (r) => r.clusters.map((g) => g.band + "/" + g.scope).join(",");
check("amara and a new shopper get the identical relevance sequence",
      rel(amaraLegs) === rel(newLegs),
      "amara: " + rel(amaraLegs) + "\n          new:   " + rel(newLegs));
check("and the identical set of rows",
      amaraLegs.clusters.map((g) => g.area).sort().join("|") ===
      newLegs.clusters.map((g) => g.area).sort().join("|"));
check("her history only reorders rows that are equally relevant",
      amaraLegs.clusters.every((g, i) => {
        const n = newLegs.clusters[i];
        return g.band === n.band && g.scope === n.scope;
      }),
      "amara: " + labels(amaraLegs, 8).join(" | ") +
      "\n          new:   " + labels(newLegs, 8).join(" | "));
check("the top rows are identical for both anyway",
      labels(amaraLegs, 4).join(" | ") === labels(newLegs, 4).join(" | "),
      labels(amaraLegs, 4).join(" | "));
check("but her wax type is pre-selected in the first row",
      chips(amaraLegs.clusters[0])[0] === "Aurora", chips(amaraLegs.clusters[0]).join(", "));
/* a shopper with no history gets whichever variant sells most, and the chip
   order is by volume rather than by anything about her */
check("a new shopper gets a pre-selection decided by volume alone",
      chips(newLegs.clusters[0]).length > 0 &&
      newLegs.clusters[0].members.every((m, i, a) =>
        i === 0 || M.bookings(a[i - 1]) >= M.bookings(m)),
      chips(newLegs.clusters[0]).join(", "));

title("an unpriced variant is never the pre-selected one");
["legs waxing", "waxing", "aurora waxing"].forEach((q) => {
  ["new", "amara"].forEach((seg) => {
    const r = search(q, seg, "HOME SALON");
    const bad = r.clusters.slice(0, r.cap).filter(
      (g) => !M.SVC[g.variants[0].id].p && g.variants.some((m) => M.SVC[m.id].p));
    check('"' + q + '" / ' + seg, bad.length === 0,
          bad.map((g) => g.label).join(", "));
  });
});

// ------------------------------------------------------------- list length
title("no history in this hall means a shorter list");
check("amara has waxing signal, so the longer cap", amaraLegs.personal && amaraLegs.cap === 10);
check("a shopper with no history at all gets the short cap",
      !newLegs.personal && newLegs.cap === 6);
/* the long list is unlocked by history IN THIS HALL, not by history anywhere.
   Pick a hall she has never bought from and check the cap is the short one. */
const herHalls = {};
Object.keys(M.PERSONAS.amara.counts).forEach((k) => {
  if (M.SVC[k]) herHalls[M.SVC[k].sc] = 1;
});
const strangeHall = M.SUBCATS.map((h) => h.name).find((n) => !herHalls[n]);
const away = search(strangeHall.toLowerCase(), "amara", M.SUBCATS
  .find((h) => h.name === strangeHall).cat);
check("history in one hall does not unlock the long list in another",
      !away.personal && away.cap === 6,
      strangeHall + ": personal=" + away.personal + " cap=" + away.cap);

// ------------------------------------------------------------- regressions
title("v8 guarantees still hold");
const broad = labels(search("waxing", "new", "HOME SALON"), 1)[0];
check('"waxing" leads with the best-selling combo, not a body part',
      /Arms/.test(broad) && /Legs/.test(broad), broad);
const fl = search("full legs waxing", "new", "HOME SALON");
const iHalf = fl.clusters.findIndex((g) => /^Half Legs$/.test(g.label));
const iFull = fl.clusters.findIndex((g) => /^Full Legs$/.test(g.label));
check("Full Legs outranks Half Legs", iFull >= 0 && (iHalf < 0 || iFull < iHalf),
      "full at " + iFull + ", half at " + iHalf);
check("no test or staging data survives",
      !Object.keys(M.SVC).some((k) => /\b(staging|internal|qa|sandbox)\b/i.test(
        (M.SVC[k].t || "") + (M.SVC[k].c || "") + (M.SVC[k].sc || ""))));
check("no cluster label carries a leaked test-hub word",
      !legs.clusters.some((g) => /sikk/i.test(g.label)),
      legs.clusters.map((g) => g.label).join(" | "));

// ---------------------------------------------------------------- result
console.log("\n" + "-".repeat(52));
console.log(pass + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
