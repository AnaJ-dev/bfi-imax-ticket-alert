import fs from "fs";
const src = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");

// pull the two injected functions out and run them against a fake DOM
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  let d = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1);
  }
};
const el = (textContent, attrs = {}) => ({
  textContent, clicked: false, click() { this.clicked = true; },
  getAttribute: (n) => attrs[n] ?? null,
});
const mkDoc = (els) => ({ querySelectorAll: () => els });
const run = (name, els, ...args) => {
  const fn = new Function("document", "console", `${grab(name)}; return ${name};`)(mkDoc(els), { log(){} });
  return fn(...args);
};

let pass = 0, fail = 0;
const t = (name, cond) => { cond ? (pass++, console.log("  PASS", name)) : (fail++, console.log("  FAIL", name)); };

console.log("H2 dismissCookieBanner:");
let els = [el("Accept cookies"), el("Continue without accepting")];
run("dismissCookieBanner", els);
t("both buttons -> rejects, does not accept", els[1].clicked && !els[0].clicked);

els = [el("Accept All Cookies"), el("Reject all")];
run("dismissCookieBanner", els);
t("accept/reject all -> rejects", els[1].clicked && !els[0].clicked);

els = [el("Accept cookies"), el("Necessary cookies only")];
run("dismissCookieBanner", els);
t("necessary-only wins over accept", els[1].clicked && !els[0].clicked);

els = [el("Accept cookies")];
let r0 = run("dismissCookieBanner", els);
t("accept-only banner still dismissed", r0.clicked === "Accept cookies" && els[0].clicked);
t("it reports what the banner offered", JSON.stringify(r0.offered) === JSON.stringify(["Accept cookies"]));

els = [el("Home"), el("Sign in")];
let r1 = run("dismissCookieBanner", els);
t("no banner -> clicks nothing", r1.clicked === null && !els.some((e) => e.clicked));

// BFI's real wording, seen live on their site
els = [el("BFI cookies policy"), el("Reject additional cookies"), el("Allow additional cookies")];
let r2 = run("dismissCookieBanner", els);
t("BFI's real banner -> rejects", r2.clicked === "Reject additional cookies" && els[1].clicked && !els[2].clicked);

console.log("H1 clickBuyInPage:");
const target = "Sunday 12 April 2026 19:00";
els = [el("Buy", { "aria-label": `Buy tickets for Friday 10 April 2026 12:00` }),
       el("Buy", { "aria-label": `Buy tickets for ${target}` })];
let r = run("clickBuyInPage", els, target);
t("matching screening clicked", r.ok && els[1].clicked && !els[0].clicked);

els = [el("Buy", { "aria-label": "Buy tickets for Friday 10 April 2026 12:00" }), el("Buy")];
r = run("clickBuyInPage", els, target);
t("no match -> refuses, clicks nothing", !r.ok && r.reason === "buy-link-not-found" && !els.some((e) => e.clicked));

console.log("H3 withStateLock serialises:");
const lock = new Function(`${grab("withStateLock")}; let stateLockTail = Promise.resolve(); return withStateLock;`)();
let store = { n: 0 }, inFlight = 0, overlap = false;
const bump = () => lock(async () => {
  if (++inFlight > 1) overlap = true;
  const v = store.n;                       // read
  await new Promise((r) => setTimeout(r, 5));
  store.n = v + 1;                         // write
  inFlight--;
});
await Promise.all([bump(), bump(), bump(), bump(), bump()]);
t("5 concurrent read-modify-writes all land", store.n === 5);
t("no two critical sections overlap", !overlap);

const q = new Function(`${grab("runQueued")}; let queueTail = Promise.resolve(); return runQueued;`)();
let order = [];
await Promise.all([
  q(async () => { await new Promise((r) => setTimeout(r, 20)); order.push("a"); }),
  q(async () => { order.push("b"); }),
]);
t("runQueued preserves submission order", order.join("") === "ab");
await q(() => { throw new Error("boom"); }).catch(() => order.push("err"));
await q(async () => order.push("after"));
t("a thrown task does not wedge the queue", order.join("") === "aberrafter");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
