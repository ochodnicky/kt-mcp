/**
 * Checks the MCP-facing side of get_day_entries / get_diary_range with a fake
 * server and a fake client. Fixture data is synthetic (see kt/diary.test.ts).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KtAuthError, type DayOutcome, type DiaryDay, type KtClient, todayCzech } from '../kt/client.js';
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
  meals: [
    {
      id: '1',
      title: 'Snídaně',
      energyTotal: entryCount ? 130 : null,
      entries: entryCount
        ? [
            {
              id: 'x',
              title: 'Test skyr',
              kind: 'food',
              quantity: { raw: '200 g', count: null, label: null, unitSize: null, unitSizeUnit: null, total: 200, totalUnit: 'g' },
              energy: 130,
              energyUnit: 'kcal',
              nutrients: { protein: 22, carbohydrate: null, fat: 0, fibre: null, sugar: null, saturatedFat: null, salt: null },
            },
          ]
        : [],
    },
    { id: '2', title: 'Dopolední svačina', energyTotal: null, entries: [] },
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
  ]) {
    assert.ok(tools.has(name), name);
  }
});

test('both new tools are marked read-only', () => {
  const tools = register({});
  for (const name of ['get_day_entries', 'get_diary_range']) {
    assert.equal(tools.get(name)?.config.annotations?.['readOnlyHint'], true, name);
    assert.equal(tools.get(name)?.config.annotations?.['destructiveHint'], false, name);
  }
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
