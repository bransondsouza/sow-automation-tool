import Anthropic from "@anthropic-ai/sdk";
import { SOWData } from "./types";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

const EXTRACTION_PROMPT = `You are acting as an experienced project management
consultant helping a professional services company turn a Statement of Work
(SOW) into structured data for an automated project setup tool. Read the SOW
text below and produce the fields listed. They fall into two different modes
of work — follow each mode exactly:

── EXTRACT (pull directly from the SOW; never invent facts) ──
projectName, clientName, overview, inputRequirements, deliverables, timeline,
stakeholders. If a name genuinely isn't in the SOW, use a bracketed
placeholder in this style: "[Insert Project Manager]", "[Insert Sponsor]",
"[Insert Start Date]".

── ANALYZE (you must apply professional PM judgment — do not just copy a
sentence from the SOW, and never leave these as "not specified") ──

risks — Identify the TOP 5 risks most likely to affect THIS specific project.
Base your analysis on its scope, timeline length, deliverable complexity,
industry/domain, and any risk language already in the SOW. Draw on standard
PM risk categories: scope creep, schedule/timeline compression, resource or
staffing availability, technical/integration complexity, stakeholder
alignment & communication, third-party/vendor dependency, budget/financial
exposure, and quality/compliance. Return EXACTLY 5 items, ordered from most
to least severe (combined likelihood × impact), each with a specific,
actionable mitigation — not a generic platitude like "monitor closely."

governance — Propose a meeting cadence and communication protocol that fits
this project's scale, following standard PMI-aligned practice: shorter or
smaller-scope engagements get a lighter cadence (e.g. "Weekly status email;
bi-weekly check-in call"), longer or multi-deliverable engagements get more
formal governance (e.g. "Weekly status call; bi-weekly steering committee;
monthly executive business review"). If the SOW already specifies its own
cadence or communication process, use that instead of inventing one.

escalationMatrix — Generate a standard escalation matrix (normally 3 tiers)
using the stakeholder placeholders you identified above:
  Level 1 — Project Manager: day-to-day issues, target resolution 24-48 hours.
  Level 2 — Sponsor / Account Director: issues affecting scope, timeline, or
    budget, target resolution 3-5 business days.
  Level 3 — Executive Sponsor: contractual, relationship-critical, or
    unresolved Level 2 issues.
If the SOW defines its own escalation path, follow that structure instead
(2-4 levels), but still present it as a clear matrix.

── Output rules ──
- Return ONLY a single valid JSON object. No markdown, no commentary, no code fences.
- Keep list items concise (one sentence or short phrase each).
- "impact" in risks must be one of: "Low", "Medium", "High".

Return JSON matching exactly this shape:
{
  "projectName": string,
  "clientName": string,
  "overview": string,                     // 2-4 sentence summary of the engagement
  "inputRequirements": string[],           // what the client must provide
  "deliverables": string[],                // what will be produced/delivered
  "timeline": [
    { "milestone": string, "start": string, "end": string, "notes": string }
  ],
  "stakeholders": {
    "projectManager": string,
    "sponsor": string,
    "teamMembers": string[]
  },
  "risks": [
    { "risk": string, "impact": "Low" | "Medium" | "High", "mitigation": string }
  ],                                       // exactly 5 items, most severe first
  "governance": {
    "meetingCadence": string,
    "communicationProtocol": string
  },
  "escalationMatrix": [
    { "level": string, "contact": string, "criteria": string }
  ],
  "closingMessage": string                 // one warm, professional closing line for the deck
}

SOW TEXT:
"""
{{SOW_TEXT}}
"""`;

export async function extractSOWData(sowText: string): Promise<SOWData> {
  // Very long SOWs are truncated to keep the request well within context
  // limits; 60k characters is generous for typical SOWs (40-60 pages).
  const trimmedText = sowText.slice(0, 60000);
  const prompt = EXTRACTION_PROMPT.replace("{{SOW_TEXT}}", trimmedText);

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = message.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return a text response.");
  }

  const raw = textBlock.text.trim();
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error("Claude's response did not contain JSON. Try again or simplify the SOW.");
  }

  const jsonString = raw.slice(jsonStart, jsonEnd + 1);

  let parsed: SOWData;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new Error("Couldn't parse the structured data Claude returned. Please try again.");
  }

  validateSOWData(parsed);

  // Safety net: enforce "top 5" even if the model returns a different count.
  if (Array.isArray(parsed.risks) && parsed.risks.length > 5) {
    parsed.risks = parsed.risks.slice(0, 5);
  }

  return parsed;
}

function validateSOWData(data: Partial<SOWData>): asserts data is SOWData {
  const required: (keyof SOWData)[] = [
    "projectName",
    "clientName",
    "overview",
    "inputRequirements",
    "deliverables",
    "timeline",
    "stakeholders",
    "risks",
    "governance",
    "escalationMatrix",
    "closingMessage",
  ];
  const missing = required.filter((key) => data[key] === undefined || data[key] === null);
  if (missing.length > 0) {
    throw new Error(`Extracted data is missing required fields: ${missing.join(", ")}`);
  }
}
