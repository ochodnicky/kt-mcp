/**
 * Averages over a series of daily balances.
 *
 * A day with no intake at all is treated as "not logged", not as a fast: the
 * site cannot tell the two apart, and counting an unlogged day as 0 kcal would
 * drag every average down. Averages therefore cover logged days only, and the
 * number of those days is reported next to them.
 */

import type { BalanceOutcome } from './client.js';

export interface NutrientAverage {
  code: string | null;
  title: string;
  unit: string | null;
  /** Mean of the actual amounts over the logged days. */
  averageActual: number | null;
  /** The goal as of the last logged day (goals can change over a long range). */
  goal: number | null;
  days: number;
}

export interface BalanceSummary {
  days: { ok: number; error: number; logged: number };
  failedDates: string[];
  energyUnit: string | null;
  averageIntake: number | null;
  averageOutput: number | null;
  /** Mean of intake − output; negative means a deficit. */
  averageNetBalance: number | null;
  nutrients: NutrientAverage[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (values: number[]): number | null => (values.length === 0 ? null : round1(values.reduce((a, b) => a + b, 0) / values.length));

export function summarizeBalances(outcomes: BalanceOutcome[]): BalanceSummary {
  const failedDates: string[] = [];
  const logged = [];
  let ok = 0;
  for (const o of outcomes) {
    if (o.status === 'error') {
      failedDates.push(o.date);
      continue;
    }
    ok += 1;
    if (o.balance.intake !== null && o.balance.intake > 0) logged.push(o.balance);
  }

  const known = <T>(values: Array<T | null>): T[] => values.filter((v): v is T => v !== null);
  const byKey = new Map<string, { code: string | null; title: string; unit: string | null; actuals: number[]; goal: number | null }>();
  for (const b of logged) {
    for (const n of b.nutrients) {
      const key = n.code ?? n.title;
      const entry = byKey.get(key) ?? { code: n.code, title: n.title, unit: n.unit, actuals: [], goal: null };
      if (n.actual !== null) entry.actuals.push(n.actual);
      entry.goal = n.goal;
      byKey.set(key, entry);
    }
  }

  return {
    days: { ok, error: failedDates.length, logged: logged.length },
    failedDates,
    energyUnit: logged[0]?.energyUnit ?? null,
    averageIntake: mean(known(logged.map(b => b.intake))),
    averageOutput: mean(known(logged.map(b => b.output))),
    averageNetBalance: mean(known(logged.map(b => b.netBalance))),
    nutrients: [...byKey.values()].map(e => ({
      code: e.code,
      title: e.title,
      unit: e.unit,
      averageActual: mean(e.actuals),
      goal: e.goal,
      days: e.actuals.length,
    })),
  };
}
