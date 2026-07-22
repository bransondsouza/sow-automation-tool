import Holidays from "date-holidays";

// How far back/forward from "now" to precompute holidays for. Project Start
// Date isn't known yet at upload time (the PM fills it in on the Estimation
// tab afterward), so this window has to be generous enough to comfortably
// cover any realistic project timeline without ballooning the data we embed
// in the Apps Script.
const YEARS_BACK = 1;
const YEARS_FORWARD = 6;

// Only these holiday types count as a full non-working day for scheduling
// purposes — 'school', 'optional', and 'observance' entries (e.g. "Flag
// Day", regional school breaks) are informational, not days businesses
// actually close for.
const BUSINESS_CLOSED_TYPES = new Set(["public", "bank"]);

export interface CountryOption {
  code: string;
  name: string;
}

export interface HolidayEntry {
  country: string; // display name, e.g. "India"
  name: string; // holiday name, e.g. "Diwali"
}

// date -> every matching holiday across all requested countries (a date can
// be a holiday in more than one selected country, sometimes for different
// reasons — e.g. Jan 1 is New Year's Day nearly everywhere).
export type HolidayMap = Record<string, HolidayEntry[]>;

let countryCache: CountryOption[] | null = null;

/** Every country date-holidays ships data for, for the Upload form's picker. */
export function getSupportedCountries(): CountryOption[] {
  if (countryCache) return countryCache;
  const hd = new Holidays();
  const map = hd.getCountries("en"); // { code: displayName }
  countryCache = Object.entries(map)
    .map(([code, name]) => ({ code, name: String(name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return countryCache;
}

/** Filters/uppercases a user-supplied code list down to ones date-holidays actually supports. */
export function normalizeCountryCodes(codes: string[]): string[] {
  const supported = new Set(getSupportedCountries().map((c) => c.code));
  const seen = new Set<string>();
  const result: string[] = [];
  codes.forEach((raw) => {
    const code = raw.trim().toUpperCase();
    if (code && supported.has(code) && !seen.has(code)) {
      seen.add(code);
      result.push(code);
    }
  });
  return result;
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Builds a date -> holiday[] map for the given ISO country codes, covering
 * a multi-year window centered on today. Returns {} if no (valid) countries
 * are given — callers should treat that as "exclude weekends only."
 */
export function buildHolidayMap(countryCodes: string[]): HolidayMap {
  const codes = normalizeCountryCodes(countryCodes);
  const map: HolidayMap = {};
  if (codes.length === 0) return map;

  const countryNames = getSupportedCountries();
  const nameByCode = new Map(countryNames.map((c) => [c.code, c.name]));

  const currentYear = new Date().getFullYear();
  const years: number[] = [];
  for (let y = currentYear - YEARS_BACK; y <= currentYear + YEARS_FORWARD; y++) years.push(y);

  codes.forEach((code) => {
    const countryName = nameByCode.get(code) ?? code;
    const hd = new Holidays(code);
    years.forEach((year) => {
      const holidays = hd.getHolidays(year, "en") ?? [];
      holidays.forEach((h) => {
        if (!BUSINESS_CLOSED_TYPES.has(h.type)) return;
        // A multi-day holiday (rare, e.g. some regional festivals) spans
        // start..end — mark every calendar day it covers, not just the first.
        const cursor = new Date(h.start.getTime());
        const end = new Date(h.end.getTime());
        // Guard against a pathological multi-week "holiday" blowing up the
        // map — cap at 14 days, generous for anything real-world.
        let guard = 0;
        while (cursor.getTime() < end.getTime() && guard < 14) {
          const key = dateKey(cursor);
          (map[key] ??= []).push({ country: countryName, name: h.name });
          cursor.setDate(cursor.getDate() + 1);
          guard++;
        }
      });
    });
  });

  return map;
}
