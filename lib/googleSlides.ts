import { google } from "googleapis";
import { SOWData } from "./types";

function buildAuthClient(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return oauth2Client;
}

function bulletList(items: string[]): string {
  if (!items || items.length === 0) return "[None specified in SOW]";
  return items.map((item) => `•  ${item}`).join("\n");
}

function formatTimeline(data: SOWData): string {
  if (!data.timeline || data.timeline.length === 0) return "[Timeline not specified in SOW]";
  return data.timeline
    .map((t) => `•  ${t.milestone}: ${t.start} → ${t.end}${t.notes ? `  (${t.notes})` : ""}`)
    .join("\n");
}

function formatTeam(data: SOWData): string {
  const lines = [
    `Project Manager: ${data.stakeholders.projectManager}`,
    `Sponsor: ${data.stakeholders.sponsor}`,
  ];
  if (data.stakeholders.teamMembers?.length) {
    lines.push("Team:");
    data.stakeholders.teamMembers.forEach((m) => lines.push(`•  ${m}`));
  }
  return lines.join("\n");
}

function formatRisks(data: SOWData): string {
  if (!data.risks || data.risks.length === 0) return "[No risks identified in SOW]";
  return data.risks
    .map((r) => `•  [${r.impact}] ${r.risk} — Mitigation: ${r.mitigation}`)
    .join("\n");
}

function formatEscalation(data: SOWData): string {
  if (!data.escalationMatrix || data.escalationMatrix.length === 0) {
    return "[Escalation matrix not specified in SOW]";
  }
  return data.escalationMatrix
    .map((e) => `•  ${e.level} — ${e.contact} (${e.criteria})`)
    .join("\n");
}

/**
 * Maps every {{TOKEN}} used in the default template (see TEMPLATE_TOKENS.md)
 * to the real content extracted from the SOW.
 */
function buildTokenMap(data: SOWData): Record<string, string> {
  return {
    "{{PROJECT_NAME}}": data.projectName,
    "{{CLIENT_NAME}}": data.clientName,
    "{{PROJECT_OVERVIEW}}": data.overview,
    "{{INPUT_REQUIREMENTS}}": bulletList(data.inputRequirements),
    "{{DELIVERABLES}}": bulletList(data.deliverables),
    "{{TIMELINE}}": formatTimeline(data),
    "{{PROJECT_MANAGER}}": data.stakeholders.projectManager,
    "{{TEAM_STRUCTURE}}": formatTeam(data),
    "{{RISK_MATRIX}}": formatRisks(data),
    "{{GOVERNANCE_CADENCE}}": data.governance.meetingCadence,
    "{{COMMUNICATION_PROTOCOL}}": data.governance.communicationProtocol,
    "{{ESCALATION_MATRIX}}": formatEscalation(data),
    "{{CLOSING_MESSAGE}}": data.closingMessage,
  };
}

export interface GeneratedDeck {
  presentationId: string;
  url: string;
}

/**
 * Copies the given Slides template into the signed-in user's Drive and
 * replaces every {{TOKEN}} with real content from the parsed SOW. Because
 * this only copies + edits text runs (never flattens to images), the result
 * stays a normal, fully-editable Google Slides file.
 */
export async function generateSlideDeck(
  accessToken: string,
  templateId: string,
  data: SOWData
): Promise<GeneratedDeck> {
  const auth = buildAuthClient(accessToken);
  const drive = google.drive({ version: "v3", auth });
  const slides = google.slides({ version: "v1", auth });

  const copyResponse = await drive.files.copy({
    fileId: templateId,
    requestBody: {
      name: `${data.projectName} — Client Pitch Deck`,
    },
    fields: "id",
  });

  const presentationId = copyResponse.data.id;
  if (!presentationId) {
    throw new Error("Google Drive did not return a file ID when copying the template.");
  }

  const tokenMap = buildTokenMap(data);
  const requests = Object.entries(tokenMap).map(([token, value]) => ({
    replaceAllText: {
      containsText: { text: token, matchCase: true },
      replaceText: value && value.trim().length > 0 ? value : "[Not specified in SOW]",
    },
  }));

  await slides.presentations.batchUpdate({
    presentationId,
    requestBody: { requests },
  });

  return {
    presentationId,
    url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
  };
}

/**
 * Accepts either a raw Google file ID or a full Slides URL and returns the ID.
 */
export function extractFileId(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  const match = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : trimmed;
}
