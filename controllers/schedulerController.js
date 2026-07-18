'use strict';

/**
 * controllers/schedulerController.js
 *
 * Pure orchestration controller — no direct API calls, no business logic.
 * All external I/O passes through injected service functions so Keploy can
 * capture and replay request/response pairs in a sandboxed test environment.
 *
 * Endpoints:
 *   POST /api/scheduler/evaluate          – single case
 *   POST /api/scheduler/evaluate-batch    – daily cause list (array of cases)
 */

const { normalizeCaseInput }          = require('../utils/inputSchema');
const { retrieveSimilarCases }        = require('../services/contextService');
const { generateSchedulingMetadata }  = require('../services/llmSchedulerService');
const { calculatePriority, estimateCaseTime } = require('../utils/priorityEngine');
const Case                            = require('../model/case');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

/** LLM confidence threshold — below this we prefer the rule-based score */
const CONFIDENCE_THRESHOLD = 0.70;

/** Max concurrent LLM calls in batch mode */
const BATCH_CONCURRENCY = 5;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Run the full AI evaluation pipeline for one case object.
 * Returns a self-contained result object — no side effects.
 *
 * @param {Object} rawCase  - Mongoose document or plain request body object
 * @returns {Promise<Object>}
 */
async function evaluateSingleCase(rawCase) {
  // 1. Normalise input
  const casePayload = normalizeCaseInput(rawCase);

  // 2. Rule-based score (always computed as baseline)
  const ruleBased = calculatePriority(rawCase);
  const ruleBasedMinutes = estimateCaseTime(rawCase);

  // 3. Semantic context retrieval
  const contextChunks = await retrieveSimilarCases(casePayload.rawDescription, 3);

  // 4. LLM inference
  const llmResult = await generateSchedulingMetadata(casePayload, contextChunks);

  // 5. Blend: LLM wins when confident, else rule-based score is used
  const useLLM = llmResult !== null && llmResult.confidence >= CONFIDENCE_THRESHOLD;

  const finalPriorityScore    = useLLM ? llmResult.priorityScore    : Math.round(ruleBased.score * 5);
  const finalEstimatedMinutes = useLLM ? llmResult.estimatedMinutes : ruleBasedMinutes;

  return {
    cnrNumber: casePayload.cnrNumber,
    caseType:  casePayload.caseType,
    stage:     casePayload.stage,
    llm: llmResult
      ? {
          priorityScore:    llmResult.priorityScore,
          estimatedMinutes: llmResult.estimatedMinutes,
          reasoning:        llmResult.reasoning,
          confidence:       llmResult.confidence,
        }
      : null,
    ruleBased: {
      score:     parseFloat(ruleBased.score.toFixed(4)),
      breakdown: ruleBased.breakdown,
      reasoning: ruleBased.reasoning,
    },
    contextUsed:            contextChunks.length,
    usedLLM:                useLLM,
    finalPriorityScore,
    finalEstimatedMinutes,
  };
}

/**
 * Bounded concurrency map — same pool approach as the ingestion script.
 */
async function pooledMap(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function runSlot() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runSlot),
  );
  return results;
}

// ─── ROUTE HANDLERS ──────────────────────────────────────────────────────────

/**
 * POST /api/scheduler/evaluate
 *
 * Evaluate a single case supplied in the request body.
 * Body: any superset of the fields in utils/inputSchema.js
 */
exports.evaluateCase = async (req, res) => {
  try {
    const rawInput = req.body;

    if (!rawInput || typeof rawInput !== 'object') {
      return res.status(400).json({ success: false, error: 'Request body must be a JSON object.' });
    }

    const result = await evaluateSingleCase(rawInput);

    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('[schedulerController] evaluateCase error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/scheduler/evaluate-batch
 *
 * Evaluate an array of cases and return a sorted cause list.
 * Body: { cases: [...] }   OR   { } to pull all pending cases from DB
 */
exports.evaluateBatch = async (req, res) => {
  try {
    let rawCases = req.body?.cases;

    // If no cases were supplied, fetch all pending cases from MongoDB
    if (!Array.isArray(rawCases) || rawCases.length === 0) {
      rawCases = await Case.find({
        status: { $nin: ['Judgment', 'Disposed', 'Withdrawn'] },
      }).lean();
    }

    if (rawCases.length === 0) {
      return res.status(200).json({
        success: true,
        totalEvaluated: 0,
        causeList: [],
      });
    }

    // Evaluate all cases with bounded concurrency
    const results = await pooledMap(rawCases, BATCH_CONCURRENCY, evaluateSingleCase);

    // Sort by finalPriorityScore descending, then ageInDays descending as tiebreaker
    const sorted = results
      .filter(Boolean)
      .sort((a, b) => {
        if (b.finalPriorityScore !== a.finalPriorityScore) {
          return b.finalPriorityScore - a.finalPriorityScore;
        }
        // Tiebreaker: prefer longer-pending cases
        const aAge = normalizeCaseInput(rawCases.find(
          (c) => (c.caseNumber || c.CNR_NUMBER) === a.cnrNumber) || {}).ageInDays;
        const bAge = normalizeCaseInput(rawCases.find(
          (c) => (c.caseNumber || c.CNR_NUMBER) === b.cnrNumber) || {}).ageInDays;
        return bAge - aAge;
      });

    // Assign time slots (court starts 10:30 AM)
    let minutesCursor = 0;
    const causeList = sorted.map((item, i) => ({
      serialNumber: i + 1,
      ...item,
      scheduledStart: generateTimeSlot(minutesCursor),
      scheduledEnd:   generateTimeSlot(minutesCursor + item.finalEstimatedMinutes),
    }));

    return res.status(200).json({
      success: true,
      totalEvaluated:    causeList.length,
      generatedAt:       new Date().toISOString(),
      causeList,
    });
  } catch (err) {
    console.error('[schedulerController] evaluateBatch error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Generate a human-readable time slot string.
 * Mirrors the logic already in priorityEngine.js so outputs are consistent.
 *
 * @param {number} minutesFromStart
 * @returns {string}  e.g. "10:30 AM"
 */
function generateTimeSlot(minutesFromStart) {
  const START_H = 10, START_M = 30;
  const total = START_H * 60 + START_M + minutesFromStart;
  const h = Math.floor(total / 60);
  const m = total % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const display = h > 12 ? h - 12 : h;
  return `${display}:${String(m).padStart(2, '0')} ${ampm}`;
}
