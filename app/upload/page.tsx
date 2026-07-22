"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import CountryPicker from "./CountryPicker";

export default function UploadPage() {
  const { data: session } = useSession();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [teamRoster, setTeamRoster] = useState("");
  const [buHeadName, setBuHeadName] = useState("");
  const [buHeadEmail, setBuHeadEmail] = useState("");
  const [businessCountries, setBusinessCountries] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!file) {
      setError("Please choose a PDF or Word (.docx) file.");
      return;
    }
    if (buHeadEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buHeadEmail.trim())) {
      setError("Business Unit Head email doesn't look valid.");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    if (templateId.trim()) formData.append("templateId", templateId.trim());
    if (teamRoster.trim()) formData.append("teamRoster", teamRoster.trim());
    if (buHeadName.trim()) formData.append("buHeadName", buHeadName.trim());
    if (buHeadEmail.trim()) formData.append("buHeadEmail", buHeadEmail.trim());
    if (businessCountries.length > 0) formData.append("businessCountries", businessCountries.join(","));

    setSubmitting(true);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const body = await res.json();

      if (!res.ok) {
        throw new Error(body.error || "Something went wrong starting the job.");
      }

      router.push(`/status/${body.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error.");
      setSubmitting(false);
    }
  }

  return (
    <main>
      <div className="top-nav">
        <span>Signed in as {session?.user?.email}</span>
        <span style={{ display: "flex", gap: 16 }}>
          <Link href="/dashboard">Dashboard →</Link>
          <Link href="/drive-folders">Create Drive folders →</Link>
        </span>
      </div>
      <div className="card">
        <h1>Upload a Statement of Work</h1>
        <p className="subtitle">
          We'll read the document, extract the key project details, and build
          your client pitch deck automatically.
        </p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="file">SOW file (PDF or .docx)</label>
          <input
            id="file"
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />

          <label htmlFor="templateId">
            Google Slides template link (optional)
          </label>
          <input
            id="templateId"
            type="text"
            placeholder="Paste a Slides link, or leave blank to use the default template"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
          />
          <p className="hint">
            The template must contain the same {"{{TOKEN}}"} placeholders as
            the default template — see TEMPLATE_TOKENS.md in the project repo.
          </p>

          <label htmlFor="teamRoster">Team roster (optional)</label>
          <textarea
            id="teamRoster"
            rows={3}
            placeholder="One name per line, or comma-separated — e.g. Priya Shah, Marcus Lee, Dana Ortiz"
            value={teamRoster}
            onChange={(e) => setTeamRoster(e.target.value)}
            style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, fontSize: 14, fontFamily: "inherit" }}
          />
          <p className="hint">
            Seeds the "Stakeholder / Owner" dropdown on the tracker sheet.
            You (or the project manager) can add or edit names directly in
            the sheet's hidden "Lists" tab at any time afterward.
          </p>

          <label htmlFor="buHeadName">Business Unit Head (optional)</label>
          <input
            id="buHeadName"
            type="text"
            placeholder="Name, e.g. Dana Ortiz"
            value={buHeadName}
            onChange={(e) => setBuHeadName(e.target.value)}
          />
          <input
            id="buHeadEmail"
            type="email"
            placeholder="Email, e.g. dana.ortiz@company.com"
            value={buHeadEmail}
            onChange={(e) => setBuHeadEmail(e.target.value)}
            style={{ marginTop: 8 }}
          />
          <p className="hint">
            The tracker gets automatically shared with this email, and this
            project shows up under their name on the multi-project dashboard.
          </p>

          <label htmlFor="businessCountries">Exclude holidays of these countries (optional)</label>
          <CountryPicker value={businessCountries} onChange={setBusinessCountries} />
          <p className="hint">
            The tracker's Baseline Date schedule skips weekends automatically.
            Pick one or more countries here and it skips their public
            holidays too — and typing a Plan Date that lands on a weekend or
            one of those holidays will ask you to confirm before keeping it.
            Leave this blank to skip weekends only.
          </p>

          <button type="submit" disabled={submitting}>
            {submitting ? "Starting…" : "Generate Pitch Deck + Tracker"}
          </button>
        </form>

        {error && <div className="error-box">{error}</div>}
      </div>
    </main>
  );
}
