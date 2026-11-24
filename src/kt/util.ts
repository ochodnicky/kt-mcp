/** Small shared pieces with no dependencies, so any module can use them without import cycles. */

export class KtError extends Error {}

/**
 * Login failed, or the session could not be (re)established. Callers that loop
 * over many requests abort on this instead of retrying the login every time.
 */
export class KtAuthError extends KtError {}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Czech number formatting: decimal comma, thin/regular space as the thousands
 * separator ("1 043", "20,43"). Returns null for absent or unparseable values
 * rather than a misleading 0.
 */
export function parseCzechNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalised = value.replace(/[\s  ]/g, '').replace(',', '.');
  if (normalised === '') return null;
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}

/** dd.MM.yyyy shifted by whole days, on the calendar (no time-zone effects). */
export function shiftDate(date: string, days: number): string {
  const [dd, mm, yyyy] = date.split('.').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(yyyy, mm - 1, dd + days));
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}
