// The acceptance run from issue #16, over HTTP and WebSocket only (no browser):
//   npm run acceptance -- https://depo.witzman.de
// Behind the login of the live site: ACCEPTANCE_AUTH=user:password npm run acceptance -- <url>
// (an environment variable, so the password is not in the command line or in the code).
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

const authHeader: Record<string, string> = process.env.ACCEPTANCE_AUTH
  ? { authorization: `Basic ${Buffer.from(process.env.ACCEPTANCE_AUTH).toString("base64")}` }
  : {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (text: string) => console.log(`• ${text}`);
const ok = (text: string) => console.log(`    ✓ ${text}`);
function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function http(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { ...authHeader, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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
    this.ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws/simulations/${id}`, { headers: authHeader });
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
      if (Date.now() > end) {
        // All clients of a simulation share one clock, so another client's Pause stops this run too.
        const last = [...this.msgs].reverse().find((x) => x.type === "snapshot" || x.type === "tick");
        const hint = last && last.running === false ? " (letzte Nachricht: die Simulation ist pausiert, hat ein anderer Client sie angehalten?)" : "";
        throw new Error(`${what}: nach ${ms / 1000} s nichts erhalten${hint}`);
      }
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
      (m) => m.type === "snapshot" && m.depots[0].orders.some((o: any) => o.id === bought.json.orderId && o.status === "filled"),
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
      cash: paused.depots[0].cash,
      positions: JSON.stringify(paused.depots[0].positions),
      orders: JSON.stringify(paused.depots[0].orders),
    };
    ok(`pausiert bei +${rec.time - startAt} s, Guthaben ${(rec.cash / 100).toFixed(2)} €`);
    a.close();

    step("Neu verbinden: derselbe Stand, pausiert");
    const b = new Conn(simId);
    conns.push(b);
    const again = await b.waitFor((m) => m.type === "snapshot", 10_000, "Snapshot nach dem Neuverbinden");
    check(again.simulation.simulationTime === rec.time, "die Simulationszeit hat sich verändert");
    check(again.running === false, "die Simulation läuft ohne Zutun");
    check(again.depots[0].cash === rec.cash, "das Guthaben hat sich verändert");
    check(JSON.stringify(again.depots[0].positions) === rec.positions, "die Positionen haben sich verändert");
    check(JSON.stringify(again.depots[0].orders) === rec.orders, "die Aufträge haben sich verändert");
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

    step("Nachspielen bei Tempo 1: die Uhr bewegt sich (sie stand früher still)");
    {
      const r = await http("POST", "/api/simulations", { name: "Abnahme Tempo 1", startAt });
      check(r.status === 201, `Anlegen: HTTP ${r.status} ${r.json?.error ?? ""}`);
      simId = r.json.id as number;
      const c = new Conn(simId);
      conns.push(c);
      const snap = await c.waitFor((m) => m.type === "snapshot", 10_000, "Snapshot");
      check(snap.simulation.tempo === 1 && snap.simulation.live === false, "ein neues Nachspielen ist nicht live und läuft mit 1x");
      c.send({ type: "run" });
      await sleep(5000);
      const mark = c.msgs.length;
      c.send({ type: "pause" });
      const stopped = await c.waitFor((m) => m.type === "snapshot" && m.running === false, 5000, "Pause", mark);
      const moved = stopped.simulation.simulationTime - startAt;
      check(moved >= 4 && moved <= 8, `bei 1x sind in 5 s ${moved} s Simulationszeit vergangen (erwartet etwa 5)`);
      ok(`in 5 s Echtzeit ${moved} s Simulationszeit`);
      c.close();
      await http("DELETE", `/api/simulations/${simId}`);
      simId = undefined;
    }

    step("Live-Simulation: ab jetzt, die Uhr läuft nie über die Live-Grenze");
    {
      const t0 = Math.floor(Date.now() / 1000);
      const r = await http("POST", "/api/simulations", { name: "Abnahme Live", live: true });
      check(r.status === 201, `Live anlegen: HTTP ${r.status} ${r.json?.error ?? ""}`);
      check(r.json.live === true, "die Simulation ist nicht als live angelegt");
      simId = r.json.id as number;
      const c = new Conn(simId);
      conns.push(c);
      const first = await c.waitFor((m) => m.type === "snapshot", 10_000, "Snapshot der Live-Simulation");
      check(first.phase === "live" || first.phase === "catchup", `Phase ${first.phase}`);
      const t1 = Math.floor(Date.now() / 1000);
      check(first.delayS === 900, `Zeitversatz ${first.delayS} s statt 900 s`);
      check(first.liveLimit >= t0 - 900 - 5 && first.liveLimit <= t1 - 900 + 5, "die Live-Grenze liegt nicht bei jetzt minus 15 Minuten");
      check(first.simulation.simulationTime <= first.liveLimit, "der Start liegt hinter der Live-Grenze");
      ok(`Phase ${first.phase}, Start ${new Date(first.simulation.simulationTime * 1000).toISOString()}, Grenze ${new Date(first.liveLimit * 1000).toISOString()}`);

      const mark = c.msgs.length;
      c.send({ type: "tempo", tempo: 60 });
      await c.waitFor((m) => m.type === "notice" && /Livebetrieb/.test(m.text), 5000, "Hinweis zum Tempo", mark);
      ok("das Tempo lässt sich im Livebetrieb nicht ändern");

      const runMark = c.msgs.length;
      c.send({ type: "run" });
      // Either the server says why it stops or waits, or the clock ticks on. Looking again at a day
      // that is not over yet takes about ten seconds (19 calls), so allow thirty.
      const end = Date.now() + 30_000;
      while (Date.now() < end) {
        const now = c.msgs.slice(runMark);
        if (now.some((m) => m.type === "notice") || now.filter((m) => m.type === "tick").length >= 5) break;
        await sleep(100);
      }
      const seen = c.msgs.slice(runMark);
      check(!seen.some((m) => m.type === "error"), "der Server meldet einen Fehler");
      const ticks = seen.filter((m) => m.type === "tick");
      for (const m of ticks) check(m.simulationTime <= m.liveLimit, "ein Tick liegt hinter der Live-Grenze");
      const note = seen.find((m) => m.type === "notice")?.text;
      check(note !== undefined || ticks.length >= 5, "nach 30 s weder ein Hinweis noch laufende Ticks: die Uhr steht ohne Erklärung");
      ok(`${ticks.length} Ticks, alle bis zur Live-Grenze${note ? `; Hinweis: "${note}"` : ""}`);
      console.log(
        note?.startsWith("Warte")
          ? "    (am Rand der Gegenwart: wartet auf neue Kurse)"
          : note?.startsWith("Ende")
            ? "    (Markt geschlossen: pausiert mit \"Ende der Daten\")"
            : "    (Markt läuft: die Uhr folgt der Grenze)",
      );
      c.send({ type: "pause" });
      c.close();
      const del2 = await http("DELETE", `/api/simulations/${simId}`);
      check(del2.status === 204, `Löschen: HTTP ${del2.status}`);
      simId = undefined;
    }

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
