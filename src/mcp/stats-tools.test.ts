/**
 * The MCP-facing side of the drinking, analysis, measurement, move and recipe
 * tools, with a fake server and a fake client. Fixture data is synthetic.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DiaryDay, KtClient } from '../kt/client.js';
import { NO_EXTRA_NUTRIENTS } from '../kt/testkit.js';
import { registerTools } from './tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function register(client: Partial<KtClient>) {
  const tools = new Map<string, { config: { description?: string }; handler: Handler }>();
  const server = {
    registerTool: (name: string, config: { description?: string }, handler: Handler) => {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;
  registerTools(server, client as KtClient);
  return tools;
}

const call = async (tools: ReturnType<typeof register>, name: string, args: Record<string, unknown> = {}) => {
  const r = await tools.get(name)!.handler(args);
  return { ...r, json: r.isError ? null : JSON.parse(r.content[0]?.text ?? 'null') };
};

test('hydration is reported in litres with both averages and the day-by-day figures', async () => {
  const tools = register({
    getHydration: async () => [
      { date: '10.11.2026', litres: 2.5, goalLitres: 2.5 },
      { date: '11.11.2026', litres: 0, goalLitres: 3 },
      { date: '12.11.2026', litres: null, goalLitres: null },
    ],
  });
  const { json } = await call(tools, 'get_hydration', { from: '10.11.2026', to: '12.11.2026' });
  assert.equal(json.unit, 'l');
  assert.deepEqual(json.summary, {
    days: 3,
    days_with_drinks_logged: 1,
    average_litres_all_days: 1.25,
    average_litres_on_days_with_drinks: 2.5,
    average_goal_litres: 2.75,
    days_goal_reached: 1,
  });
  assert.equal(json.days[2].litres, null);
});

const analysis = {
  from: '09.11.2026',
  to: '15.11.2026',
  recordsMissing: false,
  energy: { average: 2051, goal: 2093, percentOfGoal: 98, unit: 'kcal' },
  nutrients: [{ title: 'Bílkoviny', averageG: 106.6, goalG: 168.8, percentOfGoal: 63, energySharePercent: 28, goalEnergySharePercent: 35, partOf: null }],
  salt: null,
  calcium: { average: 543.44, goal: 1000, percentOfGoal: 54, unit: 'mg' },
  drinking: null,
  alcohol: null,
  sourcesByFood: [{ nutrient: 'Bílkoviny', items: ['a', 'b', 'c'].map(t => ({ title: t, amount: '1 g', times: '1x' })) }],
  sourcesByCategory: [],
};

test('the analysis lists only the asked number of sources, names the meal and keeps unknown blocks null', async () => {
  let asked: unknown[] = [];
  const tools = register({
    getGoalAnalysis: async (...a: unknown[]) => ((asked = a), { analysis, tips: [{ title: 'Málo bílkovin', advice: 'Přidej vejce', explanation: null }] }),
  });
  const { json } = await call(tools, 'get_goal_analysis', { from: '09.11.2026', to: '15.11.2026', meal: '1', top_sources: 2 });
  assert.deepEqual(asked, ['09.11.2026', '15.11.2026', '1']);
  assert.equal(json.meal, 'Snídaně');
  assert.equal(json.sources_by_food[0].top.length, 2);
  assert.equal(json.salt, null);
  assert.equal(json.drinking, null);
  assert.equal(json.calcium.unit, 'mg');
  assert.equal(json.tips[0].advice, 'Přidej vejce');
  const none = await call(register({ getGoalAnalysis: async () => ({ analysis, tips: [] }) }), 'get_goal_analysis', { from: '09.11.2026', to: '15.11.2026', top_sources: 0 });
  assert.equal(none.json.sources_by_food, undefined);
  assert.equal(none.json.meal, 'all meals');
});

test('tracked measurements show the change over the period and the kinds that can be started', async () => {
  const tools = register({
    listTrackers: async () => [
      {
        id: 'a'.repeat(32),
        name: 'Obvod pasu',
        unit: 'cm',
        values: [
          { id: 'b'.repeat(32), date: '01.11.2026', value: 96 },
          { id: 'c'.repeat(32), date: '20.11.2026', value: 94.5 },
        ],
      },
      { id: 'd'.repeat(32), name: 'Tuky', unit: '%', values: [{ id: 'e'.repeat(32), date: '20.11.2026', value: 21 }] },
    ],
    listTrackTypes: async () => [{ id: 'k1', name: 'Obvod pasu', unit: 'cm' }, { id: 'k2', name: 'Svaly', unit: '%' }],
  });
  const { json } = await call(tools, 'list_tracked_measurements', { from: '01.11.2026', to: '24.11.2026' });
  assert.equal(json.trackers[0].change_in_period, -1.5);
  assert.equal(json.trackers[1].change_in_period, null, 'one value is no change');
  assert.equal(json.trackers[0].values[1].measurement_id, 'c'.repeat(32));
  assert.deepEqual(json.available_kinds, ['Obvod pasu [cm]', 'Svaly [%]']);
});

test('recording and deleting a measurement pass the arguments on and report what the site now lists', async () => {
  let added: unknown;
  let deleted: unknown;
  const tools = register({
    addTrackedValue: async (a: unknown) => ((added = a), { tracker: 'Obvod pasu', unit: 'cm', createdTracker: false, date: '10.11.2026', requested: 94.5, recorded: null }),
    deleteTrackedValue: async (id: string) => ((deleted = id), { tracker: 'Obvod pasu', date: '10.11.2026', value: 94.5, confirmed: true }),
  });
  const add = await call(tools, 'add_tracked_measurement', { measurement: 'pas', value: 94.5, date: '10.11.2026' });
  assert.deepEqual(added, { measurement: 'pas', value: 94.5, date: '10.11.2026' });
  assert.equal(add.json.listed_by_site, null);
  assert.match(add.json.note, /could not be read back/);
  const del = await call(tools, 'delete_tracked_measurement', { measurement_id: 'b'.repeat(32) });
  assert.equal(deleted, 'b'.repeat(32));
  assert.equal(del.json.confirmed, true);
});

test('moving a line reports where it landed, and an error from the client becomes a tool error', async () => {
  let moved: unknown;
  const tools = register({
    moveDiaryEntry: async (a: unknown) => ((moved = a), { entry: 'Test skyr', from: { date: '10.11.2026', meal: 'Snídaně' }, to: { date: '10.11.2026', meal: 'Oběd' }, confirmed: true }),
  });
  const { json } = await call(tools, 'move_diary_entry', { date: '10.11.2026', entry_id: 'entry000001', meal: '3' });
  assert.deepEqual(moved, { date: '10.11.2026', entryId: 'entry000001', meal: '3', toDate: undefined });
  assert.equal(json.to.meal, 'Oběd');
  const failing = register({ moveDiaryEntry: async () => { throw new Error('No diary entry with id x'); } });
  const r = await call(failing, 'move_diary_entry', { date: '10.11.2026', entry_id: 'x', meal: '3' });
  assert.equal(r.isError, true);
});

test('diary lines show cholesterol, sodium and calcium in milligrams and keep unknown figures null', async () => {
  const day: DiaryDay = {
    date: '10.11.2026',
    energyUnit: 'kcal',
    entryCount: 1,
    activities: [],
    notes: [],
    meals: [
      {
        id: '1',
        title: 'Snídaně',
        energyTotal: 100,
        notes: [],
        entries: [
          {
            id: 'e1',
            title: 'Test sýr',
            kind: 'food',
            quantity: { raw: '120 g', count: null, label: null, unitSize: null, unitSizeUnit: null, total: 120, totalUnit: 'g' },
            energy: 100,
            energyUnit: 'kcal',
            nutrients: { protein: 1, carbohydrate: 1, fat: 1, fibre: null, sugar: null, saturatedFat: null, salt: 1.9, ...NO_EXTRA_NUTRIENTS, calcium: 0.456, cholesterol: 0.1137, alcohol: 0 },
          },
        ],
      },
    ],
  };
  const { json } = await call(register({ getDayEntries: async () => day }), 'get_day_entries', { date: '10.11.2026' });
  const n = json.meals[0].entries[0].nutrients;
  assert.equal(n.calcium_mg, 456);
  assert.equal(n.cholesterol_mg, 113.7);
  assert.equal(n.sodium_mg, null, 'unknown is not 0');
  assert.equal(n.alcohol, 0);
  assert.equal(n.trans_fat, null);
});

test('recipe search lists per-100 g figures with the available tags, and a recipe is worked out per portion and per 100 g', async () => {
  const tools = register({
    searchRecipes: async () => ({
      total: 1,
      recipes: [{ id: 'a'.repeat(32), title: 'Test kuře', link: 'https://example.invalid/r', per100g: { energy: 89, energyUnit: 'kcal', protein: 13.5, carbohydrate: 3.3, fat: 2.1, fibre: 0.4 }, rating: 4.3, author: 'Test_autor' }],
    }),
    listRecipeTags: async () => [{ title: 'večeře', slug: 'vecere' }],
    getRecipe: async () => ({
      id: 'a'.repeat(32),
      title: 'Test kuře',
      link: null,
      energyUnit: 'kcal',
      total: { energy: 2000, protein: 160, carbohydrate: 100, fat: 80, fibre: null, sugar: null, saturatedFat: null, salt: 4 },
      totalWeightG: 1000,
      portions: 4,
      ingredients: [{ title: 'kuřecí prsa', amount: 'porce (150 g)', foodId: 'f1' }],
      steps: ['Krok jedna.'],
      tags: ['maso'],
      preparationMinutes: null,
      rating: 4.3,
      ratingCount: 3,
      author: 'Test_autor',
    }),
  });
  const search = await call(tools, 'search_recipes', { query: 'kuře' });
  assert.equal(search.json.recipes[0].energy_per_100g, 89);
  assert.deepEqual(search.json.available_tags, ['večeře']);
  const detail = await call(tools, 'get_recipe', { recipe_id: 'a'.repeat(32) });
  assert.equal(detail.json.total.energy, 2000);
  assert.equal(detail.json.per_portion.energy, 500);
  assert.equal(detail.json.per_100g.protein, 16);
  assert.equal(detail.json.per_portion.fibre, null, 'unknown stays null when scaled');
  assert.equal(detail.json.preparation_minutes, null);
});

test('a recipe without a portion count has no per-portion figures rather than a made-up one', async () => {
  const tools = register({
    getRecipe: async () => ({
      id: 'a'.repeat(32), title: 'Test', link: null, energyUnit: 'kcal',
      total: { energy: 300, protein: 10, carbohydrate: 10, fat: 10, fibre: 1, sugar: 1, saturatedFat: 1, salt: 1 },
      totalWeightG: 0, portions: null, ingredients: [], steps: [], tags: [], preparationMinutes: null, rating: null, ratingCount: null, author: null,
    }),
  });
  const { json } = await call(tools, 'get_recipe', { recipe_id: 'a'.repeat(32) });
  assert.equal(json.per_portion, null);
  assert.equal(json.per_100g, null, 'a zero weight gives no per-100 g figure');
});

test('a write is reported as done only when the read-back agrees', async () => {
  const tools = register({
    addTrackedValue: async () => ({ tracker: 'Obvod pasu', unit: 'cm', createdTracker: false, date: '10.11.2026', requested: 94.5, recorded: 93 }),
    moveDiaryEntry: async () => ({ entry: 'Test skyr', from: { date: '10.11.2026', meal: 'Snídaně' }, to: { date: '10.11.2026', meal: 'Snídaně' }, confirmed: false }),
  });
  assert.equal((await call(tools, 'add_tracked_measurement', { measurement: 'pas', value: 94.5 })).json.recorded, false);
  assert.equal((await call(tools, 'move_diary_entry', { date: '10.11.2026', entry_id: 'entry000001', meal: '3' })).json.moved, false);
});

test('text written by other users is flagged as data in the descriptions of the tools that return it', () => {
  const tools = register({});
  for (const name of ['search_recipes', 'get_recipe', 'get_goal_analysis']) {
    assert.match(tools.get(name)!.config.description ?? '', /not .*instructions|never as instructions/, name);
  }
  assert.match(tools.get('add_tracked_measurement')!.config.description ?? '', /REPLACES/);
});
