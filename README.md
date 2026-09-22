# Research Dossier Synthesizer MCP

An MCP server for consultants: decompose research briefs into parallel search queries, synthesize raw findings into a structured dossier with citations, and export it for delivery.

## Setup

```bash
npm install
npm run build
npm run dev
```

The server needs at least one LLM provider configured via environment variables (see below) — it will fail to start without one.

## Configuration

Set these as environment variables (e.g. in a local `.env` file, or in the `env` block of your MCP client config):

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | one of these | Anthropic API key. Takes priority over Gemini if both are set. |
| `GEMINI_API_KEY` | one of these | Google Gemini API key. |
| `LLM_PROVIDER` | no | `anthropic` or `gemini` — forces a provider instead of auto-detecting from which key is present. |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-sonnet-5`. |
| `GEMINI_MODEL` | no | Defaults to `gemini-flash-latest`. |
| `ANTHROPIC_WORKSPACE_ID` | no | Required only if your Anthropic API key is workspace-scoped (sends the `anthropic-workspace-id` header). |

Gemini's free tier has a low daily request quota per model — if you hit `429 RESOURCE_EXHAUSTED`, the server retries with backoff automatically, but a model-wide daily cap needs either waiting for it to reset, switching `GEMINI_MODEL` to one with separate quota, or enabling billing on the Google Cloud project.

## Tools

**decompose_research_brief**
- Input: Research topic, depth level (surface/intermediate/deep)
- Output: 5-7 focused research queries (JSON)
- Use: Break down complex briefs into parallel search tasks

**synthesize_research**
- Input: Raw research findings (web_search output), original brief
- Output: Structured dossier (markdown/JSON/outline)
- Use: Transform findings into exec summary + detailed sections + citations

**run_research_workflow**
- Input: `brief`, `depth` (surface/intermediate/deep), `format` (markdown/json/outline), `max_results_per_query` (1-10, default 6)
- Output: The synthesized dossier, followed by a `---` and a workflow-notes line
- Use: One-shot version of decompose → search → synthesize. Runs `decompose_research_brief`, then fires a provider-native web search for every resulting query **in parallel** (Claude's server-side `web_search` tool, or Gemini's `google_search` grounding tool — whichever provider is configured), deduplicates sources across all queries by normalized URL, and feeds the aggregated findings into `synthesize_research`.
- A search failure on one query doesn't fail the whole run — that query's findings become `"Search failed: <reason>"` and it's counted separately, listed by name in the workflow-notes line.
- The workflow-notes line reports: queries run, unique sources gathered, any queries that returned zero sources, and a citation count (`N/M valid`) — see **Citation validation** below.

**export_dossier**
- Input: `dossier` (markdown), `format` (markdown/pdf-outline/slide-outline)
- Output:
  - `markdown`: the dossier text, unchanged, as a `text` content block.
  - `pdf-outline`: a rendered PDF (headings, bold/italic, links, bullet/numbered lists incl. one level of nesting, tables, code blocks, blockquotes, horizontal rules), returned as an MCP `resource` content block — `{ type: "resource", resource: { uri: "dossier://export.pdf", mimeType: "application/pdf", blob: "<base64>" } }`.
  - `slide-outline`: `{ "slides": [{ "title": string, "content": string[], "notes": string }] }` as a `text` content block (pretty-printed JSON). Each H1 in the markdown starts a new slide; each H2 is pushed onto `content` as a `"## heading"` marker; every other block (paragraphs, lists, tables, code, blockquotes) becomes one `content` entry, in document order. `notes` is currently always `""` — the dossier format has no dedicated speaker-notes convention.

### Citation validation

`run_research_workflow` cross-checks every `[Source: URL]` in the final dossier against the pool of URLs actually returned by the underlying web searches (`sourcesGathered`, deduplicated with trailing-slash/fragment-insensitive normalization). A citation counts as valid only if it's a well-formed `http(s)` URL *and* matches a gathered source. The workflow-notes footer reports the tally and lists up to 5 unmatched citations, so you can spot fabricated or malformed URLs at a glance. `synthesize_research` on its own has no source pool to check against — if you're calling it directly with your own findings, verify citations manually.

## Integration with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "research-dossier": {
      "command": "node",
      "args": ["/path/to/research-dossier-mcp/dist/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Run `npm run build` first so `dist/index.js` exists. Fully quit and reopen Claude Desktop (not just close the window) to pick up config changes.

## Typical Workflow

**One-shot (recommended):**

1. **User** (you): "Research SaaS consolidation trends in APAC"
2. **run_research_workflow**: Decomposes the brief, searches every query in parallel, synthesizes the results, and returns the finished dossier plus a workflow-notes summary in one call.
3. **export_dossier**: Output as markdown, PDF, or a slide outline for delivery.

**Manual (more control over each step):**

1. **decompose_research_brief**: Generates 6 queries:
   - SaaS consolidation metrics 2024-2026
   - APAC adoption rates by vertical
   - Cost savings benchmarks
   - Integration & vendor lock-in concerns
   - Regulatory drivers (India, Singapore, etc.)
   - Competitive landscape (Gartner, Forrester reports)
2. **Claude** (with its own web_search, or by calling this server's queries individually): Runs queries in parallel, collects findings
3. **synthesize_research**: Compiles findings into dossier:
   - Exec summary (200 words)
   - Key findings (3-5 points with citations)
   - Trends by region/vertical
   - Implications for consulting clients
4. **export_dossier**: Output as markdown → PDF/slides, or send to client

Use the manual path when you want to substitute your own search results (e.g. from a client's proprietary database) instead of the provider's built-in web search, or want to inspect/edit findings between steps.

## Troubleshooting

- **`No LLM configured` at startup**: neither `ANTHROPIC_API_KEY` nor `GEMINI_API_KEY` is set in the environment the server actually runs in (a local `.env` file is *not* auto-loaded — export the vars or pass them via your MCP client's `env` block).
- **`Gemini API error (429): ...RESOURCE_EXHAUSTED`**: daily free-tier quota hit for `GEMINI_MODEL`. The server retries transient 429/503s with backoff automatically; a hard daily cap needs waiting for reset, switching models, or enabling billing.
- **`Gemini API error (400)` mentioning `thinkingConfig`**: some Gemini model variants reject `thinkingConfig` outright — the server detects this and retries without it automatically. If you still see this bubble up as a final error, the underlying request itself is likely malformed (check `GEMINI_MODEL` is a real model name).
- **`decompose_research_brief did not return valid JSON`** (from `run_research_workflow`): the model wrapped its JSON in prose or markdown fences despite the system prompt. Retrying usually resolves it; if it's persistent for a given provider/model, tighten the system prompt in `decomposeResearchBrief` (`src/research.ts`).
- **Citations flagged as unmatched in the workflow-notes footer**: `synthesize_research` restated a claim without carrying over its `[Source: URL]` verbatim, or invented one. Check `src/research.ts`'s `synthesizeResearch` system prompt first — it's instructed to preserve URLs exactly and drop unsourced claims, but small/fast models sometimes ignore that.
- **A query in `run_research_workflow` comes back empty**: normal and handled gracefully — that query's findings become a "no results" note, it's excluded from the source pool, and it's called out by name in the workflow-notes footer. If *every* query comes back empty, suspect an API-level issue (auth, quota, or the model not invoking its search tool) rather than the topic itself.
- **PDF export looks off for very unusual markdown**: the renderer (`src/export.ts`) handles headings, bold/italic/links/inline code, one level of nested bullet/numbered lists, tables, fenced code blocks, blockquotes, and horizontal rules. Anything else (e.g. deeply nested lists, HTML blocks, footnotes) falls back to plain text rather than failing the export.

## Notes

- Synthesis quality depends on prompt tuning — see `synthesizeResearch` in `src/research.ts`.
- Citations are requested inline as `[Source: URL]`; `run_research_workflow` validates them automatically (see above), but if you call `synthesize_research` directly with your own findings, verify citations manually.
- `export_dossier` does no LLM call (it's pure markdown parsing + PDF/JSON rendering), so it needs no provider key by itself — but the server as a whole still requires one configured to start.
