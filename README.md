# WLO MCP Server

**WLO MCP** ist ein [Model Context Protocol](https://modelcontextprotocol.io) Server für [WirLernenOnline.de](https://wirlernenonline.de) (WLO) – die deutsche OER-Plattform für freie Bildungsmaterialien.

Kompatibel mit **OpenAI** (Responses API + native MCP), **Anthropic Claude** und allen anderen MCP-fähigen Clients.

---

## Inhaltsverzeichnis

1. [Installation](#installation)
2. [Tools im Überblick](#tools-im-überblick)
3. [Tools – Detail & API-Endpunkte](#tools--detail--api-endpunkte)
4. [Filter-Parameter](#filter-parameter)
5. [Deployment](#deployment)
6. [Konfiguration in AI-Clients](#konfiguration-in-ai-clients)
7. [Architektur](#architektur)
8. [Kompatibilität](#kompatibilität)

---

## Installation

### Voraussetzungen

- **Node.js** ≥ 18.x
- **npm** ≥ 9.x

### Lokale Installation

```bash
# Repository klonen
git clone https://github.com/yourorg/wlomcp.git
cd wlomcp

# Abhängigkeiten installieren
npm install

# TypeScript kompilieren
npm run build
```

### Umgebungsvariablen

```bash
# Optionale Konfiguration (Standard: production)
cp .env.example .env
```

| Variable | Werte | Standard | Beschreibung |
|---|---|---|---|
| `WLO_ENV` | `production`, `staging` | `production` | Ziel-Umgebung der WLO API |
| `PORT` | Zahl | `3000` | HTTP-Port (nur im HTTP-Modus) |

### Server starten

```bash
# HTTP-Modus (für REST/MCP-Clients)
node dist/http.js
# → Server läuft auf http://localhost:3000/mcp

# stdio-Modus (für Claude Desktop, lokale AI-Clients)
node dist/stdio.js

# Entwicklung mit Auto-Reload
npm run dev          # stdio
npm run dev:http     # HTTP
```

---

## Tools im Überblick

| # | Tool | Beschreibung |
|---|---|---|
| 1 | `search_wlo_collections` | Sammlungen (= Themenseiten) suchen – primär via Volltext-API, Fallback via Baum-Traversierung |
| 2 | `search_wlo_content` | Globale Volltextsuche nach Bildungsinhalten (Dateien, Videos, Arbeitsblätter) |
| 3 | `get_collection_contents` | Inhalte oder Untersammlungen einer Sammlung abrufen – mit Pagination via `skipCount` |
| 4 | `get_node_details` | Detailmetadaten, Volltext und Eltern-Sammlungen für eine Node-ID |
| 5a | `get_wirlernenonline_info` | Infos von der WirLernenOnline-Projektwebseite (mehrstufiges Crawling) |
| 5b | `get_edu_sharing_network_info` | Infos von edu-sharing-network.org (Community, Projekte, Events) |
| 5c | `get_edu_sharing_product_info` | Infos von edu-sharing.com (Produkt, Dokumentation, Features) |
| 5d | `get_metaventis_info` | Infos von metaventis.com (Unternehmen, Dienstleistungen) |
| 6 | `lookup_wlo_vocabulary` | Gültige Filterwerte für Bildungsstufe, Fach, Zielgruppe, Ressourcentyp |

> **Konzept:** In WLO sind **Sammlungen** und **Themenseiten** dasselbe. Eine Sammlung wird im WLO-Repository als Themenseite angezeigt und bündelt Bildungsinhalte in **Schwimmlinien (Swimlanes/Karussells)**. Untersammlungen entsprechen Unter-Themenseiten.

> **Tool-Routing:** Das LLM sollte `search_wlo_content` (nicht `search_wlo_collections`) nutzen, wenn nach konkreten Inhaltstypen gefragt wird (Videos, Arbeitsblätter, PDFs). Die Web-Tools (`get_*_info`) sollten genutzt werden, wenn nach den Projekten/Plattformen selbst gefragt wird – nicht nach Lernmaterialien.

---

## Tools – Detail & API-Endpunkte

### 1. `search_wlo_collections`

Sucht thematische Sammlungen (Themenseiten) im WLO-Repository.

**Parameter:**

| Parameter | Typ | Standard | Beschreibung |
|---|---|---|---|
| `query` | string | `""` | Suchbegriff, z.B. `"Algebra"`, `"Klimawandel"`. Leer = alle Top-Level-Sammlungen anzeigen |
| `parentNodeId` | string | – | NodeId einer Eltern-Sammlung für Suche im Teilbaum (z.B. Mathematik-NodeId, um darin nach Algebra zu suchen) |
| `educationalContext` | string | – | Bildungsstufe: `"Primarstufe"`, `"Sekundarstufe I"` oder URI |
| `discipline` | string | – | Fach: `"Mathematik"`, `"Biologie"` oder URI |
| `userRole` | string | – | Zielgruppe: `"Lehrer/in"`, `"Lerner/in"` oder URI |
| `maxResults` | int | `5` | Max. Ergebnisse (1–20) |
| `environment` | enum | `production` | `"production"` oder `"staging"` |

**Verwendete API-Endpunkte:**

```
# Primär: Volltext-Sammlungssuche (gibt isDirectory=true Nodes zurück)
POST /search/v1/queries/-home-/mds_oeh/collections?contentType=COLLECTIONS&maxItems={n}

Body: { "criteria": [ { "property": "ngsearchword", "values": ["..."] } ] }

# Fallback: Kinder-Traversierung (wenn parentNodeId gegeben oder Direktsuche leer)
GET /node/v1/nodes/-home-/{nodeId}/children?filter=folders&maxItems=100&propertyFilter=-all-
```

**Suchstrategie:**

1. **Direktsuche (primär):** Bei gesetztem `query` ohne `parentNodeId` → Volltext-API mit `contentType=COLLECTIONS`. Liefert echte Collection-Nodes (`isDirectory=true`). Eigenschaften wie Titel und Beschreibung sind direkt am Node (`node.collection.description`).
2. **Baum-Traversierung (Fallback):** Bei `parentNodeId` oder leerem Ergebnis → Kinder-Traversierung ab der Startnode (WLO-Root oder gegebener Parent). Keyword-Matching auf `cm:name`, `cclom:title`, `cclom:general_description`. Suchbegriff wird in Einzelwörter zerlegt – Treffer bei jedem Wort.
3. **Formatierung:** Jede Sammlung wird mit `nodeId`, Titel, Beschreibung, Fach, Bildungsstufe, Schlagworten, WLO-URL und `Typ: Sammlung` ausgegeben.

---

### 2. `search_wlo_content`

Globale Volltextsuche nach einzelnen Bildungsmaterialien (Dateien, Videos, Arbeitsblätter, etc.).

**Parameter:**

| Parameter | Typ | Standard | Beschreibung |
|---|---|---|---|
| `query` | string | **Pflicht** | Suchbegriff, z.B. `"Bruchrechnung Grundschule"` |
| `educationalContext` | string | – | Bildungsstufe |
| `discipline` | string | – | Fach |
| `userRole` | string | – | Zielgruppe |
| `learningResourceType` | string | – | Ressourcentyp: `"Arbeitsblatt"`, `"Video"`, etc. |
| `publisher` | string | – | Anbieter/Quelle: `"Klexikon"`, `"Serlo"`, `"ZUM"`, etc. |
| `maxResults` | int | `8` | Max. Ergebnisse (1–20) |
| `environment` | enum | `production` | `"production"` oder `"staging"` |

**Verwendete API-Endpunkte:**

```
POST /search/v1/queries/-home-/mds_oeh/ngsearch?contentType=FILES&maxItems={n}&skipCount=0&propertyFilter=-all-

Body: { "criteria": [ { "property": "ngsearchword", "values": ["..."] }, ... ] }
```

Mögliche `criteria`-Properties:

| Property | Zweck |
|---|---|
| `ngsearchword` | Volltext-/Titelsuche |
| `ccm:taxonid` | Fach-URI (z.B. `http://w3id.org/openeduhub/vocabs/discipline/380`) |
| `ccm:educationalcontext` | Bildungsstufe-URI |
| `ccm:educationalintendedenduserrole` | Zielgruppen-URI |
| `ccm:oeh_lrt_aggregated` | Lernressourcentyp-URI |
| `ccm:oeh_publisher_combined` | Publisher/Anbieter-Filter (z.B. `"Klexikon"`) |

**Nachbereitung (Multi-Query + Reranking):**

1. **Query Expansion:** Aus dem Suchbegriff werden mehrere Varianten generiert (Volltext, Titelsuche, Keywords, Synonyme, Einzelterme).
2. **Parallele API-Anfragen:** Alle Varianten werden gleichzeitig abgefragt (bis zu 40 Ergebnisse pro Variante).
3. **Reciprocal Rank Fusion (RRF):** Ergebnisse aus allen Varianten werden nach RRF zusammengeführt.
4. **Qualitätsscoring:** Jeder Node erhält einen Score aus: Titelrelevanz (30 Pt.), Keywords (10 Pt.), Beschreibung (8 Pt.), Metadatenqualität. Qualitätsscore dominiert (80%), RRF ist sekundär (10%), Multi-Appearance-Bonus (10%).
5. **Filter-Kriterien** (Fach, Stufe, etc.) werden direkt als `criteria` an die API übergeben, nicht als Post-Filter.

---

### 3. `get_collection_contents`

Ruft die Inhalte (Dateien/Untersammlungen) einer bekannten Sammlung ab.

**Parameter:**

| Parameter | Typ | Standard | Beschreibung |
|---|---|---|---|
| `nodeId` | string | **Pflicht** | NodeId der Sammlung (aus `search_wlo_collections`) |
| `query` | string | – | Optionaler Suchbegriff zum Reranking der Ergebnisse |
| `contentFilter` | enum | `"files"` | `"files"` = Lernmaterialien, `"folders"` = Unter-Sammlungen, `"both"` = alles |
| `includeSubcollections` | bool | `false` | Wenn `true`: rekursiv alle Untersammlungen traversieren |
| `maxResults` | int | `20` | Max. Ergebnisse (1–100) |
| `skipCount` | int | `0` | Offset für Pagination (0 = erste Seite, 4 = zweite Seite bei maxResults=4) |
| `environment` | enum | `production` | `"production"` oder `"staging"` |

**Verwendete API-Endpunkte:**

```
# Inhalte (Dateien)
GET /node/v1/nodes/-home-/{nodeId}/children?filter=files&maxItems={n}&skipCount={s}&propertyFilter=-all-

# Untersammlungen
GET /node/v1/nodes/-home-/{nodeId}/children?filter=folders&maxItems={n}&skipCount={s}&propertyFilter=-all-

# Alles (kein Filter)
GET /node/v1/nodes/-home-/{nodeId}/children?maxItems={n}&skipCount={s}&propertyFilter=-all-
```

**Pagination:** Die Antwort enthält `pagination.total`. Mit `skipCount` kann seitenweise durch Inhalte geblättert werden, z.B. `maxResults=4, skipCount=0` (1–4), `skipCount=4` (5–8) usw.

**Nachbereitung:**

- Bei `includeSubcollections=true`: BFS-Traversierung (Breadth-First) des Sammlungsbaums. Für jede Sammlung werden erst die Dateien geholt, dann die Untersammlungen in eine Queue eingefügt. Abbruch bei `maxResults`.
- Optional: Falls `query` angegeben, werden die Ergebnisse per Relevanz-Reranking (Titelvergleich) umsortiert.

---

### 4. `get_node_details`

Liefert detaillierte Informationen zu einem einzelnen Node (Content-Item oder Sammlung).

**Parameter:**

| Parameter | Typ | Standard | Beschreibung |
|---|---|---|---|
| `nodeId` | string | **Pflicht** | Node-ID aus Suchergebnissen |
| `includeTextContent` | bool | `false` | Gespeicherten Volltext (gecrawlte Webseite/PDF) abrufen |
| `includeParents` | bool | `false` | Eltern-Sammlungen des Nodes abrufen |
| `environment` | enum | `production` | `"production"` oder `"staging"` |

**Verwendete API-Endpunkte:**

```
# Metadaten (immer)
GET /node/v1/nodes/-home-/{nodeId}/metadata?propertyFilter=-all-

# Gespeicherter Volltext (optional, wenn includeTextContent=true)
GET /node/v1/nodes/-home-/{nodeId}/textContent

# Eltern-Sammlungen (optional, wenn includeParents=true)
GET /node/v1/nodes/-home-/{nodeId}/parents?propertyFilter=-all-
```

**Nachbereitung:**

- Aus den Rohdaten werden Titel, Beschreibung, Schlagworte, Fach-URI, Bildungsstufe-URI, Lizenz, Anbieter, URL und WLO-Render-URL extrahiert.
- `textContent`: Der gecrawlte Volltext ist nicht für alle Nodes verfügbar. Wenn vorhanden, wird er auf 2.000 Zeichen gekürzt.
- `parents`: Gibt die direkten Eltern-Sammlungen zurück (Name + NodeId). Nützlich um herauszufinden, in welcher Themenseite ein Inhalt eingebettet ist.

---

### 5. Web-Informations-Tools (4 Tools)

Die vier Web-Tools rufen Informationen von den Projektwebseiten ab. Jedes Tool ist einer Domain fest zugeordnet und wird vom LLM anhand der Themen-Keywords ausgewählt.

| Tool | Base URL | Trigger-Keywords |
|---|---|---|
| `get_wirlernenonline_info` | `https://www.wirlernenonline.de` | WLO, WirLernenOnline, OER, Fachportale, Qualitätssicherung, Mitmachen, Informatik, Deutsch, Medienbildung, ComeIn |
| `get_edu_sharing_network_info` | `https://edu-sharing-network.org` | edu-sharing Vernetzung, JOINTLY, ITsJOINTLY, BIRD, Bildungsraum Digital, Hackathon, OER-Sommercamp |
| `get_edu_sharing_product_info` | `https://edu-sharing.com` | edu-sharing Produkt, Repository, Suchmaschine, Moodle Integration, Cloudspeicher, Plugins, Dokumentation, Demo |
| `get_metaventis_info` | `https://metaventis.com` | metaVentis, Schulcloud, IDM, Autoren-Lösung, F&E, Firmenwissen und E-Learning |

**Parameter (alle 4 Tools identisch):**

| Parameter | Typ | Standard | Beschreibung |
|---|---|---|---|
| `path` | string | `""` | Unterseiten-Pfad, z.B. `"/fachportale/informatik"`. Leer = Hauptseite |
| `maxLength` | int | `8000` | Max. Zeichen im Markdown-Output (500–20000) |

**Verwendeter externer Dienst:**

```
POST https://text-extraction.staging.openeduhub.net/from-url

Body: { "url": "...", "method": "browser", "output_format": "markdown" }
```

Der Dienst rendert die Seite mit einem Headless-Browser und extrahiert den Textinhalt als Markdown (JavaScript-gerenderte Seiten werden korrekt erfasst).

**Mehrstufiges Crawling (bis 5 Ebenen):**

Jedes Tool unterstützt eine LLM-gesteuerte mehrstufige Exploration:

1. Tool ohne `path` aufrufen → Hauptseite laden, Navigationslinks entdecken
2. Den **einen** relevantesten Link identifizieren → Tool erneut mit `path: "/unterseite"` aufrufen
3. Schritte 1–2 wiederholen bis max. **5 Ebenen** oder ausreichend Information vorhanden
4. Nur **einen Link pro Ebene** folgen (keine parallelen Abrufe auf gleicher Tiefe)

**Whitelist erweitern:** In `src/wlo-api.ts` → `WEB_CONTENT_WHITELIST` Array anpassen.

---

### 6. `lookup_wlo_vocabulary`

Listet alle gültigen Werte und URIs für die Filter-Parameter auf.

**Parameter:**

| Parameter | Typ | Beschreibung |
|---|---|---|
| `vocabulary` | enum | `"educationalContext"`, `"discipline"`, `"userRole"`, `"lrt"` |

**Keine API-Anfrage** – die Vocabularies sind lokal in `src/vocabs.ts` hinterlegt (aus den offiziellen WLO-Vokabulardateien generiert).

---

## Filter-Parameter

Alle Filter akzeptieren **deutsche Labels** *oder* **vollständige URIs**. Die URI-Auflösung erfolgt lokal über `src/vocabs.ts`.

| Parameter | Beispiel-Labels | Vocabulary-Key |
|---|---|---|
| `educationalContext` | `Primarstufe`, `Sekundarstufe I`, `Hochschule`, `Berufliche Bildung` | `educationalContext` |
| `discipline` | `Mathematik`, `Biologie`, `Informatik`, `Deutsch`, `MINT` | `discipline` |
| `userRole` | `Lehrer/in`, `Lerner/in`, `Eltern`, `Berater/in` | `userRole` |
| `learningResourceType` | `Arbeitsblatt`, `Video`, `Unterrichtsplan`, `Interaktives Medium` | `lrt` |

Alle verfügbaren Werte mit URIs: `lookup_wlo_vocabulary(vocabulary="discipline")` etc.

---

## Deployment

### Option A: Vercel (empfohlen für öffentliche API)

> **Hinweis Vercel-Plan:** Die Web-Tools (`get_*_info`) rufen einen externen Browser-Rendering-Dienst auf, der bis zu 20–30 Sekunden dauern kann. Die `vercel.json` setzt `maxDuration: 30`. Vercel **Hobby** erlaubt maximal 10 Sekunden – für die Web-Tools ist daher mindestens **Vercel Pro** erforderlich. Alle anderen Tools (Suche, Collections, Node-Details, Vokabular) laufen problemlos auf Hobby.

1. Repository auf GitHub pushen
2. Vercel → **New Project** → Repository importieren
3. **Environment Variable** setzen (kann im Dashboard überschrieben werden):

   | Name | Wert |
   |---|---|
   | `WLO_ENV` | `production` oder `staging` |

4. Deploy → MCP-Endpoint: `https://dein-projekt.vercel.app/mcp`

### Option B: Docker (selbst gehostet, HTTP-Modus)

```bash
# Build
docker build -t wlomcp .

# Starten (Production, Port 3000)
docker run -p 3000:3000 -e WLO_ENV=production wlomcp

# Staging-Umgebung
docker run -p 3000:3000 -e WLO_ENV=staging wlomcp
```

MCP-Endpoint: `http://localhost:3000/mcp`

### Option C: Docker (stdio-Modus, für lokale AI-Clients)

```bash
docker run -i --rm -e WLO_ENV=production wlomcp node dist/stdio.js
```

### Option D: Lokal (Entwicklung)

```bash
cd wlomcp
npm install
npm run build

# HTTP-Server auf Port 3000
node dist/http.js

# Oder mit Auto-Reload
npm run dev:http
```

---

## Konfiguration in AI-Clients

### OpenAI (Responses API)

```python
response = client.responses.create(
    model="gpt-4o",
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

server = {"type": "url", "url": "https://dein-projekt.vercel.app/mcp", "name": "wlo"}
response = client.beta.messages.create(
    model="claude-opus-4-5",
    max_tokens=4096,
    mcp_servers=[server],
    messages=[{"role": "user", "content": "Suche WLO-Sammlungen zum Thema Klimawandel für die Sekundarstufe I"}],
    betas=["mcp-client-2025-04-04"],
)
```

### Claude Desktop (`claude_desktop_config.json`)

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
│   ├── server.ts       # MCP Server + alle 9 Tool-Definitionen (transport-agnostisch)
│   ├── vocabs.ts       # Label ↔ URI Mappings (Bildungsstufe, Fach, Zielgruppe, LRT)
│   ├── wlo-api.ts      # WLO/EduSharing API Client + Web Content Extraction + Whitelist
│   ├── reranker.ts     # Multi-Query-Expansion + RRF + Relevance Scoring
│   ├── formatter.ts    # WLO-Node → strukturierter Markdown-Output (mit Typ: Sammlung/Inhalt)
│   ├── stdio.ts        # Entry: stdio Transport
│   └── http.ts         # Entry: Streamable HTTP Transport
├── api/
│   └── mcp.ts          # Vercel Serverless Function
├── vercel.json         # Vercel Konfiguration (maxDuration: 30s für Web-Tools)
├── Dockerfile          # Docker Build
└── .env.example        # Umgebungsvariablen
```

**Output-Format (`formatter.ts`):**

Jeder Node wird als Markdown-Block ausgegeben:
```
## Titel
nodeId: <uuid>
Beschreibung: ...
Fach: Mathematik
Bildungsstufe: Sekundarstufe I
URL: https://...
Vorschaubild: https://...
Typ: Sammlung   ← oder: Typ: Inhalt
```

`Typ: Sammlung` = Collection-Node (`isDirectory=true`), `Typ: Inhalt` = Datei/Material.

**API-Basis-URLs:**

| Umgebung | Base URL |
|---|---|
| Production | `https://redaktion.openeduhub.net/edu-sharing/rest` |
| Staging | `https://repository.staging.openeduhub.net/edu-sharing/rest` |

---

## Kompatibilität

- **Tool-Namen** verwenden ausschließlich Kleinbuchstaben und Unterstriche — kompatibel mit OpenAI und Anthropic
- **Input-Schemas** sind JSON Schema (via Zod) — Standard-konform
- **Transport**: Streamable HTTP (MCP spec 2025-03-26) für Vercel/Docker; stdio für lokale Clients
- **Stateless**: Kein Session-State → skaliert auf Vercel Serverless
