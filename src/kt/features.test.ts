/**
 * Tests for caching, balance, weight, favourites, activities, notes, copying
 * and recipe details. The client runs against a stubbed fetch; the data is
 * synthetic (see testkit.ts).
 */

import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { KtAuthError, KtError, parseDayBalance, parseWeightHistory, todayCzech } from './client.js';
import {
  OTHER_PAST,
  PAST,
  activityLine,
  balancePayload,
  client,
  dayDate,
  dayPayload,
  envelope,
  foodLine,
  json,
  loginOk,
  note,
  okReply,
  restoreFetch,
  state,
  stubFetch,
  toLogin,
} from './testkit.js';

afterEach(restoreFetch);

type Route = [match: string | RegExp, handler: (url: URL, init?: RequestInit) => Response];
function serve(routes: Route[]): void {
  stubFetch((url, init) => {
    if (url.pathname === '/login/create') return loginOk();
    for (const [match, handler] of routes) {
      if (typeof match === 'string' ? url.pathname === match : match.test(url.pathname)) return handler(url, init);
    }
    throw new Error(`unexpected request ${url.pathname}`);
  });
}
const DAY_ROUTE = /^\/user\/diary\/\d{2}\.\d{2}\.\d{4}\/get$/;
const wrote = (path: string) => state.bodies.filter(b => b.path === path);

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

test('past days are cached, today is not, fresh reads bypass the cache, and a write clears it', async () => {
  let reads = 0;
  serve([
    [DAY_ROUTE, url => (reads++, json(envelope(dayPayload(dayDate(url) ?? PAST))))],
    ['/foodstuff/detail/form/f1', () => json({ guid: 'f1', unitGuid: '0000000000000001' })],
    ['/user/foodstuff/add', () => okReply()],
  ]);
  const c = client();
  await c.getDayEntries(PAST);
  await c.getDayEntries(PAST);
  assert.equal(reads, 1, 'second read of a past day comes from the cache');

  await c.getDayEntries(todayCzech());
  await c.getDayEntries(todayCzech());
  assert.equal(reads, 3, 'today is always read from the site');

  await c.getDayEntries(PAST, { fresh: true });
  assert.equal(reads, 4, 'fresh bypasses the cache');

  await c.getDayEntries(PAST);
  assert.equal(reads, 4, 'and refreshes it');
  await c.logFood({ foodId: 'f1', amount: 1, meal: '1', date: PAST });
  await c.getDayEntries(PAST);
  assert.equal(reads, 5, 'a write clears the cache');
});

test('deleting checks the live day, never a cached copy that may be out of date', async () => {
  let present = true;
  const entryId = 'entrya0000000';
  serve([
    [DAY_ROUTE, url => json(envelope(dayPayload(dayDate(url) ?? PAST, { meals: { '1': present ? [foodLine(entryId, 'Test skyr')] : [] } })))],
    [/\/user\/diary\/foodstuff\/delete\//, () => okReply()],
  ]);
  const c = client();
  assert.equal((await c.getDayEntries(PAST)).entryCount, 1); // now cached
  present = false; // removed behind our back (e.g. on the website)
  await assert.rejects(c.deleteDiaryEntry({ date: PAST, entryId: entryId }), /No diary entry with id/);
  assert.ok(!state.calls.some(p => p.includes('/delete/')));
});

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

test('parseDayBalance reads the summary and computes the net balance itself', () => {
  const b = parseDayBalance(balancePayload(), PAST);
  assert.equal(b.energyUnit, 'kcal');
  assert.equal(b.intake, 1800);
  assert.equal(b.output, 2500);
  assert.equal(b.target, 2000);
  assert.equal(b.plannedDeficit, -500); // the site's own figure, kept apart from the computed one
  assert.equal(b.netBalance, -700);
  assert.equal(b.activityEnergy, 300);
  assert.equal(b.weight, 81.9);
  assert.deepEqual(
    b.nutrients.map(n => [n.code, n.unit, n.goal, n.actual]),
    [
      ['protein', 'g', 150, 120],
      ['fat', 'g', 70.5, 65],
      ['calcium', 'mg', 1000, 900],
    ],
  );
});

test('parseDayBalance keeps unknown values null and rejects unrecognised shapes', () => {
  const sparse = balancePayload();
  (sparse.balance as Record<string, unknown>)['energyDeficit'] = null;
  (sparse.balance as Record<string, unknown>)['output'] = null;
  const b = parseDayBalance(sparse, PAST);
  assert.equal(b.plannedDeficit, null);
  assert.equal(b.netBalance, null);

  assert.throws(() => parseDayBalance({ items: [] }, PAST), KtError);
  assert.throws(() => parseDayBalance({ balance: {} }, PAST), KtError);
  assert.throws(() => parseDayBalance(null, PAST), KtError);
  assert.throws(() => parseDayBalance({ ...balancePayload(), itemsDynamic: [[{ nope: 1 }]] }, PAST), KtError);
});

test('getDayBalance caches past days and getBalanceRange accepts up to 90 days, not 91', async () => {
  let reads = 0;
  serve([[/^\/user\/diary\/summary\/[\d.]+\/get$/, () => (reads++, json(envelope(balancePayload())))]]);
  const c = client();
  await c.getDayBalance(PAST);
  await c.getDayBalance(PAST);
  assert.equal(reads, 1);

  const ninety = await c.getBalanceRange('01.08.2026', '29.10.2026'); // 90 days incl. both ends
  assert.equal(ninety.length, 90);
  await assert.rejects(c.getBalanceRange('01.08.2026', '30.10.2026'), /maximum is 90/);
});

test('getBalanceRange reports a failing day and aborts on a login failure', async () => {
  serve([
    [
      /^\/user\/diary\/summary\//,
      url => (url.pathname.includes(OTHER_PAST) ? json(envelope({ broken: true })) : json(envelope(balancePayload()))),
    ],
  ]);
  const out = await client().getBalanceRange(OTHER_PAST, PAST);
  assert.deepEqual(out.map(o => o.status), ['error', 'ok']);

  stubFetch(() => json({ code: 5, message: 'Špatné heslo', data: null }));
  await assert.rejects(client().getBalanceRange(OTHER_PAST, PAST), KtAuthError);
  assert.deepEqual(state.calls, ['/login/create']);
});

// ---------------------------------------------------------------------------
// Weight
// ---------------------------------------------------------------------------

const weightSummary = (records: Array<[string, string]>) => ({
  weight: '81,9',
  weightTarget: '72',
  weightUnit: 'kg',
  monthWeight: records.map(([ymd, v]) => {
    const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
    return { from: Date.UTC(y, m - 1, d, 12), value: Number(v.replace(',', '.')), valueString: v, description: ymd };
  }),
});

test('parseWeightHistory reads records, current weight and target', () => {
  const h = parseWeightHistory(weightSummary([['2026-11-09', '82,5'], ['2026-11-10', '82,4']]));
  assert.deepEqual(h.records, [
    { date: '09.11.2026', value: 82.5 },
    { date: '10.11.2026', value: 82.4 },
  ]);
  assert.equal(h.current, 81.9);
  assert.equal(h.target, 72);
  assert.equal(h.unit, 'kg');
  assert.throws(() => parseWeightHistory({}), KtError);
  assert.throws(() => parseWeightHistory({ monthWeight: [{ from: 'x' }] }), KtError);
});

test('logWeight posts the weight and date, then reads the record back', async () => {
  let recorded = false;
  serve([
    ['/user/weight/add', () => ((recorded = true), okReply('Váha byla úspěšně zapsána!'))],
    [/^\/statistic\/summary\//, () => json(envelope(weightSummary(recorded ? [['2026-11-10', '81,7']] : [])))],
  ]);
  const r = await client().logWeight({ weightKg: 81.7, date: PAST });
  assert.deepEqual(wrote('/user/weight/add')[0]?.body, { weight: 81.7, date: PAST });
  assert.equal(r.recorded, 81.7);
});

test('logWeight refuses implausible weights and impossible dates before any request', async () => {
  stubFetch(() => {
    throw new Error('no request expected');
  });
  for (const w of [0, 5, 600, Number.NaN]) await assert.rejects(client().logWeight({ weightKg: w, date: PAST }), /between 20 and 500/);
  await assert.rejects(client().logWeight({ weightKg: 80, date: '31.02.2026' }), /does not exist/);
  assert.deepEqual(state.calls, []);
});

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

test('lists favourite and common foods, and confirms adding and removing a favourite', async () => {
  let favourites = [{ id: 'food00000001', title: 'Kvasový chléb' }];
  serve([
    ['/user/settings/favorite/foodstuff', () => json(envelope(favourites))],
    ['/user/settings/common/foodstuff', () => json(envelope([{ id: 'food00000009', title: 'Pivo' }]))],
    [/^\/user\/settings\/favorite\/foodstuff\/add\//, url => ((favourites = [...favourites, { id: url.pathname.split('/').pop() ?? '', title: 'Celer' }]), okReply())],
    [/^\/user\/settings\/favorite\/foodstuff\/remove\//, url => ((favourites = favourites.filter(f => f.id !== url.pathname.split('/').pop())), okReply())],
  ]);
  const c = client();
  assert.deepEqual(await c.listFavoriteFoods(), [{ id: 'food00000001', title: 'Kvasový chléb' }]);
  assert.deepEqual(await c.listCommonFoods(), [{ id: 'food00000009', title: 'Pivo' }]);
  assert.equal((await c.setFavoriteFood('food00000002', true)).confirmed, true);
  assert.equal((await c.setFavoriteFood('food00000002', false)).confirmed, true);
  await assert.rejects(c.setFavoriteFood('../x', true), /Invalid entry id/);
});

test('an unreadable favourites list is an error, not an empty list', async () => {
  serve([['/user/settings/favorite/foodstuff', () => json(envelope([{ id: 1 }]))]]);
  await assert.rejects(client().listFavoriteFoods(), KtError);
});

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

test('searchActivities keeps only activities', async () => {
  serve([
    [
      '/autocomplete/foodstuff-activity-meal',
      () => json([{ clazz: 'foodstuff', id: 'f', title: 'Chléb' }, { clazz: 'activity', id: 'act00000001', title: 'Chůze' }]),
    ],
  ]);
  assert.deepEqual(await client().searchActivities('chůze'), [{ id: 'act00000001', title: 'Chůze' }]);
});

test('logActivity sends the duration in hours and returns the new line', async () => {
  let acts: unknown[] = [];
  serve([
    [DAY_ROUTE, url => json(envelope(dayPayload(dayDate(url) ?? PAST, { activities: acts })))],
    ['/user/activity/add/form/act00000001', () => json(envelope({ guid: 'act00000001', title: 'Chůze', time: 1, timeUnit: 'hrs', date: PAST }))],
    ['/user/activity/add', () => ((acts = [activityLine('newact000001', 'Chůze', '0,5 hod', '91,6')]), okReply('Aktivita byla úspěšně zapsána.'))],
  ]);
  const r = await client().logActivity({ activityId: 'act00000001', minutes: 30, date: PAST });
  const body = wrote('/user/activity/add')[0]?.body as Record<string, unknown>;
  assert.equal(body['time'], 0.5);
  assert.equal(body['date'], PAST);
  assert.equal(body['guid'], 'act00000001');
  assert.equal(r.added?.id, 'newact000001');
  assert.equal(r.added?.durationMinutes, 30); // "0,5 hod" read back as minutes
  assert.equal(r.added?.energy, 91.6);
});

test('logActivity refuses unsupported units, bad durations and unknown activities without posting', async () => {
  serve([
    [DAY_ROUTE, url => json(envelope(dayPayload(dayDate(url) ?? PAST)))],
    ['/user/activity/add/form/rep00000001', () => json(envelope({ guid: 'rep00000001', title: 'Kliky', time: 1, timeUnit: 'rep' }))],
    ['/user/activity/add/form/gone0000001', () => json(envelope(null))],
  ]);
  const c = client();
  await assert.rejects(c.logActivity({ activityId: 'rep00000001', minutes: 10, date: PAST }), /not support/);
  await assert.rejects(c.logActivity({ activityId: 'gone0000001', minutes: 10, date: PAST }), /unknown activity/);
  for (const minutes of [0, -1, 2000, Number.NaN]) await assert.rejects(c.logActivity({ activityId: 'act00000001', minutes, date: PAST }), /minutes must be/);
  assert.equal(wrote('/user/activity/add').length, 0);
});

test('deleteActivity checks the line is on that day, deletes it, and confirms', async () => {
  let present = true;
  serve([
    [DAY_ROUTE, url => json(envelope(dayPayload(dayDate(url) ?? PAST, { activities: present ? [activityLine('act0000000a', 'Chůze', '30 min')] : [] })))],
    [/\/user\/diary\/activity\/delete\//, () => ((present = false), okReply())],
  ]);
  const c = client();
  const r = await c.deleteActivity({ date: PAST, activityId: 'act0000000a' });
  assert.equal(r.deleted.title, 'Chůze');
  assert.equal(r.confirmed, true);
  await assert.rejects(c.deleteActivity({ date: PAST, activityId: 'act0000000a' }), /No activity with id/);
  assert.equal(state.calls.filter(p => p.includes('/activity/delete/')).length, 1);
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

test('addNote posts a day-level or meal-level note and finds it afterwards', async () => {
  let dayNotes: unknown[] = [];
  let mealNotes: Record<string, unknown[]> = {};
  serve([
    [DAY_ROUTE, url => json(envelope(dayPayload(dayDate(url) ?? PAST, { notes: dayNotes, mealNotes })))],
    [
      '/user/diary/note/add',
      (_url, init) => {
        const b = JSON.parse(String(init?.body)) as { time: number; note: string };
        if (b.time === 0) dayNotes = [note('daynote000001', b.note)];
        else mealNotes = { [String(b.time)]: [note('mealnote00001', b.note)] };
        return okReply();
      },
    ],
  ]);
  const c = client();
  const a = await c.addNote({ date: PAST, text: '  Dobrý den  ' });
  assert.deepEqual(wrote('/user/diary/note/add')[0]?.body, { date: PAST, note: 'Dobrý den', time: 0 });
  assert.equal(a.added?.note.id, 'daynote000001');
  assert.equal(a.added?.meal, null);

  const m = await c.addNote({ date: PAST, text: 'K obědu', meal: '3' });
  assert.equal(wrote('/user/diary/note/add')[1] && (wrote('/user/diary/note/add')[1]?.body as { time: number }).time, 3);
  assert.equal(m.added?.note.id, 'mealnote00001');
  assert.equal(m.added?.meal, 'Oběd');
  assert.doesNotMatch(JSON.stringify([a, m]), /fake-hash-value|example\.invalid/);
});

test('addNote refuses empty and over-long text before any request', async () => {
  stubFetch(() => {
    throw new Error('no request expected');
  });
  await assert.rejects(client().addNote({ date: PAST, text: '   ' }), /1 to 1000/);
  await assert.rejects(client().addNote({ date: PAST, text: 'x'.repeat(1001) }), /1 to 1000/);
  assert.deepEqual(state.calls, []);
});

test('deleteNote removes a meal-level note after checking it is on that day', async () => {
  let present = true;
  serve([
    [DAY_ROUTE, url => json(envelope(dayPayload(dayDate(url) ?? PAST, { mealNotes: present ? { '1': [note('mealnote00001', 'Test')] } : {} })))],
    [/\/user\/diary\/note\/delete\//, () => ((present = false), okReply())],
  ]);
  const c = client();
  await assert.rejects(c.deleteNote({ date: PAST, noteId: 'othernote0001' }), /No note with id/);
  assert.equal(state.calls.filter(p => p.includes('/note/delete/')).length, 0);
  const r = await c.deleteNote({ date: PAST, noteId: 'mealnote00001' });
  assert.equal(r.deleted.meal, 'Snídaně');
  assert.equal(r.confirmed, true);
});

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

function copyServer(opts: { failMeal?: string } = {}) {
  const target: Record<string, unknown[]> = {};
  const source: Record<string, unknown[]> = {
    '1': [foodLine('s1a000000001', 'Test chléb'), foodLine('s1b000000001', 'Test sýr')],
    '3': [foodLine('s3a000000001', 'Test oběd')],
  };
  serve([
    [
      DAY_ROUTE,
      url => {
        const d = dayDate(url) ?? PAST;
        return json(envelope(dayPayload(d, { meals: d === PAST ? source : target })));
      },
    ],
    [
      /^\/user\/diary-time\/create\/form\/[\d.]+\/\d$/,
      url => {
        const meal = url.pathname.split('/').pop() ?? '1';
        return json(envelope({ diaryTimeGuid: meal, date: PAST, foodstuff: (source[meal] ?? []).map(() => ({ selected: true, title: 'x' })), totalWeight: 0 }));
      },
    ],
    [
      '/user/diary-time/copy',
      (_url, init) => {
        const b = JSON.parse(String(init?.body)) as { diaryTimeGuid: string; foodstuff: unknown[] };
        if (opts.failMeal === b.diaryTimeGuid) return json({ requestId: null, code: 1, message: 'Nelze zkopírovat', data: null });
        target[b.diaryTimeGuid] = [...(target[b.diaryTimeGuid] ?? []), ...b.foodstuff.map((_, i) => foodLine(`t${b.diaryTimeGuid}${i}00000000`, 'copied'))];
        return okReply('Jídlo bylo úspěšně zkopírováno!');
      },
    ],
  ]);
}

test('copyMeal posts the source form with the target date and meal, and counts what was added', async () => {
  copyServer();
  const r = await client().copyMeal({ fromDate: PAST, meal: '1', toDate: OTHER_PAST, toMeal: '5' });
  const body = wrote('/user/diary-time/copy')[0]?.body as Record<string, unknown>;
  assert.equal(body['date'], OTHER_PAST);
  assert.equal(body['diaryTimeGuid'], '5');
  assert.equal(r.lines, 2);
  assert.equal(r.added, 2);
  assert.equal(r.fromMeal, 'Snídaně');
  assert.equal(r.toMeal, 'Večeře');
});

test('copyMeal refuses an empty meal and copying a meal onto itself, without posting', async () => {
  copyServer();
  const c = client();
  await assert.rejects(c.copyMeal({ fromDate: PAST, meal: '2', toDate: OTHER_PAST }), /Nothing to copy/);
  await assert.rejects(c.copyMeal({ fromDate: PAST, meal: '1', toDate: PAST }), /same meal/);
  await assert.rejects(c.copyMeal({ fromDate: '31.02.2026', meal: '1', toDate: PAST }), /does not exist/);
  assert.equal(wrote('/user/diary-time/copy').length, 0);
});

test('copyDay copies each non-empty meal into the same slot', async () => {
  copyServer();
  const r = await client().copyDay({ fromDate: PAST, toDate: OTHER_PAST });
  assert.equal(r.failed, null);
  assert.deepEqual(r.copied.map(c => [c.fromMeal, c.toMeal, c.lines, c.added]), [
    ['Snídaně', 'Snídaně', 2, 2],
    ['Oběd', 'Oběd', 1, 1],
  ]);
});

test('copyDay stops at the first failing meal and says what was already copied', async () => {
  copyServer({ failMeal: '3' });
  const r = await client().copyDay({ fromDate: PAST, toDate: OTHER_PAST });
  assert.deepEqual(r.copied.map(c => c.fromMeal), ['Snídaně']);
  assert.equal(r.failed?.meal, 'Oběd');
  assert.match(r.failed?.error ?? '', /Nelze zkopírovat/);
  await assert.rejects(client().copyDay({ fromDate: PAST, toDate: PAST }), /same day/);
});

// ---------------------------------------------------------------------------
// Recipe details
// ---------------------------------------------------------------------------

test('getMealDetails lists ingredients with nutrition and keeps going when one ingredient cannot be looked up', async () => {
  const unit = (id: string, title: string) => [{ id, title, multiplier: null }];
  serve([
    [
      '/user/meal/add/form/meal0000000001',
      () =>
        json(
          envelope({
            guid: 'meal0000000001',
            title: 'Test bábovka',
            foodstuff: [
              { title: 'mouka', foodstuffGuid: 'food00000001', count: 250, selectedUnitGuid: 'u1', units: unit('u1', '1 g'), weight: 250 },
              { title: 'záhada', foodstuffGuid: 'food00000002', count: 2, selectedUnitGuid: 'u2', units: unit('u2', 'kus'), weight: null },
              { title: 'bez množství', foodstuffGuid: 'food00000003', count: null, selectedUnitGuid: null, units: [] },
            ],
          }),
        ),
    ],
    [
      /^\/foodstuff\/detail\/food00000001\//,
      () => json({ energyUnit: 'kcal', foodstuff: { title: 'mouka', energy: '910', protein: 25, carbohydrate: 190, fat: 3 } }),
    ],
    [/^\/foodstuff\/detail\/food00000002\//, () => new Response('<html>oops</html>', { status: 200 })],
  ]);
  const m = await client().getMealDetails('meal0000000001');
  assert.equal(m.title, 'Test bábovka');
  assert.equal(m.ingredients.length, 3);
  const [flour, mystery, none] = m.ingredients;
  assert.equal(flour?.nutrition?.protein, 25);
  assert.equal(flour?.unitTitle, '1 g');
  assert.equal(flour?.weight, 250);
  assert.equal(mystery?.nutrition, null);
  assert.match(mystery?.error ?? '', /expected JSON/);
  assert.equal(none?.nutrition, null);
  assert.match(none?.error ?? '', /no amount or unit/);
});

test('getMealDetails rejects an unknown recipe and a malformed id', async () => {
  serve([['/user/meal/add/form/gone0000000001', () => json(envelope(null))]]);
  await assert.rejects(client().getMealDetails('gone0000000001'), /unknown recipe/);
  await assert.rejects(client().getMealDetails('../etc'), /Invalid entry id/);
});

test('a session that cannot be re-established makes the new reads fail as auth errors', async () => {
  stubFetch(url => (url.pathname === '/login/create' ? loginOk() : toLogin()));
  await assert.rejects(client().getDayBalance(PAST), KtAuthError);
});
