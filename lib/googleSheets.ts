import { google, sheets_v4 } from "googleapis";
import { SOWData } from "./types";

const ESTIMATION_SHEET_ID = 0;
const TRACKING_SHEET_ID = 1;
const LISTS_SHEET_ID = 2;
const FINANCIAL_HISTORY_SHEET_ID = 3;

const ESTIMATION_SHEET_NAME = "Estimation & Resource Allocation";
const TRACKING_SHEET_NAME = "Project Tracking & Execution";
const LISTS_SHEET_NAME = "Lists";
const FINANCIAL_HISTORY_SHEET_NAME = "Financial History";

const BUFFER_ROWS = 10; // extra blank template rows so PMs can add tasks/deliverables later
const ESTIMATION_HEADER_ROW = 4; // 1-indexed row the column headers sit on
const ESTIMATION_FIRST_TASK_ROW = 5;
const CHECKBOX_ROWS = 300; // how far down column H is pre-formatted as a checkbox

// Estimation & Resource Allocation task-table columns (from row 4 down).
// Row 1-2 (project dates, BU head, financials) use columns independently of
// these — same column letters mean different things on those header rows,
// same pattern already used for column F (Business Unit Head on row 1 vs.
// Effort per Member on row 4+).
const EST_COL = {
  DELIVERABLE: "A",
  TASK: "B",
  DAYS: "C",
  EFFORT: "D",
  TEAM: "E",
  EFFORT_PER_MEMBER: "F",
  NOTES: "G",
  COPY: "H",
  DEPENDENCY: "I",
};

const DEPENDENCY_OPTIONS = ["Non-dependent", "Dependent"];

// Resource Allocation Summary now lives to the right of the task table
// (see point 4) so it doesn't get pushed further down as more deliverables
// are added below the task table.
const SUMMARY_COL = { NAME: "J", TOTAL: "K" };
const SUMMARY_HEADER_ROW = 4;
const SUMMARY_FIRST_ROW = 6;
const SUMMARY_ROWS = 30; // Total-hours formulas pre-written this far down
// The Total Allocated Hours formulas scan this row range on the task table
// so they keep working as the Copy Tasks button inserts more rows over time.
const TASK_TABLE_SCAN_LAST_ROW = 500;

const LIST_ROOM_ROWS = 30; // Lists!A2:A31 (statuses) and Lists!B2:B31 (roster)

function buildAuthClient(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return oauth2Client;
}

export function extractSheetId(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  const match = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : trimmed;
}

export interface BusinessUnitHead {
  name: string;
  email: string;
}

export interface GeneratedSheet {
  spreadsheetId: string;
  url: string;
}

/**
 * Builds the 4-tab Project Plan & Tracker spreadsheet:
 *  1. Estimation & Resource Allocation — one row per task, grouped into
 *     deliverables (a "Deliverable Name" in column A starts a new group;
 *     leaving it blank means "same deliverable as the row above"). A
 *     checkbox in column H duplicates Deliverable 1's full task list into a
 *     newly-named deliverable, including the new Dependency column (I) — a
 *     Dependent/Non-dependent flag per task that feeds the dashboard's
 *     simplified critical-path view. A live resource-allocation summary
 *     sits to the right of the task table and updates itself the moment a
 *     name is added to the Lists tab — no regeneration needed. Row 1-2 also
 *     carry the project's Projected (row 1) and current Actual (row 2)
 *     Revenue/Subcon Cost/Resource-count figures — see "Financial History"
 *     below for how Actual values get logged over time.
 *  2. Project Tracking & Execution — starts empty. The PM fills in Sheet 1,
 *     then uses Project Tracker Tools ▸ Generate Project Tracker (installed
 *     by lib/googleAppsScript.ts) to build this as a Deliverable × Task
 *     matrix: one row per deliverable, RAG status + current stage, and a
 *     repeating block of columns per task (Assigned To, Hours, Baseline
 *     Date, Plan Date, Actual Date, Status, Dependency), plus a trailing
 *     Quality % column per deliverable. Re-running it preserves any
 *     Plan/Actual/Assigned/Hours/Status/Quality already entered. See
 *     SHEETS_TRACKER.md for the full explanation.
 *  3. Lists (hidden) — the editable source lists behind every dropdown.
 *  4. Financial History — an append-only log (Date, Actual Revenue, Actual
 *     Subcon Cost, Actual Resources) that a weekly Apps Script time trigger
 *     writes to automatically, snapshotting whatever the Estimation tab's
 *     current Actual values say at that moment.
 */
export async function generateProjectSheet(
  accessToken: string,
  data: SOWData,
  teamRoster: string[] = [],
  buHead?: BusinessUnitHead
): Promise<GeneratedSheet> {
  const auth = buildAuthClient(accessToken);
  const sheets = google.sheets({ version: "v4", auth });

  const taskCount = Math.max(data.timeline.length, 1);
  const totalTaskRows = taskCount + BUFFER_ROWS;

  // ── 1. Create the spreadsheet shell (tabs, freeze rows, hide Lists) ──
  const createResponse = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `${data.projectName} — Project Plan & Tracker` },
      sheets: [
        {
          properties: {
            sheetId: ESTIMATION_SHEET_ID,
            title: ESTIMATION_SHEET_NAME,
            gridProperties: { frozenRowCount: ESTIMATION_HEADER_ROW },
          },
        },
        {
          properties: {
            sheetId: TRACKING_SHEET_ID,
            title: TRACKING_SHEET_NAME,
            // Leading columns + up to ~18 task blocks (6 columns each) before
            // the Apps Script needs to grow the sheet itself on generate.
            gridProperties: { frozenRowCount: 2, columnCount: 120 },
          },
        },
        {
          properties: {
            sheetId: LISTS_SHEET_ID,
            title: LISTS_SHEET_NAME,
            hidden: true,
          },
        },
        {
          properties: {
            sheetId: FINANCIAL_HISTORY_SHEET_ID,
            title: FINANCIAL_HISTORY_SHEET_NAME,
            gridProperties: { frozenRowCount: 1 },
          },
        },
      ],
    },
  });

  const spreadsheetId = createResponse.data.spreadsheetId;
  if (!spreadsheetId) {
    throw new Error("Google Sheets did not return a spreadsheet ID.");
  }

  // ── 2. Write all cell values + formulas ──
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: `'${ESTIMATION_SHEET_NAME}'!A1`, values: buildEstimationValues(data, totalTaskRows, buHead) },
        { range: `'${ESTIMATION_SHEET_NAME}'!${SUMMARY_COL.NAME}${SUMMARY_HEADER_ROW}`, values: buildResourceSummaryValues() },
        { range: `'${TRACKING_SHEET_NAME}'!A1`, values: buildTrackingPlaceholderValues() },
        { range: `'${LISTS_SHEET_NAME}'!A1`, values: buildListsValues(teamRoster) },
        { range: `'${FINANCIAL_HISTORY_SHEET_NAME}'!A1`, values: buildFinancialHistoryValues() },
      ],
    },
  });

  // ── 3. Formatting + validation ──
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        ...headerFormattingRequests(),
        ...dateFormattingRequests(),
        ...checkboxValidationRequests(),
        ...dependencyValidationRequests(),
        ...financialFormattingRequests(),
        ...columnWidthRequests(),
      ],
    },
  });

  return {
    spreadsheetId,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}

// ───────────────────────── Values builders ─────────────────────────

function buildEstimationValues(data: SOWData, totalTaskRows: number, buHead?: BusinessUnitHead): unknown[][] {
  const buHeadLabel = buHead ? `${buHead.name} <${buHead.email}>` : "";

  const rows: unknown[][] = [
    // Row 1 — project dates/BU head (A-F) plus the PLANNED financial baseline
    // (G-L), set once at project start.
    [
      "Project Start Date:",
      "",
      "Project End Date:",
      "",
      "Business Unit Head:",
      buHeadLabel,
      "Projected Revenue ($):",
      "",
      "Projected Subcon Cost ($):",
      "",
      "Projected Resources (#):",
      "",
    ],
    // Row 2 — the instructional note (A) plus the CURRENT ACTUAL financial
    // values (G-L) — these are what the PM updates as reality changes, and
    // what the weekly snapshot trigger reads from (see lib/googleAppsScript.ts).
    [
      "(fill in below — every deliverable's schedule cascades from Project Start Date, so set this first)",
      "",
      "",
      "",
      "",
      "",
      "Actual Revenue ($):",
      "",
      "Actual Subcon Cost ($):",
      "",
      "Actual Resources (#):",
      "",
    ],
    [],
    [
      "Deliverable Name",
      "Task Name",
      "Estimated Days Required",
      "Estimated Effort (Hours)",
      "Team Members Assigned (comma-separated)",
      "Effort per Member (Hrs)",
      "Notes",
      "Copy Tasks from Deliverable 1",
      "Dependency",
    ],
  ];

  const timelineItems = data.timeline.length > 0 ? data.timeline : [{ milestone: "[Add first task]", start: "", end: "", notes: "" }];
  const deliverableName = data.projectName || "Deliverable 1";

  for (let i = 0; i < totalTaskRows; i++) {
    const row = ESTIMATION_FIRST_TASK_ROW + i;
    const item = i < timelineItems.length ? timelineItems[i] : undefined;
    // Only the FIRST row of a deliverable's task group carries its name in
    // column A — every row below it with column A left blank is treated as
    // "another task under the same deliverable" (see SHEETS_TRACKER.md).
    const name = i === 0 && item ? deliverableName : "";
    const taskName = item ? item.milestone : "";
    const notes = item && (item.start || item.end) ? `SOW timing: ${item.start} → ${item.end}` : item?.notes ?? "";
    const effortFormula = `=IF(OR(${EST_COL.EFFORT}${row}="",${EST_COL.TEAM}${row}=""),"",${EST_COL.EFFORT}${row}/COUNTA(SPLIT(${EST_COL.TEAM}${row},",")))`;
    // Dependency defaults to Non-dependent — a PM opts a task INTO a
    // dependency chain rather than the tool assuming every task blocks the
    // next one, which would otherwise manufacture a fake critical path.
    rows.push([name, taskName, "", "", "", effortFormula, notes, "", DEPENDENCY_OPTIONS[0]]);
  }

  return rows;
}

function buildFinancialHistoryValues(): unknown[][] {
  return [["Date", "Actual Revenue ($)", "Actual Subcon Cost ($)", "Actual Resources (#)"]];
}

function buildResourceSummaryValues(): unknown[][] {
  // Row 0 (SUMMARY_HEADER_ROW = row 4): title. Row 1 (row 5): column
  // headers. Row 2 (row 6) is where the live FILTER formula starts — it
  // must be the ONLY thing written under the Name column; Sheets grows it
  // downward on its own as names are added/removed on the Lists tab, and
  // writing anything below it would block the auto-expand ("spill").
  const rows: unknown[][] = [
    ["Resource Allocation Summary"],
    ["Team Member", "Total Allocated Hours"],
    [`=FILTER(${LISTS_SHEET_NAME}!$B$2:$B$${LIST_ROOM_ROWS + 1}, ${LISTS_SHEET_NAME}!$B$2:$B$${LIST_ROOM_ROWS + 1}<>"")`],
  ];

  // Total Allocated Hours: one formula per row, each referencing only its
  // own row's (possibly spilled-into) Name cell — safe to pre-write all of
  // these up front since they live in a different column than the spill.
  for (let i = 0; i < SUMMARY_ROWS; i++) {
    const summaryRow = SUMMARY_FIRST_ROW + i;
    const nameCell = `${SUMMARY_COL.NAME}${summaryRow}`;
    if (i === 0) {
      rows[2].push(buildSummaryFormula(nameCell));
    } else {
      rows.push(["", buildSummaryFormula(nameCell)]);
    }
  }

  return rows;
}

function buildSummaryFormula(nameCellRef: string): string {
  return `=IF(${nameCellRef}="","",SUMPRODUCT(ISNUMBER(SEARCH(${nameCellRef},$${EST_COL.TEAM}$${ESTIMATION_FIRST_TASK_ROW}:$${EST_COL.TEAM}$${TASK_TABLE_SCAN_LAST_ROW}))*N($${EST_COL.EFFORT_PER_MEMBER}$${ESTIMATION_FIRST_TASK_ROW}:$${EST_COL.EFFORT_PER_MEMBER}$${TASK_TABLE_SCAN_LAST_ROW})))`;
}

function buildTrackingPlaceholderValues(): unknown[][] {
  return [
    [
      "👉 Fill in the Estimation & Resource Allocation tab (add deliverables + tasks), then use the menu above:",
    ],
    ["Project Tracker Tools ▸ Generate Project Tracker — this builds everything below automatically."],
  ];
}

function buildListsValues(teamRoster: string[]): unknown[][] {
  const statuses = ["YTS", "WIP", "Completed", "Blocked", "On Hold"];
  const roster = teamRoster.length > 0 ? teamRoster : [];

  const rows: unknown[][] = [
    ["Status Options — edit this column to add/rename statuses used on the Tracking tab", "Team Roster — edit this column to manage who can be picked as Assigned To / Owner"],
  ];

  for (let i = 0; i < LIST_ROOM_ROWS; i++) {
    rows.push([statuses[i] ?? "", roster[i] ?? ""]);
  }

  return rows;
}

// ─────────────────────── Formatting requests ───────────────────────

function headerFormattingRequests(): sheets_v4.Schema$Request[] {
  const bold = { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.94, blue: 0.96 } } };

  return [
    {
      // Estimation task-table header, row 4, columns A-I (now includes Dependency)
      repeatCell: {
        range: { sheetId: ESTIMATION_SHEET_ID, startRowIndex: ESTIMATION_HEADER_ROW - 1, endRowIndex: ESTIMATION_HEADER_ROW, startColumnIndex: 0, endColumnIndex: 9 },
        cell: bold,
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      // Row 1 labels: Project Start/End Date, BU Head, Projected financials (A-L)
      repeatCell: {
        range: { sheetId: ESTIMATION_SHEET_ID, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 12 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat(textFormat)",
      },
    },
    {
      // Row 2 Actual-financials labels (G-L) — the instructional note in A2
      // stays unbolded, so this only covers the new columns.
      repeatCell: {
        range: { sheetId: ESTIMATION_SHEET_ID, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 6, endColumnIndex: 12 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat(textFormat)",
      },
    },
    {
      // Resource Allocation Summary title + headers (columns J-K)
      repeatCell: {
        range: { sheetId: ESTIMATION_SHEET_ID, startRowIndex: SUMMARY_HEADER_ROW - 1, endRowIndex: SUMMARY_HEADER_ROW + 1, startColumnIndex: 9, endColumnIndex: 11 },
        cell: bold,
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      repeatCell: {
        range: { sheetId: LISTS_SHEET_ID, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: "WRAP" } },
        fields: "userEnteredFormat(textFormat,wrapStrategy)",
      },
    },
    {
      // Financial History header row
      repeatCell: {
        range: { sheetId: FINANCIAL_HISTORY_SHEET_ID, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 },
        cell: bold,
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
  ];
}

function dateFormattingRequests(): sheets_v4.Schema$Request[] {
  const dateFormat = { numberFormat: { type: "DATE", pattern: "yyyy-mm-dd" } };
  // A DATE-typed data validation rule (not just a number format) is what
  // makes Google Sheets pop up the little calendar picker when you click
  // into the cell — plain number formatting alone doesn't trigger it.
  const dateValidation = { condition: { type: "DATE_IS_VALID" }, strict: false, showCustomUi: true };

  return [
    {
      // B1 = Project Start Date value cell
      repeatCell: {
        range: { sheetId: ESTIMATION_SHEET_ID, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: dateFormat },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    {
      // D1 = Project End Date value cell
      repeatCell: {
        range: { sheetId: ESTIMATION_SHEET_ID, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4 },
        cell: { userEnteredFormat: dateFormat },
        fields: "userEnteredFormat.numberFormat",
      },
    },
    {
      setDataValidation: {
        range: { sheetId: ESTIMATION_SHEET_ID, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
        rule: dateValidation,
      },
    },
    {
      setDataValidation: {
        range: { sheetId: ESTIMATION_SHEET_ID, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4 },
        rule: dateValidation,
      },
    },
    // Tracking tab's Baseline/Plan/Actual date columns are formatted (and
    // given the same calendar-picker validation) by the Apps Script button
    // each time it (re)writes rows, since the column count changes with the
    // number of tasks per deliverable.
  ];
}

function checkboxValidationRequests(): sheets_v4.Schema$Request[] {
  return [
    {
      // Pre-format column H as checkboxes for a generous number of rows so
      // "Copy Tasks from Deliverable 1" is always ready the moment a PM
      // types a new deliverable name — no need to wait for anything to run.
      setDataValidation: {
        range: { sheetId: ESTIMATION_SHEET_ID, startRowIndex: ESTIMATION_FIRST_TASK_ROW - 1, endRowIndex: ESTIMATION_FIRST_TASK_ROW - 1 + CHECKBOX_ROWS, startColumnIndex: 7, endColumnIndex: 8 },
        rule: { condition: { type: "BOOLEAN" }, showCustomUi: true },
      },
    },
  ];
}

function dependencyValidationRequests(): sheets_v4.Schema$Request[] {
  return [
    {
      // Pre-format column I (Dependency) as a dropdown for the same row range
      // the checkbox column is pre-formatted for, so it's ready for every
      // deliverable a PM might add without waiting for anything to run.
      setDataValidation: {
        range: { sheetId: ESTIMATION_SHEET_ID, startRowIndex: ESTIMATION_FIRST_TASK_ROW - 1, endRowIndex: ESTIMATION_FIRST_TASK_ROW - 1 + CHECKBOX_ROWS, startColumnIndex: 8, endColumnIndex: 9 },
        rule: {
          condition: { type: "ONE_OF_LIST", values: DEPENDENCY_OPTIONS.map((v) => ({ userEnteredValue: v })) },
          strict: true,
          showCustomUi: true,
        },
      },
    },
  ];
}

function financialFormattingRequests(): sheets_v4.Schema$Request[] {
  const currencyFormat = { numberFormat: { type: "NUMBER", pattern: '#,##0.00" "' } };
  const wholeNumberFormat = { numberFormat: { type: "NUMBER", pattern: "#,##0" } };
  const nonNegativeValidation = { condition: { type: "NUMBER_GREATER_THAN_EQ", values: [{ userEnteredValue: "0" }] }, strict: false, showCustomUi: true };

  // Value cells: H1/J1/L1 (Projected Revenue/Subcon Cost/Resources),
  // H2/J2/L2 (Actual Revenue/Subcon Cost/Resources). Revenue and Subcon Cost
  // get a currency-style number format; Resources (a headcount) gets a plain
  // whole-number format.
  const currencyCells = [
    { row: 0, col: 7 }, // H1
    { row: 0, col: 9 }, // J1
    { row: 1, col: 7 }, // H2
    { row: 1, col: 9 }, // J2
  ];
  const resourceCountCells = [
    { row: 0, col: 11 }, // L1
    { row: 1, col: 11 }, // L2
  ];

  const requests: sheets_v4.Schema$Request[] = [];

  currencyCells.forEach(({ row, col }) => {
    const range = { sheetId: ESTIMATION_SHEET_ID, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: col, endColumnIndex: col + 1 };
    requests.push({ repeatCell: { range, cell: { userEnteredFormat: currencyFormat }, fields: "userEnteredFormat.numberFormat" } });
    requests.push({ setDataValidation: { range, rule: nonNegativeValidation } });
  });

  resourceCountCells.forEach(({ row, col }) => {
    const range = { sheetId: ESTIMATION_SHEET_ID, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: col, endColumnIndex: col + 1 };
    requests.push({ repeatCell: { range, cell: { userEnteredFormat: wholeNumberFormat }, fields: "userEnteredFormat.numberFormat" } });
    requests.push({ setDataValidation: { range, rule: nonNegativeValidation } });
  });

  return requests;
}

function columnWidthRequests(): sheets_v4.Schema$Request[] {
  return [
    {
      updateDimensionProperties: {
        range: { sheetId: ESTIMATION_SHEET_ID, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 190 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: ESTIMATION_SHEET_ID, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
        properties: { pixelSize: 220 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: ESTIMATION_SHEET_ID, dimension: "COLUMNS", startIndex: 7, endIndex: 8 },
        properties: { pixelSize: 90 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: ESTIMATION_SHEET_ID, dimension: "COLUMNS", startIndex: 9, endIndex: 10 },
        properties: { pixelSize: 180 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: ESTIMATION_SHEET_ID, dimension: "COLUMNS", startIndex: 8, endIndex: 9 },
        properties: { pixelSize: 130 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: TRACKING_SHEET_ID, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 190 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: FINANCIAL_HISTORY_SHEET_ID, dimension: "COLUMNS", startIndex: 0, endIndex: 4 },
        properties: { pixelSize: 170 },
        fields: "pixelSize",
      },
    },
  ];
}
