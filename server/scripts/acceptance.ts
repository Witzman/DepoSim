// The acceptance run from issue #16, over HTTP and WebSocket only (no browser):
//   npm run acceptance -- https://depo.witzman.de
// Starts a simulation at 10:00 Berlin time on the last trading day, plays an hour of it at
// tempo 60, buys and places a limit order, pauses, reconnects and checks that nothing moved.
import WebSocket from "ws";
import { berlinToUtcSeconds } from "../../web/src/time.js";
import { lastTradingDayBefore } from "./acceptance-lib.js";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base) {
  console.error("usage: npm run acceptance -- <BASE_URL>");
  process.exit(2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (text: string) => console.log(`• ${text}`);
const ok = (text: string) => console.log(`    ✓ ${text}`);
function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function http(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any;
  try {
    json = await res.json();
  } catch {
    // 204 and friends have no body
  }
  return { status: res.status, json };
}

class Conn {
  readonly msgs: any[] = [];
  private readonly ws: WebSocket;

  constructor(id: number) {
    this.ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws/simulations/${id}`);
    this.ws.on("message", (d) => this.msgs.push(JSON.parse(String(d))));
  }

  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }

  /** The first message at or after index `since` that satisfies `pred`. */
  async waitFor(pred: (m: any) => boolean, ms: number, what: string, since = 0) {
    const end = Date.now() + ms;
    for (;;) {
      const m = this.msgs.slice(since).find(pred);
      if (m) return m;
      const notice = this.msgs.slice(since).find((x) => x.type === "notice" || x.type === "error");
      if (notice) throw new Error(`${what}: der Server meldet "${notice.text}"`);
      if (Date.now() > end) throw new Error(`${what}: nach ${ms / 1000} s nichts erhalten`);
      await sleep(50);
    }
  }

  close() {
    this.ws.close();
  }
}

async function main() {
  let simId: number | undefined;
  const conns: Conn[] = [];
  try {
    step("Simulation ab dem letzten Handelstag, 10:00 Uhr Berliner Zeit, anlegen");
    let startAt = 0;
    const t0 = Date.now();
    for (let attempt = 0; attempt < 5 && simId === undefined; attempt++) {
      const day = lastTradingDayBefore(new Date(), attempt);
      startAt = berlinToUtcSeconds(day, "10:00");
      const r = await http("POST", "/api/simulations", { name: `Abnahme ${day}`, startAt });
      if (r.status === 201) {
        simId = r.json.id;
        ok(`${day} angelegt in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      } else if (r.status === 502 && /keine Kurse/.test(r.json?.error ?? "")) {
        console.log(`    ${day}: keine Kurse (Feiertag?), ein Handelstag früher`);
      } else {
        throw new Error(`Anlegen: HTTP ${r.status} ${r.json?.error ?? ""}`);
      }
    }
    check(simId !== undefined, "in fünf Handelstagen kein Tag mit Kursen gefunden");

    step("Verbinden, Tempo 60, laufen lassen");
    const a = new Conn(simId);
    conns.push(a);
    const first = await a.waitFor((m) => m.type === "snapshot", 10_000, "erster Snapshot");
    check(first.simulation.simulationTime === startAt, "die Simulation startet nicht zur gewählten Zeit");
    a.send({ type: "tempo", tempo: 60 });
    a.send({ type: "run" });
    const tick = await a.waitFor((m) => m.type === "tick" && m.simulationTime >= startAt + 300, 30_000, "Uhr läuft");
    ok(`Simulationszeit +${tick.simulationTime - startAt} s`);

    step("Market-Kauf und Limit-Verkauf");
    const price: number | undefined = tick.prices["SAP.DE"]?.price;
    check(price, "kein Kurs für SAP.DE");
    const bought = await http("POST", `/api/simulations/${simId}/orders`, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 1 });
    check(bought.status === 201, `Kauf: HTTP ${bought.status} ${bought.json?.error ?? ""}`);
    await a.waitFor(
      (m) => m.type === "snapshot" && m.depot.orders.some((o: any) => o.id === bought.json.orderId && o.status === "filled"),
      5000, "Kauf ausgeführt",
    );
    ok("Kauf ausgeführt");
    const limit = Math.round(price * 1.05 * 100) / 100;
    const sell = await http("POST", `/api/simulations/${simId}/orders`, { symbol: "SAP.DE", side: "sell", kind: "limit", qty: 1, limitPrice: limit });
    check(sell.status === 201, `Limit-Verkauf: HTTP ${sell.status} ${sell.json?.error ?? ""}`);
    ok(`Limit-Verkauf bei ${limit} angenommen`);

    step("Eine Stunde Simulationszeit spielen, pausieren");
    await a.waitFor((m) => m.type === "tick" && m.simulationTime >= startAt + 3600, 120_000, "eine Stunde gespielt");
    const sinceMark = a.msgs.length;
    a.send({ type: "pause" });
    const paused = await a.waitFor((m) => m.type === "snapshot" && m.running === false, 5000, "Pause", sinceMark);
    const rec = {
      time: paused.simulation.simulationTime,
      cash: paused.depot.cash,
      positions: JSON.stringify(paused.depot.positions),
      orders: JSON.stringify(paused.depot.orders),
    };
    ok(`pausiert bei +${rec.time - startAt} s, Guthaben ${(rec.cash / 100).toFixed(2)} €`);
    a.close();

    step("Neu verbinden: derselbe Stand, pausiert");
    const b = new Conn(simId);
    conns.push(b);
    const again = await b.waitFor((m) => m.type === "snapshot", 10_000, "Snapshot nach dem Neuverbinden");
    check(again.simulation.simulationTime === rec.time, "die Simulationszeit hat sich verändert");
    check(again.running === false, "die Simulation läuft ohne Zutun");
    check(again.depot.cash === rec.cash, "das Guthaben hat sich verändert");
    check(JSON.stringify(again.depot.positions) === rec.positions, "die Positionen haben sich verändert");
    check(JSON.stringify(again.depot.orders) === rec.orders, "die Aufträge haben sich verändert");
    await sleep(2000);
    check(!b.msgs.some((m) => m.type === "tick"), "nach dem Neuverbinden laufen Ticks");
    ok("Zeit, Guthaben, Positionen und Aufträge gleich, nichts läuft");
    b.close();

    step("Abgelehnte Order, Simulation löschen");
    const bad = await http("POST", `/api/simulations/${simId}/orders`, { symbol: "SAP.DE", side: "buy", kind: "market", qty: 0 });
    check(bad.status === 400 && /Menge/.test(bad.json?.error ?? ""), "Menge 0 wird nicht mit Begründung abgelehnt");
    ok(`abgelehnt: ${bad.json.error}`);
    const del = await http("DELETE", `/api/simulations/${simId}`);
    check(del.status === 204, `Löschen: HTTP ${del.status}`);
    const gone = await http("GET", `/api/simulations/${simId}/bars?symbol=SAP.DE`);
    check(gone.status === 404, "die gelöschte Simulation ist noch da");
    simId = undefined;
    ok("gelöscht");

    console.log("\nABNAHME BESTANDEN");
  } finally {
    conns.forEach((c) => c.close());
    if (simId !== undefined) await http("DELETE", `/api/simulations/${simId}`).catch(() => undefined);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\nABNAHME FEHLGESCHLAGEN: ${err.message}`);
    process.exit(1);
  },
);
