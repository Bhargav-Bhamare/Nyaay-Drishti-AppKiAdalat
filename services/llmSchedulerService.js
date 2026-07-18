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

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * Generate optimised scheduling metadata for a single case.
 *
 * @param {import('../utils/inputSchema').CasePayload} casePayload
 * @param {import('./contextService').ContextChunk[]}  contextChunks
 * @returns {Promise<SchedulingResult|null>}  null signals "fall back to rule-based"
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
        max_tokens:  MAX_TOKENS,
        temperature: TEMPERATURE,
        // Ask Groq for JSON — reduces hallucinated formatting
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
      return null;
    }

    const result = validateResult(parsed);
    if (!result) {
      console.warn('[llmSchedulerService] Response failed validation:', parsed);
      return null;
    }

    return result;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.message || err.message;
    console.error(`[llmSchedulerService] Groq API error (HTTP ${status ?? 'N/A'}): ${detail}`);
    return null;
  }
}

module.exports = { generateSchedulingMetadata };
