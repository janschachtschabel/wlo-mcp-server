# WLO MCP Server

**WLO MCP** ist ein [Model Context Protocol](https://modelcontextprotocol.io) Server für [WirLernenOnline.de](https://wirlernenonline.de) (WLO) – die deutsche OER-Plattform für freie Bildungsmaterialien.

Kompatibel mit **OpenAI** (Responses API + native MCP), **Anthropic Claude** und allen anderen MCP-fähigen Clients.

---

## Inhaltsverzeichnis

1. [Was ist neu in v2](#was-ist-neu-in-v2)
2. [Installation](#installation)
3. [Tools im Überblick](#tools-im-überblick)
4. [Tools – Detail & API-Endpunkte](#tools--detail--api-endpunkte)
5. [Filter-Parameter & Vokabular](#filter-parameter--vokabular)
6. [Output-Formate (markdown vs. json)](#output-formate-markdown-vs-json)
7. [Determinismus & Stabilität](#determinismus--stabilität)
8. [Deployment](#deployment)
9. [Konfiguration in AI-Clients](#konfiguration-in-ai-clients)
10. [Architektur](#architektur)
11. [Migration v1 → v2](#migration-v1--v2)
12. [Kompatibilität](#kompatibilität)

---

## Was ist neu in v2

### Hinzugekommen
- **`get_subject_portals`** — listet die Fachportale (Top-Level-Sammlungen unter dem WLO-Wurzelknoten) deterministisch alphabetisch.
- **`browse_collection_tree`** — strukturierter Drilldown in Sub-Sammlungen (Tiefe 1 oder 2), optional mit File-Counts.
- **`wlo_health_check`** — Probe gegen die WLO-API, gibt Latenz + Status zurück.
- **`get_nodes_details`** — Bulk-Metadata für mehrere `nodeIds` parallel.
- **`outputFormat: "json"`** für *alle* Such- und Detail-Tools — strukturierte Daten statt Markdown-Parsing.
- **`excludeNodeIds: string[]`** für die drei Such-Tools — bereits gesehene IDs aus Folge-Calls ausblenden.
- **License- und TargetGroup-Vocabularies** in `lookup_wlo_vocabulary` (`vocabulary: "license"` / `"targetGroup"`).

### Verbessert
- **`search_wlo_topic_pages`**:
  - Mode C (Liste-aller) zeigt jetzt die **Sammlungsnamen** als Titel statt kryptischer `PAGE_VARIANT_TEMPLATE_xxx`-Slugs (Auto-Resolve via `getNodeParents`).
  - Mehrere Varianten derselben Sammlung werden per `mergeVariants=true` (Default) zu einer Karte zusammengefasst.
  - **`targetGroupLabel`** liefert lesbare Labels (`"Lehrkräfte"` / `"Lernende"` / `"Allgemein"`) statt Slugs / `ccrep://`-URIs.
  - **`sort: "alpha" | "relevance"`** mit deterministischem Tie-Breaker auf `nodeId`.
- **`get_node_details`**:
  - Output-Felder sind jetzt **identisch zu `formatNode()`** der Such-Tools — `disciplines`, `educationalContexts`, `userRoles`, `learningResourceTypes`, `license` als **menschenlesbare Labels** (`"Mathematik"`, `"CC BY-SA 4.0"`) statt URIs.
  - Optional `includeRaw: true` zeigt zusätzlich die unaufgelösten URIs für Debugging / Spezialfälle.
- **Lizenz-Mapping**: Roh-Keys wie `CC_BY_SA` werden überall zu `"CC BY-SA 4.0"` aufgelöst.
- **Reranker** (`reranker.ts`): deterministischer Tie-Breaker auf `nodeId` bei gleichem Score; neue `sortByTitle()` für stabile alphabetische Sortierung.

### Entfernt (Breaking Changes)
- `get_wirlernenonline_info`, `get_edu_sharing_network_info`, `get_edu_sharing_product_info`, `get_metaventis_info` — die Webseiten-Crawler-Tools sind weg. Diese Aufgabe übernimmt jetzt das Konsumenten-eigene RAG (z.B. das BadBoerdi-RAG).
- Damit auch `WEB_CONTENT_WHITELIST` und `fetchWebContent()` aus `wlo-api.ts` entfernt.

---

## Installation

### Voraussetzungen

- **Node.js** ≥ 18.x
- **npm** ≥ 9.x

### Lokale Installation

```bash
git clone https://github.com/yourorg/wlomcp.git
cd wlomcp
npm install
npm run build
```

### Umgebungsvariablen

```bash
cp .env.example .env
```

| Variable | Werte | Standard | Beschreibung |
|---|---|---|---|
| `WLO_ENV` | `production`, `staging` | `production` | Ziel-Umgebung der WLO-API |
| `PORT` | Zahl | `3000` | HTTP-Port (nur HTTP-Modus) |

### Server starten

```bash
node dist/http.js     # HTTP-Modus → http://localhost:3000/mcp
node dist/stdio.js    # stdio (Claude Desktop, lokale Clients)

npm run dev           # stdio mit Auto-Reload
npm run dev:http      # HTTP mit Auto-Reload
```

---

## Tools im Überblick

| # | Tool | Zweck | Output-Formate |
|---|---|---|---|
| 1 | `search_wlo_collections` | Sammlungen suchen (Volltext + Tree-Fallback) | markdown / json |
| 2 | `search_wlo_content` | Globale Volltextsuche nach Bildungsinhalten | markdown / json |
| 3 | `get_collection_contents` | Inhalte/Sub-Sammlungen einer Sammlung (paginierbar) | markdown / json |
| 4 | `get_node_details` | Detail-Metadaten + optional Volltext + Eltern | markdown / json |
| 5 | `lookup_wlo_vocabulary` | Vokabular-Werte: Bildungsstufe, Fach, Zielgruppe, LRT, Lizenzen, TargetGroup | markdown |
| 6 | `search_wlo_topic_pages` | Themenseiten finden / listen, Varianten zusammenfassen | markdown / json |
| 7 | `get_subject_portals` | Fachportale (Top-Level-Sammlungen unter WLO-Root) | markdown / json |
| 8 | `browse_collection_tree` | Drilldown in Sub-Sammlungen (Tiefe 1–2), optional mit File-Counts | markdown / json |
| 9 | `wlo_health_check` | Status + Latenz der WLO-API | json |
| 10 | `get_nodes_details` | Bulk-Metadata für mehrere `nodeIds` parallel | json |

> **Konzept:** In WLO sind **Sammlungen** und **Themenseiten** dasselbe. Eine Sammlung wird im Repository als Themenseite angezeigt und bündelt Inhalte in **Schwimmlinien (Swimlanes/Karussells)**. Sub-Sammlungen entsprechen Unter-Themenseiten. Sammlungen mit `ccm:page_config_ref` haben eine kuratierte **Themenseite** mit zielgruppenspezifischen Varianten (Lehrkräfte / Lernende / Allgemein).

> **Tool-Routing-Heuristik (für LLMs):**
> - User fragt nach **Material/Inhaltstyp** (Video, Arbeitsblatt, …) → `search_wlo_content`
> - User fragt nach **Themenseite/Sammlung** zu einem Thema → `search_wlo_topic_pages` (Mode B mit query)
> - User will durch ein Fach **navigieren** (Drilldown) → erst `get_subject_portals`, dann `browse_collection_tree`
> - User klickt eine Karte → `get_node_details` mit dieser nodeId
> - Bot zeigt 10 Karten und braucht Metadaten zu allen → `get_nodes_details(nodeIds=[...])` (1 Aufruf statt 10)

---

## Tools – Detail & API-Endpunkte

### 1. `search_wlo_collections`

Sucht thematische Sammlungen. Drei-stufige Strategie: Volltext-API → Baum-Traversierung Level 2 → Level 3.

| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `query` | string | `""` | Suchbegriff. Leer = Top-Level-Sammlungen unter Root oder `parentNodeId` |
| `parentNodeId` | string | – | nodeId einer Eltern-Sammlung für Sub-Tree-Suche |
| `educationalContext` | string | – | Bildungsstufe (Label oder URI) |
| `discipline` | string | – | Fach (Label oder URI) |
| `userRole` | string | – | Zielgruppe (Label oder URI) |
| `maxResults` | int | `5` | 1–20 |
| `excludeNodeIds` | string[] | – | Diese IDs in der Antwort überspringen |
| `outputFormat` | enum | `"markdown"` | `"markdown"` oder `"json"` |
| `environment` | enum | `production` | `"production"` oder `"staging"` |

**API-Endpunkte:**
```
POST /search/v1/queries/-home-/mds_oeh/collections?contentType=COLLECTIONS    (Volltext)
GET  /node/v1/nodes/-home-/{nodeId}/children?filter=folders                   (Tree)
```

---

### 2. `search_wlo_content`

Globale Volltextsuche nach Bildungsmaterialien (Files). Mit **Multi-Query-Expansion + RRF** (clientseitig, ohne Transformer-Modell — Vercel-tauglich).

| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `query` | string | **Pflicht** | Suchbegriff |
| `educationalContext` | string | – | Bildungsstufe |
| `discipline` | string | – | Fach |
| `userRole` | string | – | Zielgruppe |
| `learningResourceType` | string | – | Ressourcentyp (Arbeitsblatt, Video, …) |
| `publisher` | string | – | Anbieter-Filter (Klexikon, Serlo, ZUM, …) |
| `maxResults` | int | `8` | 1–20 |
| `excludeNodeIds` | string[] | – | IDs überspringen |
| `outputFormat` | enum | `"markdown"` | `"markdown"` oder `"json"` |
| `environment` | enum | `production` | – |

**Reranking-Pipeline:**
1. **Query Expansion**: Volltext, Title-Match, Keyword-Hits, Synonym-Map, Einzelterme
2. **Parallele API-Calls** (bis zu 40 Treffer / Variante)
3. **RRF (Reciprocal Rank Fusion)** mit Variant-Gewichtung
4. **Quality Score** (Titel: 30 Pt., Keywords: 10 Pt., Beschreibung: 8 Pt., Metadaten-Qualität)
5. **Endformel**: `0.8 × quality + 0.1 × rrf + 0.1 × multi_appearance_bonus`
6. **Tie-Breaker**: `nodeId.localeCompare()` für deterministische Reihenfolge bei gleichen Scores

---

### 3. `get_collection_contents`

Inhalte einer Sammlung. Unterstützt Pagination via `skipCount` und Filter.

| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `nodeId` | string | **Pflicht** | nodeId der Sammlung |
| `query` | string | – | Optional zum Reranking |
| `contentFilter` | enum | `"files"` | `"files"` / `"folders"` / `"both"` |
| `includeSubcollections` | bool | `false` | Rekursive BFS-Traversierung (nur bei `files`) |
| `maxResults` | int | `20` | 1–100 |
| `skipCount` | int | `0` | Pagination-Offset |
| `excludeNodeIds` | string[] | – | IDs überspringen |
| `outputFormat` | enum | `"markdown"` | `"markdown"` oder `"json"` |
| `environment` | enum | `production` | – |

> **Tipp:** Statt `contentFilter="folders"` ist `browse_collection_tree` (Tool 8) klarer und liefert direkt File-Counts.

---

### 4. `get_node_details`

Detail-Metadaten zu einem einzelnen Node (Content oder Sammlung).

| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `nodeId` | string | **Pflicht** | – |
| `includeTextContent` | bool | `false` | Gespeicherten Volltext (gecrawlt) abrufen, max. 4000 Zeichen |
| `includeParents` | bool | `false` | Eltern-Sammlungen mitliefern |
| `includeRaw` | bool | `false` | Zusätzlich die rohen URI-Werte (vor Label-Resolution) |
| `outputFormat` | enum | `"markdown"` | `"markdown"` oder `"json"` |
| `environment` | enum | `production` | – |

**Output-Konsistenz**: Im JSON-Modus liefert `get_node_details` **dieselben Felder** wie ein Eintrag aus `search_wlo_*` (Output-Format `formatNode()`):
```json
{
  "nodeId": "bd8be6d5-…",
  "title": "Mathematik",
  "description": "…",
  "keywords": ["…"],
  "disciplines": ["Mathematik"],
  "educationalContexts": ["Sekundarstufe i", "Hochschule"],
  "userRoles": [],
  "learningResourceTypes": [],
  "license": "CC BY-SA 4.0",
  "publisher": "ZUM",
  "url": "https://…",
  "previewUrl": "https://…",
  "topicPageUrl": "https://…/topic-pages?collectionId=…",
  "renderUrl": "https://…/components/render/…",
  "nodeType": "collection",
  "parents": [{"nodeId": "…", "title": "…"}],   // wenn includeParents
  "textContent": "…",                             // wenn includeTextContent
  "raw": { … }                                    // wenn includeRaw
}
```

---

### 5. `lookup_wlo_vocabulary`

Listet Vokabular-Werte. Quelle: lokale `src/vocabs.ts` (keine API-Calls).

| Parameter | Werte |
|---|---|
| `vocabulary` | `educationalContext`, `discipline`, `userRole`, `lrt`, `license`, `targetGroup` |

---

### 6. `search_wlo_topic_pages`

Themenseiten finden, listen oder eine spezifische Sammlung prüfen.

| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `query` | string | `""` | Thematische Suche (Mode B) |
| `targetGroup` | enum | – | `"teacher"` / `"learner"` / `"general"` |
| `educationalContext` | string | – | Bildungsstufe |
| `collectionId` | string | – | Direkt-Check einer Sammlung (Mode A) |
| `mergeVariants` | bool | `true` | Mehrere Varianten derselben Sammlung in eine Karte zusammenfassen |
| `sort` | enum | `"alpha"` | `"alpha"` (deterministisch) oder `"relevance"` |
| `maxResults` | int | `5` | 1–20 |
| `outputFormat` | enum | `"markdown"` | `"markdown"` oder `"json"` |

**Drei Suchmodi:**

1. **Mode A — Direkt-Check** (`collectionId` gesetzt): prüft `ccm:page_config_ref` der Sammlung, traversiert Config-Kinder → Varianten
2. **Mode B — Thematische Suche** (`query` gesetzt): Sucht Sammlungen per Keyword, filtert auf `page_config_ref`
3. **Mode C — Alle auflisten** (kein `query`, kein `collectionId`): Nutzt die `page_variant`-API. Variant-Owner-Sammlung wird über `getNodeParents`-Walk aufgelöst → echter Sammlungsname statt `PAGE_VARIANT_TEMPLATE_xxx`

**JSON-Output (Beispiel):**
```json
{
  "total": 1,
  "results": [{
    "title": "Physik",
    "collectionId": "94f22c9b-…",
    "topicPageUrl": "https://…/topic-pages?collectionId=…",
    "educationalContexts": ["Sekundarstufe I", "Sekundarstufe II"],
    "variants": [
      {"variantId": "…", "targetGroup": "teacher", "targetGroupLabel": "Lehrkräfte", "topicPageUrl": "…"},
      {"variantId": "…", "targetGroup": "learner", "targetGroupLabel": "Lernende",  "topicPageUrl": "…"}
    ]
  }]
}
```

---

### 7. `get_subject_portals`

Liefert die WLO-Fachportale — die **direkten Sub-Sammlungen unter dem Wurzel-Knoten**.

| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `educationalContext` | string | – | Filter (Default: alle) |
| `includeContentCounts` | bool | `false` | Zusätzlich `subCollectionCount` pro Portal |
| `outputFormat` | enum | `"markdown"` | `"markdown"` oder `"json"` |
| `environment` | enum | `production` | – |

Output ist deterministisch alphabetisch (Tie-Breaker `nodeId`). Ideal als Einstiegspunkt für geführte Drilldowns.

**API:**
```
GET /node/v1/nodes/-home-/{ROOT_ID}/children?filter=folders
```

---

### 8. `browse_collection_tree`

Drilldown unter eine bestimmte Sammlung — Tiefe 1 (direkte Kinder) oder 2 (Enkel-Knoten).

| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `nodeId` | string | **Pflicht** | Eltern-Sammlung |
| `depth` | int | `1` | `1` oder `2` |
| `includeContentCounts` | bool | `false` | Pro Sammlung den File-Count mitholen |
| `maxResults` | int | `50` | 1–100 |
| `outputFormat` | enum | `"markdown"` | `"markdown"` oder `"json"` |

> **Achtung Latenz**: `depth=2` + `includeContentCounts=true` macht `O(parents × children + parents)` API-Calls. Bei breiten Bäumen entsprechend lang.

---

### 9. `wlo_health_check`

Probe gegen die WLO-API.

| Parameter | Typ | Default |
|---|---|---|
| `environment` | enum | `production` |

**Output (JSON):**
```json
{
  "ok": true,
  "environment": "production",
  "baseUrl": "https://redaktion.openeduhub.net/edu-sharing/rest",
  "rootNodeId": "5e40e372-735c-…",
  "rootResolved": "Portale",
  "latencyMs": 392,
  "checkedAt": "2026-04-27T16:28:04.108Z"
}
```

Bei Fehler: `ok: false`, `error: "<message>"`, `isError: true` im MCP-Result. Nützlich für Konsumenten, um "WLO ist down" von "deine Query liefert keine Treffer" zu unterscheiden.

---

### 10. `get_nodes_details`

Bulk-Fetch für mehrere `nodeIds` (max. 50 / Aufruf, parallel).

| Parameter | Typ | Default |
|---|---|---|
| `nodeIds` | string[] | **Pflicht** |
| `environment` | enum | `production` |

**Output:**
```json
{
  "requested": 3,
  "resolved": 2,
  "failed": ["00000000-0000-0000-0000-000000000000"],
  "results": {
    "bd8be6d5-…": { "title": "Mathematik", "disciplines": ["Mathematik"], … },
    "742d8c87-…": { "title": "Informatik",  "disciplines": ["Informatik"],  … }
  }
}
```

Einzelne Fehler (gelöschte Node, Netzwerk-Fehler) landen im `failed[]` — der Batch crasht nicht.

---

## Filter-Parameter & Vokabular

Alle Vocab-Filter akzeptieren **deutsche Labels**, **englische Synonyme** *oder* **vollständige URIs**:

| Parameter | Beispielwerte | Vocabulary-Key |
|---|---|---|
| `educationalContext` | `Primarstufe`, `Sekundarstufe I`, `Hochschule`, `vocational education` | `educationalContext` |
| `discipline` | `Mathematik`, `Mathe`, `mathematics`, `Biologie`, `Bio`, `MINT` | `discipline` |
| `userRole` | `Lehrer/in`, `teacher`, `Lerner/in`, `Eltern`, `parent` | `userRole` |
| `learningResourceType` | `Arbeitsblatt`, `Video`, `Quiz`, `interactive media` | `lrt` |

### Vocab-Resolution: zwei asymmetrische Pfade

Der Server unterscheidet bewusst zwischen **Anzeige** (URI → Label) und **Filter-Eingabe** (Label → URI):

#### Anzeige-Pfad (URI → Label) — vollständige Abdeckung über `_DISPLAYNAME`

Beim Aufbau eines `FormattedNode` (alle Such-/Detail-Tools) werden Vocab-Felder so resolvt:

1. **Bevorzugt: server-seitiges `<property>_DISPLAYNAME`**, das edu-sharing für jeden indexierten Knoten direkt mitliefert.
   - Funktioniert für `ccm:taxonid`, `ccm:educationalcontext`, `ccm:oeh_lrt_aggregated`, `ccm:oeh_intended_end_user_role`.
   - **Deckt automatisch beide Disziplin-Vokabulare ab**: das Schulfächer-Vocab UND die [Hochschulfächersystematik](https://vocabs.openeduhub.de/w3id.org/openeduhub/vocabs/hochschulfaechersystematik/index.json), ohne dass wir die ~100 Hochschul-Klassen lokal pflegen müssen.
   - Beispiel: ein Hochschul-Knoten mit `taxonid=[".../hochschulfaechersystematik/n71", ".../n8"]` zeigt `disciplines: ["Studienbereich Informatik", "Ingenieurwissenschaften"]`.
2. **Fallback: lokales `labelFromUri`-Lookup** (`vocabs.ts`).
   - Greift, wenn `_DISPLAYNAME` leer ist (z.B. `ccm:commonlicense_key` hat nie ein DISPLAYNAME — daher die lokale License-Map).
3. **Letzter Fallback: rohe URI** — damit der Konsument zumindest etwas zurückbekommt.

**Rauschfilter:** Vokabular-Root-URIs (z.B. nur `.../discipline/` ohne konkretes Fach-Slug) werden ausgefiltert — sonst würde DISPLAYNAME den **Vokabular-Titel** ("Schulfächer", "Destatis-Systematik der Fächergruppen, Studienbereiche und Studienfächer") als Disziplin anzeigen.

#### Filter-Eingabe-Pfad (Label → URI) — bewusst konservativ

`resolveVocab` (`vocabs.ts`) deckt **nur die Schulfächer-Liste** ab. Begründung:

- Das Hochschul-Vocab und das Schul-Vocab teilen sich Labels: `"Mathematik"` existiert in beiden, mit unterschiedlicher Semantik (Schul-Mathematik = `discipline/380`; Hochschul-`n4` = "Mathematik, **Naturwissenschaften**" — viel breiter).
- Wer User-Input automatisch auch ins Hochschul-Vocab mappt, riskiert ungewollte Filter (z.B. wird auch Physik/Chemie/Bio mit-gefiltert).
- Mehrheit der WLO-Inhalte ist schulisch.
- Wer gezielt Hochschul-Inhalte will, kann orthogonal über `educationalContext: "Hochschule"` filtern.

**Resolver-Schritte** für Label-Eingabe:
1. URI? → durchreichen
2. Direkt-Match auf Label / Alias (case-insensitive)
3. Substring-Match (Label im Input ODER Input im Label) — fängt Tippfehler/Paraphrasen wie `"Naturwiss"` (matcht `"naturwissenschaften"`)
4. Kein Match → null (Caller kann den Wert trotzdem an die WLO-API durchgeben)

**Empfehlung für Konsumenten** (LLM-gestützte Apps):
Bei freier Nutzereingabe (`"sciences"`, `"Mathe Klasse 11 Gym"`) zuerst per LLM auf einen `lookup_wlo_vocabulary`-Eintrag mappen, dann den canonical Label / URI an die Such-Tools übergeben. So fängst du Paraphrasen ab, die Substring-Matching nicht mehr trifft.

Alle Werte mit URIs: `lookup_wlo_vocabulary({ vocabulary: "discipline" })`.

### Offizielle Vocab-Quellen

Wer das lokale Vocab in `src/vocabs.ts` aktualisieren oder Aliases ergänzen will:

| Vocab | URL |
|---|---|
| Schulfächer (`discipline`) | https://vocabs.openeduhub.de/w3id.org/openeduhub/vocabs/discipline/index.json |
| Bildungsstufe (`educationalContext`) | https://vocabs.openeduhub.de/w3id.org/openeduhub/vocabs/educationalContext/index.json |
| Zielgruppe (`userRole` / `intendedEndUserRole`) | https://vocabs.openeduhub.de/w3id.org/openeduhub/vocabs/intendedEndUserRole/index.json |
| Lernressourcentypen (aggregiert) (`lrt`) | https://vocabs.openeduhub.de/w3id.org/openeduhub/vocabs/new_lrt_aggregated/index.json |
| **Hochschulfächersystematik** (NICHT lokal gepflegt) | https://vocabs.openeduhub.de/w3id.org/openeduhub/vocabs/hochschulfaechersystematik/index.json |

Anzeige-Resolution für Hochschul-URIs erfolgt automatisch über `_DISPLAYNAME` aus dem edu-sharing-Index — ein lokales Hochschul-Vocab ist daher nicht nötig.

---

## Output-Formate (markdown vs. json)

Alle Tools mit Suchergebnissen unterstützen `outputFormat`:

### `outputFormat: "markdown"` (Default)

Menschenlesbare Karten, gut für Chat-Bots, die das LLM die Cards selbst rendern lassen. Beispiel:
```
## Bruchrechnung Einführung
nodeId: dc6b3f33-…
Beschreibung: …
Fach: Mathematik
Bildungsstufe: Sekundarstufe i
Lizenz: CC BY-SA 4.0
URL: https://…
Vorschaubild: https://…
Themenseite: https://…
Typ: Inhalt
```

### `outputFormat: "json"`

Strukturierter JSON-String, optimal für Konsumenten, die Daten programmatisch weiterverarbeiten:
```json
{
  "total": 287,
  "count": 5,
  "results": [
    {
      "nodeId": "dc6b3f33-…",
      "title": "Bruchrechnung Einführung",
      "description": "…",
      "keywords": ["Bruch", "Mathematik"],
      "disciplines": ["Mathematik"],
      "educationalContexts": ["Sekundarstufe i"],
      "userRoles": [],
      "learningResourceTypes": ["Video"],
      "license": "CC BY-SA 4.0",
      "publisher": "Mathe by Daniel Jung",
      "url": "https://…",
      "previewUrl": "https://…",
      "topicPageUrl": "",
      "nodeType": "content"
    }
  ]
}
```

> **Wichtig**: `disciplines`, `educationalContexts`, `userRoles`, `learningResourceTypes`, `license` sind **immer Labels**, nie URIs. Konsumenten können `card.disciplines[0]` direkt anzeigen.

---

## Determinismus & Stabilität

**Was du erwarten kannst:**
- Bei **identischer Input + identischem WLO-Server-Pool** liefern alle Tools deterministische Reihenfolge:
  - Tie-Breaker `nodeId.localeCompare()` in allen Rankings
  - `sortByTitle()` mit Tie-Breaker für alphabetische Sortierungen
  - `get_subject_portals`, `browse_collection_tree`, `search_wlo_topic_pages` (sort=alpha) sind vollständig deterministisch.
- **Mode C** von `search_wlo_topic_pages` ist deterministisch (alphabetisch über Sammlungsnamen).

**Was außerhalb unserer Kontrolle liegt:**
- Die **WLO-API** kann bei sehr ähnlichen Score-Treffern in seltenen Fällen einen anderen Pool liefern (Solr-Cache-Reshuffles serverseitig). Das beeinflusst `search_wlo_content` / Mode B von `search_wlo_topic_pages`. Mit `sort: "alpha"` umgehst du das.

---

## Deployment

### Option A: Vercel (empfohlen)

> Da die Web-Crawler-Tools entfernt sind, läuft v2 ohne Einschränkung auf **Vercel Hobby** (`maxDuration: 10s` reicht). Die `vercel.json` setzt trotzdem `maxDuration: 30` als Sicherheitspolster für `browse_collection_tree(depth=2, includeContentCounts=true)` bei breiten Bäumen.

1. Repo auf GitHub pushen
2. Vercel → New Project → Repo importieren
3. Environment Variable: `WLO_ENV=production`
4. Deploy → MCP-Endpoint: `https://dein-projekt.vercel.app/mcp`

### Option B: Docker

```bash
docker build -t wlomcp .
docker run -p 3000:3000 -e WLO_ENV=production wlomcp
# → http://localhost:3000/mcp
```

### Option C: Lokal

```bash
npm install
npm run build
node dist/http.js
# → http://localhost:3000/mcp
```

---

## Konfiguration in AI-Clients

### OpenAI (Responses API)

```python
response = client.responses.create(
    model="gpt-5",
    tools=[{
        "type": "mcp",
        "server_label": "wlo",
        "server_url": "https://dein-projekt.vercel.app/mcp",
        "require_approval": "never",
    }],
    input="Finde Unterrichtsmaterialien zu Bruchrechnung für die Grundschule",
)
```

### Anthropic (Claude)

```python
import anthropic
client = anthropic.Anthropic()

response = client.beta.messages.create(
    model="claude-opus-4-5",
    max_tokens=4096,
    mcp_servers=[{"type": "url", "url": "https://dein-projekt.vercel.app/mcp", "name": "wlo"}],
    messages=[{"role": "user", "content": "Suche WLO-Sammlungen zum Thema Klimawandel"}],
    betas=["mcp-client-2025-04-04"],
)
```

### Claude Desktop

```json
{
  "mcpServers": {
    "wlo": {
      "command": "node",
      "args": ["/pfad/zu/wlomcp/dist/stdio.js"],
      "env": { "WLO_ENV": "production" }
    }
  }
}
```

---

## Architektur

```
wlomcp/
├── src/
│   ├── server.ts       # 10 Tool-Definitionen (transport-agnostisch)
│   ├── vocabs.ts       # Label ↔ URI Mappings (educationalContext, discipline,
│   │                   #   userRole, lrt, license, targetGroup)
│   ├── wlo-api.ts      # WLO/EduSharing-API-Client + resolveVariantCollection
│   ├── reranker.ts     # Multi-Query-Expansion + RRF + Quality-Score (pure JS)
│   ├── formatter.ts    # WloNode → FormattedNode → Markdown / JSON
│   ├── stdio.ts        # Entry: stdio-Transport
│   └── http.ts         # Entry: Streamable HTTP
├── api/
│   └── mcp.ts          # Vercel-Serverless-Function-Wrapper
├── vercel.json         # Vercel-Config
├── Dockerfile
└── .env.example
```

**`FormattedNode`-Schema** (das gemeinsame Output-Format aller Tools):

```ts
{
  nodeId: string;
  title: string;
  description: string;
  keywords: string[];
  disciplines: string[];           // Labels: ["Mathematik"]
  educationalContexts: string[];   // Labels: ["Sekundarstufe i"]
  userRoles: string[];             // Labels: ["Lehrer/in"]
  learningResourceTypes: string[]; // Labels: ["Arbeitsblatt"]
  url: string;
  previewUrl: string;
  license: string;                 // Label: "CC BY-SA 4.0"
  publisher: string;
  nodeType: 'collection' | 'content';
  topicPageUrl: string;            // wenn ccm:page_config_ref vorhanden
}
```

**API-Basis-URLs:**

| Umgebung | Base URL |
|---|---|
| Production | `https://redaktion.openeduhub.net/edu-sharing/rest` |
| Staging | `https://repository.staging.openeduhub.net/edu-sharing/rest` |

---

## Migration v1 → v2

### Wenn du heute v1 nutzt

| v1-Verhalten | v2-Verhalten |
|---|---|
| `get_node_details` liefert `Fach-URI: http://w3id.org/.../380` | `get_node_details` liefert `Fach: Mathematik` (Label). Mit `includeRaw: true` zusätzlich URI |
| `Lizenz: CC_BY_SA` (Roh-Key) | `Lizenz: CC BY-SA 4.0` (Display-Form) |
| `## PAGE_VARIANT_TEMPLATE_xxx` als Themenseiten-Titel im Mode C | `## Mathematik` (Sammlungsname) — Owner wird via API resolvt |
| `Zielgruppe: teacher` (Slug) | `Zielgruppe: Lehrkräfte` (Label) |
| Mehrere Varianten = N separate Karten | 1 Karte mit `variants[]`-Array (oder `mergeVariants: false` für altes Verhalten) |
| Gleicher Score → unspezifizierte Reihenfolge | Tie-Breaker `nodeId.localeCompare()` → deterministisch |
| `get_*_info`-Tools (4 Stück) | **Entfernt**. Konsument soll RAG/eigene Page-Extraction nutzen |

### Empfohlene Migration

1. **Sofort ausführen**: `wlo_health_check` einmalig nach Deploy, Latenz prüfen, Server-Status verifizieren
2. **JSON-Output progressiv aktivieren**: Beginne mit `get_node_details` und `search_wlo_topic_pages` — die hatten in v1 die meisten Inkonsistenzen. Vorher: Markdown-Parsing → Nachher: `JSON.parse()`
3. **Webseiten-Tool-Aufrufe entfernen**: Wenn dein Client `get_wirlernenonline_info` etc. nutzt → entweder ein eigenes RAG aufsetzen oder das Tool aus dem Allowlist deines AI-Clients nehmen
4. **Variant-Merge-Code entfernen**: Wenn dein Client mehrere Varianten desselben Themas selbst gemerged hat → das macht der Server jetzt
5. **Discipline-URI-Resolver in Konsumenten**: Wer früher Karten-Disciplines manuell auf Labels resolvte, kann diese Logik abklemmen — Server liefert immer Labels

---

## Kompatibilität

- **Tool-Namen** sind ausschließlich Kleinbuchstaben + Unterstriche → kompatibel mit OpenAI / Anthropic
- **Input-Schemas** sind JSON Schema (via Zod) → Standard-konform
- **Transport**: Streamable HTTP (MCP spec 2025-03-26) für Vercel/Docker; stdio für lokale Clients
- **Stateless**: Kein Session-State → skaliert auf Vercel Serverless
- **Vercel-tauglich**: Reranker ist pure JS, kein Transformer-Modell, kein Speicherbedarf > Function-Limit
