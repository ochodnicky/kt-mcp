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
  assert.deepEqual(prompts.map(p => p.name).sort(), ['log_favorite', 'weekly_review']);
  const fav = prompts.find(p => p.name === 'log_favorite');
  assert.equal(fav?.arguments?.find(a => a.name === 'food')?.required, true);
  assert.equal(fav?.arguments?.find(a => a.name === 'meal')?.required, false);

  const review = await client.getPrompt({ name: 'weekly_review', arguments: { from: '03.11.2026', to: '09.11.2026' } });
  const first = review.messages[0]?.content;
  assert.equal(first?.type, 'text');
  assert.match(first?.type === 'text' ? first.text : '', /03\.11\.2026–09\.11\.2026/);
});
