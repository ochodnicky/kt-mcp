/**
 * The MCP-facing side of the favourite/regular activity, activity edit and day
 * template tools, with a fake server and a fake client. Synthetic data only.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KtClient } from '../kt/client.js';
import type { Weekday } from '../kt/planning.js';
import { registerTools } from './tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function register(client: Partial<KtClient>) {
  const tools = new Map<string, { config: { description?: string; annotations?: Record<string, unknown> }; handler: Handler }>();
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

const activity = (minutes: number | null) => ({ id: 'act000000001', title: 'Test plavání', durationMinutes: minutes, steps: null, energy: 300, energyUnit: 'kcal' });

test('the tools that change standing data say so in their annotations: destructive where it deletes, not idempotent where it adds', () => {
  const tools = register({});
  const hint = (n: string, k: string) => tools.get(n)!.config.annotations?.[k];
  for (const n of ['list_favorite_activities', 'list_regular_activities', 'list_day_templates', 'get_day_template']) assert.equal(hint(n, 'readOnlyHint'), true, n);
  for (const n of ['delete_regular_activity', 'delete_day_template', 'update_activity']) assert.equal(hint(n, 'destructiveHint'), true, n);
  for (const n of ['add_regular_activity', 'apply_day_template', 'save_day_as_template']) {
    assert.equal(hint(n, 'readOnlyHint'), false, n);
    assert.equal(hint(n, 'idempotentHint'), false, n);
  }
  assert.match(tools.get('add_regular_activity')!.config.description ?? '', /STANDING change/);
  assert.match(tools.get('apply_day_template')!.config.description ?? '', /ADDS/);
});

test('favourite activities are listed with both energy figures and confirmed when added or removed', async () => {
  let asked: unknown[] = [];
  const tools = register({
    listFavoriteActivities: async () => [{ id: 'a'.repeat(16), title: 'Test plavání', category: 'Plavání', kcalPerKgPerMinute: 0.15, kcalPerMinute: 12.13 }],
    setFavoriteActivity: async (...a: unknown[]) => ((asked = a), { confirmed: true }),
  });
  const list = await call(tools, 'list_favorite_activities');
  assert.deepEqual(list.json.favorites[0], { activity_id: 'a'.repeat(16), title: 'Test plavání', category: 'Plavání', kcal_per_kg_per_minute: 0.15, kcal_per_minute_for_user: 12.13 });
  assert.equal((await call(tools, 'add_favorite_activity', { activity_id: 'x'.repeat(16) })).json.confirmed, true);
  assert.deepEqual(asked, ['x'.repeat(16), true]);
  await call(tools, 'remove_favorite_activity', { activity_id: 'x'.repeat(16) });
  assert.deepEqual(asked, ['x'.repeat(16), false]);
});

test('a weekly activity reports every weekday it was added to, and warns when the site lists fewer', async () => {
  const line = (weekday: Weekday) => ({ id: weekday.padEnd(32, '0'), weekday, title: 'Test', activityId: 'a', minutes: 30, energy: 300, energyUnit: 'kcal' });
  const full = register({ addRegularActivity: async () => ({ added: [line('monday'), line('friday')] }) });
  const ok = await call(full, 'add_regular_activity', { activity_id: 'a', weekdays: ['monday', 'friday'], minutes: 30 });
  assert.equal(ok.json.added.length, 2);
  assert.equal(ok.json.note, undefined);
  const dup = register({ addRegularActivity: async () => ({ added: [line('monday')] }) });
  assert.equal((await call(dup, 'add_regular_activity', { activity_id: 'a', weekdays: ['monday', 'monday'], minutes: 30 })).json.note, undefined, 'a repeated weekday is one weekday');
  const short = register({ addRegularActivity: async () => ({ added: [line('monday')] }) });
  assert.match((await call(short, 'add_regular_activity', { activity_id: 'a', weekdays: ['monday', 'friday'], minutes: 30 })).json.note, /list_regular_activities/);
});

test('an activity update is reported as done only when the read-back shows the new duration', async () => {
  const done = register({ updateActivity: async () => ({ date: '10.11.2026', before: activity(30), after: activity(45) }) });
  assert.equal((await call(done, 'update_activity', { date: '10.11.2026', activity_id: 'act000000001', minutes: 45 })).json.updated, true);
  const stale = register({ updateActivity: async () => ({ date: '10.11.2026', before: activity(30), after: activity(30) }) });
  assert.equal((await call(stale, 'update_activity', { date: '10.11.2026', activity_id: 'act000000001', minutes: 45 })).json.updated, false);
  const unread = register({ updateActivity: async () => ({ date: '10.11.2026', before: activity(30), after: null }) });
  const r = await call(unread, 'update_activity', { date: '10.11.2026', activity_id: 'act000000001', minutes: 45 });
  assert.equal(r.json.updated, false);
  assert.match(r.json.note, /could not be read back/);
});

test('applying a template is called applied only when every day gained exactly the template\'s food lines', async () => {
  const days = (a: number | null) => [{ date: '10.11.2026', entriesBefore: 1, entriesAfter: a }];
  const good = register({ applyDayTemplate: async () => ({ template: 'Test', expectedFoods: 2, days: days(3) }) });
  assert.equal((await call(good, 'apply_day_template', { template_id: 'a'.repeat(32), dates: ['10.11.2026'] })).json.applied, true);
  for (const after of [2, 4, null]) {
    const bad = register({ applyDayTemplate: async () => ({ template: 'Test', expectedFoods: 2, days: days(after) }) });
    assert.equal((await call(bad, 'apply_day_template', { template_id: 'a'.repeat(32), dates: ['10.11.2026'] })).json.applied, false, String(after));
  }
});

test('saving a template says when it cannot tell which one it created, and template contents keep meals and notes', async () => {
  const tools = register({
    saveDayAsTemplate: async () => ({ template: null, entries: 3 }),
    getDayTemplate: async () => ({ id: 'a'.repeat(32), title: 'Test', foodCount: 1, notes: ['n'], meals: [{ meal: 'Snídaně', items: [{ title: 'okurka', amount: '10 g', kind: 'food' as const }] }] }),
  });
  const saved = await call(tools, 'save_day_as_template', { date: '10.11.2026', title: 'Test' });
  assert.equal(saved.json.template, null);
  assert.match(saved.json.note, /list_day_templates/);
  const c = await call(tools, 'get_day_template', { template_id: 'a'.repeat(32) });
  assert.deepEqual(c.json.meals[0].items[0], { title: 'okurka', amount: '10 g', kind: 'food' });
  assert.deepEqual(c.json.notes, ['n']);
});

test('an error from the client reaches the caller as a tool error', async () => {
  const tools = register({ deleteDayTemplate: async () => { throw new Error('No day template with id x'); } });
  const r = await call(tools, 'delete_day_template', { template_id: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /No day template/);
});

test('an own food and an own activity are returned with their ids so they can be deleted, and say when they cannot be identified', async () => {
  const entry = { id: 'own00000001', title: 'Test řízek', kind: 'food' as const, quantity: { raw: null, count: null, label: null, unitSize: null, unitSizeUnit: null, total: null, totalUnit: null }, energy: 650, energyUnit: 'kcal', nutrients: { protein: 30, carbohydrate: null, fat: null, fibre: null, sugar: null, saturatedFat: null, salt: null, calcium: null, cholesterol: null, sodium: null, transFat: null, monounsaturatedFat: null, polyunsaturatedFat: null, alcohol: null } };
  let asked: unknown;
  const tools = register({
    logCustomFood: async (a: unknown) => ((asked = a), { date: '10.11.2026', energyUnit: 'kcal', added: entry }),
    logCustomActivity: async () => ({ date: '10.11.2026', energyUnit: 'kcal', added: null }),
  });
  const food = await call(tools, 'log_custom_food', { title: 'Test řízek', energy: 650, meal: '3', protein: 30, saturated_fat: 4 });
  assert.deepEqual(asked, { title: 'Test řízek', energy: 650, energyUnit: undefined, meal: '3', date: undefined, nutrients: { protein: 30, carbohydrate: undefined, fat: undefined, fibre: undefined, sugar: undefined, saturatedFat: 4, salt: undefined, alcohol: undefined } });
  assert.equal(food.json.entry.entry_id, 'own00000001');
  assert.equal(food.json.entry.nutrients.protein, 30);
  assert.equal(food.json.entry.nutrients.fat, null, 'an unknown nutrient stays null');
  const act = await call(tools, 'log_custom_activity', { title: 'Test tanec', minutes: 45, energy: 210 });
  assert.equal(act.json.activity, null);
  assert.equal(act.json.energy_unit, 'kcal');
  assert.match(act.json.note, /get_day_entries/);
});

test('a recipe edit is shown with the site\'s read-back, and unconfirmed edits come with a warning', async () => {
  const now = { title: 'Test polévka', portions: 4, steps: ['Krok'], ingredients: [{ foodId: 'f', title: 'okurka', count: 100, unit: '1 g' }] };
  const done = register({ updateMeal: async () => ({ confirmed: true, now, energy: 120, energyUnit: 'kcal' }), changeMealIngredients: async () => ({ confirmed: false, now, energy: null, energyUnit: 'kcal' }) });
  const ok = await call(done, 'update_meal', { meal_id: 'a'.repeat(32), portions: 4 });
  assert.deepEqual([ok.json.confirmed, ok.json.portions, ok.json.energy_for_whole_recipe, ok.json.note], [true, 4, 120, undefined]);
  assert.deepEqual(ok.json.ingredients[0], { food_id: 'f', title: 'okurka', count: 100, unit: '1 g' });
  const warn = await call(done, 'change_meal_ingredients', { meal_id: 'a'.repeat(32), remove: ['f'] });
  assert.equal(warn.json.confirmed, false);
  assert.match(warn.json.note, /get_meal_details/);
});

test('the tools that edit or log say what they change, and the recipe tools are destructive', () => {
  const tools = register({});
  const hint = (n: string, k: string) => tools.get(n)!.config.annotations?.[k];
  assert.equal(hint('list_common_activities', 'readOnlyHint'), true);
  for (const n of ['update_meal', 'change_meal_ingredients']) assert.equal(hint(n, 'destructiveHint'), true, n);
  for (const n of ['log_custom_food', 'log_custom_activity']) {
    assert.equal(hint(n, 'idempotentHint'), false, n);
    assert.match(tools.get(n)!.config.description ?? '', /NOT added|not added/i, n);
  }
  assert.match(tools.get('log_custom_food')!.config.description ?? '', /Prefer search_food/);
});

test('log_meal passes the amount on, and calls the energy a match only when the written line is close to the expected share', async () => {
  const entry = (energy: number) => ({ id: 'newline00001', title: 'Test bábovka', kind: 'recipe' as const, quantity: { raw: '100 g', count: null, label: null, unitSize: null, unitSizeUnit: null, total: 100, totalUnit: 'g' as const }, energy, energyUnit: 'kcal', nutrients: { protein: null, carbohydrate: null, fat: null, fibre: null, sugar: null, saturatedFat: null, salt: null, calcium: null, cholesterol: null, sodium: null, transFat: null, monounsaturatedFat: null, polyunsaturatedFat: null, alcohol: null } });
  const result = (e: number | null) => ({ date: '10.11.2026', recipe: 'Test bábovka', amount: { kind: 'portions' as const, value: 1, of: 14 }, factor: 1 / 14, added: e === null ? null : entry(e), expectedEnergy: 211.6, wholeRecipeEnergy: 2962 });
  let asked: unknown;
  const ok = register({ logMeal: async (a: unknown) => ((asked = a), result(212)) });
  const good = await call(ok, 'log_meal', { meal_id: 'a'.repeat(32), meal: '1', portions: 1 });
  assert.deepEqual(asked, { mealId: 'a'.repeat(32), meal: '1', date: undefined, portions: 1, grams: undefined, percent: undefined });
  assert.deepEqual([good.json.energy_matches, good.json.share_of_recipe_percent, good.json.entry.entry_id, good.json.note], [true, 7.1, 'newline00001', undefined]);
  const whole = register({ logMeal: async () => result(2962) });
  const bad = await call(whole, 'log_meal', { meal_id: 'a'.repeat(32), meal: '1', portions: 1 });
  assert.equal(bad.json.energy_matches, false);
  assert.match(bad.json.note, /differs from the expected share/);
  const none = register({ logMeal: async () => result(null) });
  const lost = await call(none, 'log_meal', { meal_id: 'a'.repeat(32), meal: '1', portions: 1 });
  assert.deepEqual([lost.json.energy_matches, lost.json.entry], [null, null]);
  assert.match(lost.json.note, /could not be identified/);
});
