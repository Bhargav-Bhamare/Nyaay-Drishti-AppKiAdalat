'use strict';

/**
 * services/llmSchedulerService.js
 *
 * Calls the Groq API (llama3-8b-8192) with the current case payload and
 * retrieved historical context chunks to produce optimised scheduling metadata.
 *
 * Returns a clean, validated SchedulingResult object.
 * On any failure — parse error, network error, API error — returns null so
 * the controller can gracefully fall back to the rule-based priorityEngine.
 *
 * Environment variables required:
 *   GROQ_API_KEY
 *   GROQ_MODEL   (default: llama3-8b-8192)
 */

require('dotenv').config();
const axios = require('axios');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_MODEL    = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

// Hard ceiling on tokens to keep responses tight and parseable
const MAX_TOKENS    = 512;
const TEMPERATURE   = 0.2;   // Low temperature → deterministic JSON output

// Inter-request delay injected by the batch caller to avoid 429s (ms)
// Exposed so dashboardController can set it without touching this file.
const DEFAULT_REQUEST_DELAY_MS = 0;

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert judicial scheduling assistant for the Indian court system.

Your role is to analyse a case's attributes alongside historical benchmark cases and produce scheduling metadata in strict JSON.

Rules:
1. Respond ONLY with a valid JSON object — no markdown, no explanation, no code fences.
2. The JSON must contain exactly these four keys:
   - "priorityScore"    : integer 1–5 (5 = highest urgency)
   - "estimatedMinutes": integer > 0 (realistic hearing duration)
   - "reasoning"        : string, one or two sentences explaining the score
   - "confidence"       : float 0.0–1.0 (your confidence given available context)
3. Scoring guidance:
   - 5: Habeas corpus, urgent bail, final arguments, judgment-stage, vulnerable parties
   - 4: Criminal arguments, writ petitions, long-pending (>1000 days)
   - 3: Evidence stage, civil/family hearings
   - 2: Admission, summons, charge framing
   - 1: New filings, counselling, mediation
4. estimatedMinutes guidance:
   - Final arguments / judgment: 45–90 min
   - Evidence / cross-examination: 30–60 min
   - Arguments: 20–45 min
   - Admission / summons / hearing: 8–20 min
5. If historical benchmarks are absent, base your answer solely on case attributes
   and set confidence to 0.5 or lower.`;

// ─── PROMPT BUILDER ──────────────────────────────────────────────────────────

/**
 * Constructs the user-turn message from a normalised casePayload and context chunks.
 *
 * @param {import('../utils/inputSchema').CasePayload} casePayload
 * @param {import('./contextService').ContextChunk[]}  contextChunks
 * @returns {string}
 */
function buildUserPrompt(casePayload, contextChunks) {
  const caseBlock = [
    '=== CURRENT CASE ===',
    `Case ID     : ${casePayload.cnrNumber}`,
    `Type        : ${casePayload.caseType}`,
    `Court       : ${casePayload.courtType}`,
    `Stage       : ${casePayload.stage}`,
    `Status      : ${casePayload.status}`,
    `Petitioner  : ${casePayload.petitioner}`,
    `Respondent  : ${casePayload.respondent}`,
    `Acts        : ${casePayload.underActs}`,
    `Sections    : ${casePayload.underSections}`,
    `Age (days)  : ${casePayload.ageInDays}`,
    `Hearings    : ${casePayload.hearingCount}`,
    `Adjournments: ${casePayload.adjournmentCount}`,
    `Criminal?   : ${casePayload.isCriminal ? 'Yes' : 'No'}`,
  ].join('\n');

  let contextBlock;
  if (contextChunks && contextChunks.length > 0) {
    const lines = contextChunks.map(
      (c, i) => `[${i + 1}] (score: ${c.score.toFixed(3)}) ${c.content}`,
    );
    contextBlock = '=== HISTORICAL BENCHMARKS ===\n' + lines.join('\n');
  } else {
    contextBlock = '=== HISTORICAL BENCHMARKS ===\nNone available.';
  }

  return (
    caseBlock + '\n\n' + contextBlock + '\n\n' +
    'Based on the above, output the JSON scheduling metadata now.'
  );
}

// ─── RESPONSE VALIDATOR ──────────────────────────────────────────────────────

/**
 * Validates and coerces the raw parsed object into a SchedulingResult.
 * Returns null if the object is structurally invalid.
 *
 * @param {Object} obj
 * @returns {SchedulingResult|null}
 *
 * @typedef {Object} SchedulingResult
 * @property {number} priorityScore     - 1–5 integer
 * @property {number} estimatedMinutes  - positive integer
 * @property {string} reasoning         - human-readable justification
 * @property {number} confidence        - 0.0–1.0 float
 */
function validateResult(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const priorityScore = Math.round(Number(obj.priorityScore));
  if (isNaN(priorityScore) || priorityScore < 1 || priorityScore > 5) return null;

  const estimatedMinutes = Math.round(Number(obj.estimatedMinutes));
  if (isNaN(estimatedMinutes) || estimatedMinutes < 1) return null;

  const reasoning = typeof obj.reasoning === 'string' && obj.reasoning.trim()
    ? obj.reasoning.trim()
    : 'LLM did not provide reasoning.';

  const confidence = Math.min(1, Math.max(0, parseFloat(obj.confidence) || 0));

  return { priorityScore, estimatedMinutes, reasoning, confidence };
}

// ─── ALGORITHMIC FALLBACK SCORE ──────────────────────────────────────────────

/**
 * Produces a deterministic SchedulingResult from case attributes alone,
 * with no LLM call. Used when Groq is rate-limited (429), offline, or the
 * API key is absent. The confidence is set low (0.4) so the controller's
 * blend logic still prefers the rule-based score where confidence matters.
 *
 * @param {import('../utils/inputSchema').CasePayload} casePayload
 * @returns {SchedulingResult}
 */
function algorithmicFallbackScore(casePayload) {
  // Stage → priority mapping mirrors the LLM system prompt guidance
  const stagePriority = {
    'final arguments': 5,
    judgment:          5,
    arguments:         4,
    'cross examination': 4,
    evidence:          3,
    hearing:           3,
    'charge framing':  2,
    summons:           2,
    admission:         2,
    filing:            1,
    counselling:       1,
    mediation:         1,
  };

  const stageKey = (casePayload.stage || '').toLowerCase();
  let priorityScore = stagePriority[stageKey] ?? 2;

  // Bump up by 1 for criminal / bail / habeas matters (capped at 5)
  if (casePayload.isCriminal) {
    priorityScore = Math.min(5, priorityScore + 1);
  }

  // Extra bump for long-pending cases (>1000 days)
  if (casePayload.ageInDays > 1000) {
    priorityScore = Math.min(5, priorityScore + 1);
  }

  // Estimated minutes — reuse the same lookup table as llmSchedulerService
  const stageMinutes = {
    'final arguments': 60,
    judgment:          45,
    arguments:         40,
    'cross examination': 45,
    evidence:          35,
    hearing:           20,
    'charge framing':  15,
    summons:           10,
    admission:         10,
    filing:            10,
    counselling:       15,
    mediation:         20,
  };
  const estimatedMinutes = stageMinutes[stageKey] ?? 15;

  return {
    priorityScore,
    estimatedMinutes,
    reasoning: 'Algorithmic layout (AI Engine throttled)',
    confidence: 0.40,   // below CONFIDENCE_THRESHOLD — controller uses rule-based score
  };
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * Generate optimised scheduling metadata for a single case.
 *
 * Degradation tiers (highest → lowest quality):
 *   1. Groq LLM with historical context  — full AI result
 *   2. Groq LLM without context          — AI result, lower confidence
 *   3. Algorithmic fallback              — returned on 429 / timeout / key absent
 *      (controller still has the rule-based engine as a second safety net)
 *
 * NEVER throws. Always returns a SchedulingResult or null.
 * null means "skip AI entirely, use rule-based only".
 *
 * @param {import('../utils/inputSchema').CasePayload} casePayload
 * @param {import('./contextService').ContextChunk[]}  contextChunks
 * @returns {Promise<SchedulingResult|null>}
 */
async function generateSchedulingMetadata(casePayload, contextChunks) {
  if (!process.env.GROQ_API_KEY) {
    console.warn('[llmSchedulerService] GROQ_API_KEY not set — skipping LLM call.');
    return null;
  }

  const userPrompt = buildUserPrompt(casePayload, contextChunks);

  try {
    const response = await axios.post(
      `${GROQ_BASE_URL}/chat/completions`,
      {
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userPrompt },
        ],
        max_tokens:      MAX_TOKENS,
        temperature:     TEMPERATURE,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      },
    );

    const rawContent = response.data?.choices?.[0]?.message?.content ?? '';

    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      console.warn('[llmSchedulerService] JSON.parse failed on:', rawContent.slice(0, 200));
      return algorithmicFallbackScore(casePayload);
    }

    const result = validateResult(parsed);
    if (!result) {
      console.warn('[llmSchedulerService] Response failed validation:', parsed);
      return algorithmicFallbackScore(casePayload);
    }

    return result;

  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.message || err.message;

    if (status === 429) {
      // Rate limit — use the algorithmic fallback so the batch keeps running
      console.warn(`[Groq fallback active] HTTP 429 rate limit — using algorithmic score for case ${casePayload.cnrNumber}`);
      return algorithmicFallbackScore(casePayload);
    }

    // Any other error (503, network timeout, etc.) — same fallback
    console.warn(`[Groq fallback active] HTTP ${status ?? 'N/A'} — ${detail} — using algorithmic score for case ${casePayload.cnrNumber}`);
    return algorithmicFallbackScore(casePayload);
  }
}

module.exports = { generateSchedulingMetadata, algorithmicFallbackScore };
