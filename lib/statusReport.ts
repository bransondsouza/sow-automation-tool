import { google, slides_v1 } from "googleapis";
import type { ProjectSnapshot } from "./dashboardData";

function buildAuthClient(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return oauth2Client;
}

type Req = slides_v1.Schema$Request;
type RgbColor = { red: number; green: number; blue: number };

const PAGE_W = 720; // pt — standard 10in x 5.625in (16:9) slide
const PAGE_H = 405;
const MARGIN = 40;

// ── Brand + status palette (kept in sync with the dashboard's own colors —
// see app/globals.css :root and RAG_COLORS / paceClass in app/dashboard/page.tsx) ──
const NAVY: RgbColor = { red: 0x1d / 255, green: 0x4e / 255, blue: 0x6d / 255 };
const MUTED: RgbColor = { red: 0x5c / 255, green: 0x74 / 255, blue: 0x87 / 255 };
const ORANGE: RgbColor = { red: 0xf2 / 255, green: 0x6b / 255, blue: 0x22 / 255 };
const WHITE: RgbColor = { red: 1, green: 1, blue: 1 };
const PALE: RgbColor = { red: 0.78, green: 0.87, blue: 0.91 }; // muted text on navy backgrounds
const CARD_BG: RgbColor = { red: 0.945, green: 0.965, blue: 0.973 }; // neutral KPI card fill
const DIVIDER: RgbColor = { red: 0.85, green: 0.88, blue: 0.9 };

const RAG_RED: RgbColor = { red: 0.937, green: 0.267, blue: 0.267 };
const RAG_AMBER: RgbColor = { red: 0.961, green: 0.62, blue: 0.043 };
const RAG_GREEN: RgbColor = { red: 0.133, green: 0.773, blue: 0.369 };
const RAG_GRAY: RgbColor = { red: 0.612, green: 0.639, blue: 0.686 };
const RED_SOFT: RgbColor = { red: 0.99, green: 0.92, blue: 0.91 }; // risk panel background
const BLUE_SOFT: RgbColor = { red: 0.91, green: 0.95, blue: 0.97 }; // upcoming panel background

const RAG_FILL: Record<string, RgbColor> = {
  Red: RAG_RED,
  Amber: RAG_AMBER,
  Green: RAG_GREEN,
  Gray: RAG_GRAY,
};

const PACE_FILL: Record<string, RgbColor> = {
  Behind: RAG_RED,
  "On Pace": RAG_GREEN,
  Ahead: RAG_AMBER,
  Unknown: RAG_GRAY,
};

function pt(magnitude: number) {
  return { magnitude, unit: "PT" as const };
}

function box(x: number, y: number, w: number, h: number) {
  return {
    size: { width: pt(w), height: pt(h) },
    transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: "PT" as const },
  };
}

// A fresh counter per call (not module-level) so concurrent report
// generations in the same warm serverless instance never collide on IDs.
// Google Slides rejects any custom object ID shorter than 5 characters, so
// every prefix passed in here must itself be at least 4 characters long
// (plus a digit) to stay safe at every counter value — "tb"/"tbl" style
// short prefixes are NOT safe (e.g. "tb2" is only 3 characters).
function createIdGenerator() {
  let n = 0;
  return (prefix: string) => {
    n += 1;
    return `${prefix}${n}`;
  };
}

interface TextBoxOptions {
  fontSize?: number;
  bold?: boolean;
  color?: RgbColor;
}

function addTextBox(
  requests: Req[],
  nextId: (p: string) => string,
  pageId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  opts: TextBoxOptions = {}
): void {
  const id = nextId("shape");
  requests.push({
    createShape: {
      objectId: id,
      shapeType: "TEXT_BOX",
      elementProperties: { pageObjectId: pageId, ...box(x, y, w, h) },
    },
  });
  requests.push({
    insertText: { objectId: id, insertionIndex: 0, text: text || " " },
  });

  const style: slides_v1.Schema$TextStyle = {};
  const fields: string[] = [];
  if (opts.fontSize) {
    style.fontSize = pt(opts.fontSize);
    fields.push("fontSize");
  }
  if (opts.bold) {
    style.bold = true;
    fields.push("bold");
  }
  if (opts.color) {
    style.foregroundColor = { opaqueColor: { rgbColor: opts.color } };
    fields.push("foregroundColor");
  }
  if (fields.length > 0) {
    requests.push({
      updateTextStyle: {
        objectId: id,
        textRange: { type: "ALL" },
        style,
        fields: fields.join(","),
      },
    });
  }
}

// A solid-filled, borderless rectangle — used as a full-bleed background, an
// accent stripe/underline, a divider hairline, or a KPI/panel card behind
// text boxes layered on top of it (later requests render above earlier
// ones, so callers just need to add this before the text that sits on it).
function addFilledRect(
  requests: Req[],
  nextId: (p: string) => string,
  pageId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  color: RgbColor,
  rounded = false
): void {
  const id = nextId("shape");
  requests.push({
    createShape: {
      objectId: id,
      shapeType: rounded ? "ROUND_RECTANGLE" : "RECTANGLE",
      elementProperties: { pageObjectId: pageId, ...box(x, y, w, h) },
    },
  });
  requests.push({
    updateShapeProperties: {
      objectId: id,
      shapeProperties: {
        shapeBackgroundFill: { solidFill: { color: { rgbColor: color }, alpha: 1 } },
        outline: { propertyState: "NOT_RENDERED" },
      },
      fields: "shapeBackgroundFill.solidFill.color,shapeBackgroundFill.solidFill.alpha,outline.propertyState",
    },
  });
}

function addSlideHeading(requests: Req[], nextId: (p: string) => string, pageId: string, title: string): void {
  addTextBox(requests, nextId, pageId, MARGIN, 22, PAGE_W - MARGIN * 2, 34, title, {
    fontSize: 22,
    bold: true,
    color: NAVY,
  });
  addFilledRect(requests, nextId, pageId, MARGIN, 56, 56, 3, ORANGE);
}

function addFooter(requests: Req[], nextId: (p: string) => string, pageId: string, text: string): void {
  addFilledRect(requests, nextId, pageId, MARGIN, PAGE_H - 28, PAGE_W - MARGIN * 2, 1, DIVIDER);
  addTextBox(requests, nextId, pageId, MARGIN, PAGE_H - 22, PAGE_W - MARGIN * 2, 16, text, {
    fontSize: 8,
    color: MUTED,
  });
}

interface KpiCardOptions {
  bg?: RgbColor;
  valueColor?: RgbColor;
  labelColor?: RgbColor;
}

function addKpiCard(
  requests: Req[],
  nextId: (p: string) => string,
  pageId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  opts: KpiCardOptions = {}
): void {
  const bg = opts.bg ?? CARD_BG;
  const valueColor = opts.valueColor ?? NAVY;
  const labelColor = opts.labelColor ?? MUTED;
  addFilledRect(requests, nextId, pageId, x, y, w, h, bg, true);
  addTextBox(requests, nextId, pageId, x + 12, y + 12, w - 24, h * 0.5, value, {
    fontSize: 20,
    bold: true,
    color: valueColor,
  });
  addTextBox(requests, nextId, pageId, x + 12, y + h * 0.58, w - 24, h * 0.4, label, {
    fontSize: 10,
    color: labelColor,
  });
}

function addPanel(
  requests: Req[],
  nextId: (p: string) => string,
  pageId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  heading: string,
  headingColor: RgbColor,
  bg: RgbColor,
  bodyText: string
): void {
  addFilledRect(requests, nextId, pageId, x, y, w, h, bg, true);
  addTextBox(requests, nextId, pageId, x + 16, y + 14, w - 32, 22, heading, {
    fontSize: 13,
    bold: true,
    color: headingColor,
  });
  addTextBox(requests, nextId, pageId, x + 16, y + 42, w - 32, h - 58, bodyText, { fontSize: 10.5, color: NAVY });
}

interface TableOptions {
  headerBg?: RgbColor;
  headerColor?: RgbColor;
  highlightColumnIndex?: number;
  highlightColorFn?: (value: string) => RgbColor | null;
}

function addTable(
  requests: Req[],
  nextId: (p: string) => string,
  pageId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  headers: string[],
  rows: string[][],
  opts: TableOptions = {}
): void {
  const id = nextId("table");
  const rowCount = rows.length + 1;
  const colCount = headers.length;

  requests.push({
    createTable: {
      objectId: id,
      elementProperties: { pageObjectId: pageId, ...box(x, y, w, h) },
      rows: rowCount,
      columns: colCount,
    },
  });

  if (opts.headerBg) {
    requests.push({
      updateTableCellProperties: {
        objectId: id,
        tableRange: { location: { rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: colCount },
        tableCellProperties: {
          tableCellBackgroundFill: { solidFill: { color: { rgbColor: opts.headerBg }, alpha: 1 } },
        },
        fields: "tableCellBackgroundFill.solidFill.color,tableCellBackgroundFill.solidFill.alpha",
      },
    });
  }

  headers.forEach((text, c) => {
    requests.push({
      insertText: { objectId: id, cellLocation: { rowIndex: 0, columnIndex: c }, insertionIndex: 0, text },
    });
    const style: slides_v1.Schema$TextStyle = { bold: true, fontSize: pt(11) };
    const fields = ["bold", "fontSize"];
    if (opts.headerColor) {
      style.foregroundColor = { opaqueColor: { rgbColor: opts.headerColor } };
      fields.push("foregroundColor");
    }
    requests.push({
      updateTextStyle: {
        objectId: id,
        cellLocation: { rowIndex: 0, columnIndex: c },
        textRange: { type: "ALL" },
        style,
        fields: fields.join(","),
      },
    });
  });

  rows.forEach((row, r) => {
    row.forEach((text, c) => {
      requests.push({
        insertText: {
          objectId: id,
          cellLocation: { rowIndex: r + 1, columnIndex: c },
          insertionIndex: 0,
          text: text || "—",
        },
      });

      const highlight = opts.highlightColumnIndex === c ? opts.highlightColorFn?.(text) ?? null : null;
      if (highlight) {
        requests.push({
          updateTableCellProperties: {
            objectId: id,
            tableRange: { location: { rowIndex: r + 1, columnIndex: c }, rowSpan: 1, columnSpan: 1 },
            tableCellProperties: {
              tableCellBackgroundFill: { solidFill: { color: { rgbColor: highlight }, alpha: 1 } },
            },
            fields: "tableCellBackgroundFill.solidFill.color,tableCellBackgroundFill.solidFill.alpha",
          },
        });
      }

      const style: slides_v1.Schema$TextStyle = { fontSize: pt(10) };
      const fields = ["fontSize"];
      if (highlight) {
        style.bold = true;
        style.foregroundColor = { opaqueColor: { rgbColor: WHITE } };
        fields.push("bold", "foregroundColor");
      }
      requests.push({
        updateTextStyle: {
          objectId: id,
          cellLocation: { rowIndex: r + 1, columnIndex: c },
          textRange: { type: "ALL" },
          style,
          fields: fields.join(","),
        },
      });
    });
  });
}

export interface GeneratedReport {
  presentationId: string;
  url: string;
}

/**
 * Builds a client-ready status report as a brand-new Google Slides deck —
 * no template needed, so there's nothing to set up before this works. Pulls
 * straight from a live ProjectSnapshot (the same data the dashboard renders
 * live) so it's always current as of the moment it's generated. Designed
 * with the same brand palette and color language as the dashboard (RAG
 * colors, navy/orange accents) rather than plain text — colored KPI cards,
 * a branded cover/close pair, and colored status badges on the tables.
 * Fully editable afterward: real slides, shapes, and tables, not an image.
 */
export async function generateStatusReport(accessToken: string, snapshot: ProjectSnapshot): Promise<GeneratedReport> {
  const auth = buildAuthClient(accessToken);
  const slides = google.slides({ version: "v1", auth });

  const createResponse = await slides.presentations.create({
    requestBody: {
      title: `${snapshot.name} — Client Status Report — ${new Date().toISOString().slice(0, 10)}`,
    },
  });

  const presentationId = createResponse.data.presentationId;
  if (!presentationId) {
    throw new Error("Google Slides did not return a presentation ID.");
  }
  const defaultSlideId = createResponse.data.slides?.[0]?.objectId;

  const nextId = createIdGenerator();
  const requests: Req[] = [];

  if (defaultSlideId) {
    requests.push({ deleteObject: { objectId: defaultSlideId } });
  }

  const k = snapshot.kpis;
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const footerText = `${snapshot.name}  ·  Client Status Report  ·  ${today}`;

  // ── Slide 1: Title (branded cover) ──
  const titleSlideId = nextId("slide");
  requests.push({ createSlide: { objectId: titleSlideId, slideLayoutReference: { predefinedLayout: "BLANK" } } });
  addFilledRect(requests, nextId, titleSlideId, 0, 0, PAGE_W, PAGE_H, NAVY);
  addFilledRect(requests, nextId, titleSlideId, 0, 0, 10, PAGE_H, ORANGE);
  addTextBox(requests, nextId, titleSlideId, 60, 150, PAGE_W - 120, 70, snapshot.name, {
    fontSize: 34,
    bold: true,
    color: WHITE,
  });
  addTextBox(requests, nextId, titleSlideId, 60, 222, PAGE_W - 120, 36, "Client Status Report", {
    fontSize: 18,
    color: PALE,
  });
  addTextBox(
    requests,
    nextId,
    titleSlideId,
    60,
    266,
    PAGE_W - 120,
    26,
    `Generated ${today}${snapshot.buHead ? ` · Business Unit Head: ${snapshot.buHead}` : ""}`,
    { fontSize: 12, color: PALE }
  );

  // ── Slide 2: Executive Summary (KPI card grid) ──
  const summarySlideId = nextId("slide");
  requests.push({ createSlide: { objectId: summarySlideId, slideLayoutReference: { predefinedLayout: "BLANK" } } });
  addSlideHeading(requests, nextId, summarySlideId, "Executive Summary");

  if (!snapshot.trackerGenerated) {
    addTextBox(
      requests,
      nextId,
      summarySlideId,
      MARGIN,
      90,
      PAGE_W - MARGIN * 2,
      60,
      "Project Tracking & Execution hasn't been generated in the tracker sheet yet — estimation only.",
      { fontSize: 14, color: MUTED }
    );
  } else {
    const cardW = 149;
    const cardH = 95;
    const gap = 14;
    const colX = (col: number) => MARGIN + col * (cardW + gap);
    const row0Y = 80;
    const row1Y = row0Y + cardH + gap;

    const paceColor = PACE_FILL[k.schedulePace] ?? RAG_GRAY;
    const overdueColor = k.overdueTaskCount > 0 ? RAG_RED : RAG_GREEN;
    const blockedColor = k.blockedTaskCount > 0 ? RAG_RED : RAG_GREEN;

    addKpiCard(requests, nextId, summarySlideId, colX(0), row0Y, cardW, cardH, "Overall Health", k.overallRag, {
      bg: RAG_FILL[k.overallRag] ?? RAG_GRAY,
      valueColor: WHITE,
      labelColor: WHITE,
    });
    addKpiCard(
      requests,
      nextId,
      summarySlideId,
      colX(1),
      row0Y,
      cardW,
      cardH,
      `${k.completedTasks} of ${k.totalTasks} tasks`,
      `${k.taskCompletionPct}%`
    );
    addKpiCard(
      requests,
      nextId,
      summarySlideId,
      colX(2),
      row0Y,
      cardW,
      cardH,
      "On-Time Completion",
      k.onTimeCompletionPct !== null ? `${k.onTimeCompletionPct}%` : "—"
    );
    addKpiCard(requests, nextId, summarySlideId, colX(3), row0Y, cardW, cardH, "Schedule Pace", k.schedulePace, {
      bg: paceColor,
      valueColor: WHITE,
      labelColor: WHITE,
    });

    addKpiCard(
      requests,
      nextId,
      summarySlideId,
      colX(0),
      row1Y,
      cardW,
      cardH,
      "Overdue Tasks",
      String(k.overdueTaskCount),
      { valueColor: k.overdueTaskCount > 0 ? overdueColor : NAVY }
    );
    addKpiCard(
      requests,
      nextId,
      summarySlideId,
      colX(1),
      row1Y,
      cardW,
      cardH,
      "Blocked Tasks",
      String(k.blockedTaskCount),
      { valueColor: k.blockedTaskCount > 0 ? blockedColor : NAVY }
    );
    addKpiCard(
      requests,
      nextId,
      summarySlideId,
      colX(2),
      row1Y,
      cardW,
      cardH,
      "Upcoming (7 days)",
      String(k.upcomingMilestoneCount)
    );
    addKpiCard(
      requests,
      nextId,
      summarySlideId,
      colX(3),
      row1Y,
      cardW,
      cardH,
      "Days to Deadline",
      k.daysToDeadline !== null ? String(k.daysToDeadline) : "—"
    );

    if (k.elapsedPct !== null) {
      addTextBox(
        requests,
        nextId,
        summarySlideId,
        MARGIN,
        row1Y + cardH + 16,
        PAGE_W - MARGIN * 2,
        20,
        `${k.elapsedPct}% of project time elapsed vs. ${k.taskCompletionPct}% of tasks complete.`,
        { fontSize: 10.5, color: MUTED }
      );
    }
  }
  addFooter(requests, nextId, summarySlideId, footerText);

  // ── Slide 3: Deliverables Status ──
  if (snapshot.deliverables.length > 0) {
    const delivSlideId = nextId("slide");
    requests.push({ createSlide: { objectId: delivSlideId, slideLayoutReference: { predefinedLayout: "BLANK" } } });
    addSlideHeading(requests, nextId, delivSlideId, "Deliverables Status");

    const shown = snapshot.deliverables.slice(0, 20);
    const rows = shown.map((d) => [
      d.name,
      d.rag || "Not Started",
      d.currentStage || "—",
      `${d.tasks.filter((t) => t.completed).length} / ${d.tasks.length}`,
    ]);

    addTable(
      requests,
      nextId,
      delivSlideId,
      MARGIN,
      80,
      PAGE_W - MARGIN * 2,
      Math.min(250, 40 + rows.length * 22),
      ["Deliverable", "RAG", "Current Stage", "Tasks Completed"],
      rows,
      {
        headerBg: NAVY,
        headerColor: WHITE,
        highlightColumnIndex: 1,
        highlightColorFn: (value) => RAG_FILL[value] ?? null,
      }
    );

    if (snapshot.deliverables.length > shown.length) {
      addTextBox(
        requests,
        nextId,
        delivSlideId,
        MARGIN,
        355,
        PAGE_W - MARGIN * 2,
        18,
        `+ ${snapshot.deliverables.length - shown.length} more deliverable(s) not shown — see the live dashboard.`,
        { fontSize: 9.5, color: MUTED }
      );
    }
    addFooter(requests, nextId, delivSlideId, footerText);
  }

  // ── Slide 4: Upcoming & Risks ──
  const upcomingTasks = snapshot.deliverables
    .flatMap((d) => d.tasks.filter((t) => t.upcoming).map((t) => ({ deliverable: d.name, task: t.slotLabel, date: t.baseline })))
    .sort((a, b) => a.date.localeCompare(b.date));
  const blockedTasks = snapshot.deliverables.flatMap((d) =>
    d.tasks.filter((t) => t.blocked).map((t) => ({ deliverable: d.name, task: t.slotLabel }))
  );
  const overdueTasks = snapshot.deliverables
    .flatMap((d) => d.tasks.filter((t) => t.overdue).map((t) => ({ deliverable: d.name, task: t.slotLabel, date: t.baseline })))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (upcomingTasks.length > 0 || blockedTasks.length > 0 || overdueTasks.length > 0) {
    const riskSlideId = nextId("slide");
    requests.push({ createSlide: { objectId: riskSlideId, slideLayoutReference: { predefinedLayout: "BLANK" } } });
    addSlideHeading(requests, nextId, riskSlideId, "Upcoming & Risks");

    const colW = (PAGE_W - MARGIN * 2 - 20) / 2;
    const panelY = 80;
    const panelH = 260;

    const riskLines = [
      ...overdueTasks.slice(0, 8).map((t) => `⚠  [Overdue] ${t.deliverable} — ${t.task} (was due ${t.date})`),
      ...blockedTasks.slice(0, 8).map((t) => `⛔  [Blocked] ${t.deliverable} — ${t.task}`),
    ];
    addPanel(
      requests,
      nextId,
      riskSlideId,
      MARGIN,
      panelY,
      colW,
      panelH,
      "Risks",
      RAG_RED,
      RED_SOFT,
      riskLines.length > 0 ? riskLines.join("\n") : "No overdue or blocked tasks."
    );

    const upcomingLines = upcomingTasks.slice(0, 12).map((t) => `📅  ${t.date} — ${t.deliverable} — ${t.task}`);
    addPanel(
      requests,
      nextId,
      riskSlideId,
      MARGIN + colW + 20,
      panelY,
      colW,
      panelH,
      "Upcoming (Next 7 Days)",
      NAVY,
      BLUE_SOFT,
      upcomingLines.length > 0 ? upcomingLines.join("\n") : "Nothing due in the next 7 days."
    );
    addFooter(requests, nextId, riskSlideId, footerText);
  }

  // ── Slide 5: Resource Allocation ──
  if (k.resourceHours.length > 0) {
    const resSlideId = nextId("slide");
    requests.push({ createSlide: { objectId: resSlideId, slideLayoutReference: { predefinedLayout: "BLANK" } } });
    addSlideHeading(requests, nextId, resSlideId, "Resource Allocation");
    const shown = k.resourceHours.slice(0, 15);
    const rows = shown.map((r) => [r.name, `${r.hours}`]);
    addTable(requests, nextId, resSlideId, MARGIN, 80, 340, Math.min(250, 40 + rows.length * 22), ["Name", "Hours Allocated"], rows, {
      headerBg: NAVY,
      headerColor: WHITE,
    });
    addFooter(requests, nextId, resSlideId, footerText);
  }

  // ── Closing slide (branded bookend) ──
  const closingSlideId = nextId("slide");
  requests.push({ createSlide: { objectId: closingSlideId, slideLayoutReference: { predefinedLayout: "BLANK" } } });
  addFilledRect(requests, nextId, closingSlideId, 0, 0, PAGE_W, PAGE_H, NAVY);
  addFilledRect(requests, nextId, closingSlideId, 0, 0, 10, PAGE_H, ORANGE);
  addTextBox(requests, nextId, closingSlideId, 60, 165, PAGE_W - 120, 60, "Questions?", {
    fontSize: 28,
    bold: true,
    color: WHITE,
  });
  addTextBox(
    requests,
    nextId,
    closingSlideId,
    60,
    225,
    PAGE_W - 120,
    40,
    "Reach out to your project team for the full live tracker and further detail.",
    { fontSize: 14, color: PALE }
  );

  await slides.presentations.batchUpdate({ presentationId, requestBody: { requests } });

  return {
    presentationId,
    url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
  };
}

// Referenced by callers that just need page dimensions for their own math
// (none currently do, but kept exported since it's cheap and self-documenting).
export const SLIDE_DIMENSIONS = { width: PAGE_W, height: PAGE_H };
