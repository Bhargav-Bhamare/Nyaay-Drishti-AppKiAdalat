'use strict';

/**
 * services/contextService.js
 *
 * ABSTRACTION LAYER for all semantic memory / context retrieval.
 * This is the ONLY file that knows about Alchemyst AI.
 *
 * Swap strategy:
 *   - Replace the body of `retrieveSimilarCases` to point at Mem0 when ready.
 *   - `storeJudgeProfile` is already stubbed with the correct signature so
 *     Mem0 session-memory can be wired in without touching any controller.
 *
 * Environment variables required:
 *   ALCHEMYST_AI_API_KEY
 */

require('dotenv').config();
const AlchemystAI = require('@alchemystai/sdk').default;

// ─── CLIENTS ────────────────────────────────────────────────────────────────

let client = null;
try {
  if (process.env.ALCHEMYST_AI_API_KEY) {
    client = new AlchemystAI({
      apiKey: process.env.ALCHEMYST_AI_API_KEY,
      // SDK does 2 automatic retries for 408/409/429/5xx — no custom retry logic needed
    });
  }
} catch (err) {
  console.warn('[contextService] Alchemyst client unavailable, falling back to in-process memory adapter:', err.message);
}

// Lightweight in-process memory store that mimics a Mem0-like retrieval layer.
// It keeps facts per actor and returns them as context chunks when a query is present.
const memoryStore = new Map();

function getActorMemory(actorId) {
  if (!memoryStore.has(actorId)) {
    memoryStore.set(actorId, []);
  }
  return memoryStore.get(actorId);
}

function addFact(actorId, text) {
  if (!actorId || !text) return;
  const bucket = getActorMemory(actorId);
  bucket.push({
    id: `${actorId}:${Date.now()}:${bucket.length}`,
    content: String(text),
    score: 0.92,
    metadata: { source: 'mem0-local' },
  });
}

function searchFacts(query, actorId) {
  const bucket = getActorMemory(actorId || '__global__');
  if (!bucket.length) return [];

  const normalized = String(query || '').toLowerCase();
  return bucket.filter((entry) => {
    const text = String(entry.content || '').toLowerCase();
    return text.includes(normalized) || normalized.includes(text);
  }).slice(0, 5);
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

/**
 * Similarity band for context search.
 * A wide band (0.45 – 0.90) retrieves diverse-but-relevant benchmarks while
 * filtering out noise below 0.45.
 */
const SIMILARITY_MAX = 0.90;
const SIMILARITY_MIN = 0.45;

// ─── TYPES (JSDoc only — no runtime overhead) ────────────────────────────────

/**
 * @typedef {Object} ContextChunk
 * @property {string} content   - The raw semantic text from the registry
 * @property {number} score     - Similarity score (0–1)
 * @property {Object} metadata  - Optional metadata returned by Alchemyst
 */

// ─── PUBLIC API ──────────────────────────────────────────────────────────────

/**
 * Retrieve the top-K most semantically similar historical cases from the
 * Alchemyst AI context registry.
 *
 * Called by: controllers/schedulerController.js
 * Future swap target: Mem0 `searchMemory` — replace internals only.
 *
 * @param {string} caseDescription  - Natural-language description of the case
 *                                    being evaluated (built by inputSchema.js)
 * @param {number} [topK=3]         - Number of results to request
 * @returns {Promise<ContextChunk[]>}
 */
async function retrieveSimilarCases(caseDescription, topK = 3) {
  if (!caseDescription || typeof caseDescription !== 'string') {
    return [];
  }

  try {
    if (client && typeof client?.v1?.context?.search === 'function') {
      const response = await client.v1.context.search({
        query: caseDescription,
        similarity_threshold: SIMILARITY_MAX,
        minimum_similarity_threshold: SIMILARITY_MIN,
        scope: 'internal',
      });

      const responseStatus = response?.status ?? response?.statusCode ?? response?.response?.status ?? null;
      if (responseStatus === 500) {
        console.warn('[contextService fallback active] retrieveSimilarCases received HTTP 500 — returning []');
        return [];
      }

      const raw = response?.contexts ?? [];

      return raw
        .slice(0, topK)
        .map((item) => ({
          content:  item.content  ?? '',
          score:    item.score    ?? 0,
          metadata: item.metadata ?? {},
        }));
    }

    // Mem0-style in-process fallback: allow the app to remember prior facts by user.
    const actorId = process.env.MEM0_ACTOR_ID || '__global__';
    const raw = searchFacts(caseDescription, actorId);
    return raw
      .slice(0, topK)
      .map((item) => ({
        content:  item.content  ?? '',
        score:    item.score    ?? 0,
        metadata: item.metadata ?? {},
      }));
  } catch (err) {
    // Catch all failures — 500 from Alchemyst, network errors, SDK exhausted
    // retries, etc. — and degrade gracefully so the LLM still runs without
    // historical context and the endpoint always returns 200.
    const status  = err?.status ?? err?.response?.status ?? err?.statusCode ?? 'N/A';
    const detail  = err?.message ?? String(err);
    console.warn(`[contextService fallback active] retrieveSimilarCases failed (HTTP ${status}): ${detail}`);
    return [];
  }
}

/**
 * Store a judge or lawyer session summary for long-term profile building.
 *
 * STUB — no-op until Mem0 is integrated.
 * Signature is finalised so controllers never need to change.
 *
 * @param {string} actorId        - judgeId or lawyerId from MongoDB
 * @param {string} sessionSummary - Plain-text summary of the session
 * @returns {Promise<void>}
 */
async function storeJudgeProfile(actorId, sessionSummary) { // eslint-disable-line no-unused-vars
  if (!actorId || !sessionSummary) return;

  try {
    if (process.env.MEM0_API_KEY) {
      // Future integration target: Mem0 cloud or self-hosted API.
      // The current app keeps this no-op-safe so existing controllers need no changes.
      addFact(actorId, sessionSummary);
      return;
    }

    addFact(actorId, sessionSummary);
  } catch (err) {
    console.warn('[contextService] Failed to store actor memory:', err.message);
  }
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  retrieveSimilarCases,
  storeJudgeProfile,
  __internal: {
    addFact,
    searchFacts,
    memoryStore,
  },
};
