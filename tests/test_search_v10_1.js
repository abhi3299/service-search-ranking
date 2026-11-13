#!/usr/bin/env node
/**
 * Tests the v10.1 prototype — spelling correction.
 *
 *     node tests/test_search_v10_1.js
 *
 * v10.1 is v10 plus one stage: unknown query words are corrected against the
 * catalogue's own vocabulary before retrieval runs. So there are two things to
 * prove. First, that a misspelling now lands where the correct spelling lands.
 * Second — the one that actually matters — that nothing else moved: the full
 * v10 suite is re-run against this build separately, via
 *
 *     SEARCH_HTML=prototype/search_v10_1.html node tests/test_search.js
 *
 * As elsewhere, the logic is lifted out of the shipped HTML rather than copied.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HTML = path.join(ROOT, "prototype", "search_v10_1.html");

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

// ST is declared after the cut; correctQuery reads ST.spell, so stub it.
const M = new Function("D", "var ST={spell:true};" + logic + `
  return {toks,stem,dedupKey,bookings,history,lexHits,semHits,classify,band,resolveHall,
          correctQuery,correctToken,editDist,isKnown,isPrefix,maxEdits,
          svcType,svcAreas,SVC,SUBCATS,ALL};`)(D);

const tier = (n) => Math.floor(Math.log10((n || 0) + 1));
const hv = (c) => (c.brand && c.bk >= 20 ? 1 : 0);

function search(rawq, seg, bucket) {
  const sp = M.correctQuery(rawq), q = sp.q;
  const all = Object.keys(M.SVC), global = bucket === M.ALL;
  const floor = (global ? all : all.filter((k) => M.SVC[k].b === bucket))
                  .filter((k) => M.SVC[k].vis);
  const hres = M.resolveHall(q, global ? M.ALL : bucket), hid = {};
  hres.halls.forEach((h) => (hid[h.id] = 1));
  const pool = hres.halls.length ? floor.filter((k) => hid[M.SVC[k].sid]) : floor;
  const H = M.history(seg), lex = M.lexHits(q, pool), sem = M.semHits(q, pool);
  const cls = M.classify(q, pool), qt = M.toks(q), sa = cls.spec.length > 0;
  const scope = (k) => {
    if (!sa) return 0;
    const s = {}; let n = 0;
    M.toks(M.SVC[k].t || "").forEach((w) => {
      if (s[w]) return; s[w] = 1;
      if (!qt.some((t) => M.stem(t, w))) n++;
    });
    return n <= 2 ? 0 : n <= 4 ? 1 : 2;
  };
  const seen = {};
  Object.keys(lex).forEach((k) => (seen[k] = 1));
  Object.keys(sem).forEach((k) => (seen[k] = 1));
  let cand = [];
  Object.keys(seen).forEach((k) => {
    const b = M.band(k, cls, lex, sem); if (!b) return;
    let brand = 0;
    Object.keys(H.brands).forEach((x) => {
      if ((M.SVC[k].t || "").toLowerCase().indexOf(x) >= 0) brand = 1;
    });
    cand.push({ id: k, band: b, scope: scope(k), mine: H.counts[k] || 0,
                brand, bk: M.bookings(k) });
  });
  cand.sort((a, b) => a.band - b.band || a.scope - b.scope || b.mine - a.mine ||
    hv(b) - hv(a) || tier(b.bk) - tier(a.bk) || b.brand - a.brand ||
    b.bk - a.bk || (a.id < b.id ? -1 : 1));
  const kept = [], bn = {};
  cand.forEach((c) => { const d = M.dedupKey(M.SVC[c.id].t);
                        if (!bn[d]) { bn[d] = 1; kept.push(c); } });
  return { cand: kept, fixes: sp.fixes, q,
           hall: [...new Set(hres.halls.map((h) => h.name))].join(",") };
}

let pass = 0, failed = 0;
const title = (t) => console.log("\n" + t);
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}
function fail(msg) { console.error("fatal: " + msg); process.exit(1); }
const top = (r, n) => r.cand.slice(0, n).map((c) => M.SVC[c.id].t);

// ----------------------------------------------------------- the corrector
title("edit distance — transposition counts as one mistake, not two");
check("substitution", M.editDist("fadial", "facial", 2) === 1);
check("deletion", M.editDist("waxig", "waxing", 2) === 1);
check("insertion", M.editDist("waxinng", "waxing", 2) === 1);
check("transposition", M.editDist("faical", "facial", 2) === 1,
      String(M.editDist("faical", "facial", 2)));
check("it bails out past the cap", M.editDist("waxing", "pedicure", 2) > 2);

title("what gets corrected, and what is left alone");
const fix = (q) => M.correctQuery(q).q;
[["waz", "wax"], ["fadial", "facial"], ["aurroa", "aurora"], ["waxinng", "waxing"],
 ["facail", "facial"], ["massge", "massage"], ["threding", "threading"],
 ["bikni", "bikini"], ["lumne", "lumen"], ["reducton", "reduction"]].forEach(([bad, good]) => {
  check('"' + bad + '" becomes "' + good + '"', fix(bad) === good, fix(bad));
});
["waxing", "facial", "aurora", "verda", "legs", "arms", "bikini", "massage",
 "pedicure", "threading"].forEach((w) => {
  check('a real word is never "corrected" — ' + w, fix(w) === w, fix(w));
});
["wa", "fac", "wax", "kor", "pedicur", "manicur", "wax"].forEach((w) => {
  check('a word still being typed is left alone — ' + w, fix(w) === w, fix(w));
});
check("a one-letter query is left alone", fix("w") === "w");
check("gibberish with no near neighbour is left alone",
      fix("qqzzxw") === "qqzzxw", fix("qqzzxw"));
check("multiple mistakes in one query are all fixed",
      fix("aurroa fadial") === "aurora facial", fix("aurroa fadial"));
check("a correct word beside a wrong one survives untouched",
      fix("aurora waxig") === "aurora waxing", fix("aurora waxig"));

title("ties break on how common the word is");
check('"waz" prefers wax over any other one-edit neighbour',
      M.correctToken("waz") === "wax", M.correctToken("waz"));

title("how wrong a word may be scales with its length");
check("short words get one edit only", M.maxEdits("wax") === 1 && M.maxEdits("legs") === 1);
check("long words get two", M.maxEdits("reduction") === 2);

// ------------------------------------------------------ end-to-end results
title("a misspelling lands exactly where the correct spelling lands");
[["waz", "wax"], ["fadial", "facial"], ["aurroa fadial", "aurora facial"],
 ["leg waz", "leg wax"], ["bikni wax", "bikini wax"],
 ["hair reducton", "hair reduction"], ["lumne massage", "lumen massage"],
 ["waxinng", "waxing"], ["threding", "threading"]].forEach(([bad, good]) => {
  ["new", "amara"].forEach((seg) => {
    const a = search(bad, seg, M.ALL), b = search(good, seg, M.ALL);
    check('"' + bad + '" / ' + seg + " matches \"" + good + "\"",
          top(a, 5).join(" | ") === top(b, 5).join(" | ") &&
          a.cand.length === b.cand.length,
          top(a, 3).join(" | ") + "\n          vs " + top(b, 3).join(" | "));
  });
});

title("the lift commits on the corrected word");
check('"waz" reaches the Waxing hall', search("waz", "new", M.ALL).hall === "Waxing",
      search("waz", "new", M.ALL).hall);
check('"fadial" reaches the Facial hall', search("fadial", "new", M.ALL).hall === "Facial",
      search("fadial", "new", M.ALL).hall);
check('"hair reducton" reaches Laser Hair Reduction',
      search("hair reducton", "new", M.ALL).hall === "Laser Hair Reduction",
      search("hair reducton", "new", M.ALL).hall);

title("a misspelled query is never empty when the correct one is not");
["waz", "fadial", "aurroa fadial", "waxinng", "bikni", "massge", "pedicur",
 "threding", "manicur", "facail"].forEach((q) => {
  const r = search(q, "new", M.ALL);
  check('"' + q + '" returns results', r.cand.length > 0, r.cand.length + " results");
});

title("the correction is reported, not applied silently");
const rep = M.correctQuery("aurroa fadial");
check("both fixes are listed", rep.fixes.length === 2, JSON.stringify(rep.fixes));
check("each fix records what was typed and what it became",
      rep.fixes[0][0] === "aurroa" && rep.fixes[0][1] === "aurora",
      JSON.stringify(rep.fixes[0]));
check("a clean query reports no fixes",
      M.correctQuery("aurora facial").fixes.length === 0);

console.log("\n" + "-".repeat(52));
console.log(pass + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
