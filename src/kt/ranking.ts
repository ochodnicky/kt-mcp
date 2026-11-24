/**
 * Ranks foods by how much of one nutrient they supplied over a set of days.
 *
 * Done here rather than by the model because it is arithmetic over dozens of
 * lines, where a language model slips. Unknown values (null) are never turned
 * into zeros: a food whose figures are all unknown is listed apart, and a
 * food with some unknown lines is flagged, since its total is then a minimum.
 */

import { KtError, type DayOutcome, type DiaryEntry } from './client.js';

export const RANKABLE_NUTRIENTS = [
  'energy',
  'protein',
  'carbohydrate',
  'fat',
  'fibre',
  'sugar',
  'saturatedFat',
  'salt',
  'alcohol',
  'transFat',
  'cholesterol',
  'sodium',
  'calcium',
] as const;
export type RankableNutrient = (typeof RANKABLE_NUTRIENTS)[number];

export interface RankedFood {
  title: string;
  kind: 'food' | 'recipe';
  /** Sum of the known values across all its lines. A minimum when `unknownLines` > 0. */
  total: number;
  /** Lines that contributed to `total`. */
  lines: number;
  /** Lines of this food whose value is unknown and therefore missing from `total`. */
  unknownLines: number;
  /** Distinct days it was eaten on. */
  days: number;
  /** Summed logged quantity; null when any line's quantity is unknown or the units differ. */
  quantityTotal: number | null;
  quantityUnit: 'g' | 'ml' | null;
}

export interface UnknownFood {
  title: string;
  kind: 'food' | 'recipe';
  lines: number;
}

export interface NutrientRanking {
  nutrient: RankableNutrient;
  unit: string;
  ranking: RankedFood[];
  /** Foods beyond `limit` that were cut from `ranking`. */
  omittedFoods: number;
  /** Foods with no known value at all for this nutrient. */
  unknown: UnknownFood[];
  /** Sum over every food with a known value, including the omitted ones; null when no value was known at all. */
  grandTotal: number | null;
  counts: { filled: number; empty: number; error: number };
  failedDates: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Entries hold grams; these three are reported in milligrams, as the site shows them. */
const MILLIGRAM_NUTRIENTS: ReadonlySet<RankableNutrient> = new Set(['cholesterol', 'sodium', 'calcium']);

function valueOf(entry: DiaryEntry, nutrient: RankableNutrient): number | null {
  if (nutrient === 'energy') return entry.energy;
  const grams = entry.nutrients[nutrient];
  return grams !== null && MILLIGRAM_NUTRIENTS.has(nutrient) ? grams * 1000 : grams;
}

export function rankNutrient(outcomes: DayOutcome[], nutrient: RankableNutrient, limit: number): NutrientRanking {
  interface Group {
    title: string;
    kind: 'food' | 'recipe';
    total: number;
    lines: number;
    unknownLines: number;
    days: Set<string>;
    qty: number;
    qtyUnit: 'g' | 'ml' | null;
    qtyKnown: boolean;
  }
  const groups = new Map<string, Group>();
  const counts = { filled: 0, empty: 0, error: 0 };
  const failedDates: string[] = [];
  let unit: string | null = null;

  for (const outcome of outcomes) {
    counts[outcome.status] += 1;
    if (outcome.status === 'error') {
      failedDates.push(outcome.date);
      continue;
    }
    for (const meal of outcome.day.meals) {
      for (const entry of meal.entries) {
        if (nutrient === 'energy') {
          if (unit !== null && unit !== entry.energyUnit) {
            throw new KtError(`Entries use different energy units (${unit} and ${entry.energyUnit}); cannot add them up`);
          }
          unit = entry.energyUnit;
        }
        const key = `${entry.kind}|${entry.title.normalize('NFC').trim().toLowerCase()}`;
        let g = groups.get(key);
        if (!g) {
          g = { title: entry.title, kind: entry.kind, total: 0, lines: 0, unknownLines: 0, days: new Set(), qty: 0, qtyUnit: null, qtyKnown: true };
          groups.set(key, g);
        }
        g.days.add(outcome.date);

        const value = valueOf(entry, nutrient);
        if (value === null) {
          g.unknownLines += 1;
          continue;
        }
        g.total += value;
        g.lines += 1;

        // Quantity covers the same lines as `total`, so total / quantity stays meaningful.
        const q = entry.quantity;
        if (q.total === null || q.totalUnit === null || (g.qtyUnit !== null && g.qtyUnit !== q.totalUnit)) {
          g.qtyKnown = false;
        } else {
          g.qty += q.total;
          g.qtyUnit = q.totalUnit;
        }
      }
    }
  }

  const known: RankedFood[] = [];
  const unknown: UnknownFood[] = [];
  let grand = 0;
  for (const g of groups.values()) {
    if (g.lines === 0) {
      unknown.push({ title: g.title, kind: g.kind, lines: g.unknownLines });
      continue;
    }
    grand += g.total;
    known.push({
      title: g.title,
      kind: g.kind,
      total: round2(g.total),
      lines: g.lines,
      unknownLines: g.unknownLines,
      days: g.days.size,
      quantityTotal: g.qtyKnown && g.qtyUnit ? round2(g.qty) : null,
      quantityUnit: g.qtyKnown ? g.qtyUnit : null,
    });
  }
  known.sort((a, b) => b.total - a.total || a.title.localeCompare(b.title, 'cs'));
  unknown.sort((a, b) => a.title.localeCompare(b.title, 'cs'));

  return {
    nutrient,
    unit: nutrient === 'energy' ? (unit ?? 'kcal') : MILLIGRAM_NUTRIENTS.has(nutrient) ? 'mg' : 'g',
    ranking: known.slice(0, limit),
    omittedFoods: Math.max(0, known.length - limit),
    unknown,
    grandTotal: known.length === 0 ? null : round2(grand),
    counts,
    failedDates,
  };
}
