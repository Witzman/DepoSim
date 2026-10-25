# DepoSim

Ein Depot-Simulator zum Üben: Du führst ein Wertpapierdepot mit Spielgeld durch echte Kursverläufe der
Vergangenheit (oder zeitversetzt der Gegenwart), kaufst und verkaufst, und siehst danach, wie deine
Entscheidungen im Vergleich abschneiden. Gebühren, Spread, Handelszeiten und Feiertage wirken wie im
echten Handel.

> **Spielgeld und Übung. Keine Anlageberatung.** Kennzahlen, Hinweise und Faustwerte sind Orientierung.
> Gute Ergebnisse in der Vergangenheit sagen nichts über die Zukunft. Gebühren und Steuern sind
> Modellannahmen, kein Preisverzeichnis eines Brokers und keine Steuerberatung.

Die Oberfläche ist deutsch. Der Server läuft als einzelner Node-Prozess mit SQLite, die Seite ist eine
installierbare Web-App (PWA), auch auf dem Handy nutzbar.

## Inhalt

- [Was DepoSim kann](#was-deposim-kann)
- [So wird gespielt](#so-wird-gespielt)
- [Schnellstart](#schnellstart)
- [Konfiguration](#konfiguration)
- [Daten und Quellen](#daten-und-quellen)
- [Architektur](#architektur)
- [Tests](#tests)
- [Betrieb mit Docker](#betrieb-mit-docker)
- [Grenzen](#grenzen)

## Was DepoSim kann

**Spielen**

- Mehrere Simulationen nebeneinander, je mit mehreren Depots, einem Geisterdepot (was wäre ohne deine
  Eingriffe passiert) und Vergleich der Kurven.
- Minutenkerzen oder Tageskurse, Startzeitpunkt frei wählbar; Livebetrieb mit Zeitversatz und Aufholen bis
  zur Gegenwart.
- Market- und Limit-Orders, Mengen auch als Prozentvorgabe beim Depotaufbau, simuliertes Orderbuch
  (als „simuliert“ gekennzeichnet, aus der letzten Kerze abgeleitet).
- Schwierigkeitsgrade je Simulation: Entspannt, Realistisch, Hardcore (doppelter Spread und doppelte
  Gebühren, keine Pause, festes Tempo) oder eigene Regeln.
- Zeitsteuerung: Start, Pause, Tempo 1x bis 60x, Sprung zum nächsten Ereignis (Stunde, Handelsschluss,
  Eröffnung, nächster Tag), Auto-Pause bei Ausführung, Limit-Nähe, Kurssprung, Marktöffnung und Ereignissen.
- Szenarien mit Aufgabe und Sternen, Rundenabschluss mit Note, Rundenbuch und teilbarer Ergebniskarte.
- Geführter Einstieg (Lernpfad), Glossar aller Kennzahlen und eine Spielanleitung mit durchgerechneten
  Beispielen, jederzeit im Spiel erreichbar.

**Chart**

- Zeitrahmen, Kerzen, Heikin-Ashi und Linie, logarithmische und prozentuale Skala, OHLC-Legende,
  Markierungen deiner Orders.
- Indikatoren: SMA, EMA, RSI, MACD, Bollinger, ATR, Stochastik, OBV, Tages-VWAP. Sie nutzen nie Kerzen
  nach der aktuellen Simulationszeit.
- Zeichenwerkzeuge (waagerechte Linie, Trendlinie, Markierung mit Text), pro Wertpapier gespeichert.
- Dividenden, Splits und Kurslücken werden gebucht beziehungsweise markiert.

**Auswerten**

- Rendite, Volatilität, maximaler Rückgang, Sharpe, Sortino, Calmar, Value at Risk, Beta, Alpha,
  Tracking Error, Information Ratio, jeweils mit Erklärung und dem Hinweis „zu früh zu sagen“, wenn die
  Datenbasis dünn ist.
- Vergleich mit Maßstäben (FTSE All-World, S&P 500, MSCI World seit 11/2019), rollierende Kennzahlen,
  Monatsrenditen, Rückgangsepisoden, Gebührenbilanz, Verteilung und Diversifikation der Positionen.
- Journal mit Trefferquote und Haltedauer, Trade-Nachbetrachtung (MAE, MFE, Exit-Effizienz),
  Verhaltensanalyse (Dispositionseffekt, Umschlag, Hinterherlaufen).
- Nach Steuern als Schätzung (Abgeltungsteuer, Sparerpauschbetrag, Teilfreistellung), Ausblick als
  Monte-Carlo-Spanne, Hinweise-Zentrale für Klumpen, Kosten, Rückgang und Verlustserien.

**Daten und Betrieb**

- Eigenes Kursarchiv, das nachts gesammelt und geprüft wird (Plausibilität, Lücken, Handelskalender je
  Börse), Datenzustand-Seite mit Abdeckung, Quellenstatus und Auftragsprotokoll.
- Sicherung, Export und Import von Simulationen und Kursarchiv als Datei, tägliche Sicherung im Betrieb.
- Befehlspalette (Strg + K), Tastenkürzel, Töne und Haptik standardmäßig aus.

## So wird gespielt

Im Spiel öffnet der Knopf **?** in der Kopfzeile (oder die Taste **H**) die ausführliche Anleitung mit
neun Kapiteln und Beispielen. Hier der kürzeste Weg zum ersten Handel:

1. **Neue Simulation** anlegen: Name, Startzeitpunkt, Schwierigkeitsgrad. Die Uhr steht zu Beginn.
2. **Start** drücken (oder Leertaste). Tempo mit den Tasten 1 bis 4 (1x, 5x, 30x, 60x).
3. Wertpapier wählen, im **Orderticket** Menge eingeben und **Kauf** drücken (Taste **B**). Eine
   Market-Order läuft sofort zum aktuellen Kurs plus Spread.
4. Statt Market lieber **Limit**: Die Order wartet, bis das Tief (Kauf) beziehungsweise Hoch (Verkauf)
   einer Kerze dein Limit erreicht.
5. Später **verkaufen** (Taste **S**). Der Trade steht im Journal, die Auswertung zeigt, wie du gegen den
   Maßstab liegst.

Ein durchgerechnetes Beispiel aus der Anleitung (Modellgebühren: Spread 0,05 %, Provision 0,25 %, mindestens
4,90 €): 100 Stück bei 48,20 € per Market-Order kosten 4.822,41 € Kurswert plus 12,06 € Provision, also
4.834,47 €. Dieselbe Order mit Limit 48,20 € kostet 4.832,05 €, wartet aber womöglich vergeblich.
Die Zahlen der Anleitung werden in den Tests mit der Rechnung der Engine abgeglichen.

Tastenkürzel: **B** Kauf, **S** Verkauf, **G** Glossar, **H** Anleitung, **?** Kürzelliste,
**Leertaste** Start/Pause, **.** nächste Kerze (Tageskurse: ein Tag), **Strg + K** Suche und Befehle.

## Schnellstart

Voraussetzung: Node.js 20.19 oder neuer (das Docker-Image nutzt Node 24).

```sh
npm ci
npm run build
npm start            # http://localhost:3000
```

Entwicklung mit Neuladen:

```sh
npm run dev          # Server auf :3000 (tsx watch)
npm run dev:web      # Vite-Entwicklungsserver für die Seite
```

Ohne Internet oder zum Ausprobieren gibt es eine Variante mit erfundenen Kursen:

```sh
npm run build:web && npm run dev:fake
```

Die Datenbank liegt standardmäßig in `./data/deposim.sqlite` und entsteht beim ersten Start.

## Konfiguration

Alles läuft über Umgebungsvariablen; keine ist Pflicht.

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `3000` | Port des Servers |
| `DB_PATH` | `./data/deposim.sqlite` | Ort der SQLite-Datei |
| `BACKUP_DIR` | Ordner `backups` neben der Datenbank | Ziel der täglichen Sicherung |
| `BACKUP_KEEP` | `7` | Wie viele tägliche Sicherungen bleiben |
| `LIVE_DELAY_S` | `900` | Zeitversatz der Kursquelle im Livebetrieb, in Sekunden |
| `CATCH_UP_TEMPO` | `300` | Tempo, mit dem eine Livesimulation aufholt |
| `LIVE_REFRESH_S` | `60` | Kürzester Abstand zwischen zwei Abrufen der Tageskurse |
| `JOBS` | an | `off`: der Planer startet nichts von selbst (Aufträge lassen sich von Hand starten) |
| `JOB_<NAME>` | siehe unten | `off` oder lokale Uhrzeit `HH:MM` für einen Auftrag |

Aufträge des Planers: `sammlung-xetra`, `sammlung-us`, `luecken`, `tageskurse`, `pruefung`,
`wechselkurse`, `sicherung`, `pflege`. Beispiel: `JOB_SAMMLUNG_US=23:30` oder `JOB_PFLEGE=off`.
Ungültige Werte werden ignoriert.

## Daten und Quellen

- **Kurse:** Minuten- und Tagesbalken von Yahoo Finance (inoffizielle Schnittstelle, ohne Zusage). Xetra
  und die US-Börsen sind handelbar; für Frankfurt, Tradegate und gettex gibt es keine ausreichend
  lückenlose Quelle, sie werden angezeigt, aber nicht gehandelt.
- **Wechselkurse:** Referenzkurse der Europäischen Zentralbank (historisch seit 1999).
- **Handelskalender:** Feiertage und verkürzte Tage je Börse (Xetra, NYSE).
- **Archiv:** Was einmal geladen wurde, bleibt in der Datenbank. Die nächtliche Sammlung füllt es auf,
  fehlende Kurse lassen sich über den Datenzustand oder die Befehlspalette von Hand nachladen.
- **Keine Gewähr:** Kurse können Lücken oder Fehler enthalten; eine Plausibilitätsprüfung erkennt kaputte
  Balken und Ausreißer, ersetzt aber keine geprüfte Datenquelle.

## Architektur

```
web/        React 19 + Vite, Lightweight Charts; Seite, Dialoge, Texte (Glossar, Anleitung)
server/
  src/domain/   reine Fachlogik ohne Ein-/Ausgabe: Gebühren, Broker, Regeln, Kennzahlen, Journal,
                Steuern, Kalender, Hinweise (die getestete Mitte des Projekts)
  src/data/     Kursquellen und Archiv (Yahoo, EZB, SQLite-Archiv)
  src/          Fastify-API und WebSocket (Uhr), Sitzungen, Planer, Sicherung, Datenbank
  test/         Server- und Domänentests (vitest)
web/e2e/    Playwright-Tests im Browser
```

- Server: Fastify 5, `better-sqlite3`, WebSocket für die Simulationsuhr, `zod` für Eingaben.
- Beträge werden in ganzen Cent geführt; die Reihenfolge der Rechenschritte in `domain/fees.ts` ist
  festgelegt, damit Vorschau und Ausführung dieselben Zahlen liefern.
- Die Regeln einer Simulation werden beim Anlegen in deren Gebührenmodell eingerechnet und danach nicht
  mehr geändert.
- Es gibt keinen Anmeldedienst: Der Zugriffsschutz gehört vor den Server (zum Beispiel Basic-Auth im
  Reverse-Proxy).

## Tests

```sh
npm run typecheck                    # Server und Seite
npm test                             # vitest: Domäne, API, Seite
npm run e2e                          # Playwright, startet den Server auf Port 3100
npm run acceptance -- <URL>          # Abnahmelauf gegen einen laufenden Server (HTTP und WebSocket)
npm run probe                        # fragt die echte Kursquelle ab (Handprüfung, kein Test)
```

Hinweise: Der e2e-Lauf braucht den freien Port 3100; zwei Läufe gleichzeitig stören sich. Beim ersten Mal
einmal `npx playwright install chromium` ausführen. Ein Test des Livebetriebs in `server/test/api.test.ts`
ist zeitabhängig und kann im Gesamtlauf einmal wackeln; allein läuft er durch.

Die CI (`.github/workflows/ci.yml`) führt Typprüfung, `vitest` und den Build aus; die e2e-Tests laufen dort nicht.

## Betrieb mit Docker

```sh
docker compose up -d --build
```

- Mehrstufiger Build, das Image enthält Server und gebaute Seite; es läuft als Benutzer `node` auf Port 80.
- Daten und Sicherungen liegen im Volume `deposim-data` unter `/data`.
- `/healthz` antwortet ohne Anmeldung und nennt die Bauzeit des Images, so lässt sich ein Deploy erkennen.
- Das Speicherlimit der Compose-Datei ist 256 MB. Es werden keine Ports veröffentlicht; ein
  Reverse-Proxy (zum Beispiel Traefik) leitet auf den Dienst `web`.
- Der Server hat keine eigene Anmeldung. Stelle ihn nicht ungeschützt ins offene Netz.

## Grenzen

- Kein Echtzeithandel, keine Anbindung an einen Broker, keine echten Orders.
- Das Orderbuch ist ein Bild, keine Markttiefe; es beeinflusst weder Ausführung noch Gebühren.
- Kursdaten stammen aus einer inoffiziellen Quelle und können abweichen oder ausfallen.
- Steuern sind eine grobe Schätzung für einen Privatanleger in Deutschland.
- Eine Lizenz ist noch nicht festgelegt; ohne ausdrückliche Lizenz gelten alle Rechte beim Autor.
