/**
 * The site's "Sledované údaje": body measurements the user keeps besides
 * weight (waist, hips, body fat %, ...). A *tracker* is one measured quantity;
 * its *values* are the dated measurements.
 */

import { KtError, isRecord, parseCzechNumber, pragueDate } from './util.js';

export interface TrackType {
  /** The site's id for this kind of measurement. */
  id: string;
  /** "Obvod pasu". */
  name: string;
  /** "cm", "%". */
  unit: string | null;
}

export interface TrackedValue {
  id: string;
  /** dd.MM.yyyy */
  date: string;
  value: number;
}

export interface Tracker {
  id: string;
  name: string;
  unit: string | null;
  /** Measurements inside the requested period, oldest first. */
  values: TrackedValue[];
}

/** "Obvod pasu [cm]" → name and unit. */
export function splitTitle(title: string): { name: string; unit: string | null } {
  const m = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(title);
  return m ? { name: m[1]!.trim(), unit: m[2]!.trim() } : { name: title.trim(), unit: null };
}

const ID = /^[0-9a-f]{32}$/;

/** Ids end up in URL paths, so accept nothing but the site's 32-character hex ids. */
export function assertTrackId(id: string, what: string): string {
  if (!ID.test(id)) throw new KtError(`Invalid ${what} "${id}" — use one from list_tracked_measurements`);
  return id;
}

export function parseTrackTypes(data: unknown): TrackType[] {
  if (!isRecord(data) || !Array.isArray(data['typeOptions'])) throw new KtError('tracked measurements: the form has no list of kinds');
  return (data['typeOptions'] as unknown[]).map(raw => {
    if (!isRecord(raw) || typeof raw['guid'] !== 'string' || typeof raw['title'] !== 'string') {
      throw new KtError('tracked measurements: a kind has no id or title');
    }
    return { id: raw['guid'], ...splitTitle(raw['title']) };
  });
}

export function parseTrackers(data: unknown): Tracker[] {
  if (!Array.isArray(data)) throw new KtError('tracked measurements: expected a list');
  return (data as unknown[]).map(raw => {
    if (!isRecord(raw) || typeof raw['guid'] !== 'string' || typeof raw['type'] !== 'string') {
      throw new KtError('tracked measurements: a tracker has no id or name');
    }
    if (!Array.isArray(raw['values'])) throw new KtError(`tracked measurements: "${raw['type']}" has no value list`);
    const { name, unit } = splitTitle(raw['type']);
    const values = (raw['values'] as unknown[]).map(v => {
      const value = isRecord(v) ? parseCzechNumber(v['value']) : null;
      if (!isRecord(v) || typeof v['guid'] !== 'string' || typeof v['from'] !== 'number' || value === null) {
        throw new KtError(`tracked measurements: a value of "${name}" is unreadable`);
      }
      return { id: v['guid'], date: pragueDate(new Date(v['from'])), value, epoch: v['from'] };
    });
    values.sort((a, b) => a.epoch - b.epoch);
    return {
      id: raw['guid'],
      name,
      unit: unit ?? (typeof raw['unit'] === 'string' ? raw['unit'] : null),
      values: values.map(({ id, date, value }) => ({ id, date, value })),
    };
  });
}

/** Lower-case without diacritics, so "pas" finds "Obvod pasu" and "stehna" finds "Obvod stehna". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** The items an id or a (part of a) name refers to: an exact match when there is exactly one, otherwise every partial match. */
export function matchByName<T extends { id: string; name: string }>(items: T[], query: string): T[] {
  const q = fold(query.trim());
  if (q === '') return [];
  const exact = items.filter(i => i.id === query.trim() || fold(i.name) === q);
  if (exact.length === 1) return exact;
  return items.filter(i => fold(i.name).includes(q));
}

/** Like matchByName, but throws unless exactly one item matches. */
export function pickByName<T extends { id: string; name: string }>(items: T[], query: string, what: string): T {
  if (query.trim() === '') throw new KtError(`Name the ${what}`);
  const found = matchByName(items, query);
  if (found.length === 1) return found[0]!;
  throw new KtError(
    found.length > 1
      ? `"${query}" matches several ${what}s: ${found.map(i => i.name).join(', ')}`
      : `No ${what} matches "${query}". Available: ${items.map(i => i.name).join(', ')}`,
  );
}
