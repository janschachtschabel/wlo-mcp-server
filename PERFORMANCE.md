# WLO-MCP — Performance & Optimierungen

Stand: 2026-06-01. Dieses Dokument hält die latenzrelevanten Designentscheidungen
des MCP-Servers fest — was umgesetzt ist, welche Werte aktiv sind und wo noch
Potenzial liegt.

## Kontext
Ein Such-Turn im Chatbot dauerte gemessen **9–18 s** (Faktenfrage ohne Suche ~4 s).
Hauptkosten: die edu-sharing-Suchen (Vercel-Cold-Starts + mehrere edu-sharing-
REST-Calls je Tool) und mehrere sequenzielle LLM-Calls im Backend. Die folgenden
MCP-Änderungen senken Anzahl + Größe der edu-sharing-Calls.

## Umgesetzte Optimierungen (2026-06-01)

### O1 — Kombiniertes Tool `search_wlo_all`
Liefert **Einzel-Inhalte + Sammlungen + Themenseiten in EINEM Aufruf**, intern
`Promise.all`-parallel. Spart dem Backend die separaten Aufrufe von
`search_wlo_content` + `search_wlo_collections` (= weniger MCP-Round-Trips /
Cold-Starts). Rückgabe ist ein strukturiertes Envelope:
```json
{ "query": "...",
  "content":     { "total": N, "count": M, "results": [...] },
  "collections": { "total": N, "count": M, "results": [...] },
  "topicPages":  { "total": N, "count": M, "results": [...] } }
```
Themenseiten = Sammlungen mit `ccm:page_config_ref` → eine Sammlungssuche bedient
beide Töpfe (kein separater Durchlauf). Nutzt bewusst den schnellen Keyword-Pfad
(nicht den Baumlauf) → niedrige Concurrency.
*Status: im MCP implementiert UND im Backend verdrahtet (2026-06-01).* Der
Chatbot ruft `search_wlo_all` im spekulativen Prefetch für generische Inhalts-/
Sammlungs-Such-Turns (1 MCP-Call statt 3 separater) und splittet das Envelope in
drei Per-Tool-Payloads, die der bestehende `parse_wlo_cards`/Box-Pfad unverändert
verarbeitet. Explizite Themenseiten-Anfragen (Nutzer tippt „Themenseite"/
„Fachportal" oder LLM-Tool-Hint = `search_wlo_topic_pages`) nutzen weiter das
dedizierte, session-stateful `search_wlo_topic_pages`. Live verifiziert: gleiche
Query „Photosynthese" 12,2 s (3 Calls) → 9,1 s (1 Call); Karten-Töpfe korrekt
getrennt (content/collections/topicPages).

### O2 — Kuratierter `propertyFilter`
edu-sharing akzeptiert Feldauswahl NUR als **wiederholten** `propertyFilter=`-Param
(Kommaliste → 0 Properties). Statt `-all-` (~59 Properties/Node) werden nur die
real genutzten ~24 Felder angefordert (`DISPLAY_PROPS` / für Themenseiten
`TOPIC_PAGE_PROPS` in `wlo-api.ts`). Die `_DISPLAYNAME`-Label-Felder müssen
explizit mitgelistet werden — kommen dann korrekt zurück (verifiziert).
Behaltene „Extras": `ccm:oeh_lrt(_DISPLAYNAME)`, `ccm:replicationsource(_DISPLAYNAME)`
(= Bezugsquelle, z.B. Klexikon), `ccm:author_freetext`.
Top-Level-Felder (`preview`, `content.url`, `mimetype`, `size`, `downloadUrl`)
sind NICHT von propertyFilter betroffen.
`get_node_details` bleibt bewusst auf `-all-` (Einzelknoten, Detail-Tool).

### O4 — `enhancedSearch` gezähmt
Query-Expansion erzeugte 6–9 parallele `ngsearch`-Calls. Jetzt: Einzelterm-
Varianten entfernt + Hard-Cap `MAX_VARIANTS = 5` (nach Gewicht sortiert,
`full:` bleibt immer dabei).

### O5 — Themenseiten-Loops parallelisiert
`getCollectionThemePages` holt die page_config-Kinder jetzt `Promise.all`-parallel
statt sequenziell (`for … await`). `getTopicPageContent` braucht den per-Kind-
Fan-out gar nicht mehr (siehe Stage-3-Befund unten: die Variante IST das
page_config-Kind) → noch weniger Calls.

### O6 — Collections-Baumlauf gedeckelt
Fallback-Traversal begrenzt: level2 ≤ 25 Parents, level3 ≤ 15 (mit Warn-Log).
Verhindert die frühere 100+-Parallel-Call-Lawine. Direkte level1-Treffer bleiben
vollständig.

### O8 — Reranking vereinheitlicht (Sammlungen + Themenseiten)
Bisher wurden NUR Einzel-Inhalte gerankt (`enhancedSearch`); Sammlungen kamen in
roher edu-sharing-API-Reihenfolge → off-topic Treffer oben (z.B. „Musik der
Klassik" bei „Französische Revolution"). Jetzt wird `rerankNodes(query)`
einheitlich angewandt:
- `search_wlo_collections` (im `renderOut`, vor dem Slice),
- `search_wlo_all` (Sammlungen → daraus erben die Themenseiten die Reihenfolge),
- `search_wlo_topic_pages` Mode B (Eingangs-Sammlungen + Default-Sortierung bei
  Query = „relevance" statt „alpha").

`rerankNodes` **sortiert nur um + entfernt gelöschte Knoten** (kein `minScore`-
Drop) → kann nichts Relevantes verlieren. Verlust-Check über 6 Queries
(`test_rerank_loss.mjs`): **0 relevante Treffer aus Top-3 verloren**, durchweg
Gewinn (Exakt-Treffer von #3 → #1; z.B. „Klimawandel"/„Mittelalter" rückten von
3 off-topic-Sammlungen auf 3 exakte). Browse ohne Query bleibt unverändert.

## Aktuell aktive Einstellungen
| Knopf | Wert | Bedeutung |
|---|---|---|
| `POOL_SIZE` (`WLO_POOL_SIZE`) | **25** (von 40) | Kandidaten-Pool **je Variante** fürs Ranking — NICHT die ausgelieferte Trefferzahl |
| `MAX_VARIANTS` | 5 | max. parallele Such-Varianten |
| `search_wlo_content` maxResults | Default 8 | ausgelieferte Inhalte (Backend setzt real 10 spekulativ / 4 im Loop) |
| `search_wlo_collections` maxResults | Default 5 | |
| `search_wlo_all` maxContent / maxCollections | 8 / 5 | |
| Collections-Baumlauf | level1 ≤100 · level2 ≤25 · level3 ≤15 | |
| `minScore` | max(5, Terme×3) | Quality-Floor im Reranking |
| Properties/Node | ~24 (statt ~59) | O2 |

## Was nach dem Ranking ausgeliefert wird
`enhancedSearch`: ≤5 Varianten × `POOL_SIZE` Kandidaten → RRF-Merge +
Quality-Score (`computeRelevanceScore`) → `minScore`-Filter (Graceful-Fallback
auf den Pool) → gelöschte Knoten raus → **auf `maxResults` gekürzt** → diese
Top-N als formatierte Knoten + der **echte edu-sharing-Treffer-Total**. Der
Kandidaten-Pool verlässt den MCP nie.

## Themenseiten-Inhalte (`get_topic_page_content`) — Stand 2026-06-01

**Bugfix (umgesetzt):** Die Variantenauflösung war kaputt — sie durchsuchte die
*Inhalte* der `page_config_ref`-Kinder (das sind `WIDGET_*`-Knoten OHNE
`ccm:page_variant_config`) und lieferte daher **immer 0 Swimlanes**. Tatsächlich
tragen die page_config-**Kind-Collections selbst** den `ccm:page_variant_config`
(Titel z.B. „Variante_Ideal" / „PAGE_VARIANT_…"). Fix in `getTopicPageContent`:
direkt unter den Kindern die echte (Nicht-Template-)Variante wählen. Verifiziert
gegen Staging: „Nachhaltigkeit" liefert jetzt **8 Swimlanes** mit echten
Überschriften („Test Tina 2", „Akkordeonelement", „Ankermenü", …).

**`outputFormat:'json'` = RENDER-READY (umgesetzt):** Die Swimlane-Items sind
**WIDGET-Knoten** (`ccm:map` mit `ccm:widget_config`). Der json-Branch löst je
Swimlane das **erste inhaltstragende Widget** zu echten Karten auf — drei in WLO
vorkommende Formen:
| Widget-Typ | config-Feld | Auflösung |
|---|---|---|
| `content-teaser` | `propertyFilters` (gespeicherte Query) | → `ngsearch(FILES)` |
| `wlo-collection-chips` | `sortedNodeIds` (feste Liste) | → `getCollectionMetadata` |
| `wlo-media-rendering` | `selectedNodeId` (Einzelknoten) | → `getCollectionMetadata` |

Andere Widgets (Text / AI-Text / `wlo-topics-column-browser` / `editorial-members`
/ iframe) tragen keine Inhalte → leere Swimlane (Frontend überspringt sie).
Output je Swimlane: `{heading, type, items:[Karte…≤maxPerSwimlane], hasMore}` +
`variantTitle` + `topicPageUrl`. Gedeckelt: ≤ `MAX_LANES=12` Swimlanes, 1 Widget/
Swimlane, `maxPerSwimlane` (Default 3) Karten — hält die Call-Zahl beschränkt.
**Live verifiziert (Staging):** „Nachhaltigkeit" füllt 5/8 Swimlanes —
content-teaser → echte Inhalte („Wie funktioniert das Internet?"), collection-chips
→ Sammlungen („Klimawandel", „Nachhaltige Ernährung"), media-rendering → 1 Knoten.
*Backend-/Frontend-Verdrahtung (Intent/Pattern + Swimlane-Boxen mit „(Auszug)" +
Absprung-Button) steht noch aus — Backend ruft das Tool noch nicht.*

## Offenes Optimierungspotenzial

### O7 — Persistenter Betrieb + In-Process-Cache  *(NICHT umgesetzt)*
**Größter verbliebener Hebel.** Der MCP läuft aktuell **stateless serverless**
(`api/mcp.ts`: ein Server je Request, `server.close()` danach) → Vercel-**Cold-
Starts** (~1–3 s/Call) **und** kein Caching über Requests hinweg.
- Ein **persistenter Prozess** (vorhandener `Dockerfile`/stdio-Modus oder Vercel
  „fluid"/keep-warm) eliminiert Cold-Starts und ermöglicht erst einen
  **In-Process-Result-Cache** (Suchergebnisse, Node-Metadaten, Vokabular mit TTL).
- Auf serverless wäre ein solcher Cache ein No-op (überlebt Requests nicht).
- Code-seitig könnte der Cache hinter einem Env-Flag vorbereitet werden; er greift
  aber erst mit einem persistenten Deployment. **Daher an die Betriebsart-
  Entscheidung gekoppelt.**
- Workaround ohne Umbau: **Keep-Warm-Cron** (alle ~5 min `/mcp` pingen) gegen
  Cold-Starts.

### Kleinere, optionale Hebel
- `POOL_SIZE` weiter senken (25→15) — minimal weniger Recall.
- edu-sharing-Antwortzeit selbst (~1–4 s/ngsearch) ist Infra (Staging; Prod evtl.
  schneller) — nicht im MCP-Code lösbar; wir senken nur Anzahl + Größe der Calls.
