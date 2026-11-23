/**
 * The tool surface Claude sees.
 *
 * Designed around one flow: "I ate 3 eggs" → search → pick a portion unit →
 * log. Descriptions are prescriptive about *when* to call each tool, because
 * that is what drives correct tool selection.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type DiaryDay,
  type DiaryEntry,
  GRAM_UNIT,
  KtClient,
  MAX_RANGE_DAYS,
  MEALS,
  type MealId,
  todayCzech,
} from '../kt/client.js';
import { RANKABLE_NUTRIENTS, rankNutrient } from '../kt/ranking.js';

const MEAL_IDS = Object.keys(MEALS) as [MealId, ...MealId[]];

const mealDescription = `Which meal slot to file the entry under: ${Object.entries(MEALS)
  .map(([id, name]) => `${id} = ${name}`)
  .join(', ')}.`;

const dateDescription =
  'Date in dd.MM.yyyy format (Czech style). Omit for today. Use this to log something the user ate on a previous day.';

/** Tool results are text; JSON keeps them unambiguous for the model. */
function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

/**
 * Wraps a tool handler so every call lands in the container log with its
 * arguments and outcome, and every throw becomes an in-band tool error.
 * Without this, a failing tool is invisible from the server side.
 */
function guard<Args>(name: string, fn: (args: Args) => Promise<ReturnType<typeof json>>) {
  return async (args: Args) => {
    try {
      const result = await fn(args);
      console.log(`[tool] ${name} ${JSON.stringify(args)} -> ok`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tool] ${name} ${JSON.stringify(args)} -> ${message}`);
      return failure(error);
    }
  };
}

export function registerTools(server: McpServer, kt: KtClient): void {
  server.registerTool(
    'search_food',
    {
      title: 'Search foods',
      description:
        'Find foods in the kaloricketabulky.cz database by name or barcode. Call this first whenever the user mentions eating something, to get the food id the other tools need. ' +
        'The database is Czech, so prefer Czech search terms ("vejce" rather than "egg") for the best matches. ' +
        'A 13-digit EAN barcode also works and resolves to the exact product.',
      inputSchema: {
        query: z.string().min(1).describe('Food name (Czech works best) or a 13-digit EAN barcode.'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum results to return. Defaults to 10.'),
      },
    },
    guard('search_food', async ({ query, limit }) => {
      const hits = await kt.search(query, limit ?? 10);
      if (hits.length === 0) {
        return json({ results: [], hint: 'No matches. Try a different or more general Czech term.' });
      }
      return json({ results: hits });
    }),
  );

  server.registerTool(
    'get_food_portions',
    {
      title: 'Get portion units for a food',
      description:
        'List the portion units a food supports (for example "kus (55 g)", "velký kus (60 g)") along with its default portion. ' +
        'Call this after search_food when the user gave a count rather than a weight ("3 eggs", "2 slices"), so you can log natural portions instead of guessing grams.',
      inputSchema: {
        food_id: z.string().min(1).describe('The food id returned by search_food.'),
      },
    },
    guard('get_food_portions', async ({ food_id }) => {
      const detail = await kt.getFoodDetail(food_id);
      return json({
        id: detail.id,
        title: detail.title,
        default: { amount: detail.defaultAmount, unit_id: detail.defaultUnitId },
        units: detail.units,
        grams_unit_id: GRAM_UNIT,
        note: `Use grams_unit_id (${GRAM_UNIT}) with an amount in grams when the user gave a weight.`,
      });
    }),
  );

  server.registerTool(
    'get_food_nutrition',
    {
      title: 'Get nutrition for a quantity',
      description:
        'Calculate calories and macros for a specific quantity of a food, without logging anything. ' +
        'Use this when the user asks what something contains, or to confirm a portion before logging it. The site does the scaling, so the numbers match its own diary exactly.',
      inputSchema: {
        food_id: z.string().min(1).describe('The food id returned by search_food.'),
        amount: z.number().positive().describe('How many units. With the grams unit this is a weight in grams.'),
        unit_id: z
          .string()
          .optional()
          .describe(`Unit id from get_food_portions. Omit to use grams (${GRAM_UNIT}).`),
      },
    },
    guard('get_food_nutrition', async ({ food_id, amount, unit_id }) => {
      return json(await kt.getNutrition(food_id, amount, unit_id ?? GRAM_UNIT));
    }),
  );

  server.registerTool(
    'log_food',
    {
      title: 'Log food to the diary',
      description:
        'Write an eating record into the user\'s kaloricketabulky.cz diary. This modifies their real diary, so confirm the food and portion first if there was any ambiguity in what they said. ' +
        'Returns the nutrition that was logged.',
      inputSchema: {
        food_id: z.string().min(1).describe('The food id returned by search_food.'),
        amount: z.number().positive().describe('How many units. With the grams unit this is a weight in grams.'),
        unit_id: z
          .string()
          .optional()
          .describe(`Unit id from get_food_portions. Omit to use grams (${GRAM_UNIT}).`),
        meal: z.enum(MEAL_IDS).describe(mealDescription),
        date: z.string().optional().describe(dateDescription),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('log_food', async ({ food_id, amount, unit_id, meal, date }) => {
      const unit = unit_id ?? GRAM_UNIT;
      await kt.logFood({ foodId: food_id, amount, unitId: unit, meal, date });
      // The write has landed; a failed read-back must not become a tool error,
      // or the model retries and logs the food twice.
      const nutrition = await kt.getNutrition(food_id, amount, unit).catch(() => null);
      return json({
        logged: true,
        meal: MEALS[meal],
        date: date ?? todayCzech(),
        amount,
        nutrition,
      });
    }),
  );

  server.registerTool(
    'create_meal',
    {
      title: 'Create a saved recipe',
      description:
        'Save a recipe (the site calls it a "meal") built from existing foods, so it can be logged later in one step instead of ingredient by ingredient. ' +
        'Use this when the user describes something they cook regularly — a smoothie, a bread, a standard breakfast. ' +
        'Look each ingredient up with search_food first to get its id. ' +
        'IMPORTANT: `amount` counts units, not grams. Omit `unit_id` and `amount` means grams for solids and millilitres for liquids, which is what recipes are normally written in. ' +
        'If you do pass a unit_id from get_food_portions, then 2 with "porce (250 ml)" means 500 ml, not 2 ml.',
      inputSchema: {
        title: z.string().min(1).describe('Name for the recipe, e.g. "Ranní smoothie".'),
        ingredients: z
          .array(
            z.object({
              food_id: z.string().min(1).describe('Food id from search_food.'),
              amount: z.number().positive().describe('Number of units. With no unit_id this is grams or millilitres.'),
              unit_id: z
                .string()
                .optional()
                .describe('Optional unit id from get_food_portions. Omit for grams/millilitres.'),
            }),
          )
          .min(1)
          .describe('The ingredients, each with a quantity.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('create_meal', async ({ title, ingredients }) => {
      const id = await kt.createMeal({
        title,
        ingredients: ingredients.map(i => ({ foodId: i.food_id, amount: i.amount, unitId: i.unit_id })),
      });
      // The recipe exists now; the read-back is best-effort decoration only.
      const created = (await kt.listMeals().catch(() => [])).find(m => m.id === id);
      return json({
        created: true,
        meal_id: id,
        title,
        total_energy: created && created.energy !== null ? `${created.energy} ${created.energyUnit}` : null,
        note: 'Energy is for the whole recipe. Log it with log_meal.',
      });
    }),
  );

  server.registerTool(
    'list_my_meals',
    {
      title: 'List saved recipes',
      description:
        "List the user's own saved recipes with their ids and total energy. Call this before log_meal to find the right recipe id, or when the user asks what recipes they have saved.",
      inputSchema: {},
    },
    guard('list_my_meals', async () => {
      return json({ meals: await kt.listMeals() });
    }),
  );

  server.registerTool(
    'log_meal',
    {
      title: 'Log a saved recipe to the diary',
      description:
        "Log one of the user's saved recipes into their diary as a single entry. Find the recipe id with list_my_meals first. This writes to their real diary. " +
        'The whole recipe is always logged — the site provides no way to log a fraction of one. If the user ate only part of a recipe, log the individual ingredients with log_food instead.',
      inputSchema: {
        meal_id: z.string().min(1).describe('Recipe id from list_my_meals.'),
        meal: z.enum(MEAL_IDS).describe(mealDescription),
        date: z.string().optional().describe(dateDescription),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('log_meal', async ({ meal_id, meal, date }) => {
      await kt.logMeal({ mealId: meal_id, meal, date });
      // Same as log_food: the diary entry exists, so the read-back may not fail the tool.
      const logged = (await kt.listMeals().catch(() => [])).find(m => m.id === meal_id);
      return json({
        logged: true,
        recipe: logged?.title ?? meal_id,
        energy: logged && logged.energy !== null ? `${logged.energy} ${logged.energyUnit}` : null,
        meal: MEALS[meal],
        date: date ?? todayCzech(),
      });
    }),
  );

  server.registerTool(
    'delete_meal',
    {
      title: 'Delete a saved recipe',
      description:
        'Permanently delete one of the user\'s saved recipes. This cannot be undone, so confirm which recipe they mean before calling it. ' +
        'It removes the recipe only — diary entries already logged from it are untouched.',
      inputSchema: {
        meal_id: z.string().min(1).describe('Recipe id from list_my_meals.'),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard('delete_meal', async ({ meal_id }) => {
      const before = (await kt.listMeals()).find(m => m.id === meal_id);
      if (!before) return json({ deleted: false, reason: 'No saved recipe with that id.' });
      await kt.deleteMeal(meal_id);
      return json({ deleted: true, title: before.title });
    }),
  );

  server.registerTool(
    'get_day_summary',
    {
      title: 'Get a day summary',
      description:
        'Read back totals from the diary for one day — use this when the user asks what they have eaten, how many calories they have left, or how a day went.',
      inputSchema: {
        date: z.string().optional().describe(dateDescription),
      },
    },
    guard('get_day_summary', async ({ date }) => {
      return json({ date: date ?? todayCzech(), summary: await kt.getDaySummary(date) });
    }),
  );

  server.registerTool(
    'get_day_entries',
    {
      title: 'Get the individual entries logged on a day',
      description:
        'Read every food and recipe actually logged on one day, grouped by meal, each with its name, the logged quantity and its nutrients. Read-only. ' +
        'Use this instead of get_day_summary whenever the question is about WHICH foods were eaten ("what gave me the most protein", "what did I have for dinner"); get_day_summary only has totals and goals. ' +
        'Nutrient values are for the logged quantity, not per 100 g. A null value means the site has no figure for it — it is not zero. ' +
        'Each entry has an entry_id, which update_diary_entry and delete_diary_entry need. The day\'s exercise (activities) and free-text notes (day_notes) come along too. ' +
        'Empty meals are left out. For several days use get_diary_range.',
      inputSchema: {
        date: z.string().optional().describe(dateDescription),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('get_day_entries', async ({ date }) => {
      return json({ ...presentDay(await kt.getDayEntries(date)), reading_guide: ENTRY_NOTES });
    }),
  );

  server.registerTool(
    'get_diary_range',
    {
      title: 'Get logged entries for a range of days',
      description:
        `Read the individual logged entries for every day from \`from\` to \`to\`, both included, at most ${MAX_RANGE_DAYS} days. Read-only. ` +
        'Same per-entry detail as get_day_entries; use it for week-level questions such as "which foods gave me the most protein this week". ' +
        'Each day has a status: "filled" (has food entries), "empty" (the site returned no food entries — that cannot tell "ate nothing" from "did not log" or a future date; activities and notes may still be present) or "error" (that day failed to load; the rest are still returned). ' +
        'If the login fails the whole call fails. Nutrient values are for the logged quantity; null means unknown, not zero.',
      inputSchema: {
        from: z.string().describe('First day, dd.MM.yyyy.'),
        to: z.string().describe(`Last day, dd.MM.yyyy. Must not be before "from", and at most ${MAX_RANGE_DAYS} days from it, both included.`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('get_diary_range', async ({ from, to }) => {
      const outcomes = await kt.getDiaryRange(from, to);
      const count = (s: string) => outcomes.filter(o => o.status === s).length;
      return json({
        from,
        to,
        counts: { filled: count('filled'), empty: count('empty'), error: count('error') },
        days: outcomes.map(o =>
          o.status === 'error'
            ? { date: o.date, status: o.status, error: o.error }
            : { status: o.status, ...presentDay(o.day) },
        ),
        reading_guide: ENTRY_NOTES,
      });
    }),
  );

  server.registerTool(
    'get_nutrient_ranking',
    {
      title: 'Rank foods by a nutrient over a date range',
      description:
        'Which foods supplied the most protein (or energy, carbohydrate, fat, fibre, sugar, saturated fat, salt) over a range of days, summed per food. Read-only. ' +
        'Use this for questions like "what gave me the most protein this week" — the sums are done exactly, which beats adding up get_diary_range lines yourself. ' +
        `Same range rules as get_diary_range (both end days included, at most ${MAX_RANGE_DAYS} days). ` +
        'Foods are matched by exact name. A food whose value is unknown on every line is listed under "unknown", never counted as 0; if some lines are unknown its total is a minimum (unknown_lines > 0). ' +
        'Days that failed to load are listed in failed_dates, so the ranking may be incomplete. A login failure fails the whole call.',
      inputSchema: {
        from: z.string().describe('First day, dd.MM.yyyy.'),
        to: z.string().describe(`Last day, dd.MM.yyyy. At most ${MAX_RANGE_DAYS} days from "from", both included.`),
        nutrient: z.enum(RANKABLE_NUTRIENTS).describe('Which value to add up. "energy" is in the diary\'s energy unit (kcal), the rest in grams.'),
        limit: z.number().int().min(1).max(50).optional().describe('How many top foods to return. Defaults to 10.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('get_nutrient_ranking', async ({ from, to, nutrient, limit }) => {
      const r = rankNutrient(await kt.getDiaryRange(from, to), nutrient, limit ?? 10);
      return json({
        from,
        to,
        nutrient: r.nutrient,
        unit: r.unit,
        grand_total: r.grandTotal,
        ranking: r.ranking.map(f => ({
          title: f.title,
          kind: f.kind,
          total: f.total,
          lines: f.lines,
          unknown_lines: f.unknownLines,
          days_eaten: f.days,
          quantity_total: f.quantityTotal,
          quantity_unit: f.quantityUnit,
        })),
        omitted_foods: r.omittedFoods,
        unknown: r.unknown.map(u => ({ title: u.title, kind: u.kind, lines: u.lines })),
        days: r.counts,
        failed_dates: r.failedDates,
        reading_guide:
          'total is summed over the logged quantities (not per 100 g). grand_total covers every food with a known value, including those cut by limit. ' +
          'quantity_total covers the same lines as total (lines with an unknown value are left out of both); it is null when any of those lines had no readable quantity or the units differ. grand_total is null when no value was known at all.',
      });
    }),
  );

  server.registerTool(
    'update_diary_entry',
    {
      title: 'Change the quantity of a logged entry',
      description:
        'Change how much of a food was logged in an existing diary entry. This edits the user\'s real diary, so confirm the entry and the new amount first. ' +
        'Get the entry_id (and the date it belongs to) from get_day_entries — it is NOT the food_id used by log_food. ' +
        '`amount` counts units, as in log_food: with no unit_id the entry keeps its current unit, so 20 on a gram entry means 20 g, but 2 on a "kus (55 g)" entry means 2 pieces. ' +
        'Entries logged from a saved recipe cannot be changed by the site; delete and re-log those. Returns the entry before and after.',
      inputSchema: {
        date: z.string().describe('The day the entry is on, dd.MM.yyyy.'),
        entry_id: z.string().min(1).describe('entry_id from get_day_entries.'),
        amount: z.number().positive().describe('New number of units.'),
        unit_id: z.string().optional().describe('Optional unit id from get_food_portions. Omit to keep the entry\'s current unit.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard('update_diary_entry', async ({ date, entry_id, amount, unit_id }) => {
      const change = await kt.updateDiaryEntry({ date, entryId: entry_id, amount, unitId: unit_id });
      return json({
        updated: true,
        date: change.date,
        meal: change.meal,
        before: presentEntry(change.before),
        after: change.after ? presentEntry(change.after) : null,
        note: change.after ? undefined : 'The change was accepted but the entry could not be re-read; check it with get_day_entries.',
      });
    }),
  );

  server.registerTool(
    'delete_diary_entry',
    {
      title: 'Delete a logged entry',
      description:
        'Permanently remove one entry from the user\'s diary. This cannot be undone, so confirm which entry they mean before calling it. ' +
        'Get the entry_id (and its date) from get_day_entries. Removes a single entry per call; saved recipes themselves are untouched (that is delete_meal). ' +
        'Returns what was removed and whether the day shows it gone.',
      inputSchema: {
        date: z.string().describe('The day the entry is on, dd.MM.yyyy.'),
        entry_id: z.string().min(1).describe('entry_id from get_day_entries.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard('delete_diary_entry', async ({ date, entry_id }) => {
      const result = await kt.deleteDiaryEntry({ date, entryId: entry_id });
      return json({
        deleted: true,
        date: result.date,
        meal: result.meal,
        entry: presentEntry(result.deleted),
        confirmed_gone: result.confirmed,
        note:
          result.confirmed === true
            ? undefined
            : 'The site accepted the deletion but the day could not be confirmed afterwards; check it with get_day_entries before trying again.',
      });
    }),
  );
}

const ENTRY_NOTES =
  'quantity.raw is the site\'s own text and is always correct; count/label/unit_size/total are parsed from it and are null when it could not be read (some lines have no quantity at all). ' +
  'Nutrients are grams for the logged quantity; energy is in energy_unit. Lines with kind "recipe" were logged from a saved recipe. ' +
  'Activities from different sources (e.g. a phone and a watch) can overlap, so their energy is not guaranteed to add up. activities / day_notes are null when the site gave no readable list.';

function presentEntry(e: DiaryEntry) {
  return {
    entry_id: e.id,
    title: e.title,
    kind: e.kind,
    quantity: {
      raw: e.quantity.raw,
      count: e.quantity.count,
      label: e.quantity.label,
      unit_size: e.quantity.unitSize,
      unit_size_unit: e.quantity.unitSizeUnit,
      total: e.quantity.total,
      total_unit: e.quantity.totalUnit,
    },
    energy: e.energy,
    energy_unit: e.energyUnit,
    nutrients: {
      protein: e.nutrients.protein,
      carbohydrate: e.nutrients.carbohydrate,
      fat: e.nutrients.fat,
      fibre: e.nutrients.fibre,
      sugar: e.nutrients.sugar,
      saturated_fat: e.nutrients.saturatedFat,
      salt: e.nutrients.salt,
    },
  };
}

function presentDay(day: DiaryDay) {
  return {
    date: day.date,
    entry_count: day.entryCount,
    energy_unit: day.energyUnit,
    activities: day.activities?.map(a => ({
      title: a.title,
      duration_minutes: a.durationMinutes,
      steps: a.steps,
      energy: a.energy,
      energy_unit: a.energyUnit,
    })) ?? null,
    day_notes: day.notes?.map(n => ({ text: n.text, created: n.created })) ?? null,
    // Empty slots add nothing but length, which matters over a 14-day range.
    meals: day.meals
      .filter(meal => meal.entries.length > 0)
      .map(meal => ({
        meal_id: meal.id,
        meal: meal.title,
        energy_total: meal.energyTotal,
        entries: meal.entries.map(presentEntry),
      })),
  };
}
