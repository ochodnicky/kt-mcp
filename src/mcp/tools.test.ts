/**
 * Checks the MCP-facing side of get_day_entries / get_diary_range with a fake
 * server and a fake client. Fixture data is synthetic (see kt/diary.test.ts).
 */

import { NO_EXTRA_NUTRIENTS } from '../kt/testkit.js';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KtAuthError, type DayOutcome, type DiaryDay, type KtClient, todayCzech } from '../kt/client.js';
import type { Goals } from '../kt/goals.js';
import { shiftDate } from '../kt/util.js';
import { registerPrompts } from './prompts.js';
import { registerTools } from './tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
interface Registered {
  config: { annotations?: Record<string, unknown>; description?: string };
  handler: Handler;
}

function register(client: Partial<KtClient>) {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: Registered['config'], handler: Handler) => {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;
  registerTools(server, client as KtClient);
  return tools;
}

const day = (date: string, entryCount: number): DiaryDay => ({
  date,
  energyUnit: 'kcal',
  entryCount,
  activities: [{ id: 'act1', title: 'Test chůze', durationMinutes: 50, steps: 4000, energy: 216, energyUnit: 'kcal' }],
  notes: [{ id: 'n1', text: 'Test poznámka', created: '2026-11-10T10:00:00.000Z' }],
  meals: [
    {
      id: '1',
      title: 'Snídaně',
      energyTotal: entryCount ? 130 : null,
      notes: null,
      entries: entryCount
        ? [
            {
              id: 'x',
              title: 'Test skyr',
              kind: 'food',
              quantity: { raw: '200 g', count: null, label: null, unitSize: null, unitSizeUnit: null, total: 200, totalUnit: 'g' },
              energy: 130,
              energyUnit: 'kcal',
              nutrients: { protein: 22, carbohydrate: null, fat: 0, fibre: null, sugar: null, saturatedFat: null, salt: null, ...NO_EXTRA_NUTRIENTS },
            },
          ]
        : [],
    },
    { id: '2', title: 'Dopolední svačina', energyTotal: null, notes: null, entries: [] },
  ],
});

const parse = async (h: Promise<{ content: Array<{ text: string }> }>) => JSON.parse((await h).content[0]?.text ?? 'null');

test('the existing tools are all still registered next to the two new ones', () => {
  const tools = register({});
  for (const name of [
    'search_food',
    'get_food_portions',
    'get_food_nutrition',
    'log_food',
    'create_meal',
    'list_my_meals',
    'log_meal',
    'delete_meal',
    'get_day_summary',
    'get_day_entries',
    'get_diary_range',
    'get_nutrient_ranking',
    'update_diary_entry',
    'delete_diary_entry',
  ]) {
    assert.ok(tools.has(name), name);
  }
});

test('the read tools are marked read-only and the two diary-changing tools destructive', () => {
  const tools = register({});
  for (const name of ['get_day_entries', 'get_diary_range', 'get_nutrient_ranking']) {
    assert.equal(tools.get(name)?.config.annotations?.['readOnlyHint'], true, name);
    assert.equal(tools.get(name)?.config.annotations?.['destructiveHint'], false, name);
  }
  for (const name of ['update_diary_entry', 'delete_diary_entry']) {
    assert.equal(tools.get(name)?.config.annotations?.['readOnlyHint'], false, name);
    assert.equal(tools.get(name)?.config.annotations?.['destructiveHint'], true, name);
  }
});

test('day output carries entry ids, activities and notes, with the reading guide under its own key', async () => {
  const tools = register({ getDayEntries: async () => day('10.11.2026', 1) });
  const out = await parse(tools.get('get_day_entries')!.handler({ date: '10.11.2026' }));
  assert.equal(out.meals[0].entries[0].entry_id, 'x');
  assert.deepEqual(out.activities, [{ activity_id: 'act1', title: 'Test chůze', duration_minutes: 50, steps: 4000, energy: 216, energy_unit: 'kcal' }]);
  assert.deepEqual(out.day_notes, [{ note_id: 'n1', text: 'Test poznámka', created: '2026-11-10T10:00:00.000Z' }]);
  assert.equal(typeof out.reading_guide, 'string');
});

test('unreadable activities and notes stay null rather than turning into empty lists', async () => {
  const unknown = { ...day('10.11.2026', 0), activities: null, notes: null };
  const tools = register({ getDayEntries: async () => unknown });
  const out = await parse(tools.get('get_day_entries')!.handler({}));
  assert.equal(out.activities, null);
  assert.equal(out.day_notes, null);
});

test('get_nutrient_ranking ranks over the range and reports failed days', async () => {
  let args: unknown[] = [];
  const outcomes: DayOutcome[] = [
    { date: '09.11.2026', status: 'filled', day: day('09.11.2026', 1) },
    { date: '10.11.2026', status: 'error', error: 'boom' },
  ];
  const tools = register({
    getDiaryRange: async (...a: unknown[]) => {
      args = a;
      return outcomes;
    },
  });
  const out = await parse(tools.get('get_nutrient_ranking')!.handler({ from: '09.11.2026', to: '10.11.2026', nutrient: 'protein' }));
  assert.deepEqual(args, ['09.11.2026', '10.11.2026', 90]); // ranking may span up to 90 days
  assert.equal(out.ranking[0].title, 'Test skyr');
  assert.equal(out.ranking[0].total, 22);
  assert.equal(out.unit, 'g');
  assert.deepEqual(out.failed_dates, ['10.11.2026']);
  assert.deepEqual(out.days, { filled: 1, empty: 0, error: 1 });
});

test('update_diary_entry and delete_diary_entry pass their arguments through and report the result', async () => {
  const entry = day('10.11.2026', 1).meals[0]!.entries[0]!;
  let upd: unknown;
  let del: unknown;
  const tools = register({
    updateDiaryEntry: async (a: unknown) => {
      upd = a;
      return { date: '10.11.2026', meal: 'Snídaně', before: entry, after: { ...entry, energy: 260 } };
    },
    deleteDiaryEntry: async (a: unknown) => {
      del = a;
      return { date: '10.11.2026', meal: 'Snídaně', deleted: entry, confirmed: true };
    },
  } as unknown as Partial<KtClient>);

  const u = await parse(tools.get('update_diary_entry')!.handler({ date: '10.11.2026', entry_id: 'x', amount: 400, unit_id: 'u1' }));
  assert.deepEqual(upd, { date: '10.11.2026', entryId: 'x', amount: 400, unitId: 'u1' });
  assert.equal(u.updated, true);
  assert.equal(u.before.energy, 130);
  assert.equal(u.after.energy, 260);

  const d = await parse(tools.get('delete_diary_entry')!.handler({ date: '10.11.2026', entry_id: 'x' }));
  assert.deepEqual(del, { date: '10.11.2026', entryId: 'x' });
  assert.equal(d.deleted, true);
  assert.equal(d.confirmed_gone, true);
  assert.equal(d.entry.title, 'Test skyr');
});

test('a failed delete comes back as a tool error', async () => {
  const tools = register({
    deleteDiaryEntry: async () => {
      throw new Error('No diary entry with id x on 10.11.2026');
    },
  } as unknown as Partial<KtClient>);
  const result = await tools.get('delete_diary_entry')!.handler({ date: '10.11.2026', entry_id: 'x' });
  assert.equal(result.isError, true);
});

test('get_day_entries returns meals with entries, drops empty meals, and keeps null as null', async () => {
  let asked: string | undefined = 'unset';
  const tools = register({
    getDayEntries: async (date?: string) => {
      asked = date;
      return day('10.11.2026', 1);
    },
  });
  const out = await parse(tools.get('get_day_entries')!.handler({ date: '10.11.2026' }));
  assert.equal(asked, '10.11.2026');
  assert.equal(out.date, '10.11.2026');
  assert.equal(out.entry_count, 1);
  assert.equal(out.meals.length, 1); // the empty "Dopolední svačina" is left out
  assert.equal(out.meals[0].meal, 'Snídaně');
  const entry = out.meals[0].entries[0];
  assert.equal(entry.title, 'Test skyr');
  assert.equal(entry.quantity.raw, '200 g');
  assert.equal(entry.quantity.total, 200);
  assert.equal(entry.nutrients.protein, 22);
  assert.equal(entry.nutrients.fat, 0); // a real zero stays 0 …
  assert.equal(entry.nutrients.carbohydrate, null); // … and an unknown value stays null
  assert.ok(!('proteinTotal' in out));
});

test('get_day_entries passes an omitted date through, so the client defaults to today in Prague', async () => {
  let asked: string | undefined = 'unset';
  const tools = register({
    getDayEntries: async (date?: string) => {
      asked = date;
      return day(todayCzech(), 0);
    },
  });
  await parse(tools.get('get_day_entries')!.handler({}));
  assert.equal(asked, undefined);
});

test('get_diary_range reports filled, empty and error days separately', async () => {
  const outcomes: DayOutcome[] = [
    { date: '09.11.2026', status: 'filled', day: day('09.11.2026', 1) },
    { date: '10.11.2026', status: 'empty', day: day('10.11.2026', 0) },
    { date: '11.11.2026', status: 'error', error: 'diary 11.11.2026: response has no meal list' },
  ];
  const tools = register({ getDiaryRange: async () => outcomes });
  const out = await parse(tools.get('get_diary_range')!.handler({ from: '09.11.2026', to: '11.11.2026' }));
  assert.deepEqual(out.counts, { filled: 1, empty: 1, error: 1 });
  assert.deepEqual(
    out.days.map((d: { date: string; status: string }) => [d.date, d.status]),
    [
      ['09.11.2026', 'filled'],
      ['10.11.2026', 'empty'],
      ['11.11.2026', 'error'],
    ],
  );
  assert.equal(out.days[0].meals[0].entries[0].title, 'Test skyr');
  assert.deepEqual(out.days[1].meals, []);
  assert.match(out.days[2].error, /no meal list/);
  assert.ok(!('meals' in out.days[2]));
});

test('a login failure makes get_diary_range return a tool error, not partial data', async () => {
  const tools = register({
    getDiaryRange: async () => {
      throw new KtAuthError('login: Špatné heslo');
    },
  });
  const result = await tools.get('get_diary_range')!.handler({ from: '09.11.2026', to: '11.11.2026' });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /Špatné heslo/);
});

test('delete and update flag it when the result could not be confirmed', async () => {
  const entry = day('10.11.2026', 1).meals[0]!.entries[0]!;
  const tools = register({
    deleteDiaryEntry: async () => ({ date: '10.11.2026', meal: 'Snídaně', deleted: entry, confirmed: null }),
    updateDiaryEntry: async () => ({ date: '10.11.2026', meal: 'Snídaně', before: entry, after: null }),
  } as unknown as Partial<KtClient>);
  const d = await parse(tools.get('delete_diary_entry')!.handler({ date: '10.11.2026', entry_id: 'x' }));
  assert.equal(d.confirmed_gone, null);
  assert.match(d.note, /could not be confirmed/);
  const u = await parse(tools.get('update_diary_entry')!.handler({ date: '10.11.2026', entry_id: 'x', amount: 1 }));
  assert.equal(u.after, null);
  assert.match(u.note, /could not be re-read/);
});

test('get_nutrient_ranking returns a null grand_total when nothing was known', async () => {
  const tools = register({ getDiaryRange: async () => [] as DayOutcome[] });
  const out = await parse(tools.get('get_nutrient_ranking')!.handler({ from: '09.11.2026', to: '09.11.2026', nutrient: 'protein' }));
  assert.equal(out.grand_total, null);
  assert.deepEqual(out.ranking, []);
});

// ---------------------------------------------------------------------------
// Recipes, balance, weight, favourites, activities, notes, copying, export
// ---------------------------------------------------------------------------

const NEW_TOOLS = [
  'get_meal_details',
  'get_day_balance',
  'get_balance_range',
  'get_weight_history',
  'log_weight',
  'list_favorite_foods',
  'list_common_foods',
  'add_favorite_food',
  'remove_favorite_food',
  'search_activity',
  'log_activity',
  'delete_activity',
  'add_diary_note',
  'delete_diary_note',
  'copy_meal',
  'copy_day',
  'export_diary_csv',
];

test('every new tool is registered, with the right read-only / destructive hints', () => {
  const tools = register({});
  for (const name of NEW_TOOLS) assert.ok(tools.has(name), name);
  const readOnly = ['get_meal_details', 'get_day_balance', 'get_balance_range', 'get_weight_history', 'list_favorite_foods', 'list_common_foods', 'search_activity', 'export_diary_csv'];
  for (const name of readOnly) assert.equal(tools.get(name)?.config.annotations?.['readOnlyHint'], true, name);
  const destructive = ['log_weight', 'delete_activity', 'delete_diary_note'];
  for (const name of destructive) assert.equal(tools.get(name)?.config.annotations?.['destructiveHint'], true, name);
  // Copies and adds are writes, but not destructive — and none of them is idempotent.
  for (const name of ['copy_meal', 'copy_day', 'log_activity', 'add_diary_note']) {
    assert.equal(tools.get(name)?.config.annotations?.['readOnlyHint'], false, name);
    assert.equal(tools.get(name)?.config.annotations?.['idempotentHint'], false, name);
  }
});

test('list_favorite_foods filters by name ignoring accents and case, and hints at search_food when nothing matches', async () => {
  const tools = register({
    listFavoriteFoods: async () => [
      { id: 'f1', title: 'Kvasový chléb Authentic' },
      { id: 'f2', title: 'Bio kefír' },
    ],
  });
  const hit = await parse(tools.get('list_favorite_foods')!.handler({ query: 'KVASOVY chleb' }));
  assert.deepEqual(hit.matches, [{ food_id: 'f1', title: 'Kvasový chléb Authentic' }]);
  assert.equal(hit.total_favorites, 2);
  const none = await parse(tools.get('list_favorite_foods')!.handler({ query: 'pizza' }));
  assert.deepEqual(none.matches, []);
  assert.match(none.hint, /search_food/);
  const all = await parse(tools.get('list_favorite_foods')!.handler({}));
  assert.equal(all.matches.length, 2);
});

test('get_day_balance and get_balance_range present the balance with averages and failed days', async () => {
  const b = {
    date: '10.11.2026',
    energyUnit: 'kcal',
    intake: 2000,
    target: 2200,
    output: 2600,
    basal: 1750,
    maintenance: 2600,
    plannedDeficit: -400,
    remaining: 200,
    netBalance: -600,
    activityEnergy: 300,
    weight: 82,
    nutrients: [{ code: 'protein', title: 'Bílkoviny', unit: 'g', goal: 150, actual: 120, percent: 80 }],
  };
  const tools = register({
    getDayBalance: async () => b,
    getBalanceRange: async () =>
      [{ date: '10.11.2026', status: 'ok', balance: b }, { date: '11.11.2026', status: 'error', error: 'boom' }] as never,
  });
  const one = await parse(tools.get('get_day_balance')!.handler({ date: '10.11.2026' }));
  assert.equal(one.net_balance, -600);
  assert.equal(one.planned_deficit, -400);
  assert.equal(one.nutrients[0].goal, 150);

  const many = await parse(tools.get('get_balance_range')!.handler({ from: '10.11.2026', to: '11.11.2026' }));
  assert.deepEqual(many.days, { ok: 1, error: 1, logged: 1 });
  assert.deepEqual(many.failed_dates, ['11.11.2026']);
  assert.equal(many.averages_over_logged_days.intake, 2000);
  assert.equal(many.per_day[0].protein, 120);
  assert.equal(many.per_day[1].status, 'error');
});

test('get_meal_details totals only the ingredients with known nutrition and counts the rest', async () => {
  const nutrition = (protein: number | null) => ({ title: 'x', energy: 100, energyUnit: 'kcal', protein, carbs: 5, fat: 1, sugar: null, fibre: null, saturatedFat: null, salt: null });
  const tools = register({
    getMealDetails: async () => ({
      id: 'm1',
      title: 'Test bábovka',
      ingredients: [
        { title: 'mouka', amount: 250, unitTitle: '1 g', weight: 250, nutrition: nutrition(25), error: null },
        { title: 'vejce', amount: 2, unitTitle: 'kus', weight: 100, nutrition: nutrition(null), error: null },
        { title: 'záhada', amount: 1, unitTitle: null, weight: null, nutrition: null, error: 'nope' },
      ],
    }),
  });
  const out = await parse(tools.get('get_meal_details')!.handler({ meal_id: 'm1' }));
  assert.equal(out.totals_for_whole_recipe.protein, 25); // the null protein is not added as 0
  assert.equal(out.totals_for_whole_recipe.energy, 200);
  assert.equal(out.unknown_ingredients, 1);
  assert.equal(out.ingredients[2].error, 'nope');
  assert.equal(out.ingredients[2].protein, null);
});

test('export_diary_csv returns metadata and the CSV as two text blocks', async () => {
  const outcomes: DayOutcome[] = [
    { date: '09.11.2026', status: 'filled', day: day('09.11.2026', 1) },
    { date: '10.11.2026', status: 'error', error: 'boom' },
  ];
  let maxDays: unknown;
  const tools = register({
    getDiaryRange: async (_f: string, _t: string, m?: number) => {
      maxDays = m;
      return outcomes;
    },
  });
  const result = await tools.get('export_diary_csv')!.handler({ from: '09.11.2026', to: '10.11.2026' });
  assert.equal(maxDays, 31);
  assert.equal(result.content.length, 2);
  const meta = JSON.parse(result.content[0]?.text ?? '{}');
  assert.equal(meta.rows, 1);
  assert.deepEqual(meta.failed_dates, ['10.11.2026']);
  assert.match(result.content[1]?.text ?? '', /^date,meal,title,kind,quantity/);
  assert.match(result.content[1]?.text ?? '', /Test skyr/);
});

test('the diary-changing tools pass their arguments through and report what happened', async () => {
  const calls: Record<string, unknown> = {};
  const rec = (name: string, result: unknown) => async (a: unknown) => ((calls[name] = a), result);
  const tools = register({
    logWeight: rec('logWeight', { date: '10.11.2026', requested: 81.7, recorded: 81.7 }),
    logActivity: rec('logActivity', { date: '10.11.2026', added: { id: 'a1', title: 'Chůze', durationMinutes: 30, steps: null, energy: 91.6, energyUnit: 'kcal' } }),
    deleteActivity: rec('deleteActivity', { date: '10.11.2026', deleted: { id: 'a1', title: 'Chůze', durationMinutes: 30, steps: null, energy: 91.6, energyUnit: 'kcal' }, confirmed: true }),
    addNote: rec('addNote', { date: '10.11.2026', added: { note: { id: 'n1', text: 'Test', created: null }, meal: 'Oběd' } }),
    deleteNote: rec('deleteNote', { date: '10.11.2026', deleted: { note: { id: 'n1', text: 'Test', created: null }, meal: null }, confirmed: null }),
    copyMeal: rec('copyMeal', { fromDate: '09.11.2026', toDate: '10.11.2026', fromMeal: 'Oběd', toMeal: 'Večeře', lines: 3, added: 3 }),
    copyDay: rec('copyDay', { fromDate: '09.11.2026', toDate: '10.11.2026', copied: [{ fromMeal: 'Oběd', lines: 3, added: 3 }], failed: { meal: 'Večeře', error: 'boom' } }),
    setFavoriteFood: async (id: string, fav: boolean) => ((calls[fav ? 'fav+' : 'fav-'] = id), { confirmed: true }),
  } as unknown as Partial<KtClient>);
  const h = (n: string) => tools.get(n)!.handler;

  assert.equal((await parse(h('log_weight')({ weight_kg: 81.7, date: '10.11.2026' }))).recorded_kg, 81.7);
  assert.deepEqual(calls['logWeight'], { weightKg: 81.7, date: '10.11.2026' });

  const act = await parse(h('log_activity')({ activity_id: 'x', minutes: 30, date: '10.11.2026' }));
  assert.equal(act.activity.activity_id, 'a1');
  assert.deepEqual(calls['logActivity'], { activityId: 'x', minutes: 30, date: '10.11.2026' });

  assert.equal((await parse(h('delete_activity')({ date: '10.11.2026', activity_id: 'a1' }))).confirmed_gone, true);

  const added = await parse(h('add_diary_note')({ date: '10.11.2026', text: 'Test', meal: '3' }));
  assert.deepEqual(added.note, { note_id: 'n1', text: 'Test', meal: 'Oběd' });
  assert.deepEqual(calls['addNote'], { date: '10.11.2026', text: 'Test', meal: '3' });

  const del = await parse(h('delete_diary_note')({ date: '10.11.2026', note_id: 'n1' }));
  assert.equal(del.confirmed_gone, null);
  assert.match(del.hint, /could not be confirmed/);

  const cm = await parse(h('copy_meal')({ from_date: '09.11.2026', meal: '3', to_date: '10.11.2026', to_meal: '5' }));
  assert.equal(cm.entries_added_to_target_day, 3);
  assert.deepEqual(calls['copyMeal'], { fromDate: '09.11.2026', meal: '3', toDate: '10.11.2026', toMeal: '5' });

  const cd = await parse(h('copy_day')({ from_date: '09.11.2026', to_date: '10.11.2026' }));
  assert.equal(cd.completed, false);
  assert.equal(cd.failed.meal, 'Večeře');

  await parse(h('add_favorite_food')({ food_id: 'f9' }));
  await parse(h('remove_favorite_food')({ food_id: 'f9' }));
  assert.equal(calls['fav+'], 'f9');
  assert.equal(calls['fav-'], 'f9');
});

test('a failing new write comes back as a tool error', async () => {
  const tools = register({
    copyMeal: async () => {
      throw new Error('Nothing to copy');
    },
  } as unknown as Partial<KtClient>);
  const r = await tools.get('copy_meal')!.handler({ from_date: '09.11.2026', meal: '2', to_date: '10.11.2026' });
  assert.equal(r.isError, true);
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

test('the prompts are registered and build sensible instructions', async () => {
  const prompts = new Map<string, { config: { description?: string }; handler: (a: Record<string, string | undefined>) => { messages: Array<{ content: { text: string } }> } }>();
  registerPrompts({
    registerPrompt: (name: string, config: { description?: string }, handler: never) => {
      prompts.set(name, { config, handler });
    },
  } as unknown as McpServer);
  assert.deepEqual([...prompts.keys()].sort(), ['log_favorite', 'plateau_review', 'weekly_review']);

  const review = prompts.get('weekly_review')!.handler({ from: '03.11.2026', to: '09.11.2026' }).messages[0]!.content.text;
  assert.match(review, /03\.11\.2026–09\.11\.2026/);
  assert.match(review, /get_balance_range/);
  assert.match(review, /get_nutrient_ranking/);
  assert.match(review, /do not count them as fasting/);

  // With no dates the window is the 7 days ending today.
  const defaults = prompts.get('weekly_review')!.handler({}).messages[0]!.content.text;
  assert.match(defaults, new RegExp(todayCzech().replace(/\./g, '\\.')));

  const fav = prompts.get('log_favorite')!.handler({ food: 'kvasový chléb', amount: '2 plátky' }).messages[0]!.content.text;
  assert.match(fav, /list_favorite_foods with query "kvasový chléb"/);
  assert.match(fav, /after I confirm/);
  assert.match(fav, /2 plátky/);

  assert.throws(() => prompts.get('weekly_review')!.handler({ from: '31.02.2026' }), /does not exist/);

  const plateau = prompts.get('plateau_review')!.handler({ weeks: '6' }).messages[0]!.content.text;
  assert.match(plateau, /get_goals/);
  assert.match(plateau, /get_energy_model with weeks 6/);
  assert.match(plateau, /Change nothing yet/);
  assert.match(plateau, /below my basal metabolism or below 1200 kcal/);
  assert.match(prompts.get('plateau_review')!.handler({ weeks: '99' }).messages[0]!.content.text, /weeks 12/);
  assert.match(prompts.get('plateau_review')!.handler({}).messages[0]!.content.text, /weeks 4/);
});

const goals = (over: Record<string, unknown> = {}): Goals => ({
  sex: 'male', heightCm: 175, birthYear: 1992, weightKg: 81.9, targetWeightKg: 72, mode: 'lose', activityLevel: 1.2, considerActivity: true,
  energyUnit: 'kcal', basal: { computed: 1748, own: null }, targetEnergy: { computed: 1783, own: null }, customNutrients: true,
  nutrients: [
    { code: 'protein', title: 'Bílkoviny', recommended: 123, own: 144, percent: null, active: true },
    { code: 'carbohydrate', title: 'Sacharidy', recommended: 189, own: 163, percent: null, active: true },
    { code: 'fat', title: 'Tuky', recommended: 55.5, own: 55, percent: null, active: true },
  ],
  drinkLiters: 3.28,
  effective: { energyGoal: 1783, basal: 1748, maintenance: 2097, plannedDeficit: -315, activityEnergy: 0, energyGoalWithActivities: 1783 },
  ...over,
});

test('get_goals presents the goals in the unit of the account, with the figure in use and the warnings', async () => {
  const tools = register({ getGoals: async () => goals() });
  assert.equal(tools.get('get_goals')!.config.annotations?.['readOnlyHint'], true);
  const out = await parse(tools.get('get_goals')!.handler({}));
  assert.equal(out.goal, 'lose');
  assert.equal(out.activity_level_label, 'sedentary');
  assert.deepEqual(out.energy_goal, { site_calculation: 1783, own: null, in_use: 1783 });
  assert.deepEqual(out.basal_metabolism, { site_calculation: 1748, own: null, in_use: 1748 });
  assert.deepEqual({ ...out.in_use_today, note: undefined }, {  note: undefined, energy_goal: 1783, basal_metabolism: 1748, maintenance_intake: 2097, planned_deficit: -315, planned_deficit_percent: 15, todays_activity_energy: 0, energy_goal_including_todays_activities: 1783 });
  assert.equal(out.macro_goals_add_up_to, 1723);
  assert.equal(out.nutrient_goals[0].own_g, 144);
  assert.equal(out.warnings.length, 1);

  // An own energy goal switches the deficit model off; the site then has no maintenance figure.
  const own = register({ getGoals: async () => goals({ effective: { energyGoal: 1700, basal: 1748, maintenance: null, plannedDeficit: null, activityEnergy: 0, energyGoalWithActivities: 1700 } }) });
  const o = await parse(own.get('get_goals')!.handler({}));
  assert.equal(o.in_use_today.planned_deficit_percent, null);
  assert.equal(o.energy_goal.in_use, 1700);
  // Nothing read from today's balance: the form's own numbers are used.
  const blind = register({ getGoals: async () => goals({ effective: null }) });
  assert.equal((await parse(blind.get('get_goals')!.handler({}))).in_use_today, null);
});

test('update_goals maps its arguments, reports before and after, and flags what was not taken', async () => {
  let received: unknown;
  const tools = register({
    updateGoals: async (change: unknown) => {
      received = change;
      return { before: goals(), after: goals({ targetEnergy: { computed: 1783, own: 1700 }, effective: { energyGoal: 1700, basal: 1748, maintenance: null, plannedDeficit: null, activityEnergy: 0, energyGoalWithActivities: 1700 } }), changed: ['ownTargetEnergy'], notApplied: [], warnings: [] };
    },
  });
  assert.equal(tools.get('update_goals')!.config.annotations?.['readOnlyHint'], false);
  assert.equal(tools.get('update_goals')!.config.annotations?.['destructiveHint'], true);
  const out = await parse(
    tools.get('update_goals')!.handler({ own_target_energy: 1700, activity_level: 1.375, nutrients: [{ code: 'carbohydrate', grams: 178 }] }),
  );
  assert.deepEqual(received, {
    mode: undefined, targetWeightKg: undefined, activityLevel: 1.375, considerActivity: undefined, ownBasal: undefined, ownTargetEnergy: 1700,
    drinkLiters: undefined, nutrients: [{ code: 'carbohydrate', grams: 178, percent: undefined, active: undefined }],
  });
  assert.equal(out.updated, true);
  assert.equal(out.before.energy_goal.in_use, 1783);
  assert.equal(out.after.energy_goal.in_use, 1700);
  assert.equal(out.note, undefined);

  const unread = register({ updateGoals: async () => ({ before: goals(), after: null, changed: ['mode'], notApplied: [], warnings: [] }) });
  assert.match((await parse(unread.get('update_goals')!.handler({ mode: 'maintain' }))).note, /could not be read back/);

  const ignored = register({ updateGoals: async () => ({ before: goals(), after: goals(), changed: ['mode'], notApplied: ['mode'], warnings: [] }) });
  const r = await parse(ignored.get('update_goals')!.handler({ mode: 'maintain' }));
  assert.deepEqual(r.not_applied, ['mode']);
  assert.match(r.note, /not taken over/);
});

test('get_energy_model looks back the requested weeks from yesterday unless told otherwise', async () => {
  let range: string[] = [];
  const tools = register({
    getEnergyModel: async (from: string, to: string) => {
      range = [from, to];
      return { confidence: 'low' } as never;
    },
  });
  await parse(tools.get('get_energy_model')!.handler({ weeks: 2, to: '14.11.2026' }));
  assert.deepEqual(range, ['01.11.2026', '14.11.2026']);
  await parse(tools.get('get_energy_model')!.handler({}));
  assert.equal(range[1], shiftDate(todayCzech(), -1));
  assert.equal(range[0], shiftDate(todayCzech(), -28));
});

test('log lines never contain the MCP access token, even for a tool that takes no arguments', async () => {
  const tools = register({ getGoals: async () => goals() });
  // What the SDK passes to a tool WITHOUT an input schema: the request context, with the caller's OAuth token in it.
  const context = {
    signal: new AbortController().signal,
    authInfo: { token: 'MCP-ACCESS-TOKEN-SENTINEL', clientId: 'c', scopes: ['caltrack:log'] },
    requestInfo: { headers: { authorization: 'Bearer MCP-ACCESS-TOKEN-SENTINEL' } },
  };
  const captured: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => void captured.push(a.join(' '));
  console.error = (...a: unknown[]) => void captured.push(a.join(' '));
  try {
    await tools.get('get_goals')!.handler(context as never);
    await tools.get('get_day_entries')!.handler({ date: '10.11.2026' });
  } finally {
    console.log = log;
    console.error = err;
  }
  const all = captured.join('\n');
  assert.ok(captured.length >= 2);
  assert.ok(!/SENTINEL|authorization|authInfo|requestInfo|Bearer/i.test(all), all);
  assert.match(captured[0]!, /^\[tool\] get_goals \{\} -> ok$/);
  assert.match(all, /"date":"10\.11\.2026"/, 'real arguments are still logged');
});
