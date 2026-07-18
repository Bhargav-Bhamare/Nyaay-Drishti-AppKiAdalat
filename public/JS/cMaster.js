// Court Master interactive script
// Loads daily cause list, renders rows with time bars, adds action handlers and Expand Session controls

const COURT_START_HOUR = 10;
const COURT_START_MIN = 30;
const DAY_AVAILABLE_MINUTES = 300; // default

async function loadCauseListForCM() {
  try {
    const res = await fetch('/api/dashboard/daily-cause-list?availableMinutes=' + DAY_AVAILABLE_MINUTES + '&aiEnhanced=true');
    if (!res.ok) throw new Error('Failed to fetch daily cause list');
    const json = await res.json();
    const list = json && json.data && json.data.dailyCauseList ? json.data.dailyCauseList : [];
    const summary = json && json.data && json.data.summary ? json.data.summary : {};
    renderCauseList(list);
    updateClosureSummary(list, summary);
  } catch (err) {
    console.error('Error loading cause list for Court Master:', err);
    const tbody = document.getElementById('causeListBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#dc3545;padding:1rem;">Failed to load cause list. Please refresh.</td></tr>';
  }
}

function parseTimeToMinutes(t) {
  // Expect formats like "10:30 AM"
  if (!t) return null;
  const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

function minutesToTimeString(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHour}:${String(minutes).padStart(2, '0')} ${ampm}`;
}

function renderCauseList(list) {
  const tbody = document.getElementById('causeListBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  // We'll build an in-memory schedule state to allow shifting times when extended
  const schedule = [];

  list.forEach((item, idx) => {
    const est = item.estimatedTime || 15;
    const startStr = item.startTime || '';
    const endStr = item.endTime || '';
    const startAbs = parseTimeToMinutes(startStr);
    const startOffset = (startAbs !== null) ? (startAbs - (COURT_START_HOUR * 60 + COURT_START_MIN)) : null;

    schedule.push({
      id: item._id || `C${idx}`,
      serialNumber: item.serialNumber || idx + 1,
      caseNumber: item.caseNumber || '',
      petitioner: item.petitioner || '',
      respondent: item.respondent || '',
      caseType: item.caseType || '',
      stage: item.stage || '',
      startOffset,
      estimatedTime: est,
      startStr,
      endStr,
    });
  });

  // Render rows and store schedule data on each row
  schedule.forEach((s, idx) => {
    const item = list[idx] || {};
    const tr = document.createElement('tr');
    tr.className = 'case-row';
    tr.dataset.caseId = s.id;
    tr.dataset.index = idx;
    tr.dataset.estimatedTime = s.estimatedTime;
    tr.dataset.startOffset = s.startOffset !== null ? s.startOffset : '';

    // ── AI-aware priority label (finalPriorityScore is 1–5 integer) ──────────
    const finalScore = (item.finalPriorityScore != null) ? item.finalPriorityScore : null;
    const ruleScore  = (item.priority && typeof item.priority.score === 'number') ? item.priority.score : null;

    let priorityLevel, priorityLabel;
    if (finalScore != null) {
      // Map 1–5 to high / medium / low
      priorityLevel = finalScore >= 4 ? 'high' : finalScore >= 3 ? 'medium' : 'low';
      priorityLabel  = finalScore >= 4 ? 'High'  : finalScore >= 3 ? 'Medium'  : 'Low';
    } else if (ruleScore != null) {
      priorityLevel = ruleScore >= 0.7 ? 'high' : ruleScore >= 0.5 ? 'medium' : 'low';
      priorityLabel  = ruleScore >= 0.7 ? 'High'  : ruleScore >= 0.5 ? 'Medium'  : 'Low';
    } else {
      priorityLevel = 'low'; priorityLabel = 'Unknown';
    }

    // ── AI badge (shown only when LLM was used) ───────────────────────────────
    const aiBadge = item.usedLLM
      ? `<span title="${escapeHtml(item.llm && item.llm.reasoning ? item.llm.reasoning : '')}" style="margin-left:4px;display:inline-block;background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:4px;padding:1px 5px;font-size:0.72rem;font-weight:600;cursor:help;">AI ✦ ${finalScore}/5</span>`
      : (finalScore != null ? `<span style="margin-left:4px;display:inline-block;background:#f9fafb;color:#6b7280;border:1px solid #e5e7eb;border-radius:4px;padding:1px 5px;font-size:0.72rem;">⚙ ${finalScore}/5</span>` : '');

    const status = item.status ? item.status : 'Pending';

    const timeHtml = `<div class="time-cell"><div class="time-text">${s.startStr || ''} - ${s.endStr || ''}</div><div class="time-bar"><div class="time-fill" style="width:${(s.estimatedTime / DAY_AVAILABLE_MINUTES) * 100}%"></div></div></div>`;

    tr.innerHTML = `
      <td>${s.serialNumber || idx + 1}</td>
      <td><strong>${escapeHtml(s.caseNumber)}</strong></td>
      <td>${escapeHtml(s.caseType)} — ${escapeHtml(s.petitioner)} v/s ${escapeHtml(s.respondent)}</td>
      <td>${escapeHtml(s.stage)}</td>
      <td>${timeHtml}</td>
      <td><span class="priority-badge priority-${priorityLevel}"></span>${priorityLabel}${aiBadge}</td>
      <td><span class="status-badge status-pending">${escapeHtml(status)}</span></td>
      <td>
        <div class="action-buttons">
          <button class="btn btn-call btn-sm" data-action="call">Call</button>
          <button class="btn btn-pass btn-sm" data-action="pass">Pass</button>
          <button class="btn btn-adjourn btn-sm" data-action="adjourn">Adjourn</button>
          <button class="btn btn-heard btn-sm" data-action="heard">Heard</button>
          <div class="expand-wrap">
            <button class="btn btn-secondary btn-sm expand-btn">Extend ⌛</button>
            <div class="expand-menu hidden">
              <button class="expand-option" data-mins="15">+15 min</button>
              <button class="expand-option" data-mins="30">+30 min</button>
              <button class="expand-option" data-mins="60">+60 min</button>
            </div>
          </div>
        </div>
      </td>
    `;

    // attach handlers
    tr.querySelectorAll('.action-buttons .btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = btn.dataset.action;
        handleActionClick(s.id, action, tr);
        e.stopPropagation();
      });
    });

    const expandBtn = tr.querySelector('.expand-btn');
    const expandMenu = tr.querySelector('.expand-menu');
    expandBtn.addEventListener('click', (e) => {
      expandMenu.classList.toggle('hidden');
      expandBtn.classList.add('btn-anim');
      setTimeout(() => expandBtn.classList.remove('btn-anim'), 300);
      e.stopPropagation();
    });

    tr.querySelectorAll('.expand-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        const mins = parseInt(opt.dataset.mins, 10);
        extendCaseTime(s.id, mins);
        expandMenu.classList.add('hidden');
        e.stopPropagation();
      });
    });

    tbody.appendChild(tr);
  });
}

function escapeHtml(text) {
  if (!text && text !== 0) return '';
  return String(text).replace(/[&<>"]+/g, function (s) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s]); });
}

async function handleActionClick(caseId, action, tr) {
  // Optimistically update UI
  const statusBadge = tr.querySelector('.status-badge');
  if (action === 'call') {
    statusBadge.textContent = 'Called';
    statusBadge.className = 'status-badge status-called';
  } else if (action === 'pass') {
    statusBadge.textContent = 'Passed';
    statusBadge.className = 'status-badge status-passed';
  } else if (action === 'adjourn') {
    statusBadge.textContent = 'Adjourned';
    statusBadge.className = 'status-badge status-adjourned';
  } else if (action === 'heard') {
    statusBadge.textContent = 'Heard';
    statusBadge.className = 'status-badge status-heard';
  }

  // Send server update (non-blocking)
  try {
    await fetch(`/api/case-action/${caseId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
  } catch (err) {
    console.warn('Action API failed; state kept client-side', err);
  }
}

function extendCaseTime(caseId, extraMinutes) {
  // Find the row and adjust estimated time and shift subsequent rows
  const tbody = document.getElementById('causeListBody');
  const rows = Array.from(tbody.querySelectorAll('tr.case-row'));
  const index = rows.findIndex(r => r.dataset.caseId === caseId);
  if (index === -1) return;

  // update this row's estimated time
  const row = rows[index];
  let est = parseInt(row.dataset.estimatedTime || '0', 10);
  est += extraMinutes;
  row.dataset.estimatedTime = String(est);

  // animate time-fill width in this row
  const fill = row.querySelector('.time-fill');
  if (fill) {
    const pct = (est / DAY_AVAILABLE_MINUTES) * 100;
    fill.style.transition = 'width 0.6s ease';
    fill.style.width = pct + '%';
    fill.classList.add('bar-anim');
    setTimeout(() => fill.classList.remove('bar-anim'), 700);
  }

  // shift start/end times for subsequent rows by extraMinutes
  for (let i = index; i < rows.length; i++) {
    const r = rows[i];
    // compute start time from displayed text
    const timeTextEl = r.querySelector('.time-text');
    if (!timeTextEl) continue;
    const timeText = timeTextEl.textContent || '';
    // format like "10:30 AM - 11:00 AM"
    const parts = timeText.split('-').map(s => s.trim());
    if (parts.length < 2) continue;
    const start = parts[0];
    const end = parts[1];
    const startAbs = parseTimeToMinutes(start);
    const endAbs = parseTimeToMinutes(end);
    if (startAbs === null || endAbs === null) continue;

    let newStart = startAbs + (i === index ? 0 : extraMinutes);
    let newEnd = endAbs + extraMinutes;

    // For the first row (index), extend its end by extraMinutes
    if (i === index) newEnd = endAbs + extraMinutes;

    // Update display
    const newStartStr = minutesToTimeString(newStart);
    const newEndStr = minutesToTimeString(newEnd);
    timeTextEl.textContent = `${newStartStr} - ${newEndStr}`;

    // Update dataset startOffset for future operations
    const newStartOffset = newStart - (COURT_START_HOUR * 60 + COURT_START_MIN);
    r.dataset.startOffset = String(newStartOffset);

    // For rows after the extended one, also shift their fills or estimated times visually remain same
  }
}

// close expand menus when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.expand-menu').forEach(m => m.classList.add('hidden'));
});

/**
 * Update the Daily Closure Summary panel with live AI-enhanced figures.
 * Falls back gracefully when no data is available.
 */
function updateClosureSummary(list, summary) {
  // Tile counts
  const causeListTile = document.querySelector('.cause-list-tile .tile-count');
  if (causeListTile) causeListTile.textContent = list.length;

  // Closure stats
  const statEls = document.querySelectorAll('.closure-stat-value');
  if (statEls.length >= 4) {
    statEls[0].textContent = summary.casesScheduled != null ? summary.casesScheduled : list.length;
    // "Heard" and "Adjourned" start at 0 — updated client-side as Court Master clicks
    statEls[1].textContent = statEls[1].textContent || '0';
    statEls[2].textContent = statEls[2].textContent || '0';
    statEls[3].textContent = statEls[3].textContent || '0';
  }

  // AI summary banner (inject once below the filters bar)
  if (summary.aiEnhancedCount != null && !document.getElementById('ai-summary-banner')) {
    const banner = document.createElement('div');
    banner.id = 'ai-summary-banner';
    banner.style.cssText = 'background:#eef2ff;border:1px solid #c7d2fe;border-radius:6px;padding:10px 16px;margin-bottom:1rem;font-size:0.88rem;color:#3730a3;display:flex;gap:16px;flex-wrap:wrap;align-items:center;';
    banner.innerHTML = `
      <strong>✦ AI Scheduler Active</strong>
      <span>📊 ${summary.aiEnhancedCount} cases scored by LLM</span>
      <span>⚙ ${summary.ruleBasedFallbacks} used rule-based fallback</span>
      <span>⏱ ${summary.totalMinutesUsed} min scheduled / ${summary.totalMinutesAvailable} available</span>
      <span>📈 ${summary.utilizationPercentage}% utilization</span>
    `;
    const filtersBar = document.querySelector('.filters-bar');
    if (filtersBar) filtersBar.insertAdjacentElement('afterend', banner);
  }
}

// initialize
document.addEventListener('DOMContentLoaded', () => {
  loadCauseListForCM();
  setInterval(loadCauseListForCM, 30000);
});
