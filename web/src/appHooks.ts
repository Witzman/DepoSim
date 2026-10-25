import { useEffect, useRef, useState } from "react";
import { getMarketEvents } from "./api.js";
import { feedback } from "./feedback.js";
import type { DepotView, MarketEvent } from "./types.js";

/**
 * Dividends, splits and gaps of the shown symbol and of what the depot holds. Fetched when the day turns, the symbol changes or
 * the holdings do; nothing is newer than the clock. An event that was not there at the last look is told through `onNotice`.
 */
export function useMarketEvents(simulationId: number | null, symbol: string, heldKey: string, eventDay: number, onNotice: (text: string) => void): MarketEvent[] {
  const [events, setEvents] = useState<MarketEvent[]>([]);
  const seen = useRef<{ sim: number; keys: Set<string> } | null>(null);
  useEffect(() => {
    if (simulationId === null || !symbol) { setEvents([]); return; }
    const symbols = [...new Set([symbol, ...(heldKey ? heldKey.split(",") : [])])];
    let alive = true;
    getMarketEvents(simulationId, symbols).then((list) => {
      if (!alive) return;
      setEvents(list);
      const before = seen.current;
      const keys = new Set(list.map((e) => e.key));
      seen.current = { sim: simulationId, keys };
      if (!before || before.sim !== simulationId) return; // the first look at a simulation only remembers
      const fresh = list.filter((e) => !before.keys.has(e.key));
      if (fresh.length === 0) return;
      onNotice(fresh.length === 1 ? fresh[0].text : `${fresh.length} neue Ereignisse: ${fresh.map((e) => e.text).join(" · ")}`);
      feedback("event");
    }).catch(() => {});
    return () => { alive = false; };
  }, [simulationId, symbol, heldKey, eventDay]); // eslint-disable-line react-hooks/exhaustive-deps
  return events;
}

/** The signals follow what the server did with the orders: an order that fills, a limit that is reached, one that is refused. */
export function useOrderSignals(simulationId: number | null, depot: DepotView | undefined): void {
  const seen = useRef<{ key: string; status: Map<number, string> } | null>(null);
  useEffect(() => {
    if (!depot || simulationId === null) return;
    const key = `${simulationId}:${depot.id}`;
    const now = new Map(depot.orders.map((o) => [o.id, o.status] as [number, string]));
    const before = seen.current;
    seen.current = { key, status: now };
    if (!before || before.key !== key) return; // the first look at a depot only remembers
    for (const o of depot.orders) {
      const was = before.status.get(o.id);
      if (was === o.status || (was === undefined && o.status === "open")) continue;
      if (o.status === "filled") feedback(o.kind === "limit" && was === "open" ? "limit" : o.side);
      else if (o.status === "rejected") feedback("rejected");
    }
  }, [depot?.orders]); // eslint-disable-line react-hooks/exhaustive-deps
}
