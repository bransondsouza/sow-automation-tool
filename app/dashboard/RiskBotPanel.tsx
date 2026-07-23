"use client";

import { useState } from "react";
import type { ProjectSnapshot } from "@/lib/dashboardData";

interface ChatTurn {
  role: "user" | "bot";
  text: string;
}

// A per-project chat panel backed by Gemini (lib/gemini.ts /
// /api/dashboard/risk-bot) — grounded in that project's live status on
// every call. Opens with a proactive risk analysis, then supports
// free-form follow-up questions about this project or PM best practices
// generally. See DASHBOARD.md.
export default function RiskBotPanel({ project }: { project: ProjectSnapshot }) {
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overdueCount = project.kpis.overdueTaskCount;

  async function callBot(message: string, history: ChatTurn[], initial: boolean): Promise<string> {
    const res = await fetch("/api/dashboard/risk-bot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sheetLink: project.sheetUrl, message, history, initial }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "The risk assistant couldn't respond.");
    return body.reply as string;
  }

  async function handleToggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (started) return;
    setStarted(true);
    setLoading(true);
    setError(null);
    try {
      const reply = await callBot("", [], true);
      setMessages([{ role: "bot", text: reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error starting the risk assistant.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const historyForRequest = messages;
    setInput("");
    setError(null);
    setMessages((m) => [...m, { role: "user", text }]);
    setLoading(true);
    try {
      const reply = await callBot(text, historyForRequest, false);
      setMessages((m) => [...m, { role: "bot", text: reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error messaging the risk assistant.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="risk-bot">
      <button type="button" className="risk-bot-toggle" onClick={handleToggle}>
        <span aria-hidden="true">🤖</span> Risk Assistant
        {overdueCount > 0 && (
          <span className="risk-bot-badge" title={`${overdueCount} overdue task${overdueCount === 1 ? "" : "s"}`}>
            {overdueCount}
          </span>
        )}
      </button>

      {open && (
        <div className="risk-bot-panel">
          <div className="risk-bot-panel-header">
            <div>
              <strong>Risk Assistant</strong>
              <p className="hint" style={{ margin: "2px 0 0" }}>
                Grounded in this project&rsquo;s live status. Ask about specific risks, or general PM best
                practices.
              </p>
            </div>
            <button type="button" className="risk-bot-close" onClick={() => setOpen(false)} aria-label="Close risk assistant">
              ×
            </button>
          </div>

          <div className="risk-bot-messages">
            {messages.length === 0 && loading && <p className="hint" style={{ padding: "0 16px" }}>Analyzing current project risks…</p>}
            {messages.map((m, i) => (
              <div key={i} className={`risk-bot-message risk-bot-message-${m.role}`}>
                {m.text}
              </div>
            ))}
            {loading && messages.length > 0 && (
              <div className="risk-bot-message risk-bot-message-bot risk-bot-typing">Thinking…</div>
            )}
          </div>

          {error && (
            <div className="error-box" style={{ margin: "0 16px 12px" }}>
              {error}
            </div>
          )}

          <form onSubmit={handleSend} className="risk-bot-input-row">
            <input
              type="text"
              placeholder="Ask about a risk, or PM best practices…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={loading}
            />
            <button type="submit" disabled={loading || !input.trim()} style={{ marginTop: 0 }}>
              Send
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
