import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Socket, addDepot, addGhost, addInstrument, cancelOrder, createSimulation, deleteSimulation, endSimulation, getBackupStatus, getBars, getDataStatus, getWatchlist, listSimulations,
  openSocket, removeDepot, setBenchmark, removeInstrument, renameDepot,
} from "./api.js";
import { AllocationDialog } from "./components/AllocationDialog.js";
import { BackfillDialog } from "./components/BackfillDialog.js";
import { Compare } from "./components/Compare.js";
import { Journal } from "./components/Journal.js";
import { OrderbookPanel } from "./components/Orderbook.js";
import { Chart, type Fill } from "./components/Chart.js";
import { CHART_PREFS_KEY, RAW_LIMIT, defaultChartPrefs, parseChartPrefs, type ChartPrefs } from "./bars.js";
import { DataView } from "./components/DataView.js";
import { lightLine } from "./data.js";
import { Collapsible } from "./components/Collapsible.js";
import { ClockBar } from "./components/ClockBar.js";
import { Curves } from "./components/Curves.js";
import { Evaluation } from "./components/Evaluation.js";
import { Longterm } from "./components/Longterm.js";
import { DepotPanel } from "./components/DepotPanel.js";
import { DepotSwitch } from "./components/DepotSwitch.js";
import { OrderTicket } from "./components/OrderTicket.js";
import { OrdersPanel } from "./components/OrdersPanel.js";
import { MobileBar } from "./components/MobileBar.js";
import { BackupDialog } from "./components/BackupDialog.js";
import { backupLine } from "./backup.js";
import { Palette } from "./components/Palette.js";
import { Glossary } from "./components/Glossary.js";
import { Guide } from "./components/Guide.js";
import { initGuide, markSeen, restartGuide } from "./guide.js";
import { FeedbackSettings } from "./components/FeedbackSettings.js";
import { Hints } from "./components/Hints.js";
import { applyMotion, feedback, feedbackPrefs } from "./feedback.js";
import { ShortcutHelp } from "./components/ShortcutHelp.js";
import { SimulationPicker } from "./components/SimulationPicker.js";
import { Watchlist } from "./components/Watchlist.js";
import { formatPrice } from "./format.js";
import { pickInitial } from "./select.js";
import { canGhost, pickDepot } from "./view.js";
import type { CommandId } from "./palette.js";
import { useNarrow } from "./useNarrow.js";
import { useTheme } from "./theme.js";
import type { BackupStatus, Bar, DataStatus, Instrument, ServerMessage, Simulation, Snapshot, Tempo } from "./types.js";

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

function storedChartPrefs(): ChartPrefs {
  try {
    return parseChartPrefs(localStorage.getItem(CHART_PREFS_KEY));
  } catch {
    return defaultChartPrefs(); // blocked storage: the chart opens with its defaults
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
  const [chartPrefs, setChartPrefs] = useState<ChartPrefs>(storedChartPrefs);
  const rawLimit = RAW_LIMIT[chartPrefs.timeframe];
  const barsKey = useRef("");
  const rawLimitRef = useRef(rawLimit);
  rawLimitRef.current = rawLimit;
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticketCommand, setTicketCommand] = useState<{ side: "buy" | "sell"; n: number }>({ side: "buy", n: 0 });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [view, setView] = useState<"trade" | "evaluation" | "longterm" | "data">("trade");
  const [activeDepotId, setActiveDepotId] = useState<number | null>(null);
  const [allocationOpen, setAllocationOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [glossaryQuery, setGlossaryQuery] = useState("");
  const [hintsOpen, setHintsOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [hintCount, setHintCount] = useState(0);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupState, setBackupState] = useState<BackupStatus | null>(null);
  const [dataState, setDataState] = useState<DataStatus | null>(null);
  const restored = useRef(false);
  const [orderbookOpen, setOrderbookOpen] = useState(false);
  const [scrollTo, setScrollTo] = useState<{ id: string; n: number } | null>(null);
  const narrow = useNarrow();
  const socket = useRef<Socket | null>(null);
  const runningRef = useRef(false);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  useEffect(() => {
    listSimulations()
      .then((list) => {
        setSimulations(list);
        initGuide(list.length);
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

  // The status line shows the last daily backup; read at the start and whenever the dialog closes.
  useEffect(() => {
    if (!backupOpen) getBackupStatus().then(setBackupState).catch(() => setBackupState(null));
  }, [backupOpen]);

  // The light in the top bar (#49): read at the start, every minute, and when the data view says something changed.
  const readLight = useCallback(() => { getDataStatus().then(setDataState).catch(() => setDataState(null)); }, []);
  useEffect(() => {
    readLight();
    const timer = setInterval(readLight, 60_000);
    return () => clearInterval(timer);
  }, [readLight]);

  const onMessage = useCallback((m: ServerMessage) => {
    if (m.type === "snapshot") {
      setSnapshot(m);
    } else if (m.type === "tick") {
      setSnapshot((prev) =>
        prev && {
          ...prev, running: m.running, depots: m.depots, prices: m.prices, fx: m.fx, venues: m.venues, venueClosed: m.venueClosed,
          liveLimit: m.liveLimit, delayS: m.delayS, phase: m.phase,
          simulation: { ...prev.simulation, simulationTime: m.simulationTime },
        },
      );
      const fresh = m.newBars[symbolRef.current];
      if (fresh?.length) {
        setBars((prev) => {
          const last = prev.length ? prev[prev.length - 1].t : -1;
          const next = [...prev, ...fresh.filter((b) => b.t > last)];
          const cap = Math.max(2000, Math.round(rawLimitRef.current * 1.2));
          return next.length > cap ? next.slice(-cap) : next;
        });
      }
    } else {
      setNotice(m.text);
    }
  }, []);

  useEffect(() => rememberSelection(selectedId), [selectedId]);

  // A palette command that points at a section: scrolled to once the section is on screen.
  useEffect(() => {
    if (!scrollTo) return;
    const el = document.getElementById(scrollTo.id) ?? document.querySelector(`[data-testid='${scrollTo.id}']`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [scrollTo, view]);

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
      } else if (e.key === "g") {
        e.preventDefault();
        setGlossaryOpen(true);
      } else if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
      } else if (/^[1-4]$/.test(e.key) && socket.current) {
        e.preventDefault();
        socket.current.send({ type: "tempo", tempo: ([1, 5, 30, 60] as const)[Number(e.key) - 1] });
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
    // Another title or simulation: the old bars must not stay on the chart while the new ones load.
    const barsFor = `${selectedId}|${symbol}`;
    if (barsFor !== barsKey.current) { barsKey.current = barsFor; setBars([]); }
    if (selectedId === null) return;
    let current = true;
    getBars(selectedId, symbol, rawLimit)
      .then((b) => current && setBars(b))
      .catch((e) => current && setNotice(e.message));
    return () => { current = false; };
  }, [selectedId, symbol, rawLimit]);

  function changeChartPrefs(p: ChartPrefs) {
    setChartPrefs(p);
    try {
      localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(p));
    } catch { /* the choice then lasts only until the page is closed */ }
  }

  async function create(input: Parameters<typeof createSimulation>[0]) {
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

  async function newDepot() {
    if (selectedId === null) return;
    try {
      const depot = await addDepot(selectedId);
      setActiveDepotId(depot.id);
      setNotice(null);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  async function newGhost() {
    const source = snapshot && pickDepot(snapshot.depots, activeDepotId);
    if (selectedId === null || !source) return;
    const check = canGhost(source);
    if (!check.ok) return setNotice(check.reason);
    try {
      const ghost = await addGhost(selectedId, source.id);
      setActiveDepotId(ghost.id);
      setNotice(null);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  function runCommand(id: CommandId) {
    if (id === "backfill") return setBackfillOpen(true);
    if (id === "backup") return setBackupOpen(true);
    if (id === "guide") return restartGuide();
    if (id === "glossary") return setGlossaryOpen(true);
    if (id === "ghost") return void newGhost();
    if (id === "longterm") return setView("longterm");
    if (id === "data") return setView("data");
    if (id === "orderbook") {
      setView("trade");
      setOrderbookOpen((o) => !o);
      return setScrollTo((c) => ({ id: "orderbook-toggle", n: (c?.n ?? 0) + 1 }));
    }
    setView("evaluation");
    setScrollTo((c) => ({ id: id === "journal" ? "journal" : "compare", n: (c?.n ?? 0) + 1 }));
  }

  async function renameActive(id: number, name: string) {
    if (selectedId === null) return;
    try {
      await renameDepot(selectedId, id, name);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  async function removeActive(id: number) {
    if (selectedId === null) return;
    try {
      await removeDepot(selectedId, id);
      setActiveDepotId(null);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  async function chooseBenchmark(symbol: string | null) {
    if (selectedId === null) return;
    try {
      const sim = await setBenchmark(selectedId, symbol);
      setSimulations((prev) => prev.map((x) => (x.id === sim.id ? sim : x)));
      setSnapshot((prev) => prev && { ...prev, simulation: sim });
      if (symbol) markSeen("benchmark");
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
  const depot = snapshot ? pickDepot(snapshot.depots, activeDepotId) : undefined;
  const isGhost = depot?.kind === "ghost";
  const fills = useMemo<Fill[]>(() => (depot?.orders ?? []).flatMap((o) =>
    o.status === "filled" && o.symbol === symbol && o.filledSim !== undefined && o.fillPrice !== undefined
      ? [{ t: o.filledSim, side: o.side, price: o.fillPrice, qty: o.qty }] : []), [depot?.orders, symbol]);
  // The signals follow what the server did with the orders: an order that fills, a limit that is reached, one that is refused.
  const seenOrders = useRef<{ key: string; status: Map<number, string> } | null>(null);
  useEffect(() => {
    applyMotion(feedbackPrefs());
  }, []);
  useEffect(() => {
    if (!depot || !live) return;
    const key = `${live.id}:${depot.id}`;
    const now = new Map(depot.orders.map((o) => [o.id, o.status] as [number, string]));
    const before = seenOrders.current;
    seenOrders.current = { key, status: now };
    if (!before || before.key !== key) return; // the first look at a depot only remembers
    for (const o of depot.orders) {
      const was = before.status.get(o.id);
      if (was === o.status || (was === undefined && o.status === "open")) continue;
      if (o.status === "filled") feedback(o.kind === "limit" && was === "open" ? "limit" : o.side);
      else if (o.status === "rejected") feedback("rejected");
    }
  }, [depot?.orders]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (view === "evaluation") markSeen("evaluation"); }, [view]);
  const locked = live === null || live.endedAt !== null || snapshot === null;

  return (
    <div className={`app${narrow && live ? " with-bar" : ""}`}>
      <header className="topbar">
        <h1 className="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="var(--accent)" />
            <path d="M6 22 L12 15 L17 19 L22 11 L26 9" fill="none" stroke="var(--accent-text)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          DepoSim
        </h1>
        {live && (
          <span className={`pill${snapshot?.running ? " on" : ""}`} data-testid="top-status">
            <span className="dot" aria-hidden="true" />
            {live.endedAt !== null ? "beendet" : snapshot?.running ? "läuft" : "angehalten"}
          </span>
        )}
        <span className="spacer" />
        {dataState && (() => {
          const line = lightLine(dataState);
          return (
            <button className={`btn small light-btn ${dataState.level}`} data-testid="data-status" data-level={dataState.level}
              onClick={() => setView("data")} title={line.title} aria-label={`${line.text}. Datenzustand öffnen`}>
              <span className={`light ${dataState.level}`} aria-hidden="true" />{narrow ? "" : line.text}
            </button>
          );
        })()}
        {backupState && (() => {
          // On a phone the bar has no room: the line shows only when something is wrong; the palette opens the dialog.
          const line = backupLine(backupState, Date.now() / 1000);
          if (narrow && !line.bad) return null;
          return (
            <button className={`btn small${line.bad ? " error" : ""}`} data-testid="backup-status" onClick={() => setBackupOpen(true)}
              title={line.text}>{narrow ? (line.bad ? "Sicherung !" : "Sicherung") : line.text}</button>
          );
        })()}
        {live && depot && (
          <button className="btn small" data-testid="hints-open" onClick={() => setHintsOpen(true)}
            aria-label={`Hinweise: ${hintCount}`} title="Hinweise und Einstellungen">Hinweise{hintCount > 0 && <span className="badge warn" data-testid="hints-count">{hintCount}</span>}</button>
        )}
        <button className="btn small" data-testid="feedback-open" onClick={() => setFeedbackOpen(true)} aria-label="Rückmeldung einstellen" title="Ton, Vibration, Bewegung">Ton</button>
        <button className="btn small" data-testid="palette-open" onClick={() => setPaletteOpen(true)}
          aria-label="Suche und Befehle öffnen (Strg+K)" title="Strg+K">Suche</button>
        <button className="btn small" data-testid="theme-toggle" onClick={toggle} aria-label="Hell oder Dunkel umschalten">
          {theme === "dark" ? "Hell" : "Dunkel"}
        </button>
      </header>

      <div className="layout">
        <div className="stack side">
          <Collapsible narrow={narrow} title="Simulationen" openByDefault={selectedId === null}>
            <SimulationPicker
              simulations={simulations} selectedId={selectedId} onSelect={setSelectedId}
              onCreate={create} onEnd={end} onDelete={remove}
            />
          </Collapsible>
          {live && (
            <>
            <Collapsible narrow={narrow} title="Watchlist">
              <Watchlist instruments={watchlist} prices={snapshot?.prices ?? {}} venues={snapshot?.venues} venueClosed={snapshot?.venueClosed}
                selected={symbol} onSelect={setSymbol} onRemove={removeTitle} onBackfill={() => setBackfillOpen(true)} showBackfill={!narrow} />
            </Collapsible>
            {narrow && <button className="btn" data-testid="backfill-open" onClick={() => setBackfillOpen(true)}>Fehlende Kurse nachladen</button>}
            </>
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
                  rules={live.rules}
                  onTempo={(t) => socket.current?.send({ type: "tempo", tempo: t })}
                  onRun={() => { setNotice(null); socket.current?.send({ type: "run" }); }}
                  onPause={() => socket.current?.send({ type: "pause" })}
                />
              </section>
              <div className="tabs" role="tablist" aria-label="Ansicht">
                <button role="tab" className="btn" aria-selected={view === "trade"}
                  onClick={() => setView("trade")}>Handel</button>
                <button role="tab" className="btn" data-guide="tab-evaluation" aria-selected={view === "evaluation"}
                  onClick={() => setView("evaluation")}>Auswertung</button>
                <button role="tab" className="btn" aria-selected={view === "longterm"}
                  onClick={() => setView("longterm")}>Langzeitvergleich</button>
                <button role="tab" className="btn" aria-selected={view === "data"}
                  onClick={() => setView("data")}>Daten</button>
              </div>
              {snapshot && depot && view !== "longterm" && view !== "data" && (
                <DepotSwitch depots={snapshot.depots} activeId={depot.id} disabled={locked}
                  onSelect={setActiveDepotId} onAdd={newDepot} onRename={renameActive} onRemove={removeActive}
                  onAllocate={() => setAllocationOpen(true)} onGhost={() => void newGhost()} />
              )}
              {depot && (
                <Hints simulationId={live.id} depotId={depot.id} running={snapshot?.running ?? false} showCard={view === "trade"}
                  version={depot.orders.filter((o) => o.status === "filled").length} settingsOpen={hintsOpen} onSettings={setHintsOpen}
                  onCount={setHintCount} onWhy={(q) => { setGlossaryQuery(q); setGlossaryOpen(true); }} />
              )}
              {view === "data" ? (
                <DataView onChanged={readLight} />
              ) : view === "longterm" ? (
                <Longterm theme={theme} />
              ) : view === "trade" ? (
                <>
              <section className="card">
<Chart bars={bars} prefs={chartPrefs} onPrefs={changeChartPrefs} fills={fills} theme={theme}
                  simulationId={live.id} symbol={symbol}
                  lead={(
                    <div className="lead">
                      <select aria-label="Wertpapier" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                        {watchlist.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol} · {i.name}</option>)}
                      </select>
                      {price && instrument && (
                        <span className="num last" data-testid="last-price">{formatPrice(price.price, instrument.currency)}</span>
                      )}
                    </div>
                  )} />
              </section>
              <div className="trade-grid">
                <div className="stack">
                  {isGhost ? (
                    <section className="card" aria-label="Orderticket gesperrt" data-testid="ghost-no-ticket">
                      <h2>Order</h2>
                      <p className="muted">Ein Geisterdepot handelt nicht. Wechsle zu einem normalen Depot, um Orders zu legen.</p>
                    </section>
                  ) : (
                    <OrderTicket simulationId={live.id} depotId={depot?.id} instrument={instrument} priceKey={price?.barT}
                      disabled={locked} command={ticketCommand} />
                  )}
                  <OrderbookPanel simulationId={live.id} instrument={instrument} simulationTime={live.simulationTime}
                    open={orderbookOpen} onToggle={() => setOrderbookOpen((o) => !o)} />
                </div>
                {depot && <DepotPanel depot={depot} startCash={live.startCash} />}
              </div>
              {depot && !isGhost && (
                <OrdersPanel orders={depot.orders} instruments={watchlist} disabled={locked} onCancel={cancel} />
              )}
                </>
              ) : (
                snapshot && depot && (
                  <>
                    <Curves simulationId={live.id} depots={snapshot.depots} simulationTime={live.simulationTime} theme={theme}
                      instruments={watchlist} benchmark={live.benchmark}
                      benchmarkPrice={live.benchmark ? snapshot.prices[live.benchmark]?.price : undefined}
                      onBenchmark={chooseBenchmark} />
                    <Evaluation simulationId={live.id} activeDepotId={depot.id} running={snapshot.running}
                      benchmark={live.benchmark} rules={live.rules} />
                    <Journal simulationId={live.id} depot={depot} running={snapshot.running} />
                    <Compare simulations={simulations} initial={[live.id]} theme={theme} />
                  </>
                )
              )}
            </>
          ) : view === "data" ? (
            <DataView onChanged={readLight} onClose={() => setView("trade")} />
          ) : view === "longterm" ? (
            <Longterm theme={theme} />
          ) : (
            <section className="card"><p className="muted">Wähle oder lege links eine Simulation an.</p></section>
          )}
        </main>
      </div>
      {live && depot && (
        <AllocationDialog open={allocationOpen} simulationId={live.id} depotId={depot.id} depotName={depot.name}
          instruments={watchlist} onClose={() => setAllocationOpen(false)} />
      )}
      {narrow && live && (
        <MobileBar disabled={locked} tradeDisabled={isGhost} running={snapshot?.running ?? false}
          onBuy={() => { setView("trade"); setTicketCommand((c) => ({ side: "buy", n: c.n + 1 })); }}
          onSell={() => { setView("trade"); setTicketCommand((c) => ({ side: "sell", n: c.n + 1 })); }}
          onToggleRun={() => socket.current?.send({ type: runningRef.current ? "pause" : "run" })} />
      )}
      <BackupDialog open={backupOpen} simulationId={selectedId}
        onClose={() => { setBackupOpen(false); if (restored.current) window.location.reload(); }}
        onChanged={(what) => {
          if (what === "restored") restored.current = true; // the page is read again when the dialog closes
          else listSimulations().then(setSimulations).catch((e) => setNotice(e.message));
        }} />
      <BackfillDialog open={backfillOpen} onClose={() => setBackfillOpen(false)} />
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Guide started={live !== null && live.simulationTime > live.startAt} simulations={simulations.length}
        orders={(depot?.orders ?? []).map((o) => ({ side: o.side, kind: o.kind, status: o.status }))} />
      <FeedbackSettings open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      <Glossary open={glossaryOpen} initialQuery={glossaryQuery} onClose={() => { setGlossaryOpen(false); setGlossaryQuery(""); }} />
      <Palette
        open={paletteOpen} instruments={watchlist} simulations={simulations} selectedId={selectedId}
        onClose={() => setPaletteOpen(false)} onPickInstrument={setSymbol} onPickSimulation={setSelectedId}
        onToggleTheme={toggle} onShowHelp={() => setHelpOpen(true)} onAdd={addTitle}
        commands={selectedId === null ? ["backfill", "backup", "longterm", "data", "glossary", "guide"] : ["backfill", "backup", "ghost", "journal", "compare", "orderbook", "longterm", "data", "glossary", "guide"]} onCommand={runCommand}
      />
    </div>
  );
}
