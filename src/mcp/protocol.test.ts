/**
 * Runs the real MCP SDK server and client against each other (in memory), so
 * the tool schemas and prompts are checked by the SDK itself, not by a fake.
 * The Kaloricketabulky client is replaced by a stub; no network is involved.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KtClient } from '../kt/client.js';
import { registerPrompts } from './prompts.js';
import { registerTools } from './tools.js';

async function connect(stub: Partial<KtClient>) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, stub as KtClient);
  registerPrompts(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const EXPECTED_TOOLS = [
  'search_food', 'get_food_portions', 'get_food_nutrition', 'log_food', 'create_meal', 'list_my_meals', 'log_meal', 'delete_meal', 'get_day_summary',
  'get_day_entries', 'get_diary_range', 'get_nutrient_ranking', 'update_diary_entry', 'delete_diary_entry',
  'get_meal_details', 'get_day_balance', 'get_balance_range', 'get_weight_history', 'log_weight',
  'list_favorite_foods', 'list_common_foods', 'add_favorite_food', 'remove_favorite_food',
  'search_activity', 'log_activity', 'delete_activity', 'add_diary_note', 'delete_diary_note',
  'copy_meal', 'copy_day', 'export_diary_csv',
  'get_goals', 'update_goals', 'get_energy_model',
  'get_hydration', 'get_goal_analysis', 'list_tracked_measurements', 'add_tracked_measurement', 'delete_tracked_measurement',
  'move_diary_entry', 'search_recipes', 'get_recipe',
  'list_favorite_activities', 'add_favorite_activity', 'remove_favorite_activity', 'list_regular_activities', 'add_regular_activity', 'delete_regular_activity',
  'update_activity', 'list_day_templates', 'get_day_template', 'save_day_as_template', 'apply_day_template', 'delete_day_template',
  'list_common_activities', 'log_custom_food', 'log_custom_activity', 'update_meal', 'change_meal_ingredients',
];

test('the SDK lists every tool, old and new, each with a description and an input schema', async () => {
  const client = await connect({});
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), [...EXPECTED_TOOLS].sort());
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 40, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, 'object', t.name);
  }
  const byName = new Map(tools.map(t => [t.name, t]));
  // Dates and ids the model must supply are required; everything else is optional.
  assert.deepEqual(byName.get('get_balance_range')?.inputSchema.required?.sort(), ['from', 'to']);
  assert.deepEqual(byName.get('delete_diary_entry')?.inputSchema.required?.sort(), ['date', 'entry_id']);
  assert.deepEqual(byName.get('copy_meal')?.inputSchema.required?.sort(), ['from_date', 'meal', 'to_date']);
  assert.equal(byName.get('get_day_balance')?.inputSchema.required, undefined);
  assert.equal(byName.get('delete_diary_entry')?.annotations?.destructiveHint, true);
  assert.equal(byName.get('get_nutrient_ranking')?.annotations?.readOnlyHint, true);
  assert.deepEqual(byName.get('get_hydration')?.inputSchema.required?.sort(), ['from', 'to']);
  assert.deepEqual(byName.get('get_goal_analysis')?.inputSchema.required?.sort(), ['from', 'to']);
  assert.deepEqual(byName.get('add_tracked_measurement')?.inputSchema.required?.sort(), ['measurement', 'value']);
  assert.deepEqual(byName.get('delete_tracked_measurement')?.inputSchema.required, ['measurement_id']);
  assert.deepEqual(byName.get('move_diary_entry')?.inputSchema.required?.sort(), ['date', 'entry_id']);
  assert.deepEqual(byName.get('get_recipe')?.inputSchema.required, ['recipe_id']);
  assert.equal(byName.get('search_recipes')?.inputSchema.required, undefined);
  for (const name of ['get_hydration', 'get_goal_analysis', 'list_tracked_measurements', 'search_recipes', 'get_recipe']) {
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, name);
  }
  for (const name of ['add_tracked_measurement', 'delete_tracked_measurement', 'move_diary_entry']) {
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, false, name);
  }
  assert.equal(byName.get('delete_tracked_measurement')?.annotations?.destructiveHint, true);
  assert.deepEqual(byName.get('add_regular_activity')?.inputSchema.required?.sort(), ['activity_id', 'minutes', 'weekdays']);
  assert.deepEqual(byName.get('update_activity')?.inputSchema.required?.sort(), ['activity_id', 'date', 'minutes']);
  assert.deepEqual(byName.get('apply_day_template')?.inputSchema.required?.sort(), ['dates', 'template_id']);
  assert.deepEqual(byName.get('save_day_as_template')?.inputSchema.required?.sort(), ['date', 'title']);
  assert.deepEqual(byName.get('log_custom_food')?.inputSchema.required?.sort(), ['energy', 'meal', 'title']);
  assert.deepEqual(byName.get('log_custom_activity')?.inputSchema.required?.sort(), ['energy', 'minutes', 'title']);
  assert.deepEqual(byName.get('update_meal')?.inputSchema.required, ['meal_id']);
  assert.deepEqual(byName.get('change_meal_ingredients')?.inputSchema.required, ['meal_id']);
  assert.equal(byName.get('list_common_activities')?.annotations?.readOnlyHint, true);
  for (const name of ['list_favorite_activities', 'list_regular_activities', 'list_day_templates']) {
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, name);
  }
});

test('arguments are validated by the SDK before a handler runs', async () => {
  let called = false;
  const client = await connect({ getDiaryRange: async () => ((called = true), []) } as unknown as Partial<KtClient>);
  const bad = await client.callTool({ name: 'get_nutrient_ranking', arguments: { from: '09.11.2026', to: '10.11.2026', nutrient: 'vitamin-c' } }).catch(e => e);
  assert.ok(bad instanceof Error || (bad as { isError?: boolean }).isError, 'an unknown nutrient must be refused');
  const badMeal = await client.callTool({ name: 'add_diary_note', arguments: { date: '10.11.2026', text: 'x', meal: '9' } }).catch(e => e);
  assert.ok(badMeal instanceof Error || (badMeal as { isError?: boolean }).isError, 'an unknown meal must be refused');
  assert.equal(called, false);
});

test('update_goals refuses values the site has no option for, before the handler runs', async () => {
  let called = false;
  const client = await connect({ updateGoals: async () => ((called = true), {}) } as unknown as Partial<KtClient>);
  for (const args of [{ activity_level: 1.3 }, { mode: 'bulk' }, { nutrients: [{ code: 'vitamin-c', grams: 1 }] }, { nutrients: [] }, { own_target_energy: -5 }]) {
    const r = await client.callTool({ name: 'update_goals', arguments: args }).catch(e => e);
    assert.ok(r instanceof Error || (r as { isError?: boolean }).isError, JSON.stringify(args));
  }
  assert.equal(called, false);
});

test('a tool call travels through the protocol and back', async () => {
  const client = await connect({
    getDayBalance: async (date?: string) => ({
      date: date ?? 'today', energyUnit: 'kcal', intake: 1800, target: 2000, output: 2500, basal: 1750, maintenance: 2500,
      plannedDeficit: -500, remaining: 200, netBalance: -700, activityEnergy: 300, weight: 81.9,
      nutrients: [{ code: 'protein', title: 'Bílkoviny', unit: 'g', goal: 150, actual: 120, percent: 80 }],
    }),
  } as unknown as Partial<KtClient>);
  const result = (await client.callTool({ name: 'get_day_balance', arguments: { date: '10.11.2026' } })) as { content: Array<{ text: string }>; isError?: boolean };
  assert.notEqual(result.isError, true);
  const out = JSON.parse(result.content[0]?.text ?? 'null');
  assert.equal(out.date, '10.11.2026');
  assert.equal(out.net_balance, -700);
  assert.equal(out.nutrients[0].actual, 120);
});

test('a handler error reaches the client as a tool error, not a protocol failure', async () => {
  const client = await connect({
    deleteDiaryEntry: async () => {
      throw new Error('No diary entry with id x on 10.11.2026');
    },
  } as unknown as Partial<KtClient>);
  const result = (await client.callTool({ name: 'delete_diary_entry', arguments: { date: '10.11.2026', entry_id: 'x' } })) as { content: Array<{ text: string }>; isError?: boolean };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /No diary entry/);
});

test('the SDK lists and serves the prompts', async () => {
  const client = await connect({});
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map(p => p.name).sort(), ['log_favorite', 'plateau_review', 'weekly_review']);
  const fav = prompts.find(p => p.name === 'log_favorite');
  assert.equal(fav?.arguments?.find(a => a.name === 'food')?.required, true);
  assert.equal(fav?.arguments?.find(a => a.name === 'meal')?.required, false);

  const review = await client.getPrompt({ name: 'weekly_review', arguments: { from: '03.11.2026', to: '09.11.2026' } });
  const first = review.messages[0]?.content;
  assert.equal(first?.type, 'text');
  assert.match(first?.type === 'text' ? first.text : '', /03\.11\.2026–09\.11\.2026/);
});

test('a duration below one minute is refused by the schema before an activity or the routine is touched', async () => {
  let called = 0;
  const client = await connect({
    addRegularActivity: async () => ((called += 1), { added: [] }),
    updateActivity: async () => ((called += 1), {}),
  } as unknown as Partial<KtClient>);
  for (const [name, args] of [
    ['add_regular_activity', { activity_id: 'a', weekdays: ['monday'], minutes: 0.001 }],
    ['update_activity', { date: '10.11.2026', activity_id: 'act000000001', minutes: 0.5 }],
  ] as const) {
    const r = await client.callTool({ name, arguments: args }).catch(e => e);
    assert.ok(r instanceof Error || (r as { isError?: boolean }).isError, name);
  }
  assert.equal(called, 0);
});

test('values the schema cannot accept never reach the custom-item and recipe-edit handlers', async () => {
  let called = 0;
  const bump = async () => ((called += 1), {});
  const client = await connect({ logCustomFood: bump, logCustomActivity: bump, updateMeal: bump, changeMealIngredients: bump } as unknown as Partial<KtClient>);
  for (const [name, args] of [
    ['log_custom_food', { title: 'x', energy: -1, meal: '1' }],
    ['log_custom_food', { title: 'x', energy: 100, meal: '9' }],
    ['log_custom_food', { title: 'x', energy: 100, meal: '1', protein: -2 }],
    ['log_custom_food', { title: '', energy: 100, meal: '1' }],
    ['log_custom_food', { title: 'x', energy: 100, meal: '1', energy_unit: 'btu' }],
    ['log_custom_activity', { title: 'x', minutes: 30, energy: 10, energy_unit: 'joule' }],
    ['log_custom_activity', { title: 'x', minutes: 0.2, energy: 10 }],
    ['update_meal', { meal_id: 'a', portions: 0 }],
    ['update_meal', { meal_id: 'a', steps: Array.from({ length: 51 }, () => 'x') }],
    ['change_meal_ingredients', { meal_id: 'a', add: [{ food_id: 'f', amount: 0 }] }],
  ] as const) {
    const r = await client.callTool({ name, arguments: args }).catch(e => e);
    assert.ok(r instanceof Error || (r as { isError?: boolean }).isError, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(called, 0);
});
