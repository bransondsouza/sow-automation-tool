"use client";

import { useEffect, useMemo, useState } from "react";

interface CountryOption {
  code: string;
  name: string;
}

interface CountryPickerProps {
  value: string[];
  onChange: (codes: string[]) => void;
}

/**
 * Multi-select for "exclude the public holidays of these countries" — backs
 * the Baseline Date business-day math and the Plan Date weekend/holiday
 * warning on the generated tracker (see SHEETS_TRACKER.md). Leaving it
 * empty is a valid, common choice: the schedule still skips weekends, it
 * just won't know about any country's public holidays.
 */
export default function CountryPicker({ value, onChange }: CountryPickerProps) {
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/countries")
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled) setCountries(body.countries ?? []);
      })
      .catch(() => {
        if (!cancelled) setCountries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const nameByCode = useMemo(() => new Map(countries.map((c) => [c.code, c.name])), [countries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return countries;
    return countries.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
  }, [countries, query]);

  function toggle(code: string) {
    if (value.includes(code)) {
      onChange(value.filter((c) => c !== code));
    } else {
      onChange([...value, code]);
    }
  }

  function remove(code: string) {
    onChange(value.filter((c) => c !== code));
  }

  return (
    <div className="country-picker">
      {value.length > 0 && (
        <div className="country-picker-chips">
          {value.map((code) => (
            <span key={code} className="country-chip">
              {nameByCode.get(code) ?? code}
              <button type="button" onClick={() => remove(code)} aria-label={`Remove ${nameByCode.get(code) ?? code}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        type="text"
        placeholder="Search countries…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="country-picker-list">
        {loading ? (
          <p className="hint" style={{ margin: "8px 0" }}>
            Loading countries…
          </p>
        ) : filtered.length === 0 ? (
          <p className="hint" style={{ margin: "8px 0" }}>
            No countries match &ldquo;{query}&rdquo;.
          </p>
        ) : (
          filtered.map((c) => (
            <label key={c.code} className="country-picker-option">
              <input type="checkbox" checked={value.includes(c.code)} onChange={() => toggle(c.code)} />
              {c.name}
            </label>
          ))
        )}
      </div>
    </div>
  );
}
