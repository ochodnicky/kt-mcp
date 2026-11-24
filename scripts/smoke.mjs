#!/usr/bin/env node
/**
 * Live smoke test: runs the compiled client against the real kaloricketabulky.cz
 * with YOUR account, to catch the site changing under us.
 *
 *   npm run build && KT_EMAIL=... KT_PASSWORD=... node scripts/smoke.mjs
 *   ... node scripts/smoke.mjs --write      # also exercises the write paths
 *
 * Default mode only reads. With --write, every write happens on the first day from
 * tomorrow on that, together with the day after it, is completely empty (the run aborts if there is none within two weeks), and every entry, note
 * and activity created is deleted again; a favourite is added and removed for a
 * food that was not one; the latest weight is re-saved with its own value; a test
 * body-measurement tracker is started and removed again (only when none of that
 * kind exists); a test activity is favourited and used as a weekly routine, an activity's duration is changed, a day is saved as a template and written to the day after tomorrow (all removed again); own food and own activity lines are logged, a throwaway saved recipe is created, edited and deleted (your own recipes are never touched); a test line is moved between meals and, if the day after
 * tomorrow is also empty, to that day and back; and a few goal values (drinking goal, own basal, one carbohydrate goal) are changed
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
const { summarizeHydration } = await import(dist('kt/stats.js'));

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
let tomorrow = shift(today, 1); // in --write mode this becomes the first empty test day (see below)
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

section('Drinking, analysis, measurements, recipes, extra nutrients');
const hydration = await client.getHydration(weekAgo, today);
const hs = summarizeHydration(hydration);
ok('drinking for 7 days', hydration.length === 7 && hydration.every(d => d.litres !== null && d.goalLitres !== null), `avg ${hs.averageLitres} l, ${hs.daysWithDrinks} days with drinks, goal ${hs.averageGoalLitres} l`);
const year = await client.getHydration(shift(today, -364), today);
ok('drinking works for a whole year', year.length === 365 && year.some(d => d.litres !== null), `${year.filter(d => (d.litres ?? 0) > 0).length} days with drinks`);
const { analysis, tips } = await client.getGoalAnalysis(weekAgo, shift(today, -1));
ok('analysis has the main nutrients', ['Bílkoviny', 'Sacharidy', 'Tuky'].every(t => analysis.nutrients.some(n => n.title === t && n.averageG !== null)), analysis.nutrients.map(n => `${n.title} ${n.percentOfGoal}%`).join(', '));
ok('analysis has energy, calcium in mg and sources', analysis.energy?.unit === 'kcal' && (analysis.calcium === null || analysis.calcium.unit === 'mg') && analysis.sourcesByFood.length > 0, `energy ${analysis.energy?.average}/${analysis.energy?.goal}, ${analysis.sourcesByFood.length} source groups`);
console.log('tips:', tips.map(t => t.title).join(' | ') || 'none');
const lunchOnly = await client.getGoalAnalysis(weekAgo, shift(today, -1), '3');
ok('analysis narrowed to one meal differs from all meals', JSON.stringify(lunchOnly.analysis.nutrients) !== JSON.stringify(analysis.nutrients) || lunchOnly.analysis.recordsMissing !== null);
const kinds = await client.listTrackTypes();
ok('14 kinds of measurement', kinds.length === 14 && kinds.every(k => k.name && k.unit), kinds.map(k => `${k.name} [${k.unit}]`).slice(0, 4).join(', ') + ', …');
const trackersNow = await client.listTrackers(shift(today, -364), today);
console.log(`trackers on the account: ${trackersNow.length}${trackersNow.length ? ' (' + trackersNow.map(t => `${t.name}: ${t.values.length}`).join(', ') + ')' : ''}`);
const recipeTags = await client.listRecipeTags();
ok('recipe tags', recipeTags.length > 10 && recipeTags.some(t => t.slug === 'vecere'), `${recipeTags.length} tags`);
const found = await client.searchRecipes({ query: 'kuřecí', tags: ['večeře'], sort: 'best_rated', limit: 5 });
ok('recipe search', found.total > 0 && found.recipes.length > 0 && found.recipes.length <= 5, `${found.total} matches, first "${found.recipes[0]?.title}"`);
const ranged = await client.searchRecipes({ nutrient: 'energy', min: 100, max: 200, limit: 10 });
ok('recipe energy range per 100 g is respected', ranged.recipes.length > 0 && ranged.recipes.every(r => r.per100g.energy !== null && r.per100g.energy >= 99 && r.per100g.energy <= 201), `${ranged.total} matches`);
const quick = await client.searchRecipes({ maxPreparationMinutes: 15, limit: 5 });
const quickDetails = await Promise.all(quick.recipes.map(r => client.getRecipe(r.id)));
ok('preparation time limit is "at most"', quickDetails.every(d => d.preparationMinutes === null || d.preparationMinutes <= 15), quickDetails.map(d => d.preparationMinutes).join(','));
if (found.recipes[0]) {
  const rd = await client.getRecipe(found.recipes[0].id);
  ok('recipe detail has ingredients, steps and nutrition', rd.ingredients.length > 0 && rd.total.energy !== null, `${rd.ingredients.length} ingredients, ${rd.steps.length} steps, ${rd.portions ?? 'no'} portions`);
  const per100 = rd.totalWeightG ? (rd.total.energy / rd.totalWeightG) * 100 : null;
  const listed = found.recipes[0].per100g.energy;
  ok('detail agrees with the list per 100 g', per100 !== null && listed !== null && Math.abs(per100 - listed) / listed < 0.05, `${per100?.toFixed(1)} vs ${listed}`);
}
const calciumFromEntries = lines.every(l => l.nutrients.calcium === null) ? null : lines.reduce((sum, l) => sum + (l.nutrients.calcium ?? 0), 0) * 1000;
const calciumGoal = bal.nutrients.find(n => n.code === 'calcium');
ok('calcium from the entries matches the site\'s day balance (mg)', calciumFromEntries === null || calciumGoal?.actual === null || Math.abs(calciumFromEntries - calciumGoal.actual) / Math.max(calciumGoal.actual, 1) < 0.02, `${calciumFromEntries?.toFixed(0)} vs ${calciumGoal?.actual} ${calciumGoal?.unit}`);

section('Favourite and regular activities, day templates (read-only)');
const favActs = await client.listFavoriteActivities();
console.log(`favourite activities: ${favActs.length}${favActs.length ? ' (' + favActs.map(a => a.title).join(', ') + ')' : ''}`);
ok('favourite activities have the figures the site shows', favActs.every(a => a.kcalPerKgPerMinute !== null && a.kcalPerMinute !== null));
const commonActs = await client.listCommonActivities();
console.log(`common activities: ${commonActs.length}${commonActs.length ? ' (' + commonActs.map(a => a.title).join(', ') + ')' : ' (the site has none yet)'}`);
ok('common activities parse', commonActs.every(a => a.id && a.title));
const routine = await client.listRegularActivities();
console.log(`regular activities: ${routine.length}${routine.length ? ' (' + routine.map(r => `${r.weekday} ${r.title} ${r.minutes} min`).join(', ') + ')' : ''}`);
ok('regular activities parse', routine.every(r => r.id.length === 32 && r.minutes !== null));
const templates = await client.listDayTemplates();
console.log(`day templates: ${templates.length}${templates.length ? ' (' + templates.map(t => t.title).join(', ') + ')' : ''}`);
if (templates[0]) {
  const tc = await client.getDayTemplate(templates[0].id);
  ok('a template can be read', tc.foodCount === tc.meals.reduce((n, m) => n + m.items.length, 0), `"${tc.title}": ${tc.foodCount} lines, ${tc.notes.length} notes`);
}

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
  // The user plans meals ahead, so tomorrow may hold real data. Use the first day (from tomorrow on) that, together
  // with the day after it, is completely empty; nothing is ever written to a day that has content.
  const isEmpty = async d => { const x = await client.getDayEntries(d, { fresh: true }); return x.entryCount + (x.notes?.length ?? 0) + (x.activities?.length ?? 0) + x.meals.reduce((n, m) => n + (m.notes?.length ?? 0), 0) === 0; };
  for (let offset = 1; offset <= 14; offset += 1) {
    const d = shift(today, offset);
    if ((await isEmpty(d)) && (await isEmpty(shift(d, 1)))) { tomorrow = d; break; }
  }
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

  // tracked measurements: start a test tracker, add and remove a value, then delete the whole test tracker
  {
    const KIND = 'Obvod krku';
    const window = [shift(today, -1094), today];
    const existing = (await client.listTrackers(...window)).find(t => t.name === KIND);
    if (existing) {
      console.log(`SKIP  "${KIND}" is already tracked on this account — not touching it`);
    } else {
      let trackerId = null;
      try {
        const first = await client.addTrackedValue({ measurement: 'krku', value: 38.5 });
        ok('tracker started with today\'s value', first.createdTracker && first.recorded === 38.5, `${first.tracker} [${first.unit}]`);
        const list1 = await client.listTrackers(...window);
        trackerId = list1.find(t => t.name === KIND)?.id ?? null;
        ok('tracker is listed', trackerId !== null);
        await client.addTrackedValue({ measurement: 'krku', value: 38.2, date: shift(today, -1) });
        const list2 = (await client.listTrackers(...window)).find(t => t.id === trackerId);
        ok('a value for yesterday was added', list2?.values.length === 2 && list2.values[0].date === shift(today, -1), list2?.values.map(v => `${v.date}=${v.value}`).join(', '));
        await client.addTrackedValue({ measurement: 'krku', value: 38.9 });
        const list3 = (await client.listTrackers(...window)).find(t => t.id === trackerId);
        const todays = list3?.values.filter(v => v.date === today) ?? [];
        ok('a second value on the same day replaces the first', todays.length === 1 && todays[0].value === 38.9, todays.map(v => v.value).join(' and '));
        const yesterdayValue = list3?.values.find(v => v.date === shift(today, -1));
        const del = await client.deleteTrackedValue(yesterdayValue.id);
        ok('one value deleted and confirmed', del.confirmed === true && del.value === 38.2);
        await client.deleteTrackedValue('0'.repeat(32)).then(() => ok('an unknown id is refused', false), e => ok('an unknown id is refused', /No tracked measurement/.test(e.message)));
        const weightBefore = (await client.getWeightHistory(today)).records.length;
        ok('weight records untouched', weightBefore === weights.records.length);
      } catch (e) {
        ok('tracker steps completed', false, e.message);
      } finally {
        const id = trackerId ?? (await client.listTrackers(...window).catch(() => [])).find(t => t.name === KIND)?.id;
        if (id) await client.deleteTracker(id).catch(e => ok('cleanup tracker', false, e.message));
        const left = (await client.listTrackers(...window)).some(t => t.name === KIND);
        ok('the test tracker is gone again', !left);
      }
    }
  }

  // moving a line: another meal, then another day (the day after tomorrow must be empty too)
  {
    const dayAfter = shift(tomorrow, 1);
    const dayAfterDay = await client.getDayEntries(dayAfter, { fresh: true });
    const dayAfterEmpty = dayAfterDay.entryCount === 0;
    const where = { date: tomorrow, ids: [] };
    try {
      await client.logFood({ foodId: '47c3415addecabd5', amount: 10, unitId: '0000000000000001', meal: '1', date: tomorrow });
      const entryId = (await client.getDayEntries(tomorrow, { fresh: true })).meals.flatMap(m => m.entries)[0].id;
      const toLunch = await client.moveDiaryEntry({ date: tomorrow, entryId, meal: '3' });
      ok('moved to lunch', toLunch.confirmed === true && toLunch.to.meal === 'Oběd', `${toLunch.from.meal} -> ${toLunch.to.meal}`);
      if (dayAfterEmpty) {
        const toNext = await client.moveDiaryEntry({ date: tomorrow, entryId, toDate: dayAfter });
        ok('moved to the next day, meal kept', toNext.confirmed === true && toNext.to.date === dayAfter && toNext.to.meal === 'Oběd', `${toNext.to.date} ${toNext.to.meal}`);
        where.date = dayAfter;
        const back = await client.moveDiaryEntry({ date: dayAfter, entryId, toDate: tomorrow, meal: '2' });
        ok('moved back with a new meal in one call', back.confirmed === true && back.to.date === tomorrow && back.to.meal === 'Dopolední svačina', `${back.to.date} ${back.to.meal}`);
        where.date = tomorrow;
      } else {
        console.log(`SKIP  ${dayAfter} is not empty — day move not tested`);
      }
    } catch (e) {
      ok('move steps completed', false, e.message);
    } finally {
      for (const d of [tomorrow, dayAfter]) {
        const cur = await client.getDayEntries(d, { fresh: true }).catch(() => null);
        if (!cur) continue;
        if (d === dayAfter && !dayAfterEmpty) continue;
        for (const m of cur.meals) for (const e of m.entries) await client.deleteDiaryEntry({ date: d, entryId: e.id }).catch(err => ok(`cleanup entry on ${d}`, false, err.message));
      }
      const t = await client.getDayEntries(tomorrow, { fresh: true });
      const n = dayAfterEmpty ? (await client.getDayEntries(dayAfter, { fresh: true })).entryCount : 0;
      ok('both test days are empty again', t.entryCount === 0 && n === 0, `${t.entryCount} and ${n} entries left`);
    }
  }

  // favourite activity, weekly routine and an activity edit
  {
    const hit = (await client.searchActivities('plavání', 5)).find(h => !favActs.some(f => f.id === h.id) && !routine.some(r => r.activityId === h.id));
    if (!hit) {
      console.log('SKIP  no suitable test activity (all swimming activities are already favourites or regular)');
    } else {
      let regularIds = [];
      try {
        const add = await client.setFavoriteActivity(hit.id, true);
        ok(`"${hit.title}" added to the favourite activities`, add.confirmed === true);
        const fav = (await client.listFavoriteActivities()).find(f => f.id === hit.id);
        ok('and listed with its figures', !!fav && fav.kcalPerMinute !== null, fav ? `${fav.kcalPerMinute} kcal/min` : '');
      } finally {
        const rem = await client.setFavoriteActivity(hit.id, false);
        ok('favourite activity removed again', rem.confirmed === true);
        ok('favourite activities restored', (await client.listFavoriteActivities()).length === favActs.length);
      }
      try {
        const r = await client.addRegularActivity({ activityId: hit.id, weekdays: ['sunday', 'saturday'], minutes: 30 });
        regularIds = r.added.map(a => a.id);
        ok('weekly activity added on two weekdays', r.added.length === 2 && r.added.every(a => a.minutes === 30), r.added.map(a => `${a.weekday} ${a.minutes} min`).join(', '));
        await client.addRegularActivity({ activityId: hit.id, weekdays: ['sunday'], minutes: 30 }).then(() => ok('the same activity on the same weekday is refused', false), e => ok('the same activity on the same weekday is refused', /already a regular activity/.test(e.message)));
        ok('nothing was written to a diary day by the routine', (await client.getDayEntries(tomorrow, { fresh: true })).activities?.length === 0);
      } catch (e) {
        ok('weekly activity steps completed', false, e.message);
      } finally {
        const now = (await client.listRegularActivities().catch(() => [])).filter(x => x.activityId === hit.id);
        for (const x of now) await client.deleteRegularActivity(x.id).catch(err => ok('cleanup regular activity', false, err.message));
        const left = (await client.listRegularActivities()).filter(x => x.activityId === hit.id).length;
        ok('the test weekly activity is gone again', left === 0);
        ok('the routine is as before', (await client.listRegularActivities()).length === routine.length);
      }
      try {
        await client.logActivity({ activityId: hit.id, minutes: 30, date: tomorrow });
        const a0 = (await client.getDayEntries(tomorrow, { fresh: true })).activities[0];
        const upd = await client.updateActivity({ date: tomorrow, activityId: a0.id, minutes: 45 });
        ok('activity duration changed 30 -> 45 min', upd.after?.durationMinutes === 45 && upd.before.durationMinutes === 30 && upd.after.energy > upd.before.energy, `${upd.before.energy} -> ${upd.after?.energy} kcal`);
      } catch (e) {
        ok('activity edit steps completed', false, e.message);
      } finally {
        const d = await client.getDayEntries(tomorrow, { fresh: true });
        for (const a of d.activities ?? []) await client.deleteActivity({ date: tomorrow, activityId: a.id }).catch(err => ok('cleanup activity', false, err.message));
        ok('tomorrow has no activities again', ((await client.getDayEntries(tomorrow, { fresh: true })).activities ?? []).length === 0);
      }
    }
  }

  // day template: save tomorrow as a template, read it, write it to the day after tomorrow, delete it
  {
    const dayAfter = shift(tomorrow, 1);
    const TITLE = 'KT smoke test';
    const dayAfterDay = await client.getDayEntries(dayAfter, { fresh: true });
    const clean = dayAfterDay.entryCount + (dayAfterDay.notes?.length ?? 0) === 0;
    if (!clean || (await client.listDayTemplates()).some(t => t.title === TITLE)) {
      console.log(`SKIP  ${dayAfter} is not empty or a "${TITLE}" template exists — template test not run`);
    } else {
      let templateId = null;
      try {
        await client.logFood({ foodId: '47c3415addecabd5', amount: 10, unitId: '0000000000000001', meal: '1', date: tomorrow });
        await client.addNote({ date: tomorrow, text: 'Smoke test — template note' });
        const saved = await client.saveDayAsTemplate({ date: tomorrow, title: TITLE, includeNotes: true });
        templateId = saved.template?.id ?? null;
        ok('day saved as a template and identified', templateId !== null && saved.entries === 1);
        const tc = await client.getDayTemplate(templateId);
        ok('template shows the food and the note', tc.foodCount === 1 && tc.meals[0]?.meal === 'Snídaně' && tc.notes.some(n => n.startsWith('Smoke')), `${tc.meals[0]?.items[0]?.title} ${tc.meals[0]?.items[0]?.amount}`);
        const applied = await client.applyDayTemplate({ templateId, dates: [dayAfter] });
        ok('template written to the day after tomorrow', applied.days[0].entriesAfter - applied.days[0].entriesBefore === applied.expectedFoods, `${applied.days[0].entriesBefore} -> ${applied.days[0].entriesAfter}`);
        const written = await client.getDayEntries(dayAfter, { fresh: true });
        ok('its note came along', [...(written.notes ?? []), ...written.meals.flatMap(m => m.notes ?? [])].some(n => n.text.startsWith('Smoke')));
      } catch (e) {
        ok('template steps completed', false, e.message);
      } finally {
        if (templateId) {
          const del = await client.deleteDayTemplate(templateId).catch(err => ({ confirmed: false, err: err.message }));
          ok('template deleted', del.confirmed === true, del.err ?? '');
        }
        for (const d of [tomorrow, dayAfter]) {
          const x = await client.getDayEntries(d, { fresh: true });
          for (const m of x.meals) for (const e of m.entries) await client.deleteDiaryEntry({ date: d, entryId: e.id }).catch(() => {});
          for (const n of [...(x.notes ?? []), ...x.meals.flatMap(m => m.notes ?? [])]) await client.deleteNote({ date: d, noteId: n.id }).catch(() => {});
        }
        const a = await client.getDayEntries(tomorrow, { fresh: true });
        const b = await client.getDayEntries(dayAfter, { fresh: true });
        ok('both test days are empty again', a.entryCount + (a.notes?.length ?? 0) + b.entryCount + (b.notes?.length ?? 0) === 0);
        ok('the templates are as before', (await client.listDayTemplates()).length === templates.length);
      }
    }
  }

  // own food and own activity, then a throwaway saved recipe that is edited and deleted
  {
    try {
      const food = await client.logCustomFood({ title: 'KT smoke vlastní jídlo', energy: 400, meal: '3', date: tomorrow, nutrients: { protein: 30, carbohydrate: 40, fat: 10, fibre: 5, sugar: 8, saturatedFat: 3, salt: 1.2, alcohol: 4 } });
      const e = food.added;
      ok('own food logged with the values given', !!e && e.energy === 400 && e.nutrients.protein === 30 && e.nutrients.salt === 1.2 && e.nutrients.alcohol === 4 && e.nutrients.calcium === null, e ? `${e.title}: ${e.energy} ${food.energyUnit}` : 'not identified');
      const plain = await client.logCustomFood({ title: 'KT smoke jen energie', energy: 120, meal: '1', date: tomorrow });
      ok('own food with energy only keeps the nutrients unknown', !!plain.added && plain.added.energy === 120 && plain.added.nutrients.protein === null && plain.added.nutrients.fat === null);
      ok('an own food is not added to the database', (await client.search('KT smoke vlastní', 5)).length === 0);
      const act = await client.logCustomActivity({ title: 'KT smoke vlastní aktivita', minutes: 45, energy: 210, date: tomorrow });
      ok('own activity logged with the values given', act.added?.durationMinutes === 45 && act.added.energy === 210, `${act.added?.title} ${act.added?.durationMinutes} min, ${act.added?.energy} kcal`);
      ok('an own activity is not added to the catalogue', (await client.searchActivities('KT smoke vlastní', 5)).length === 0);
      ok('favourites and common foods are unaffected', (await client.listFavoriteFoods()).length === favs.length && (await client.listCommonFoods()).length === common.length);
    } catch (e) {
      ok('own food and activity steps completed', false, e.message);
    } finally {
      const d = await client.getDayEntries(tomorrow, { fresh: true });
      for (const m of d.meals) for (const x of m.entries) await client.deleteDiaryEntry({ date: tomorrow, entryId: x.id }).catch(err => ok('cleanup entry', false, err.message));
      for (const a of d.activities ?? []) await client.deleteActivity({ date: tomorrow, activityId: a.id }).catch(err => ok('cleanup activity', false, err.message));
      const e = await client.getDayEntries(tomorrow, { fresh: true });
      ok('tomorrow is empty again after the own items', e.entryCount + (e.activities?.length ?? 0) === 0);
    }

    const mealsBefore = await client.listMeals();
    let mealId = null;
    try {
      const carrot = (await client.search('mrkev', 3))[0];
      mealId = await client.createMeal({ title: 'KT smoke recipe', ingredients: [{ foodId: '47c3415addecabd5', amount: 100 }, { foodId: '47c3415addecabd5', amount: 50 }] });
      // two lines of the same food: changing by food id must be refused as ambiguous
      await client.changeMealIngredients({ mealId, change: [{ foodId: '47c3415addecabd5', amount: 5 }] }).then(() => ok('a food that is in the recipe twice is refused', false), e => ok('a food that is in the recipe twice is refused', /2 times/.test(e.message)));
      const named = await client.updateMeal({ mealId, title: 'KT smoke recipe 2', portions: 4, steps: ['Krok jedna', 'Krok dvě'] });
      ok('recipe renamed, given portions and steps', named.confirmed === true && named.now.title === 'KT smoke recipe 2' && named.now.portions === 4 && named.now.steps.length === 2);
      const swapped = await client.changeMealIngredients({ mealId, remove: ['47c3415addecabd5'].filter(() => false), add: [{ foodId: carrot.id, amount: 80 }] });
      ok('an ingredient was added', swapped.confirmed === true && swapped.now.ingredients.some(i => i.foodId === carrot.id && i.count === 80), swapped.now.ingredients.map(i => `${i.title} ${i.count}`).join(', '));
      const expected = (await client.getNutrition('47c3415addecabd5', 150, '0000000000000001')).energy + (await client.getNutrition(carrot.id, 80, '0000000000000001')).energy;
      const now = (await client.listMeals()).find(m => m.id === mealId);
      ok('the site recomputed the energy from the food ids', Math.abs(now.energy - expected) <= 1.5, `${now.energy} vs ${expected.toFixed(1)} ${now.energyUnit}`);
      // drop the duplicate cucumber lines by rebuilding: remove is refused while ambiguous, so edit a one-line recipe instead
      const second = await client.createMeal({ title: 'KT smoke recipe single', ingredients: [{ foodId: '47c3415addecabd5', amount: 100 }, { foodId: carrot.id, amount: 40 }] });
      try {
        const changed = await client.changeMealIngredients({ mealId: second, change: [{ foodId: carrot.id, amount: 200 }], remove: ['47c3415addecabd5'] });
        ok('an amount was changed and another ingredient removed', changed.confirmed === true && changed.now.ingredients.length === 1 && changed.now.ingredients[0].count === 200, changed.now.ingredients.map(i => `${i.title} ${i.count}`).join(', '));
        await client.changeMealIngredients({ mealId: second, remove: [carrot.id] }).then(() => ok('the last ingredient cannot be removed', false), e => ok('the last ingredient cannot be removed', /at least one ingredient/.test(e.message)));
        const cleared = await client.updateMeal({ mealId: second, steps: [] });
        ok('steps can be cleared', cleared.confirmed === true && cleared.now.steps.length === 0);
        const detail = await client.getMealDetails(second);
        ok('the edited recipe is readable with get_meal_details', detail.ingredients.length === 1);
      } finally {
        await client.deleteMeal(second).catch(err => ok('cleanup second recipe', false, err.message));
      }
    } catch (e) {
      ok('recipe edit steps completed', false, e.message);
    } finally {
      if (mealId) await client.deleteMeal(mealId).catch(err => ok('cleanup recipe', false, err.message));
      const left = await client.listMeals();
      ok('the saved recipes are as before', left.length === mealsBefore.length && left.every(m => mealsBefore.some(b => b.id === m.id)), `${left.length} recipes`);
    }
  }

  // saving part of a saved recipe: use one of the user's own recipes that has a portion count and delete the lines again
  {
    const withPortions = [];
    for (const m of await client.listMeals()) {
      const d = await client.getMealDetails(m.id);
      if (d.portions !== null && d.portions > 1 && m.energy !== null && d.ingredients.length > 0) withPortions.push({ m, d });
    }
    const pick = withPortions[0];
    if (!pick) {
      console.log('SKIP  no saved recipe with a portion count — partial recipe logging not tested');
    } else {
      const { m, d } = pick;
      try {
        const one = await client.logMeal({ mealId: m.id, meal: '1', date: tomorrow, portions: 1 });
        ok('one portion of a recipe has about its share of the energy and reads "porce" like the site', one.added !== null && one.added.quantity.raw === 'porce' && Math.abs(one.added.energy - m.energy / d.portions) <= Math.max(3, (m.energy / d.portions) * 0.03), `${one.added?.energy} vs ${(m.energy / d.portions).toFixed(1)} kcal, shown as "${one.added?.quantity.raw}"`);
        const half = await client.logMeal({ mealId: m.id, meal: '1', date: tomorrow, percent: 50 });
        ok('half of a recipe has half of the energy and reads "50%"', half.added !== null && half.added.quantity.raw === '50%' && Math.abs(half.added.energy - m.energy / 2) <= Math.max(3, (m.energy / 2) * 0.03), `${half.added?.energy} vs ${(m.energy / 2).toFixed(1)} kcal`);
        const quarter = Math.round(d.totalWeight / 4);
        const grams = await client.logMeal({ mealId: m.id, meal: '1', date: tomorrow, grams: quarter });
        ok('a quarter of the weight has a quarter of the energy and reads like a gram amount typed on the site', grams.added !== null && grams.added.quantity.raw === `${quarter} x 1 g` && Math.abs(grams.added.energy - m.energy / 4) <= Math.max(4, (m.energy / 4) * 0.04), `${grams.added?.energy} vs ${(m.energy / 4).toFixed(1)} kcal, shown as "${grams.added?.quantity.raw}"`);
      } catch (e) {
        ok('partial recipe logging completed', false, e.message);
      } finally {
        const x = await client.getDayEntries(tomorrow, { fresh: true });
        for (const mm of x.meals) for (const e of mm.entries) await client.deleteDiaryEntry({ date: tomorrow, entryId: e.id }).catch(err => ok('cleanup entry', false, err.message));
        ok('the test day is empty again after the recipe lines', (await client.getDayEntries(tomorrow, { fresh: true })).entryCount === 0);
        ok('the recipe itself is unchanged', (await client.listMeals()).find(x2 => x2.id === m.id)?.energy === m.energy);
      }
    }
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
    // A value different from the current own basal, or the diary's energy goal could not be seen to move.
    const testBasal = snapshot.basal.own !== null && Math.abs(snapshot.basal.own - 1750) <= 1 ? 1700 : 1750;
    try {
      const r = await client.updateGoals({
        drinkLiters: snapshot.drinkLiters === 3.3 ? 3.4 : 3.3,
        ownBasal: testBasal,
        ...(carb && carb.own !== null ? { nutrients: [{ code: 'carbohydrate', grams: carb.own + 1 }] } : {}),
      });
      ok('goals changed and read back', r.notApplied.length === 0 && Math.abs((r.after?.basal.own ?? 0) - testBasal) <= 1, `changed ${r.changed.join(', ')}`);
      if (snapshot.targetEnergy.own !== null) {
        // An own energy goal switches the deficit model off, so the basal cannot move the goal.
        ok('the own energy goal stays put when the basal changes', r.after?.effective?.energyGoal === snapshot.effective?.energyGoal, `${snapshot.effective?.energyGoal} -> ${r.after?.effective?.energyGoal}`);
      } else {
        ok('the diary\'s energy goal follows the own basal', r.after?.effective?.energyGoal !== snapshot.effective?.energyGoal, `${snapshot.effective?.energyGoal} -> ${r.after?.effective?.energyGoal}`);
      }
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
