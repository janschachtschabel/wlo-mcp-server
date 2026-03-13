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
| 1 | `search_wlo_collections` | Sammlungen (= Themenseiten) suchen und durchsuchen |
| 2 | `search_wlo_content` | Globale Volltextsuche nach Bildungsinhalten (Dateien/Materialien) |
| 3 | `get_collection_contents` | Inhalte oder Untersammlungen einer Sammlung abrufen (via nodeId) |
| 4 | `get_node_details` | Detailmetadaten, Volltext und Eltern-Sammlungen für eine Node-ID |
| 5 | `fetch_web_content` | Textinhalt einer Projektwebseite als Markdown extrahieren |
| 6 | `lookup_wlo_vocabulary` | Gültige Filterwerte für Bildungsstufe, Fach, Zielgruppe, Ressourcentyp |

> **Konzept:** In WLO sind **Sammlungen** und **Themenseiten** dasselbe. Eine Sammlung wird im WLO-Repository als Themenseite angezeigt und bündelt Bildungsinhalte in **Schwimmlinien (Swimlanes/Karussells)**. Untersammlungen entsprechen Unter-Themenseiten.

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
GET /node/v1/nodes/-home-/{nodeId}/children?filter=folders&maxItems=100&propertyFilter=-all-
```

- `nodeId` ist bei leerem `parentNodeId` die WLO-Root-Collection-ID (`5e40e372-735c-4b17-bbf7-e827a5702b57`), andernfalls die übergebene `parentNodeId`.
- Der Parameter `filter=folders` liefert ausschließlich Verzeichnis-Nodes (Sammlungen), keine Inhalts-Dateien.

**Nachbereitung (Browse-then-Filter):**

> **Hinweis:** Der `ngsearch`-Endpunkt liefert für anonyme Nutzer keine echten Collection-Nodes, unabhängig von `contentType=COLLECTIONS` oder `filter=collections`. Die einzig funktionierende Methode für anonymen Zugriff auf Sammlungen ist die Kinder-Traversierung über `/children?filter=folders`.

1. **Level 1:** Direkte Kinder der Startnode werden abgerufen (max. 100).
2. **Keyword-Filter:** Treffer werden über Volltextvergleich gegen `cm:name`, `cclom:title` und `cclom:general_description` ermittelt.
3. **Level 2 Fallback:** Falls auf Level 1 keine Treffer → alle Level-1-Kinder werden parallel abgefragt und deren Kinder gefiltert.
4. **Formatierung:** Jede Sammlung wird mit nodeId, Titel, Fach, Bildungsstufe, Schlagworten und WLO-URL ausgegeben.

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
| `environment` | enum | `production` | `"production"` oder `"staging"` |

**Verwendete API-Endpunkte:**

```
# Inhalte (Dateien)
GET /node/v1/nodes/-home-/{nodeId}/children?filter=files&maxItems={n}&propertyFilter=-all-

# Untersammlungen
GET /node/v1/nodes/-home-/{nodeId}/children?filter=folders&maxItems={n}&propertyFilter=-all-

# Alles (kein Filter)
GET /node/v1/nodes/-home-/{nodeId}/children?maxItems={n}&propertyFilter=-all-
```

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

### 5. `fetch_web_content`

Extrahiert den Textinhalt einer Projektwebseite als Markdown.

**Parameter:**

| Parameter | Typ | Standard | Beschreibung |
|---|---|---|---|
| `url` | string (URL) | **Pflicht** | Vollständige URL der Seite |
| `maxLength` | int | `8000` | Max. Zeichen im Markdown-Output (500–20000) |

**Verwendeter externer Dienst:**

```
POST https://text-extraction.staging.openeduhub.net/from-url

Body:
{
  "url": "https://...",
  "method": "browser",
  "browser_location": null,
  "lang": "auto",
  "output_format": "markdown",
  "preference": "none"
}
```

Der Dienst rendert die Seite mit einem Headless-Browser und extrahiert den Textinhalt als Markdown. Damit werden auch JavaScript-gerenderte Seiten korrekt erfasst.

**Whitelist – erlaubte Domains:**

Aus Sicherheitsgründen darf der Tool-Aufruf nur URLs aus folgenden Domains abrufen. Unterseiten (beliebige Pfade) sind jeweils erlaubt:

| Domain | Beschreibung |
|---|---|
| `https://www.wirlernenonline.de` | WLO-Projektwebseite |
| `https://edu-sharing-network.org` | edu-sharing Network e.V. |
| `https://edu-sharing.com` | edu-sharing Plattform |
| `https://metaventis.com` | Metaventis GmbH |

Subdomains der gelisteten Domains sind ebenfalls erlaubt. Jede andere URL wird mit einer Fehlermeldung abgewiesen.

**Whitelist erweitern:** In `src/wlo-api.ts` → `WEB_CONTENT_WHITELIST` Array anpassen.

**Nachbereitung:**

- Der Markdown-Output wird auf `maxLength` Zeichen gekürzt. Ein Hinweis im Text signalisiert die Kürzung.
- **Empfohlener Workflow:** Hauptseite zuerst abrufen → Navigationslinks im Markdown erkennen → relevante Unterseiten gezielt nachladen.

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

> **Hinweis Vercel-Plan:** Das Tool `fetch_web_content` ruft einen externen Browser-Rendering-Dienst auf, der bis zu 20–30 Sekunden dauern kann. Das `vercel.json` setzt `maxDuration: 30`. Vercel **Hobby** erlaubt maximal 10 Sekunden – für `fetch_web_content` ist daher mindestens **Vercel Pro** erforderlich. Alle anderen Tools (Suche, Collections, Node-Details) laufen problemlos auf Hobby.

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
│   ├── server.ts       # MCP Server + alle 6 Tool-Definitionen (transport-agnostisch)
│   ├── vocabs.ts       # Label ↔ URI Mappings (Bildungsstufe, Fach, Zielgruppe, LRT)
│   ├── wlo-api.ts      # WLO/EduSharing API Client + Web Content Extraction
│   ├── reranker.ts     # Multi-Query-Expansion + RRF + Relevance Scoring
│   ├── formatter.ts    # WLO-Node → strukturierter Markdown-Output
│   ├── stdio.ts        # Entry: stdio Transport
│   └── http.ts         # Entry: Streamable HTTP Transport
├── api/
│   └── mcp.ts          # Vercel Serverless Function
├── vercel.json         # Vercel Konfiguration
├── Dockerfile          # Docker Build
└── .env.example        # Umgebungsvariablen
```

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
