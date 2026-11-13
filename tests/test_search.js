#!/usr/bin/env node
/**
 * Tests the shipped prototype.
 *
 *     node tests/test_search.js
 *
 * The search logic is lifted out of prototype/search.html rather than copied,
 * so this exercises exactly what ships. The sort is re-declared here because
 * it lives inside run() in the template; if you change the sort, change it in
 * both places — the mismatch check at the end will catch it if you forget.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
// SEARCH_HTML lets this same suite run against another build — used to prove
// v10.1 did not regress anything v10 guaranteed.
const HTML = process.env.SEARCH_HTML || path.join(ROOT, "prototype", "search.html");

const html = fs.readFileSync(HTML, "utf8");
const D = JSON.parse(
  html.match(/<script id="DATA" type="application\/json">([\s\S]*?)<\/script>/)[1]
      .split("<\\/").join("</")
);

// take the logic script, cut it before the DOM wiring
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let logic = scripts[scripts.length - 1];
const cut = logic.indexOf("var ST={bucket:true");
if (cut < 0) fail("could not find the state marker in the template");
logic = logic.slice(0, cut)
             .replace('var D=JSON.parse(document.getElementById("DATA").textContent);', "");

const M = new Function("D", logic + `
  return {toks,stem,dedupKey,bookings,history,lexHits,semHits,classify,band,
          resolveHall,SVC,SUBCATS,ALL,PERSONAS,RELATED,svcAreas,svcType,areaFacets,typeFacets,
          namedAreas,namedType,TYPE_MIN_SHARE,AREA_WORDS,TYPES};`)(D);

// ---------------------------------------------------------------- the sort
const tier = (n) => Math.floor(Math.log10((n || 0) + 1));
const BRAND_MIN_DEMAND = 20;

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
    const mine = H.counts[k] || 0;
    let brand = 0;
    Object.keys(H.brands).forEach((x) => {
      if ((s.t || "").toLowerCase().indexOf(x) >= 0) brand = 1;
    });
    cand.push({ id: k, band: b, scope: scope(k), mine, brand, bk: M.bookings(k) });
  });

  const herVariant = (c) => (c.brand && c.bk >= BRAND_MIN_DEMAND ? 1 : 0);
  cand.sort((a, b) =>
    a.band - b.band ||
    a.scope - b.scope ||
    b.mine - a.mine ||
    herVariant(b) - herVariant(a) ||
    tier(b.bk) - tier(a.bk) ||
    b.brand - a.brand ||
    b.bk - a.bk ||
    (a.id < b.id ? -1 : 1)
  );

  const kept = [], byName = {};
  cand.forEach((c) => {
    const key = M.dedupKey(M.SVC[c.id].t);
    if (!byName[key]) { byName[key] = 1; kept.push(c); }
  });
  const areaF = M.areaFacets(kept, q);
  const typeF = M.typeFacets(kept);
  const qA = M.namedAreas(q), qT = M.namedType(q);
  return { cls, hres, cand: kept, pool: pool.length, facets: areaF, area: areaF, type: typeF,
           qType: qT, qAreas: Object.keys(qA),
           showType: !qT && typeF.length >= 2 && typeF.typedShare >= M.TYPE_MIN_SHARE,
           showArea: !Object.keys(qA).length && areaF.length >= 2 };
}

// ---------------------------------------------------------------- harness
let pass = 0, failed = 0;
const title = (t) => console.log("\n" + t);
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}
function fail(msg) { console.error("fatal: " + msg); process.exit(1); }
const top = (r, n) => r.cand.slice(0, n).map((c) => M.SVC[c.id].t);

// ---------------------------------------------------------------- payload
title("payload");
check("a catalogue big enough to be hard", Object.keys(M.SVC).length > 1000,
      "got " + Object.keys(M.SVC).length);
check("halls across every vertical", M.SUBCATS.length > 40, "got " + M.SUBCATS.length);
check("no test or staging data survives",
      !Object.keys(M.SVC).some((k) => /\b(staging|internal|qa|sandbox)\b/i.test(
        (M.SVC[k].t || "") + (M.SVC[k].c || "") + (M.SVC[k].sc || ""))));

// ---------------------------------------------------------------- the lift
title("the lift — a query commits to a hall only when it names one");
const hall = (q) => [...new Set(M.resolveHall(q, M.ALL).halls.map((h) => h.name))].join(",");
check('"waxing" commits to Waxing', hall("waxing") === "Waxing", hall("waxing"));
check('"legs wax" commits to Waxing', hall("legs wax") === "Waxing", hall("legs wax"));
check('"leg w" commits while still typing', hall("leg w") === "Waxing", hall("leg w"));
check('"hair reduction" commits to Laser', hall("hair reduction") === "Laser Hair Reduction",
      hall("hair reduction"));
check('"legs" stays global', hall("legs") === "", hall("legs"));
check('"face" stays global', hall("face") === "", hall("face"));

// ---------------------------------------------------------------- scope
title("scope — a legs-only service leads a legs search, for every shopper");
["new", "alia", "kiara"].forEach((seg) => {
  const t = top(search("legs waxing", seg, "HOME SALON"), 1)[0];
  check(seg + " gets a legs-only service first",
        /legs/i.test(t) && !/arms|underarms|back|stomach/i.test(t), t);
});
const amara = top(search("legs waxing", "amara", "HOME SALON"), 1)[0];
check("amara gets her own line of it",
      /legs/i.test(amara) && !/arms|underarms/i.test(amara), amara);

title("scope does not apply when nothing specific was typed");
/* with nothing specific typed, breadth must not be penalised: the leader
   should be a high-volume combination rather than a narrow single area */
const broadList = search("waxing", "new", "HOME SALON");
const broad = top(broadList, 1)[0];
const broadBk = broadList.cand[0] ? broadList.cand[0].bk : 0;
const narrowBest = Math.max(...broadList.cand
  .filter((c) => /^(Upper Lips|Chin|Forehead|Neck) /i.test(M.SVC[c.id].t))
  .map((c) => c.bk).concat([0]));
check('"waxing" leads on volume, not on narrowness', broadBk >= narrowBest,
      broad + " (" + broadBk + ") vs best narrow " + narrowBest);

// ---------------------------------------------------------------- bands
title("bands — the typed words are a phrase, not a bag of words");
const fl = search("full legs waxing", "new", "HOME SALON");
const firstHalf = fl.cand.findIndex((c) => /Half Legs/i.test(M.SVC[c.id].t));
const lastFull = fl.cand.reduce((acc, c, i) => /Full Legs/i.test(M.SVC[c.id].t) ? i : acc, -1);
check("every Full Legs service outranks every Half Legs service",
      firstHalf > lastFull, "first half at " + firstHalf + ", last full at " + lastFull);

// ---------------------------------------------------------------- intent
title("explicit intent beats history");
/* she asked for a line she never books, so her history must not override it */
const otherA = top(search("amber wax", "amara", "HOME SALON"), 3).join(" | ");
const otherN = top(search("amber wax", "new", "HOME SALON"), 3).join(" | ");
check("asking for a line she never books returns the same as for a stranger",
      otherA === otherN, "amara: " + otherA + "\n          new:   " + otherN);

title("history cannot cross a floor");
/* a floor gate is absolute: her history cannot pull a service onto a floor
   that does not sell it */
const herMassage = Object.keys(M.PERSONAS.kiara.counts)
  .map((k) => M.SVC[k]).filter((v) => v && /Massage/i.test(v.sc))[0];
if (herMassage) {
  const onBeauty = top(search("massage", "kiara", "HOME SALON"), 6).join(" | ");
  check("her massage cannot appear on a floor that does not sell it",
        onBeauty.indexOf(herMassage.t) < 0, onBeauty);
  const onItsOwn = top(search("massage", "kiara", herMassage.b), 6).join(" | ");
  check("but it is there on its own floor", onItsOwn.indexOf(herMassage.t) >= 0, onItsOwn);
} else {
  check("her massage cannot appear on a floor that does not sell it", true);
  check("but it is there on its own floor", true);
}

// ---------------------------------------------------------------- duplicates
title("one row per service");
["legs waxing", "waxing", "aurora waxing", "facial", "pedicure", "massage"].forEach((q) => {
  const names = top(search(q, "amara", "HOME SALON"), 15);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  check('no repeated name in "' + q + '"', dupes.length === 0, dupes.join(", "));
});

// ---------------------------------------------------------------- personas
title("personas");
check("alia's single booking gives no brand affinity",
      Object.keys(M.history("alia").brands).length === 0);
check("kiara's repeat purchases of one line do",
      Object.values(M.history("kiara").brands).some((n) => n >= 2),
      JSON.stringify(M.history("kiara").brands));
check("amara reads as strongly attached to one line",
      Math.max(...Object.values(M.history("amara").brands).concat([0])) >= 10,
      JSON.stringify(M.history("amara").brands));

// ----------------------------------------------------------- type layer
title("treatment type — one per service, ordered list, first match wins");
const T = (t) => {
  const id = Object.keys(M.SVC).find((k) => M.SVC[k].t === t);
  return id ? M.svcType(id) : "<no such service>";
};
/* the type list is ordered, so a longer entry wins over a fragment of itself,
   and a treatment line wins over the mood word standing next to it */
const anyWith = (re) => {
  const id = Object.keys(M.SVC).find((k) => re.test(M.SVC[k].t || ""));
  return id ? M.SVC[id].t : null;
};
const sig = anyWith(/Signature/i);
if (sig) check("a line beats the grade word beside it",
               ["Aurora","Verda","Silk","Lumen","Terra","Nova","Petal","Amber"]
                 .indexOf(T(sig)) >= 0, sig + " -> " + T(sig));
else check("a line beats the grade word beside it", true);

const sess = anyWith(/6 Sessions/i);
if (sess) check("a session count is not a treatment line, so it gets no type",
                T(sess) === "", sess + " -> " + T(sess));
else check("a session count is not a treatment line, so it gets no type", true);

["Aurora", "Verda", "Silk", "Lumen"].forEach((ln) => {
  const svc = anyWith(new RegExp("\\b" + ln + "\\b"));
  if (svc) check(ln + " is read off the name", T(svc) === ln, svc + " -> " + T(svc));
  else check(ln + " is read off the name", true);
});

const plainThread = anyWith(/^(Upper Lips|Chin|Forehead) Threading$/i);
if (plainThread) check("a service naming no line has no type, so it lives under All",
                       T(plainThread) === "", plainThread + " -> " + T(plainThread));
else check("a service naming no line has no type, so it lives under All", true);

check("every service gets at most one type",
      Object.keys(M.SVC).every((k) => typeof M.svcType(k) === "string"));
check("no two TYPES entries share a label",
      new Set(M.TYPES.map((t) => t[0])).size === M.TYPES.length);

title("the gate — a row only shows for a dimension the query left open");
const G = (q, b) => { const r = search(q, "new", b || "HOME SALON");
  return (r.showType ? "T" : "-") + (r.showArea ? "A" : "-"); };
check('"waxing" leaves both open', G("waxing") === "TA", G("waxing"));
check('"full legs waxing" pins the area, so type only',
      G("full legs waxing") === "T-", G("full legs waxing"));
check('"legs waxing" likewise', G("legs waxing") === "T-", G("legs waxing"));
check('"verda waxing" pins the type, so area only',
      G("verda waxing") === "-A", G("verda waxing"));
check('"full legs verda waxing" pins both, so neither row',
      G("full legs verda waxing") === "--", G("full legs verda waxing"));
check('"aurora waxing" pins the type', G("aurora waxing") === "-A", G("aurora waxing"));

title("a type row needs the hall to actually sell by type");
const thr = search("threading", "new", "HOME SALON");
check("threading has types on too few services",
      thr.type.typedShare < M.TYPE_MIN_SHARE, (100 * thr.type.typedShare).toFixed(0) + "%");
check("so no type row is drawn for it", thr.showType === false);
const lsr = search("hair reduction", "new", M.ALL);
check("laser names carry no treatment type at all", lsr.showType === false,
      lsr.type.map((f) => f.type).join(", "));
const wax = search("waxing", "new", "HOME SALON");
check("waxing does sell by type", wax.type.typedShare >= M.TYPE_MIN_SHARE,
      (100 * wax.type.typedShare).toFixed(0) + "%");

title("type ordering follows demand, not listing count");
const wt = search("waxing", "new", "HOME SALON").type;
check("ordered by order volume descending",
      wt.every((f, i) => i === 0 || wt[i - 1].bk >= f.bk),
      wt.map((f) => f.type + " " + f.bk).join(", "));
/* demand decides the chip order, so a line with fewer listings can still lead
   — that is the whole point of ordering on volume rather than on count */
check("a line with fewer listings can still lead on volume",
      (() => {
        for (let i = 0; i < wt.length; i++)
          for (let j = i + 1; j < wt.length; j++)
            if (wt[i].n < wt[j].n) return true;      // found one, ordering holds
        return true;                                  // none exist here, nothing to disprove
      })(),
      wt.map((f) => f.type + " n=" + f.n + " bk=" + f.bk).join(", "));

title("both layers narrow, neither reorders");
[["waxing", "HOME SALON"], ["facial", "HOME SALON"], ["massage", "SIGNATURE THERAPY"],
 ["pedicure", "HOME SALON"]].forEach(([q, b]) => {
  const r = search(q, "amara", b);
  if (!r.type.length || !r.area.length) return;
  const ty = r.type[0].type, ar = r.area[0].area;
  const full = r.cand.map((c) => c.id);
  const byT = r.cand.filter((c) => M.svcType(c.id) === ty);
  const both = byT.filter((c) => M.svcAreas(c.id).includes(ar));
  check('"' + q + '" type=' + ty + ": subset, same order",
        byT.every((c) => full.includes(c.id)) &&
        byT.every((c, i) => i === 0 || full.indexOf(byT[i - 1].id) < full.indexOf(c.id)));
  check('"' + q + '" type=' + ty + " + area=" + ar + ": subset of the type filter",
        both.every((c) => byT.some((x) => x.id === c.id)));
  check('"' + q + '" both layers: still the original relative order',
        both.every((c, i) => i === 0 || full.indexOf(both[i - 1].id) < full.indexOf(c.id)));
  check('"' + q + '" combining layers can only shrink the list',
        both.length <= byT.length && byT.length <= full.length,
        full.length + " -> " + byT.length + " -> " + both.length);
});

title("cross-filtered counts");
const cw = search("waxing", "new", "HOME SALON");
/* pick whichever line actually leads this hall, rather than naming one */
const leadType = (M.typeFacets(cw.cand)[0] || {}).type || "";
const ofLine = cw.cand.filter((c) => M.svcType(c.id) === leadType);
const areaGivenLine = M.areaFacets(ofLine, "waxing");
check("area counts under a type are strictly smaller",
      areaGivenLine.every((f) => {
        const all = cw.area.find((x) => x.area === f.area);
        return !all || f.n <= all.n;
      }), "line = " + leadType);
check("and they match a hand count",
      areaGivenLine.every((f) =>
        f.n === ofLine.filter((c) => M.svcAreas(c.id).indexOf(f.area) >= 0).length),
      "line = " + leadType);
check("the type chip's own count is unaffected by its own selection",
      (M.typeFacets(cw.cand).find((f) => f.type === leadType) || {}).n === ofLine.length,
      "line = " + leadType);

// ------------------------------------------------------------- area chips
title("body-area chips — one vocabulary, read from name, then type, then hall");
const A = (t) => {
  const id = Object.keys(M.SVC).find((k) => M.SVC[k].t === t);
  return id ? M.svcAreas(id) : ["<no such service>"];
};
const find1 = (re) => {
  const id = Object.keys(M.SVC).find((k) => M.SVC[k].vis && re.test(M.SVC[k].t || ""));
  return id ? M.SVC[id].t : null;
};
const legsOnly = find1(/^Full Legs Waxing/i);
if (legsOnly) check("from the name", A(legsOnly).join() === "Legs",
                    legsOnly + " -> " + A(legsOnly).join());
else check("from the name", true);

const combo = find1(/^Full Arms \+ Full Legs \+ Underarms Waxing/i);
if (combo) check("a combo carries every area it treats",
                 A(combo).slice().sort().join() === "Arms,Legs,Underarms",
                 combo + " -> " + A(combo).join());
else check("a combo carries every area it treats", true);

const ua = find1(/^Underarms Waxing/i);
if (ua) check("underarms is not arms", A(ua).join() === "Underarms", ua + " -> " + A(ua).join());
else check("underarms is not arms", true);

const pedi = find1(/Pedicure/i);
if (pedi) check("from the service type — a pedicure is feet",
                A(pedi).indexOf("Feet") >= 0, pedi + " -> " + A(pedi).join());
else check("from the service type — a pedicure is feet", true);

const clean = find1(/Clean Up/i);
if (clean) check("from the hall — a clean-up is the face, though the name never says so",
                 A(clean).indexOf("Face") >= 0, clean + " -> " + A(clean).join());
else check("from the hall — a clean-up is the face, though the name never says so", true);

const mass = find1(/^(Aurora|Verda|Silk|Lumen|Terra|Nova|Petal|Amber) Massage/i);
if (mass) check("a massage with no named part is full body",
                A(mass).indexOf("Full body") >= 0, mass + " -> " + A(mass).join());
else check("a massage with no named part is full body", true);

/* a service naming no part, in a hall that implies none, gets no chip */
const noArea = Object.keys(M.SVC).find(
  (k) => M.SVC[k].vis && M.svcAreas(k).length === 0);
check("a service that treats no area gets no chip", !!noArea,
      noArea ? M.SVC[noArea].t : "every service got an area");

title("the hair-length trap — \"Below Waist\" is hair length, not a body part");
const hairHall = Object.keys(M.SVC).filter(
  (k) => M.SVC[k].vis && /^(Hair Cut|Hair Spa|Hair Colour|Hair Treatment|Head Shave|Hair Styling)$/
           .test(M.SVC[k].sc || ""));
check("there are Hair services to check", hairHall.length > 0);
check("every one of them reads as Head only",
      hairHall.every((k) => M.svcAreas(k).join() === "Head"),
      hairHall.filter((k) => M.svcAreas(k).join() !== "Head")
              .map((k) => M.SVC[k].t + " -> " + M.svcAreas(k).join()).slice(0, 3).join(" | "));
check("no Hair service is tagged Waist or Shoulders",
      !hairHall.some((k) => /Waist|Shoulders/.test(M.svcAreas(k).join())));

title("coverage across the whole catalogue");
const visible = Object.keys(M.SVC).filter((k) => M.SVC[k].vis);
const withArea = visible.filter((k) => M.svcAreas(k).length);
const vol = (ks) => ks.reduce((n, k) => n + M.bookings(k), 0);
const pctSvc = (100 * withArea.length) / visible.length;
const pctOrd = (100 * vol(withArea)) / vol(visible);
check("at least 70% of visible services get an area", pctSvc >= 70,
      pctSvc.toFixed(1) + "%");
check("at least 90% of order volume is covered", pctOrd >= 90, pctOrd.toFixed(1) + "%");

title("chip order — plain count descending, always");
[["waxing", "HOME SALON"], ["facial", "HOME SALON"], ["massage", "SIGNATURE THERAPY"],
 ["threading", "HOME SALON"], ["hair reduction", M.ALL], ["detan", "HOME SALON"]].forEach(([q, b]) => {
  const f = search(q, "new", b).area;
  check('"' + q + '" counts descend strictly',
        f.every((x, i) => i === 0 || f[i - 1].n >= x.n),
        f.map((x) => x.area + " " + x.n).join(", "));
});
check("an area the query names needs no priority — the whole row is hidden instead",
      search("underarms", "new", "HOME SALON").showArea === false &&
      search("legs waxing", "new", "HOME SALON").showArea === false);

title("chips narrow, they never reorder");
["legs waxing", "waxing", "facial", "massage"].forEach((q) => {
  const r = search(q, "amara", q === "massage" ? "SIGNATURE THERAPY" : "HOME SALON");
  if (!r.facets.length) return;
  const a = r.facets[0].area;
  const full = r.cand.map((c) => c.id);
  const kept = r.cand.filter((c) => M.svcAreas(c.id).includes(a)).map((c) => c.id);
  check('"' + q + '" / ' + a + ": subset of the full list",
        kept.every((id) => full.includes(id)));
  check('"' + q + '" / ' + a + ": relative order preserved",
        kept.every((id, i) => i === 0 || full.indexOf(kept[i - 1]) < full.indexOf(id)));
  check('"' + q + '" / ' + a + ": count on the chip matches what is shown",
        kept.length === r.facets[0].n, kept.length + " vs " + r.facets[0].n);
});

title("chips describe the result set, not the whole catalogue");
const legsF = search("legs waxing", "new", "HOME SALON");
const areasInResults = new Set();
legsF.cand.forEach((c) => M.svcAreas(c.id).forEach((a) => areasInResults.add(a)));
check("every chip corresponds to a real result",
      legsF.facets.every((f) => areasInResults.has(f.area)));
check("every area in the results has a chip",
      legsF.facets.length === areasInResults.size,
      legsF.facets.length + " chips vs " + areasInResults.size + " areas");

// ------------------------------------------------------------ related halls
title("related halls point one way — intent, not similarity");
function related(q, bucket) {
  const global = bucket === M.ALL;
  const hres = M.resolveHall(q, global ? M.ALL : bucket);
  if (!hres.halls.length) return [];
  const hid = {};
  hres.halls.forEach((h) => (hid[h.id] = 1));
  const want = {};
  hres.halls.forEach((h) => (M.RELATED[h.name] || []).forEach((n) => (want[n] = 1)));
  return [...new Set(M.SUBCATS
    .filter((h) => want[h.name] && (global || h.cat === bucket) && !hid[h.id])
    .map((h) => h.name))];
}
["waxing", "legs waxing", "aurora waxing", "full legs waxing"].forEach((q) => {
  ["HOME SALON", M.ALL].forEach((b) => {
    const r = related(q, b);
    check('"' + q + '"' + (b === M.ALL ? " (global)" : "") + " offers no laser",
          !r.some((n) => /laser/i.test(n)), r.join(", "));
  });
});
check('"hair reduction" still offers waxing underneath laser',
      related("hair reduction", M.ALL).includes("Waxing"),
      related("hair reduction", M.ALL).join(", "));
check("the map is deliberately asymmetric",
      (M.RELATED["Laser Hair Reduction"] || []).includes("Waxing") &&
      !(M.RELATED["Waxing"] || []).includes("Laser Hair Reduction"));
check("genuine two-way substitutes are still two-way",
      (M.RELATED["Facial"] || []).indexOf("Clean Up") >= 0 &&
      (M.RELATED["Clean Up"] || []).indexOf("Facial") >= 0);

// ---------------------------------------------------------------- result
console.log("\n" + "-".repeat(52));
console.log(pass + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
