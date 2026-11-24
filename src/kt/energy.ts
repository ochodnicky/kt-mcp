/**
 * Estimates what the user's body actually spends, from what they ate and how
 * their weight moved, and sets that against what the site assumes.
 *
 * energy in − energy stored = energy spent, and one kilogram of body weight is
 * taken as 7700 kcal. The estimate is only as good as the diary is complete and
 * the weigh-ins are comparable (same time of day, similar hydration), so every
 * result carries a confidence rating and the reasons for it.
 */

import type { BalanceOutcome } from './client.js';
import { KtError } from './util.js';

export interface WeightPoint {
  date: string;
  kg: number;
}

const KCAL_PER_KG = 7700;
const KJ_PER_KCAL = 4.184;

export interface EnergyModel {
  period: { from: string; to: string; days: number };
  energyUnit: string;
  days: { logged: number; notLogged: number; failed: number; excluded: number };
  /** Mean intake over the logged days. */
  averageIntake: number | null;
  /** Mean energy spent according to the site (basal × flat allowance + logged activities), over days that used the site's model. */
  siteExpenditure: number | null;
  weight: {
    points: number;
    first: WeightPoint;
    last: WeightPoint;
    spanDays: number;
    /** Least-squares trend, kg per week; negative is losing. */
    trendKgPerWeek: number;
    /** One standard error of the trend, kg per week; null with fewer than 3 points. */
    trendErrorKgPerWeek: number | null;
  } | null;
  /** Intake plus the energy released by the weight trend: what the body seems to spend. */
  impliedExpenditure: number | null;
  /** The ± on impliedExpenditure that the weight scatter alone causes. */
  impliedExpenditureError: number | null;
  /** How many logged days siteExpenditure rests on. */
  siteExpenditureDays: number;
  /**
   * impliedExpenditure − siteExpenditure; negative means the body spends less than the site assumes.
   * Only given when siteExpenditure covers (nearly) all logged days; otherwise the two are not comparable.
   */
  differenceFromSite: number | null;
  /** How much to trust impliedExpenditure. */
  confidence: 'low' | 'medium' | 'high';
  caveats: string[];
}

const round = (n: number) => Math.round(n);
const round2 = (n: number) => Math.round(n * 100) / 100;

function dayNumber(date: string): number {
  const [d, m, y] = date.split('.').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** Least-squares line through (day, kg). Returns the slope per day and its standard error. */
function trend(points: WeightPoint[]): { slopePerDay: number; errorPerDay: number | null } {
  const xs = points.map(p => dayNumber(p.date));
  const ys = points.map(p => p.kg);
  const n = points.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0);
  const slope = sxy / sxx;
  if (n < 3) return { slopePerDay: slope, errorPerDay: null };
  const intercept = my - slope * mx;
  const sse = xs.reduce((a, x, i) => a + (ys[i]! - (intercept + slope * x)) ** 2, 0);
  return { slopePerDay: slope, errorPerDay: Math.sqrt(sse / (n - 2) / sxx) };
}

/**
 * @param outcomes daily balances for the period, in order. `excludeDates` are left out of the averages
 *                 (today, which is still being logged).
 */
export function estimateEnergyModel(args: {
  from: string;
  to: string;
  outcomes: BalanceOutcome[];
  weights: WeightPoint[];
  excludeDates?: string[];
}): EnergyModel {
  const exclude = new Set(args.excludeDates ?? []);
  const counted = args.outcomes.filter(o => !exclude.has(o.date));
  const failed = counted.filter(o => o.status === 'error').length;
  const ok = counted.flatMap(o => (o.status === 'ok' ? [o.balance] : []));
  const logged = ok.filter(b => b.intake !== null && b.intake > 0);
  const unit = (logged[0] ?? ok[0])?.energyUnit ?? 'kcal';
  const perKg = unit.toLowerCase() === 'kj' ? KCAL_PER_KG * KJ_PER_KCAL : unit.toLowerCase() === 'kcal' ? KCAL_PER_KG : null;
  if (perKg === null) throw new KtError(`energy model: unsupported energy unit "${unit}"`);

  // On a day with an own energy goal the site drops its deficit model and reports the goal as "energy spent",
  // which says nothing about what the body spends. Only the modelled days count towards siteExpenditure.
  const modelled = logged.filter(b => b.maintenance !== null);
  const fixedGoalDays = logged.length - modelled.length;

  const comparable = logged.length > 0 && modelled.length >= logged.length * 0.8;
  const mean = (v: number[]) => (v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length);
  const avgIntake = mean(logged.flatMap(b => (b.intake === null ? [] : [b.intake])));
  const avgOutput = mean(modelled.flatMap(b => (b.output === null ? [] : [b.output])));

  const inRange = args.weights
    .filter(w => dayNumber(w.date) >= dayNumber(args.from) && dayNumber(w.date) <= dayNumber(args.to))
    .sort((a, b) => dayNumber(a.date) - dayNumber(b.date));
  const distinct = inRange.filter((w, i) => i === 0 || w.date !== inRange[i - 1]!.date);

  let weight: EnergyModel['weight'] = null;
  let slope: { slopePerDay: number; errorPerDay: number | null } | null = null;
  if (distinct.length >= 2 && dayNumber(distinct.at(-1)!.date) > dayNumber(distinct[0]!.date)) {
    slope = trend(distinct);
    weight = {
      points: distinct.length,
      first: distinct[0]!,
      last: distinct.at(-1)!,
      spanDays: dayNumber(distinct.at(-1)!.date) - dayNumber(distinct[0]!.date),
      trendKgPerWeek: round2(slope.slopePerDay * 7),
      trendErrorKgPerWeek: slope.errorPerDay === null ? null : round2(slope.errorPerDay * 7),
    };
  }

  const implied = avgIntake !== null && slope ? avgIntake - slope.slopePerDay * perKg : null;
  const impliedError = slope?.errorPerDay != null ? slope.errorPerDay * perKg : null;

  const total = args.outcomes.length - exclude.size;
  const loggedShare = total > 0 ? logged.length / total : 0;
  const caveats: string[] = [];
  if (exclude.size > 0) caveats.push(`${[...exclude].join(', ')} left out: that day is not finished.`);
  if (failed > 0) caveats.push(`${failed} day(s) could not be read.`);
  if (fixedGoalDays > 0) {
    caveats.push(
      `On ${fixedGoalDays} of ${logged.length} logged days the account had its own fixed energy goal. The site then reports that goal as "energy spent", so those days are left out of siteExpenditure, which rests on ${modelled.length} days.` +
        (comparable
          ? ''
          : modelled.length === 0
            ? ' impliedExpenditure cannot be compared with the site; compare it with basal metabolism times the activity level instead.'
            : ' It covers a different period than impliedExpenditure, so differenceFromSite is not given. For a like-for-like comparison, ask again for only the period since the goal setting last changed (at least 14 days).'),
    );
  }
  if (loggedShare < 0.85) {
    caveats.push(
      `Only ${logged.length} of ${total} days have food logged. Days with nothing logged are skipped, so if the user ate on them, the real intake and expenditure are higher than shown.`,
    );
  }
  if (weight === null) caveats.push('Fewer than two weigh-ins in the period (or all on one day), so there is no weight trend and no estimate.');
  else {
    if (weight.spanDays < 14) caveats.push(`The weigh-ins cover only ${weight.spanDays} days; day-to-day water changes can outweigh real change over such a short time.`);
    if (weight.points < 4) caveats.push(`Only ${weight.points} weigh-ins; a trend from so few points is rough.`);
  }
  const typicalDay = logged.length > 0 ? logged.length : 0;
  if (typicalDay > 0 && avgIntake !== null) {
    const low = logged.filter(b => (b.intake ?? 0) < avgIntake * 0.5).length;
    if (low > 0) caveats.push(`${low} logged day(s) have less than half the average intake; they are probably incomplete and pull the average down.`);
  }

  let confidence: EnergyModel['confidence'] = 'low';
  if (weight && implied !== null) {
    if (weight.spanDays >= 21 && weight.points >= 6 && loggedShare >= 0.85) confidence = 'high';
    else if (weight.spanDays >= 14 && weight.points >= 4 && loggedShare >= 0.7) confidence = 'medium';
  }

  return {
    period: { from: args.from, to: args.to, days: args.outcomes.length },
    energyUnit: unit,
    days: { logged: logged.length, notLogged: ok.length - logged.length, failed, excluded: exclude.size },
    averageIntake: avgIntake === null ? null : round(avgIntake),
    siteExpenditure: avgOutput === null ? null : round(avgOutput),
    weight,
    impliedExpenditure: implied === null ? null : round(implied),
    impliedExpenditureError: impliedError === null ? null : round(impliedError),
    siteExpenditureDays: modelled.length,
    differenceFromSite: comparable && implied !== null && avgOutput !== null ? round(implied - avgOutput) : null,
    confidence,
    caveats,
  };
}
