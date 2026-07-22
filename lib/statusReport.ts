import { google, slides_v1 } from "googleapis";
import type { ProjectSnapshot } from "./dashboardData";

function buildAuthClient(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return oauth2Client;
}

type Req = slides_v1.Schema$Request;

const PAGE_W = 720; // pt — standard 10in x 5.625in (16:9) slide
const PAGE_H = 405;
const MARGIN = 40;

const NAVY = { red: 0x1d / 255, green: 0x4e / 255, blue: 0x6d / 255 };
const MUTED = { red: 0x5c / 255, green: 0x74 / 255, blue: 0x87 / 255 };

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
  color?: { red: number; green: number; blue: number };
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
  const id = nextId("tb");
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

function addTable(
  requests: Req[],
  nextId: (p: string) => string,
  pageId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  headers: string[],
  rows: string[][]
): void {
  const id = nextId("tbl");
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

  headers.forEach((text, c) => {
    requests.push({
      insertText: { objectId: id, cellLocation: { rowIndex: 0, columnIndex: c }, insertionIndex: 0, text },
    });
    requests.push({
      updateTextStyle: {
        objectId: id,
        cellLocation: { rowIndex: 0, columnIndex: c },
        textRange: { type: "ALL" },
        style: { bold: true, fontSize: pt(11) },
        fields: "bold,fontSize",
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
      requests.push({
        updateTextStyle: {
          objectId: id,
          cellLocation: { rowIndex: r + 1, columnIndex: c },
          textRange: { type: "ALL" },
          style: { fontSize: pt(10) },
          fields: "fontSize",
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
 * live) so it's always current as of the moment it's generated. Fully
 * editable afterward: real slides, shapes, and tables, not an image export.
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

  // ── Slide 1: Title ──
  const titleSlideId = nextId("slide");
  requests.push({ createSlide: { objectId: titleSlideId, slideLayoutReference: { predefinedLayout: "BLANK" } } });
  addTextBox(requests, nextId, titleSlideId, MARGIN, 120, PAGE_W - MARGIN * 2, 70, snapshot.name, {
    fontSize: 32,
    bold: true,
    color: NAVY,
  });
  addTextBox(requests, nextId, titleSlideId, MARGIN, 195, PAGE_W - MARGIN * 2, 40, "Client Status Report", {
    fontSize: 18,
    color: MUTED,
  });
  addTextBox(
    requests,
    nextId,
    titleSlideId,
    MARGIN,
    245,
    PAGE_W - MARGIN * 2,
    30,
    `Generated ${today}${snapshot.buHead ? ` · Business Unit Head: ${snapshot.buHead}` : ""}`,
    { fontSize: 12, color: MUTED }
  );

  // ── Slide 2: Executive Summary ──
  const summarySlideId = nextId("slide");
  requests.push({ createSlide: { objectId: summarySlideId, slideLayoutReference: { predefinedLayout: "BLANK" } } });
  addTextBox(requests, nextId, summarySlideId, MARGIN, 24, PAGE_W - MARGIN * 2, 40, "Executive Summary", {
    fontSize: 22,
    bold: true,
    color: NAVY,
  });

  const summaryLines = !snapshot.trackerGenerated
    ? ["Project Tracking & Execution hasn't been generated in the tracker sheet yet — estimation only."]
    : [
        `Overall Health: ${k.overallRag}`,
        `Task Completion: ${k.taskCompletionPct}% (${k.completedTasks} of ${k.totalTasks} tasks)`,
        k.onTimeCompletionPct !== null ? `On-Time Completion: ${k.onTimeCompletionPct}%` : null,
        `Overdue Tasks: ${k.overdueTaskCount}`,
        `Blocked Tasks: ${k.blockedTaskCount}`,
        `Upcoming Milestones (next 7 days): ${k.upcomingMilestoneCount}`,
        k.daysToDeadline !== null ? `Days to Deadline: ${k.daysToDeadline}` : null,
        `Schedule Pace: ${k.schedulePace}${
          k.elapsedPct !== null ? ` (${k.elapsedPct}% of time elapsed vs ${k.taskCompletionPct}% complete)` : ""
        }`,
      ].filter((l): l is string => l !== null);

  addTextBox(
    requests,
    nextId,
    summarySlideId,
    MARGIN,
    80,
    PAGE_W - MARGIN * 2,
    280,
    summaryLines.map((l) => `•  ${l}`).join("\n"),
    { fontSize: 14 }
  );

  // ── Slide 3: Deliverables Status ──
  if (snapshot.deliverables.length > 0) {
    const delivSlideId = nextId("slide");
    requests.push({ createSlide: { objectId: delivSlideId, slideLayoutReference: { predefinedLayout: "BLANK" } } });
    addTextBox(requests, nextId, delivSlideId, MARGIN, 24, PAGE_W - MARGIN * 2, 40, "Deliverables Status", {
      fontSize: 22,
      bold: true,
      color: NAVY,
    });

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
      Math.min(280, 40 + rows.length * 22),
      ["Deliverable", "RAG", "Current Stage", "Tasks Completed"],
      rows
    );

    if (snapshot.deliverables.length > shown.length) {
      addTextBox(
        requests,
        nextId,
        delivSlideId,
        MARGIN,
        375,
        PAGE_W - MARGIN * 2,
        20,
        `+ ${snapshot.deliverables.length - shown.length} more deliverable(s) not shown — see the live dashboard.`,
        { fontSize: 10, color: MUTED }
      );
    }
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
    addTextBox(requests, nextId, riskSlideId, MARGIN, 24, PAGE_W - MARGIN * 2, 40, "Upcoming & Risks", {
      fontSize: 22,
      bold: true,
      color: NAVY,
    });

    const colW = (PAGE_W - MARGIN * 2 - 20) / 2;

    const riskLines = [
      ...overdueTasks.slice(0, 8).map((t) => `•  [Overdue] ${t.deliverable} — ${t.task} (was due ${t.date})`),
      ...blockedTasks.slice(0, 8).map((t) => `•  [Blocked] ${t.deliverable} — ${t.task}`),
    ];
    addTextBox(
      requests,
      nextId,
      riskSlideId,
      MARGIN,
      80,
      colW,
      280,
      riskLines.length > 0 ? riskLines.join("\n") : "No overdue or blocked tasks.",
      { fontSize: 11 }
    );

    const upcomingLines = upcomingTasks.slice(0, 12).map((t) => `•  ${t.date} — ${t.deliverable} — ${t.task}`);
    addTextBox(
      requests,
      nextId,
      riskSlideId,
      MARGIN + colW + 20,
      80,
      colW,
      280,
      upcomingLines.length > 0 ? upcomingLines.join("\n") : "Nothing due in the next 7 days.",
      { fontSize: 11 }
    );
  }

  // ── Slide 5: Resource Allocation ──
  if (k.resourceHours.length > 0) {
    const resSlideId = nextId("slide");
    requests.push({ createSlide: { objectId: resSlideId, slideLayoutReference: { predefinedLayout: "BLANK" } } });
    addTextBox(requests, nextId, resSlideId, MARGIN, 24, PAGE_W - MARGIN * 2, 40, "Resource Allocation", {
      fontSize: 22,
      bold: true,
      color: NAVY,
    });
    const shown = k.resourceHours.slice(0, 15);
    const rows = shown.map((r) => [r.name, `${r.hours}`]);
    addTable(requests, nextId, resSlideId, MARGIN, 80, 320, Math.min(280, 40 + rows.length * 22), ["Name", "Hours Allocated"], rows);
  }

  // ── Closing slide ──
  const closingSlideId = nextId("slide");
  requests.push({ createSlide: { objectId: closingSlideId, slideLayoutReference: { predefinedLayout: "BLANK" } } });
  addTextBox(requests, nextId, closingSlideId, MARGIN, 160, PAGE_W - MARGIN * 2, 60, "Questions?", {
    fontSize: 26,
    bold: true,
    color: NAVY,
  });
  addTextBox(
    requests,
    nextId,
    closingSlideId,
    MARGIN,
    220,
    PAGE_W - MARGIN * 2,
    40,
    "Reach out to your project team for the full live tracker and further detail.",
    { fontSize: 14, color: MUTED }
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
