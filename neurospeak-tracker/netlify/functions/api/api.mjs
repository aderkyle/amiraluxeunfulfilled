// NeuroSpeak COD Tracker API (Netlify Function + Netlify Blobs).
// Every route requires the team passcode in the "x-passcode" header.
// Set it in Netlify: Site configuration > Environment variables > TRACKER_PASSCODE.
import { getStore } from "@netlify/blobs";
import { timingSafeEqual, createHash } from "node:crypto";
import BASE from "./orders-data.mjs";

export const config = { path: "/api/*" };

const CALL = ["Not called", "No answer", "Busy / call back", "Reached", "Wrong number"];
const DEC = ["Undecided", "Confirmed", "Will cancel", "Reschedule"];
const STAGE = ["Not processed", "Processed / packed", "Handed to courier", "In transit", "Out for delivery", "Delivered", "Failed attempt", "Returned (RTS)"];
const BASE_IDS = new Set(BASE.map((r) => r[0]));
const SHARDS = [...new Set(BASE.map((r) => shardOf(r[0])))].concat("added");

function shardOf(id) {
  if (/^o\d+$/.test(id)) return "s" + String(Math.floor((parseInt(id.slice(1), 10) - 1) / 50)).padStart(2, "0");
  return "added";
}
function store() {
  return getStore({ name: "neurospeak-tracker", consistency: "strong" });
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
function configuredPasscode() {
  let v = "";
  try { v = (globalThis.Netlify && globalThis.Netlify.env && globalThis.Netlify.env.get("TRACKER_PASSCODE")) || ""; } catch (_) {}
  if (!v) v = process.env.TRACKER_PASSCODE || "";
  return String(v).trim();
}
// Returns null when the passcode matches, otherwise a reason code.
function authProblem(req) {
  const want = configuredPasscode();
  const got = String(req.headers.get("x-passcode") || "").trim();
  if (!want) return "not_configured";
  if (want.length < 6) return "too_short";
  if (!got) return "missing";
  const a = createHash("sha256").update(want).digest();
  const b = createHash("sha256").update(got).digest();
  return timingSafeEqual(a, b) ? null : "wrong";
}
const AUTH_MSG = {
  not_configured: "The site has no passcode set yet. In Netlify, add TRACKER_PASSCODE under Environment variables, then redeploy.",
  too_short: "The site's passcode is shorter than 6 characters. Set a longer TRACKER_PASSCODE in Netlify, then redeploy.",
  missing: "Enter the team passcode.",
  wrong: "That passcode doesn't match. Check capital letters and try again.",
};
function clean(s, max) {
  return String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

// Read-modify-write a JSON blob with a conditional write, retrying on conflicts,
// so two callers editing at the same moment never overwrite each other.
async function mutate(st, key, fn, fallback) {
  for (let i = 0; i < 10; i++) {
    const cur = await st.getWithMetadata(key, { type: "json" });
    if (!cur) {
      const next = fn(structuredClone(fallback));
      const r = await st.setJSON(key, next, { onlyIfNew: true });
      if (r.modified) return next;
    } else {
      const next = fn(cur.data);
      const r = await st.setJSON(key, next, { onlyIfMatch: cur.etag });
      if (r.modified) return next;
    }
    await new Promise((res) => setTimeout(res, 40 + Math.random() * 120));
  }
  throw new Error("busy");
}

async function readState(st) {
  const [shards, added] = await Promise.all([
    Promise.all(SHARDS.map((s) => st.get("track/" + s, { type: "json" }))),
    st.get("added-orders", { type: "json" }),
  ]);
  const track = {};
  shards.forEach((s) => s && Object.assign(track, s));
  return { track, added: added || [], at: Date.now() };
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const problem = authProblem(req);
  if (problem) return json({ error: AUTH_MSG[problem], reason: problem }, 401);
  const st = store();

  try {
    if (req.method === "GET" && route === "check") return json({ ok: true });

    if (req.method === "GET" && route === "orders") {
      return json({ orders: BASE });
    }

    if (req.method === "GET" && route === "state") {
      return json(await readState(st));
    }

    if (req.method === "POST" && route === "track") {
      const body = await req.json().catch(() => null);
      const id = body && String(body.id || "");
      if (!id || (!BASE_IDS.has(id) && !/^a-[a-z0-9]{6,40}$/.test(id))) return json({ error: "Unknown order." }, 400);
      const p = body.patch || {};
      const who = clean(req.headers.get("x-user"), 60) || "Team";
      const entry = await mutate(st, "track/" + shardOf(id), (doc) => {
        const e = Object.assign({}, doc[id] || {});
        if (p.call !== undefined && CALL.includes(p.call)) e.call = p.call;
        if (p.decision !== undefined && DEC.includes(p.decision)) e.decision = p.decision;
        if (p.stage !== undefined && STAGE.includes(p.stage)) e.stage = p.stage;
        if (p.tracking !== undefined) e.tracking = clean(p.tracking, 60);
        if (p.notes !== undefined) e.notes = clean(p.notes, 500);
        if (p.attempt) {
          e.attempts = (e.attempts || 0) + 1;
          e.lastCall = Date.now();
          if (!e.call || e.call === "Not called") e.call = "No answer";
        } else if (p.call && p.call !== "Not called" && !e.attempts) {
          e.attempts = 1;
          e.lastCall = Date.now();
        }
        if (p.stage && p.stage !== "Not processed" && (!e.decision || e.decision === "Undecided")) e.decision = "Confirmed";
        e.by = who;
        e.at = Date.now();
        doc[id] = e;
        return doc;
      }, {});
      return json({ id, entry: entry[id] });
    }

    if (req.method === "POST" && route === "orders") {
      const b = await req.json().catch(() => null);
      if (!b) return json({ error: "Missing order details." }, 400);
      let phone = String(b.phone || "").replace(/\D/g, "");
      if (phone.length === 10 && phone[0] === "9") phone = "0" + phone;
      const name = clean(b.name, 80);
      const price = Number(b.price);
      const date = String(b.date || "");
      if (!name) return json({ error: "Enter the customer's name." }, 400);
      if (!/^09\d{9}$/.test(phone)) return json({ error: "Enter an 11-digit mobile number starting with 09." }, 400);
      if (!(price > 0 && price < 100000)) return json({ error: "Enter a valid price." }, 400);
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date)) return json({ error: "Enter the order date and time." }, 400);
      const order = { id: "a-" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), name, phone, price, date, by: clean(req.headers.get("x-user"), 60) || "Team", at: Date.now() };
      await mutate(st, "added-orders", (list) => { list.push(order); return list; }, []);
      return json({ order });
    }

    return json({ error: "Not found." }, 404);
  } catch (e) {
    return json({ error: e.message === "busy" ? "Many people are saving at once. Try again." : "Server error. Try again." }, 503);
  }
};
