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
  type DayBalance,
  assertCalendarDate,
  type DiaryActivity,
  type DiaryDay,
  type DiaryEntry,
  GRAM_UNIT,
  KtClient,
  MAX_EXPORT_DAYS,
  MAX_LONG_RANGE_DAYS,
  MAX_RANGE_DAYS,
  MEALS,
  type MealId,
  type Nutrition,
  todayCzech,
} from '../kt/client.js';
import { summarizeBalances } from '../kt/balance.js';
import { entriesToCsv } from '../kt/export.js';
import { shiftDate } from '../kt/util.js';
import { ACTIVITY_LEVELS, GOAL_MODES, type GoalMode, type Goals, NUTRIENT_CODES, effectiveBasal, effectiveEnergyGoal, goalWarnings, macroEnergy } from '../kt/goals.js';
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
      console.log(`[tool] ${name} ${JSON.stringify(loggableArgs(args))} -> ok`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tool] ${name} ${JSON.stringify(loggableArgs(args))} -> ${message}`);
      return failure(error);
    }
  };
}

/**
 * A tool declared WITHOUT an input schema receives the SDK's request context as
 * its first argument — including the caller's OAuth access token (authInfo) and
 * request headers. That must never reach a log line, so such an object is logged
 * as empty. Real arguments (parsed by zod) never carry these keys.
 */
export function loggableArgs(args: unknown): unknown {
  if (typeof args === 'object' && args !== null && ('signal' in args || 'authInfo' in args || 'requestInfo' in args)) return {};
  return args;
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
        'Each entry has an entry_id (for update_diary_entry / delete_diary_entry); the day\'s exercise (activities, with activity_id) and free-text notes (day_notes and per-meal notes, with note_id) come along too. ' +
        'Meals with neither entries nor notes are left out. For several days use get_diary_range.',
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
        `Both end days are included and the range may be up to ${MAX_LONG_RANGE_DAYS} days (the answer stays short however long the range). ` +
        'Foods are matched by exact name. A food whose value is unknown on every line is listed under "unknown", never counted as 0; if some lines are unknown its total is a minimum (unknown_lines > 0). ' +
        'Days that failed to load are listed in failed_dates, so the ranking may be incomplete. A login failure fails the whole call.',
      inputSchema: {
        from: z.string().describe('First day, dd.MM.yyyy.'),
        to: z.string().describe(`Last day, dd.MM.yyyy. At most ${MAX_LONG_RANGE_DAYS} days from "from", both included.`),
        nutrient: z.enum(RANKABLE_NUTRIENTS).describe('Which value to add up. "energy" is in the diary\'s energy unit (kcal), the rest in grams.'),
        limit: z.number().int().min(1).max(50).optional().describe('How many top foods to return. Defaults to 10.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('get_nutrient_ranking', async ({ from, to, nutrient, limit }) => {
      const r = rankNutrient(await kt.getDiaryRange(from, to, MAX_LONG_RANGE_DAYS), nutrient, limit ?? 10);
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

  // ---------------------------------------------------------------------
  // Recipes, balance, weight
  // ---------------------------------------------------------------------

  server.registerTool(
    'get_meal_details',
    {
      title: 'See what is inside a saved recipe',
      description:
        'List the ingredients of one of the user\'s saved recipes, each with its amount and nutrition, plus the totals for the whole recipe (not per portion). Read-only. ' +
        'A diary line logged from a recipe only shows the recipe\'s name, so use this to answer "how much protein comes from what in my bábovka". Find the recipe id with list_my_meals. ' +
        'An ingredient the site gives no figures for has null nutrition and is counted in unknown_ingredients; the totals then cover the known ones only.',
      inputSchema: { meal_id: z.string().min(1).describe('Recipe id from list_my_meals.') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('get_meal_details', async ({ meal_id }) => {
      const meal = await kt.getMealDetails(meal_id);
      const sum = (pick: (n: Nutrition) => number | null) => {
        const known = meal.ingredients.map(i => (i.nutrition ? pick(i.nutrition) : null)).filter((v): v is number => v !== null);
        return known.length === 0 ? null : Math.round(known.reduce((a, b) => a + b, 0) * 100) / 100;
      };
      return json({
        meal_id: meal.id,
        title: meal.title,
        ingredients: meal.ingredients.map(i => ({
          title: i.title,
          amount: i.amount,
          unit: i.unitTitle,
          weight: i.weight,
          energy: i.nutrition?.energy ?? null,
          protein: i.nutrition?.protein ?? null,
          carbohydrate: i.nutrition?.carbs ?? null,
          fat: i.nutrition?.fat ?? null,
          fibre: i.nutrition?.fibre ?? null,
          sugar: i.nutrition?.sugar ?? null,
          saturated_fat: i.nutrition?.saturatedFat ?? null,
          salt: i.nutrition?.salt ?? null,
          error: i.error,
        })),
        totals_for_whole_recipe: {
          energy: sum(n => n.energy),
          protein: sum(n => n.protein),
          carbohydrate: sum(n => n.carbs),
          fat: sum(n => n.fat),
          fibre: sum(n => n.fibre),
          sugar: sum(n => n.sugar),
          saturated_fat: sum(n => n.saturatedFat),
          salt: sum(n => n.salt),
        },
        unknown_ingredients: meal.ingredients.filter(i => i.nutrition === null).length,
        reading_guide: 'Energy is in kcal, the rest in grams, all for the amounts listed (the whole recipe). null = the site has no figure.',
      });
    }),
  );

  server.registerTool(
    'get_day_balance',
    {
      title: 'Get a day\'s energy balance and nutrient goals',
      description:
        'The site\'s own balance for one day: energy eaten against the goal, energy spent (basal + activity), and goal-vs-actual for protein, carbohydrate, fat, fibre, sugar, salt and more, each with its unit. Read-only. ' +
        'Use it for "am I on track today", "how much protein do I still need". net_balance is intake minus output (negative = deficit); planned_deficit is the site\'s own "Kalorický deficit", i.e. goal minus maintenance — a plan, not what the day came to. ' +
        'Intake 0 means nothing was logged.',
      inputSchema: { date: z.string().optional().describe(dateDescription) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('get_day_balance', async ({ date }) => json(presentBalance(await kt.getDayBalance(date)))),
  );

  server.registerTool(
    'get_balance_range',
    {
      title: 'Get energy balance and nutrient averages over many days',
      description:
        `Daily balance (as get_day_balance) for every day from \`from\` to \`to\`, both included, at most ${MAX_LONG_RANGE_DAYS} days, plus averages. Read-only. ` +
        'Use it for trends: "how was my deficit this month", "did I hit my protein goal on average". ' +
        'Days with no intake are treated as not logged and left out of the averages (days.logged says how many counted). Days that failed to load are listed in failed_dates. A login failure fails the whole call.',
      inputSchema: {
        from: z.string().describe('First day, dd.MM.yyyy.'),
        to: z.string().describe(`Last day, dd.MM.yyyy. At most ${MAX_LONG_RANGE_DAYS} days from "from", both included.`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('get_balance_range', async ({ from, to }) => {
      const outcomes = await kt.getBalanceRange(from, to);
      const summary = summarizeBalances(outcomes);
      return json({
        from,
        to,
        energy_unit: summary.energyUnit,
        days: summary.days,
        failed_dates: summary.failedDates,
        averages_over_logged_days: {
          intake: summary.averageIntake,
          output: summary.averageOutput,
          net_balance: summary.averageNetBalance,
          nutrients: summary.nutrients.map(n => ({
            code: n.code,
            title: n.title,
            unit: n.unit,
            average_actual: n.averageActual,
            goal: n.goal,
            days: n.days,
          })),
        },
        per_day: outcomes.map(o =>
          o.status === 'error'
            ? { date: o.date, status: 'error', error: o.error }
            : {
                date: o.date,
                intake: o.balance.intake,
                target: o.balance.target,
                output: o.balance.output,
                net_balance: o.balance.netBalance,
                weight: o.balance.weight,
                protein: o.balance.nutrients.find(n => n.code === 'protein')?.actual ?? null,
              },
        ),
      });
    }),
  );

  server.registerTool(
    'get_weight_history',
    {
      title: 'Get weight history',
      description:
        'The user\'s recorded body weights for the month around a day, with the current weight and the target weight. Read-only. Use it for "how has my weight changed" or to combine with get_balance_range.',
      inputSchema: { date: z.string().optional().describe('Day to centre on, dd.MM.yyyy. Omit for today.') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('get_weight_history', async ({ date }) => {
      const h = await kt.getWeightHistory(date);
      return json({ unit: h.unit, current: h.current, target: h.target, records: h.records });
    }),
  );

  server.registerTool(
    'log_weight',
    {
      title: 'Record a body weight',
      description:
        'Write a body weight into the user\'s diary for a day. This changes their real weight history, and the site keeps one value per date, so it replaces any weight already recorded for that date. Confirm the value first. ' +
        'Omit the date for today. Returns what the site lists for that date afterwards.',
      inputSchema: {
        weight_kg: z.number().min(20).max(500).describe('Weight in kg, e.g. 81.9.'),
        date: z.string().optional().describe(dateDescription),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard('log_weight', async ({ weight_kg, date }) => {
      const r = await kt.logWeight({ weightKg: weight_kg, date });
      return json({ logged: true, date: r.date, requested_kg: r.requested, recorded_kg: r.recorded, note: r.recorded === null ? 'The value could not be read back; check it with get_weight_history.' : undefined });
    }),
  );

  // ---------------------------------------------------------------------
  // Goals and energy model
  // ---------------------------------------------------------------------

  server.registerTool(
    'get_goals',
    {
      title: 'Get my goals and body settings',
      description:
        'The user\'s goals as set in kaloricketabulky.cz: goal (lose / maintain / gain), current and target weight, activity level (the flat allowance multiplier), basal metabolism and daily energy goal (the site\'s calculation and the user\'s own override, if any), ' +
        'and the nutrient goals (recommended vs. own, in grams or % of energy). Read-only. Call it first whenever the user asks to review or change their goals, deficit or macros. ' +
        'in_use_today holds what the diary really applies (read from the day balance and worked back to a day without activities; the site_calculation figures can be stale once an own basal is set). ' +
        'Observed on the account this was built on: maintenance intake = basal metabolism × activity level, and in lose mode the goal was that minus a 15 % planned deficit; a day\'s goal rises with its logged activities. ' +
        'Warnings point out inconsistencies, e.g. nutrient goals that do not add up to the energy goal.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('get_goals', async () => json(presentGoals(await kt.getGoals()))),
  );

  server.registerTool(
    'update_goals',
    {
      title: 'Change my goals',
      description:
        'Change goals and body settings in the user\'s real kaloricketabulky.cz account: goal mode, target weight, activity level, own basal metabolism, own daily energy goal, own nutrient goals, drinking goal. ' +
        'Only the fields you pass change; null on an own_* field or target weight clears it, so the site calculates it again. ' +
        'ALWAYS call get_goals first, explain the change and its reason, and call this only after the user agreed. Make one coherent change at a time and, after changing, tell the user the before and after. ' +
        'Energy values are in the account\'s own unit (see energy_unit in get_goals, usually kcal); the site stores kJ, so a value can come back rounded by one. ' +
        'What moves the energy goal (observed on the account this was built on): activity_level and own_basal change the maintenance intake and the goal follows, in lose mode at a 15 % deficit below maintenance. ' +
        'own_target_energy overrides all of that with a fixed number and switches the site\'s deficit model OFF (no maintenance or planned deficit is shown, and energy spent is reported as equal to the goal), so use it only when the user explicitly wants a fixed figure; null brings the model back. ' +
        'Nutrient goals: grams per nutrient, or percent of energy (whole numbers) for protein, carbohydrate and fat, which must then all three be given and sum to at most 100. ' +
        'The result reports before, after, anything the site did not take, and warnings (for example a goal below basal metabolism). It does not touch the e-mail, password, weight or any other setting.',
      inputSchema: {
        mode: z.enum(Object.keys(GOAL_MODES) as [GoalMode, ...GoalMode[]]).optional().describe('lose, maintain or gain.'),
        target_weight_kg: z.number().min(30).max(300).nullable().optional().describe('Target weight in kg. null clears it.'),
        activity_level: z
          .union(ACTIVITY_LEVELS.map(l => z.literal(l.value)) as [z.ZodLiteral<number>, z.ZodLiteral<number>, ...z.ZodLiteral<number>[]])
          .optional()
          .describe(`The flat activity multiplier on basal metabolism: ${ACTIVITY_LEVELS.map(l => `${l.value} = ${l.label}`).join('; ')}.`),
        consider_activity: z.boolean().optional().describe('Whether logged activities add to the energy spent.'),
        own_basal: z.number().positive().nullable().optional().describe('Own basal metabolism, in the account\'s energy unit. null goes back to the site\'s calculation.'),
        own_target_energy: z.number().positive().nullable().optional().describe('Own daily energy goal, in the account\'s energy unit. null goes back to the site\'s calculation.'),
        drink_liters: z.number().min(0.5).max(10).nullable().optional().describe('Daily drinking goal in litres. null clears it.'),
        nutrients: z
          .array(
            z.object({
              code: z.enum(NUTRIENT_CODES).describe('protein, carbohydrate, fat, fiber, sugar, salt, calcium, saturatedFattyAcid or phe.'),
              grams: z.number().positive().max(2000).nullable().optional().describe('Own goal in grams per day. null clears it.'),
              percent: z.number().int().min(1).max(100).nullable().optional().describe('Own goal as % of energy; only protein, carbohydrate, fat, and only all three together.'),
              active: z.boolean().optional().describe('Show this nutrient in the diary and statistics.'),
            }),
          )
          .min(1)
          .optional()
          .describe('Nutrient goals to change; nutrients not listed stay as they are.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard('update_goals', async a => {
      const r = await kt.updateGoals({
        mode: a.mode,
        targetWeightKg: a.target_weight_kg,
        activityLevel: a.activity_level,
        considerActivity: a.consider_activity,
        ownBasal: a.own_basal,
        ownTargetEnergy: a.own_target_energy,
        drinkLiters: a.drink_liters,
        nutrients: a.nutrients?.map(n => ({ code: n.code, grams: n.grams, percent: n.percent, active: n.active })),
      });
      return json({
        updated: true,
        changed: r.changed,
        not_applied: r.notApplied,
        before: presentGoals(r.before),
        after: r.after ? presentGoals(r.after) : null,
        warnings: r.warnings,
        note:
          r.after === null
            ? 'The change was sent but could not be read back; check it with get_goals.'
            : r.notApplied.length > 0
              ? 'Some fields were not taken over by the site; see not_applied.'
              : undefined,
      });
    }),
  );

  server.registerTool(
    'get_energy_model',
    {
      title: 'Estimate what my body really spends',
      description:
        'Works out the user\'s real energy expenditure from what they logged eating and how their weight moved, and sets it against what the site assumes. Read-only. ' +
        'Use it when weight is not moving as expected ("my weight is stuck", "is my deficit real?"). ' +
        'difference_from_site negative means the body spends less than the site assumes, so the real deficit is smaller than planned. ' +
        'Always read confidence and caveats to the user: the estimate needs a nearly complete diary and several weigh-ins, and days with nothing logged are skipped. Today is never counted.',
      inputSchema: {
        weeks: z.number().int().min(2).max(12).optional().describe('How many weeks to look back. Defaults to 4.'),
        to: z.string().optional().describe('Last day, dd.MM.yyyy. Defaults to yesterday.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('get_energy_model', async ({ weeks, to }) => {
      const end = to === undefined ? shiftDate(todayCzech(), -1) : assertCalendarDate(to);
      const start = shiftDate(end, -((weeks ?? 4) * 7 - 1));
      return json(await kt.getEnergyModel(start, end));
    }),
  );

  // ---------------------------------------------------------------------
  // Favourites
  // ---------------------------------------------------------------------

  const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

  server.registerTool(
    'list_favorite_foods',
    {
      title: 'List the user\'s favourite foods',
      description:
        'The foods the user marked as favourites on kaloricketabulky.cz. Read-only. ' +
        'Call this FIRST when the user says "my favourite ..." or "my usual ..." ("add my favourite sourdough bread"): pass `query` to filter by name (accents and case ignored), take the food_id, then use get_food_portions and log_food as usual. ' +
        'If nothing matches, fall back to search_food.',
      inputSchema: {
        query: z.string().optional().describe('Part of the food name, e.g. "kvasový chléb". Omit to list all favourites.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('list_favorite_foods', async ({ query }) => {
      const all = await kt.listFavoriteFoods();
      const q = query ? fold(query) : '';
      const foods = q ? all.filter(f => fold(f.title).includes(q)) : all;
      return json({
        total_favorites: all.length,
        matches: foods.map(f => ({ food_id: f.id, title: f.title })),
        hint: foods.length === 0 && q ? 'No favourite matches. Try search_food with the same words.' : undefined,
      });
    }),
  );

  server.registerTool(
    'list_common_foods',
    {
      title: 'List the foods the user logs most often',
      description:
        'The foods the user logs most often, as the site ranks them. Read-only. Useful for "what do I usually eat" and as a shortcut when the user names a food they log all the time. The food_id works with get_food_portions and log_food.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('list_common_foods', async () => {
      const foods = await kt.listCommonFoods();
      return json({ foods: foods.map(f => ({ food_id: f.id, title: f.title })) });
    }),
  );

  server.registerTool(
    'add_favorite_food',
    {
      title: 'Mark a food as a favourite',
      description: 'Add a food to the user\'s favourites (food_id from search_food). Harmless and reversible with remove_favorite_food. Returns whether the list now shows it.',
      inputSchema: { food_id: z.string().min(1).describe('The food id returned by search_food.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('add_favorite_food', async ({ food_id }) => json({ favorite: true, confirmed: (await kt.setFavoriteFood(food_id, true)).confirmed })),
  );

  server.registerTool(
    'remove_favorite_food',
    {
      title: 'Remove a food from the favourites',
      description: 'Remove a food from the user\'s favourites (food_id from list_favorite_foods). The food itself and any diary entries are untouched. Returns whether the list no longer shows it.',
      inputSchema: { food_id: z.string().min(1).describe('The food id returned by list_favorite_foods.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('remove_favorite_food', async ({ food_id }) => json({ favorite: false, confirmed: (await kt.setFavoriteFood(food_id, false)).confirmed })),
  );

  // ---------------------------------------------------------------------
  // Activities and notes
  // ---------------------------------------------------------------------

  server.registerTool(
    'search_activity',
    {
      title: 'Search activities',
      description: 'Find an activity (walking, cycling, ...) in the kaloricketabulky.cz catalogue by Czech name, to get the activity_id log_activity needs. Read-only.',
      inputSchema: {
        query: z.string().min(1).describe('Activity name in Czech, e.g. "chůze" or "jízda na kole".'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum results. Defaults to 10.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('search_activity', async ({ query, limit }) => {
      const hits = await kt.searchActivities(query, limit ?? 10);
      return json({ results: hits.map(h => ({ activity_id: h.id, title: h.title })), hint: hits.length === 0 ? 'No matches. Try a different Czech term.' : undefined });
    }),
  );

  server.registerTool(
    'log_activity',
    {
      title: 'Log an activity',
      description:
        'Write an exercise into the user\'s diary for a given number of minutes (activity_id from search_activity). This modifies their real diary, so confirm first. ' +
        'The site computes the energy burned. Only activities the site measures in hours (walking, cycling and similar) are supported. Omit the date for today. ' +
        'Returns the new activity line, including its activity_id for delete_activity.',
      inputSchema: {
        activity_id: z.string().min(1).describe('Activity id from search_activity.'),
        minutes: z.number().positive().max(1440).describe('Duration in minutes.'),
        date: z.string().optional().describe(dateDescription),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('log_activity', async ({ activity_id, minutes, date }) => {
      const r = await kt.logActivity({ activityId: activity_id, minutes, date });
      return json({
        logged: true,
        date: r.date,
        activity: r.added ? presentActivity(r.added) : null,
        note: r.added ? undefined : 'The activity was accepted but could not be identified afterwards; check it with get_day_entries.',
      });
    }),
  );

  server.registerTool(
    'delete_activity',
    {
      title: 'Delete a logged activity',
      description:
        'Permanently remove one activity line from a day (activity_id and date from get_day_entries). This cannot be undone, so confirm which one first. ' +
        'Activities imported from a watch or phone app may be imported again by that sync.',
      inputSchema: {
        date: z.string().describe('The day the activity is on, dd.MM.yyyy.'),
        activity_id: z.string().min(1).describe('activity_id from get_day_entries.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard('delete_activity', async ({ date, activity_id }) => {
      const r = await kt.deleteActivity({ date, activityId: activity_id });
      return json({
        deleted: true,
        date: r.date,
        activity: presentActivity(r.deleted),
        confirmed_gone: r.confirmed,
        note: r.confirmed === true ? undefined : 'The site accepted the deletion but the day could not be confirmed afterwards; check it with get_day_entries before trying again.',
      });
    }),
  );

  server.registerTool(
    'add_diary_note',
    {
      title: 'Add a note to a day',
      description:
        'Write a free-text note on a day, or on one meal of that day (e.g. "felt full", "restaurant, estimated portions"). Modifies the real diary, so confirm the text first. ' +
        'Returns the note with its note_id for delete_diary_note.',
      inputSchema: {
        date: z.string().describe('The day, dd.MM.yyyy.'),
        text: z.string().min(1).max(1000).describe('The note.'),
        meal: z.enum(MEAL_IDS).optional().describe(`Attach the note to one meal instead of the whole day. ${mealDescription}`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('add_diary_note', async ({ date, text, meal }) => {
      const r = await kt.addNote({ date, text, meal });
      return json({
        added: true,
        date: r.date,
        note: r.added ? { note_id: r.added.note.id, text: r.added.note.text, meal: r.added.meal } : null,
        hint: r.added ? undefined : 'The note was accepted but could not be identified afterwards; check it with get_day_entries.',
      });
    }),
  );

  server.registerTool(
    'delete_diary_note',
    {
      title: 'Delete a note',
      description: 'Permanently remove one note from a day (note_id and date from get_day_entries). Cannot be undone, so confirm which note first.',
      inputSchema: {
        date: z.string().describe('The day the note is on, dd.MM.yyyy.'),
        note_id: z.string().min(1).describe('note_id from get_day_entries.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard('delete_diary_note', async ({ date, note_id }) => {
      const r = await kt.deleteNote({ date, noteId: note_id });
      return json({
        deleted: true,
        date: r.date,
        note: { text: r.deleted.note.text, meal: r.deleted.meal },
        confirmed_gone: r.confirmed,
        hint: r.confirmed === true ? undefined : 'The site accepted the deletion but the day could not be confirmed afterwards; check it with get_day_entries before trying again.',
      });
    }),
  );

  // ---------------------------------------------------------------------
  // Copying and export
  // ---------------------------------------------------------------------

  server.registerTool(
    'copy_meal',
    {
      title: 'Copy a meal to another day',
      description:
        'Copy every entry of one meal (e.g. yesterday\'s lunch) onto another day, with the same quantities, optionally into a different meal slot. Use it for "log the same dinner as yesterday". ' +
        'This writes to the real diary and is NOT idempotent — running it twice duplicates the entries — so confirm first and never retry blindly. ' +
        'Returns how many entries the target day gained.',
      inputSchema: {
        from_date: z.string().describe('Day to copy from, dd.MM.yyyy.'),
        meal: z.enum(MEAL_IDS).describe(`Which meal to copy. ${mealDescription}`),
        to_date: z.string().describe('Day to copy onto, dd.MM.yyyy.'),
        to_meal: z.enum(MEAL_IDS).optional().describe('Meal slot on the target day. Omit to use the same meal.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('copy_meal', async ({ from_date, meal, to_date, to_meal }) => {
      const r = await kt.copyMeal({ fromDate: from_date, meal, toDate: to_date, toMeal: to_meal });
      return json({
        copied: true,
        from: `${r.fromDate} ${r.fromMeal}`,
        to: `${r.toDate} ${r.toMeal}`,
        lines_requested: r.lines,
        entries_added_to_target_day: r.added,
      });
    }),
  );

  server.registerTool(
    'copy_day',
    {
      title: 'Copy a whole day to another day',
      description:
        'Copy every meal of one day onto another day, meal by meal into the same slots. Activities and notes are not copied. Writes to the real diary and is NOT idempotent — running it twice duplicates everything — so confirm first. ' +
        'If a meal fails the copy stops and the result lists which meals were already copied; do not simply rerun it.',
      inputSchema: {
        from_date: z.string().describe('Day to copy from, dd.MM.yyyy.'),
        to_date: z.string().describe('Day to copy onto, dd.MM.yyyy.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard('copy_day', async ({ from_date, to_date }) => {
      const r = await kt.copyDay({ fromDate: from_date, toDate: to_date });
      return json({
        completed: r.failed === null,
        from: r.fromDate,
        to: r.toDate,
        copied_meals: r.copied.map(c => ({ meal: c.fromMeal, lines: c.lines, entries_added: c.added })),
        failed: r.failed,
      });
    }),
  );

  server.registerTool(
    'export_diary_csv',
    {
      title: 'Export diary entries as CSV',
      description:
        `Every logged entry from \`from\` to \`to\` (at most ${MAX_EXPORT_DAYS} days) as CSV text, ready to save as a .csv file or paste into Excel / Google Sheets. Read-only. ` +
        'One row per entry: date, meal, title, kind, quantity, energy and nutrients. Numbers use a dot as decimal separator and unknown values are empty cells, not 0. ' +
        'Days that failed to load are listed in the metadata and contribute no rows.',
      inputSchema: {
        from: z.string().describe('First day, dd.MM.yyyy.'),
        to: z.string().describe(`Last day, dd.MM.yyyy. At most ${MAX_EXPORT_DAYS} days from "from", both included.`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('export_diary_csv', async ({ from, to }) => {
      const outcomes = await kt.getDiaryRange(from, to, MAX_EXPORT_DAYS);
      const { csv, rows } = entriesToCsv(outcomes);
      const failed = outcomes.filter(o => o.status === 'error').map(o => o.date);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ from, to, rows, failed_dates: failed, note: 'The CSV follows in the next block, header row first.' }) },
          { type: 'text' as const, text: csv },
        ],
      };
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
    activities: day.activities?.map(presentActivity) ?? null,
    day_notes: day.notes?.map(n => ({ note_id: n.id, text: n.text, created: n.created })) ?? null,
    // Empty slots add nothing but length, which matters over a 14-day range.
    meals: day.meals
      .filter(meal => meal.entries.length > 0 || (meal.notes?.length ?? 0) > 0)
      .map(meal => ({
        meal_id: meal.id,
        meal: meal.title,
        energy_total: meal.energyTotal,
        entries: meal.entries.map(presentEntry),
        notes: meal.notes && meal.notes.length > 0 ? meal.notes.map(n => ({ note_id: n.id, text: n.text, created: n.created })) : undefined,
      })),
  };
}

function presentActivity(a: DiaryActivity) {
  return {
    activity_id: a.id,
    title: a.title,
    duration_minutes: a.durationMinutes,
    steps: a.steps,
    energy: a.energy,
    energy_unit: a.energyUnit,
  };
}

function presentBalance(b: DayBalance) {
  return {
    date: b.date,
    energy_unit: b.energyUnit,
    intake: b.intake,
    target: b.target,
    remaining: b.remaining,
    output: b.output,
    basal: b.basal,
    activity_energy: b.activityEnergy,
    maintenance_intake: b.maintenance,
    planned_deficit: b.plannedDeficit,
    net_balance: b.netBalance,
    weight: b.weight,
    nutrients: b.nutrients.map(n => ({ code: n.code, title: n.title, unit: n.unit, goal: n.goal, actual: n.actual, percent: n.percent })),
  };
}

function presentGoals(g: Goals) {
  const levelLabel = ACTIVITY_LEVELS.find(l => l.value === g.activityLevel)?.label ?? null;
  return {
    goal: g.mode,
    sex: g.sex,
    height_cm: g.heightCm,
    birth_year: g.birthYear,
    weight_kg: g.weightKg,
    target_weight_kg: g.targetWeightKg,
    activity_level: g.activityLevel,
    activity_level_label: levelLabel,
    consider_logged_activities: g.considerActivity,
    energy_unit: g.energyUnit,
    basal_metabolism: { site_calculation: g.basal.computed, own: g.basal.own, in_use: effectiveBasal(g) },
    energy_goal: { site_calculation: g.targetEnergy.computed, own: g.targetEnergy.own, in_use: effectiveEnergyGoal(g) },
    in_use_today:
      g.effective === null
        ? null
        : {
            note: 'Worked back to a day without activities. todays_activity_energy and energy_goal_including_todays_activities show the day as the diary has it.',
            energy_goal: g.effective.energyGoal,
            basal_metabolism: g.effective.basal,
            maintenance_intake: g.effective.maintenance,
            planned_deficit: g.effective.plannedDeficit,
            planned_deficit_percent:
              g.effective.maintenance && g.effective.plannedDeficit !== null ? Math.round((-g.effective.plannedDeficit / g.effective.maintenance) * 1000) / 10 : null,
            todays_activity_energy: g.effective.activityEnergy,
            energy_goal_including_todays_activities: g.effective.energyGoalWithActivities,
          },
    own_nutrient_goals_enabled: g.customNutrients,
    nutrient_goals: g.nutrients.map(n => ({
      code: n.code,
      title: n.title,
      recommended_g: n.recommended,
      own_g: n.own,
      own_percent: n.percent,
      shown: n.active,
    })),
    macro_goals_add_up_to: macroEnergy(g) === null ? null : Math.round(macroEnergy(g)!),
    drinking_goal_liters: g.drinkLiters,
    warnings: goalWarnings(g),
  };
}
