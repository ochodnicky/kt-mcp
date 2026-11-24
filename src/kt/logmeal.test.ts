/**
 * Tests for logging a saved recipe whole or in part. The site scales a recipe
 * in the browser (every ingredient's `count`), so that is what is checked
 * here. The client runs against a stubbed fetch; the data is synthetic.
 */

import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { PAST, client, dayPayload, envelope, json, loginOk, okReply, restoreFetch, state, stubFetch } from './testkit.js';

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

const MEAL = 'e'.repeat(32);
const ing = (guid: string, title: string, count: number, over: Record<string, unknown> = {}) => ({
  guid,
  title,
  count,
  countOriginal: count,
  selected: true,
  weight: count,
  selectedUnitGuid: '0000000000000001',
  selectedUnitGuidOriginal: '0000000000000001',
  ...over,
});
const form = (over: Record<string, unknown> = {}, items = [ing('i1', 'okurka', 100), ing('i2', 'mrkev', 100)]) => ({
  guid: MEAL,
  title: 'Test bábovka',
  diaryTimeGuid: '1',
  date: '24.11.2026',
  totalWeight: 200,
  count: null,
  percent: null,
  portionsMax: null,
  selectedUnitMultiplier: 200,
  selectedUnitGuid: '0000000000000001',
  dontSendUnit: null,
  foodstuff: items,
  units: [{ id: '0000000000000004', title: 'porce', multiplier: -2 }, { id: '0000000000000003', title: '%', multiplier: -1 }, { id: '0000000000000001', title: '1 g', multiplier: 1 }],
  ...over,
});

interface Setup {
  form?: Record<string, unknown>;
  wholeEnergy?: number | null;
  /** The diary line the site writes after the POST. */
  line?: (factor: number) => Record<string, unknown> | null;
}

function routes(setup: Setup = {}): Route[] {
  let written: Record<string, unknown> | null = null;
  return [
    [`/user/meal/add/form/${MEAL}`, () => json(envelope(setup.form ?? form()))],
    ['/user/settings/meal/list', () => json(envelope(setup.wholeEnergy === null ? [] : [{ guid: MEAL, title: 'Test bábovka', energy: String(setup.wholeEnergy ?? 400), energyUnit: 'kcal', portions: 1 }]))],
    [
      /^\/user\/diary\/\d{2}\.\d{2}\.\d{4}\/get$/,
      url => {
        const date = /\/user\/diary\/(\d{2}\.\d{2}\.\d{4})\/get/.exec(url.pathname)![1]!;
        const lines = [{ id: 'other0000001', type: 'foodstuff', title: 'Něco jiného', unit: '10 x 1 g', energy: '50', energyUnit: 'kcal', isRecipe: false, guidUserMeal: null }];
        if (written) lines.push(written as never);
        return json(envelope(dayPayload(date, { meals: { '1': lines } })));
      },
    ],
    [
      '/user/meal/add',
      (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { foodstuff: Array<{ count: number; countOriginal: number }> };
        const factor = body.foodstuff[0]!.count / body.foodstuff[0]!.countOriginal;
        const line = setup.line ? setup.line(factor) : { id: 'newline00001', type: 'foodstuff', title: 'Test bábovka', unit: '100 g', energy: String(400 * factor), energyUnit: 'kcal', isRecipe: true, guidUserMeal: MEAL };
        written = line;
        return okReply();
      },
    ],
  ];
}

const posted = () => writes().find(b => b.path === '/user/meal/add')!.body as { foodstuff: Array<Record<string, unknown>>; [k: string]: unknown };
const counts = () => posted().foodstuff.map(i => i['count']);

test('without an amount the whole recipe is logged exactly as before: portion unit, count 1, ingredients untouched', async () => {
  serve(routes());
  const r = await client().logMeal({ mealId: MEAL, meal: '3', date: PAST });
  const b = posted();
  assert.deepEqual([b['selectedUnitGuid'], b['count'], b['diaryTimeGuid'], b['date'], b['dontSendUnit']], ['0000000000000004', 1, '3', PAST, null]);
  assert.deepEqual(counts(), [100, 100]);
  assert.deepEqual([r.amount, r.factor, r.expectedEnergy], [{ kind: 'whole' }, 1, 400]);
});

test('portions are scaled over the recipe\'s portion count, on every ingredient, and posted with the portion unit and the amount like the site does', async () => {
  serve(routes({ form: form({ portionsMax: 4 }) }));
  const r = await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, portions: 1 });
  const b = posted();
  assert.deepEqual(counts(), [25, 25]);
  assert.deepEqual([b['dontSendUnit'], b['selectedUnitGuid'], b['selectedUnitMultiplier']], [false, '0000000000000004', 1]);
  assert.deepEqual([r.factor, r.expectedEnergy, r.amount], [0.25, 100, { kind: 'portions', value: 1, of: 4 }]);
  assert.equal(r.added?.id, 'newline00001');
});

test('grams and percent are posted with the gram or percent unit and the typed amount, so the line reads like one typed on the site', async () => {
  serve(routes());
  await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, grams: 126 });
  assert.deepEqual([posted()['selectedUnitGuid'], posted()['selectedUnitMultiplier'], posted()['dontSendUnit']], ['0000000000000001', 126, false]);
  serve(routes());
  await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, percent: 50 });
  assert.deepEqual([posted()['selectedUnitGuid'], posted()['selectedUnitMultiplier'], posted()['dontSendUnit']], ['0000000000000003', 50, false]);
});

test('a recipe whose form offers no such unit is still scaled, with the label left to the site', async () => {
  serve(routes({ form: form({ units: [] }) }));
  await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, percent: 50 });
  assert.deepEqual([counts(), posted()['dontSendUnit'], posted()['selectedUnitGuid']], [[50, 50], true, '0000000000000001']);
});

test('grams are taken out of the total weight of the selected ingredients, and percent as a share', async () => {
  serve(routes());
  const g = await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, grams: 50 });
  assert.deepEqual(counts(), [25, 25]);
  assert.deepEqual([g.factor, g.amount], [0.25, { kind: 'grams', value: 50, of: 200 }]);
  serve(routes());
  const p = await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, percent: 33.333 });
  assert.deepEqual(counts(), [33.333, 33.333]);
  assert.ok(Math.abs(p.factor - 0.33333) < 1e-9);
  serve(routes());
  await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, percent: 100 / 3 });
  assert.deepEqual(counts(), [33.3333, 33.3333], 'counts are rounded to four decimals');
});

test('the original count is what is scaled, so a form that was already changed cannot be scaled twice', async () => {
  serve(routes({ form: form({ portionsMax: 2 }, [ing('i1', 'okurka', 7, { countOriginal: 100 }), ing('i2', 'mrkev', 100)]) }));
  await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, portions: 1 });
  assert.deepEqual(counts(), [50, 50]);
});

test('an ingredient the site marks as not selected is left out of the weight and posted as it was', async () => {
  serve(routes({ form: form({ totalWeight: 100 }, [ing('i1', 'okurka', 100), ing('i2', 'mrkev', 100, { selected: false, count: 0 })]) }));
  const r = await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, grams: 50 });
  assert.deepEqual(counts(), [50, 0]);
  assert.equal(r.amount.kind === 'grams' && r.amount.of, 100);
});

test('nothing is posted for more than one amount, a silly amount, a recipe without portions, no weights, a huge share, a bad id or a bad day', async () => {
  const c = client();
  serve(routes());
  await assert.rejects(c.logMeal({ mealId: MEAL, meal: '1', portions: 1, grams: 50 }), /only one of/);
  for (const bad of [{ portions: 0 }, { grams: -5 }, { percent: Number.NaN }]) {
    await assert.rejects(c.logMeal({ mealId: MEAL, meal: '1', ...bad }), /above 0/);
  }
  await assert.rejects(c.logMeal({ mealId: MEAL, meal: '1', portions: 1 }), /no portion count.*update_meal/);
  await assert.rejects(c.logMeal({ mealId: MEAL, meal: '1', percent: 1500 }), /looks like a mistake/);
  await assert.rejects(c.logMeal({ mealId: MEAL, meal: '1', date: '31.02.2026', percent: 50 }), /does not exist/);
  await assert.rejects(c.logMeal({ mealId: '../x', meal: '1', percent: 50 }), /Invalid recipe id.*list_my_meals/);
  assert.deepEqual(writes(), []);
  serve(routes({ form: form({}, [ing('i1', 'okurka', 100, { weight: null }), ing('i2', 'mrkev', 100, { weight: null })]) }));
  await assert.rejects(client().logMeal({ mealId: MEAL, meal: '1', grams: 50 }), /no weight for okurka, mrkev/);
  assert.deepEqual(writes(), []);
});

test('the new line is told apart from the others by its title, and is null when it cannot be identified', async () => {
  serve(routes());
  assert.equal((await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, percent: 50 })).added?.id, 'newline00001');
  serve(routes({ line: () => ({ id: 'newline00002', type: 'foodstuff', title: 'Jiný název', unit: '1 g', energy: '10', energyUnit: 'kcal', isRecipe: false, guidUserMeal: null }) }));
  const r = await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, percent: 50 });
  assert.equal(r.added, null);
});

test('the expected energy is the share of the recipe\'s whole energy, and unknown when the recipe list does not show it', async () => {
  serve(routes({ wholeEnergy: 2962, form: form({ portionsMax: 14 }) }));
  const r = await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, portions: 1 });
  assert.equal(r.expectedEnergy, 211.6);
  serve(routes({ wholeEnergy: null }));
  const u = await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, percent: 50 });
  assert.deepEqual([u.expectedEnergy, u.wholeRecipeEnergy], [null, null]);
});

test('get_meal_details data now carries the total weight and the portion count', async () => {
  serve([[`/user/meal/add/form/${MEAL}`, () => json(envelope(form({ portionsMax: 14, totalWeight: 1431 }, [])))]]);
  const d = await client().getMealDetails(MEAL);
  assert.deepEqual([d.totalWeight, d.portions], [1431, 14]);
  serve([[`/user/meal/add/form/${MEAL}`, () => json(envelope(form()))]]);
  assert.equal((await client().getMealDetails(MEAL)).portions, null);
});

test('grams are refused when one ingredient has no weight, because the share would be wrong with no sign of it', async () => {
  serve(routes({ form: form({ totalWeight: 200 }, [ing('i1', 'okurka', 100), ing('i2', 'vejce', 2, { weight: null })]) }));
  await assert.rejects(client().logMeal({ mealId: MEAL, meal: '1', date: PAST, grams: 50 }), /no weight for vejce/);
  assert.deepEqual(writes(), []);
  // percent and portions do not need weights
  serve(routes({ form: form({ portionsMax: 2 }, [ing('i1', 'okurka', 100), ing('i2', 'vejce', 2, { weight: null })]) }));
  await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, portions: 1 });
  assert.deepEqual(counts(), [50, 1]);
});

test('grams are refused when the ingredient weights do not add up to the weight the site states for the recipe', async () => {
  serve(routes({ form: form({ totalWeight: 1431 }, [ing('i1', 'okurka', 600), ing('i2', 'mrkev', 600)]) }));
  await assert.rejects(client().logMeal({ mealId: MEAL, meal: '1', date: PAST, grams: 350 }), /add up to 1200 g but the site states 1431 g/);
  assert.deepEqual(writes(), []);
  serve(routes({ form: form({ totalWeight: 1210 }, [ing('i1', 'okurka', 600), ing('i2', 'mrkev', 600)]) }));
  const r = await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, grams: 300 });
  assert.equal(r.amount.kind === 'grams' && r.amount.of, 1200);
});

test('a selected ingredient without a readable amount stops the whole write', async () => {
  serve(routes({ form: form({}, [ing('i1', 'okurka', 100), ing('i2', 'mrkev', 100, { count: null, countOriginal: null })]) }));
  await assert.rejects(client().logMeal({ mealId: MEAL, meal: '1', date: PAST, percent: 50 }), /no amount for mrkev/);
  assert.deepEqual(writes(), []);
});

test('the original unit is restored with the original count, as the site\'s dialog does', async () => {
  serve(routes({ form: form({}, [ing('i1', 'okurka', 2, { selectedUnitGuid: 'changed', selectedUnitGuidOriginal: 'piece' }), ing('i2', 'mrkev', 100)]) }));
  await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, percent: 50 });
  assert.deepEqual(posted().foodstuff.map(i => [i['count'], i['selectedUnitGuid']]), [[1, 'piece'], [50, '0000000000000001']]);
});

test('a line with the same title that was already in the diary is not taken for the new one', async () => {
  serve(
    routes().map(([m, h]) =>
      typeof m !== 'string' && String(m).includes('diary')
        ? ([m, (url: URL) => json(envelope(dayPayload(/\/user\/diary\/(\d{2}\.\d{2}\.\d{4})\/get/.exec(url.pathname)![1]!, { meals: { '1': [{ id: 'old000000001', type: 'foodstuff', title: 'Test bábovka', unit: '100 g', energy: '10', energyUnit: 'kcal', isRecipe: true, guidUserMeal: MEAL }, ...(state.bodies.some(b => b.path === '/user/meal/add') ? [{ id: 'newline00001', type: 'foodstuff', title: 'Test bábovka', unit: '100 g', energy: '200', energyUnit: 'kcal', isRecipe: true, guidUserMeal: MEAL }] : [])] } })))] as Route)
        : ([m, h] as Route),
    ),
  );
  const r = await client().logMeal({ mealId: MEAL, meal: '1', date: PAST, percent: 50 });
  assert.equal(r.added?.id, 'newline00001');
});

test('if the diary cannot be read before the write, the write still goes ahead and the new line is simply not identified', async () => {
  serve(routes().map(([m, h]) => (typeof m !== 'string' && String(m).includes('diary') ? ([m, () => new Response('<html>down</html>')] as Route) : ([m, h] as Route))));
  const r = await client().logMeal({ mealId: MEAL, meal: '1', date: PAST });
  assert.equal(writes().some(b => b.path === '/user/meal/add'), true);
  assert.equal(r.added, null);
});
