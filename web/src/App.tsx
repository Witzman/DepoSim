import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Socket, createSimulation, deleteSimulation, endSimulation, getBars, getWatchlist, listSimulations, openSocket,
} from "./api.js";
import { Chart } from "./components/Chart.js";
import { ClockBar } from "./components/ClockBar.js";
import { SimulationPicker } from "./components/SimulationPicker.js";
import { useTheme } from "./theme.js";
import type { Bar, Instrument, ServerMessage, Simulation, Snapshot, Tempo } from "./types.js";

const BARS_SHOWN = 500;
const MAX_BARS = 2000;

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
  const socket = useRef<Socket | null>(null);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  useEffect(() => {
    listSimulations().then(setSimulations).catch((e) => setLoadError(e.message));
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

  async function create(name: string, startAt: number) {
    const sim = await createSimulation({ name, startAt });
    setSimulations((prev) => [...prev, sim]);
    setSelectedId(sim.id);
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

  const selected = simulations.find((s) => s.id === selectedId) ?? null;
  const live = snapshot?.simulation ?? selected;

  return (
    <div className="app">
      <header className="topbar">
        <h1>DepoSim</h1>
        <button className="btn small" data-testid="theme-toggle" onClick={toggle} aria-label="Hell oder Dunkel umschalten">
          {theme === "dark" ? "Hell" : "Dunkel"}
        </button>
      </header>

      <div className="layout">
        <SimulationPicker
          simulations={simulations} selectedId={selectedId} onSelect={setSelectedId}
          onCreate={create} onEnd={end} onDelete={remove}
        />

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
                  disabled={live.endedAt !== null || snapshot === null}
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
                  {snapshot?.prices[symbol] && (
                    <span className="num">{snapshot.prices[symbol].price.toFixed(2)}</span>
                  )}
                </div>
                <Chart bars={bars} theme={theme} />
              </section>
            </>
          ) : (
            <section className="card"><p className="muted">Wähle oder lege links eine Simulation an.</p></section>
          )}
        </main>
      </div>
    </div>
  );
}
