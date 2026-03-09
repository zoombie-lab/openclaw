import { resolveTimezone } from "../infra/format-time/format-datetime.js";

export type ResolvedSearchTimeFilter = {
  fromTs?: number;
  toTs?: number;
};

const TIMESTAMP_SECONDS_TO_MS_MAX = 15_000_000_000;

export function normalizeTimestampMs(value: number): number {
  if (value > 0 && value < TIMESTAMP_SECONDS_TO_MS_MAX) {
    return Math.floor(value * 1000);
  }
  return Math.floor(value);
}

export function resolveSearchTimezone(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const resolved = resolveTimezone(trimmed);
  if (!resolved) {
    throw new Error("invalid memory_search timezone: expected valid IANA timezone");
  }
  return resolved;
}

export function resolveTimezoneOffsetMs(utcMs: number, timezone: string): number {
  const utcDate = new Date(utcMs);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(utcDate);
  const pick = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value ? Number(value) : NaN;
  };
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  const hour = pick("hour");
  const minute = pick("minute");
  const second = pick("second");
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    throw new Error("invalid memory_search timezone: failed to resolve timezone boundary");
  }
  const zonedAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const utcAsUtc = Date.UTC(
    utcDate.getUTCFullYear(),
    utcDate.getUTCMonth(),
    utcDate.getUTCDate(),
    utcDate.getUTCHours(),
    utcDate.getUTCMinutes(),
    utcDate.getUTCSeconds(),
    0,
  );
  return zonedAsUtc - utcAsUtc;
}

export function resolveZonedBoundaryMs(
  localDateTime: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
  },
  timezone: string,
): number {
  const utcGuess = Date.UTC(
    localDateTime.year,
    localDateTime.month - 1,
    localDateTime.day,
    localDateTime.hour,
    localDateTime.minute,
    localDateTime.second,
    localDateTime.millisecond,
  );
  let offset = resolveTimezoneOffsetMs(utcGuess, timezone);
  let resolved = utcGuess - offset;
  const refinedOffset = resolveTimezoneOffsetMs(resolved, timezone);
  if (refinedOffset !== offset) {
    offset = refinedOffset;
    resolved = utcGuess - offset;
  }
  return resolved;
}

function parseDateOnlySearchBoundary(
  dateOnly: string,
  boundary: "from" | "to",
  timezone?: string,
): number | undefined {
  if (!timezone) {
    const utcDateOnly =
      boundary === "to" ? `${dateOnly}T23:59:59.999Z` : `${dateOnly}T00:00:00.000Z`;
    const parsedUtcDateOnly = Date.parse(utcDateOnly);
    return Number.isFinite(parsedUtcDateOnly) ? parsedUtcDateOnly : undefined;
  }
  const [yearText, monthText, dayText] = dateOnly.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return undefined;
  }
  return resolveZonedBoundaryMs(
    {
      year,
      month,
      day,
      hour: boundary === "to" ? 23 : 0,
      minute: boundary === "to" ? 59 : 0,
      second: boundary === "to" ? 59 : 0,
      millisecond: boundary === "to" ? 999 : 0,
    },
    timezone,
  );
}

export function parseSearchTimeBoundary(
  value: unknown,
  boundary: "from" | "to",
  timezone?: string,
): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`invalid memory_search ${boundary}: expected positive timestamp`);
    }
    return normalizeTimestampMs(value);
  }
  if (typeof value !== "string") {
    throw new Error(`invalid memory_search ${boundary}: expected string or number`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new Error(`invalid memory_search ${boundary}: expected positive timestamp`);
    }
    return normalizeTimestampMs(numeric);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsedDateOnly = parseDateOnlySearchBoundary(trimmed, boundary, timezone);
    if (Number.isFinite(parsedDateOnly)) {
      return parsedDateOnly;
    }
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid memory_search ${boundary}: expected ISO datetime or timestamp`);
  }
  return Math.floor(parsed);
}

export function resolveSearchTimeFilter(opts?: {
  from?: unknown;
  to?: unknown;
  timezone?: string;
}): ResolvedSearchTimeFilter | null {
  const timezone = resolveSearchTimezone(opts?.timezone);
  const fromTs = parseSearchTimeBoundary(opts?.from, "from", timezone);
  const toTs = parseSearchTimeBoundary(opts?.to, "to", timezone);
  if (fromTs == null && toTs == null) {
    return null;
  }
  if (fromTs != null && toTs != null && fromTs > toTs) {
    throw new Error("invalid memory_search time filter: from must be <= to");
  }
  return {
    ...(fromTs != null ? { fromTs } : {}),
    ...(toTs != null ? { toTs } : {}),
  };
}
