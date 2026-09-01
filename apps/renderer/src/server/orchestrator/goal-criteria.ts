import "server-only";

/**
 * Parses the *trusted* criteria out of the user's own request (P03-R04
 * steps 1-2).
 *
 * The reproduced failure lost the user's dates: "available from sep 3 to 5"
 * became a generic Seattle landing page, and the answer then described
 * listings whose availability nobody had checked. Criteria the user stated
 * have to survive into the URL that is actually opened, or be reported as
 * unrepresented -- silently dropping them is the one outcome that is always
 * wrong.
 *
 * This module reads only the user's message. It never reads page content,
 * model output, or discovered URLs, all of which are untrusted and are
 * handled in `collection-url.ts`. It deliberately extracts nothing about
 * payment, authentication, identity, or private profile data -- only the
 * few fields a public collection page can encode in its query string.
 */

/** Inclusive lower and exclusive upper bound of a stay, as `YYYY-MM-DD`. */
export interface CriteriaDateRange {
  checkIn: string;
  checkOut: string;
}

export interface GoalCriteria {
  /** Best-effort place name, for model context only -- never used to synthesize a URL path. */
  location?: string;
  dates?: CriteriaDateRange;
  guests?: number;
  /** How many results the user asked to compare, when they said. */
  resultCount?: number;
  /** The user's own phrasing of the dates, preserved so the model can echo it back. */
  datesWording?: string;
  /**
   * Criteria the user stated that could not be resolved -- a reversed
   * range, an impossible date. Reported rather than guessed at.
   */
  unresolved: string[];
}

const MAX_STAY_NIGHTS = 365;
const MAX_GUESTS = 16;
const MAX_RESULT_COUNT = 50;
const MAX_LOCATION_CHARS = 60;
/** Enough to step over three non-leap years to reach the next 29 February. */
const MAX_YEAR_PROBES = 8;

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
});

const MONTH_ALTERNATION = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const RANGE_SEPARATOR = "(?:\\s*(?:to|until|through|thru|till|-|–|—)\\s*)";

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Calendar-valid check that rejects 31 February rather than rolling it over. */
function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day;
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * Resolves a bare month/day to its next valid occurrence at or after
 * `notBefore` (P03-R04 step 2). A 29 February with no year resolves to the
 * next leap year rather than to an invalid date or a silent 1 March.
 */
function resolveNextOccurrence(month: number, day: number, notBefore: number): number | null {
  const startYear = new Date(notBefore).getUTCFullYear();
  for (let offset = 0; offset < MAX_YEAR_PROBES; offset += 1) {
    const year = startYear + offset;
    if (!isRealDate(year, month, day)) continue;
    const candidate = Date.UTC(year, month, day);
    if (candidate >= notBefore) return candidate;
  }
  return null;
}

interface RawRange {
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
  wording: string;
}

function monthIndex(token: string): number | undefined {
  return MONTHS[token.toLowerCase()];
}

function findRawRange(text: string): RawRange | { isoRange: [string, string]; wording: string } | null {
  const isoMatch = text.match(
    new RegExp(`(\\d{4}-\\d{2}-\\d{2})${RANGE_SEPARATOR}(\\d{4}-\\d{2}-\\d{2})`, "iu"),
  );
  if (isoMatch) return { isoRange: [isoMatch[1]!, isoMatch[2]!], wording: isoMatch[0] };

  // "sep 3 to sep 5" / "september 3 - october 2"
  const bothMonths = text.match(
    new RegExp(`(${MONTH_ALTERNATION})\\.?\\s+(\\d{1,2})${RANGE_SEPARATOR}(${MONTH_ALTERNATION})\\.?\\s+(\\d{1,2})`, "iu"),
  );
  if (bothMonths) {
    const startMonth = monthIndex(bothMonths[1]!);
    const endMonth = monthIndex(bothMonths[3]!);
    if (startMonth !== undefined && endMonth !== undefined) {
      return {
        startMonth, startDay: Number(bothMonths[2]), endMonth, endDay: Number(bothMonths[4]),
        wording: bothMonths[0],
      };
    }
  }

  // "sep 3 to 5" -- the shape the reproduced prompt used.
  const sharedMonth = text.match(
    new RegExp(`(${MONTH_ALTERNATION})\\.?\\s+(\\d{1,2})${RANGE_SEPARATOR}(\\d{1,2})\\b`, "iu"),
  );
  if (sharedMonth) {
    const month = monthIndex(sharedMonth[1]!);
    if (month !== undefined) {
      return {
        startMonth: month, startDay: Number(sharedMonth[2]),
        endMonth: month, endDay: Number(sharedMonth[3]),
        wording: sharedMonth[0],
      };
    }
  }

  // "3 to 5 september"
  const trailingMonth = text.match(
    new RegExp(`(\\d{1,2})${RANGE_SEPARATOR}(\\d{1,2})\\s+(${MONTH_ALTERNATION})\\b`, "iu"),
  );
  if (trailingMonth) {
    const month = monthIndex(trailingMonth[3]!);
    if (month !== undefined) {
      return {
        startMonth: month, startDay: Number(trailingMonth[1]),
        endMonth: month, endDay: Number(trailingMonth[2]),
        wording: trailingMonth[0],
      };
    }
  }
  return null;
}

function resolveDates(text: string, now: Date): { dates?: CriteriaDateRange; wording?: string; unresolved?: string } {
  const raw = findRawRange(text);
  if (!raw) return {};
  const today = startOfUtcDay(now);

  if ("isoRange" in raw) {
    const [start, end] = raw.isoRange;
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const endMs = Date.parse(`${end}T00:00:00Z`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return { unresolved: "an unusable check-in/check-out range", wording: raw.wording };
    }
    if ((endMs - startMs) / 86_400_000 > MAX_STAY_NIGHTS) {
      return { unresolved: "an implausibly long stay", wording: raw.wording };
    }
    return { dates: { checkIn: start, checkOut: end }, wording: raw.wording };
  }

  const { startMonth, startDay, endMonth, endDay, wording } = raw;
  // Reversed inside one month is a mistake, not a year rollover.
  if (startMonth === endMonth && endDay <= startDay) {
    return { unresolved: "a reversed check-in/check-out range", wording };
  }
  const checkInMs = resolveNextOccurrence(startMonth, startDay, today);
  if (checkInMs === null) return { unresolved: "an impossible check-in date", wording };
  // Resolved from the check-in, so "dec 30 to jan 2" rolls the year forward.
  const checkOutMs = resolveNextOccurrence(endMonth, endDay, checkInMs + 86_400_000);
  if (checkOutMs === null) return { unresolved: "an impossible check-out date", wording };
  if ((checkOutMs - checkInMs) / 86_400_000 > MAX_STAY_NIGHTS) {
    return { unresolved: "an implausibly long stay", wording };
  }
  const checkIn = new Date(checkInMs);
  const checkOut = new Date(checkOutMs);
  return {
    dates: {
      checkIn: iso(checkIn.getUTCFullYear(), checkIn.getUTCMonth(), checkIn.getUTCDate()),
      checkOut: iso(checkOut.getUTCFullYear(), checkOut.getUTCMonth(), checkOut.getUTCDate()),
    },
    wording,
  };
}

function resolveGuests(text: string): number | undefined {
  const match = text.match(/\b(\d{1,2})\s+(?:guests?|adults?|people|persons?|travell?ers?)\b/iu)
    ?? text.match(/\b(?:for|party of)\s+(\d{1,2})\b/iu);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 1 && value <= MAX_GUESTS ? value : undefined;
}

function resolveResultCount(text: string): number | undefined {
  const match = text.match(
    /\b(\d{1,2})\s+(?:\S+\s+){0,2}?(?:listings?|results?|options?|places?|stays?|hotels?|properties|rentals?)\b/iu,
  );
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 1 && value <= MAX_RESULT_COUNT ? value : undefined;
}

const LOCATION_STOPWORDS = new Set(["the", "a", "an", "that", "which", "and", "for", "with", "from"]);

function resolveLocation(text: string): string | undefined {
  const match = text.match(/\b(?:in|near|around|at|from)\s+([A-Za-z][A-Za-z'’.-]*(?:\s+[A-Za-z][A-Za-z'’.-]*){0,2})/u);
  if (!match) return undefined;
  const words = match[1]!.split(/\s+/u).filter((word) => !LOCATION_STOPWORDS.has(word.toLowerCase()));
  // Stop at the first date word, so "in seattle that's available from sep" keeps only the place.
  const cleaned: string[] = [];
  for (const word of words) {
    if (monthIndex(word.replace(/\.$/u, "")) !== undefined) break;
    cleaned.push(word);
  }
  const location = cleaned.join(" ").trim().slice(0, MAX_LOCATION_CHARS);
  return location.length > 1 ? location : undefined;
}

/**
 * Extracts the collection-page criteria from one user request.
 *
 * `now` is injected so date resolution is deterministic and testable; the
 * orchestrator passes the real clock it already trusts.
 */
export function parseGoalCriteria(text: string, now: Date = new Date()): GoalCriteria {
  const bounded = text.slice(0, 4_000);
  const { dates, wording, unresolved } = resolveDates(bounded, now);
  return {
    ...(resolveLocation(bounded) ? { location: resolveLocation(bounded) } : {}),
    ...(dates ? { dates } : {}),
    ...(resolveGuests(bounded) !== undefined ? { guests: resolveGuests(bounded) } : {}),
    ...(resolveResultCount(bounded) !== undefined ? { resultCount: resolveResultCount(bounded) } : {}),
    ...(wording ? { datesWording: wording } : {}),
    unresolved: unresolved ? [unresolved] : [],
  };
}
