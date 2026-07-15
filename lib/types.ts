// Shared shapes used across the app. Keeping them in one file means the
// Claude prompt, the Slides generator, and the database all agree on the
// same structure.

export interface TimelineItem {
  milestone: string;
  start: string; // free-text or ISO date if the SOW gives one
  end: string;
  notes?: string;
}

export interface RiskItem {
  risk: string;
  impact: "Low" | "Medium" | "High" | string;
  mitigation: string;
}

export interface EscalationLevel {
  level: string; // e.g. "Level 1", "Level 2"
  contact: string; // e.g. "[Insert Account Manager]"
  criteria: string; // when to escalate to this level
}

export interface SOWData {
  projectName: string;
  clientName: string;
  overview: string;

  inputRequirements: string[];
  deliverables: string[];
  timeline: TimelineItem[];

  stakeholders: {
    projectManager: string; // placeholder if not named, e.g. "[Insert Project Manager]"
    sponsor: string;
    teamMembers: string[];
  };

  risks: RiskItem[];

  governance: {
    meetingCadence: string;
    communicationProtocol: string;
  };

  escalationMatrix: EscalationLevel[];

  closingMessage: string;
}

export type JobStatus =
  | "extracting"
  | "parsing"
  | "generating_slides"
  | "generating_sheet"
  | "finalizing"
  | "complete"
  | "error";

export interface Job {
  id: string;
  user_email: string;
  status: JobStatus;
  original_filename: string;
  template_id: string | null;
  sow_data: SOWData | null;
  slides_url: string | null;
  sheet_url: string | null;
  sheet_id: string | null;
  bu_head_name: string | null;
  bu_head_email: string | null;
  script_error: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}
