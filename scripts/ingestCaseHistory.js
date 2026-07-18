'use strict';

/**
 * scripts/ingestCaseHistory.js
 *
 * One-time / cron seeding script.
 * Streams raw CSV rows from the production datasets and pushes each row as a
 * semantic text block into the Alchemyst AI context registry via the official
 * @alchemystai/sdk.
 *
 * Usage:
 *   node scripts/ingestCaseHistory.js --file bail      (default)
 *   node scripts/ingestCaseHistory.js --file writ
 *   node scripts/ingestCaseHistory.js --file both
 *
 * Environment variables required (see .env):
 *   ALCHEMYST_AI_API_KEY
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const AlchemystAI = require('@alchemystai/sdk').default;

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const CONCURRENCY = 5;          // max simultaneous /context/add calls
const SOURCE_BAIL  = 'nyaay-drishti.bail-cases';
const SOURCE_WRIT  = 'nyaay-drishti.writ-cases';

const CSV_PATHS = {
  bail: path.resolve(__dirname, '../data/Bail Chhattisgarh.csv'),
  writ: path.resolve(__dirname, '../data/Chhattisgarh_Writ_Case.csv'),
};

// ─── ALCHEMYST CLIENT ────────────────────────────────────────────────────────

const client = new AlchemystAI({
  apiKey: process.env.ALCHEMYST_AI_API_KEY,
});

// ─── SANITISATION HELPERS ────────────────────────────────────────────────────

/**
 * Returns true if the value is absent, the literal string 'NA', or blank.
 */
function isEmpty(val) {
  if (val === undefined || val === null) return true;
  const s = String(val).trim();
  return s === '' || s.toUpperCase() === 'NA';
}

/**
 * Returns the value if meaningful, otherwise the provided fallback.
 */
function sanitize(val, fallback = 'Unknown') {
  return isEmpty(val) ? fallback : String(val).trim();
}

/**
 * Normalise date strings to ISO format.
 * Bail CSV uses DD-MM-YYYY; Writ CSV uses YYYY-MM-DD.
 * Returns null when the date is absent.
 */
function parseDate(raw) {
  if (isEmpty(raw)) return null;
  const s = raw.trim();
  // DD-MM-YYYY
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
    const [d, m, y] = s.split('-');
    return new Date(`${y}-${m}-${d}`).toISOString().split('T')[0];
  }
  // YYYY-MM-DD (or any ISO-parseable string)
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

/**
 * Calculate pending days from DATE_FILED to today when PENDING_DAYS is absent.
 */
function resolvePendingDays(row) {
  const raw = sanitize(row.PENDING_DAYS, '');
  if (raw !== '' && !isNaN(Number(raw))) return Number(raw);
  const filed = parseDate(row.DATE_FILED);
  if (!filed) return 0;
  return Math.floor((Date.now() - new Date(filed).getTime()) / 86_400_000);
}

// ─── SEMANTIC TEXT BUILDER ───────────────────────────────────────────────────

/**
 * Converts a sanitised CSV row into a human-readable semantic block.
 * Exported so the Gnani.ai voice-transcript parser can reuse it later.
 *
 * @param {Object} row     - sanitised row object
 * @param {string} dataset - 'bail' | 'writ'
 * @returns {string}
 */
function buildContextText(row, dataset) {
  const caseId       = sanitize(row.CNR_NUMBER);
  const caseType     = sanitize(row.CASETYPE_FULLFORM, sanitize(row.CASE_TYPE));
  const court        = sanitize(row.COURT_NAME);
  const stage        = sanitize(row.CURRENT_STAGE);
  const status       = sanitize(row.CURRENT_STATUS);
  const respondent   = sanitize(row.RESPONDENT);
  const acts         = sanitize(row.UNDER_ACTS);
  const sections     = sanitize(row.UNDER_SECTIONS);
  const pendingDays  = resolvePendingDays(row);
  const filedDate    = parseDate(row.DATE_FILED) || 'Unknown';
  const decisionDate = parseDate(row.DECISION_DATE) || 'Pending';
  const hearingCount = sanitize(row.HEARING_COUNT, '0');
  const disposal     = sanitize(row.NATURE_OF_DISPOSAL);
  const judge        = sanitize(row.NJDG_JUDGE_NAME);
  const category     = dataset === 'writ'
    ? sanitize(row.CASE_CATEGORY)
    : sanitize(row.Mapped_Bail, sanitize(row.SUB_CLASSIFICATION));

  return (
    `Case ID: ${caseId}. ` +
    `Type: ${caseType} (${dataset.toUpperCase()}). ` +
    `Court: ${court}. ` +
    `Filed: ${filedDate}. Decision: ${decisionDate}. ` +
    `Stage: ${stage}. Status: ${status}. ` +
    `Respondent: ${respondent}. ` +
    `Acts: ${acts}. Sections: ${sections}. ` +
    `Hearings held: ${hearingCount}. Pending days: ${pendingDays}. ` +
    `Disposal: ${disposal}. Category: ${category}. ` +
    `Judge: ${judge}.`
  );
}

// ─── ALCHEMYST UPLOADER ──────────────────────────────────────────────────────

/**
 * Pushes one row to Alchemyst /context/add.
 * The SDK handles Bearer auth and up to 2 automatic retries internally.
 *
 * @param {Object} row       - sanitised CSV row
 * @param {string} dataset   - 'bail' | 'writ'
 * @param {string} source    - Alchemyst source identifier
 * @returns {Promise<{ok: boolean, cnr: string, error?: string}>}
 */
async function uploadRow(row, dataset, source) {
  const cnr = sanitize(row.CNR_NUMBER);
  const text = buildContextText(row, dataset);

  try {
    await client.v1.context.add({
      context_type: 'resource',
      scope: 'internal',
      source,
      documents: [{ content: text }],
      metadata: {
        fileName: `${cnr}.txt`,
        fileType: 'text/plain',
        lastModified: new Date().toISOString(),
        // fileSize is byte-length of the UTF-8 encoded content
        fileSize: Buffer.byteLength(text, 'utf8'),
      },
    });
    return { ok: true, cnr };
  } catch (err) {
    return { ok: false, cnr, error: err.message || String(err) };
  }
}

// ─── CONCURRENCY HELPER ───────────────────────────────────────────────────────

/**
 * Runs an async worker over an iterable with a fixed concurrency ceiling.
 * Uses a simple slot-pool approach; no external library required.
 *
 * @param {Array}    items
 * @param {number}   concurrency
 * @param {Function} worker  - (item) => Promise<result>
 * @returns {Promise<Array<result>>}
 */
async function pooledMap(items, concurrency, worker) {
  const results = [];
  let idx = 0;

  async function runWorker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i]);
    }
  }

  const pool = Array.from({ length: Math.min(concurrency, items.length) }, runWorker);
  await Promise.all(pool);
  return results;
}

// ─── STREAM PROCESSOR ────────────────────────────────────────────────────────

/**
 * Streams a CSV file and collects valid rows into memory in batches,
 * then flushes each batch to Alchemyst with controlled concurrency.
 *
 * We batch (CONCURRENCY × 20) rows at a time so we never hold the full
 * 33–69 MB file in memory at once.
 *
 * @param {string} filePath
 * @param {string} dataset   - 'bail' | 'writ'
 * @param {string} source
 * @returns {Promise<{ingested, failed, skipped}>}
 */
async function processFile(filePath, dataset, source) {
  const BATCH_SIZE = CONCURRENCY * 20;

  let ingested = 0;
  let failed   = 0;
  let skipped  = 0;
  let total    = 0;

  console.log(`\n📂  Starting: ${path.basename(filePath)}`);
  console.log(`    Source  : ${source}\n`);

  return new Promise((resolve, reject) => {
    const batch = [];

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
      .pipe(csv());

    // Pause the stream while we flush a batch so back-pressure is respected.
    stream.on('data', async (row) => {
      // Skip rows without a valid CNR_NUMBER
      if (isEmpty(row.CNR_NUMBER)) {
        skipped++;
        return;
      }

      total++;
      batch.push(row);

      if (batch.length >= BATCH_SIZE) {
        stream.pause();
        const snap = batch.splice(0, BATCH_SIZE);
        const results = await pooledMap(snap, CONCURRENCY,
          (r) => uploadRow(r, dataset, source));

        for (const res of results) {
          if (res.ok) {
            ingested++;
            process.stdout.write(`  [✓] ${res.cnr} (${ingested})\r`);
          } else {
            failed++;
            console.error(`\n  [✗] ${res.cnr} — ${res.error}`);
          }
        }
        stream.resume();
      }
    });

    stream.on('end', async () => {
      // Flush the remaining partial batch
      if (batch.length > 0) {
        const results = await pooledMap(batch, CONCURRENCY,
          (r) => uploadRow(r, dataset, source));

        for (const res of results) {
          if (res.ok) {
            ingested++;
            process.stdout.write(`  [✓] ${res.cnr} (${ingested})\r`);
          } else {
            failed++;
            console.error(`\n  [✗] ${res.cnr} — ${res.error}`);
          }
        }
      }

      console.log(`\n\n  ────────────────────────────────`);
      console.log(`  Dataset   : ${dataset.toUpperCase()}`);
      console.log(`  Total rows: ${total + skipped}`);
      console.log(`  Skipped   : ${skipped}  (missing CNR_NUMBER)`);
      console.log(`  Ingested  : ${ingested}`);
      console.log(`  Failed    : ${failed}`);
      console.log(`  ────────────────────────────────\n`);

      resolve({ ingested, failed, skipped });
    });

    stream.on('error', (err) => {
      console.error(`\n[STREAM ERROR] ${filePath}: ${err.message}`);
      reject(err);
    });
  });
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ALCHEMYST_AI_API_KEY) {
    console.error('[ERROR] ALCHEMYST_AI_API_KEY is not set in your .env file.');
    process.exit(1);
  }

  const arg = process.argv.find((a) => a.startsWith('--file='))
    || process.argv[process.argv.indexOf('--file') + 1]
    || 'bail';

  const fileFlag = String(arg).replace('--file=', '').toLowerCase();

  const targets = [];
  if (fileFlag === 'bail' || fileFlag === 'both') {
    targets.push({ path: CSV_PATHS.bail, dataset: 'bail', source: SOURCE_BAIL });
  }
  if (fileFlag === 'writ' || fileFlag === 'both') {
    targets.push({ path: CSV_PATHS.writ, dataset: 'writ', source: SOURCE_WRIT });
  }

  if (targets.length === 0) {
    console.error(`[ERROR] Unknown --file value "${fileFlag}". Use bail | writ | both.`);
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Nyaay Drishti — Alchemyst Context Ingestion    ║');
  console.log('╚══════════════════════════════════════════════════╝');

  let totalIngested = 0;
  let totalFailed   = 0;

  for (const target of targets) {
    if (!fs.existsSync(target.path)) {
      console.error(`[SKIP] File not found: ${target.path}`);
      continue;
    }
    const { ingested, failed } = await processFile(
      target.path,
      target.dataset,
      target.source,
    );
    totalIngested += ingested;
    totalFailed   += failed;
  }

  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║  FINAL — Ingested: ${String(totalIngested).padEnd(6)} | Failed: ${String(totalFailed).padEnd(6)}  ║`);
  console.log('╚══════════════════════════════════════════════════╝');

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});

// ─── EXPORTS (for reuse by Gnani.ai voice parser etc.) ───────────────────────
module.exports = { buildContextText, sanitize, parseDate };
