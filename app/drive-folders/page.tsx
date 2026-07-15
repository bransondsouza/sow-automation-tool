"use client";

import { useState } from "react";
import Link from "next/link";

interface CreatedFolder {
  id: string;
  name: string;
  url: string;
}

export default function DriveFoldersPage() {
  const [parentFolder, setParentFolder] = useState("");
  const [folderNamesText, setFolderNamesText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedFolder[] | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);

    const folderNames = folderNamesText
      .split("\n")
      .map((n) => n.trim())
      .filter((n) => n.length > 0);

    if (!parentFolder.trim() || folderNames.length === 0) {
      setError("Please provide a parent folder link and at least one folder name.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/drive-folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentFolder, folderNames }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not create folders.");
      setCreated(body.folders);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <div className="top-nav">
        <Link href="/upload">← Back to Upload</Link>
      </div>
      <div className="card">
        <h1>Create Drive Folders</h1>
        <p className="subtitle">
          Paste a parent folder link and a list of folder names — each one
          gets created as a new subfolder inside it, in one step.
        </p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="parentFolder">Parent Drive folder link</label>
          <input
            id="parentFolder"
            type="text"
            placeholder="https://drive.google.com/drive/folders/..."
            value={parentFolder}
            onChange={(e) => setParentFolder(e.target.value)}
          />

          <label htmlFor="folderNames">Folder names (one per line)</label>
          <textarea
            id="folderNames"
            rows={6}
            placeholder={"01 - Contracts\n02 - Working Files\n03 - Client Deliverables\n04 - Meeting Notes"}
            value={folderNamesText}
            onChange={(e) => setFolderNamesText(e.target.value)}
            style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, fontSize: 14, fontFamily: "inherit" }}
          />

          <button type="submit" disabled={submitting}>
            {submitting ? "Creating…" : "Create Folders"}
          </button>
        </form>

        {error && <div className="error-box">{error}</div>}

        {created && created.length > 0 && (
          <div className="success-box">
            <p>
              <strong>{created.length} folder{created.length === 1 ? "" : "s"} created:</strong>
            </p>
            {created.map((f) => (
              <div key={f.id} style={{ marginTop: 8 }}>
                <a href={f.url} target="_blank" rel="noreferrer">
                  {f.name} →
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
