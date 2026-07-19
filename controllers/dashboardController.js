const Lawyer = require("../model/lawyer.js");
const Case = require("../model/case.js");
const { generateDailyCauseList, calculatePriority, estimateCaseTime } = require("../utils/priorityEngine.js");
const { normalizeCaseInput }         = require("../utils/inputSchema.js");
const { retrieveSimilarCases }       = require("../services/contextService.js");
const { generateSchedulingMetadata } = require("../services/llmSchedulerService.js");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

/** LLM confidence floor — below this the rule-based score is used instead */
const CONFIDENCE_THRESHOLD = 0.70;

/**
 * Milliseconds to wait between consecutive Groq calls in a batch.
 * At the free-tier limit of 6000 TPM, each ~300-token request needs a little
 * breathing room when 13 cases are processed. 600 ms keeps the burst rate low
 * without making the endpoint feel sluggish.
 */
const GROQ_REQUEST_DELAY_MS = 600;

// Sample data for demonstration (can be replaced with DB queries)
const sampleCases = [
  {
    caseNumber: "CRL/2024/00123",
    court: "District Court, Pune",
    stage: "Arguments",
    nextHearing: "Dec 28, 2025",
    timeSlot: "10:30 AM",
    status: "Listed",
    priority: "high",
    petitioner: "Ramesh Singh",
    respondent: "State of Maharashtra",
    yourSide: "Petitioner"
  },
  {
    caseNumber: "CIV/2024/00456",
    court: "High Court, Mumbai",
    stage: "Evidence",
    nextHearing: "Jan 3, 2026",
    timeSlot: "2:00 PM",
    status: "Reserved",
    priority: "medium",
    petitioner: "ABC Corporation Ltd",
    respondent: "XYZ Industries",
    yourSide: "Petitioner"
  },
  {
    caseNumber: "CIV/2024/01890",
    court: "District Court, Pune",
    stage: "Admission",
    nextHearing: "Jan 10, 2026",
    timeSlot: "11:00 AM",
    status: "Pending",
    priority: "high",
    petitioner: "Priya Sharma",
    respondent: "Raj Kumar",
    yourSide: "Respondent"
  },
  {
    caseNumber: "FAM/2024/00445",
    court: "Family Court, Pune",
    stage: "Mediation",
    nextHearing: "Jan 15, 2026",
    timeSlot: "3:30 PM",
    status: "Waiting",
    priority: "medium",
    petitioner: "Anjali Patel",
    respondent: "Vikram Patel",
    yourSide: "Respondent"
  },
  {
    caseNumber: "WP/2024/01012",
    court: "High Court, Mumbai",
    stage: "Arguments",
    nextHearing: "Jan 5, 2026",
    timeSlot: "10:00 AM",
    status: "Listed",
    priority: "high",
    petitioner: "Citizens Rights Association",
    respondent: "State Government",
    yourSide: "Petitioner"
  }
];

const sampleNotifications = [
  {
    type: "urgent",
    icon: "🔴",
    title: "Case Listed Tomorrow",
    caseNumber: "CRL/2024/00123",
    message: "Your case is listed for hearing tomorrow at 10:15 AM in Courtroom 3, District Court.",
    timestamp: "2 hours ago"
  },
  {
    type: "warning",
    icon: "⚠️",
    title: "Defect Raised",
    caseNumber: "CIV/2024/01890",
    message: "Registry has identified defects. Please rectify within 7 days.",
    timestamp: "5 hours ago"
  },
  {
    type: "success",
    icon: "✅",
    title: "Order Reserved",
    caseNumber: "WP/2024/01012",
    message: "Judge has reserved the order after final arguments. Expected within 30 days.",
    timestamp: "1 day ago"
  },
  {
    type: "info",
    icon: "📝",
    title: "Case Adjourned",
    caseNumber: "FAM/2024/00445",
    message: "Case adjourned to Jan 10, 2026 due to respondent's absence.",
    timestamp: "2 days ago"
  }
];

const sampleDefects = [
  {
    caseNumber: "CIV/2024/01890",
    deadline: "Jan 5, 2026",
    reason: "Vakalatnama not properly stamped. Please submit corrected document with proper court fee stamp."
  },
  {
    caseNumber: "CRL/2024/02134",
    deadline: "Jan 8, 2026",
    reason: "Affidavit missing notary seal. Respondent address incomplete."
  }
];

// Get lawyer dashboard data
exports.getLawyerDashboardData = async (req, res) => {
  try {
    const lawyerId = req.user._id;
    const lawyer = await Lawyer.findById(lawyerId);

    if (!lawyer) {
      return res.status(404).json({ error: "Lawyer not found" });
    }

    // Return comprehensive dashboard data
    const dashboardData = {
      lawyer: {
        id: lawyer._id,
        name: lawyer.username,
        email: lawyer.email,
        mobile: lawyer.mobile,
        barCouncilNumber: lawyer.BarCouncilRegistrationNumber,
        specializations: lawyer.specializations || [],
        courts: lawyer.courts || [],
        vakalatnamaValidity: lawyer.vakalatnamaValidity
      },
      statistics: {
        todaysHearings: 4,
        upcomingThisWeek: 12,
        awaitingOrders: 8,
        pendingFilings: 2,
        adjournments: 3,
        totalCases: lawyer.totalCases || 0,
        activeCases: lawyer.activeCases || 0,
        disposedCases: lawyer.disposedCases || 0,
        successRate: lawyer.successRate || 0
      },
      cases: sampleCases,
      notifications: sampleNotifications,
      defects: sampleDefects
    };

    res.json(dashboardData);
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    res.status(500).json({ error: "Error fetching dashboard data" });
  }
};

// Get all cases for a lawyer
exports.getLawyerCases = async (req, res) => {
  try {
    const lawyerId = req.user._id;
    const lawyer = await Lawyer.findById(lawyerId);

    if (!lawyer) {
      return res.status(404).json({ error: "Lawyer not found" });
    }

    // Fetch cases from database for this lawyer (use .lean() for plain JSON)
    const cases = await Case.find({ lawyerId: lawyerId }).sort({ nextHearingDate: 1 }).lean();

    // Ensure each case has a string _id and caseNumber fallback
    const safeCases = (cases || []).map((c, i) => ({
      _id: c._id ? String(c._id) : `C${i}`,
      caseNumber: c.caseNumber || `UNDEF-${i}`,
      petitioner: c.petitioner || '',
      respondent: c.respondent || '',
      caseType: c.caseType || '',
      stage: c.stage || '',
      nextHearingDate: c.nextHearingDate || null,
      timeSlot: c.timeSlot || '',
      status: c.status || '' ,
      courtType: c.courtType || '',
      courtFee: c.courtFee || 0
    }));

    res.json({
      cases: safeCases,
      totalCount: safeCases.length
    });
  } catch (error) {
    console.error("Error fetching cases:", error);
    res.status(500).json({ error: "Error fetching cases" });
  }
};

// Get notifications
exports.getNotifications = async (req, res) => {
  try {
    const lawyerId = req.user._id;
    const lawyer = await Lawyer.findById(lawyerId);

    if (!lawyer) {
      return res.status(404).json({ error: "Lawyer not found" });
    }

    res.json({
      notifications: sampleNotifications,
      totalCount: sampleNotifications.length,
      unreadCount: 4
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ error: "Error fetching notifications" });
  }
};

// Get defects
exports.getDefects = async (req, res) => {
  try {
    const lawyerId = req.user._id;
    const lawyer = await Lawyer.findById(lawyerId);

    if (!lawyer) {
      return res.status(404).json({ error: "Lawyer not found" });
    }

    res.json({
      defects: sampleDefects,
      totalCount: sampleDefects.length
    });
  } catch (error) {
    console.error("Error fetching defects:", error);
    res.status(500).json({ error: "Error fetching defects" });
  }
};

// File new case
exports.fileNewCase = async (req, res) => {
  try {
    const { 
      caseType, 
      courtType, 
      petitioner, 
      respondent, 
      stage, 
      nextHearingDate, 
      timeSlot, 
      courtFee,
      affidavitId,
      vakalatnamaNumber
    } = req.body;
    const lawyerId = req.user._id;

    // Validate required fields
    if (!caseType || !courtType || !petitioner || !respondent || !stage || !nextHearingDate || !timeSlot) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Generate case number and diary number
    const caseNumber = `CASE/${Date.now()}/${Math.floor(Math.random() * 10000)}`;
    const diaryNumber = `DIARY/${Date.now()}/${Math.floor(Math.random() * 10000)}`;

    // Create new case in database
    const newCase = new Case({
      lawyerId: lawyerId,
      caseType: caseType,
      courtType: courtType,
      caseNumber: caseNumber,
      petitioner: petitioner,
      respondent: respondent,
      stage: stage,
      nextHearingDate: new Date(nextHearingDate),
      timeSlot: timeSlot,
      courtFee: courtFee || 0,
      status: "Under Scrutiny",
      affidavitId: affidavitId,
      vakalatnamaNumber: vakalatnamaNumber
    });

    const savedCase = await newCase.save();

    // Update lawyer's case statistics
    const lawyer = await Lawyer.findById(lawyerId);
    if (lawyer) {
      lawyer.totalCases = (lawyer.totalCases || 0) + 1;
      lawyer.activeCases = (lawyer.activeCases || 0) + 1;
      await lawyer.save();
    }

    res.json({
      success: true,
      caseId: savedCase._id,
      caseNumber: caseNumber,
      diaryNumber: diaryNumber,
      status: "Under Scrutiny",
      message: "Case filed successfully. Your case number is: " + caseNumber + " and diary number is: " + diaryNumber
    });
  } catch (error) {
    console.error("Error filing case:", error);
    res.status(500).json({ error: "Error filing case: " + error.message });
  }
};

// Update lawyer profile
exports.updateLawyerProfile = async (req, res) => {
  try {
    const lawyerId = req.user._id;
    const { mobile, specializations, courts } = req.body;

    const updatedLawyer = await Lawyer.findByIdAndUpdate(
      lawyerId,
      {
        mobile: mobile,
        specializations: specializations,
        courts: courts
      },
      { new: true }
    );

    res.json({
      success: true,
      message: "Profile updated successfully",
      lawyer: updatedLawyer
    });
  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).json({ error: "Error updating profile" });
  }
};

// ==========================================
// DAILY CAUSE LIST GENERATION
// ==========================================

/**
 * Simple async delay helper.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the full AI evaluation pipeline for one case and return a merged
 * result object that carries both the LLM output and the rule-based baseline.
 *
 * This function NEVER throws — every failure path returns a valid object
 * built from the rule-based engine so the batch always produces 200 OK.
 *
 * @param {Object} caseObj  - lean Mongoose document
 * @returns {Promise<Object>}
 */
async function aiAugmentCase(caseObj) {
  // Rule-based score is always computed first — it's the guaranteed floor.
  let ruleScore, ruleMinutes;
  try {
    ruleScore   = calculatePriority(caseObj);
    ruleMinutes = estimateCaseTime(caseObj);
  } catch (ruleErr) {
    console.error('[dashboardController] calculatePriority threw for case', caseObj._id, ':', ruleErr.message);
    // Absolute last-resort defaults
    ruleScore   = { score: 0.3, breakdown: {}, reasoning: [] };
    ruleMinutes = 15;
  }

  let casePayload;
  try {
    casePayload = normalizeCaseInput(caseObj);
  } catch (normErr) {
    console.error('[dashboardController] normalizeCaseInput threw for case', caseObj._id, ':', normErr.message);
    // Return rule-based only — no LLM attempt
    return {
      _id:                   String(caseObj._id),
      usedLLM:               false,
      finalPriorityScore:    Math.round(ruleScore.score * 5) || 1,
      finalEstimatedMinutes: ruleMinutes,
      llm:                   null,
      ruleBased: {
        score:     parseFloat(ruleScore.score.toFixed(4)),
        breakdown: ruleScore.breakdown,
        reasoning: ruleScore.reasoning,
      },
    };
  }

  // Context retrieval — already has its own fallback (returns [])
  const contextChunks = await retrieveSimilarCases(casePayload.rawDescription, 3);

  // LLM call — already has its own fallback (returns algorithmicFallbackScore)
  const llmResult = await generateSchedulingMetadata(casePayload, contextChunks);

  // Blend: LLM wins when confident enough, otherwise rule-based takes over
  const useLLM = llmResult !== null && llmResult.confidence >= CONFIDENCE_THRESHOLD;

  return {
    _id:                   String(caseObj._id),
    usedLLM:               useLLM,
    finalPriorityScore:    useLLM ? llmResult.priorityScore    : Math.round(ruleScore.score * 5) || 1,
    finalEstimatedMinutes: useLLM ? llmResult.estimatedMinutes : ruleMinutes,
    llm:      llmResult ?? null,
    ruleBased: {
      score:     parseFloat(ruleScore.score.toFixed(4)),
      breakdown: ruleScore.breakdown,
      reasoning: ruleScore.reasoning,
    },
  };
}

/**
 * GET /api/dashboard/daily-cause-list
 *     ?availableMinutes=300   (default 300)
 *     &aiEnhanced=true        (opt-in — runs LLM augmentation on every case)
 *
 * Behaviour:
 *   aiEnhanced=false (default) → pure rule-based response, identical to before
 *   aiEnhanced=true            → each item in dailyCauseList gains:
 *       { llm, ruleBased, usedLLM, finalPriorityScore, finalEstimatedMinutes }
 *     The list is re-sorted by finalPriorityScore after AI augmentation so the
 *     AI-derived urgency order is reflected in the judge/court-master dashboard.
 */
exports.getDailyCauseList = async (req, res) => {
  try {
    const availableMinutes = parseInt(req.query.availableMinutes) || 300;
    const aiEnhanced       = req.query.aiEnhanced === "true";

    // ── 1. Fetch pending cases ────────────────────────────────────────────────
    const allCases = await Case.find({
      status: { $nin: ["Judgment", "Disposed", "Withdrawn"] },
    }).lean();

    console.log(`getDailyCauseList: fetched ${(allCases || []).length} cases | aiEnhanced=${aiEnhanced}`);

    const preparedCases = (allCases || []).map((c) => ({
      ...c,
      _id:            String(c._id),
      nextHearingDate: c.nextHearingDate ? new Date(c.nextHearingDate) : null,
      createdAt:       c.createdAt       ? new Date(c.createdAt)       : null,
    }));

    // ── 2. Always run the rule-based engine first ─────────────────────────────
    const ruleBasedResult = generateDailyCauseList(preparedCases, availableMinutes);

    // ── 3. If AI not requested, return the rule-based result unchanged ────────
    if (!aiEnhanced) {
      return res.json({
        success: true,
        date:    new Date().toLocaleDateString(),
        aiEnhanced: false,
        data:    ruleBasedResult,
      });
    }

    // ── 4. AI augmentation path ───────────────────────────────────────────────
    // Run LLM evaluation concurrently across all cases in the cause list
    const causeListCases = ruleBasedResult.dailyCauseList;

    if (causeListCases.length === 0) {
      return res.json({
        success:    true,
        date:       new Date().toLocaleDateString(),
        aiEnhanced: true,
        data:       ruleBasedResult,
      });
    }

    // Map cause-list _ids back to full case objects for the LLM service
    const caseById = Object.fromEntries(preparedCases.map((c) => [c._id, c]));

    // ── Sequential processing with inter-request delay ────────────────────
    // Running all LLM calls concurrently saturates Groq's 6000 TPM free-tier
    // limit and triggers 429s for every case after the first two. Sequential
    // processing with GROQ_REQUEST_DELAY_MS between calls keeps the token
    // rate well within limits. The algorithmic fallback in llmSchedulerService
    // ensures every case still gets a score even if a 429 slips through.
    const augmentations = [];
    for (const [i, item] of causeListCases.entries()) {
      const augmentedData = await aiAugmentCase(caseById[item._id] || item);
      augmentations.push(augmentedData);
      // Throttle: skip delay after the last item
      if (i < causeListCases.length - 1) {
        await sleep(GROQ_REQUEST_DELAY_MS);
      }
    }

    // ── 5. Merge AI results back into each cause list item ────────────────────
    const augmentedList = causeListCases.map((item, i) => {
      const augmentedData = augmentations[i];
      return augmentedData ? {
        ...item,
        ...augmentedData,
        usedLLM:               augmentedData.usedLLM,
        finalPriorityScore:    augmentedData.finalPriorityScore,
        finalEstimatedMinutes: augmentedData.finalEstimatedMinutes,
        llm:                   augmentedData.llm,
        ruleBased:             augmentedData.ruleBased,
        estimatedTime:         augmentedData.finalEstimatedMinutes,
      } : item;
    });

    // ── 6. Re-sort by AI-derived priority, tiebreak by ageInDays ─────────────
    augmentedList.sort((a, b) => {
      const scoreDiff = (b.finalPriorityScore ?? 0) - (a.finalPriorityScore ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      // Tiebreaker: longer-pending case goes first (use rule-based age factor)
      const aAge = a.ruleBased?.breakdown?.age?.factor ?? 0;
      const bAge = b.ruleBased?.breakdown?.age?.factor ?? 0;
      return bAge - aAge;
    });

    // ── 7. Recompute time slots after re-sort ─────────────────────────────────
    let cursor = 0;
    const finalList = augmentedList.map((item, i) => {
      const start = cursor;
      cursor += item.estimatedTime || 15;
      return {
        ...item,
        serialNumber: i + 1,
        startTime: generateTimeSlotLocal(start),
        endTime:   generateTimeSlotLocal(cursor),
      };
    });

    // ── 8. Rebuild summary with AI-aware figures ──────────────────────────────
    const aiSummary = {
      ...ruleBasedResult.summary,
      totalMinutesUsed:     cursor,
      casesScheduled:       finalList.length,
      aiEnhancedCount:      finalList.filter((c) => c.usedLLM).length,
      ruleBasedFallbacks:   finalList.filter((c) => c.usedLLM === false).length,
      utilizationPercentage: Math.round(
        (cursor / (availableMinutes - availableMinutes * 0.15)) * 100,
      ),
    };

    return res.json({
      success:    true,
      date:       new Date().toLocaleDateString(),
      aiEnhanced: true,
      data: {
        dailyCauseList: finalList,
        summary:        aiSummary,
      },
    });
  } catch (error) {
    console.error("Error generating daily cause list:", error);
    res.status(500).json({ error: "Error generating daily cause list: " + error.message });
  }
};

/** Mirror of the helper in priorityEngine — kept local to avoid circular deps */
function generateTimeSlotLocal(minutesFromStart) {
  const total = 10 * 60 + 30 + minutesFromStart;
  const h = Math.floor(total / 60);
  const m = total % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const display = h > 12 ? h - 12 : h;
  return `${display}:${String(m).padStart(2, "0")} ${ampm}`;
}

/**
 * GET /api/dashboard/case-priority/:caseId
 * Returns detailed priority breakdown for a single case (modal / detail view).
 * Now includes AI scheduling metadata alongside the rule-based breakdown.
 */
exports.getCasePriorityDetails = async (req, res) => {
  try {
    const caseObj = await Case.findById(req.params.caseId).lean();
    if (!caseObj) {
      return res.status(404).json({ error: "Case not found" });
    }

    const ruleScore   = calculatePriority(caseObj);
    const ruleMinutes = estimateCaseTime(caseObj);

    // Run AI augmentation for the single case
    const aug = await aiAugmentCase(caseObj);

    return res.json({
      success:      true,
      caseNumber:   caseObj.caseNumber,
      // Rule-based (always present)
      priorityScore:  ruleScore.score,
      estimatedTime:  ruleMinutes,
      breakdown:      ruleScore.breakdown,
      reasoning:      ruleScore.reasoning,
      // AI layer (null when LLM unavailable)
      ai: aug ? {
        usedLLM:               aug.usedLLM,
        finalPriorityScore:    aug.finalPriorityScore,
        finalEstimatedMinutes: aug.finalEstimatedMinutes,
        llm:                   aug.llm,
      } : null,
    });
  } catch (error) {
    console.error("Error fetching case priority:", error);
    res.status(500).json({ error: "Error fetching case priority" });
  }
};
