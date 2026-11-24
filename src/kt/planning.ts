/**
 * Parsers for the site's recurring and saved things: favourite activities,
 * regular (weekly) activities and saved day templates ("Moje jídelníčky").
 */

import { KtError, isRecord, parseCzechNumber } from './util.js';

const HEX32 = /^[0-9a-f]{32}$/;

/** Ids end up in URL paths, so accept nothing but the site's 32-character hex ids. */
export function assertHexId(id: string, what: string, hint: string): string {
  if (!HEX32.test(id)) throw new KtError(`Invalid ${what} "${id}" — ${hint}`);
  return id;
}

// ---------------------------------------------------------------------------
// Favourite activities
// ---------------------------------------------------------------------------

export interface FavoriteActivity {
  /** The id search_activity returns, so it works with log_activity. */
  id: string;
  title: string;
  category: string | null;
  /** kcal per kg of body weight per minute, the catalogue's own figure. */
  kcalPerKgPerMinute: number | null;
  /** kcal per minute for the user's current weight, as the site computes it. */
  kcalPerMinute: number | null;
}

export function parseFavoriteActivities(data: unknown): FavoriteActivity[] {
  if (!Array.isArray(data)) throw new KtError('favourite activities: expected a list');
  return (data as unknown[]).map(row => {
    if (!isRecord(row) || typeof row['id'] !== 'string' || typeof row['title'] !== 'string') {
      throw new KtError('favourite activities: unreadable entry');
    }
    return {
      id: row['id'],
      title: row['title'],
      category: typeof row['category'] === 'string' ? row['category'] : null,
      kcalPerKgPerMinute: parseCzechNumber(row['energy']),
      kcalPerMinute: parseCzechNumber(row['energyForUser']),
    };
  });
}

// ---------------------------------------------------------------------------
// Regular (weekly) activities
// ---------------------------------------------------------------------------

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** The site numbers the days the American way: Sunday is 1. */
export const WEEKDAY_CODES: Record<Weekday, number> = { monday: 2, tuesday: 3, wednesday: 4, thursday: 5, friday: 6, saturday: 7, sunday: 1 };

export interface RegularActivity {
  /** One id per weekday: deleting it removes that weekday only. */
  id: string;
  weekday: Weekday;
  title: string;
  /** The catalogue activity it was made from (for log_activity); null for a custom one. */
  activityId: string | null;
  minutes: number | null;
  energy: number | null;
  energyUnit: string;
}

export function parseRegularActivities(data: unknown): RegularActivity[] {
  if (!isRecord(data)) throw new KtError('regular activities: expected an object');
  const out: RegularActivity[] = [];
  for (const weekday of WEEKDAYS) {
    const list = data[weekday];
    if (!Array.isArray(list)) throw new KtError(`regular activities: no list for ${weekday}`);
    for (const row of list as unknown[]) {
      if (!isRecord(row) || typeof row['id'] !== 'string' || typeof row['title'] !== 'string') {
        throw new KtError(`regular activities: unreadable entry on ${weekday}`);
      }
      const time = parseCzechNumber(row['time']);
      const unit = row['timeUnit'];
      out.push({
        id: row['id'],
        weekday,
        title: row['title'],
        activityId: typeof row['guidActivity'] === 'string' ? row['guidActivity'] : null,
        minutes: time === null ? null : unit === 'hrs' ? Math.round(time * 60) : unit === 'min' ? Math.round(time) : null,
        energy: parseCzechNumber(row['energy']),
        energyUnit: typeof row['energyUnit'] === 'string' ? row['energyUnit'] : 'kcal',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Day templates
// ---------------------------------------------------------------------------

export interface DayTemplate {
  id: string;
  title: string;
}

export function parseTemplateList(data: unknown): DayTemplate[] {
  if (!Array.isArray(data)) throw new KtError('day templates: expected a list');
  return (data as unknown[]).map(row => {
    if (!isRecord(row) || typeof row['id'] !== 'string' || typeof row['title'] !== 'string') throw new KtError('day templates: unreadable entry');
    return { id: row['id'], title: row['title'] };
  });
}

export interface TemplateContents {
  id: string;
  title: string;
  meals: Array<{ meal: string; items: Array<{ title: string; amount: string | null; kind: 'food' | 'recipe' }> }>;
  notes: string[];
  /** The site's own count, to compare with what a write added. */
  foodCount: number;
}

export function parseTemplateContents(data: unknown): TemplateContents {
  if (!isRecord(data) || typeof data['id'] !== 'string' || typeof data['title'] !== 'string') throw new KtError('day template: unknown template');
  if (!Array.isArray(data['times'])) throw new KtError('day template: response has no meal list');
  let foodCount = 0;
  const meals = (data['times'] as unknown[]).flatMap(slot => {
    if (!isRecord(slot) || typeof slot['title'] !== 'string' || !Array.isArray(slot['foodstuff'])) throw new KtError('day template: a meal is malformed');
    const items = (slot['foodstuff'] as unknown[]).map(f => {
      if (!isRecord(f) || typeof f['title'] !== 'string') throw new KtError('day template: a line has no title');
      foodCount += 1;
      return {
        title: f['title'],
        amount: typeof f['unitSimple'] === 'string' ? f['unitSimple'] : null,
        kind: (typeof f['userMealGuid'] === 'string' ? 'recipe' : 'food') as 'food' | 'recipe',
      };
    });
    return items.length === 0 ? [] : [{ meal: slot['title'], items }];
  });
  const notes = Array.isArray(data['notes']) ? (data['notes'] as unknown[]).flatMap(n => (isRecord(n) && typeof n['text'] === 'string' ? [n['text']] : [])) : [];
  return { id: data['id'], title: data['title'], meals, notes, foodCount };
}
