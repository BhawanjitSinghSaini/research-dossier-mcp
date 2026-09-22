import { callLLM, webSearch, type QueryFindings, type SearchSource } from "./llm.js";

export async function decomposeResearchBrief(brief: string, depth: string): Promise<string> {
  const system = `You are a research strategist. Decompose a research brief into 5-7 focused, non-overlapping research queries.

For depth level "${depth}":
- surface: Quick overview queries (3-5 min searches each)
- intermediate: Balanced research (5-10 min each)
- deep: Thorough investigation (10-15 min each, includes academic/proprietary sources)

Return ONLY a JSON array of query objects with "query" and "priority" fields. No markdown, no preamble.`;

  return callLLM(system, `Research brief: "${brief}"`, 1024);
}

export async function synthesizeResearch(findings: string, brief: string, format: string): Promise<string> {
  const system = `You are a research synthesis expert. Transform raw research findings into a polished dossier.

Structure (${format}):
- Executive Summary (200 words max)
- Key Findings (3-5 major points)
- Detailed Analysis (by topic, with citations — 600-900 words total across all subsections)
- Trends & Implications
- Recommendations
- Sources

Length budget: the whole dossier must fit in 1500-2500 words. This is a hard budget, not a suggestion —
condense or cut lower-priority findings/topics as needed. A complete, shorter dossier is always better
than a longer one that gets cut off before reaching Recommendations and Sources.

Citation rules:
- The raw findings already contain [Source: URL] tags anchored to real search results. Preserve those exact URLs verbatim whenever you reuse the claim they support, including the "https://" (or "http://") scheme — never shorten a citation to a bare domain like "example.com/path".
- A citation bracket contains nothing but one URL: "[Source: https://...]". Never put commentary, caveats, or more than one URL inside the brackets — if a claim's sourcing needs a caveat, write that in the sentence itself, outside the brackets.
- Never invent, alter, or guess a URL. If a claim has no [Source: URL] backing it in the raw findings, either drop the claim or state plainly that no source was found for it.
- Be factual. Flag uncertainties. Avoid speculation.`;

  const userMessage = `Research brief: "${brief}"

Raw findings:
${findings}`;

  return callLLM(system, userMessage, 6000);
}

interface DecomposedQuery {
  query: string;
  priority?: string;
}

export function parseDecomposedQueries(raw: string): DecomposedQuery[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `decompose_research_brief did not return valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("decompose_research_brief output was not a JSON array");
  }

  return parsed.map((item, i) => {
    if (typeof item !== "object" || item === null || typeof (item as Record<string, unknown>).query !== "string") {
      throw new Error(`decompose_research_brief item ${i} is missing a "query" string field`);
    }
    const record = item as Record<string, unknown>;
    return {
      query: record.query as string,
      priority: typeof record.priority === "string" ? record.priority : undefined,
    };
  });
}

export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function dedupeSources(sources: SearchSource[]): SearchSource[] {
  const seen = new Map<string, SearchSource>();
  for (const source of sources) {
    if (!source.url) continue;
    const key = normalizeUrl(source.url);
    if (!seen.has(key)) seen.set(key, source);
  }
  return [...seen.values()];
}

export interface CitationValidation {
  total: number;
  valid: number;
  unmatched: string[];
}

/**
 * Loosely normalizes a URL-ish string for citation matching: strips scheme, "www.", query
 * string, fragment, and trailing slash. Deliberately looser than `normalizeUrl` (used for
 * deduping the source pool itself) because models sometimes restate a cited URL without its
 * scheme — that's a formatting slip, not a fabricated source, and shouldn't read as invalid.
 */
function looseUrlKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[?#]/)[0]
    .replace(/\/$/, "");
}

function looksLikeUrl(raw: string): boolean {
  return (
    /^https?:\/\/\S+$/i.test(raw) ||
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\/\S*)?$/i.test(raw)
  );
}

/** Checks that every [Source: URL] in the dossier matches a source the workflow actually gathered. */
export function validateCitations(dossier: string, sources: SearchSource[]): CitationValidation {
  // A single bracket sometimes bundles multiple sources as "[Source: a; Source: b]" instead of
  // two separate brackets — split on ";" and strip any repeated "Source:" label per piece.
  const citations = [...dossier.matchAll(/\[Source:\s*([^\]]+)\]/gi)]
    .flatMap((m) => m[1].split(";"))
    .map((piece) => piece.replace(/^\s*Source:\s*/i, "").trim())
    .filter((piece) => piece.length > 0);

  const sourceKeys = new Set(sources.map((s) => looseUrlKey(s.url)));

  let valid = 0;
  const unmatched: string[] = [];
  for (const raw of citations) {
    // URLs never contain whitespace, so the URL is at most the first token even if the model
    // ignored instructions and appended trailing commentary after it inside the brackets.
    const candidate = raw.split(/\s+/)[0];
    if (looksLikeUrl(candidate) && sourceKeys.has(looseUrlKey(candidate))) {
      valid++;
    } else {
      unmatched.push(raw);
    }
  }

  return { total: citations.length, valid, unmatched };
}

const MAX_RESULTS_PER_QUERY_DEFAULT = 6;
const MAX_RESULTS_PER_QUERY_CAP = 10;

export interface WorkflowResult {
  dossier: string;
  queriesRun: number;
  sourcesGathered: number;
  emptyQueries: string[];
  citations: CitationValidation;
}

/** Decomposes a brief, runs web search on every resulting query in parallel, and synthesizes the aggregated findings into a dossier. */
export async function runResearchWorkflow(
  brief: string,
  depth: string,
  format: string,
  maxResultsPerQuery: number = MAX_RESULTS_PER_QUERY_DEFAULT
): Promise<WorkflowResult> {
  const cappedMaxResults = Math.max(1, Math.min(maxResultsPerQuery, MAX_RESULTS_PER_QUERY_CAP));

  const decomposed = await decomposeResearchBrief(brief, depth);
  const queries = parseDecomposedQueries(decomposed);
  if (queries.length === 0) {
    throw new Error("decompose_research_brief returned zero queries");
  }

  const results = await Promise.all(
    queries.map(async (q): Promise<QueryFindings> => {
      try {
        return await webSearch(q.query, cappedMaxResults);
      } catch (err) {
        return {
          query: q.query,
          text: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
          sources: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  const allSources = dedupeSources(results.flatMap((r) => r.sources));
  const emptyQueries = results.filter((r) => r.sources.length === 0).map((r) => r.query);

  const aggregated = results
    .map(
      (r) =>
        `### Query: ${r.query}\n\n${r.text}\n\nSources found: ${
          r.sources.map((s) => s.url).join(", ") || "none"
        }`
    )
    .join("\n\n---\n\n");

  const dossier = await synthesizeResearch(aggregated, brief, format);
  const citations = validateCitations(dossier, allSources);

  return {
    dossier,
    queriesRun: queries.length,
    sourcesGathered: allSources.length,
    emptyQueries,
    citations,
  };
}
