/**
 * The user's goals and body settings (`/user/settings/profile/form`).
 *
 * The site saves them by POSTing the WHOLE profile form back, so a write is
 * read-modify-write: read the form fresh, change only the fields asked for, and
 * send everything else back untouched. Only an explicit whitelist of fields is
 * ever changed here. E-mail, password, agreements, language and the rest of the
 * form are passed through exactly as the site sent them, and none of them is
 * ever returned to the caller.
 */

import { KtError, isRecord, parseCzechNumber } from './util.js';

export const GOAL_MODES = { maintain: 0, lose: 1, gain: 2 } as const;
export type GoalMode = keyof typeof GOAL_MODES;

/** The site's "Paušální výdej" choices, as the multiplier applied to basal metabolism. */
export const ACTIVITY_LEVELS = [
  { value: 1, label: 'none (no flat activity allowance)' },
  { value: 1.2, label: 'sedentary' },
  { value: 1.375, label: 'lightly active' },
  { value: 1.55, label: 'moderately active' },
  { value: 1.725, label: 'very active' },
  { value: 1.9, label: 'extremely active' },
] as const;

export const NUTRIENT_CODES = ['protein', 'carbohydrate', 'fat', 'fiber', 'sugar', 'salt', 'calcium', 'saturatedFattyAcid', 'phe'] as const;
export type NutrientCode = (typeof NUTRIENT_CODES)[number];
/** Only these three can be given as a percentage of energy, and then all three must be. */
const MACROS: readonly string[] = ['protein', 'carbohydrate', 'fat'];

export interface GoalNutrient {
  code: string;
  title: string;
  /** The amount the site recommends, in grams, from the user's profile. */
  recommended: number | null;
  /** The user's own goal in grams, or null when none is set. */
  own: number | null;
  /** The user's own goal as % of energy, or null. Only for protein, carbohydrate and fat. */
  percent: number | null;
  /** Whether the nutrient is shown in the diary and statistics. */
  active: boolean;
}

/**
 * The figures the diary applies, taken from a day balance. A day's target
 * includes the energy of activities logged that day, so the figures here are
 * worked back to a day WITHOUT activities, which is what the goal settings
 * describe; the day's own numbers sit next to them.
 */
export interface EffectiveFigures {
  /** The energy goal on a day without activities. */
  energyGoal: number | null;
  basal: number | null;
  /** The intake that would hold weight steady, without activities; null when an own energy goal switches the deficit model off. */
  maintenance: number | null;
  /** The planned deficit (negative), without activities; null when an own energy goal switches the deficit model off. */
  plannedDeficit: number | null;
  /** Energy of the activities logged on the day the balance was read. */
  activityEnergy: number;
  /** The day's goal as the diary shows it, activities included. */
  energyGoalWithActivities: number | null;
}

interface BalanceFigures {
  target: number | null;
  basal: number | null;
  maintenance: number | null;
  plannedDeficit: number | null;
  activityEnergy: number | null;
}

/**
 * Works a day's balance back to an activity-free base. Observed on the real site:
 * with the deficit model on, the day's maintenance is base + activities and the
 * goal is that minus the same percentage deficit (1783 → 2377 for 699 kcal of
 * activity); with an own fixed goal the activities are simply added (1852 → 1862).
 * Nothing is adjusted when logged activities are switched off in the profile.
 */
export function effectiveFromBalance(b: BalanceFigures, considerActivity: boolean | null): EffectiveFigures {
  const act = considerActivity === false ? 0 : (b.activityEnergy ?? 0);
  const round = (n: number) => Math.round(n);
  let energyGoal = b.target;
  let maintenance = b.maintenance;
  let plannedDeficit = b.plannedDeficit;
  if (act > 0 && b.target !== null) {
    if (b.maintenance !== null && b.maintenance > 0) {
      const share = 1 - act / b.maintenance;
      energyGoal = round(b.target * share);
      maintenance = round(b.maintenance - act);
      plannedDeficit = b.plannedDeficit === null ? null : round(b.plannedDeficit * share);
    } else {
      energyGoal = round(b.target - act);
    }
  }
  return { energyGoal, basal: b.basal, maintenance, plannedDeficit, activityEnergy: b.activityEnergy ?? 0, energyGoalWithActivities: b.target };
}

export interface Goals {
  sex: 'male' | 'female' | null;
  heightCm: number | null;
  birthYear: number | null;
  weightKg: number | null;
  targetWeightKg: number | null;
  mode: GoalMode | null;
  /** The activity multiplier, one of ACTIVITY_LEVELS. */
  activityLevel: number | null;
  /** Whether logged activities add to the energy spent. */
  considerActivity: boolean | null;
  energyUnit: string;
  basal: { computed: number | null; own: number | null };
  targetEnergy: { computed: number | null; own: number | null };
  /** Whether the user's own nutrient goals are switched on. */
  customNutrients: boolean;
  nutrients: GoalNutrient[];
  drinkLiters: number | null;
  /** Filled in by the client from today's balance; null when that could not be read. */
  effective: EffectiveFigures | null;
}

const MODE_BY_NUMBER: Record<number, GoalMode> = { 0: 'maintain', 1: 'lose', 2: 'gain' };

function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** Reads the whitelisted goal fields out of the profile form. Everything else in the form is ignored. */
export function parseGoals(form: unknown): Goals {
  if (!isRecord(form)) throw new KtError('goals: expected the profile form object');
  const nutrients = form['ownNutrients'];
  if (!Array.isArray(nutrients)) throw new KtError('goals: profile form has no nutrient list');
  if (typeof form['energyUnit'] !== 'string') throw new KtError('goals: profile form has no energy unit');

  const mode = typeof form['mode'] === 'number' ? (MODE_BY_NUMBER[form['mode']] ?? null) : null;
  const sex = form['sex'] === 'M' ? 'male' : form['sex'] === 'F' ? 'female' : null;

  return {
    sex,
    heightCm: parseCzechNumber(form['height']),
    birthYear: parseCzechNumber(form['year']),
    weightKg: parseCzechNumber(form['weight']),
    targetWeightKg: parseCzechNumber(form['targetWeight']),
    mode,
    activityLevel: parseCzechNumber(form['amr']),
    considerActivity: boolOrNull(form['considerActivity']),
    energyUnit: form['energyUnit'],
    basal: { computed: parseCzechNumber(form['computedBasal']), own: parseCzechNumber(form['ownBasal']) },
    targetEnergy: { computed: parseCzechNumber(form['computedTargetEnergy']), own: parseCzechNumber(form['ownTargetEnergy']) },
    customNutrients: form['ownDailyDose'] === true,
    nutrients: nutrients.map((n, i) => {
      if (!isRecord(n) || typeof n['code'] !== 'string') throw new KtError(`goals: unreadable nutrient entry ${i}`);
      return {
        code: n['code'],
        title: typeof n['title'] === 'string' ? n['title'] : n['code'],
        recommended: parseCzechNumber(n['computedValue']),
        own: parseCzechNumber(n['value']),
        percent: parseCzechNumber(n['ratio']),
        active: n['active'] === true,
      };
    }),
    drinkLiters: parseCzechNumber(form['drinkRegime']),
    effective: null,
  };
}

/** What the caller may change. A field left out is untouched; `null` clears an own value back to the site's calculation. */
export interface GoalsChange {
  mode?: GoalMode;
  targetWeightKg?: number | null;
  activityLevel?: number;
  considerActivity?: boolean;
  /** Own basal metabolism, in the profile's energy unit. */
  ownBasal?: number | null;
  /** Own daily energy goal, in the profile's energy unit. */
  ownTargetEnergy?: number | null;
  drinkLiters?: number | null;
  nutrients?: Array<{ code: string; grams?: number | null; percent?: number | null; active?: boolean }>;
}

const KJ_PER_KCAL = 4.184;

/** Plausible ranges, in kcal. They catch typos and unit mix-ups, not clinical judgement. */
const BASAL_KCAL = [800, 4000] as const;
const TARGET_KCAL = [1000, 6000] as const;

function inUnit(range: readonly [number, number], unit: string): [number, number] {
  return unit.toLowerCase() === 'kj' ? [Math.round(range[0] * KJ_PER_KCAL), Math.round(range[1] * KJ_PER_KCAL)] : [range[0], range[1]];
}

function assertRange(name: string, value: number, [lo, hi]: [number, number], unit: string): void {
  if (!Number.isFinite(value) || value < lo || value > hi) throw new KtError(`${name} must be between ${lo} and ${hi} ${unit}`);
}

/** The form field each change touches, for the `…Open` flags the site's own page sets while a field is being edited. */
const OPEN_FLAG: Record<string, string> = {
  mode: 'modeOpen',
  targetWeightKg: 'targetWeightOpen',
  activityLevel: 'amrOpen',
  considerActivity: 'considerActivityOpen',
  ownBasal: 'ownBasalOpen',
  ownTargetEnergy: 'ownTargetEnergyOpen',
  drinkLiters: 'drinkRegimeOpen',
};

/**
 * Applies a validated change to a copy of the profile form. Returns the body
 * to POST and the names of the fields that change. Throws on anything invalid
 * or empty, before anything is sent.
 */
export function applyGoalsChange(form: unknown, change: GoalsChange): { body: Record<string, unknown>; changed: string[] } {
  if (!isRecord(form)) throw new KtError('goals: expected the profile form object');
  const body = structuredClone(form);
  const unit = typeof form['energyUnit'] === 'string' ? form['energyUnit'] : 'kcal';
  const changed: string[] = [];
  const touch = (name: string) => {
    changed.push(name);
    const flag = OPEN_FLAG[name];
    if (flag) body[flag] = true;
  };

  if (change.mode !== undefined) {
    if (!(change.mode in GOAL_MODES)) throw new KtError(`mode must be one of ${Object.keys(GOAL_MODES).join(', ')}`);
    body['mode'] = GOAL_MODES[change.mode];
    touch('mode');
  }
  if (change.targetWeightKg !== undefined) {
    if (change.targetWeightKg !== null) assertRange('target weight', change.targetWeightKg, [30, 300], 'kg');
    body['targetWeight'] = change.targetWeightKg;
    touch('targetWeightKg');
  }
  if (change.activityLevel !== undefined) {
    if (!ACTIVITY_LEVELS.some(l => l.value === change.activityLevel)) {
      throw new KtError(`activity level must be one of ${ACTIVITY_LEVELS.map(l => l.value).join(', ')}`);
    }
    body['amr'] = change.activityLevel;
    touch('activityLevel');
  }
  if (change.considerActivity !== undefined) {
    body['considerActivity'] = change.considerActivity;
    touch('considerActivity');
  }
  if (change.ownBasal !== undefined) {
    if (change.ownBasal !== null) assertRange('own basal metabolism', change.ownBasal, inUnit(BASAL_KCAL, unit), unit);
    body['ownBasal'] = change.ownBasal;
    touch('ownBasal');
  }
  if (change.ownTargetEnergy !== undefined) {
    if (change.ownTargetEnergy !== null) assertRange('own energy goal', change.ownTargetEnergy, inUnit(TARGET_KCAL, unit), unit);
    body['ownTargetEnergy'] = change.ownTargetEnergy;
    touch('ownTargetEnergy');
  }
  if (change.drinkLiters !== undefined) {
    if (change.drinkLiters !== null) assertRange('drinking goal', change.drinkLiters, [0.5, 10], 'l');
    body['drinkRegime'] = change.drinkLiters;
    touch('drinkLiters');
  }

  if (change.nutrients !== undefined) {
    const list = body['ownNutrients'];
    if (!Array.isArray(list)) throw new KtError('goals: profile form has no nutrient list');
    const seen = new Set<string>();
    for (const n of change.nutrients) {
      if (!(NUTRIENT_CODES as readonly string[]).includes(n.code)) {
        throw new KtError(`unknown nutrient "${n.code}"; use one of ${NUTRIENT_CODES.join(', ')}`);
      }
      if (seen.has(n.code)) throw new KtError(`nutrient "${n.code}" appears twice`);
      seen.add(n.code);
      if (n.grams === undefined && n.percent === undefined && n.active === undefined) {
        throw new KtError(`nutrient "${n.code}": give grams, percent or active`);
      }
      if (n.grams !== undefined && n.percent !== undefined) throw new KtError(`nutrient "${n.code}": give grams or percent, not both`);
      if (n.grams !== undefined && n.grams !== null && !(n.grams > 0 && n.grams <= 2000)) {
        throw new KtError(`nutrient "${n.code}": grams must be between 0 and 2000`);
      }
      if (n.percent !== undefined && n.percent !== null) {
        if (!MACROS.includes(n.code)) throw new KtError(`nutrient "${n.code}" cannot be set as a percentage; only protein, carbohydrate and fat can`);
        if (!Number.isInteger(n.percent) || n.percent < 1 || n.percent > 100) throw new KtError(`nutrient "${n.code}": percent must be a whole number from 1 to 100`);
      }
      const row = list.find((r): r is Record<string, unknown> => isRecord(r) && r['code'] === n.code);
      if (!row) throw new KtError(`goals: the profile has no "${n.code}" nutrient`);
      if (n.grams !== undefined) {
        row['value'] = n.grams;
        row['ratio'] = null;
      }
      if (n.percent !== undefined) {
        row['ratio'] = n.percent;
        row['value'] = null;
      }
      if (n.active !== undefined) row['active'] = n.active;
      changed.push(`nutrients.${n.code}`);
    }
    // The same checks the site's own page makes before saving.
    const ratios = list.filter((r): r is Record<string, unknown> => isRecord(r) && MACROS.includes(String(r['code'])));
    const withRatio = ratios.filter(r => r['ratio'] !== null && r['ratio'] !== undefined);
    if (withRatio.length > 0 && withRatio.length < MACROS.length) {
      throw new KtError('percentages must be set for protein, carbohydrate and fat together');
    }
    if (withRatio.reduce((sum, r) => sum + Number(r['ratio']), 0) > 100) throw new KtError('the percentages add up to more than 100');
    body['ownDailyDose'] = true;
  }

  if (changed.length === 0) throw new KtError('nothing to change: give at least one field');
  return { body, changed };
}

const same = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);
/** The site stores energy in kJ, so a kcal value comes back rounded by up to one unit (1750 → 1749). */
const sameEnergy = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1);

/** After a write: the names of the requested fields that the site did not end up with. Empty means all took effect. */
export function unappliedChanges(change: GoalsChange, after: Goals): string[] {
  const bad: string[] = [];
  if (change.mode !== undefined && after.mode !== change.mode) bad.push('mode');
  if (change.targetWeightKg !== undefined && !same(after.targetWeightKg, change.targetWeightKg)) bad.push('targetWeightKg');
  if (change.activityLevel !== undefined && !same(after.activityLevel, change.activityLevel)) bad.push('activityLevel');
  if (change.considerActivity !== undefined && after.considerActivity !== change.considerActivity) bad.push('considerActivity');
  if (change.ownBasal !== undefined && !sameEnergy(after.basal.own, change.ownBasal)) bad.push('ownBasal');
  if (change.ownTargetEnergy !== undefined && !sameEnergy(after.targetEnergy.own, change.ownTargetEnergy)) bad.push('ownTargetEnergy');
  if (change.drinkLiters !== undefined && !same(after.drinkLiters, change.drinkLiters)) bad.push('drinkLiters');
  for (const n of change.nutrients ?? []) {
    const got = after.nutrients.find(a => a.code === n.code);
    if (!got) {
      bad.push(`nutrients.${n.code}`);
      continue;
    }
    if (n.grams !== undefined && !same(got.own, n.grams)) bad.push(`nutrients.${n.code}`);
    else if (n.percent !== undefined && !same(got.percent, n.percent)) bad.push(`nutrients.${n.code}`);
    else if (n.active !== undefined && got.active !== n.active) bad.push(`nutrients.${n.code}`);
  }
  return bad;
}

/** The goal the user is actually held to today: what the diary uses, else their own, else the site's calculation. */
export function effectiveEnergyGoal(g: Goals): number | null {
  return g.effective?.energyGoal ?? g.targetEnergy.own ?? g.targetEnergy.computed;
}
export function effectiveBasal(g: Goals): number | null {
  return g.effective?.basal ?? g.basal.own ?? g.basal.computed;
}

/** Energy the nutrient goals add up to, in the profile's unit. Needs protein, carbohydrate and fat. */
export function macroEnergy(g: Goals): number | null {
  const grams = (code: string) => {
    const n = g.nutrients.find(x => x.code === code);
    return n ? (n.own ?? n.recommended) : null;
  };
  const p = grams('protein');
  const c = grams('carbohydrate');
  const f = grams('fat');
  if (p === null || c === null || f === null) return null;
  const kcal = p * 4 + c * 4 + f * 9;
  return g.energyUnit.toLowerCase() === 'kj' ? kcal * KJ_PER_KCAL : kcal;
}

/** Things worth telling the user about a set of goals. Observations, never blocks. */
export function goalWarnings(g: Goals): string[] {
  const out: string[] = [];
  const unit = g.energyUnit;
  const kcalFloor = inUnit([1200, 1200], unit)[0];
  const target = effectiveEnergyGoal(g);
  const basal = effectiveBasal(g);
  if (target !== null && target < kcalFloor) out.push(`The energy goal (${target} ${unit}) is below ${kcalFloor} ${unit}, a level that should only be used under medical supervision.`);
  if (target !== null && basal !== null && target < basal) out.push(`The energy goal (${target} ${unit}) is below basal metabolism (${basal} ${unit}).`);
  const macros = macroEnergy(g);
  if (target !== null && macros !== null && g.customNutrients && Math.abs(macros - target) / target > 0.03) {
    out.push(
      `The protein, carbohydrate and fat goals add up to ${Math.round(macros)} ${unit}, but the energy goal is ${target} ${unit}; they do not match.`,
    );
  }
  return out;
}
