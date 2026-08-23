const DUBAI_OFFSET_MINUTES = 4 * 60;
const DUBAI_OFFSET_MS = DUBAI_OFFSET_MINUTES * 60_000;
const LOCAL_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function instant(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`not a valid instant: ${String(value)}`);
  }
  return date;
}

function shifted(value: string | Date): Date {
  return new Date(instant(value).getTime() + DUBAI_OFFSET_MS);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** YYYY-MM-DD in Asia/Dubai (UTC+4, no daylight saving). */
export function dubaiDayKey(value: string | Date): string {
  const date = shifted(value);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** HH:mm in Asia/Dubai. */
export function dubaiTime(value: string | Date): string {
  const date = shifted(value);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** Value for a datetime-local control, expressed in Asia/Dubai. */
export function isoToDubaiLocalInput(value: string | Date): string {
  return `${dubaiDayKey(value)}T${dubaiTime(value)}`;
}

/**
 * Convert a wall-clock time entered in Dubai to the UTC instant stored by
 * Paperclip. Dubai is permanently UTC+4 and does not observe DST.
 */
export function dubaiLocalToIso(value: string): string {
  const match = LOCAL_INPUT_RE.exec(value);
  if (!match) throw new Error("publish time must be a valid Dubai date and time");

  const [, y, mo, d, h, mi] = match;
  const parts = [y, mo, d, h, mi].map(Number);
  const [year, month, day, hour, minute] = parts;
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(localAsUtc);

  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    throw new Error("publish time must be a valid Dubai date and time");
  }

  return new Date(localAsUtc - DUBAI_OFFSET_MS).toISOString();
}

export function dubaiYear(value: string | Date): number {
  return shifted(value).getUTCFullYear();
}

/** Zero-based month in Asia/Dubai. */
export function dubaiMonth(value: string | Date): number {
  return shifted(value).getUTCMonth();
}
