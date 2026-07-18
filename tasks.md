# Nyaay Drishti — Hybrid LLM Scheduler: Implementation Blueprint

## Executive Summary

We are augmenting the existing rule-based `priorityEngine.js` with a **Hybrid AI layer** that uses:

1. **Alchemyst AI** as a semantic context registry (vector memory of historical case data)
2. **Groq (llama3-8b-8192)** as the reasoning engine that produces optimized scheduling metadata

The design is intentionally **modular and adapter-based** to allow zero-friction future integration of Mem0 (persistent memory), Keploy (automated test capture), and Gnani.ai (voice/audio input).

---

## Architectural Overview

```
CSV Historical Data
        │
        ▼
[ scripts/ingestCaseHistory.js ]       ← One-time / cron seeding script
        │  POST /context/add
        ▼
[ Alchemyst AI Context Registry ]      ← Semantic vector store
        │  POST /context/search
        ▼
[ services/contextService.js ]         ← ABSTRACTION LAYER (swap Alchemyst → Mem0 here)
        │  retrieved context chunks
        ▼
[ services/llmSchedulerService.js ]    ← Groq API call (llama3-8b-8192)
        │  { priorityScore, estimatedDuration, reasoning }
        ▼
[ controllers/schedulerController.js ] ← Clean, deterministic controller
        │
        ▼
[ routes/schedulerRoutes.js ]          ← POST /api/scheduler/evaluate
        │
        ▼
[ Existing priorityEngine.js ]         ← Rule-based score still computed in parallel;
                                           LLM score used as intelligent override/blend
```

### Key Abstraction Boundaries

| Layer | File | Swap Target |
|---|---|---|
| Context/Memory | `services/contextService.js` | Alchemyst → **Mem0** |
| LLM Inference | `services/llmSchedulerService.js` | Groq → any OpenAI-compatible API |
| Input Parsing | `utils/inputSchema.js` | JSON body → **Gnani.ai** voice transcript |
| Controller Logic | `controllers/schedulerController.js` | Deterministic — safe for **Keploy** capture |

---

## Dependency Plan

New packages to install (exact versions):

```bash
npm install axios@1.7.9 csv-parse@5.5.6 dotenv@16.4.7
```

- `axios` — HTTP client for Alchemyst and Groq API calls
- `csv-parse` — streaming CSV parser for the ingestion script
- `dotenv` — environment variable management (API keys never hardcoded)

---

## Environment Variables

Add to a new `.env` file (already in `.gitignore`):

```
ALCHEMYST_API_KEY=
ALCHEMYST_BASE_URL=https://platform.alchemystai.dev/api/v1
ALCHEMYST_NAMESPACE=nyaay-drishti-cases

GROQ_API_KEY=
GROQ_BASE_URL=https://api.groq.com/openai/v1
GROQ_MODEL=llama3-8b-8192
```

---

## Task List

---

### TASK 1 — CSV Ingestion Utility

**Goal:** Read the historical case dataset from a local CSV file and push each row as a semantic text block into Alchemyst's `/context/add` endpoint.

**Files to create:**
- `data/historicalCases.csv` — seed dataset (~50 rows, columns: caseType, stage, petitioner, respondent, priorityScore, estimatedMinutes, outcome)
- `scripts/ingestCaseHistory.js` — Node.js CLI script (not part of the Express app)

**Logic inside `ingestCaseHistory.js`:**
1. Read `historicalCases.csv` using `csv-parse` (streaming, not full-load into memory)
2. For each row, construct a **semantic text block**:
   ```
   "A [caseType] case at [stage] stage involving [petitioner] vs [respondent].
    Historical priority score: [priorityScore]/5.
    Estimated hearing duration: [estimatedMinutes] minutes.
    Outcome: [outcome]."
   ```
3. POST each block to Alchemyst `/context/add` with:
   - `namespace`: `nyaay-drishti-cases`
   - `content`: the text block above
   - `metadata`: `{ caseType, stage, priorityScore, estimatedMinutes }`
4. Batch requests with a configurable concurrency limit (default: 5) using `Promise.allSettled` to avoid rate limiting
5. Log progress: `[✓] Ingested row 1/50 — DC/CIV/2024/001`
6. On completion, print a summary: total ingested, total failed, total skipped

**Extensibility note:** The text-block construction function (`buildContextText`) is exported separately so it can be reused by the Gnani.ai voice input parser later.

---

### TASK 2 — Context Service (Abstraction Layer)

**Goal:** Create a clean, swappable service that handles all semantic memory retrieval. This is the single file that changes when we move from Alchemyst to Mem0.

**File to create:** `services/contextService.js`

**Exports:**
```js
// Retrieve N most semantically similar historical cases
retrieveSimilarCases(caseDescription, topK = 3) → Promise<Array<ContextChunk>>

// (Future Mem0 hook — no-op for now, same signature)
storeJudgeProfile(judgeId, sessionSummary) → Promise<void>
```

**Implementation:**
- `retrieveSimilarCases`: POST to Alchemyst `/context/search` with `{ query: caseDescription, namespace, topK }`
- Response is normalized to a standard `ContextChunk` shape: `{ content, score, metadata }`
- All Alchemyst-specific headers and auth are confined here — no other file touches the Alchemyst API key or URL directly
- Includes retry logic (max 2 retries with 500ms backoff) to handle transient API failures

**Extensibility note:** When dropping in Mem0, only this file changes. The `storeJudgeProfile` stub is already in the signature so the Mem0 session-memory feature can be wired in without touching any controller.

---

### TASK 3 — LLM Scheduler Service

**Goal:** Take a current case object + retrieved historical context and call Groq to produce scheduling metadata as clean, validated JSON.

**File to create:** `services/llmSchedulerService.js`

**Exports:**
```js
generateSchedulingMetadata(casePayload, contextChunks) → Promise<SchedulingResult>
```

**Where `SchedulingResult` is:**
```js
{
  priorityScore: Number,      // 1–5, integer
  estimatedMinutes: Number,   // e.g. 30
  reasoning: String,          // human-readable justification
  confidence: Number          // 0.0–1.0, derived from Groq's logprobs if available
}
```

**Prompt Engineering Strategy:**
- **System prompt**: Establishes the model as a judicial scheduling assistant with knowledge of Indian court procedure. Instructs it to respond ONLY with valid JSON.
- **User prompt structure**:
  ```
  CURRENT CASE:
  [Serialized casePayload fields]

  HISTORICAL BENCHMARKS (retrieved via semantic search):
  [Formatted contextChunks, one per line]

  TASK: Based on the historical benchmarks and case attributes, output a JSON object with keys: priorityScore (1-5), estimatedMinutes, reasoning, confidence.
  ```
- **Output parsing**: Response is parsed via `JSON.parse`. If parsing fails, falls back to the rule-based `priorityEngine.js` result and logs a warning. No unhandled exceptions surface to the controller.

**Extensibility note:** `casePayload` is typed via a plain JS schema (`utils/inputSchema.js`) that maps raw request fields to the LLM prompt fields. This schema is the single touch-point for Gnani.ai voice transcript normalization.

---

### TASK 4 — Input Schema Utility

**Goal:** A thin normalization layer that maps raw incoming request data (JSON body or, later, voice transcript) to the canonical `casePayload` shape expected by the LLM service.

**File to create:** `utils/inputSchema.js`

**Exports:**
```js
normalizeCaseInput(rawInput) → casePayload
```

**Fields in `casePayload`:**
```js
{
  caseType, courtType, stage, petitioner,
  respondent, ageInDays, status, adjournmentCount
}
```

This is the only file that changes when adding Gnani.ai voice transcript parsing. The LLM service and controller remain completely untouched.

---

### TASK 5 — Scheduler Controller

**Goal:** A clean, deterministic controller that orchestrates the above services. No direct API calls, no business logic — only orchestration. This makes it fully capturable by Keploy.

**File to create:** `controllers/schedulerController.js`

**Endpoints to handle:**

#### `POST /api/scheduler/evaluate` — Evaluate a single case
1. Validate request body against `inputSchema.js`
2. Build a `caseDescription` string for semantic search
3. Call `contextService.retrieveSimilarCases(caseDescription)`
4. Call `llmSchedulerService.generateSchedulingMetadata(casePayload, contextChunks)`
5. Also run the existing `calculatePriority(caseObj)` from `priorityEngine.js` (rule-based score)
6. **Blend logic**: If LLM confidence > 0.7, use LLM score; else use rule-based score; always return both in response
7. Return:
```json
{
  "success": true,
  "llm": { "priorityScore": 4, "estimatedMinutes": 45, "reasoning": "...", "confidence": 0.85 },
  "ruleBased": { "score": 0.76, "breakdown": {...} },
  "finalPriorityScore": 4,
  "finalEstimatedMinutes": 45
}
```

#### `POST /api/scheduler/evaluate-batch` — Evaluate the full daily cause list
1. Accepts array of case objects
2. Runs evaluate logic for each case with controlled concurrency (5 at a time)
3. Returns sorted cause list with LLM-enhanced scheduling metadata

**Keploy note:** All external I/O (DB reads, API calls) passes through injected service functions. The controller itself has no side effects, making request/response capture via Keploy deterministic.

---

### TASK 6 — Routes & App Integration

**Goal:** Wire the new controller into Express and connect `dotenv` to the app entry point.

**File to create:** `routes/schedulerRoutes.js`

**File to modify:** `app.js`
- Add `require('dotenv').config()` at the very top
- Mount `schedulerRoutes` at `/api/scheduler`

**Middleware applied to all scheduler routes:**
- `isAuth` — session authentication check (already exists)
- `express.json()` — already applied globally in `app.js`

---

### TASK 7 — End-to-End Smoke Test

**Goal:** Manually verify the full pipeline before any integration with the frontend.

**Checklist:**
- [ ] Run `node scripts/ingestCaseHistory.js` — confirm all CSV rows ingested successfully into Alchemyst
- [ ] `POST /api/scheduler/evaluate` with a sample case payload — confirm JSON response with `priorityScore` and `estimatedMinutes`
- [ ] `POST /api/scheduler/evaluate-batch` with the 15 cases from `init/caseData.js` — confirm sorted cause list
- [ ] Simulate Groq API failure — confirm graceful fallback to rule-based score
- [ ] Simulate Alchemyst API failure — confirm empty context is handled gracefully (LLM still runs, just without historical context)

---

## File Creation Summary

| # | File | Type |
|---|---|---|
| 1 | `data/historicalCases.csv` | New (seed data) |
| 2 | `scripts/ingestCaseHistory.js` | New (CLI script) |
| 3 | `services/contextService.js` | New |
| 4 | `services/llmSchedulerService.js` | New |
| 5 | `utils/inputSchema.js` | New |
| 6 | `controllers/schedulerController.js` | New |
| 7 | `routes/schedulerRoutes.js` | New |
| 8 | `.env` | New |
| 9 | `app.js` | Modified (dotenv + route mount) |

---

## Partner Integration Readiness Matrix

| Partner | Integration Point | Status |
|---|---|---|
| **Keploy** | `schedulerController.js` — no internal side effects, all I/O via injected services | Ready for capture |
| **Mem0** | `services/contextService.js` — swap `retrieveSimilarCases` implementation; `storeJudgeProfile` stub already in API | Stub in place |
| **Gnani.ai** | `utils/inputSchema.js` — single normalization point for raw input (JSON or voice transcript) | Hook identified |

---

## Awaiting Your Approval

The design above is finalized. On your go-ahead, I will begin with **Task 1** — generating the `historicalCases.csv` seed dataset and writing the `ingestCaseHistory.js` script.

Shall I proceed?
