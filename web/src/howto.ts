/**
 * "So wird gespielt" (#57): the manual of the game as data. Every worked example carries a `check`
 * that `web/test/howto.test.ts` recomputes with the engine, and the figures in its text must match
 * that result. If the fee model or a rule changes, the test fails and the text has to follow.
 */

export type Check =
  | {
      kind: "cost";
      side: "buy" | "sell";
      qty: number;
      price: number;
      order: "market" | "limit";
      limit?: number;
      /** USD per EUR; given: the instrument is quoted in USD. */
      eurUsd?: number;
      preset?: "relaxed" | "hardcore";
      /** Cents. */
      expect: { gross: number; commission: number; foreign: number; total: number };
    }
  | { kind: "limit"; side: "buy" | "sell"; limit: number; low: number; high: number; fires: boolean }
  | { kind: "gap"; close: number; open: number; text: string };

export interface Example {
  id: string;
  title: string;
  text: string;
  check: Check;
}

export interface Chapter {
  id: string;
  title: string;
  /** Plain paragraphs. */
  body: string[];
  examples: Example[];
  /** Glossary entries that explain the figures this chapter mentions. */
  see?: string[];
  /** Other names the search should find. */
  aliases?: string[];
}

export const HOWTO: Chapter[] = [
  {
    id: "idea", title: "Spielidee und Ziel",
    body: [
      "DepoSim lässt dich ein Depot durch echte Kursverläufe der Vergangenheit (oder zeitversetzt der Gegenwart) führen. Du kaufst und verkaufst, die Uhr läuft, Gebühren und Spread kosten wie im echten Handel.",
      "Es gibt keinen Punktestand, den man jagen müsste. Das Ziel ist zu sehen, wie deine Entscheidungen im Vergleich abschneiden: gegen einen Maßstab (zum Beispiel einen Index-ETF), gegen das Geisterdepot, das ohne deine Eingriffe weitergelaufen wäre, und gegen deine eigene frühere Runde.",
      "Alles ist Übung mit Spielgeld. Nichts davon ist Anlageberatung, und gute Ergebnisse in der Vergangenheit sagen nichts über die Zukunft.",
    ],
    examples: [],
    see: ["return", "fees"],
    aliases: ["ziel", "überblick", "einführung", "geisterdepot", "maßstab"],
  },
  {
    id: "setup", title: "Simulation anlegen",
    body: [
      "Mit „Neue Simulation“ wählst du Startkapital, Startzeitpunkt und Regeln. Eine Simulation ist ein Spielstand: Du kannst mehrere nebeneinander führen und später vergleichen.",
      "Liegt der Startzeitpunkt in der Vergangenheit, spielst du Kerze für Kerze nach. Mit Livebetrieb folgt die Simulation der Gegenwart mit Zeitversatz, und beim Aufholen läuft sie schnell bis zum jetzigen Stand.",
      "Die Schwierigkeitsgrade sind feste Regelpakete, die beim Anlegen gewählt werden und danach nicht mehr wechseln: Entspannt und Realistisch rechnen Gebühren und Spread wie im Modell, Pause und Tempo sind frei. Hardcore verdoppelt Spread und Gebühren, erlaubt keine Pause, hält das Tempo fest und lässt Orders nur bei laufender Uhr zu. Einzelne Schalter lassen sich ändern, dann heißt das Paket „Eigene Regeln“.",
    ],
    examples: [
      {
        id: "hardcore-cost",
        title: "Dieselbe Order unter Hardcore",
        text: "100 Stück zu 48,20 € per Market-Order kosten unter Entspannt 4.834,47 € (Gebühr 12,06 €). Unter Hardcore sind Spread und Gebühr doppelt: Ausführung zu 48,2482 €, Kurswert 4.824,82 €, Gebühr 24,12 €, zusammen 4.848,94 €. Das sind 14,47 € mehr für dieselbe Order.",
        check: { kind: "cost", side: "buy", qty: 100, price: 48.2, order: "market", preset: "hardcore", expect: { gross: 482482, commission: 2412, foreign: 0, total: 484894 } },
      },
    ],
    aliases: ["schwierigkeit", "entspannt", "realistisch", "hardcore", "regeln", "startkapital", "live", "aufholen"],
  },
  {
    id: "clock", title: "Uhr und Zeitsteuerung",
    body: [
      "Start und Pause (Leertaste) lassen die Uhr laufen oder halten sie an. Das Tempo wählst du mit den Tasten 1 bis 4 (1x, 5x, 30x, 60x). Bei Tageskursen geht die Taste „.“ einen Tag weiter, bei Minutenkursen eine Kerze.",
      "Über die Befehlspalette (Strg + K) springst du zum nächsten Ereignis: eine Stunde weiter, bis Handelsschluss, bis Eröffnung oder bis zum nächsten Tag. Die Uhr hält dort an.",
      "Die Auto-Pause stoppt die Uhr von selbst, wenn etwas geschieht: eine Order wurde ausgeführt, der Kurs kommt nah an ein Limit, ein Titel springt, ein Markt öffnet oder eine Dividende oder ein Split wird gebucht. Alle Schalter sind zu Beginn aus. Unter Hardcore gibt es keine Pause, keine Sprünge und keine Auto-Pause.",
    ],
    examples: [],
    aliases: ["pause", "tempo", "sprung", "auto-pause", "zeit", "leertaste"],
  },
  {
    id: "orders", title: "Orders: Market, Limit und Gebühren",
    body: [
      "Eine Market-Order wird sofort zum aktuellen Kurs ausgeführt, mit kleinem Aufschlag beim Kauf und Abschlag beim Verkauf (Spread, 0,05 % im Modell). Eine Limit-Order nennt einen Preis und wartet. Ein Kauf-Limit löst aus, wenn das Tief einer Kerze das Limit erreicht, ein Verkauf-Limit, wenn das Hoch es erreicht. Ausgeführt wird dann zum Limit.",
      "Die Provision beträgt 0,25 % des Kurswerts, mindestens 4,90 € und höchstens 59,90 €. Wertpapiere in US-Dollar kosten zusätzlich 14,90 € Fremdentgelt und 0,5 % Aufschlag auf den Umrechnungskurs. Die Zahlen sind Platzhalter des Modells, kein Preisverzeichnis eines Brokers.",
      "Das Orderticket zeigt die Kosten vorab. Offene Limit-Orders reservieren kein Guthaben: Geprüft wird erst bei der Ausführung. Du kannst nur verkaufen, was du hältst, abzüglich dessen, was in offenen Verkaufsorders steckt.",
    ],
    examples: [
      {
        id: "market-buy",
        title: "Market-Kauf",
        text: "100 Stück bei einem Kurs von 48,20 €. Ausführung zu 48,2241 € (Spread 0,05 %), Kurswert 4.822,41 €, Provision 12,06 € (0,25 %). Es fließen 4.834,47 € ab.",
        check: { kind: "cost", side: "buy", qty: 100, price: 48.2, order: "market", expect: { gross: 482241, commission: 1206, foreign: 0, total: 483447 } },
      },
      {
        id: "limit-buy",
        title: "Limit-Kauf zum selben Kurs",
        text: "100 Stück mit Limit 48,20 €. Ausführung genau zum Limit: Kurswert 4.820,00 €, Provision 12,05 €, zusammen 4.832,05 €. Das sind 2,42 € weniger als beim Market-Kauf, dafür wartet die Order womöglich vergeblich.",
        check: { kind: "cost", side: "buy", qty: 100, price: 48.2, order: "limit", limit: 48.2, expect: { gross: 482000, commission: 1205, foreign: 0, total: 483205 } },
      },
      {
        id: "limit-fires",
        title: "Wann löst ein Kauf-Limit aus?",
        text: "Dein Kauf-Limit liegt bei 48,20 €. Eine Kerze mit Tief 48,10 € und Hoch 48,60 € löst es aus, denn das Tief erreicht das Limit. Eine Kerze mit Tief 48,25 € löst es nicht aus, auch wenn der Kurs nah dran war.",
        check: { kind: "limit", side: "buy", limit: 48.2, low: 48.1, high: 48.6, fires: true },
      },
      {
        id: "min-fee",
        title: "Kleine Order, Mindestgebühr",
        text: "10 Stück zu 48,20 € per Market-Order: Kurswert 482,24 €. 0,25 % wären 1,21 €, es gilt aber die Mindestprovision von 4,90 €. Zusammen 487,14 €. Die Gebühr frisst hier gut 1 % des Einsatzes. Viele kleine Orders sind deshalb teuer.",
        check: { kind: "cost", side: "buy", qty: 10, price: 48.2, order: "market", expect: { gross: 48224, commission: 490, foreign: 0, total: 48714 } },
      },
      {
        id: "usd-buy",
        title: "Kauf in US-Dollar",
        text: "10 Stück zu 200 $ bei einem Kurs von 1,10 $ je Euro. Ausführung zu 200,10 $, der Umrechnungskurs wird mit 0,5 % Aufschlag zu 1,0945 gerechnet. Kurswert 1.828,23 €, Provision 4,90 €, Fremdentgelt 14,90 €, zusammen 1.848,03 €.",
        check: { kind: "cost", side: "buy", qty: 10, price: 200, order: "market", eurUsd: 1.1, expect: { gross: 182823, commission: 490, foreign: 1490, total: 184803 } },
      },
      {
        id: "market-sell",
        title: "Verkauf",
        text: "Du hast die 100 Stück bei 52,00 € im Markt. Ausführung zu 51,974 € (Abschlag 0,05 %), Kurswert 5.197,40 €, Provision 12,99 €. Es fließen 5.184,41 € zu.",
        check: { kind: "cost", side: "sell", qty: 100, price: 52, order: "market", expect: { gross: 519740, commission: 1299, foreign: 0, total: 518441 } },
      },
    ],
    see: ["fees"],
    aliases: ["order", "kaufen", "verkaufen", "limit", "market", "spread", "provision", "gebühren", "orderbuch", "handelsplatz", "kosten", "fremdwährung", "dollar"],
  },
  {
    id: "chart", title: "Chart lesen",
    body: [
      "Eine Kerze zeigt Eröffnung, Hoch, Tief und Schluss eines Zeitraums. Den Zeitraum wählst du über dem Chart. Linie, Heikin-Ashi sowie logarithmische und prozentuale Skala sind Darstellungen derselben Kurse.",
      "Indikatoren (Durchschnitte, RSI, MACD, Bollinger, ATR und andere) fassen den bisherigen Kursverlauf zusammen. Sie sehen nie in die Zukunft: Jeder Wert nutzt nur Kerzen bis zur aktuellen Zeit. Zeichenwerkzeuge markieren Preise und Zeiten, die du beobachten willst. Deine Orders erscheinen als Markierungen im Chart.",
      "Das Orderbuch ist ein Bild, aus der letzten Kerze abgeleitet, keine echte Markttiefe. Es ist als „simuliert“ gekennzeichnet und beeinflusst weder Ausführung noch Gebühren.",
    ],
    examples: [],
    aliases: ["kerze", "zeitrahmen", "indikator", "sma", "ema", "rsi", "macd", "zeichnen", "chart", "heikin"],
  },
  {
    id: "events", title: "Ereignisse: Dividenden, Splits und Kurslücken",
    body: [
      "Zahlt ein Titel eine Dividende oder teilt er seine Aktien, bucht DepoSim das im Depot und markiert es im Chart. Dividenden stehen zusätzlich im Kalender mit den Einnahmen. Der Kurs allein täuscht: Am Ex-Tag fällt er um etwa die Dividende, ohne dass du Geld verloren hättest.",
      "Eine Kurslücke entsteht, wenn ein Tag mit mindestens 3 % Abstand zum Schluss davor eröffnet, etwa nach Nachrichten über Nacht. Ein Preis in der Lücke wird nie gehandelt.",
    ],
    examples: [
      {
        id: "gap",
        title: "Kurslücke",
        text: "Ein Titel schließt bei 50,00 € und eröffnet am nächsten Tag bei 52,00 €. Das ist +4,0 % und damit eine Lücke. Zwischen 50 und 52 € wurde nie gehandelt, ein Limit dort wäre übersprungen worden.",
        check: { kind: "gap", close: 50, open: 52, text: "Kurslücke ABC +4,0 %: Eröffnung 52,00 nach Schluss 50,00" },
      },
    ],
    aliases: ["dividende", "split", "lücke", "gap", "ausschüttung", "ex-tag"],
  },
  {
    id: "scenarios", title: "Szenarien, Sterne und Rundenabschluss",
    body: [
      "Ein Szenario ist eine vorbereitete Runde mit Aufgabe und Ziel, zum Beispiel ein Crash, den du überstehen sollst. Am Ende gibt es Sterne für das Ergebnis.",
      "Der Rundenabschluss gibt eine Note und legt die Runde ins Rundenbuch. Daraus lässt sich eine teilbare Ergebniskarte erzeugen. Die Formel der Note steht beim Abschluss.",
    ],
    examples: [],
    see: ["return", "maxDrawdown"],
    aliases: ["szenario", "sterne", "note", "runde", "rundenbuch", "ergebniskarte", "crash"],
  },
  {
    id: "evaluation", title: "Auswertung und Journal",
    body: [
      "Die Auswertung stellt dein Depot dem Maßstab gegenüber und zeigt Kennzahlen zu Rendite, Schwankung und Rückgang. Hinter jeder Zahl steht ein (i)-Knopf; das Glossar (Taste G) erklärt alle.",
      "Das Journal führt jeden abgeschlossenen Trade mit Trefferquote, Haltedauer und Gebührenbilanz. Die Trade-Nachbetrachtung zeigt, wie weit der Kurs während der Haltezeit gegen und für dich lief.",
      "Zahlen aus kurzer Zeit sind Zufall. Das Etikett „zu früh zu sagen“ warnt, wenn zu wenig Werte vorliegen.",
    ],
    examples: [],
    see: ["maxDrawdown", "sharpe", "hitRate", "fees"],
    aliases: ["auswertung", "journal", "kennzahlen", "trefferquote", "maßstab", "benchmark", "trade", "nachbetrachtung"],
  },
  {
    id: "mistakes", title: "Häufige Fehler",
    body: [
      "Zu viele Trades: Jede Order kostet Spread und Provision, bei kleinen Beträgen die Mindestgebühr. Das Umschlag-Maß in der Verhaltensanalyse zeigt, wie viel du umschichtest.",
      "Gewinne früh mitnehmen, Verluste laufen lassen: Das ist der Dispositionseffekt. Die Verhaltensanalyse prüft ihn an deinen eigenen Trades.",
      "Alles auf einen Titel: Ein Klumpen macht das Depot abhängig von einer Nachricht. Die Hinweise-Zentrale meldet Klumpen, hohe Kosten, tiefe Rückgänge und Verlustserien.",
      "Aus wenigen Trades Schlüsse ziehen: Fünf Gewinne hintereinander sind noch keine Strategie.",
    ],
    examples: [],
    see: ["turnover", "disposition", "concentration"],
    aliases: ["fehler", "tipps", "verhalten", "dispositionseffekt", "umschlag", "klumpen"],
  },
];

export function chapterOf(id: string): Chapter | undefined {
  return HOWTO.find((c) => c.id === id);
}

const fold = (s: string) => s.toLowerCase();

/** Chapters whose title, aliases, text or examples contain the query; title matches first. Empty query: all. */
export function searchHowto(query: string): Chapter[] {
  const q = fold(query.trim());
  if (q === "") return HOWTO;
  const hit = (c: Chapter) => ({
    title: fold(c.title).includes(q) || (c.aliases ?? []).some((a) => fold(a).includes(q)),
    text: c.body.some((p) => fold(p).includes(q)) || c.examples.some((e) => fold(e.title + " " + e.text).includes(q)),
  });
  const found = HOWTO.map((c) => ({ c, h: hit(c) })).filter(({ h }) => h.title || h.text);
  return [...found.filter(({ h }) => h.title), ...found.filter(({ h }) => !h.title)].map(({ c }) => c);
}
