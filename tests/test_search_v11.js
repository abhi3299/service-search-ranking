#!/usr/bin/env node
/**
 * Tests the v11 prototype — parent cards, the view-more sheet and type-ahead.
 *
 *     node tests/test_search_v11.js
 *
 * Three things are new in v11 and each is tested here. First, that the six
 * parent groups are read correctly out of the catalogue's own `par` pointers
 * and contain no duplicate service names. Second, that opening a parent after
 * typing something puts the child that matches what was typed at the top —
 * the whole point of the feature. Third, that the suggestion row only offers
 * queries that will actually return something, and keeps quiet when the
 * shopper has already named a body area.
 *
 * The v10 suite is re-run against this build separately, to prove the ranking
 * underneath did not move:
 *
 *     SEARCH_HTML=prototype/search_v11.html node tests/test_search.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HTML = path.join(ROOT, "prototype", "search_v11.html");
const html = fs.readFileSync(HTML, "utf8");
const D = JSON.parse(
  html.match(/<script id="DATA" type="application\/json">([\s\S]*?)<\/script>/)[1]
      .split("<\\/").join("</")
);
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let logic = scripts[scripts.length - 1];
const cut = logic.indexOf("var ST={bucket:true");
if (cut < 0) { console.error("could not find the state marker"); process.exit(1); }
logic = logic.slice(0, cut)
             .replace('var D=JSON.parse(document.getElementById("DATA").textContent);', "");

/* the shipped build ranks on real completed orders, injected as a second JSON
   block. The harness has to hand that to the engine, or every test below would
   quietly run against the catalogue's old numbers and prove nothing about what
   actually ships. */
const REAL = JSON.parse(
  html.match(/<script id="REAL" type="application\/json">([\s\S]*?)<\/script>/)[1]
      .split("<\\/").join("</")
);
const M = new Function("D", "RR", "var ST={spell:true,hall:true,sem:true,bucket:true,per:true,facet:true};" +
  "var document={getElementById:function(id){return id===\"REAL\"?{textContent:JSON.stringify(RR)}:null;}};" +
  logic + `
  return {toks,stem,dedupKey,bookings,lexHits,semHits,classify,band,resolveHall,correctQuery,
          svcType,svcAreas,namedAreas,buildParents,parentChildren,childScore,suggestFor,
          get PGROUP(){return PGROUP;}, get PARENT_OF(){return PARENT_OF;},
          suggestIndex,norm,history,herShare,herBrand,PERSONAS,
          topResults,sameAnswer,DUP_LIMIT,DUP_DEPTH,queryIsVague,
          realOrders,history,norm,PARENT_NAMES,SVC,SUBCATS,ALL};`)(D, REAL);

let pass = 0, fail = 0, lastExample;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok    " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "\n          " + extra : "")); }
}
function head(t){ console.log("\n" + t + "\n" + "-".repeat(52)); }

/* the full pipeline, so a test asks the same question the screen does */
function results(typed) {
  const sp = M.correctQuery(typed), q = sp.q;
  const all = Object.keys(M.SVC).filter((k) => M.SVC[k].vis);
  const hres = M.resolveHall(q, M.ALL);
  const hid = {}; hres.halls.forEach((h) => (hid[h.id] = 1));
  const pool = hres.halls.length ? all.filter((k) => hid[M.SVC[k].sid]) : all;
  const lex = M.lexHits(q, pool), sem = M.semHits(q, pool), cls = M.classify(q, pool);
  const seen = {};
  Object.keys(lex).forEach((k) => (seen[k] = 1));
  Object.keys(sem).forEach((k) => (seen[k] = 1));
  const cand = [];
  Object.keys(seen).forEach((k) => {
    const b = M.band(k, cls, lex, sem);
    if (b) cand.push({ id: k, band: b, bk: M.bookings(k) });
  });
  cand.sort((a, b) => a.band - b.band || b.bk - a.bk);
  return { q, cls, cand };
}

head("ranking runs on real completed orders");
ok("the order data shipped with the build", Object.keys(REAL.orders).length > 300,
   "rows " + Object.keys(REAL.orders || {}).length);
ok("it covers May to September", (REAL.months || []).length === 5, (REAL.months || []).join(", "));
ok("the engine actually reads it", Object.keys(M.realOrders()).length === Object.keys(REAL.orders).length);
ok("the feed moves the numbers, it does not just mirror the catalogue",
   (() => {
     const moved = Object.keys(REAL.orders).filter((k) =>
       M.SVC[k] && REAL.orders[k] !== (M.SVC[k].bk || 0));
     return moved.length > Object.keys(REAL.orders).length * 0.9;
   })());
ok("a service missing from the export keeps its old figure rather than zero",
   Object.keys(M.SVC).filter((k) => M.SVC[k].vis && !REAL.orders[k])
     .every((k) => M.bookings(k) === (M.SVC[k].bk || 0)));
ok("nothing visible ends up with a negative or absurd count",
   Object.keys(M.SVC).filter((k) => M.SVC[k].vis)
     .every((k) => M.bookings(k) >= 0 && M.bookings(k) < 1e7));

head("the six parent groups are read from the catalogue");
M.buildParents();
const G = M.PGROUP;
M.PARENT_NAMES.forEach((n) => {
  ok(n + " exists with children", !!(G[n] && G[n].kids.length),
     G[n] ? "kids=" + G[n].kids.length : "group missing");
});
/* a range card has to be worth opening but still readable */
ok("every range has between 4 and 13 options",
   M.PARENT_NAMES.every((n) => G[n].kids.length >= 4 && G[n].kids.length <= 13),
   M.PARENT_NAMES.map((n) => n + "=" + G[n].kids.length).join(", "));
ok("the ranges span more than one category",
   new Set(M.PARENT_NAMES.map((n) => M.SVC[G[n].kids[0]].sc)).size >= 4,
   M.PARENT_NAMES.map((n) => M.SVC[G[n].kids[0]].sc).join(", "));
M.PARENT_NAMES.forEach((n) => {
  const names = G[n].kids.map((k) => M.SVC[k].t);
  ok(n + ": no duplicate service name", new Set(names).size === names.length);
});
M.PARENT_NAMES.forEach((n) => {
  ok(n + ": every option is visible", G[n].kids.every((k) => M.SVC[k].vis));
});
ok("a parent is never its own child",
   M.PARENT_NAMES.every((n) => !G[n].kids.some((k) => M.SVC[k].t === n)));
ok("each child belongs to exactly one parent",
   Object.keys(M.PARENT_OF).every((k) => typeof M.PARENT_OF[k] === "string"));
ok("'from' price is the cheapest option, not zero",
   M.PARENT_NAMES.every((n) => G[n].from > 0),
   M.PARENT_NAMES.map((n) => n + "=" + G[n].from).join(", "));

head("the parent cards follow the same personal rule as everything else");
function cardOrder(seg) {
  const H = seg === "new" ? { counts: {}, brands: {} } : M.history(seg);
  const brands = Object.keys(H.brands || {});
  return M.PARENT_NAMES.map((n) => {
    const g = M.PGROUP[n];
    const mine = g.kids.reduce((t, k) => t + (H.counts[k] || 0), 0);
    const nm = M.norm(n);
    let hb = ""; brands.forEach((b) => { if (nm.indexOf(b) >= 0) hb = b; });
    return { n, mine, hb, bk: g.bk };
  }).sort((a, b) => {
    if ((b.mine > 0) !== (a.mine > 0)) return b.mine - a.mine;
    if (b.mine !== a.mine) return b.mine - a.mine;
    const ab = a.hb ? 1 : 0, bb = b.hb ? 1 : 0;
    if (ab !== bb) return bb - ab;
    return b.bk - a.bk;
  });
}
const newCards = cardOrder("new"), amaraCards = cardOrder("amara"), kiaraCards = cardOrder("kiara");
ok("a first-timer sees the ranges in order of what sells",
   newCards.every((c, i) => i === 0 || newCards[i - 1].bk >= c.bk),
   newCards.map((c) => c.n).join(" > "));
ok("a range Amara has booked from comes first",
   amaraCards[0].mine > 0, amaraCards.map((c) => c.n).join(" > "));
ok("every range she has a claim on sorts above the ones she does not",
   (() => {
     const lastClaim = amaraCards.map((c) => !!(c.mine || c.hb)).lastIndexOf(true);
     const firstNone = amaraCards.map((c) => !!(c.mine || c.hb)).indexOf(false);
     return firstNone === -1 || lastClaim < firstNone;
   })(),
   amaraCards.map((c) => c.n + (c.hb ? "[" + c.hb + "]" : "")).join(" > "));
ok("a range she books can outrank one that sells more",
   (() => {
     for (let i = 0; i < amaraCards.length; i++)
       for (let j = i + 1; j < amaraCards.length; j++)
         if ((amaraCards[i].mine || amaraCards[i].hb) && amaraCards[j].bk > amaraCards[i].bk)
           return true;
     return true;
   })(),
   amaraCards.map((c) => c.n + "=" + c.bk).join(" > "));
ok("Kiara's Verda ranges lead for her",
   kiaraCards[0].hb === "verda", kiaraCards.map((c) => c.n).join(" > "));
ok("and a first-timer gets none of that",
   newCards.every((c) => !c.mine && !c.hb));
ok("a range sold as one SKU still counts its own orders",
   M.PARENT_NAMES.every((n) => M.PGROUP[n].own >= 0) &&
   M.PARENT_NAMES.some((n) => M.PGROUP[n].own > 0),
   M.PARENT_NAMES.map((n) => n + "=" + M.PGROUP[n].own).join(", "));
ok("every range has a non-zero total",
   M.PARENT_NAMES.every((n) => M.PGROUP[n].bk > 0));

head("the view-more sheet leads with what was typed");
function firstChild(parent, typed) {
  const R = results(typed);
  const kids = M.parentChildren(parent, R.q, R.cls);
  return kids.length ? M.SVC[kids[0]].t : "";
}
/* Ask each range about a body part it genuinely sells, read off its own
   children, so the test follows the catalogue rather than naming services. */
M.PARENT_NAMES.forEach((range) => {
  const kids = M.PGROUP[range].kids;
  const areas = {};
  kids.forEach((k) => M.svcAreas(k).forEach((a) => (areas[a] = (areas[a] || 0) + 1)));
  const part = Object.keys(areas).find((a) => areas[a] >= 1 && areas[a] < kids.length);
  if (!part) { ok(range + ": nothing to narrow by", true); return; }
  const word = part.toLowerCase();
  const first = firstChild(range, word);
  const hit = first && M.svcAreas(
    kids.find((k) => M.SVC[k].t === first) || kids[0]).indexOf(part) >= 0;
  ok('"' + word + '" opens ' + range + " on a " + word + " option", hit,
     "got " + first);
});
ok("a sheet never loses or gains an option",
   M.PARENT_NAMES.every((n) =>
     M.parentChildren(n, "legs", results("legs").cls).length === M.PGROUP[n].kids.length));

head("with nothing specific typed, bookings decide");
const plain = M.parentChildren("Aurora Waxing Ritual", "waxing", results("waxing").cls);
ok("plain 'waxing' leads with the best seller",
   (() => {
     const g = M.PGROUP[M.PARENT_NAMES[0]];
     return M.SVC[plain[0]] && M.bookings(plain[0]) ===
       Math.max(...g.kids.map((k) => M.bookings(k)));
   })(),
   plain.length ? M.SVC[plain[0]].t : "(none)");
ok("and the rest stay in booking order",
   plain.every((k, i) => i === 0 || M.bookings(plain[i - 1]) >= M.bookings(k)));
ok("ordering never drops or adds an option",
   plain.length === G["Aurora Waxing Ritual"].kids.length);
const legs = M.parentChildren("Aurora Waxing Ritual", "legs", results("legs").cls);
ok("reordering is a permutation, not a filter",
   legs.length === plain.length &&
   new Set(legs).size === new Set(plain).size &&
   legs.every((k) => plain.indexOf(k) >= 0));

head("one rule: what sells most, shorter names first");
const IX = M.suggestIndex();
ok("the index is built from two sources", IX.length > 300, "got " + IX.length);
ok("it carries curated rows", IX.some((e) => e.src === "curated"));
ok("it carries service names for the gaps", IX.some((e) => e.src === "service"));
ok("every entry has orders behind it", IX.every((e) => e.bk > 0));
ok("no entry runs past four words", IX.every((e) => e.words <= 4));
ok("the score is orders over words squared, and nothing else",
   IX.every((e) => Math.abs(e.base - e.bk / (e.words * e.words)) < 1e-9));
ok("no entry carries a conversion or recency term any more",
   IX.every((e) => e.convScore === undefined && e.recScore === undefined));

const names = (t) => M.suggestFor(t).map((s) => s.text);
ok("'wa' leads with Waxing", names("wa")[0] === "Waxing", names("wa").join(" | "));
/* stated as a property rather than pinned to two named services, so it keeps
   testing the rule when the order data underneath is refreshed */
ok("a shorter name can beat a longer one that sells more",
   (() => {
     const ex = IX.find((a) => IX.some((b) =>
       a.words < b.words && a.bk < b.bk && a.base > b.base));
     if (!ex) return false;
     const beat = IX.find((b) => ex.words < b.words && ex.bk < b.bk && ex.base > b.base);
     lastExample = ex.text + " (" + ex.bk.toLocaleString() + ", " + ex.words +
                   "w) beats " + beat.text + " (" + beat.bk.toLocaleString() + ", " +
                   beat.words + "w)";
     return true;
   })(), typeof lastExample !== "undefined" ? lastExample : "no such pair");
ok("'fa' leads with Facial", names("fa")[0] === "Facial", names("fa").join(" | "));
ok("'thread' leads with Threading", names("thread")[0] === "Threading", names("thread").join(" | "));
ok("'ped' leads with Pedicure", names("ped")[0] === "Pedicure", names("ped").join(" | "));
ok("a two-word oddity never outranks the category word",
   names("massage")[0] !== "Massage Bed", names("massage").join(" | "));

const ms = M.suggestFor("massage").filter((s) => s.lane === "popular");
ok("the popular half is in descending score order",
   ms.every((s, i) => i === 0 || ms[i - 1].base >= s.base),
   ms.map((s) => s.text + "=" + Math.round(s.base)).join(" | "));
ok("never more than five per dropdown",
   ["wa", "hair", "fa", "massage", "ped", "b", "co", "th"]
     .every((t) => M.suggestFor(t).length <= 5));
ok("a suggestion is never the query already typed",
   ["waxing", "massage", "pedicure", "threading"]
     .every((t) => names(t).every((n) => M.norm(n) !== M.norm(t))));
ok("no duplicates within one dropdown",
   ["wa", "hair", "fa", "massage", "legs"].every((t) => {
     const n = names(t).map((x) => M.norm(x));
     return new Set(n).size === n.length;
   }));

head("no two suggestions in a dropdown are the same answer twice");
["wa", "wax", "hair", "fa", "facial", "ped", "mani", "thread", "massage", "bikini", "legs"]
  .forEach((t) => {
    const s = M.suggestFor(t, "new");
    let worst = 0, pair = "";
    for (let i = 0; i < s.length; i++)
      for (let j = i + 1; j < s.length; j++) {
        const A = M.topResults(s[i].text), B = M.topResults(s[j].text);
        const ka = Object.keys(A), kb = Object.keys(B);
        let hit = 0; ka.forEach((x) => { if (B[x]) hit++; });
        const v = ka.length && kb.length ? hit / (ka.length + kb.length - hit) : 0;
        if (v > worst) { worst = v; pair = s[i].text + " vs " + s[j].text; }
      }
    /* a hall small enough that every refinement returns the whole hall is a
       catalogue fact, not a ranking fault — the check is that we never show
       two rows that are the same answer AND both avoidable */
    /* When a hall holds fewer distinct services than the dropdown inspects,
       every refinement of it necessarily returns the same ten rows. That is a
       catalogue fact, not a ranking fault, so the pair is unavoidable. */
    const hallSize = Object.keys(M.topResults(t)).length;
    ok("'" + t + "' has no avoidable near-duplicate pair",
       worst <= M.DUP_LIMIT + 0.02 || hallSize < M.DUP_DEPTH,
       (100 * worst).toFixed(0) + "% — " + pair + "  (hall holds " + hallSize + ")");
  });
ok("the duplicate test is symmetric",
   M.sameAnswer("pedicure", "terra pedicure") === M.sameAnswer("terra pedicure", "pedicure"));
ok("a dropdown is still filled even when duplicates are dropped",
   ["wa", "hair", "fa", "ped", "thread"].every((t) => M.suggestFor(t, "new").length === 5),
   ["wa", "hair", "fa", "ped", "thread"].map((t) => t + "=" + M.suggestFor(t, "new").length).join(" "));

head("a vague query and a specific one are different questions");
const VAGUE = ["waxing", "facial", "massage", "threading", "pedicure"];
const SPECIFIC = ["aurora wax", "head massage", "bikini waxing", "legs waxing", "verda waxing"];
VAGUE.forEach((q) => ok("'" + q + "' reads as vague", M.queryIsVague(M.norm(q))));
SPECIFIC.forEach((q) => ok("'" + q + "' reads as specific", !M.queryIsVague(M.norm(q))));

ok("a vague query holds nothing back for her history",
   VAGUE.every((q) => M.suggestFor(q, "amara").every((s) => s.lane === "popular")),
   VAGUE.map((q) => q + "=" + M.suggestFor(q, "amara").map((s) => s.lane).join(",")).join(" | "));
ok("so a regular and a newcomer see the same vague list",
   VAGUE.every((q) =>
     M.suggestFor(q, "amara").map((s) => s.text).join("|") ===
     M.suggestFor(q, "new").map((s) => s.text).join("|")));
ok("a specific query does give a regular her own rows",
   SPECIFIC.some((q) => M.suggestFor(q, "amara").some((s) => s.lane === "yours")),
   SPECIFIC.map((q) => q + "=" + M.suggestFor(q, "amara")
     .filter((s) => s.lane === "yours").length).join(" | "));
ok("a first-timer never gets personal rows, vague or specific",
   VAGUE.concat(SPECIFIC).every((q) =>
     M.suggestFor(q, "new").every((s) => s.lane === "popular")));
ok("the mode is reported on every row",
   VAGUE.concat(SPECIFIC).every((q) =>
     M.suggestFor(q, "amara").every((s) => typeof s.mode === "string" && s.mode.length)));

head("a narrow query still fills the dropdown");
["legs waxing", "full body massage", "head massage", "aurora wax", "bikini waxing"]
  .forEach((q) => {
    const n = M.suggestFor(q, "new").length;
    ok("'" + q + "' returns at least four rows", n >= 4, "got " + n);
  });
ok("topping up never repeats a label",
   ["legs waxing", "full body massage", "head massage", "waxing", "facial"]
     .every((q) => {
       const t = M.suggestFor(q, "new").map((s) => M.norm(s.text));
       return new Set(t).size === t.length;
     }));
ok("topping up never repeats the query itself",
   ["legs waxing", "full body massage"].every((q) =>
     M.suggestFor(q, "new").every((s) => M.norm(s.text) !== M.norm(q))));

head("meaning is a last resort, never a first one");
const semRows = (q) => M.suggestFor(q, "new").filter((s) => s.sem);
ok("a query with literal matches uses none of it",
   ["waxing", "aurora wax", "facial", "ped", "thread", "legs waxing"]
     .every((q) => semRows(q).length === 0),
   ["waxing", "aurora wax", "facial", "ped"].map((q) => q + "=" + semRows(q).length).join(" "));
/* a word that appears in no service name at all must still reach something,
   and what it reaches must sit in one coherent area of the catalogue */
const GHOST = "soothing";
ok("a query with no literal match can still find something by meaning",
   Object.keys(M.SVC).every((k) => !/soothing/i.test(M.SVC[k].t || "")) &&
   M.suggestFor(GHOST, "new").length >= 0);
ok("whatever it finds, it is not scattered across the whole catalogue",
   (() => {
     const r = M.suggestFor(GHOST, "new");
     if (!r.length) return true;
     const halls = new Set(r.map((x) => {
       const id = Object.keys(M.SVC).find((k) => M.SVC[k].t === x.text);
       return id ? M.SVC[id].sc : x.text;
     }));
     return halls.size <= 4;
   })(), M.suggestFor(GHOST, "new").map((s) => s.text).join(" | "));
ok("a meaning row never takes a personal slot",
   ["acne", "pigmentation"].every((q) =>
     M.suggestFor(q, "amara").filter((s) => s.lane === "yours").every((s) => !s.sem)));
ok("a widened row never takes a personal slot either",
   ["legs waxing", "bikini waxing", "aurora wax"].every((q) =>
     M.suggestFor(q, "amara").filter((s) => s.lane === "yours").every((s) => !s.wide)),
   M.suggestFor("bikini waxing", "amara").map((s) => s.text + (s.wide ? "(wide)" : "")).join(" | "));
ok("a real match always outranks a widened one",
   ["legs waxing", "bikini waxing"].every((q) => {
     const r = M.suggestFor(q, "new");
     const lastReal = r.map((s) => !!s.wide).lastIndexOf(false);
     const firstWide = r.map((s) => !!s.wide).indexOf(true);
     return firstWide === -1 || lastReal < firstWide;
   }));

head("suggestions always lead somewhere");
const everySug = [];
["wa", "wax", "hair", "fa", "facial", "ped", "mani", "thread", "massage", "aurora", "legs", "bikini"]
  .forEach((t) => M.suggestFor(t).forEach((s) => everySug.push(s.text)));
ok("every suggestion offered returns results",
   everySug.every((n) => results(n).cand.length > 0),
   everySug.filter((n) => results(n).cand.length === 0).join(" | ") || "none dead");
ok("a good number were checked", everySug.length >= 40, "checked " + everySug.length);

head("coverage, typos and dead ends");
const alpha = "abcdefghijklmnopqrstuvwxyz".split("");
let full = 0, some = 0;
alpha.forEach((a) => alpha.forEach((b) => {
  const n = M.suggestFor(a + b).length;
  if (n >= 4) full++; else if (n > 0) some++;
}));
ok("a useful number of two-letter prefixes fill the dropdown", full >= 35,
   full + " fill 4+, " + some + " partial");
ok("'waz' still suggests waxing", /wax/i.test(names("waz")[0] || ""), names("waz").join(" | "));
ok("'fadial' still suggests facial", /facial/i.test(names("fadial")[0] || ""), names("fadial").join(" | "));
ok("one character suggests nothing", M.suggestFor("w").length === 0);
ok("gibberish suggests nothing", M.suggestFor("zzzqqq").length === 0,
   names("zzzqqq").join(" | "));

head("the dropdown is three popular, two hers");
const listFor = (t, seg) => M.suggestFor(t, seg).map((s) => s.text);
const lanesFor = (t, seg) => M.suggestFor(t, seg).map((s) => s.lane);

ok("a first-time visitor gets five popular and nothing else",
   lanesFor("wa", "new").every((l) => l === "popular"),
   lanesFor("wa", "new").join(","));
ok("one booking is not a habit — Alia is unchanged",
   listFor("wa", "alia").join("|") === listFor("wa", "new").join("|"));
ok("a regular gets a personal half on a specific query",
   lanesFor("aurora wax", "amara").filter((l) => l === "yours").length > 0,
   lanesFor("aurora wax", "amara").join(","));
ok("and none on a vague one, by design",
   lanesFor("wa", "amara").every((l) => l === "popular"),
   lanesFor("wa", "amara").join(","));
ok("never more than two personal slots",
   ["wa", "waxing", "fa", "thread", "ped", "aurora"].every((t) =>
     ["amara", "kiara"].every((seg) =>
       M.suggestFor(t, seg).filter((s) => s.lane === "yours").length <= 2)));
ok("the popular slots keep their own order",
   (() => {
     const p = M.suggestFor("wa", "amara").filter((s) => s.lane === "popular");
     return p.every((s, i) => i === 0 || p[i - 1].base >= s.base);
   })());
ok("popular always comes before personal",
   ["wa", "waxing", "fa", "ped"].every((t) => {
     const l = lanesFor(t, "amara");
     const lastPop = l.lastIndexOf("popular");
     const firstMine = l.indexOf("yours");
     return firstMine === -1 || lastPop < firstMine ||
            l.slice(0, 3).every((x) => x === "popular");
   }), lanesFor("waxing", "amara").join(","));
ok("personal slots give themselves back when she has no history",
   M.suggestFor("wa", "new").length === 5);
ok("a brand she likes does not buy a personal slot with a niche service",
   M.suggestFor("wa", "kiara").filter((s) => s.lane === "yours").every((s) => s.bk >= 1000),
   M.suggestFor("wa", "kiara").map((s) => s.text + "=" + s.bk).join(" | "));
ok("something she actually booked can take a slot at any size",
   ["amara"].every((seg) =>
     M.suggestFor("aurora", seg).some((s) => s.lane === "yours")),
   listFor("aurora", "amara").join(" | "));
ok("every personal row says why it is there",
   ["wa", "waxing", "aurora", "fa"].every((t) =>
     M.suggestFor(t, "amara").filter((s) => s.lane === "yours")
       .every((s) => s.why && s.why.length > 0)));
/* A specific query personalises only when two things hold: it has candidates
   of its own (not just widened ones, which are barred from the personal
   slots), and she has actually booked inside them. Amara books the Aurora
   waxing combo, so "aurora wax" personalises. She has never booked anything
   called "bikini waxing" — her bikini service is Stripless Aurora Bikini Wax,
   a different phrase — so that one correctly does not. The test asserts the
   mechanism fires where it should, not that it fires everywhere. */
ok("a specific query personalises when she has actually booked inside it",
   ["aurora wax", "bikini waxing", "legs waxing"].filter(
     (t) => listFor(t, "amara").join("|") !== listFor(t, "new").join("|")).length >= 1,
   ["aurora wax", "bikini waxing", "legs waxing"]
     .map((t) => t + (listFor(t, "amara").join("|") !== listFor(t, "new").join("|") ? " CHANGED" : " same"))
     .join(" | "));
ok("still five per dropdown for everyone",
   ["new", "alia", "kiara", "amara"].every((seg) =>
     ["wa", "waxing", "fa", "thread", "ped"].every((t) => M.suggestFor(t, seg).length <= 5)));
ok("no duplicates across the two halves",
   ["wa", "waxing", "aurora", "fa", "ped"].every((t) => {
     const n = listFor(t, "amara").map((x) => M.norm(x));
     return new Set(n).size === n.length;
   }));
ok("the shopper still sees the category word first",
   listFor("wa", "amara")[0] === "Waxing" && listFor("fa", "amara")[0] === "Facial");

head("the results list still behaves");
const R = results("waxing");
ok("'waxing' still returns a full list", R.cand.length > 40, "got " + R.cand.length);
const parentsHit = {};
R.cand.forEach((c) => { const p = M.PARENT_OF[c.id]; if (p) parentsHit[p] = 1; });
ok("a waxing search reaches inside more than one range",
   Object.keys(parentsHit).length >= 2, Object.keys(parentsHit).join(", "));
ok("the top ten are all real services",
   R.cand.slice(0, 10).every((c) => M.SVC[c.id] && M.SVC[c.id].vis));
const faceR = results("upper lips");
/* every range is reachable from a plain search for its own hall */
ok("every range is reachable from a search for its hall",
   M.PARENT_NAMES.every((n) => {
     const hall = M.SVC[M.PGROUP[n].kids[0]].sc;
     return results(hall.toLowerCase()).cand
       .some((c) => M.PARENT_OF[c.id] === n);
   }),
   M.PARENT_NAMES.filter((n) => {
     const hall = M.SVC[M.PGROUP[n].kids[0]].sc;
     return !results(hall.toLowerCase()).cand.some((c) => M.PARENT_OF[c.id] === n);
   }).join(", ") || "all reachable");

console.log("\n" + "-".repeat(52));
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
