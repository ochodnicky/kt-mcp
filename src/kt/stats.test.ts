/**
 * Tests for drinking, the diary analysis, tracked measurements, moving a diary
 * line, the extra nutrient figures and the public recipe catalogue. The client
 * runs against a stubbed fetch; the data is synthetic (see testkit.ts).
 */

import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { KtError, todayCzech } from './client.js';
import { rankNutrient } from './ranking.js';
import { parseGoalAnalysis, parseHydration, summarizeHydration } from './stats.js';
import { matchByName, parseTrackers, splitTitle } from './tracking.js';
import {
  OTHER_PAST,
  PAST,
  client,
  dayPayload,
  envelope,
  foodLine,
  json,
  loginOk,
  okReply,
  restoreFetch,
  state,
  stubFetch,
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

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const ID_C = 'c'.repeat(32);

// ---------------------------------------------------------------------------
// Drinking
// ---------------------------------------------------------------------------

const series = (rows: Array<[string, number | null]>) => rows.map(([description, value]) => ({ description, value, from: 0 }));
const drinkPayload = () => ({
  type: 'drink',
  unit: 'kcal',
  values: series([['10.11.2026', 2.5], ['11.11.2026', 0], ['12.11.2026', 1.5]]),
  target: series([['10.11.2026', 3.3], ['11.11.2026', 3.3], ['12.11.2026', 2]]),
});

test('drinking is read per requested day, and a day the site left out stays unknown', () => {
  const days = parseHydration(drinkPayload(), ['10.11.2026', '11.11.2026', '12.11.2026', '13.11.2026']);
  assert.deepEqual(days.map(d => d.litres), [2.5, 0, 1.5, null]);
  assert.deepEqual(days.map(d => d.goalLitres), [3.3, 3.3, 2, null]);
});

test('drinking averages are kept apart for all days and for days with something logged, and a missing day is never a zero', () => {
  const s = summarizeHydration(parseHydration(drinkPayload(), ['10.11.2026', '11.11.2026', '12.11.2026', '13.11.2026']));
  assert.equal(s.days, 4);
  assert.equal(s.daysWithDrinks, 2);
  assert.equal(s.averageLitres, 1.33); // (2.5 + 0 + 1.5) / 3, the unknown day is not counted
  assert.equal(s.averageLitresOnDaysWithDrinks, 2);
  assert.equal(s.daysGoalReached, 0); // 2.5 of 3.3 and 1.5 of 2 are both short
});

test('a day with drinks counts as reached only when the litres are at least the goal', () => {
  const s = summarizeHydration([
    { date: 'a', litres: 3.3, goalLitres: 3.3 },
    { date: 'b', litres: 3.2, goalLitres: 3.3 },
    { date: 'c', litres: 0, goalLitres: 0 },
    { date: 'd', litres: 2, goalLitres: null },
  ]);
  assert.equal(s.daysGoalReached, 1);
});

test('an unrecognised drinking response throws instead of looking like a dry week', () => {
  assert.throws(() => parseHydration(null, ['10.11.2026']), KtError);
  assert.throws(() => parseHydration({ values: [] }, ['10.11.2026']), /target/);
  assert.throws(() => parseHydration({ values: [{ value: 1 }], target: [] }, ['10.11.2026']), /no date/);
});

test('getHydration asks the site for exactly the requested period and refuses an absurd one', async () => {
  serve([[/^\/statistic\/drink\//, () => json(envelope(drinkPayload()))]]);
  const days = await client().getHydration('10.11.2026', '12.11.2026');
  assert.deepEqual(state.calls.filter(c => c.startsWith('/statistic')), ['/statistic/drink/10.11.2026/12.11.2026/get']);
  assert.equal(days.length, 3);
  await assert.rejects(client().getHydration('01.01.2024', '12.11.2026'), /Range too long/);
  await assert.rejects(client().getHydration('31.02.2026', '12.11.2026'), /does not exist/);
});

// ---------------------------------------------------------------------------
// Diary analysis
// ---------------------------------------------------------------------------

const analysisPayload = () => ({
  from: Date.UTC(2026, 10, 9, 23),
  to: Date.UTC(2026, 10, 15, 22, 59, 59),
  recordsMissing: false,
  list: [
    { title: 'Bílkoviny', value: 106.6, target: 168.8, percent: 63, valuePercent: 28, targetPercent: 35, subset: null },
    { title: 'Tuky', value: 74, target: 70.5, percent: 105, valuePercent: 20, targetPercent: 14, subset: { title: 'Nasycené mastné kyseliny', value: 29, target: 23, percent: 125, valuePercent: 8, targetPercent: 5, subset: null } },
  ],
  energy: { value: 2051.07, target: 2092.7, percent: 98, energyUnit: 'kcal' },
  salt: { value: 6.45, target: 5, percent: 129 },
  calcium: { value: 0.54343593, target: 1, percent: 54 },
  drink: { value: 0.554, target: 3.3, percent: 17 },
  alcohol: null,
  totalValueInfluence: [{ title: 'Bílkoviny', items: [{ id: 'f1', title: 'Test maso', valueString: '13,6 g', count: '4x' }, { id: 'f2', title: 'Test sýr', valueString: '9,7 g', count: '1x' }] }],
  totalValueInfluenceCategory: [{ title: 'Bílkoviny', items: [{ id: '1047', title: 'Maso', valueString: '27,9 g', count: '6x' }] }],
});

test('the analysis flattens the saturated part, shows calcium in milligrams and keeps the site\'s own source texts', () => {
  const a = parseGoalAnalysis(analysisPayload());
  assert.deepEqual(a.nutrients.map(n => [n.title, n.partOf]), [['Bílkoviny', null], ['Tuky', null], ['Nasycené mastné kyseliny', 'Tuky']]);
  assert.equal(a.nutrients[0]!.percentOfGoal, 63);
  assert.deepEqual(a.calcium, { average: 543.44, goal: 1000, percentOfGoal: 54, unit: 'mg' });
  assert.deepEqual(a.drinking, { average: 0.55, goal: 3.3, percentOfGoal: 17, unit: 'l' });
  assert.equal(a.energy?.unit, 'kcal');
  assert.equal(a.alcohol, null);
  assert.deepEqual(a.sourcesByFood[0]!.items[0], { title: 'Test maso', amount: '13,6 g', times: '4x' });
  assert.equal(a.from, '10.11.2026');
  assert.equal(a.to, '15.11.2026');
});

test('an analysis block the site leaves out is null, not zero, and a broken response throws', () => {
  const p = analysisPayload() as Record<string, unknown>;
  delete p['salt'];
  p['calcium'] = { value: null };
  const a = parseGoalAnalysis(p);
  assert.equal(a.salt, null);
  assert.equal(a.calcium, null);
  assert.throws(() => parseGoalAnalysis({ list: 'x' }), /no nutrient list/);
  assert.throws(() => parseGoalAnalysis({ list: [{ value: 1 }] }), /no title/);
  assert.throws(() => parseGoalAnalysis({ list: [], totalValueInfluence: [{ title: 'x' }] }), /malformed/);
});

test('the analysis passes through alcohol only as far as it can be read', () => {
  const a = parseGoalAnalysis({ ...analysisPayload(), alcohol: { title: 'Alkohol', value: 12.5, valueString: '12,5', evil: { nested: true } } });
  assert.deepEqual(a.alcohol, { title: 'Alkohol', value: 12.5, valueString: '12,5' });
});

test('getGoalAnalysis fetches the analysis and the tips for the period, narrowed to a meal on request, and orders the tips', async () => {
  serve([
    [/\/statistic\/analysis\/graph\//, () => json(envelope(analysisPayload()))],
    [
      /\/statistic\/analysis\/tips\//,
      () =>
        json(
          envelope([
            { key: 'b', title: 'Second <b>tip</b>', text: 'Why &nbsp;it <i>matters</i>', advice: 'Do this', order: 5 },
            { key: 'a', title: 'First tip', text: null, advice: null, order: 1 },
          ]),
        ),
    ],
  ]);
  const { analysis, tips } = await client().getGoalAnalysis('09.11.2026', '15.11.2026', '3');
  assert.equal(analysis.nutrients.length, 3);
  assert.deepEqual(tips.map(t => t.title), ['First tip', 'Second tip']);
  assert.equal(tips[1]!.explanation, 'Why &nbsp;it matters');
  assert.deepEqual(state.calls.filter(c => c.includes('analysis')).sort(), [
    '/statistic/analysis/graph/09.11.2026/15.11.2026/get',
    '/statistic/analysis/tips/09.11.2026/15.11.2026/get',
  ]);
});

test('an unknown meal for the analysis is refused before any request', async () => {
  serve([]);
  await assert.rejects(client().getGoalAnalysis('09.11.2026', '15.11.2026', '9' as never), /Unknown meal/);
  assert.deepEqual(state.calls, []);
});

// ---------------------------------------------------------------------------
// Tracked measurements
// ---------------------------------------------------------------------------

const TODAY = todayCzech();
const tracker = (id: string, type: string, values: Array<[string, number, number]>) => ({
  guid: id,
  type,
  unit: null,
  values: values.map(([guid, from, value]) => ({ guid, from, value, valueString: String(value) })),
});
const KINDS = {
  typeGuid: null,
  typeOptions: [
    { guid: 'k1', title: 'Obvod pasu [cm]' },
    { guid: 'k2', title: 'Obvod boků [cm]' },
    { guid: 'k3', title: 'Tuky [%]' },
  ],
  title: null,
  unit: null,
  value: null,
};

test('a tracker title is split into name and unit, and the values come back oldest first', () => {
  assert.deepEqual(splitTitle('Obvod pasu [cm]'), { name: 'Obvod pasu', unit: 'cm' });
  assert.deepEqual(splitTitle('Vlastní'), { name: 'Vlastní', unit: null });
  const [t] = parseTrackers([tracker(ID_A, 'Tuky [%]', [[ID_B, Date.UTC(2026, 10, 20, 12), 21.5], [ID_C, Date.UTC(2026, 10, 10, 12), 22.4]])]);
  assert.deepEqual(t!.values.map(v => [v.date, v.value]), [['10.11.2026', 22.4], ['20.11.2026', 21.5]]);
  assert.equal(t!.unit, '%');
});

test('an unreadable tracker throws rather than dropping a value', () => {
  assert.throws(() => parseTrackers({}), /expected a list/);
  assert.throws(() => parseTrackers([{ guid: ID_A, type: 'Tuky [%]', values: [{ guid: ID_B, from: 1, value: null }] }]), /unreadable/);
  assert.throws(() => parseTrackers([{ guid: ID_A, type: 'Tuky [%]' }]), /no value list/);
});

test('names match without diacritics and by part, and an exact name wins over a longer one', () => {
  const items = [{ id: '1', name: 'Obvod pasu' }, { id: '2', name: 'Obvod boků' }, { id: '3', name: 'Obvod břicha' }];
  assert.deepEqual(matchByName(items, 'PAS').map(i => i.id), ['1']);
  assert.deepEqual(matchByName(items, 'obvod').map(i => i.id), ['1', '2', '3']);
  assert.deepEqual(matchByName(items, 'boku').map(i => i.id), ['2']);
  assert.deepEqual(matchByName(items, ''), []);
});

function trackerRoutes(listed: () => unknown[], extra: Route[] = []): Route[] {
  return [
    [/^\/user\/track\/form$/, () => json(envelope(KINDS))],
    [/^\/statistic\/optional\//, () => json(envelope(listed()))],
    ...extra,
  ];
}

test('a value for an existing tracker is posted with its tracker id and the chosen date, then read back', async () => {
  let values: Array<[string, number, number]> = [];
  serve(
    trackerRoutes(() => [tracker(ID_A, 'Obvod pasu [cm]', values)], [
      [
        '/user/track/value/add',
        () => {
          values = [[ID_B, Date.UTC(2026, 10, 10, 12), 94.5]];
          return okReply();
        },
      ],
    ]),
  );
  const r = await client().addTrackedValue({ measurement: 'pas', value: 94.5, date: PAST });
  assert.deepEqual(state.bodies.find(b => b.path === '/user/track/value/add')?.body, { trackGuid: ID_A, value: 94.5, valueHint: null, unit: null, date: PAST });
  assert.equal(r.createdTracker, false);
  assert.equal(r.recorded, 94.5);
  assert.equal(state.bodies.some(b => b.path === '/user/track/add'), false);
});

test('an untracked kind is started with the value for today, using the site\'s own form', async () => {
  let created = false;
  serve(
    trackerRoutes(() => (created ? [tracker(ID_A, 'Tuky [%]', [[ID_B, Date.now(), 21.5]])] : []), [
      [
        '/user/track/add',
        () => {
          created = true;
          return okReply();
        },
      ],
    ]),
  );
  const r = await client().addTrackedValue({ measurement: 'tuky', value: 21.5 });
  const posted = state.bodies.find(b => b.path === '/user/track/add')?.body as Record<string, unknown>;
  assert.equal(posted['typeGuid'], 'k3');
  assert.equal(posted['value'], 21.5);
  assert.equal('typeOptions' in posted, true, 'the form is posted back whole');
  assert.equal(r.createdTracker, true);
  assert.equal(r.date, TODAY);
});

test('starting a tracker for a past day is refused, because the site would record it for today', async () => {
  serve(trackerRoutes(() => []));
  await assert.rejects(client().addTrackedValue({ measurement: 'tuky', value: 21.5, date: PAST }), /call again without a date/);
  assert.deepEqual(state.bodies.filter(b => b.path !== '/login/create'), []);
});

test('a future day, a silly value, an unknown or an ambiguous name write nothing', async () => {
  serve(trackerRoutes(() => [tracker(ID_A, 'Obvod pasu [cm]', []), tracker(ID_B, 'Obvod boků [cm]', [])]));
  const c = client();
  await assert.rejects(c.addTrackedValue({ measurement: 'pas', value: 90, date: '01.01.2999' }), /future/);
  await assert.rejects(c.addTrackedValue({ measurement: 'pas', value: 0 }), /above 0/);
  await assert.rejects(c.addTrackedValue({ measurement: 'obvod', value: 90 }), /matches several trackers/);
  await assert.rejects(c.addTrackedValue({ measurement: 'rozpětí', value: 90 }), /Available: Obvod pasu, Obvod boků, Tuky/);
  assert.deepEqual(state.bodies.filter(b => b.path !== '/login/create'), []);
});

test('only a measurement the site lists as a tracker value can be deleted, so a weight record is never touched', async () => {
  let present = true;
  serve(
    trackerRoutes(() => [tracker(ID_A, 'Obvod pasu [cm]', present ? [[ID_B, Date.UTC(2026, 10, 10, 12), 94]] : [])], [
      [
        /^\/user\/track\/value\/delete\//,
        () => {
          present = false;
          return okReply();
        },
      ],
    ]),
  );
  const c = client();
  await assert.rejects(c.deleteTrackedValue(ID_C), /No tracked measurement/);
  await assert.rejects(c.deleteTrackedValue('../weight'), /Invalid measurement id/);
  assert.equal(state.calls.some(p => p.includes('/value/delete/')), false);
  const r = await c.deleteTrackedValue(ID_B);
  assert.deepEqual([r.tracker, r.date, r.value, r.confirmed], ['Obvod pasu', '10.11.2026', 94, true]);
  assert.ok(state.calls.includes(`/user/track/value/delete/${ID_B}/`));
});

// ---------------------------------------------------------------------------
// Moving a diary line
// ---------------------------------------------------------------------------

const THE_ID = 'entry000001';
function moveRoutes(mealOfEntry: () => string, dayOfEntry: () => string): Route[] {
  return [
    [
      /^\/user\/diary\/\d{2}\.\d{2}\.\d{4}\/get$/,
      url => {
        const date = /\/user\/diary\/(\d{2}\.\d{2}\.\d{4})\/get/.exec(url.pathname)![1]!;
        const here = date === dayOfEntry();
        return json(envelope(dayPayload(date, { meals: here ? { [mealOfEntry()]: [foodLine(THE_ID, 'Test skyr')] } : {} })));
      },
    ],
  ];
}

test('moving to another meal uses the site\'s drag route with the meal id and 0 for the day, and reads the result back', async () => {
  let meal = '1';
  serve([
    ...moveRoutes(() => meal, () => PAST),
    [
      /dragndrop$/,
      () => {
        meal = '3';
        return okReply();
      },
    ],
  ]);
  const r = await client().moveDiaryEntry({ date: PAST, entryId: THE_ID, meal: '3' });
  assert.ok(state.calls.includes(`/user/diary/${THE_ID}/3/0/dragndrop`));
  assert.deepEqual([r.from.meal, r.to.meal, r.confirmed], ['Snídaně', 'Oběd', true]);
});

test('moving to another day uses the route with 0 for the meal, and then moves the meal as well when asked', async () => {
  let day = PAST;
  let meal = '1';
  serve([
    ...moveRoutes(() => meal, () => day),
    [
      /dragndrop$/,
      url => {
        if (url.pathname.endsWith('/0/11.11.2026/dragndrop')) day = '11.11.2026';
        else meal = '5';
        return okReply();
      },
    ],
  ]);
  const r = await client().moveDiaryEntry({ date: PAST, entryId: THE_ID, toDate: '11.11.2026', meal: '5' });
  const moves = state.calls.filter(c => c.endsWith('dragndrop'));
  assert.deepEqual(moves, [`/user/diary/${THE_ID}/0/11.11.2026/dragndrop`, `/user/diary/${THE_ID}/5/0/dragndrop`]);
  assert.deepEqual([r.to.date, r.to.meal, r.confirmed], ['11.11.2026', 'Večeře', true]);
});

test('a move that did not land is reported as unconfirmed, never as success', async () => {
  serve([...moveRoutes(() => '1', () => PAST), [/dragndrop$/, () => okReply()]]);
  const r = await client().moveDiaryEntry({ date: PAST, entryId: THE_ID, meal: '3' });
  assert.equal(r.confirmed, false);
});

test('nothing is moved for an unknown entry, a missing target, a bad meal or an id that is not plain', async () => {
  serve(moveRoutes(() => '1', () => PAST));
  const c = client();
  await assert.rejects(c.moveDiaryEntry({ date: PAST, entryId: 'nosuchentry1', meal: '3' }), /No diary entry/);
  await assert.rejects(c.moveDiaryEntry({ date: PAST, entryId: THE_ID }), /Say where to move it/);
  await assert.rejects(c.moveDiaryEntry({ date: PAST, entryId: THE_ID, meal: '9' as never }), /Unknown meal/);
  await assert.rejects(c.moveDiaryEntry({ date: PAST, entryId: THE_ID, toDate: PAST }), /already on that day/);
  await assert.rejects(c.moveDiaryEntry({ date: PAST, entryId: '../x/../y' }), /Invalid entry id/);
  assert.equal(state.calls.some(p => p.endsWith('dragndrop')), false);
});

// ---------------------------------------------------------------------------
// Extra nutrient figures
// ---------------------------------------------------------------------------

test('the diary lines carry calcium, cholesterol, sodium, fat kinds and alcohol, and an unknown one stays null', async () => {
  serve([
    [
      /^\/user\/diary\/\d{2}\.\d{2}\.\d{4}\/get$/,
      () =>
        json(
          envelope(
            dayPayload(PAST, {
              meals: { '1': [foodLine('e1', 'Test sýr', { calcium: 0.456, cholesterol: 0.114, sodium: null, transFattyAcid: 0.6, monoSaturated: 6.75, polySaturated: 3.3, alcohol: 0 })] },
            }),
          ),
        ),
    ],
  ]);
  const day = await client().getDayEntries(PAST);
  assert.deepEqual(day.meals[0]!.entries[0]!.nutrients, {
    protein: 10,
    carbohydrate: 5,
    fat: 2,
    fibre: null,
    sugar: null,
    saturatedFat: null,
    salt: 0.1,
    calcium: 0.456,
    cholesterol: 0.114,
    sodium: null,
    transFat: 0.6,
    monounsaturatedFat: 6.75,
    polyunsaturatedFat: 3.3,
    alcohol: 0,
  });
});

test('ranking by calcium is reported in milligrams, and unknown lines are not turned into zeros', async () => {
  serve([
    [
      /^\/user\/diary\/\d{2}\.\d{2}\.\d{4}\/get$/,
      () =>
        json(
          envelope(
            dayPayload(PAST, {
              meals: { '1': [foodLine('e1', 'Test sýr', { calcium: 0.456 }), foodLine('e2', 'Test sýr', { calcium: null }), foodLine('e3', 'Test chléb', { calcium: null })] },
            }),
          ),
        ),
    ],
  ]);
  const outcomes = await client().getDiaryRange(PAST, PAST);
  const r = rankNutrient(outcomes, 'calcium', 10);
  assert.equal(r.unit, 'mg');
  assert.equal(r.ranking[0]!.total, 456);
  assert.equal(r.ranking[0]!.unknownLines, 1);
  assert.deepEqual(r.unknown.map(u => u.title), ['Test chléb']);
});

// ---------------------------------------------------------------------------
// Recipe catalogue
// ---------------------------------------------------------------------------

const hit = (id: string, title: string) => ({
  id,
  title,
  url: 'test-slug',
  energy: '88,9 kcal',
  protein: '13,5',
  carbohydrate: '3,3',
  fat: '2,1',
  fiber: '0,41',
  rating: '4,3',
  user: 'someone@example.invalid',
  author: { nickname: 'Test_autor', linkInstagram: 'https://example.invalid' },
});
const TAGS = [
  { id: 't1', title: 'večeře', url: 'vecere' },
  { id: 't2', title: 'maso', url: 'maso' },
  { id: 't3', title: 'bez laktózy', url: 'bez-laktozy' },
];

test('a recipe search sends the site\'s own filter names, maps tags to their slugs and never forwards the author\'s e-mail', async () => {
  serve([
    ['/recipe/tag/filters', () => json(envelope(TAGS))],
    ['/recipe/public/filter', () => json({ requestId: null, count: 290, data: [hit(ID_A, 'Test kuře')] })],
  ]);
  const r = await client().searchRecipes({ query: 'kuře', tags: ['VEČEŘE', 'maso'], nutrient: 'protein', min: 10, max: 40, sort: 'newest', maxPreparationMinutes: 25, page: 2, limit: 5 });
  assert.equal(r.total, 290);
  assert.deepEqual(r.recipes[0]!.per100g, { energy: 88.9, energyUnit: 'kcal', protein: 13.5, carbohydrate: 3.3, fat: 2.1, fibre: 0.41 });
  assert.equal(r.recipes[0]!.author, 'Test_autor');
  assert.equal(JSON.stringify(r).includes('example.invalid'), false);
});

test('the recipe search parameters reach the site as the site expects them', async () => {
  let seen: URL | undefined;
  serve([
    ['/recipe/tag/filters', () => json(envelope(TAGS))],
    [
      '/recipe/public/filter',
      url => {
        seen = url;
        return json({ requestId: null, count: 0, data: [] });
      },
    ],
  ]);
  await client().searchRecipes({ query: ' kuře ', tags: ['večeře', 'maso'], nutrient: 'protein', min: 10, max: 40, sort: 'newest', maxPreparationMinutes: 25, page: 2, limit: 5 });
  const p = seen!.searchParams;
  assert.deepEqual(
    [p.get('query'), p.get('tags'), p.get('sliderType'), p.get('min'), p.get('max'), p.get('sort'), p.get('preparationTime'), p.get('page'), p.get('limit')],
    ['kuře', 'vecere-maso-', '1', '10', '40', 'created', '30', '2', '5'],
  );
});

test('a recipe search with a bad range, an unknown tag or a limit out of bounds is refused before any request for results', async () => {
  serve([['/recipe/tag/filters', () => json(envelope(TAGS))]]);
  const c = client();
  await assert.rejects(c.searchRecipes({ min: 5 }), /which nutrient/);
  await assert.rejects(c.searchRecipes({ nutrient: 'fat', min: 9, max: 3 }), /min must not be above max/);
  await assert.rejects(c.searchRecipes({ tags: ['kosmická'] }), /Unknown or ambiguous recipe tag/);
  await assert.rejects(c.searchRecipes({ limit: 99 }), /limit must be/);
  assert.equal(state.calls.includes('/recipe/public/filter'), false);
});

test('a recipe search that returns something else than a list of recipes throws', async () => {
  serve([['/recipe/public/filter', () => json({ count: 1, data: [{ title: 'no id' }] })]]);
  await assert.rejects(client().searchRecipes({}), /no id or title/);
  serve([['/recipe/public/filter', () => new Response('<html>nope</html>')]]);
  await assert.rejects(client().searchRecipes({}), /expected JSON/);
});

const recipeDetail = (over: Record<string, unknown> = {}) => ({
  id: ID_A,
  title: 'Test kuře',
  link: 'https://kaloricketabulky.cz/recepty/test-kure',
  energy: '2 301',
  energyUnit: 'kcal',
  protein: '42,8',
  carbohydrate: '10,3',
  fat: '6,5',
  fiber: '1,3',
  sugar: '9,4',
  saturatedFattyAcid: '3,2',
  salt: '1,3',
  description: ['Krok <b>jedna</b>.', 'Krok dvě.'],
  content: [{ foodstuff: { id: 'f1', title: 'kuřecí prsa', userEmail: 'someone@example.invalid' }, unit: 'porce (150 g)' }],
  tags: [{ title: 'maso' }, { title: 'večeře' }],
  author: { id: 'x', nickname: 'Test_autor', linkInstagram: 'https://example.invalid' },
  totalWeight: 2198,
  portions: 8,
  rating: 4.27,
  ratingCount: 35,
  preparationTime: '45',
  ...over,
});

test('a recipe detail has ingredients, steps and the whole-recipe nutrition, and never the other users\' e-mails', async () => {
  serve([[`/recipe/detail/${ID_A}`, () => json(envelope(recipeDetail()))]]);
  const r = await client().getRecipe(ID_A);
  assert.equal(r.total.energy, 2301);
  assert.equal(r.portions, 8);
  assert.equal(r.preparationMinutes, 45);
  assert.deepEqual(r.ingredients, [{ title: 'kuřecí prsa', amount: 'porce (150 g)', foodId: 'f1' }]);
  assert.deepEqual(r.steps, ['Krok jedna.', 'Krok dvě.']);
  assert.deepEqual(r.tags, ['maso', 'večeře']);
  assert.equal(JSON.stringify(r).includes('example.invalid'), false);
});

test('a recipe without a portion count has none, and an id that is not a plain recipe id is refused', async () => {
  serve([[`/recipe/detail/${ID_A}`, () => json(envelope(recipeDetail({ portions: null })))]]);
  assert.equal((await client().getRecipe(ID_A)).portions, null);
  await assert.rejects(client().getRecipe('../../user/settings'), /Invalid recipe id/);
});

// ---------------------------------------------------------------------------
// Review follow-ups: lookups, partial failures, unreadable replies
// ---------------------------------------------------------------------------

test('a tracker the site lists with no values is found and reused, so no second tracker is started', async () => {
  serve(trackerRoutes(() => [tracker(ID_A, 'Obvod pasu [cm]', [])], [['/user/track/value/add', () => okReply()]]));
  const r = await client().addTrackedValue({ measurement: 'pas', value: 93 });
  assert.equal(r.createdTracker, false);
  assert.equal(state.bodies.some(b => b.path === '/user/track/add'), false);
  assert.equal((state.bodies.find(b => b.path === '/user/track/value/add')?.body as { trackGuid: string }).trackGuid, ID_A);
});

test('the lookup before a write reaches back far enough to find an old tracker', async () => {
  const windows: string[] = [];
  serve([
    [/^\/user\/track\/form$/, () => json(envelope(KINDS))],
    [
      /^\/statistic\/optional\//,
      url => {
        windows.push(url.pathname.split('/').slice(3, 5).join('-'));
        return json(envelope([tracker(ID_A, 'Obvod pasu [cm]', [])]));
      },
    ],
    ['/user/track/value/add', () => okReply()],
  ]);
  await client().addTrackedValue({ measurement: 'pas', value: 93 });
  assert.ok(windows.every(w => w.startsWith('01.01.2000-')), windows.join(' '));
});

test('the tracker that was started is the one that was not there before, whatever it is called', async () => {
  let created = false;
  serve(
    trackerRoutes(() => (created ? [tracker(ID_C, 'Obvod pasu [cm]', []), tracker(ID_A, 'Tuky [%]', [[ID_B, Date.now(), 21.5]])] : [tracker(ID_C, 'Obvod pasu [cm]', [])]), [
      [
        '/user/track/add',
        () => {
          created = true;
          return okReply();
        },
      ],
    ]),
  );
  const r = await client().addTrackedValue({ measurement: 'tuky', value: 21.5 });
  assert.deepEqual([r.tracker, r.createdTracker, r.recorded], ['Tuky', true, 21.5]);
});

test('the value read back is the one for the requested date, not another day\'s', async () => {
  serve(
    trackerRoutes(() => [tracker(ID_A, 'Obvod pasu [cm]', [[ID_B, Date.UTC(2026, 10, 9, 12), 90], [ID_C, Date.UTC(2026, 10, 10, 12), 94.5]])], [
      ['/user/track/value/add', () => okReply()],
    ]),
  );
  assert.equal((await client().addTrackedValue({ measurement: 'pas', value: 94.5, date: PAST })).recorded, 94.5);
  assert.equal((await client().addTrackedValue({ measurement: 'pas', value: 90, date: OTHER_PAST })).recorded, 90);
});

test('a tracker that was started but cannot be read back is reported as started, so the call is not repeated', async () => {
  let created = false;
  serve([
    [/^\/user\/track\/form$/, () => json(envelope(KINDS))],
    [/^\/statistic\/optional\//, () => (created ? new Response('boom') : json(envelope([])))],
    [
      '/user/track/add',
      () => {
        created = true;
        return okReply();
      },
    ],
  ]);
  await assert.rejects(client().addTrackedValue({ measurement: 'tuky', value: 21.5 }), /was started with today's value.*do not repeat/);
});

test('a delete whose reply cannot be read counts as done when the value is gone, and fails when it is still listed', async () => {
  let present = true;
  serve(
    trackerRoutes(() => [tracker(ID_A, 'Obvod pasu [cm]', present ? [[ID_B, Date.UTC(2026, 10, 10, 12), 94]] : [])], [
      [
        /^\/user\/track\/value\/delete\//,
        () => {
          present = false;
          return new Response('<html>oops</html>');
        },
      ],
    ]),
  );
  const done = await client().deleteTrackedValue(ID_B);
  assert.equal(done.confirmed, true);

  present = true;
  serve(trackerRoutes(() => [tracker(ID_A, 'Obvod pasu [cm]', [[ID_B, Date.UTC(2026, 10, 10, 12), 94]])], [[/^\/user\/track\/value\/delete\//, () => new Response('<html>oops</html>')]]));
  await assert.rejects(client().deleteTrackedValue(ID_B), /expected JSON/);
});

test('when the day moved but the meal step fails, the error says where the line is now', async () => {
  let day = PAST;
  serve([
    ...moveRoutes(() => '1', () => day),
    [
      /dragndrop$/,
      url => {
        if (url.pathname.endsWith('/0/11.11.2026/dragndrop')) {
          day = '11.11.2026';
          return okReply();
        }
        return new Response('<html>nope</html>');
      },
    ],
  ]);
  await assert.rejects(
    client().moveDiaryEntry({ date: PAST, entryId: THE_ID, toDate: '11.11.2026', meal: '5' }),
    (e: Error) => /was moved to 11\.11\.2026 \(still under Snídaně\)/.test(e.message) && /call move_diary_entry again with date 11\.11\.2026/.test(e.message),
  );
});

test('a recipe search error from the site is shown as the site worded it', async () => {
  serve([['/recipe/public/filter', () => json({ code: 5, message: 'Hledání je dočasně nedostupné', data: null })]]);
  await assert.rejects(client().searchRecipes({}), /Hledání je dočasně nedostupné/);
});
