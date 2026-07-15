import { google } from "googleapis";

function buildAuthClient(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return oauth2Client;
}

// ─────────────────────────────────────────────────────────────────────────
// The actual in-Sheet script. This becomes Code.gs inside a script bound to
// the generated spreadsheet. It reads the Estimation & Resource Allocation
// tab (any number of tasks, any WBS nesting depth, in any order), computes
// a schedule, and (re)writes the Project Tracking & Execution tab — while
// preserving any Actual dates / Owner / Status already entered for tasks
// that still exist. See SHEETS_TRACKER.md for the full explanation.
// ─────────────────────────────────────────────────────────────────────────
const CODE_GS = `
var EST_SHEET_NAME = 'Estimation & Resource Allocation';
var TRACK_SHEET_NAME = 'Project Tracking & Execution';
var LISTS_SHEET_NAME = 'Lists';
var EST_FIRST_ROW = 5;
var TRACK_FIRST_ROW = 2;
var TRACK_COLUMNS = 8; // WBS, Name, PlannedStart, PlannedEnd, ActualStart, ActualEnd, Owner, Status

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Project Tracker Tools')
    .addItem('Generate Project Tracker', 'generateProjectTracker')
    .addToUi();
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

  var projectStart = est.getRange('B1').getValue();
  var lastRow = est.getLastRow();
  if (lastRow < EST_FIRST_ROW) {
    ui.alert('No tasks found on the Estimation tab.');
    return;
  }

  var raw = est.getRange(EST_FIRST_ROW, 1, lastRow - EST_FIRST_ROW + 1, 7).getValues();
  var tasks = [];
  for (var i = 0; i < raw.length; i++) {
    var wbs = String(raw[i][0]).trim();
    var name = String(raw[i][1]).trim();
    if (!wbs || !name) continue; // skip blank buffer rows
    tasks.push({
      wbs: wbs,
      name: name,
      estDays: Number(raw[i][2]) || 0,
      depth: wbs.split('.').length,
    });
  }

  if (tasks.length === 0) {
    ui.alert('No rows with both a WBS # and a Task Name were found. Fill those in on the Estimation tab first, then try again.');
    return;
  }

  // Natural sort by WBS # (numeric per segment: 1, 1.2, 1.10, 2 — not string sort).
  tasks.sort(function (a, b) {
    var pa = a.wbs.split('.').map(Number);
    var pb = b.wbs.split('.').map(Number);
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
      var da = pa[i] === undefined ? -1 : pa[i];
      var db = pb[i] === undefined ? -1 : pb[i];
      if (isNaN(da)) da = -1;
      if (isNaN(db)) db = -1;
      if (da !== db) return da - db;
    }
    return 0;
  });

  // A row is a "parent" if some other row's WBS is nested under it.
  tasks.forEach(function (t) {
    t.isParent = tasks.some(function (other) { return other.wbs.indexOf(t.wbs + '.') === 0; });
  });

  // Sequential cascade across LEAF rows only, in sorted WBS order.
  var cursor = (projectStart instanceof Date) ? projectStart : null;
  tasks.forEach(function (t) {
    if (t.isParent) return;
    if (cursor && t.estDays > 0) {
      t.plannedStart = cursor;
      t.plannedEnd = addDays(cursor, t.estDays - 1);
      cursor = addDays(t.plannedEnd, 1);
    } else {
      t.plannedStart = null;
      t.plannedEnd = null;
    }
  });

  // Roll up parent date ranges from their descendants, deepest levels first.
  var byDepthDesc = tasks.slice().sort(function (a, b) { return b.depth - a.depth; });
  byDepthDesc.forEach(function (t) {
    if (!t.isParent) return;
    var children = tasks.filter(function (o) { return o.wbs.indexOf(t.wbs + '.') === 0; });
    var starts = children.map(function (c) { return c.plannedStart; }).filter(function (d) { return !!d; });
    var ends = children.map(function (c) { return c.plannedEnd; }).filter(function (d) { return !!d; });
    t.plannedStart = starts.length ? new Date(Math.min.apply(null, starts)) : null;
    t.plannedEnd = ends.length ? new Date(Math.max.apply(null, ends)) : null;
  });

  // Preserve existing Actual dates / Owner / Status for WBS rows that still exist.
  var existing = {};
  var trackLastRow = track.getLastRow();
  if (trackLastRow >= TRACK_FIRST_ROW) {
    var existingRaw = track.getRange(TRACK_FIRST_ROW, 1, trackLastRow - TRACK_FIRST_ROW + 1, TRACK_COLUMNS).getValues();
    existingRaw.forEach(function (r) {
      var wbs = String(r[0]).trim();
      if (!wbs) return;
      existing[wbs] = { actualStart: r[4], actualEnd: r[5], owner: r[6], status: r[7] };
    });
  }

  var output = tasks.map(function (t) {
    var prior = existing[t.wbs];
    var indent = new Array(t.depth).join('    ');
    return [
      t.wbs,
      indent + t.name,
      t.plannedStart || '',
      t.plannedEnd || '',
      prior ? prior.actualStart : '',
      prior ? prior.actualEnd : '',
      prior ? prior.owner : '',
      (prior && prior.status) ? prior.status : 'YTS',
    ];
  });

  if (trackLastRow >= TRACK_FIRST_ROW) {
    track.getRange(TRACK_FIRST_ROW, 1, trackLastRow - TRACK_FIRST_ROW + 1, TRACK_COLUMNS).clearContent();
  }
  track.getRange(TRACK_FIRST_ROW, 1, output.length, TRACK_COLUMNS).setValues(output);

  reapplyTrackingFormatting(ss, track, output.length);

  ui.alert('Project Tracker generated: ' + output.length + ' row(s). Existing Actual dates, Owners, and Status were kept for any task that still has the same WBS #.');
}

function reapplyTrackingFormatting(ss, track, rowCount) {
  var lists = ss.getSheetByName(LISTS_SHEET_NAME);
  if (!lists) return;

  track.getRange(2, 3, rowCount, 2).setNumberFormat('yyyy-mm-dd'); // Planned Start/End
  track.getRange(2, 5, rowCount, 2).setNumberFormat('yyyy-mm-dd'); // Actual Start/End

  var ownerRange = lists.getRange('B2:B31');
  var statusRange = lists.getRange('A2:A31');
  var ownerRule = SpreadsheetApp.newDataValidation().requireValueInRange(ownerRange, true).setAllowInvalid(true).build();
  var statusRule = SpreadsheetApp.newDataValidation().requireValueInRange(statusRange, true).setAllowInvalid(true).build();
  track.getRange(2, 7, rowCount, 1).setDataValidation(ownerRule);
  track.getRange(2, 8, rowCount, 1).setDataValidation(statusRule);

  var statusColRange = track.getRange(2, 8, rowCount, 1);
  var rules = [
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Completed').setBackground('#D9F0D3').setRanges([statusColRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('WIP').setBackground('#FFF2B2').setRanges([statusColRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('YTS').setBackground('#EDEDED').setRanges([statusColRange]).build(),
  ];
  track.setConditionalFormatRules(rules);
}

function addDays(date, days) {
  var d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}
`;

const MANIFEST_JSON = JSON.stringify({
  timeZone: "Etc/UTC",
  exceptionLogging: "STACKDRIVER",
  runtimeVersion: "V8",
});

/**
 * Creates a container-bound Apps Script project on the given spreadsheet and
 * pushes the Code.gs source above into it. This is what makes the
 * "Project Tracker Tools ▸ Generate Project Tracker" menu appear the next
 * time anyone opens the sheet.
 *
 * Requires: the Apps Script API enabled in Google Cloud, the
 * `script.projects` OAuth scope, AND the signed-in user must have "Google
 * Apps Script API" access turned on at script.google.com/home/usersettings
 * (off by default on many accounts) — otherwise this throws, which callers
 * should treat as non-fatal since the spreadsheet itself is already usable.
 */
export async function attachTrackerScript(accessToken: string, spreadsheetId: string): Promise<void> {
  const auth = buildAuthClient(accessToken);
  const script = google.script({ version: "v1", auth });

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
        { name: "Code", type: "SERVER_JS", source: CODE_GS },
        { name: "appsscript", type: "JSON", source: MANIFEST_JSON },
      ],
    },
  });
}
