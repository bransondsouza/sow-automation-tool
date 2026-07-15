import { google, sheets_v4 } from "googleapis";
import { SOWData } from "./types";

const ESTIMATION_SHEET_ID = 0;
const TRACKING_SHEET_ID = 1;
const LISTS_SHEET_ID = 2;

const ESTIMATION_SHEET_NAME = "Estimation & Resource Allocation";
const TRACKING_SHEET_NAME = "Project Tracking & Execution";
const LISTS_SHEET_NAME = "Lists";

const BUFFER_ROWS = 5; // extra blank template rows so PMs can add tasks later
const ESTIMATION_HEADER_ROW = 4; // 1-indexed row the column headers sit on
const ESTIMATION_FIRST_TASK_ROW = 5;

// Estimation & Resource Allocation task-table columns (from row 4 down).
// Row 1-3 (project dates, BU head, notes) use columns independently of these.
const EST_COL = { WBS: "A", NAME: "B", DAYS: "C", EFFORT: "D", TEAM: "E", EFFORT_PER_MEMBER: "F", NOTES: "G" };

// Both list columns share the same row range so the sheet stays simple —
// Lists!A2:A31 (statuses) and Lists!B2:B31 (roster), 30 editable rows each.
const LIST_ROOM_ROWS = 30;
const RESOURCE_SUMMARY_ROWS = 10; // blank rows in the allocation summary table

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
 * Builds the 3-tab Project Plan & Tracker spreadsheet:
 *  1. Estimation & Resource Allocation — tasks pulled from the SOW timeline
 *     as a starting point, each with a "WBS #" (e.g. 1, 1.1, 1.2.1) so the
 *     PM can freely restructure them into sub-projects/steps of any depth
 *     (e.g. "Lesson 1" as 1, its steps as 1.1/1.2/1.3). Includes a live
 *     formula splitting estimated effort across assigned team members, and
 *     a resource-allocation summary.
 *  2. Project Tracking & Execution — starts empty with just a header and a
 *     "how to use this" note. The PM fills in / restructures Sheet 1, then
 *     uses the "Generate Project Tracker" menu item this file installs
 *     (Project Tracker Tools ▸ Generate Project Tracker) to populate this
 *     tab from whatever's on Sheet 1 at that moment — any number of tasks,
 *     any nesting depth, in any order. Re-running it later preserves any
 *     Actual dates / Owner / Status already entered for tasks that still
 *     exist. See lib/googleAppsScript.ts for that script.
 *  3. Lists (hidden) — the editable source lists behind both dropdowns.
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
  const lastTaskRow = ESTIMATION_FIRST_TASK_ROW + totalTaskRows - 1;
  const summaryHeaderRow = lastTaskRow + 3;

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
            gridProperties: { frozenRowCount: 1 },
          },
        },
        {
          properties: {
            sheetId: LISTS_SHEET_ID,
            title: LISTS_SHEET_NAME,
            hidden: true,
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
        {
          range: `'${ESTIMATION_SHEET_NAME}'!A${summaryHeaderRow}`,
          values: buildResourceSummaryValues(teamRoster, lastTaskRow, summaryHeaderRow),
        },
        { range: `'${TRACKING_SHEET_NAME}'!A1`, values: buildTrackingPlaceholderValues() },
        { range: `'${LISTS_SHEET_NAME}'!A1`, values: buildListsValues(teamRoster) },
      ],
    },
  });

  // ── 3. Formatting ──
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        ...headerFormattingRequests(summaryHeaderRow),
        ...dateFormattingRequests(),
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
    ["Project Start Date:", "", "Project End Date:", "", "Business Unit Head:", buHeadLabel],
    [
      "(fill in below — WBS # can be restructured into sub-projects/steps at any depth, e.g. 1, 1.1, 1.2.1)",
      "",
      "",
      "",
      "",
      "",
    ],
    [],
    [
      "WBS #",
      "Task / Sub-Project / Step Name",
      "Estimated Days Required",
      "Estimated Effort (Hours)",
      "Team Members Assigned (comma-separated)",
      "Effort per Member (Hrs)",
      "Notes",
    ],
  ];

  const timelineItems = data.timeline.length > 0 ? data.timeline : [{ milestone: "[Add first task]", start: "", end: "", notes: "" }];

  for (let i = 0; i < totalTaskRows; i++) {
    const row = ESTIMATION_FIRST_TASK_ROW + i;
    const item = i < timelineItems.length ? timelineItems[i] : undefined;
    // Starting WBS numbers are flat top-level items (1, 2, 3...) — the SOW
    // timeline has no concept of sub-projects yet. The PM restructures these
    // into a real hierarchy (1, 1.1, 1.2, 2, 2.1...) as the project unfolds.
    // The leading "'" forces Sheets to store this as text, not a number —
    // without it, "1.10" would silently become the number 1.1.
    const wbs = item ? `'${i + 1}` : "";
    const taskName = item ? item.milestone : "";
    const notes = item && (item.start || item.end) ? `SOW timing: ${item.start} → ${item.end}` : item?.notes ?? "";
    const effortFormula = `=IF(OR(${EST_COL.EFFORT}${row}="",${EST_COL.TEAM}${row}=""),"",${EST_COL.EFFORT}${row}/COUNTA(SPLIT(${EST_COL.TEAM}${row},",")))`;
    rows.push([wbs, taskName, "", "", "", effortFormula, notes]);
  }

  return rows;
}

function buildResourceSummaryValues(teamRoster: string[], lastTaskRow: number, summaryHeaderRow: number): unknown[][] {
  // This block is written starting at absolute sheet row `summaryHeaderRow`,
  // so row index 0 here = the "Resource Allocation Summary" title, index 1 =
  // the column headers, and index 2 onward = the actual name/total pairs.
  const rows: unknown[][] = [
    ["Resource Allocation Summary"],
    ["Team Member", "Total Allocated Hours"],
  ];

  const names = teamRoster.length > 0 ? teamRoster : new Array(RESOURCE_SUMMARY_ROWS).fill("");

  for (let i = 0; i < RESOURCE_SUMMARY_ROWS; i++) {
    const name = names[i] ?? "";
    const absoluteRow = summaryHeaderRow + rows.length; // row this entry will land on once written
    const cellRef = `A${absoluteRow}`;
    rows.push([name, buildSummaryFormula(cellRef, lastTaskRow, ESTIMATION_FIRST_TASK_ROW)]);
  }

  return rows;
}

function buildSummaryFormula(nameCellRef: string, lastTaskRow: number, firstTaskRow: number): string {
  return `=IF(${nameCellRef}="","",SUMPRODUCT(ISNUMBER(SEARCH(${nameCellRef},$${EST_COL.TEAM}$${firstTaskRow}:$${EST_COL.TEAM}$${lastTaskRow}))*N($${EST_COL.EFFORT_PER_MEMBER}$${firstTaskRow}:$${EST_COL.EFFORT_PER_MEMBER}$${lastTaskRow})))`;
}

function buildTrackingPlaceholderValues(): unknown[][] {
  return [
    ["WBS #", "Task / Sub-Project / Step Name", "Planned Start Date", "Planned End Date", "Actual Start Date", "Actual End Date", "Stakeholder / Owner Name", "Status"],
    [
      "",
      "👉 Fill in the Estimation & Resource Allocation tab, then use the menu above: Project Tracker Tools ▸ Generate Project Tracker to populate this sheet.",
      "",
      "",
      "",
      "",
      "",
      "",
    ],
  ];
}

function buildListsValues(teamRoster: string[]): unknown[][] {
  const statuses = ["YTS", "WIP", "Completed"];
  const roster = teamRoster.length > 0 ? teamRoster : [];

  const rows: unknown[][] = [
    ["Status Options — edit this column to add/rename statuses used on the Tracking tab", "Team Roster — edit this column to manage who can be picked as Stakeholder/Owner"],
  ];

  for (let i = 0; i < LIST_ROOM_ROWS; i++) {
    rows.push([statuses[i] ?? "", roster[i] ?? ""]);
  }

  return rows;
}

// ─────────────────────── Formatting requests ───────────────────────

function headerFormattingRequests(summaryHeaderRow: number): sheets_v4.Schema$Request[] {
  const bold = { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.94, blue: 0.96 } } };

  return [
    {
      // Estimation task-table header, row 4, columns A-G
      repeatCell: {
        range: { sheetId: ESTIMATION_SHEET_ID, startRowIndex: ESTIMATION_HEADER_ROW - 1, endRowIndex: ESTIMATION_HEADER_ROW, startColumnIndex: 0, endColumnIndex: 7 },
        cell: bold,
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      // Row 1 labels: Project Start Date / Project End Date / Business Unit Head
      repeatCell: {
        range: { sheetId: ESTIMATION_SHEET_ID, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat(textFormat)",
      },
    },
    {
      repeatCell: {
        range: { sheetId: ESTIMATION_SHEET_ID, startRowIndex: summaryHeaderRow - 1, endRowIndex: summaryHeaderRow + 1, startColumnIndex: 0, endColumnIndex: 2 },
        cell: bold,
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      // Tracking header, row 1, columns A-H
      repeatCell: {
        range: { sheetId: TRACKING_SHEET_ID, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 8 },
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
  ];
}

function dateFormattingRequests(): sheets_v4.Schema$Request[] {
  const dateFormat = { numberFormat: { type: "DATE", pattern: "yyyy-mm-dd" } };
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
    // Tracking tab's date columns are formatted by the Apps Script button
    // each time it (re)writes rows, since the row count changes over time.
  ];
}

function columnWidthRequests(): sheets_v4.Schema$Request[] {
  return [
    {
      updateDimensionProperties: {
        range: { sheetId: ESTIMATION_SHEET_ID, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 70 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: ESTIMATION_SHEET_ID, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
        properties: { pixelSize: 260 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: TRACKING_SHEET_ID, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 70 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: TRACKING_SHEET_ID, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
        properties: { pixelSize: 280 },
        fields: "pixelSize",
      },
    },
  ];
}
