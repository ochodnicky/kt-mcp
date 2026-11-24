/**
 * Tests for foods and activities the user describes themselves, the most
 * common activities and editing saved recipes. The client runs against a
 * stubbed fetch; the data is synthetic (see testkit.ts).
 */

import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { PAST, activityLine, client, dayPayload, envelope, foodLine, json, loginOk, okReply, restoreFetch, state, stubFetch } from './testkit.js';

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
const writes = () => state.bodies.filter(b => b.path !== '/login/create');

// ---------------------------------------------------------------------------
// Own food
// ---------------------------------------------------------------------------

const ownFoodForm = () => ({
  guid: '0',
  title: null,
  diaryTimeGuid: '1',
  diaryTimeOptions: [{ id: '1', title: 'Snídaně' }],
  date: '24.11.2026',
  energy: null,
  energyUnit: 'kcal',
  detailValues: false,
  protein: null,
  carbohydrate: null,
  fat: null,
  fiber: null,
  sugar: null,
  saturatedFattyAcid: null,
  salt: null,
  alcohol: null,
});

function ownFoodRoutes(onAdd?: (body: Record<string, unknown>) => void, linesAfter: () => unknown[] = () => []): Route[] {
  return [
    ['/foodstuff/detail/form/0', () => json(envelope(ownFoodForm()))],
    [
      /^\/user\/diary\/\d{2}\.\d{2}\.\d{4}\/get$/,
      url => {
        const date = /\/user\/diary\/(\d{2}\.\d{2}\.\d{4})\/get/.exec(url.pathname)![1]!;
        return json(envelope(dayPayload(date, { meals: { '3': linesAfter() } })));
      },
    ],
    [
      '/user/foodstuff/add',
      (_url, init) => {
        onAdd?.(JSON.parse(String(init?.body)));
        return okReply();
      },
    ],
  ];
}

test('an own food is posted through the site\'s own form with the title, energy, meal and day, and nutrients only when given', async () => {
  let lines: unknown[] = [];
  serve(ownFoodRoutes(() => (lines = [foodLine('own00000001', 'Test řízek', { energy: '650', unit: null })]), () => lines));
  const r = await client().logCustomFood({ title: '  Test řízek ', energy: 650, meal: '3', date: PAST });
  const body = writes().find(b => b.path === '/user/foodstuff/add')!.body as Record<string, unknown>;
  assert.deepEqual([body['title'], body['energy'], body['diaryTimeGuid'], body['date'], body['detailValues'], body['protein']], ['Test řízek', 650, '3', PAST, false, null]);
  assert.equal(body['guid'], '0');
  assert.deepEqual([r.added?.id, r.energyUnit], ['own00000001', 'kcal']);
});

test('given nutrients are sent as the site\'s field names and switch on the detail values', async () => {
  serve(ownFoodRoutes());
  await client().logCustomFood({ title: 'Test', energy: 400, meal: '1', nutrients: { protein: 30, carbohydrate: 40, fat: 10, fibre: 5, sugar: 8, saturatedFat: 3, salt: 1.2, alcohol: 0 } });
  const body = writes().find(b => b.path === '/user/foodstuff/add')!.body as Record<string, unknown>;
  assert.deepEqual([body['detailValues'], body['protein'], body['carbohydrate'], body['fat'], body['fiber'], body['sugar'], body['saturatedFattyAcid'], body['salt'], body['alcohol']], [true, 30, 40, 10, 5, 8, 3, 1.2, 0]);
});

test('an own food that cannot be identified afterwards is reported as such, not as a failure', async () => {
  serve(ownFoodRoutes());
  const r = await client().logCustomFood({ title: 'Test', energy: 100, meal: '1' });
  assert.equal(r.added, null);
});

test('nothing is posted for a blank title, a silly energy or nutrient, an unknown meal or a day that does not exist', async () => {
  serve(ownFoodRoutes());
  const c = client();
  const ok = { title: 'Test', energy: 100, meal: '1' as const };
  await assert.rejects(c.logCustomFood({ ...ok, title: '   ' }), /title must be/);
  await assert.rejects(c.logCustomFood({ ...ok, title: 'x'.repeat(101) }), /title must be/);
  await assert.rejects(c.logCustomFood({ ...ok, energy: -1 }), /energy must be/);
  await assert.rejects(c.logCustomFood({ ...ok, energy: Number.NaN }), /energy must be/);
  await assert.rejects(c.logCustomFood({ ...ok, energy: 20001 }), /energy must be/);
  await assert.rejects(c.logCustomFood({ ...ok, nutrients: { protein: -3 } }), /protein must be/);
  await assert.rejects(c.logCustomFood({ ...ok, meal: '9' as never }), /Unknown meal/);
  await assert.rejects(c.logCustomFood({ ...ok, date: '31.02.2026' }), /does not exist/);
  assert.deepEqual(writes(), []);
});

test('a food form that is not the site\'s own-food form is refused before anything is posted', async () => {
  serve([['/foodstuff/detail/form/0', () => json(envelope({ ...ownFoodForm(), guid: 'abc' }))], ['/user/foodstuff/add', () => okReply()]]);
  await assert.rejects(client().logCustomFood({ title: 'Test', energy: 100, meal: '1' }), /not as expected/);
  assert.deepEqual(writes(), []);
});

// ---------------------------------------------------------------------------
// Own activity and common activities
// ---------------------------------------------------------------------------

const ownActivityForm = (over: Record<string, unknown> = {}) => ({ guid: '0', title: null, time: 1, timeUnit: 'hrs', date: '24.11.2026', energy: null, energyUnit: 'kcal', ...over });

function ownActivityRoutes(form = ownActivityForm, onAdd?: (body: Record<string, unknown>) => void, after: () => unknown[] = () => []): Route[] {
  return [
    ['/user/activity/add/form/0', () => json(envelope(form()))],
    [/^\/user\/diary\/\d{2}\.\d{2}\.\d{4}\/get$/, url => json(envelope(dayPayload(/\/user\/diary\/(\d{2}\.\d{2}\.\d{4})\/get/.exec(url.pathname)![1]!, { activities: after() })))],
    [
      '/user/activity/add',
      (_url, init) => {
        onAdd?.(JSON.parse(String(init?.body)));
        return okReply();
      },
    ],
  ];
}

test('an own activity is posted with the duration in hours and the energy the user gave, and identified afterwards', async () => {
  let acts: unknown[] = [];
  serve(ownActivityRoutes(ownActivityForm, () => (acts = [activityLine('act000000009', 'Test hodina tance', '0,75 hod', '210')]), () => acts));
  const r = await client().logCustomActivity({ title: ' Test hodina tance ', minutes: 44.6, energy: 210, date: PAST });
  const body = writes().find(b => b.path === '/user/activity/add')!.body as Record<string, unknown>;
  assert.deepEqual([body['title'], body['time'], body['energy'], body['date'], body['guid']], ['Test hodina tance', 0.75, 210, PAST, '0']);
  assert.equal(r.added?.id, 'act000000009');
});

test('nothing is posted for a blank title, a duration under a minute, a silly energy or a form not measured in hours', async () => {
  serve(ownActivityRoutes());
  const c = client();
  const ok = { title: 'Test', minutes: 30, energy: 100 };
  await assert.rejects(c.logCustomActivity({ ...ok, title: ' ' }), /title must be/);
  await assert.rejects(c.logCustomActivity({ ...ok, minutes: 0.4 }), /between 1 and 1440/);
  await assert.rejects(c.logCustomActivity({ ...ok, minutes: 1441 }), /between 1 and 1440/);
  await assert.rejects(c.logCustomActivity({ ...ok, energy: -5 }), /energy must be/);
  await assert.rejects(c.logCustomActivity({ ...ok, date: '31.02.2026' }), /does not exist/);
  assert.deepEqual(writes(), []);
  serve(ownActivityRoutes(() => ownActivityForm({ timeUnit: 'min' })));
  await assert.rejects(client().logCustomActivity(ok), /does not support/);
  serve(ownActivityRoutes(() => ownActivityForm({ guid: 'x' })));
  await assert.rejects(client().logCustomActivity(ok), /not as expected/);
  assert.deepEqual(writes(), []);
});

test('the most common activities are read like the favourites, an empty list is fine and a broken one throws', async () => {
  serve([['/user/settings/common/activity', () => json(envelope([{ id: 'a'.repeat(16), title: 'Test běh', category: 'Běh', energy: '0,12', energyForUser: '9,8' }]))]]);
  assert.deepEqual((await client().listCommonActivities())[0], { id: 'a'.repeat(16), title: 'Test běh', category: 'Běh', kcalPerKgPerMinute: 0.12, kcalPerMinute: 9.8 });
  serve([['/user/settings/common/activity', () => json(envelope([]))]]);
  assert.deepEqual(await client().listCommonActivities(), []);
  serve([['/user/settings/common/activity', () => json(envelope([{ nope: 1 }]))]]);
  await assert.rejects(client().listCommonActivities(), /unreadable/);
});

// ---------------------------------------------------------------------------
// Editing saved recipes
// ---------------------------------------------------------------------------

const M1 = 'e'.repeat(32);
const F1 = 'f1'.padEnd(16, '0');
const F2 = 'f2'.padEnd(16, '0');
const F3 = 'f3'.padEnd(16, '0');
const item = (guid: string, title: string, count: number, over: Record<string, unknown> = {}) => ({
  guid,
  title,
  locked: true,
  preference: 0,
  energy: 0.15,
  protein: 0.008,
  unitCount: count,
  selectedUnitGuid: '0000000000000001',
  units: [{ id: '0000000000000001', title: '1 g', multiplier: 1 }, { id: 'p50', title: 'porce (50 g)', multiplier: 50 }],
  originalRecipeUnit: `${count} x 1 g`,
  ...over,
});
const mealForm = (items: unknown[], over: Record<string, unknown> = {}) => ({
  guid: M1,
  title: 'Test polévka',
  description: [{ description: 'Krok 1' }],
  portions: 2,
  preparationTime: null,
  visibility: 'private',
  user: 'someone@example.invalid',
  files: [],
  items,
  ...over,
});

function mealRoutes(state0: { form: Record<string, unknown>; listed?: boolean }, opts: { echo?: boolean } = {}): Route[] {
  return [
    ['/user/settings/meal/list', () => json(envelope(state0.listed === false ? [] : [{ guid: M1, title: String(state0.form['title']), energy: '120', energyUnit: 'kcal', portions: state0.form['portions'] }]))],
    [`/user/settings/meal/edit/form/${M1}/`, () => json(envelope(state0.form))],
    [
      `/user/settings/meal/detail/edit/${M1}`,
      (_url, init) => {
        if (opts.echo !== false) state0.form = JSON.parse(String(init?.body));
        return json(envelope(M1));
      },
    ],
    [/^\/foodstuff\/detail\/form\//, url => json(envelope({ guid: url.pathname.split('/').pop(), title: 'Test mrkev', unitGuid: '0000000000000001', multiplier: 100, unitOptions: [{ id: '0000000000000001', title: '1 g', multiplier: 1 }, { id: 'pc1', title: 'kus (60 g)', multiplier: 60 }] }))],
  ];
}

const posted = () => writes().filter(b => b.path === `/user/settings/meal/detail/edit/${M1}`).at(-1)!.body as Record<string, unknown>;

test('a recipe is renamed, given portions and new steps by posting the site\'s own form back with only those fields changed', async () => {
  const s = { form: mealForm([item(F1, 'okurka', 100)]) as Record<string, unknown> };
  serve(mealRoutes(s));
  const r = await client().updateMeal({ mealId: M1, title: '  Nová polévka ', portions: 4, steps: ['První ', '', 'Druhý'] });
  const b = posted();
  assert.deepEqual([b['title'], b['portions'], b['description']], ['Nová polévka', 4, [{ description: 'První' }, { description: 'Druhý' }]]);
  assert.deepEqual([b['visibility'], b['user'], (b['items'] as unknown[]).length], ['private', 'someone@example.invalid', 1]);
  assert.deepEqual([r.confirmed, r.now.title, r.now.portions, r.now.steps], [true, 'Nová polévka', 4, ['První', 'Druhý']]);
  assert.equal(JSON.stringify(r).includes('example.invalid'), false);
});

test('steps can be cleared with an empty list, and nothing else changes', async () => {
  const s = { form: mealForm([item(F1, 'okurka', 100)]) as Record<string, unknown> };
  serve(mealRoutes(s));
  const r = await client().updateMeal({ mealId: M1, steps: [] });
  assert.deepEqual(posted()['description'], []);
  assert.deepEqual([r.now.title, r.now.portions, r.now.steps], ['Test polévka', 2, []]);
});

test('a recipe edit that the site does not show back as sent is reported as unconfirmed', async () => {
  const s = { form: mealForm([item(F1, 'okurka', 100)]) as Record<string, unknown> };
  serve(mealRoutes(s, { echo: false }));
  const r = await client().updateMeal({ mealId: M1, portions: 9 });
  assert.equal(r.confirmed, false);
});

test('nothing is posted for an unlisted recipe, a bad id, nothing to change or silly values', async () => {
  const s = { form: mealForm([item(F1, 'okurka', 100)]) as Record<string, unknown>, listed: false };
  serve(mealRoutes(s));
  const c = client();
  await assert.rejects(c.updateMeal({ mealId: M1, title: 'x' }), /No saved recipe/);
  await assert.rejects(c.updateMeal({ mealId: '../x', title: 'x' }), /Invalid recipe id/);
  assert.equal(state.calls.some(p => p.includes('/meal/edit/form/')), false, 'the form is not even requested for an unlisted recipe');
  s.listed = true;
  await assert.rejects(c.updateMeal({ mealId: M1 }), /Nothing to change/);
  await assert.rejects(c.updateMeal({ mealId: M1, portions: 0 }), /portions must be/);
  await assert.rejects(c.updateMeal({ mealId: M1, portions: 2.5 }), /portions must be/);
  await assert.rejects(c.updateMeal({ mealId: M1, title: '   ' }), /title must be/);
  await assert.rejects(c.updateMeal({ mealId: M1, steps: Array.from({ length: 51 }, () => 'x') }), /at most 50 steps/);
  assert.deepEqual(writes(), []);
});

test('an ingredient amount and unit are changed in place, and the other ingredients are posted back unchanged', async () => {
  const s = { form: mealForm([item(F1, 'okurka', 100), item(F2, 'rajče', 50)]) as Record<string, unknown> };
  serve(mealRoutes(s));
  const r = await client().changeMealIngredients({ mealId: M1, change: [{ foodId: F1, amount: 3, unitId: 'p50' }] });
  const items = posted()['items'] as Array<Record<string, unknown>>;
  assert.deepEqual([items[0]!['unitCount'], items[0]!['selectedUnitGuid'], items[1]!['unitCount']], [3, 'p50', 50]);
  assert.deepEqual(r.now.ingredients.map(i => [i.title, i.count, i.unit]), [['okurka', 3, 'porce (50 g)'], ['rajče', 50, '1 g']]);
  assert.equal(r.confirmed, true);
});

test('an added ingredient carries only its identity, amount and units, and the site\'s unit list is used', async () => {
  const s = { form: mealForm([item(F1, 'okurka', 100)]) as Record<string, unknown> };
  serve(mealRoutes(s));
  const r = await client().changeMealIngredients({ mealId: M1, add: [{ foodId: F3, amount: 2, unitId: 'pc1' }] });
  const added = (posted()['items'] as Array<Record<string, unknown>>)[1]!;
  assert.deepEqual([added['guid'], added['title'], added['unitCount'], added['selectedUnitGuid'], added['energy'], added['protein']], [F3, 'Test mrkev', 2, 'pc1', undefined, undefined]);
  assert.deepEqual(r.now.ingredients.map(i => i.title), ['okurka', 'Test mrkev']);
  const s2 = { form: mealForm([item(F1, 'okurka', 100)]) as Record<string, unknown> };
  serve(mealRoutes(s2));
  const grams = await client().changeMealIngredients({ mealId: M1, add: [{ foodId: F3, amount: 80 }] });
  assert.equal(grams.now.ingredients.at(-1)!.unit, '1 g');
});

test('an ingredient is removed by food id, and removing the last one, an unknown food or an ambiguous one is refused', async () => {
  const s = { form: mealForm([item(F1, 'okurka', 100), item(F2, 'rajče', 50)]) as Record<string, unknown> };
  serve(mealRoutes(s));
  const c = client();
  const r = await c.changeMealIngredients({ mealId: M1, remove: [F2] });
  assert.deepEqual(r.now.ingredients.map(i => i.title), ['okurka']);
  await assert.rejects(c.changeMealIngredients({ mealId: M1, remove: [F1] }), /at least one ingredient/);
  await assert.rejects(c.changeMealIngredients({ mealId: M1, remove: [F3] }), /not in "Test polévka"/);
  await assert.rejects(c.changeMealIngredients({ mealId: M1, change: [{ foodId: F3, amount: 5 }] }), /not in "Test polévka"/);

  const dup = { form: mealForm([item(F1, 'okurka', 100), item(F1, 'okurka', 50)]) as Record<string, unknown> };
  serve(mealRoutes(dup));
  await assert.rejects(client().changeMealIngredients({ mealId: M1, change: [{ foodId: F1, amount: 5 }] }), /2 times/);
  await assert.rejects(client().changeMealIngredients({ mealId: M1, remove: [F1] }), /2 times/);
  assert.deepEqual(writes(), []);
});

test('a unit that the food does not have, a silly amount, an empty request or too many ingredients write nothing', async () => {
  const s = { form: mealForm([item(F1, 'okurka', 100)]) as Record<string, unknown> };
  serve(mealRoutes(s));
  const c = client();
  await assert.rejects(c.changeMealIngredients({ mealId: M1, change: [{ foodId: F1, amount: 2, unitId: 'nope' }] }), /not valid for "okurka"/);
  await assert.rejects(c.changeMealIngredients({ mealId: M1, add: [{ foodId: F3, amount: 2, unitId: 'nope' }] }), /not valid for "Test mrkev"/);
  await assert.rejects(c.changeMealIngredients({ mealId: M1, add: [{ foodId: F3, amount: 0 }] }), /amount must be/);
  await assert.rejects(c.changeMealIngredients({ mealId: M1, add: [{ foodId: '../x', amount: 1 }] }), /Invalid entry id/);
  await assert.rejects(c.changeMealIngredients({ mealId: M1 }), /Nothing to change/);
  await assert.rejects(c.changeMealIngredients({ mealId: M1, add: Array.from({ length: 61 }, (_, i) => ({ foodId: `g${String(i).padStart(3, '0')}`.padEnd(16, 'x'), amount: 1 })) }), /at most 60/);
  assert.deepEqual(writes(), []);
});

// ---------------------------------------------------------------------------
// Review follow-ups
// ---------------------------------------------------------------------------

test('a diary that works in kJ refuses a kcal figure, and accepts the same figure given in kJ', async () => {
  serve([
    ['/foodstuff/detail/form/0', () => json(envelope({ ...ownFoodForm(), energyUnit: 'kj' }))],
    ['/user/activity/add/form/0', () => json(envelope(ownActivityForm({ energyUnit: 'kj' })))],
    [/^\/user\/diary\/\d{2}\.\d{2}\.\d{4}\/get$/, url => json(envelope(dayPayload(/\/user\/diary\/(\d{2}\.\d{2}\.\d{4})\/get/.exec(url.pathname)![1]!)))],
    ['/user/foodstuff/add', () => okReply()],
    ['/user/activity/add', () => okReply()],
  ]);
  const c = client();
  await assert.rejects(c.logCustomFood({ title: 'Test', energy: 650, meal: '1' }), /works in kj.*given in kcal.*energy_unit "kj"/);
  await assert.rejects(c.logCustomFood({ title: 'Test', energy: 650, meal: '1', energyUnit: 'kcal' }), /works in kj/);
  await assert.rejects(c.logCustomActivity({ title: 'Test', minutes: 30, energy: 200 }), /works in kj/);
  assert.deepEqual(writes(), []);
  const food = await c.logCustomFood({ title: 'Test', energy: 2700, meal: '1', energyUnit: 'kj' });
  assert.equal(food.energyUnit, 'kj');
  assert.equal((writes().find(b => b.path === '/user/foodstuff/add')!.body as { energy: number }).energy, 2700);
  const act = await c.logCustomActivity({ title: 'Test', minutes: 30, energy: 800, energyUnit: 'kj' });
  assert.equal(act.energyUnit, 'kj');
});

test('a kcal diary refuses kJ, and every nutrient field is set explicitly even when the form carries defaults', async () => {
  serve([
    ['/foodstuff/detail/form/0', () => json(envelope({ ...ownFoodForm(), detailValues: true, protein: 5, fat: 7 }))],
    [/^\/user\/diary\/\d{2}\.\d{2}\.\d{4}\/get$/, url => json(envelope(dayPayload(/\/user\/diary\/(\d{2}\.\d{2}\.\d{4})\/get/.exec(url.pathname)![1]!)))],
    ['/user/foodstuff/add', () => okReply()],
  ]);
  const c = client();
  await assert.rejects(c.logCustomFood({ title: 'Test', energy: 2700, meal: '1', energyUnit: 'kj' }), /works in kcal/);
  await c.logCustomFood({ title: 'Test', energy: 100, meal: '1' });
  const body = writes().find(b => b.path === '/user/foodstuff/add')!.body as Record<string, unknown>;
  assert.deepEqual([body['detailValues'], body['protein'], body['fat'], body['carbohydrate'], body['alcohol']], [false, null, null, null, null], 'defaults of the form do not pass for values the user gave');
});

test('a line added by someone else at the same time is not mistaken for the own food or activity', async () => {
  let lines: unknown[] = [];
  serve(ownFoodRoutes(() => (lines = [foodLine('other0000001', 'Něco jiného'), foodLine('own00000002', 'Test jídlo', { unit: null })]), () => lines));
  const r = await client().logCustomFood({ title: 'Test jídlo', energy: 100, meal: '3' });
  assert.equal(r.added?.id, 'own00000002');
  let acts: unknown[] = [];
  serve(ownActivityRoutes(ownActivityForm, () => (acts = [activityLine('actother0001', 'Cizí aktivita', '0,5 hod', '100'), activityLine('actown000002', 'Test aktivita', '0,5 hod', '100')]), () => acts));
  assert.equal((await client().logCustomActivity({ title: 'Test aktivita', minutes: 30, energy: 100 })).added?.id, 'actown000002');
});

test('changing an ingredient without a unit keeps the line\'s current unit, so 200 stays 200 of that unit', async () => {
  const s = { form: mealForm([item(F1, 'okurka', 1, { selectedUnitGuid: 'p50' })]) as Record<string, unknown> };
  serve(mealRoutes(s));
  await client().changeMealIngredients({ mealId: M1, change: [{ foodId: F1, amount: 200 }] });
  const line = (posted()['items'] as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual([line['unitCount'], line['selectedUnitGuid']], [200, 'p50']);
  await client().changeMealIngredients({ mealId: M1, change: [{ foodId: F1, amount: 200, unitId: '0000000000000001' }] });
  assert.equal((posted()['items'] as Array<Record<string, unknown>>)[0]!['selectedUnitGuid'], '0000000000000001');
});

test('a food that is already in the recipe, or listed twice in one call, cannot be added again', async () => {
  const s = { form: mealForm([item(F1, 'okurka', 100)]) as Record<string, unknown> };
  serve(mealRoutes(s));
  const c = client();
  await assert.rejects(c.changeMealIngredients({ mealId: M1, add: [{ foodId: F1, amount: 5 }] }), /already in "Test polévka".*use change/);
  await assert.rejects(c.changeMealIngredients({ mealId: M1, add: [{ foodId: F3, amount: 5 }, { foodId: F3, amount: 6 }] }), /already in|listed twice/);
  assert.deepEqual(writes(), []);
});

test('a recipe edit whose reply cannot be read counts as done when the site shows what was sent, and fails when it does not', async () => {
  const landed = { form: mealForm([item(F1, 'okurka', 100)]) as Record<string, unknown> };
  serve([
    ...mealRoutes(landed).filter(([m]) => m !== `/user/settings/meal/detail/edit/${M1}`),
    [
      `/user/settings/meal/detail/edit/${M1}`,
      (_url, init) => {
        landed.form = JSON.parse(String(init?.body));
        return new Response('<html>timeout</html>');
      },
    ],
  ]);
  const r = await client().updateMeal({ mealId: M1, portions: 5 });
  assert.deepEqual([r.confirmed, r.now.portions], [true, 5]);

  const lost = { form: mealForm([item(F1, 'okurka', 100)]) as Record<string, unknown> };
  serve([...mealRoutes(lost).filter(([m]) => m !== `/user/settings/meal/detail/edit/${M1}`), [`/user/settings/meal/detail/edit/${M1}`, () => new Response('<html>timeout</html>')]]);
  await assert.rejects(client().updateMeal({ mealId: M1, portions: 5 }), /expected JSON/);
});

test('a recipe without a step list at all can still be edited, and gets its steps', async () => {
  const s = { form: mealForm([item(F1, 'okurka', 100)], { description: null }) as Record<string, unknown> };
  serve(mealRoutes(s));
  const r = await client().updateMeal({ mealId: M1, steps: ['Nový krok'] });
  assert.deepEqual(r.now.steps, ['Nový krok']);
  const t = { form: mealForm([item(F1, 'okurka', 100)], { description: null }) as Record<string, unknown> };
  serve(mealRoutes(t));
  assert.deepEqual((await client().updateMeal({ mealId: M1, title: 'Jiný název' })).now.steps, []);
});
