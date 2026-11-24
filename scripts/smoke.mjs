#!/usr/bin/env node
/**
 * Live smoke test: runs the compiled client against the real kaloricketabulky.cz
 * with YOUR account, to catch the site changing under us.
 *
 *   npm run build && KT_EMAIL=... KT_PASSWORD=... node scripts/smoke.mjs
 *   ... node scripts/smoke.mjs --write      # also exercises the write paths
 *
 * Default mode only reads. With --write, every write happens on TOMORROW, which
 * must be completely empty (the run aborts otherwise), and every entry, note
 * and activity created is deleted again; a favourite is added and removed for a
 * food that was not one; the latest weight is re-saved with its own value; and a
 * few goal values (drinking goal, own basal, one carbohydrate goal) are changed
 * and put back, with the whole goals block compared to its snapshot.
 * The run ends by checking that tomorrow is empty again. Nothing on today or
 * earlier days is ever modified. Exit code 1 if any check fails.
 */

const dist = p => new URL(`../dist/${p}`, import.meta.url).href;
const { KtClient, todayCzech, enumerateDays } = await import(dist('kt/client.js'));
const { rankNutrient } = await import(dist('kt/ranking.js'));
const { summarizeBalances } = await import(dist('kt/balance.js'));
const { entriesToCsv } = await import(dist('kt/export.js'));
const { goalWarnings } = await import(dist('kt/goals.js'));

if (!process.env.KT_EMAIL || !process.env.KT_PASSWORD) {
  console.error('Set KT_EMAIL and KT_PASSWORD in the environment first.');
  process.exit(2);
}
const WRITE = process.argv.includes('--write');
const client = new KtClient({ email: process.env.KT_EMAIL, password: process.env.KT_PASSWORD });

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
};
const section = t => console.log(`\n=== ${t} ===`);
const shift = (date, days) => {
  const [d, m, y] = date.split('.').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${String(t.getUTCDate()).padStart(2, '0')}.${String(t.getUTCMonth() + 1).padStart(2, '0')}.${t.getUTCFullYear()}`;
};

const today = todayCzech();
const tomorrow = shift(today, 1);
const weekAgo = shift(today, -6);
console.log(`today ${today}, tomorrow ${tomorrow}, mode: ${WRITE ? 'READ + WRITE (tomorrow only)' : 'read-only'}`);

// ------------------------------------------------------------------ reads
section('Diary entries');
const day = await client.getDayEntries(today);
const lines = day.meals.flatMap(m => m.entries);
ok('today has a consistent entry count', lines.length === day.entryCount, `${day.entryCount} entries`);
ok('no user record leaks into notes', !/password|@/.test(JSON.stringify(day.notes ?? [])));
const range = await client.getDiaryRange(weekAgo, today);
ok('7-day range, both end days', range.length === 7 && range[0].date === weekAgo && range[6].date === today);
console.log('statuses:', range.map(o => o.status[0]).join(' '));

section('Ranking over 30 days (cache makes repeats cheap)');
const t0 = Date.now();
const long = await client.getDiaryRange(shift(today, -29), today, 90);
const ranked = rankNutrient(long, 'protein', 3);
ok('30 days ranked', ranked.ranking.length > 0, ranked.ranking.map(f => `${f.title} ${f.total} g`).join(' | '));
const t1 = Date.now();
await client.getDiaryRange(shift(today, -29), today, 90);
ok('second pass is served from the cache', Date.now() - t1 < (t1 - t0) / 2 + 50, `${t1 - t0} ms -> ${Date.now() - t1} ms`);

section('Balance and weight');
const bal = await client.getDayBalance(today);
ok('balance has energy figures', bal.intake !== null && bal.output !== null, `intake ${bal.intake}, output ${bal.output}, target ${bal.target}, net ${bal.netBalance} ${bal.energyUnit}`);
ok('nutrient goals present', bal.nutrients.some(n => n.code === 'protein' && n.goal !== null), bal.nutrients.filter(n => ['protein', 'carbohydrate', 'fat'].includes(n.code)).map(n => `${n.code} ${n.actual}/${n.goal} ${n.unit}`).join(', '));
const balRange = summarizeBalances(await client.getBalanceRange(shift(today, -13), today));
ok('14-day balance averages', balRange.days.logged > 0 && balRange.averageIntake !== null, `${balRange.days.logged} logged days, avg intake ${balRange.averageIntake}, avg net ${balRange.averageNetBalance}`);
const weights = await client.getWeightHistory(today);
ok('weight history', weights.records.length > 0, `${weights.records.length} records, current ${weights.current}, target ${weights.target}`);

section('Favourites, common foods, recipes, activities');
const favs = await client.listFavoriteFoods();
ok('favourite foods listed', favs.length > 0, `${favs.length} favourites`);
const common = await client.listCommonFoods();
ok('common foods listed', common.length > 0, `${common.length} foods`);
const meals = await client.listMeals();
if (meals[0]) {
  const details = await client.getMealDetails(meals[0].id);
  const withNutrition = details.ingredients.filter(i => i.nutrition).length;
  ok('recipe details', details.ingredients.length > 0 && withNutrition > 0, `"${details.title}": ${details.ingredients.length} ingredients, ${withNutrition} with nutrition`);
} else {
  console.log('SKIP  no saved recipes');
}
const acts = await client.searchActivities('chůze', 3);
ok('activity search', acts.length > 0, acts.map(a => a.title).join(' | '));

section('CSV export');
const { csv, rows } = entriesToCsv(range);
ok('CSV rows match the entries', rows === range.reduce((n, o) => n + (o.status === 'error' ? 0 : o.day.entryCount), 0), `${rows} rows`);
ok('CSV has a header', csv.startsWith('date,meal,title'));

section('Goals and energy model');
const goals = await client.getGoals();
ok('goals read', ['lose', 'maintain', 'gain'].includes(goals.mode) && goals.nutrients.length > 0, `${goals.mode}, goal ${goals.targetEnergy.own ?? goals.targetEnergy.computed} ${goals.energyUnit}`);
ok('no personal field in goals', !/@|password|guid|token/i.test(JSON.stringify(goals)));
console.log('warnings:', goalWarnings(goals).join(' | ') || 'none');
const modelTo = shift(today, -1);
const model = await client.getEnergyModel(shift(modelTo, -27), modelTo);
ok('energy model over 28 days', model.period.days === 28 && model.days.logged <= 28, `confidence ${model.confidence}, implied ${model.impliedExpenditure} vs site ${model.siteExpenditure} ${model.energyUnit}`);
console.log('caveats:', model.caveats.join(' | ') || 'none');

section('Validation');
for (const bad of ['31.02.2026', '2026-11-23']) {
  await client.getDayEntries(bad).then(() => ok(`rejects ${bad}`, false), e => ok(`rejects ${bad}`, true, e.message.slice(0, 50)));
}
await client.getDiaryRange(shift(today, -14), today).then(() => ok('rejects 15 days for entries', false), e => ok('rejects 15 days for entries', /maximum is 14/.test(e.message)));
ok('90 days allowed for aggregates', enumerateDays(shift(today, -89), today, 90).length === 90);

// ------------------------------------------------------------------ writes
if (WRITE) {
  section(`Writes on ${tomorrow} (must be empty; everything is removed again)`);
  const before = await client.getDayEntries(tomorrow, { fresh: true });
  const dirty = before.entryCount + (before.notes?.length ?? 0) + (before.activities?.length ?? 0) + before.meals.reduce((n, m) => n + (m.notes?.length ?? 0), 0);
  if (dirty !== 0) {
    console.log(`ABORT  ${tomorrow} is not empty (${dirty} items) — refusing to write there.`);
    process.exit(1);
  }

  const created = { entries: [], notes: [], activities: [] };
  const track = async () => {
    const d = await client.getDayEntries(tomorrow, { fresh: true });
    created.entries = d.meals.flatMap(m => m.entries.map(e => e.id));
    created.notes = [...(d.notes ?? []), ...d.meals.flatMap(m => m.notes ?? [])].map(n => n.id);
    created.activities = (d.activities ?? []).map(a => a.id);
  };
  try {
    // food: add -> edit -> switch unit
    await client.logFood({ foodId: '47c3415addecabd5', amount: 10, unitId: '0000000000000001', meal: '1', date: tomorrow });
    await track();
    ok('food added', created.entries.length === 1);
    const id = created.entries[0];
    const edit = await client.updateDiaryEntry({ date: tomorrow, entryId: id, amount: 25 });
    ok('amount edited to 25 g', edit.after?.quantity.total === 25, `${edit.before.quantity.raw} -> ${edit.after?.quantity.raw}`);

    // notes: day-level and meal-level
    const n1 = await client.addNote({ date: tomorrow, text: 'Smoke test — day note' });
    const n2 = await client.addNote({ date: tomorrow, text: 'Smoke test — meal note', meal: '3' });
    ok('day note found afterwards', n1.added?.meal === null && n1.added?.note.text.startsWith('Smoke'));
    ok('meal note found afterwards', n2.added?.meal === 'Oběd');

    // activity
    if (acts[0]) {
      const a = await client.logActivity({ activityId: acts[0].id, minutes: 30, date: tomorrow });
      ok('activity logged for 30 minutes', a.added?.durationMinutes === 30, `${a.added?.title}, ${a.added?.energy} kcal`);
    }

    // copy: a real meal from today into tomorrow's dinner
    const source = day.meals.find(m => m.entries.length > 0);
    if (source) {
      const copy = await client.copyMeal({ fromDate: today, meal: source.id, toDate: tomorrow, toMeal: '5' });
      ok(`meal "${copy.fromMeal}" copied to dinner`, copy.added === copy.lines, `${copy.added} of ${copy.lines} entries`);
    }
    await track();
  } catch (e) {
    ok('write steps completed', false, e.message);
  } finally {
    await track().catch(() => {});
    for (const id of created.entries) await client.deleteDiaryEntry({ date: tomorrow, entryId: id }).catch(e => ok(`cleanup entry ${id.slice(0, 6)}`, false, e.message));
    for (const id of created.notes) await client.deleteNote({ date: tomorrow, noteId: id }).catch(e => ok(`cleanup note ${id.slice(0, 6)}`, false, e.message));
    for (const id of created.activities) await client.deleteActivity({ date: tomorrow, activityId: id }).catch(e => ok(`cleanup activity ${id.slice(0, 6)}`, false, e.message));
    const after = await client.getDayEntries(tomorrow, { fresh: true });
    const left = after.entryCount + (after.notes?.length ?? 0) + (after.activities?.length ?? 0) + after.meals.reduce((n, m) => n + (m.notes?.length ?? 0), 0);
    ok(`${tomorrow} is empty again`, left === 0, `${left} items left`);
  }

  // favourites: a food that is not one yet
  const hits = await client.search('celer', 10);
  const food = hits.find(h => !favs.some(f => f.id === h.id));
  if (food) {
    try {
      const add = await client.setFavoriteFood(food.id, true);
      ok(`"${food.title}" added to favourites`, add.confirmed === true);
    } finally {
      const rem = await client.setFavoriteFood(food.id, false);
      ok('and removed again', rem.confirmed === true);
    }
    ok('favourites restored', (await client.listFavoriteFoods()).length === favs.length);
  }

  // goals: change a few harmless values, check, and put every one back
  {
    const snapshot = await client.getGoals();
    const weightRecords = (await client.getWeightHistory(today)).records.length;
    const carb = snapshot.nutrients.find(n => n.code === 'carbohydrate');
    try {
      const r = await client.updateGoals({
        drinkLiters: snapshot.drinkLiters === 3.3 ? 3.4 : 3.3,
        ownBasal: 1750,
        ...(carb && carb.own !== null ? { nutrients: [{ code: 'carbohydrate', grams: carb.own + 1 }] } : {}),
      });
      ok('goals changed and read back', r.notApplied.length === 0 && Math.abs((r.after?.basal.own ?? 0) - 1750) <= 1, `changed ${r.changed.join(', ')}`);
      ok('the diary\'s energy goal follows the own basal', r.after?.effective?.energyGoal !== snapshot.effective?.energyGoal, `${snapshot.effective?.energyGoal} -> ${r.after?.effective?.energyGoal}`);
    } finally {
      const back = await client.updateGoals({
        drinkLiters: snapshot.drinkLiters,
        ownBasal: snapshot.basal.own,
        ...(carb && carb.own !== null ? { nutrients: [{ code: 'carbohydrate', grams: carb.own }] } : {}),
      });
      ok('goals restored', back.notApplied.length === 0);
    }
    const restored = await client.getGoals();
    const bare = g => JSON.stringify({ ...g, effective: undefined });
    ok('goals identical to before', bare(restored) === bare(snapshot));
    ok('effective figures restored', restored.effective?.energyGoal === snapshot.effective?.energyGoal && restored.effective?.maintenance === snapshot.effective?.maintenance);
    ok('no weigh-in was added by saving the profile', (await client.getWeightHistory(today)).records.length === weightRecords);
  }

  // weight: re-save the latest record with its own value — one record per date, so nothing changes
  const latest = weights.records.at(-1);
  if (latest) {
    const w = await client.logWeight({ weightKg: latest.value, date: latest.date });
    const again = await client.getWeightHistory(today);
    ok('weight re-saved unchanged', w.recorded === latest.value && again.records.length === weights.records.length, `${latest.date}: ${latest.value} kg`);
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
