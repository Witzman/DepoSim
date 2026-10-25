import type { Metrics } from "./types.js";

/**
 * What every figure of the evaluation and the journal means. The texts follow the doc comments of
 * `server/src/domain/metrics.ts` and `domain/journal.ts`; where the implementation differs from the
 * textbook (no risk-free rate, historical VaR) the text says so. `rule` is a rule of thumb for
 * orientation, never advice.
 */
export interface Entry {
  id: string;
  name: string;
  /** One sentence in plain words. */
  short: string;
  /** How the figure comes about, in words. */
  how: string;
  rule?: string;
  pitfall?: string;
  /** Other names the search should find. */
  aliases?: string[];
}

export const GLOSSARY: Entry[] = [
  {
    id: "return", name: "Rendite",
    short: "Um wie viel das Depot seit dem Start gewachsen oder geschrumpft ist.",
    how: "Letzter Punkt der Depotkurve durch ersten Punkt, minus 1.",
    pitfall: "Sie sagt nichts über das Risiko, mit dem sie erzielt wurde, und nicht, wie lange es dauerte. 5 % in einer Woche und 5 % in einem Jahr sind sehr verschieden.",
  },
  {
    id: "basis", name: "Basis",
    short: "Die Zeitschritte, aus denen Volatilität, Sharpe und die anderen Risikozahlen berechnet sind.",
    how: "Es wird der gröbste Schritt genommen, der mindestens 10 Renditen liefert: Tageswerte, sonst Stundenwerte, sonst 5-Minuten-Werte (letzter Wert je Tag, Stunde oder 5 Minuten).",
    pitfall: "Die Hochrechnung auf ein Jahr nimmt 252 Handelstage zu etwa 8 Handelsstunden an. Aus 5-Minuten-Werten hochgerechnet schwanken die Zahlen stark; Werte verschiedener Basis sind nicht vergleichbar.",
    aliases: ["zeitbasis", "tageswerte", "stundenwerte"],
  },
  {
    id: "volatility", name: "Volatilität p. a.",
    short: "Wie stark der Depotwert schwankt, hochgerechnet auf ein Jahr.",
    how: "Standardabweichung der Schritt-Renditen der Basis, mal Wurzel aus der Zahl der Schritte pro Jahr.",
    rule: "Orientierung: ein breiter Aktienindex schwankt langfristig oft um 15 bis 20 % im Jahr; Einzelwerte meist mehr.",
    pitfall: "Sie zählt Auf- und Abwärtsschwankung gleich. Wenige Werte oder eine kurze Zeit machen sie unsicher.",
    aliases: ["schwankung", "standardabweichung"],
  },
  {
    id: "maxDrawdown", name: "Max. Rückgang",
    short: "Der tiefste Fall vom bisherigen Höchststand, in Prozent.",
    how: "Zu jedem Zeitpunkt: Wert durch bisheriges Maximum, minus 1. Der kleinste dieser Werte zählt. Alle Punkte der Kurve gehen ein, nicht nur die der Basis.",
    pitfall: "Sie ist der schlimmste Fall der bisherigen Zeit, nicht der schlimmstmögliche. Wer länger zuschaut, sieht meist einen tieferen.",
    aliases: ["drawdown", "rückgang", "verlust vom hoch"],
  },
  {
    id: "sharpe", name: "Sharpe-Ratio",
    short: "Wie viel Rendite das Depot je Einheit Schwankung brachte.",
    how: "Mittlere Schritt-Rendite, auf ein Jahr hochgerechnet, durch die Volatilität p. a. Abweichung vom Lehrbuch: ohne risikofreien Zins.",
    rule: "Faustwert, nur bei langer Zeitspanne: unter 0,5 schwach, 0,5 bis 1 mittel, über 1 gut.",
    pitfall: "Bei Wochen oder Monaten entscheidet der Zufall. Ein hoher Wert aus wenigen Tagen ist kein Können.",
    aliases: ["sharpe ratio"],
  },
  {
    id: "sortino", name: "Sortino-Ratio",
    short: "Wie Sharpe, aber nur Rückgänge zählen als Risiko.",
    how: "Mittlere Schritt-Rendite, hochgerechnet, durch die Abwärtsabweichung: Wurzel aus dem Mittel der quadrierten negativen Schritte (Schwelle 0 %), hochgerechnet. Ohne risikofreien Zins.",
    rule: "Faustwert: wie bei Sharpe gelesen, meist etwas höher, weil Gewinnschwankung nicht bestraft wird.",
    pitfall: "Gab es kaum Verlustschritte, ist der Nenner winzig und der Wert springt. Ohne Verlustschritt gibt es keinen Wert.",
  },
  {
    id: "calmar", name: "Calmar-Ratio",
    short: "Jahresrendite im Verhältnis zum größten Rückgang.",
    how: "Auf ein Jahr hochgerechnete Rendite durch den Betrag des maximalen Rückgangs. Ohne Rückgang gibt es keinen Wert.",
    rule: "Faustwert, nur bei langer Zeitspanne: über 1 heißt, die Jahresrendite war größer als der tiefste Fall.",
    pitfall: "Bei kurzer Laufzeit ist die Hochrechnung grob: 2 % in einer Woche ergeben hochgerechnet eine große, bedeutungslose Zahl.",
  },
  {
    id: "var95", name: "Value at Risk 95 %",
    short: "Der Verlust, den jeder zwanzigste Schritt erreicht oder übersteigt.",
    how: "Historisch: das 5-%-Quantil der eigenen Schritt-Renditen der Basis, je Schritt, nicht hochgerechnet. Ohne Verlustschritte gibt es keinen Wert.",
    pitfall: "Er sagt nichts über die Größe der seltenen schlimmsten Fälle jenseits der Grenze. Der Schritt ist ein Tag, eine Stunde oder 5 Minuten, je nach Basis.",
    aliases: ["var", "value at risk"],
  },
  {
    id: "bestStep", name: "Bester Schritt",
    short: "Der größte Gewinn in einem einzelnen Schritt der Basis.",
    how: "Größte Schritt-Rendite der Basis.",
    pitfall: "Ein Schritt ist je nach Basis ein Tag, eine Stunde oder 5 Minuten; die Zahlen verschiedener Basis passen nicht zusammen.",
  },
  {
    id: "worstStep", name: "Schlechtester Schritt",
    short: "Der größte Verlust in einem einzelnen Schritt der Basis.",
    how: "Kleinste Schritt-Rendite der Basis.",
    pitfall: "Er ist der schlechteste bisher gesehene, nicht der schlechteste mögliche.",
  },
  {
    id: "upShare", name: "Gewinnschritte",
    short: "Der Anteil der Schritte, in denen das Depot im Plus war.",
    how: "Schritte mit Rendite über 0 durch alle Schritte der Basis.",
    pitfall: "Viele kleine Gewinne und ein großer Verlust können 80 % ergeben und trotzdem ein Minus. Es zählt nur das Vorzeichen, nicht die Größe.",
  },
  {
    id: "beta", name: "Beta",
    short: "Wie stark das Depot den Schritten des Maßstabs folgt.",
    how: "Kovarianz der Depot- und Maßstab-Schritte durch die Varianz der Maßstab-Schritte, über die Schritte, die beide haben.",
    rule: "Orientierung: 1 bewegt sich wie der Maßstab, unter 1 ruhiger, über 1 stärker, nahe 0 unabhängig, negativ gegenläufig.",
    pitfall: "Beta ist nur so gut wie der Maßstab: gegen einen unpassenden Index sagt es wenig. Es misst die Bewegung, nicht die Güte.",
  },
  {
    id: "alpha", name: "Alpha p. a.",
    short: "Der Mehrertrag über das hinaus, was das Beta erklärt, hochgerechnet auf ein Jahr.",
    how: "(mittlere Depot-Rendite − Beta × mittlere Maßstab-Rendite) × Schritte pro Jahr. Ohne risikofreien Zins.",
    pitfall: "Bei kurzer Zeit ist Alpha überwiegend Zufall. Hochgerechnete Werte aus Wochen sind selten zu gebrauchen.",
  },
  {
    id: "trackingError", name: "Tracking Error",
    short: "Wie stark die Schritte des Depots von denen des Maßstabs abweichen.",
    how: "Standardabweichung der Differenz Depot minus Maßstab je Schritt, hochgerechnet auf ein Jahr.",
    pitfall: "Er ist hoch, wenn das Depot deutlich anders ist, nicht wenn es schlecht ist. Er sagt nichts über besser oder schlechter.",
  },
  {
    id: "informationRatio", name: "Information Ratio",
    short: "Wie viel Mehrrendite gegenüber dem Maßstab je Einheit Abweichung.",
    how: "Mittlere Differenz je Schritt, hochgerechnet, durch den Tracking Error.",
    rule: "Faustwert, nur bei langer Zeitspanne: über 0,5 gilt als gut, aber nur wenn es lange hält.",
    pitfall: "Bei wenigen Werten springt sie; ein Tracking Error nahe 0 macht sie unbrauchbar.",
  },
  {
    id: "hitShare", name: "Besser als Maßstab",
    short: "Der Anteil der Schritte, in denen das Depot besser war als der Maßstab.",
    how: "Schritte mit Depot-Rendite über Maßstab-Rendite durch alle gemeinsamen Schritte.",
    pitfall: "Zählt nur, wie oft, nicht, wie viel. Wer selten, aber stark gewinnt, kann bei 40 % vorn liegen.",
  },
  {
    id: "correlation", name: "Korrelation",
    short: "Wie gleichgerichtet sich zwei Depots bewegen, von −1 bis 1.",
    how: "Pearson-Korrelation der Schritt-Renditen über die Schritte, die beide haben, mit der gröbsten Basis, die mindestens 10 liefert.",
    rule: "Orientierung: nahe 1 bewegen sich beide gleich, nahe 0 unabhängig, nahe −1 gegenläufig.",
    pitfall: "Sie misst den Gleichlauf der Schritte, nicht der Höhe. In Krisen steigen Korrelationen oft, gerade dann, wenn man Streuung braucht.",
    aliases: ["gleichlauf", "pearson"],
  },
  {
    id: "hitRate", name: "Trefferquote",
    short: "Der Anteil der abgeschlossenen Trades, die netto im Plus endeten.",
    how: "Trades mit Netto-Gewinn nach Gebühren durch alle abgeschlossenen Trades. Ein Trade ist ein Kauf, der ganz oder teilweise verkauft wurde (FIFO).",
    pitfall: "Eine hohe Quote kann mit kleinen Gewinnen und großen Verlusten einhergehen. Erst mit dem Gewinn-Verlust-Verhältnis ergibt sie ein Bild. Unter 5 Trades sagt sie wenig.",
    aliases: ["trefferquote", "gewinnquote"],
  },
  {
    id: "holding", name: "Haltedauer",
    short: "Wie lange eine Position gehalten wurde, bis sie verkauft war.",
    how: "Zeit zwischen Kauf und Verkauf je Trade in Simulationszeit; angezeigt als Median (die Mitte) und Mittel (der Durchschnitt).",
    pitfall: "Einzelne sehr lange Trades ziehen das Mittel hoch. Der Median ist dann die ehrlichere Zahl. Offene Positionen zählen nicht.",
    aliases: ["haltedauer", "median"],
  },
  {
    id: "payoff", name: "Gewinn-Verlust-Verhältnis",
    short: "Wie groß der durchschnittliche Gewinn-Trade im Vergleich zum durchschnittlichen Verlust-Trade ist.",
    how: "Durchschnittlicher Netto-Gewinn der Gewinn-Trades durch den Betrag des durchschnittlichen Netto-Verlusts der Verlust-Trades.",
    rule: "Orientierung: über 1 heißt, Gewinne sind im Schnitt größer als Verluste. Zusammen mit der Trefferquote entscheidet es über den Erwartungswert.",
    pitfall: "Ohne Gewinn- oder ohne Verlust-Trade gibt es keinen Wert.",
  },
  {
    id: "avgWinLoss", name: "Ø Gewinn / Ø Verlust",
    short: "Der durchschnittliche Netto-Gewinn eines Gewinn-Trades und der durchschnittliche Netto-Verlust eines Verlust-Trades.",
    how: "Mittel der positiven und der negativen Netto-Ergebnisse, nach Gebühren.",
    pitfall: "Wenige Trades machen beide Zahlen zufällig; ein einzelner Ausreißer verschiebt sie stark.",
  },
  {
    id: "profitFactor", name: "Profitfaktor",
    short: "Wie viel Gewinn auf einen Euro Verlust kam.",
    how: "Summe aller Netto-Gewinne durch den Betrag der Summe aller Netto-Verluste. Ohne Verlust-Trade gibt es keinen.",
    rule: "Orientierung: über 1 heißt Plus insgesamt, unter 1 Minus.",
    pitfall: "Bei wenigen Trades entscheidet ein einzelner. Ein sehr hoher Wert nach drei Trades ist Zufall.",
  },
  {
    id: "expectancy", name: "Erwartungswert je Trade",
    short: "Was ein Trade im Schnitt netto gebracht hat.",
    how: "Summe aller Netto-Ergebnisse durch die Zahl der abgeschlossenen Trades, in Euro.",
    pitfall: "Er beschreibt die Vergangenheit, keine Zusage für den nächsten Trade. Mit wenigen Trades ist er unsicher.",
    aliases: ["erwartungswert", "expectancy"],
  },
  {
    id: "bestWorstTrade", name: "Bester / schlechtester Trade",
    short: "Der größte Netto-Gewinn und der größte Netto-Verlust eines einzelnen Trades.",
    how: "Größtes und kleinstes Netto-Ergebnis nach Gebühren.",
    pitfall: "Ein einzelner Ausreißer prägt oft die Gesamtbilanz; bei wenigen Trades dominiert er.",
  },
  {
    id: "losingStreak", name: "Längste Verlustserie",
    short: "Die meisten Verlust-Trades in Folge.",
    how: "In der Reihenfolge der Schließung gezählt; ein Trade mit Gewinn oder genau null setzt die Zählung zurück.",
    pitfall: "Auch bei einer guten Methode kommen Serien vor. Wer sie erlebt, sollte sie nicht gleich als Fehler der Methode lesen. Wenige Trades machen sie zufällig.",
    aliases: ["verlustserie"],
  },
  {
    id: "tooEarly", name: "Zu früh verkauft",
    short: "Wie oft der Kurs nach dem Verkauf noch deutlich stieg.",
    how: "Ein Verkauf zählt als zu früh, wenn der letzte Kurs des 1. oder 5. Handelstags danach mehr als 2 % über dem Verkaufskurs liegt. Verkäufe, deren Frist noch nicht erreicht ist, zählen nicht mit.",
    pitfall: "Das ist eine Beobachtung im Rückblick, keine Prognose. Ein Verkauf kann richtig sein, auch wenn der Kurs danach steigt.",
  },
  {
    id: "disposition", name: "Dispositionseffekt (PGR und PLR)",
    short: "Ob Gewinne eher mitgenommen werden als Verluste, obwohl beide gleich lange offen standen.",
    how: "An jedem Verkaufstag zählt der Simulator, wie viele Gewinne und Verluste realisiert wurden und wie viele auf dem Papier offen blieben (zum letzten Kurs des Tages gegen den Kaufkurs). PGR ist der Anteil realisierter an allen möglichen Gewinnen, PLR der Anteil realisierter an allen möglichen Verlusten. Das Verhältnis PGR zu PLR über 1 heißt: Gewinne werden eher verkauft als Verluste.",
    pitfall: "Nach Odean (1998) ein verbreitetes Muster bei Privatanlegern. Ein Verhältnis über 1 ist kein Beweis, mit wenigen Trades auch Zufall. Steuerliche oder Cash-Gründe können dahinterstehen.",
    aliases: ["pgr", "plr", "odean", "gewinne laufen lassen", "verluste aussitzen"],
  },
  {
    id: "turnover", name: "Umschlag",
    short: "Wie viel gehandelt wurde, gemessen an der Größe des Depots.",
    how: "Orders je Monat; Kaufvolumen je Jahr geteilt durch den mittleren Depotwert (1,0 heißt: einmal pro Jahr das ganze Depot gekauft); Gebühren je Trade; Gebührenanteil am Ergebnis vor Gebühren.",
    pitfall: "Viel Handel ist nicht falsch, aber jede Order kostet. Ein hoher Gebührenanteil zeigt, dass das Ergebnis vor Kosten klein war.",
    aliases: ["handelsaktivität", "orders pro monat", "gebührenanteil"],
  },
  {
    id: "chasing", name: "Hinterherlaufen",
    short: "Wie oft nach einem starken Anstieg gekauft wurde.",
    how: "Für jeden Kauf: Kurs der Order gegen den Schlusskurs von vor 5 Handelstagen. Mehr als +5 % zählt als Kauf nach Anstieg, unter 0 % als Kauf nach Rücksetzer.",
    pitfall: "Kaufen in einem Trend ist eine anerkannte Strategie; die Zahl sagt nur, wie oft es geschah, nicht ob es gut war.",
    aliases: ["momentum", "fomo", "hinterherlaufen"],
  },
  {
    id: "afterLoss", name: "Verhalten nach einem Verlust",
    short: "Ob nach einem Verlust-Trade schneller oder größer gehandelt wird als sonst.",
    how: "Zeit bis zur nächsten Order und deren Größe nach jedem Verkauf mit Verlust, gegen den Median aller Orders.",
    pitfall: "Schneller und größer nach einem Verlust kann auf den Wunsch hindeuten, ihn wettzumachen. Es kann auch Plan gewesen sein.",
    aliases: ["tilt", "rache", "revenge trading"],
  },
  {
    id: "mae", name: "MAE (größter Rückgang im Trade)",
    short: "Wie weit der Kurs nach dem Kauf zwischendurch unter deinen Einstand fiel.",
    how: "Tiefster Kurs der Kerzen während der Haltezeit gegen den Kaufkurs, in Prozent (ohne Gebühren). Der Betrag in Euro rechnet den Prozentwert auf die Kosten des Postens um und ist bei US-Werten eine Näherung.",
    pitfall: "Liegen die Verlierer im Mittel tiefer als die Gewinner, kann ein Stopp helfen, muss aber nicht: ein enger Stopp hätte auch Gewinner ausgestoppt.",
    aliases: ["maximum adverse excursion", "rückgang", "stop"],
  },
  {
    id: "mfe", name: "MFE (größter Buchgewinn im Trade)",
    short: "Wie weit der Kurs nach dem Kauf zwischendurch über deinen Einstand stieg.",
    how: "Höchster Kurs der Kerzen während der Haltezeit gegen den Kaufkurs, in Prozent (ohne Gebühren).",
    aliases: ["maximum favorable excursion", "buchgewinn"],
  },
  {
    id: "exitEfficiency", name: "Exit-Effizienz",
    short: "Wie viel vom möglichen Gewinn der Ausstieg mitgenommen hat.",
    how: "(Verkaufskurs minus Kaufkurs) durch (Höchstkurs minus Kaufkurs), ohne Gebühren. 100 % wäre der Verkauf am Höchstkurs. Ohne Kurs über dem Einstand gibt es keinen Wert.",
    pitfall: "Der Höchstkurs ist erst im Nachhinein bekannt. Auch ein perfekter Plan nimmt selten alles mit.",
    aliases: ["exit", "ausstieg", "gewinn mitgenommen"],
  },
  {
    id: "afterTax", name: "Nach Steuern (Schätzung)",
    short: "Was von den realisierten Gewinnen nach deutscher Abgeltungsteuer übrig bliebe, als reine Informationssicht.",
    how: "Realisierte Ergebnisse (nach Gebühren) und Ausschüttungen werden je Kalenderjahr getrennt in einen Aktien-Topf und einen allgemeinen Topf verrechnet, mit Verlustvortrag, Teilfreistellung bei Fonds und dem Sparerpauschbetrag des Jahres. Der Rest wird mit 25 % plus Soli (und Kirchensteuer) besteuert. Die Netto-Kurve ist die Depotkurve minus die bis dahin geschuldete Steuer.",
    pitfall: "Eine Vereinfachung, keine Steuerberatung: die Buchung des Brokers ändert sich nicht, nicht realisierte Gewinne werden nicht besteuert, die Vorabpauschale fehlt, Quellensteuer und Freistellungsaufträge bei mehreren Banken sind nicht modelliert.",
    aliases: ["steuer", "abgeltungsteuer", "sparerpauschbetrag", "freistellungsauftrag", "teilfreistellung", "verlustverrechnung", "kirchensteuer", "soli"],
  },
  {
    id: "fees", name: "Gebührenbilanz",
    short: "Was Provision und Auslandspauschale gekostet haben.",
    how: "Summe aus Provision und Auslandspauschale aller ausgeführten Orders; „vom Start“ setzt sie ins Verhältnis zum Startkapital.",
    pitfall: "Spread und Devisenaufschlag stecken im Ausführungspreis und fehlen hier. Die tatsächlichen Handelskosten sind höher.",
    aliases: ["gebühren", "provision", "kosten"],
  },
  {
    id: "concentration", name: "Konzentration (effektive Anzahl)",
    short: "Wie gleichmäßig das Geld auf die Positionen verteilt ist, als Zahl gleich großer Positionen.",
    how: "Herfindahl-Index (HHI): Summe der quadrierten Anteile der Positionen am Wert der Positionen, ohne Guthaben. Die effektive Anzahl ist 1 durch HHI. Die größte Position und die drei größten stehen daneben.",
    rule: "Orientierung: zehn Positionen mit 60 % in einer wirken wie etwa zwei bis drei gleich große.",
    pitfall: "Sie zählt nur Gewichte, nicht, wie die Positionen zusammen laufen. Ein ETF zählt als eine Position, auch wenn er viele Titel enthält; hineingeschaut wird nicht.",
    aliases: ["hhi", "herfindahl", "klumpen", "streuung", "diversifikation"],
  },
  {
    id: "positionCorrelation", name: "Korrelation der Positionen",
    short: "Wie gleichgerichtet sich die Kurse der gehaltenen Positionen bewegen.",
    how: "Pearson-Korrelation der Renditen in EUR über die Zeitschritte, die alle gezeigten Positionen gemeinsam haben, mit der gröbsten Basis, die mindestens 10 Renditen liefert. Nur Kurse bis zur Simulationszeit.",
    rule: "Orientierung: ab etwa 0,8 laufen zwei Positionen fast gleich und streuen kaum.",
    pitfall: "Aus kurzer Zeit geschätzt ist sie instabil; die Zahl der Renditen steht dabei. Sie gilt für die Kurse der Positionen, nicht für das Depot, wenn sich die Gewichte im Fenster geändert haben.",
    aliases: ["heatmap", "korrelationsmatrix"],
  },
  {
    id: "riskShare", name: "Risikobeitrag",
    short: "Wie viel der Schwankung des Depots eine Position verursacht, neben ihrem Anteil am Geld.",
    how: "Gewicht mal Kovarianz der Position mit dem Depot, durch die Varianz des Depots. Die Beiträge ergeben zusammen 100 %. Gewichte aus den heutigen Werten, Renditen aus dem Fenster der Simulation.",
    pitfall: "Er ist rückblickend und hängt vom gewählten Zeitraum ab. Ein hoher Beitrag heißt nicht, dass die Position schlecht ist, nur dass sie die Schwankung bestimmt.",
    aliases: ["risikoanteil", "marginaler beitrag"],
  },
  {
    id: "diversificationRatio", name: "Diversifikationsquotient",
    short: "Wie viel ruhiger das Depot ist als die einzelnen Positionen zusammen.",
    how: "Gewichtete Summe der einzelnen Volatilitäten durch die Volatilität des Depots. 1 heißt: kein Gewinn durch Mischen; zwei unabhängige gleich große Positionen ergeben etwa 1,41.",
    pitfall: "Er sagt nichts über die Höhe der Rendite. Bei kurzer Zeit schwankt er stark.",
    aliases: ["diversifikation", "streuung"],
  },
  {
    id: "distribution", name: "Verteilung",
    short: "Wie sich der Depotwert auf Sektoren, Handelsländer und Währungen aufteilt.",
    how: "Anteil der Positionen am Wert nach Sektor, Land der Börse und Währung. Fonds stehen als „ETF/Fonds“.",
    pitfall: "Das Handelsland ist das der Börse, nicht des Firmensitzes. Wenige große Positionen in einem Sektor sind ein Klumpen, auch wenn viele Titel im Depot liegen.",
    aliases: ["sektor", "land", "währung", "streuung", "diversifikation"],
  },
];

const BY_ID = new Map(GLOSSARY.map((e) => [e.id, e]));

export const entryOf = (id: string): Entry | undefined => BY_ID.get(id);

/** Entries whose name, aliases or text contain every word of the query, name matches first. Empty query: all. */
export function searchGlossary(query: string): Entry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return GLOSSARY;
  const hay = (e: Entry) => [e.name, ...(e.aliases ?? [])].join(" ").toLowerCase();
  const full = (e: Entry) => [hay(e), e.short, e.how, e.rule ?? "", e.pitfall ?? ""].join(" ").toLowerCase();
  const hits = GLOSSARY.filter((e) => words.every((w) => full(e).includes(w)));
  const named = (e: Entry) => (words.every((w) => hay(e).includes(w)) ? 0 : 1);
  return hits.map((e, i) => [e, i] as const).sort((a, b) => named(a[0]) - named(b[0]) || a[1] - b[1]).map(([e]) => e);
}

export interface Reliability {
  /** The label next to the figure. */
  label: string;
  reason: string;
}

/**
 * Whether the figures of one row rest on a basis that says little: no basis at all (fewer than ten
 * returns even on 5 minutes) or the finest one, whose annualised values swing widely.
 */
export function reliabilityOf(m: Pick<Metrics, "basis" | "periodsPerYear">): Reliability | null {
  if (m.basis === null) return { label: "zu früh zu sagen", reason: "Es liegen weniger als 10 Werte vor, daraus lässt sich nichts schätzen." };
  if (m.basis === "5min") {
    return { label: "Aussagekraft gering", reason: "Die Zahlen stehen auf 5-Minuten-Werten und sind auf ein Jahr hochgerechnet; solche Werte schwanken stark. Mit mehr Tagen werden sie verlässlicher." };
  }
  return null;
}
