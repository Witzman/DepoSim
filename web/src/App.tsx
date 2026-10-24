import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Socket, addInstrument, cancelOrder, createSimulation, deleteSimulation, endSimulation, getBars, getWatchlist, listSimulations,
  openSocket, removeInstrument,
} from "./api.js";
import { Chart } from "./components/Chart.js";
import { ClockBar } from "./components/ClockBar.js";
import { DepotPanel } from "./components/DepotPanel.js";
import { OrderTicket } from "./components/OrderTicket.js";
import { OrdersPanel } from "./components/OrdersPanel.js";
import { Palette } from "./components/Palette.js";
import { SimulationPicker } from "./components/SimulationPicker.js";
import { Watchlist } from "./components/Watchlist.js";
import { formatPrice } from "./format.js";
import { pickInitial } from "./select.js";
import { useTheme } from "./theme.js";
import type { Bar, Instrument, ServerMessage, Simulation, Snapshot, Tempo } from "./types.js";

const BARS_SHOWN = 500;
const MAX_BARS = 2000;
const SELECTED_KEY = "deposim-selected";

function storedSelection(): number | null {
  try {
    const v = Number(localStorage.getItem(SELECTED_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null; // blocked storage: the newest simulation is opened instead
  }
}

function rememberSelection(id: number | null) {
  try {
    if (id === null) localStorage.removeItem(SELECTED_KEY);
    else localStorage.setItem(SELECTED_KEY, String(id));
  } catch {
    // nothing to do: it only means the choice is not kept
  }
}

export function App() {
  const { theme, toggle } = useTheme();
  const [simulations, setSimulations] = useState<Simulation[]>([]);
  const [watchlist, setWatchlist] = useState<Instrument[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [symbol, setSymbol] = useState("SAP.DE");
  const [bars, setBars] = useState<Bar[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticketCommand, setTicketCommand] = useState<{ side: "buy" | "sell"; n: number }>({ side: "buy", n: 0 });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const socket = useRef<Socket | null>(null);
  const runningRef = useRef(false);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  useEffect(() => {
    listSimulations()
      .then((list) => {
        setSimulations(list);
        setSelectedId(pickInitial(list, storedSelection()));
      })
      .catch((e) => setLoadError(e.message));
    getWatchlist()
      .then((list) => {
        setWatchlist(list);
        const first = list.find((i) => i.venue === "XETRA") ?? list[0];
        if (first) setSymbol(first.symbol);
      })
      .catch((e) => setLoadError(e.message));
  }, []);

  const onMessage = useCallback((m: ServerMessage) => {
    if (m.type === "snapshot") {
      setSnapshot(m);
    } else if (m.type === "tick") {
      setSnapshot((prev) =>
        prev && {
          ...prev, running: m.running, depot: m.depot, prices: m.prices, fx: m.fx, venues: m.venues,
          liveLimit: m.liveLimit, delayS: m.delayS, phase: m.phase,
          simulation: { ...prev.simulation, simulationTime: m.simulationTime },
        },
      );
      const fresh = m.newBars[symbolRef.current];
      if (fresh?.length) {
        setBars((prev) => {
          const last = prev.length ? prev[prev.length - 1].t : -1;
          const next = [...prev, ...fresh.filter((b) => b.t > last)];
          return next.length > MAX_BARS ? next.slice(-MAX_BARS) : next;
        });
      }
    } else {
      setNotice(m.text);
    }
  }, []);

  useEffect(() => rememberSelection(selectedId), [selectedId]);

  // Ctrl+K (Cmd+K) opens and closes the palette, from anywhere, also from inside a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (document.querySelector("dialog[open]:not([data-testid='palette'])")) return;
      e.preventDefault();
      setPaletteOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // B and S pick the side, Space starts and pauses. Typing in a field is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return;
      // A focused button or link takes Space itself; the letters are free.
      if (e.key === " " && t && /^(BUTTON|A)$/.test(t.tagName)) return;
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "b" || e.key === "s") {
        e.preventDefault();
        setTicketCommand((c) => ({ side: e.key === "b" ? "buy" : "sell", n: c.n + 1 }));
      } else if (e.key === " " && socket.current) {
        e.preventDefault();
        socket.current.send({ type: runningRef.current ? "pause" : "run" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // One socket per selected simulation.
  useEffect(() => {
    socket.current?.close();
    socket.current = null;
    setSnapshot(null);
    setNotice(null);
    if (selectedId === null) return;
    const s = openSocket(selectedId, onMessage, () => {});
    socket.current = s;
    return () => s.close();
  }, [selectedId, onMessage]);

  // The chart's history: reloaded for another simulation or another symbol.
  useEffect(() => {
    if (selectedId === null) return setBars([]);
    let current = true;
    getBars(selectedId, symbol, BARS_SHOWN)
      .then((b) => current && setBars(b))
      .catch((e) => current && setNotice(e.message));
    return () => { current = false; };
  }, [selectedId, symbol]);

  async function create(input: { name: string; startAt?: number; live?: boolean }) {
    const sim = await createSimulation(input);
    setSimulations((prev) => [...prev, sim]);
    setSelectedId(sim.id);
  }

  async function addTitle(symbol: string) {
    const added = await addInstrument(symbol);
    setWatchlist(await getWatchlist());
    setSymbol(added.symbol);
  }

  async function removeTitle(sym: string) {
    try {
      await removeInstrument(sym);
      const list = await getWatchlist();
      setWatchlist(list);
      if (sym === symbol) setSymbol((list.find((i) => i.venue === "XETRA") ?? list[0])?.symbol ?? "");
      setNotice(null);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  async function remove(id: number) {
    try {
      await deleteSimulation(id);
      setSimulations((prev) => prev.filter((s) => s.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  async function end(id: number) {
    try {
      const sim = await endSimulation(id);
      setSimulations((prev) => prev.map((s) => (s.id === id ? sim : s)));
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  async function cancel(orderId: number) {
    if (selectedId === null) return;
    try {
      await cancelOrder(selectedId, orderId);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  const selected = simulations.find((s) => s.id === selectedId) ?? null;
  const live = snapshot?.simulation ?? selected;
  runningRef.current = snapshot?.running ?? false;
  const instrument = watchlist.find((i) => i.symbol === symbol);
  const price = snapshot?.prices[symbol];
  const locked = live === null || live.endedAt !== null || snapshot === null;

  return (
    <div className="app">
      <header className="topbar">
        <h1>DepoSim</h1>
        <button className="btn small" data-testid="palette-open" onClick={() => setPaletteOpen(true)}
          aria-label="Suche und Befehle öffnen (Strg+K)" title="Strg+K">Suche</button>
        <button className="btn small" data-testid="theme-toggle" onClick={toggle} aria-label="Hell oder Dunkel umschalten">
          {theme === "dark" ? "Hell" : "Dunkel"}
        </button>
      </header>

      <div className="layout">
        <div className="stack">
          <SimulationPicker
            simulations={simulations} selectedId={selectedId} onSelect={setSelectedId}
            onCreate={create} onEnd={end} onDelete={remove}
          />
          {live && (
            <Watchlist instruments={watchlist} prices={snapshot?.prices ?? {}} venues={snapshot?.venues}
              selected={symbol} onSelect={setSymbol} onRemove={removeTitle} />
          )}
        </div>

        <main className="main stack">
          {loadError && <p className="banner error" role="alert">{loadError}</p>}
          {notice && <p className="banner" role="status">{notice}</p>}

          {live ? (
            <>
              <section className="card">
                <ClockBar
                  simulationTime={live.simulationTime}
                  tempo={live.tempo as Tempo}
                  running={snapshot?.running ?? false}
                  disabled={locked}
                  live={live.live}
                  phase={snapshot?.phase ?? "replay"}
                  lagS={snapshot ? Math.max(snapshot.liveLimit - live.simulationTime, 0) : 0}
                  delayS={snapshot?.delayS ?? 900}
                  onTempo={(t) => socket.current?.send({ type: "tempo", tempo: t })}
                  onRun={() => { setNotice(null); socket.current?.send({ type: "run" }); }}
                  onPause={() => socket.current?.send({ type: "pause" })}
                />
              </section>
              <section className="card">
                <div className="toolbar">
                  <select aria-label="Wertpapier" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                    {watchlist.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol} · {i.name}</option>)}
                  </select>
                  {price && instrument && (
                    <span className="num" data-testid="last-price">{formatPrice(price.price, instrument.currency)}</span>
                  )}
                </div>
                <Chart bars={bars} theme={theme} />
              </section>
              <div className="trade-grid">
                <OrderTicket simulationId={live.id} instrument={instrument} priceKey={price?.barT}
                  disabled={locked} command={ticketCommand} />
                {snapshot && <DepotPanel depot={snapshot.depot} startCash={live.startCash} />}
              </div>
              {snapshot && (
                <OrdersPanel orders={snapshot.depot.orders} instruments={watchlist} disabled={locked} onCancel={cancel} />
              )}
            </>
          ) : (
            <section className="card"><p className="muted">Wähle oder lege links eine Simulation an.</p></section>
          )}
        </main>
      </div>
      <Palette
        open={paletteOpen} instruments={watchlist} simulations={simulations} selectedId={selectedId}
        onClose={() => setPaletteOpen(false)} onPickInstrument={setSymbol} onPickSimulation={setSelectedId}
        onToggleTheme={toggle} onAdd={addTitle}
      />
    </div>
  );
}
