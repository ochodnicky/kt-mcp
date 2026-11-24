/**
 * Goals (the profile form) and the energy model. Synthetic data only; the
 * personal fields in the fixture are planted fakes to prove they never leave.
 */

import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import type { BalanceOutcome, DayBalance } from './client.js';
import { estimateEnergyModel } from './energy.js';
import { applyGoalsChange, effectiveBasal, effectiveFromBalance, effectiveEnergyGoal, goalWarnings, macroEnergy, parseGoals, unappliedChanges } from './goals.js';
import { KtError } from './util.js';
import { OTHER_PAST, PAST, balancePayload, client, envelope, json, loginOk, noonEpoch, profileForm, restoreFetch, state, stubFetch } from './testkit.js';

afterEach(restoreFetch);

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

test('parseGoals reads the goal fields and nothing personal', () => {
  const g = parseGoals(profileForm());
  assert.equal(g.mode, 'lose');
  assert.equal(g.activityLevel, 1.2);
  assert.equal(g.targetWeightKg, 72);
  assert.equal(g.basal.computed, 1748);
  assert.equal(g.targetEnergy.computed, 1783);
  assert.equal(g.targetEnergy.own, null);
  assert.equal(g.customNutrients, true);
  assert.deepEqual(g.nutrients.find(n => n.code === 'protein'), { code: 'protein', title: 'Bílkoviny', recommended: 123, own: 144, percent: null, active: true });
  assert.equal(g.nutrients.find(n => n.code === 'fat')?.recommended, 55.5);
  const text = JSON.stringify(g);
  for (const secret of ['test@example.invalid', 'fake-token', 'fake-support-code']) assert.ok(!text.includes(secret), secret);
});

test('parseGoals refuses a form without the pieces it needs', () => {
  assert.throws(() => parseGoals(null), KtError);
  assert.throws(() => parseGoals({ ...profileForm(), ownNutrients: undefined }), KtError);
  assert.throws(() => parseGoals({ ...profileForm(), energyUnit: undefined }), KtError);
});

// ---------------------------------------------------------------------------
// building a change
// ---------------------------------------------------------------------------

test('a change touches only the requested fields and leaves the rest of the form as it was', () => {
  const form = profileForm();
  const snapshot = structuredClone(form);
  const { body, changed } = applyGoalsChange(form, { ownTargetEnergy: 1700, activityLevel: 1.375 });
  assert.deepEqual(form, snapshot, 'the input form must not be modified');
  assert.deepEqual(changed.sort(), ['activityLevel', 'ownTargetEnergy']);
  assert.equal(body['ownTargetEnergy'], 1700);
  assert.equal(body['amr'], 1.375);
  assert.equal(body['ownTargetEnergyOpen'], true);
  assert.equal(body['amrOpen'], true);
  // Everything else is sent back exactly as it came.
  const rest = (o: Record<string, unknown>) => {
    const { ownTargetEnergy, ownTargetEnergyOpen, amr, amrOpen, ...others } = o;
    void ownTargetEnergy; void ownTargetEnergyOpen; void amr; void amrOpen;
    return others;
  };
  assert.deepEqual(rest(body), rest(form));
});

test('null clears an own value, and the weight is never part of a change', () => {
  const { body } = applyGoalsChange(profileForm({ ownBasal: 1700 }), { ownBasal: null, targetWeightKg: null });
  assert.equal(body['ownBasal'], null);
  assert.equal(body['targetWeight'], null);
  assert.equal(body['weight'], 81.9);
  assert.equal(body['weightOpen'], false);
});

test('nutrient goals: grams, percent, clearing and visibility', () => {
  const g = applyGoalsChange(profileForm(), { nutrients: [{ code: 'carbohydrate', grams: 178 }, { code: 'sugar', grams: 40 }, { code: 'fiber', active: false }] });
  const rows = g.body['ownNutrients'] as Array<Record<string, unknown>>;
  assert.equal(rows.find(r => r['code'] === 'carbohydrate')?.['value'], 178);
  assert.equal(rows.find(r => r['code'] === 'sugar')?.['value'], 40);
  assert.equal(rows.find(r => r['code'] === 'fiber')?.['active'], false);
  assert.equal(rows.find(r => r['code'] === 'fiber')?.['value'], 28, 'visibility alone must not clear the value');
  assert.deepEqual(g.changed.sort(), ['nutrients.carbohydrate', 'nutrients.fiber', 'nutrients.sugar']);

  const pct = applyGoalsChange(profileForm(), {
    nutrients: [{ code: 'protein', percent: 30 }, { code: 'carbohydrate', percent: 40 }, { code: 'fat', percent: 30 }],
  });
  const prow = (pct.body['ownNutrients'] as Array<Record<string, unknown>>).find(r => r['code'] === 'protein');
  assert.equal(prow?.['ratio'], 30);
  assert.equal(prow?.['value'], null);

  const cleared = applyGoalsChange(profileForm(), { nutrients: [{ code: 'sugar', grams: null }] });
  assert.equal((cleared.body['ownNutrients'] as Array<Record<string, unknown>>).find(r => r['code'] === 'sugar')?.['value'], null);
});

test('invalid changes are refused before anything would be sent', () => {
  const bad: Array<[string, Parameters<typeof applyGoalsChange>[1]]> = [
    ['empty change', {}],
    ['unknown activity level', { activityLevel: 1.3 }],
    ['basal absurdly low', { ownBasal: 100 }],
    ['energy goal absurdly high', { ownTargetEnergy: 90000 }],
    ['drinking goal out of range', { drinkLiters: 40 }],
    ['target weight out of range', { targetWeightKg: 5 }],
    ['unknown nutrient', { nutrients: [{ code: 'vitamin-c', grams: 1 }] }],
    ['nutrient without anything to set', { nutrients: [{ code: 'sugar' }] }],
    ['grams and percent together', { nutrients: [{ code: 'protein', grams: 100, percent: 30 }] }],
    ['percent on a non-macro', { nutrients: [{ code: 'sugar', percent: 10 }] }],
    ['percent not a whole number', { nutrients: [{ code: 'protein', percent: 30.5 }] }],
    ['only some macros as percent', { nutrients: [{ code: 'protein', percent: 30 }] }],
    ['percentages over 100', { nutrients: [{ code: 'protein', percent: 50 }, { code: 'carbohydrate', percent: 40 }, { code: 'fat', percent: 30 }] }],
    ['the same nutrient twice', { nutrients: [{ code: 'sugar', grams: 1 }, { code: 'sugar', grams: 2 }] }],
    ['grams out of range', { nutrients: [{ code: 'sugar', grams: 5000 }] }],
  ];
  for (const [name, change] of bad) assert.throws(() => applyGoalsChange(profileForm(), change), KtError, name);
});

test('energy ranges follow the account\'s unit', () => {
  const kj = profileForm({ energyUnit: 'kJ' });
  assert.doesNotThrow(() => applyGoalsChange(kj, { ownTargetEnergy: 7400 }));
  assert.throws(() => applyGoalsChange(kj, { ownTargetEnergy: 1700 }), KtError, '1700 kJ is far too low');
  assert.throws(() => applyGoalsChange(profileForm(), { ownTargetEnergy: 7400 }), KtError, '7400 kcal is too high');
});

test('energy values may come back one unit off, because the site stores kJ', () => {
  const after = parseGoals(profileForm({ ownBasal: 1749 }));
  assert.deepEqual(unappliedChanges({ ownBasal: 1750 }, after), []);
  assert.deepEqual(unappliedChanges({ ownBasal: 1760 }, after), ['ownBasal']);
});

test('the figures the diary really uses take precedence over the form\'s stale calculation', () => {
  const g = parseGoals(profileForm({ ownBasal: 1600 }));
  g.effective = { energyGoal: 1632, basal: 1600, maintenance: 1920, plannedDeficit: -288, activityEnergy: 0, energyGoalWithActivities: 1632 };
  assert.equal(effectiveEnergyGoal(g), 1632);
  assert.equal(effectiveBasal(g), 1600);
  assert.equal(effectiveEnergyGoal(parseGoals(profileForm())), 1783, 'without today\'s balance the form is used');
});

test('a day\'s logged activities are taken out of the goal figures again', () => {
  // Rows observed on the real site (rounded): a modelled day with 699 kcal of activity, and a day on an own fixed goal.
  const modelled = effectiveFromBalance({ target: 2377, basal: 1753, maintenance: 2796, plannedDeficit: -419, activityEnergy: 699 }, true);
  assert.equal(modelled.energyGoal, 1783);
  assert.equal(modelled.maintenance, 2097);
  assert.ok(Math.abs((modelled.plannedDeficit ?? 0) + 315) <= 1);
  assert.equal(modelled.energyGoalWithActivities, 2377);
  assert.equal(modelled.activityEnergy, 699);
  const fixed = effectiveFromBalance({ target: 1862, basal: 1754, maintenance: null, plannedDeficit: null, activityEnergy: 10 }, true);
  assert.equal(fixed.energyGoal, 1852);
  assert.equal(fixed.maintenance, null);
  // No activity, or activities switched off: nothing to take out.
  assert.equal(effectiveFromBalance({ target: 1783, basal: 1748, maintenance: 2097, plannedDeficit: -315, activityEnergy: 0 }, true).energyGoal, 1783);
  assert.equal(effectiveFromBalance({ target: 2377, basal: 1753, maintenance: 2796, plannedDeficit: -419, activityEnergy: 699 }, false).energyGoal, 2377);
});

test('warnings judge the goal without today\'s activities, so a synced walk neither raises nor hides them', () => {
  const g = parseGoals(applyGoalsChange(profileForm(), { nutrients: [{ code: 'carbohydrate', grams: 178 }] }).body);
  g.effective = effectiveFromBalance({ target: 2377, basal: 1748, maintenance: 2796, plannedDeficit: -419, activityEnergy: 699 }, true);
  assert.deepEqual(goalWarnings(g), [], 'the macros still match the base goal of 1783');
  // An own goal of 1100 with 300 kcal of activity must still trip the safety floor.
  const low = parseGoals(profileForm({ ownTargetEnergy: 1100, ownDailyDose: false }));
  low.effective = effectiveFromBalance({ target: 1400, basal: 1748, maintenance: null, plannedDeficit: null, activityEnergy: 300 }, true);
  assert.match(goalWarnings(low).join(' '), /medical supervision/);
});

test('unappliedChanges names the fields the site did not take', () => {
  const after = parseGoals(profileForm({ ownTargetEnergy: 1700 }));
  assert.deepEqual(unappliedChanges({ ownTargetEnergy: 1700 }, after), []);
  assert.deepEqual(unappliedChanges({ ownTargetEnergy: 1800, mode: 'gain' }, after).sort(), ['mode', 'ownTargetEnergy']);
  assert.deepEqual(unappliedChanges({ nutrients: [{ code: 'protein', grams: 150 }] }, after), ['nutrients.protein']);
  assert.deepEqual(unappliedChanges({ nutrients: [{ code: 'protein', grams: 144 }] }, after), []);
});

// ---------------------------------------------------------------------------
// warnings
// ---------------------------------------------------------------------------

test('warnings: nutrient goals that do not add up to the energy goal', () => {
  const g = parseGoals(profileForm());
  assert.equal(macroEnergy(g), 144 * 4 + 163 * 4 + 55 * 9);
  const w = goalWarnings(g);
  assert.equal(w.length, 1);
  assert.match(w[0]!, /1723.*1783/);

  const fixed = parseGoals(applyGoalsChange(profileForm(), { nutrients: [{ code: 'carbohydrate', grams: 178 }] }).body);
  assert.equal(macroEnergy(fixed), 1783);
  assert.deepEqual(goalWarnings(fixed), []);
});

test('warnings: a goal below basal metabolism or below the safe floor', () => {
  const low = parseGoals(profileForm({ ownTargetEnergy: 1500, ownDailyDose: false }));
  assert.match(goalWarnings(low).join(' '), /below basal metabolism/);
  const lower = parseGoals(profileForm({ ownTargetEnergy: 1100, ownDailyDose: false }));
  assert.match(goalWarnings(lower).join(' '), /medical supervision/);
});

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

function serveProfile(form: () => Record<string, unknown>, onPost?: (body: Record<string, unknown>) => void) {
  stubFetch((url, init) => {
    if (url.pathname === '/login/create') return loginOk();
    if (url.pathname === '/user/settings/profile/form') return json(envelope(form()));
    if (url.pathname.startsWith('/user/diary/summary/')) return json(envelope({ ...balancePayload({ target: '1 783' }), activityEnergyTotal: 0 }));
    if (url.pathname === '/user/settings/profile/edit') {
      onPost?.(JSON.parse(String(init?.body)));
      return json(envelope(form()));
    }
    throw new Error(`unexpected request ${url.pathname}`);
  });
}

test('updateGoals reads the form fresh, posts the whole form with the change, and reads it back', async () => {
  let current = profileForm();
  serveProfile(
    () => current,
    body => {
      current = body as ReturnType<typeof profileForm>;
    },
  );
  const r = await client().updateGoals({ nutrients: [{ code: 'carbohydrate', grams: 178 }] });
  const steps = state.calls.filter(c => c !== '/login/create').map(c => c.replace(/\/summary\/.*/, '/summary'));
  assert.deepEqual(steps, ['/user/settings/profile/form', '/user/diary/summary', '/user/settings/profile/edit', '/user/settings/profile/form', '/user/diary/summary']);
  const post = state.bodies.find(b => b.path === '/user/settings/profile/edit');
  assert.equal(post?.method, 'POST');
  const sent = post?.body as Record<string, unknown>;
  assert.equal(sent['email'], 'test@example.invalid', 'untouched fields travel back as they came');
  assert.equal(sent['weight'], 81.9);
  assert.equal(r.before.nutrients.find(n => n.code === 'carbohydrate')?.own, 163);
  assert.equal(r.after?.nutrients.find(n => n.code === 'carbohydrate')?.own, 178);
  assert.deepEqual(r.notApplied, []);
  assert.deepEqual(r.warnings, [], 'the mismatch is gone after the fix');
  assert.ok(!JSON.stringify(r).includes('test@example.invalid'));
});

test('updateGoals reports what the site did not take, and a failed read-back is not an error', async () => {
  serveProfile(() => profileForm()); // the site ignores the write
  const ignored = await client().updateGoals({ ownTargetEnergy: 1700 });
  assert.deepEqual(ignored.notApplied, ['ownTargetEnergy']);

  let reads = 0;
  stubFetch((url) => {
    if (url.pathname === '/login/create') return loginOk();
    if (url.pathname === '/user/settings/profile/form') {
      reads += 1;
      if (reads > 1) return new Response('boom', { status: 500 });
      return json(envelope(profileForm()));
    }
    if (url.pathname === '/user/settings/profile/edit') return json(envelope(profileForm()));
    throw new Error(url.pathname);
  });
  const blind = await client().updateGoals({ ownTargetEnergy: 1700 });
  assert.equal(blind.after, null);
  assert.deepEqual(blind.changed, ['ownTargetEnergy']);
});

test('updateGoals sends nothing when the change is invalid', async () => {
  serveProfile(() => profileForm());
  await assert.rejects(client().updateGoals({ activityLevel: 1.3 }), KtError);
  assert.ok(!state.calls.includes('/user/settings/profile/edit'));
});

test('a write the site rejects is an error, not a silent success', async () => {
  stubFetch((url) => {
    if (url.pathname === '/login/create') return loginOk();
    if (url.pathname === '/user/settings/profile/form') return json(envelope(profileForm()));
    return json({ requestId: null, code: 1, message: 'Neplatná hodnota', data: null });
  });
  await assert.rejects(client().updateGoals({ ownTargetEnergy: 1700 }), /Neplatná hodnota/);
});

// ---------------------------------------------------------------------------
// the energy model
// ---------------------------------------------------------------------------

function balance(date: string, intake: number | null, output = 2400, unit = 'kcal'): BalanceOutcome {
  const b: DayBalance = {
    date, energyUnit: unit, intake, target: 1783, output, basal: 1748, maintenance: 2400, plannedDeficit: -600,
    remaining: null, netBalance: intake === null ? null : intake - output, activityEnergy: 0, weight: null, nutrients: [],
  };
  return { date, status: 'ok', balance: b };
}

/** n consecutive days ending on dd.MM.yyyy `last`. */
function days(last: string, n: number): string[] {
  const [d, m, y] = last.split('.').map(Number) as [number, number, number];
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(Date.UTC(y, m - 1, d - (n - 1 - i)));
    return `${String(t.getUTCDate()).padStart(2, '0')}.${String(t.getUTCMonth() + 1).padStart(2, '0')}.${t.getUTCFullYear()}`;
  });
}

test('the model adds the energy the weight trend released to what was eaten', () => {
  const list = days('28.11.2026', 28);
  // Weight falls 0.1 kg per week, exactly linear: 28 days → 0.4 kg.
  const weights = list.filter((_, i) => i % 4 === 0).map((date, k) => ({ date, kg: Math.round((82 - ((k * 4) / 7) * 0.1) * 1000) / 1000 }));
  const m = estimateEnergyModel({ from: list[0]!, to: list.at(-1)!, outcomes: list.map(d => balance(d, 2000)), weights });
  assert.equal(m.days.logged, 28);
  assert.equal(m.averageIntake, 2000);
  assert.equal(m.siteExpenditure, 2400);
  assert.equal(m.weight?.trendKgPerWeek, -0.1);
  assert.equal(m.impliedExpenditure, 2110); // 2000 + 0.1/7 * 7700
  assert.equal(m.differenceFromSite, -290);
  assert.equal(m.confidence, 'high');
  assert.deepEqual(m.caveats, []);
});

test('days with nothing logged lower the confidence and are explained', () => {
  const list = days('28.11.2026', 28);
  const weights = list.filter((_, i) => i % 4 === 0).map((date, k) => ({ date, kg: 82 - k * 0.05 }));
  const outcomes = list.map((d, i) => balance(d, i % 2 === 0 ? 2000 : 0));
  const m = estimateEnergyModel({ from: list[0]!, to: list.at(-1)!, outcomes, weights });
  assert.equal(m.days.logged, 14);
  assert.equal(m.days.notLogged, 14);
  assert.notEqual(m.confidence, 'high');
  assert.match(m.caveats.join(' '), /Only 14 of 28 days/);
});

test('without weigh-ins there is no estimate, and the model says so', () => {
  const list = days('28.11.2026', 14);
  const none = estimateEnergyModel({ from: list[0]!, to: list.at(-1)!, outcomes: list.map(d => balance(d, 2000)), weights: [] });
  assert.equal(none.impliedExpenditure, null);
  assert.equal(none.weight, null);
  assert.equal(none.confidence, 'low');
  assert.match(none.caveats.join(' '), /no weight trend/);
  const sameDay = estimateEnergyModel({ from: list[0]!, to: list.at(-1)!, outcomes: list.map(d => balance(d, 2000)), weights: [{ date: list[3]!, kg: 82 }, { date: list[3]!, kg: 82.2 }] });
  assert.equal(sameDay.impliedExpenditure, null);
});

test('a day that is still going is left out, and unreadable days are counted', () => {
  const list = days('28.11.2026', 14);
  const outcomes: BalanceOutcome[] = list.map((d, i) => (i === 3 ? { date: d, status: 'error', error: 'boom' } : balance(d, d === list.at(-1) ? 300 : 2000)));
  const weights = [{ date: list[0]!, kg: 82 }, { date: list[13]!, kg: 82 }, { date: list[7]!, kg: 82 }, { date: list[10]!, kg: 82 }];
  const m = estimateEnergyModel({ from: list[0]!, to: list.at(-1)!, outcomes, weights, excludeDates: [list.at(-1)!] });
  assert.equal(m.averageIntake, 2000, 'the partial day must not pull the average down');
  assert.equal(m.days.excluded, 1);
  assert.equal(m.days.failed, 1);
  assert.match(m.caveats.join(' '), /not finished/);
  assert.match(m.caveats.join(' '), /could not be read/);
});

test('days with an own fixed energy goal are left out of the site\'s expenditure figure', () => {
  const list = days('28.11.2026', 28);
  const fixed = (d: string): BalanceOutcome => {
    const o = balance(d, 2000, 1700);
    if (o.status === 'ok') {
      o.balance.maintenance = null;
      o.balance.plannedDeficit = null;
      o.balance.target = 1700;
    }
    return o;
  };
  const weights = list.filter((_, i) => i % 4 === 0).map(date => ({ date, kg: 82 }));

  const allFixed = estimateEnergyModel({ from: list[0]!, to: list.at(-1)!, outcomes: list.map(fixed), weights });
  assert.equal(allFixed.siteExpenditure, null);
  assert.equal(allFixed.differenceFromSite, null);
  assert.equal(allFixed.impliedExpenditure, 2000);
  assert.match(allFixed.caveats.join(' '), /own fixed energy goal/);

  // First half fixed (reports 1700), second half modelled (reports 2400): only the modelled half counts.
  const mixed = estimateEnergyModel({ from: list[0]!, to: list.at(-1)!, outcomes: list.map((d, i) => (i < 14 ? fixed(d) : balance(d, 2000, 2400))), weights });
  assert.equal(mixed.siteExpenditure, 2400);
  assert.equal(mixed.siteExpenditureDays, 14);
  assert.equal(mixed.differenceFromSite, null, 'half the days against all of them is not a like-for-like comparison');
  assert.match(mixed.caveats.join(' '), /On 14 of 28 logged days/);
  assert.match(mixed.caveats.join(' '), /differenceFromSite is not given/);

  // When nearly all days used the site's model, the comparison is given.
  const mostly = estimateEnergyModel({ from: list[0]!, to: list.at(-1)!, outcomes: list.map((d, i) => (i < 3 ? fixed(d) : balance(d, 2000, 2400))), weights });
  assert.equal(mostly.siteExpenditureDays, 25);
  assert.equal(mostly.differenceFromSite, -400);
});

test('kilojoules use the matching energy per kilogram', () => {
  const list = days('28.11.2026', 28);
  const weights = list.filter((_, i) => i % 4 === 0).map((date) => ({ date, kg: 82 }));
  const m = estimateEnergyModel({ from: list[0]!, to: list.at(-1)!, outcomes: list.map(d => balance(d, 8400, 10000, 'kJ')), weights });
  assert.equal(m.energyUnit, 'kJ');
  assert.equal(m.impliedExpenditure, 8400, 'a flat weight means expenditure equals intake');
  const bad = list.map(d => balance(d, 8400, 10000, 'Wh'));
  assert.throws(() => estimateEnergyModel({ from: list[0]!, to: list.at(-1)!, outcomes: bad, weights }), KtError);
});

test('a noisy weight series carries an honest error margin', () => {
  const list = days('28.11.2026', 28);
  const noise = [0.4, -0.3, 0.2, -0.5, 0.3, -0.2, 0.1];
  const weights = list.filter((_, i) => i % 4 === 0).map((date, k) => ({ date, kg: 82 + noise[k]! }));
  const m = estimateEnergyModel({ from: list[0]!, to: list.at(-1)!, outcomes: list.map(d => balance(d, 2000)), weights });
  assert.ok((m.impliedExpenditureError ?? 0) > 50, 'scatter must widen the margin');
  assert.ok((m.weight?.trendErrorKgPerWeek ?? 0) > 0);
});

// ---------------------------------------------------------------------------
// client: weight series and the full model
// ---------------------------------------------------------------------------

/** Answers /statistic/summary/{date} with every weigh-in within ±15 days of the day asked about. */
function serveWeights(records: Array<{ date: string; kg: number }>, summaryDays: string[] = []) {
  stubFetch((url) => {
    if (url.pathname === '/login/create') return loginOk();
    const m = /\/statistic\/summary\/(\d{2}\.\d{2}\.\d{4})\/get/.exec(url.pathname);
    if (m) {
      summaryDays.push(m[1]!);
      const centre = noonEpoch(m[1]!);
      const near = records.filter(r => Math.abs(noonEpoch(r.date) - centre) <= 15 * 86_400_000);
      return json(envelope({ weightUnit: 'kg', weight: '81,9', weightTarget: '72', monthWeight: near.map(r => ({ from: noonEpoch(r.date), valueString: String(r.kg).replace('.', ',') })) }));
    }
    const b = /\/user\/diary\/summary\/(\d{2}\.\d{2}\.\d{4})\/get/.exec(url.pathname);
    if (b) return json(envelope({ ...balancePayload({ intake: '2 000', output: '2 400' }), date: b[1] }));
    throw new Error(`unexpected request ${url.pathname}`);
  });
}

test('the weight series merges several month windows and keeps one value per day', async () => {
  const list = days('20.11.2026', 60);
  const records = list.filter((_, i) => i % 5 === 0).map((date, k) => ({ date, kg: 85 - k * 0.1 }));
  serveWeights(records);
  const series = await client().getWeightSeries(list[0]!, list.at(-1)!);
  assert.deepEqual(series.map(s => s.date), records.map(r => r.date), 'every weigh-in, once, oldest first');
  assert.equal(series[0]?.kg, 85);
});

test('a range of one day asks the site once', async () => {
  const asked: string[] = [];
  serveWeights([{ date: PAST, kg: 82 }], asked);
  const series = await client().getWeightSeries(PAST, PAST);
  assert.deepEqual(series, [{ date: PAST, kg: 82 }]);
  assert.deepEqual(asked, [PAST]);
});

test('getEnergyModel combines the diary balance with the weigh-ins', async () => {
  const list = days('20.11.2026', 14);
  const records = list.filter((_, i) => i % 3 === 0).map((date) => ({ date, kg: 82 }));
  serveWeights(records);
  const m = await client().getEnergyModel(list[0]!, list.at(-1)!);
  assert.equal(m.days.logged, 14);
  assert.equal(m.averageIntake, 2000);
  assert.equal(m.siteExpenditure, 2400);
  assert.ok(m.weight && m.weight.points >= 4);
  void OTHER_PAST;
});
