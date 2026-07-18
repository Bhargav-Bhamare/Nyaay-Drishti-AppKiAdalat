'use strict';

/**
 * utils/inputSchema.js
 *
 * SINGLE normalisation point for all incoming case data.
 * Maps raw request bodies (JSON today, Gnani.ai voice transcripts tomorrow)
 * to the canonical `casePayload` shape consumed by llmSchedulerService.js.
 *
 * GNANI.AI HOOK:
 *   When voice-to-text transcripts arrive, add a new normaliser here:
 *     normalizeCaseInput(parseVoiceTranscript(transcript))
 *   Nothing in the controller or LLM service needs to change.
 */

// ─── ALLOWED VALUES ───────────────────────────────────────────────────────────

const VALID_CASE_TYPES = new Set([
  'bail', 'writ', 'criminal', 'civil', 'family',
  'habeas', 'appeal', 'commercial', 'land', 'consumer', 'other',
]);

const VALID_STAGES = new Set([
  'filing', 'admission', 'summons', 'evidence', 'arguments',
  'final arguments', 'judgment', 'hearing', 'motion hearing matters',
  'cross examination', 'charge framing', 'counselling', 'mediation',
  'final hearing', 'order', 'unknown',
]);

const VALID_STATUSES = new Set([
  'pending', 'listed', 'adjourned', 'reserved', 'disposed',
  'under scrutiny', 'waiting', 'unknown',
]);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function coerceString(val, fallback = 'Unknown') {
  if (val === undefined || val === null) return fallback;
  const s = String(val).trim();
  return s === '' || s.toUpperCase() === 'NA' ? fallback : s;
}

function coerceInt(val, fallback = 0) {
  const n = parseInt(val, 10);
  return isNaN(n) || n < 0 ? fallback : n;
}

function coerceEnum(val, validSet, fallback = 'unknown') {
  const s = coerceString(val, fallback).toLowerCase();
  return validSet.has(s) ? s : fallback;
}

/**
 * Calculate age of a case in days from its filing date.
 * Accepts ISO strings, DD-MM-YYYY, or YYYY-MM-DD.
 *
 * @param {string|Date|undefined} filingDate
 * @returns {number}
 */
function calcAgeInDays(filingDate) {
  if (!filingDate) return 0;
  let d;
  const s = String(filingDate).trim();
  // DD-MM-YYYY (Bail dataset format)
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
    const [day, month, year] = s.split('-');
    d = new Date(`${year}-${month}-${day}`);
  } else {
    d = new Date(s);
  }
  if (isNaN(d.getTime())) return 0;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

// ─── MAIN NORMALISER ─────────────────────────────────────────────────────────

/**
 * Normalise any raw input object into the canonical casePayload shape.
 *
 * Accepts:
 *  - Express req.body (JSON API)
 *  - Mongoose Case document (lean or hydrated)
 *  - Future: Gnani.ai parsed voice transcript object (same fields, different source)
 *
 * @param {Object} raw  - Raw input from any source
 * @returns {CasePayload}
 *
 * @typedef {Object} CasePayload
 * @property {string}  cnrNumber         - Unique case identifier
 * @property {string}  caseType          - Normalised case type
 * @property {string}  courtType         - Court name / type
 * @property {string}  stage             - Current hearing stage
 * @property {string}  status            - Current case status
 * @property {string}  petitioner        - Petitioner / complainant name
 * @property {string}  respondent        - Respondent name
 * @property {string}  underSections     - IPC / CrPC sections involved
 * @property {string}  underActs         - Acts cited
 * @property {number}  ageInDays         - Days since filing
 * @property {number}  hearingCount      - Total hearings held
 * @property {number}  adjournmentCount  - Estimated adjournments (PENDING_DAYS proxy)
 * @property {boolean} isCriminal        - True for criminal matters
 * @property {string}  rawDescription    - Human-readable summary for LLM prompt
 */
function normalizeCaseInput(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('normalizeCaseInput: input must be a non-null object');
  }

  // Support both camelCase (Mongoose model) and UPPER_SNAKE (CSV row / voice parse)
  const caseType = coerceEnum(
    raw.caseType || raw.CASE_TYPE || raw.CASETYPE_FULLFORM,
    VALID_CASE_TYPES,
  );

  const stage = coerceEnum(
    raw.stage || raw.CURRENT_STAGE,
    VALID_STAGES,
  );

  const status = coerceEnum(
    raw.status || raw.CURRENT_STATUS,
    VALID_STATUSES,
  );

  const courtType    = coerceString(raw.courtType || raw.COURT_NAME);
  const petitioner   = coerceString(raw.petitioner);
  const respondent   = coerceString(raw.respondent || raw.RESPONDENT);
  const underSections = coerceString(raw.underSections || raw.UNDER_SECTIONS);
  const underActs    = coerceString(raw.underActs || raw.UNDER_ACTS);
  const cnrNumber    = coerceString(raw.cnrNumber || raw.CNR_NUMBER || raw.caseNumber || raw.CASE_NUMBER);

  const ageInDays = raw.ageInDays
    ? coerceInt(raw.ageInDays)
    : calcAgeInDays(raw.nextHearingDate || raw.DATE_FILED || raw.REGISTRATION_DATE);

  const hearingCount     = coerceInt(raw.hearingCount || raw.HEARING_COUNT);
  const adjournmentCount = coerceInt(raw.adjournmentCount || raw.PENDING_DAYS);

  const isCriminal = ['criminal', 'bail', 'habeas'].includes(caseType) ||
    String(raw.CIVIL_CRIMINAL || '').toUpperCase() === 'CRIMINAL';

  // Build the human-readable summary for semantic search + LLM prompt
  const rawDescription =
    `A ${caseType} case at ${stage} stage. ` +
    `Court: ${courtType}. ` +
    `Petitioner: ${petitioner} vs Respondent: ${respondent}. ` +
    `Status: ${status}. ` +
    `Acts: ${underActs}. Sections: ${underSections}. ` +
    `Case age: ${ageInDays} days. Hearings: ${hearingCount}. ` +
    `Adjournments: ${adjournmentCount}.`;

  return {
    cnrNumber,
    caseType,
    courtType,
    stage,
    status,
    petitioner,
    respondent,
    underSections,
    underActs,
    ageInDays,
    hearingCount,
    adjournmentCount,
    isCriminal,
    rawDescription,
  };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  normalizeCaseInput,
  // Expose helpers for voice-transcript parsers (Gnani.ai)
  coerceString,
  coerceInt,
  coerceEnum,
  calcAgeInDays,
};
