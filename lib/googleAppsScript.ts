import { google } from "googleapis";
import { buildHolidayMap } from "./holidays";

function buildAuthClient(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return oauth2Client;
}

// ─────────────────────────────────────────────────────────────────────────
// The actual in-Sheet script. This becomes Code.gs inside a script bound to
// the generated spreadsheet. It reads the Estimation & Resource Allocation
// tab — rows grouped into deliverables, each with its own list of tasks —
// and builds the Project Tracking & Execution tab as a Deliverable × Task
// matrix: one row per deliverable, RAG status + current stage, a
// repeating 7-column block per task (Assigned To, Hours, Baseline Date,
// Plan Date, Actual Date, Status, Dependency), and a trailing Quality %
// column. Deliverable 1's task list is the template every other
// deliverable's columns are matched against. Existing Plan/Actual/
// Assigned/Hours/Status/Quality % are preserved across regenerations,
// matched by (deliverable name, task name) or (deliverable name);
// Dependency is always re-copied fresh from the Estimation tab, the same
// treatment as Baseline Date. See SHEETS_TRACKER.md.
//
// It also installs an onEdit trigger that:
//  - runs the "Copy Tasks from Deliverable 1" checkbox in column H,
//  - auto-stamps a task's Actual Date the moment its Status is set to a
//    "Completed…" value,
//  - live-recomputes a deliverable row's RAG + Current Stage the moment any
//    of its Baseline/Plan/Actual/Status cells change, without waiting for
//    the next full regenerate.
//  - warns (with an override option) when someone types a Plan Date that
//    falls on a weekend or a public holiday in one of the countries chosen
//    on the Upload form.
//
// HOLIDAYS is computed server-side (lib/holidays.ts, via the date-holidays
// npm package — Apps Script's sandbox has no npm access) at the moment this
// script is attached, and baked into the source as a plain JS object
// literal below. It's a one-time snapshot covering a multi-year window, not
// a live lookup — see attachTrackerScript's doc comment for why.
// ─────────────────────────────────────────────────────────────────────────
function buildCodeGs(holidaysJson: string): string {
  return `
var EST_SHEET_NAME = 'Estimation & Resource Allocation';
var TRACK_SHEET_NAME = 'Project Tracking & Execution';
var LISTS_SHEET_NAME = 'Lists';
var FINANCIAL_HISTORY_SHEET_NAME = 'Financial History';
var EST_FIRST_ROW = 5;
var EST_COPY_COL = 8; // column H
var EST_DEPENDENCY_COL = 9; // column I
var TRACK_LEADING_COLS = 10; // A Deliverable, B-H spare (7), I RAG, J Current Stage
var TRACK_COLS_PER_TASK = 7; // Assigned To, Hours, Baseline, Plan, Actual, Status, Dependency
var DEPENDENCY_VALUES = ['Non-dependent', 'Dependent'];

// date ('YYYY-MM-DD') -> [{country, name}] — every holiday, across every
// country chosen at generation time, that falls on that date.
var HOLIDAYS = ${holidaysJson};

// ─────────────────────── Business-day helpers ───────────────────────

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function dateKey(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function isWeekend(d) {
  var day = d.getDay();
  return day === 0 || day === 6;
}

function holidaysOn(d) {
  return HOLIDAYS[dateKey(d)] || null;
}

function isBusinessDay(d) {
  return !isWeekend(d) && !holidaysOn(d);
}

// Rolls forward (never backward) to the next date that isn't a weekend or
// a holiday — returns \`d\` itself if it already qualifies.
function nextBusinessDay(d) {
  var next = new Date(d.getTime());
  while (!isBusinessDay(next)) next = addDays(next, 1);
  return next;
}

// The date that is the \`count\`-th business day starting from (and
// including, if it already qualifies) \`start\`.
function addBusinessDays(start, count) {
  var d = nextBusinessDay(start);
  var found = 1;
  while (found < count) {
    d = addDays(d, 1);
    if (isBusinessDay(d)) found++;
  }
  return d;
}

// Human-readable reason a date isn't a business day, or null if it is one.
function nonBusinessDayReason(d) {
  var holidays = holidaysOn(d);
  if (holidays) {
    var parts = holidays.map(function (h) { return h.country + ': ' + h.name; });
    return 'a public holiday (' + parts.join('; ') + ')';
  }
  if (isWeekend(d)) return 'a weekend';
  return null;
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Project Tracker Tools')
    .addItem('Generate Project Tracker', 'generateProjectTracker')
    .addToUi();
}

// ─────────────────────── Estimation tab parsing ───────────────────────

function readDeliverables(est) {
  var lastRow = est.getLastRow();
  if (lastRow < EST_FIRST_ROW) return [];
  var raw = est.getRange(EST_FIRST_ROW, 1, lastRow - EST_FIRST_ROW + 1, 9).getValues();

  var deliverables = [];
  var current = null;
  for (var i = 0; i < raw.length; i++) {
    var delivName = String(raw[i][0] || '').trim();
    var taskName = String(raw[i][1] || '').trim();
    var days = Number(raw[i][2]) || 0;
    var effort = Number(raw[i][3]) || 0;
    var team = String(raw[i][4] || '').trim();
    var dependency = String(raw[i][8] || '').trim() || DEPENDENCY_VALUES[0];

    if (delivName) {
      current = { name: delivName, tasks: [], startRow: EST_FIRST_ROW + i };
      deliverables.push(current);
    }
    if (taskName && current) {
      current.tasks.push({ name: taskName, days: days, effort: effort, team: team, dependency: dependency });
    }
  }
  return deliverables;
}

function buildTaskSlots(deliverables) {
  if (deliverables.length === 0) return [];
  var canonical = deliverables[0].tasks;
  var maxSlots = canonical.length;
  deliverables.forEach(function (d) {
    if (d.tasks.length > maxSlots) maxSlots = d.tasks.length;
  });

  var slots = [];
  for (var i = 0; i < maxSlots; i++) {
    var label = canonical[i] ? canonical[i].name : '';
    if (!label) {
      for (var j = 0; j < deliverables.length; j++) {
        if (deliverables[j].tasks[i]) { label = deliverables[j].tasks[i].name; break; }
      }
    }
    slots.push(label || ('Task ' + (i + 1)));
  }
  return slots;
}

// ───────────────────── Copy Tasks from Deliverable 1 ─────────────────────

function copyTasksFromDeliverable1(sheet, targetRow) {
  var deliverables = readDeliverables(sheet);
  if (deliverables.length === 0) return;
  var template = deliverables[0];
  if (template.tasks.length === 0) return;
  if (targetRow === template.startRow) return; // don't copy Deliverable 1 onto itself

  var targetName = String(sheet.getRange(targetRow, 1).getValue() || '').trim();
  if (!targetName) return;

  var extraRowsNeeded = template.tasks.length - 1; // targetRow already exists as the first task row
  if (extraRowsNeeded > 0) {
    sheet.insertRowsAfter(targetRow, extraRowsNeeded);
  }

  var values = template.tasks.map(function (t, idx) {
    return [idx === 0 ? targetName : '', t.name, t.days, t.effort, t.team, '', ''];
  });
  sheet.getRange(targetRow, 1, values.length, 7).setValues(values);

  for (var i = 0; i < values.length; i++) {
    var r = targetRow + i;
    sheet.getRange(r, 6).setFormula('=IF(OR(D' + r + '="",E' + r + '=""),"",D' + r + '/COUNTA(SPLIT(E' + r + ',",")))');
  }

  // Dependency (column I) is copied separately from the A-G range above so
  // the checkbox column (H), sitting between them, is never touched.
  var dependencyValues = template.tasks.map(function (t) { return [t.dependency || DEPENDENCY_VALUES[0]]; });
  sheet.getRange(targetRow, EST_DEPENDENCY_COL, dependencyValues.length, 1).setValues(dependencyValues);
}

// ───────────────────────── RAG + Current Stage ─────────────────────────

function isCompletedStatus(status) {
  return String(status || '').toLowerCase().indexOf('completed') === 0;
}

function isBlockedStatus(status) {
  return String(status || '').toLowerCase().indexOf('blocked') === 0;
}

function toDateOnly(value) {
  if (!value) return null;
  var d = new Date(value);
  if (isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

// taskCells: array (one per slot) of either null (deliverable has no task in
// that slot) or { baseline, plan, actual, status }.
function computeRagAndStage(taskCells, slots) {
  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var anyBlocked = false;
  var anyOverdue = false;
  var anyDrift = false;
  var anyStarted = false;
  var allDone = true;
  var anyTask = false;
  var firstIncomplete = null;

  for (var i = 0; i < taskCells.length; i++) {
    var t = taskCells[i];
    if (!t) continue;
    anyTask = true;

    var status = t.status;
    if (isBlockedStatus(status)) anyBlocked = true;
    if (!isCompletedStatus(status)) {
      allDone = false;
      if (!firstIncomplete) firstIncomplete = { label: slots[i], status: status || 'YTS' };
    }
    if (status && String(status).toUpperCase() !== 'YTS') anyStarted = true;

    var baselineDate = toDateOnly(t.baseline);
    if (baselineDate) {
      if (!isCompletedStatus(status) && today > baselineDate) anyOverdue = true;
      var latestDate = toDateOnly(t.actual) || toDateOnly(t.plan);
      if (latestDate && latestDate > baselineDate) anyDrift = true;
    }
  }

  if (!anyTask) return { rag: '', stage: '' };

  var rag;
  if (anyBlocked || anyOverdue) rag = 'Red';
  else if (allDone) rag = 'Green';
  else if (anyDrift || anyStarted) rag = 'Amber';
  else rag = 'Gray';

  var stage = allDone ? 'Done' : (firstIncomplete ? (firstIncomplete.label + ' · ' + firstIncomplete.status) : '');
  return { rag: rag, stage: stage };
}

// ──────────────────────── Generate Project Tracker ────────────────────────

function readExistingTracking(track) {
  var lastRow = track.getLastRow();
  var lastCol = track.getLastColumn();
  if (lastRow < 3 || lastCol < TRACK_LEADING_COLS + TRACK_COLS_PER_TASK) return { tasks: {}, quality: {} };

  var header1 = track.getRange(1, 1, 1, lastCol).getValues()[0];
  var existingSlotLabels = [];
  for (var col = TRACK_LEADING_COLS; col + TRACK_COLS_PER_TASK <= lastCol; col += TRACK_COLS_PER_TASK) {
    existingSlotLabels.push(String(header1[col] || '').trim());
  }

  // The trailing Quality % column, if this sheet already has one, is found
  // by its header label rather than assumed to be at a fixed position —
  // older trackers (generated before this column existed) won't have it at
  // all, and its position shifts with however many task slots exist.
  var qualityCol = -1;
  for (var c = 0; c < header1.length; c++) {
    if (String(header1[c] || '').trim() === 'Quality %') { qualityCol = c; break; }
  }

  var data = track.getRange(3, 1, lastRow - 2, lastCol).getValues();
  var tasks = {};
  var quality = {};
  data.forEach(function (r) {
    var delivName = String(r[0] || '').trim();
    if (!delivName) return;
    existingSlotLabels.forEach(function (label, idx) {
      if (!label) return;
      var col = TRACK_LEADING_COLS + idx * TRACK_COLS_PER_TASK;
      if (col + TRACK_COLS_PER_TASK > r.length) return;
      // Dependency (col+6) is intentionally NOT preserved here — it's
      // planning data that always gets freshly re-copied from the
      // Estimation tab on regenerate (same treatment as Baseline Date),
      // not an execution-time value like Plan/Actual/Status.
      tasks[delivName + '||' + label] = {
        assignedTo: r[col + 0],
        hours: r[col + 1],
        plan: r[col + 3],
        actual: r[col + 4],
        status: r[col + 5],
      };
    });
    if (qualityCol >= 0 && qualityCol < r.length) {
      quality[delivName] = r[qualityCol];
    }
  });
  return { tasks: tasks, quality: quality };
}

function addDays(date, days) {
  var d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function ensureSheetSize(sheet, neededRows, neededCols) {
  var maxRows = sheet.getMaxRows();
  var maxCols = sheet.getMaxColumns();
  if (neededCols > maxCols) sheet.insertColumnsAfter(maxCols, neededCols - maxCols);
  if (neededRows > maxRows) sheet.insertRowsAfter(maxRows, neededRows - maxRows);
}

function generateProjectTracker() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var est = ss.getSheetByName(EST_SHEET_NAME);
  var track = ss.getSheetByName(TRACK_SHEET_NAME);

  if (!est || !track) {
    ui.alert('Could not find the expected tabs. Please don\\'t rename "' + EST_SHEET_NAME + '" or "' + TRACK_SHEET_NAME + '".');
    return;
  }

  var projectStartRaw = est.getRange('B1').getValue();
  var projectStart = (projectStartRaw instanceof Date) ? projectStartRaw : null;

  var deliverables = readDeliverables(est);
  if (deliverables.length === 0) {
    ui.alert('No deliverables found. Add a Deliverable Name and at least one task on the Estimation tab first.');
    return;
  }

  var slots = buildTaskSlots(deliverables);
  var existing = readExistingTracking(track);

  var headerRow1 = ['Deliverable Name', '', '', '', '', '', '', '', 'RAG', 'Current Stage'];
  var headerRow2 = ['', '', '', '', '', '', '', '', '', ''];
  slots.forEach(function (label) {
    headerRow1.push(label, '', '', '', '', '', '');
    headerRow2.push('Assigned To', 'Hours Allocated', 'Baseline Date', 'Plan Date', 'Actual Date', 'Status', 'Dependency');
  });
  headerRow1.push('Quality %');
  headerRow2.push('');

  var totalCols = TRACK_LEADING_COLS + slots.length * TRACK_COLS_PER_TASK + 1; // +1 trailing Quality % column
  var outputRows = [];

  deliverables.forEach(function (d) {
    var cursor = projectStart;
    var row = new Array(totalCols).fill('');
    row[0] = d.name;

    var taskCellsForRag = [];

    for (var i = 0; i < slots.length; i++) {
      var task = d.tasks[i];
      var baseCol = TRACK_LEADING_COLS + i * TRACK_COLS_PER_TASK;

      if (task) {
        var baseline = null;
        if (cursor) {
          // Never START a task on a weekend/holiday — roll forward to the
          // next real business day first.
          baseline = nextBusinessDay(cursor);
          if (task.days > 0) {
            var baselineEnd = addBusinessDays(baseline, task.days);
            cursor = addDays(baselineEnd, 1); // next task's nextBusinessDay() call rolls this forward if needed
          } else {
            cursor = baseline;
          }
        }

        var prior = existing.tasks[d.name + '||' + slots[i]];
        var firstMember = task.team ? task.team.split(',')[0].trim() : '';
        var assignedTo = (prior && prior.assignedTo) ? prior.assignedTo : firstMember;
        var hours = (prior && prior.hours !== '' && prior.hours != null) ? prior.hours : '';
        var plan = prior ? prior.plan : '';
        var actual = prior ? prior.actual : '';
        var status = (prior && prior.status) ? prior.status : 'YTS';

        row[baseCol + 0] = assignedTo;
        row[baseCol + 1] = hours;
        row[baseCol + 2] = baseline || '';
        row[baseCol + 3] = plan;
        row[baseCol + 4] = actual;
        row[baseCol + 5] = status;
        // Always freshly copied from Estimation — see readExistingTracking's
        // comment on why Dependency isn't preserved like Plan/Actual/Status.
        row[baseCol + 6] = task.dependency || DEPENDENCY_VALUES[0];

        taskCellsForRag.push({ baseline: baseline, plan: plan, actual: actual, status: status });
      } else {
        taskCellsForRag.push(null);
      }
    }

    var result = computeRagAndStage(taskCellsForRag, slots);
    row[8] = result.rag;
    row[9] = result.stage;
    var priorQuality = existing.quality[d.name];
    row[totalCols - 1] = (priorQuality !== undefined && priorQuality !== null) ? priorQuality : '';
    outputRows.push(row);
  });

  var neededRows = 2 + outputRows.length;
  ensureSheetSize(track, neededRows, totalCols);

  try { track.getDataRange().breakApart(); } catch (e) { /* nothing to unmerge yet */ }
  track.getRange(1, 1, Math.max(track.getLastRow(), neededRows), Math.max(track.getLastColumn(), totalCols)).clearContent();
  track.getRange(1, 1, Math.max(track.getLastRow(), neededRows), Math.max(track.getLastColumn(), totalCols)).clearFormat();

  track.getRange(1, 1, 1, totalCols).setValues([headerRow1]);
  track.getRange(2, 1, 1, totalCols).setValues([headerRow2]);
  if (outputRows.length > 0) {
    track.getRange(3, 1, outputRows.length, totalCols).setValues(outputRows);
  }

  applyTrackingFormatting(ss, track, slots, outputRows.length, totalCols);
  ensureWeeklyFinancialTrigger();

  ui.alert('Project Tracker generated: ' + deliverables.length + ' deliverable(s), ' + slots.length + ' task column(s). Existing Assigned To, Hours, Plan/Actual dates, Status, and Quality % were kept for any deliverable/task that still matches by name. Dependency was re-synced fresh from the Estimation tab.');
}

// ─────────────────────── Weekly financial snapshot ───────────────────────

// Installs the weekly Financial History snapshot trigger the first time
// Generate Project Tracker is run (idempotent — checking existing triggers
// first means re-running Generate Project Tracker never creates
// duplicates). Deliberately installed here rather than in onOpen: onOpen is
// a simple trigger and runs with restricted authorization, while this
// function only ever runs from the menu, which carries the full
// authorization the PM already granted the first time they used it.
function ensureWeeklyFinancialTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'weeklyFinancialSnapshot') return;
  }
  ScriptApp.newTrigger('weeklyFinancialSnapshot')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(6)
    .create();
}

// Snapshots whatever the Estimation tab's current Actual Revenue/Subcon
// Cost/Resources cells say (H2/J2/L2) into a new dated row on the
// Financial History tab. Fires weekly regardless of whether those cells
// changed — an unchanged week just logs the same numbers again, which is
// what lets the dashboard show a flat trend line rather than a gap.
function weeklyFinancialSnapshot() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var est = ss.getSheetByName(EST_SHEET_NAME);
  var history = ss.getSheetByName(FINANCIAL_HISTORY_SHEET_NAME);
  if (!est || !history) return;

  var actualRevenue = est.getRange('H2').getValue();
  var actualSubconCost = est.getRange('J2').getValue();
  var actualResources = est.getRange('L2').getValue();

  history.appendRow([new Date(), actualRevenue, actualSubconCost, actualResources]);
}

function applyTrackingFormatting(ss, track, slots, rowCount, totalCols) {
  var boldRange = track.getRange(1, 1, 2, totalCols);
  boldRange.setFontWeight('bold');
  boldRange.setBackground('#EDEEF2');
  boldRange.setHorizontalAlignment('center');

  // Vertically merge the leading single-row-concept headers across both header rows.
  track.getRange(1, 1, 2, 1).merge(); // Deliverable Name
  track.getRange(1, 9, 2, 1).merge(); // RAG
  track.getRange(1, 10, 2, 1).merge(); // Current Stage
  track.getRange(1, totalCols, 2, 1).merge(); // Quality % (trailing column)

  // Merge each task's group header across its 7 columns.
  slots.forEach(function (label, idx) {
    var startCol = TRACK_LEADING_COLS + idx * TRACK_COLS_PER_TASK + 1;
    track.getRange(1, startCol, 1, TRACK_COLS_PER_TASK).merge();
  });

  var lists = ss.getSheetByName(LISTS_SHEET_NAME);
  var conditionalRules = [];

  if (rowCount > 0 && lists) {
    var ownerRange = lists.getRange('B2:B31');
    var statusRange = lists.getRange('A2:A31');
    var ownerRule = SpreadsheetApp.newDataValidation().requireValueInRange(ownerRange, true).setAllowInvalid(true).build();
    var statusRule = SpreadsheetApp.newDataValidation().requireValueInRange(statusRange, true).setAllowInvalid(true).build();
    var dateRule = SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(true).build();
    var dependencyRule = SpreadsheetApp.newDataValidation().requireValueInList(DEPENDENCY_VALUES, true).setAllowInvalid(true).build();

    slots.forEach(function (label, idx) {
      var startCol = TRACK_LEADING_COLS + idx * TRACK_COLS_PER_TASK + 1;

      track.getRange(3, startCol, rowCount, 1).setDataValidation(ownerRule); // Assigned To
      var dateBlock = track.getRange(3, startCol + 2, rowCount, 3); // Baseline, Plan, Actual
      dateBlock.setNumberFormat('yyyy-mm-dd');
      dateBlock.setDataValidation(dateRule);
      var statusColRange = track.getRange(3, startCol + 5, rowCount, 1);
      statusColRange.setDataValidation(statusRule);
      track.getRange(3, startCol + 6, rowCount, 1).setDataValidation(dependencyRule); // Dependency

      [
        ['Completed', '#D9F0D3'],
        ['WIP', '#FFF2B2'],
        ['Blocked', '#F6C6C6'],
        ['On Hold', '#E0E0E0'],
        ['YTS', '#F2F2F2'],
      ].forEach(function (pair) {
        conditionalRules.push(
          SpreadsheetApp.newConditionalFormatRule()
            .whenTextStartsWith(pair[0])
            .setBackground(pair[1])
            .setRanges([statusColRange])
            .build()
        );
      });
    });

    var ragRange = track.getRange(3, 9, rowCount, 1);
    [
      ['Red', '#F6C6C6'],
      ['Amber', '#FFE2A8'],
      ['Green', '#D9F0D3'],
      ['Gray', '#E8E8E8'],
    ].forEach(function (pair) {
      conditionalRules.push(
        SpreadsheetApp.newConditionalFormatRule()
          .whenTextEqualTo(pair[0])
          .setBackground(pair[1])
          .setRanges([ragRange])
          .build()
      );
    });

    // Quality % (trailing column) — PM-entered, 0-100, shown as a percentage.
    var qualityRange = track.getRange(3, totalCols, rowCount, 1);
    var qualityRule = SpreadsheetApp.newDataValidation().requireNumberBetween(0, 100).setAllowInvalid(true).build();
    qualityRange.setDataValidation(qualityRule);
    qualityRange.setNumberFormat('0.0"%"');
  }

  track.setConditionalFormatRules(conditionalRules);
  track.autoResizeColumn(1);
}

// ──────────────────────────────── onEdit ────────────────────────────────

function onEdit(e) {
  try {
    var range = e.range;
    var sheet = range.getSheet();
    var name = sheet.getName();

    if (name === EST_SHEET_NAME) {
      handleEstimationEdit(sheet, range);
    } else if (name === TRACK_SHEET_NAME) {
      handleTrackingEdit(sheet, range);
    }
  } catch (err) {
    console.error(err);
  }
}

function handleEstimationEdit(sheet, range) {
  if (range.getColumn() !== EST_COPY_COL || range.getRow() < EST_FIRST_ROW) return;
  if (range.getValue() !== true) return;

  copyTasksFromDeliverable1(sheet, range.getRow());
  range.setValue(false);
}

function getCurrentSlotCount(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < TRACK_LEADING_COLS + TRACK_COLS_PER_TASK) return 0;
  return Math.floor((lastCol - TRACK_LEADING_COLS) / TRACK_COLS_PER_TASK);
}

function handleTrackingEdit(sheet, range) {
  var row = range.getRow();
  var col = range.getColumn();
  if (row < 3) return;

  var slotCount = getCurrentSlotCount(sheet);
  if (slotCount === 0) return;

  var offset = col - TRACK_LEADING_COLS;
  if (offset <= 0) return;
  var withinBlock = (offset - 1) % TRACK_COLS_PER_TASK; // 0 Assigned,1 Hours,2 Baseline,3 Plan,4 Actual,5 Status
  var slotIndex = Math.floor((offset - 1) / TRACK_COLS_PER_TASK);
  if (slotIndex >= slotCount) return;

  if (withinBlock === 3) {
    checkPlanDate(range);
  }

  if (withinBlock === 5) {
    var newStatus = String(range.getValue() || '');
    if (isCompletedStatus(newStatus)) {
      var actualCell = sheet.getRange(row, col - 1);
      if (!actualCell.getValue()) actualCell.setValue(new Date());
    }
  }

  if (withinBlock >= 2 && withinBlock <= 5) {
    recomputeRowStatus(sheet, row, slotCount);
  }
}

// Only Plan Date gets this treatment — Baseline Date is already generated
// business-day-aware by the script itself, and Actual Date records what
// really happened, holiday or not.
function checkPlanDate(range) {
  var value = range.getValue();
  if (!(value instanceof Date)) return; // cleared, or not a real date yet

  var reason = nonBusinessDayReason(value);
  if (!reason) return;

  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert(
    'Plan Date falls on ' + reason,
    'Keep this Plan Date anyway, or clear it and pick a different date?',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) {
    range.setValue('');
  }
}

function recomputeRowStatus(sheet, row, slotCount) {
  var lastCol = TRACK_LEADING_COLS + slotCount * TRACK_COLS_PER_TASK;
  var header1 = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var rowValues = sheet.getRange(row, 1, 1, lastCol).getValues()[0];

  var slots = [];
  var taskCells = [];
  for (var i = 0; i < slotCount; i++) {
    var startCol0 = TRACK_LEADING_COLS + i * TRACK_COLS_PER_TASK;
    var label = String(header1[startCol0] || ('Task ' + (i + 1)));
    slots.push(label);

    var assignedTo = rowValues[startCol0 + 0];
    var baseline = rowValues[startCol0 + 2];
    var plan = rowValues[startCol0 + 3];
    var actual = rowValues[startCol0 + 4];
    var status = rowValues[startCol0 + 5];
    var hasAny = assignedTo || baseline || plan || actual || status;
    taskCells.push(hasAny ? { baseline: baseline, plan: plan, actual: actual, status: status } : null);
  }

  var result = computeRagAndStage(taskCells, slots);
  if (result.rag !== '') {
    sheet.getRange(row, 9).setValue(result.rag);
    sheet.getRange(row, 10).setValue(result.stage);
  }
}
`;
}

const MANIFEST_JSON = JSON.stringify({
  timeZone: "Etc/UTC",
  exceptionLogging: "STACKDRIVER",
  runtimeVersion: "V8",
});

/**
 * Creates a container-bound Apps Script project on the given spreadsheet and
 * pushes the Code.gs source above into it. This is what makes the
 * "Project Tracker Tools ▸ Generate Project Tracker" menu appear the next
 * time anyone opens the sheet, and wires up the onEdit automations (copy
 * button, auto Actual Date, live RAG updates, Plan Date holiday warnings).
 *
 * `countryCodes` (ISO 3166-1 alpha-2, e.g. ["IN","US","ZA"]) drives the
 * holiday table baked into the script — see lib/holidays.ts. Pass an empty
 * array (or omit) for "weekends only, no country holidays." This is a
 * one-time snapshot taken now, not a live lookup: Apps Script's sandbox
 * can't reach npm packages, and Project Start/End Date aren't filled in yet
 * at this point in the flow (the PM sets them after upload), so there's no
 * real project date range to scope it to. The window is generous (current
 * year -1 to +6) specifically to absorb that uncertainty — see YEARS_BACK /
 * YEARS_FORWARD in lib/holidays.ts. Per-project country choice only applies
 * going forward; an already-generated sheet keeps whatever was baked in
 * when it was created.
 *
 * Requires: the Apps Script API enabled in Google Cloud, the
 * `script.projects` OAuth scope, AND the signed-in user must have "Google
 * Apps Script API" access turned on at script.google.com/home/usersettings
 * (off by default on many accounts) — otherwise this throws, which callers
 * should treat as non-fatal since the spreadsheet itself is already usable.
 */
export async function attachTrackerScript(
  accessToken: string,
  spreadsheetId: string,
  countryCodes: string[] = []
): Promise<void> {
  const auth = buildAuthClient(accessToken);
  const script = google.script({ version: "v1", auth });

  const holidayMap = buildHolidayMap(countryCodes);
  const codeGs = buildCodeGs(JSON.stringify(holidayMap));

  const createResponse = await script.projects.create({
    requestBody: {
      title: "Project Tracker Tools",
      parentId: spreadsheetId,
    },
  });

  const scriptId = createResponse.data.scriptId;
  if (!scriptId) {
    throw new Error("Apps Script API did not return a script ID.");
  }

  await script.projects.updateContent({
    scriptId,
    requestBody: {
      files: [
        { name: "Code", type: "SERVER_JS", source: codeGs },
        { name: "appsscript", type: "JSON", source: MANIFEST_JSON },
      ],
    },
  });
}
