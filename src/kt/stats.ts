/**
 * Parsers for the site's statistics pages: drinking, and the diary analysis
 * (goal fulfilment per nutrient, the biggest sources, personal tips).
 *
 * Like every parser here they throw on a shape they do not recognise, and a
 * missing figure stays null rather than becoming 0.
 */

import { KtError, isRecord, parseCzechNumber, pragueDate } from './util.js';

const round = (n: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

const DATE = /^\d{2}\.\d{2}\.\d{4}$/;

// ---------------------------------------------------------------------------
// Drinking (`/statistic/drink/{from}/{to}/get`)
// ---------------------------------------------------------------------------

export interface HydrationDay {
  date: string;
  /** Litres drunk that day; null when the site sent no figure for the day. */
  litres: number | null;
  /** The day's goal in litres (it moves with activity); null when unknown. */
  goalLitres: number | null;
}

function readDaySeries(raw: unknown, name: string): Map<string, number | null> {
  if (!Array.isArray(raw)) throw new KtError(`drinking: response has no "${name}" list`);
  const out = new Map<string, number | null>();
  for (const item of raw as unknown[]) {
    if (!isRecord(item) || typeof item['description'] !== 'string' || !DATE.test(item['description'])) {
      throw new KtError(`drinking: an entry of "${name}" has no date`);
    }
    out.set(item['description'], parseCzechNumber(item['value']));
  }
  return out;
}

/** `days` are the requested days (dd.MM.yyyy); a day the site did not mention comes back with nulls. */
export function parseHydration(data: unknown, days: string[]): HydrationDay[] {
  if (!isRecord(data)) throw new KtError('drinking: expected an object');
  const values = readDaySeries(data['values'], 'values');
  const targets = readDaySeries(data['target'], 'target');
  return days.map(date => ({ date, litres: values.get(date) ?? null, goalLitres: targets.get(date) ?? null }));
}

export interface HydrationSummary {
  days: number;
  /** Days with a figure above zero. The site cannot tell "drank nothing" from "logged nothing". */
  daysWithDrinks: number;
  /** Average over every day that has a figure, zeros included. */
  averageLitres: number | null;
  /** Average over the days with some drinking logged only. */
  averageLitresOnDaysWithDrinks: number | null;
  averageGoalLitres: number | null;
  /** Days with drinks logged where the goal was reached. */
  daysGoalReached: number;
}

export function summarizeHydration(days: HydrationDay[]): HydrationSummary {
  const known = days.filter((d): d is HydrationDay & { litres: number } => d.litres !== null);
  const withDrinks = known.filter(d => d.litres > 0);
  const goals = days.flatMap(d => (d.goalLitres === null ? [] : [d.goalLitres]));
  const mean = (xs: number[]) => (xs.length === 0 ? null : round(xs.reduce((a, b) => a + b, 0) / xs.length));
  return {
    days: days.length,
    daysWithDrinks: withDrinks.length,
    averageLitres: mean(known.map(d => d.litres)),
    averageLitresOnDaysWithDrinks: mean(withDrinks.map(d => d.litres)),
    averageGoalLitres: mean(goals),
    daysGoalReached: withDrinks.filter(d => d.goalLitres !== null && d.litres >= d.goalLitres).length,
  };
}

// ---------------------------------------------------------------------------
// Diary analysis (`/statistic/analysis/graph/{from}/{to}/get`, `.../tips/...`)
// ---------------------------------------------------------------------------

export interface AnalysisNutrient {
  title: string;
  /** Average per day over the period, in grams, as the site computes it. */
  averageG: number | null;
  goalG: number | null;
  /** Average as a percentage of the goal. */
  percentOfGoal: number | null;
  /** Share of the energy intake this nutrient supplied, in percent. */
  energySharePercent: number | null;
  goalEnergySharePercent: number | null;
  /** Set for a nutrient that is a part of another one (saturated fat of fat). */
  partOf: string | null;
}

export interface AnalysisFigure {
  average: number | null;
  goal: number | null;
  percentOfGoal: number | null;
  unit: string;
}

export interface SourceItem {
  title: string;
  /** The site's own text for the amount ("132 kcal", "13,6 g"). */
  amount: string | null;
  /** The site's own text for how often ("4x"). */
  times: string | null;
}

export interface SourceGroup {
  nutrient: string;
  items: SourceItem[];
}

export interface GoalAnalysis {
  from: string | null;
  to: string | null;
  /** The site's own flag that some days in the period have no records. */
  recordsMissing: boolean | null;
  energy: AnalysisFigure | null;
  nutrients: AnalysisNutrient[];
  salt: AnalysisFigure | null;
  calcium: AnalysisFigure | null;
  drinking: AnalysisFigure | null;
  /** The site's alcohol block as far as it is readable; null when the site sends none. */
  alcohol: Record<string, string | number | null> | null;
  sourcesByFood: SourceGroup[];
  sourcesByCategory: SourceGroup[];
}

function figure(raw: unknown, unit: string, scale = 1): AnalysisFigure | null {
  if (!isRecord(raw)) return null;
  const value = parseCzechNumber(raw['value']);
  if (value === null) return null;
  const target = parseCzechNumber(raw['target']);
  return {
    average: round(value * scale),
    goal: target === null ? null : round(target * scale),
    percentOfGoal: parseCzechNumber(raw['percent']),
    unit,
  };
}

function parseNutrient(raw: unknown, partOf: string | null, out: AnalysisNutrient[]): void {
  if (!isRecord(raw) || typeof raw['title'] !== 'string') throw new KtError('analysis: a nutrient has no title');
  const value = parseCzechNumber(raw['value']);
  const target = parseCzechNumber(raw['target']);
  out.push({
    title: raw['title'],
    averageG: value === null ? null : round(value),
    goalG: target === null ? null : round(target),
    percentOfGoal: parseCzechNumber(raw['percent']),
    energySharePercent: parseCzechNumber(raw['valuePercent']),
    goalEnergySharePercent: parseCzechNumber(raw['targetPercent']),
    partOf,
  });
  if (raw['subset'] !== null && raw['subset'] !== undefined) parseNutrient(raw['subset'], raw['title'], out);
}

function parseSources(raw: unknown, where: string): SourceGroup[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new KtError(`analysis: ${where} is not a list`);
  return (raw as unknown[]).map(group => {
    if (!isRecord(group) || typeof group['title'] !== 'string' || !Array.isArray(group['items'])) {
      throw new KtError(`analysis: a group in ${where} is malformed`);
    }
    const items = (group['items'] as unknown[]).map(item => {
      if (!isRecord(item) || typeof item['title'] !== 'string') throw new KtError(`analysis: an item in ${where} has no title`);
      return {
        title: item['title'],
        amount: typeof item['valueString'] === 'string' ? item['valueString'] : null,
        times: typeof item['count'] === 'string' ? item['count'] : null,
      };
    });
    return { nutrient: group['title'], items };
  });
}

function epochDate(raw: unknown): string | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? pragueDate(new Date(raw)) : null;
}

export function parseGoalAnalysis(data: unknown): GoalAnalysis {
  if (!isRecord(data)) throw new KtError('analysis: expected an object');
  if (!Array.isArray(data['list'])) throw new KtError('analysis: response has no nutrient list');
  const nutrients: AnalysisNutrient[] = [];
  for (const raw of data['list'] as unknown[]) parseNutrient(raw, null, nutrients);

  const energyRaw = data['energy'];
  const energyUnit = isRecord(energyRaw) && typeof energyRaw['energyUnit'] === 'string' ? energyRaw['energyUnit'] : 'kcal';

  let alcohol: GoalAnalysis['alcohol'] = null;
  if (isRecord(data['alcohol'])) {
    const a = data['alcohol'];
    alcohol = {};
    for (const key of ['title', 'value', 'valueString', 'target', 'targetString', 'percent']) {
      const v = a[key];
      if (typeof v === 'string' || typeof v === 'number') alcohol[key] = v;
    }
  }

  return {
    from: epochDate(data['from']),
    to: epochDate(data['to']),
    recordsMissing: typeof data['recordsMissing'] === 'boolean' ? data['recordsMissing'] : null,
    energy: figure(energyRaw, energyUnit),
    nutrients,
    salt: figure(data['salt'], 'g'),
    // The site sends calcium in grams (0.54) while showing milligrams (543,44).
    calcium: figure(data['calcium'], 'mg', 1000),
    drinking: figure(data['drink'], 'l'),
    alcohol,
    sourcesByFood: parseSources(data['totalValueInfluence'], 'sources by food'),
    sourcesByCategory: parseSources(data['totalValueInfluenceCategory'], 'sources by category'),
  };
}

export interface AnalysisTip {
  title: string;
  advice: string | null;
  explanation: string | null;
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

export function parseAnalysisTips(data: unknown): AnalysisTip[] {
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data)) throw new KtError('analysis tips: expected a list');
  const rows = (data as unknown[]).map(raw => {
    if (!isRecord(raw) || typeof raw['title'] !== 'string') throw new KtError('analysis tips: a tip has no title');
    return {
      order: parseCzechNumber(raw['order']) ?? 0,
      tip: {
        title: stripTags(raw['title']),
        advice: typeof raw['advice'] === 'string' ? stripTags(raw['advice']) : null,
        explanation: typeof raw['text'] === 'string' ? stripTags(raw['text']) : null,
      },
    };
  });
  return rows.sort((a, b) => a.order - b.order).map(r => r.tip);
}
