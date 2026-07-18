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

// ─── CLIENT ──────────────────────────────────────────────────────────────────

const client = new AlchemystAI({
  apiKey: process.env.ALCHEMYST_AI_API_KEY,
  // SDK does 2 automatic retries for 408/409/429/5xx — no custom retry logic needed
});

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
    const response = await client.v1.context.search({
      query: caseDescription,
      similarity_threshold: SIMILARITY_MAX,
      minimum_similarity_threshold: SIMILARITY_MIN,
      scope: 'internal',
    });

    const raw = response?.contexts ?? [];

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
    const status  = err.status ?? err.response?.status ?? 'N/A';
    const detail  = err.message ?? String(err);
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
  // TODO: replace with mem0ai client call
  // e.g. await mem0Client.add(actorId, sessionSummary);
  return;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  retrieveSimilarCases,
  storeJudgeProfile,
};
