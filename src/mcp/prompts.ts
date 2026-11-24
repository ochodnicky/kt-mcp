/**
 * Ready-made prompts. In clients that support MCP prompts (Claude shows them
 * as slash-style shortcuts) they start a multi-step task without the user
 * having to spell out which tools to call.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertCalendarDate, todayCzech } from '../kt/client.js';

/** dd.MM.yyyy shifted by whole days, on the calendar (no time-zone effects). */
function shiftDays(date: string, days: number): string {
  const [dd, mm, yyyy] = date.split('.').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(yyyy, mm - 1, dd + days));
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}

const text = (t: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: t } }] });

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'weekly_review',
    {
      title: 'Weekly nutrition review',
      description: 'Review a stretch of days (default: the last 7 including today): energy in and out, protein against goal, top protein sources and weight trend.',
      argsSchema: {
        from: z.string().optional().describe('First day, dd.MM.yyyy. Defaults to 6 days before "to".'),
        to: z.string().optional().describe('Last day, dd.MM.yyyy. Defaults to today.'),
      },
    },
    ({ from, to }) => {
      const end = to ? assertCalendarDate(to) : todayCzech();
      const start = from ? assertCalendarDate(from) : shiftDays(end, -6);
      return text(
        `Review my eating from ${start} to ${end} using my kaloricketabulky.cz diary. Reply in the language I write in.\n\n` +
          `1. Call get_balance_range for ${start}–${end}: report average intake, energy spent and net balance, and say how many days were logged. Days with no intake are not logged — do not count them as fasting.\n` +
          `2. Compare average protein, carbohydrate and fat with their goals from the same result.\n` +
          `3. Call get_nutrient_ranking (nutrient "protein", limit 8) for the same dates and name the main protein sources. If a food has unknown_lines, say its figure is a minimum.\n` +
          `4. Call get_weight_history and describe the weight trend, if there are records in the period.\n` +
          `5. Finish with three concrete, short observations. Base everything on the numbers returned; if a call fails or a day is missing, say so instead of filling the gap.`,
      );
    },
  );

  server.registerPrompt(
    'log_favorite',
    {
      title: 'Log a favourite food',
      description: 'Log one of my favourite foods (found by name in my favourites) into the diary.',
      argsSchema: {
        food: z.string().describe('Part of the favourite food\'s name, e.g. "kvasový chléb".'),
        amount: z.string().optional().describe('How much, e.g. "2 slices" or "80 g". If omitted, ask me.'),
        meal: z.string().optional().describe('Which meal, e.g. "snídaně". If omitted, ask me.'),
        date: z.string().optional().describe('dd.MM.yyyy. Defaults to today.'),
      },
    },
    ({ food, amount, meal, date }) =>
      text(
        `Add my favourite "${food}" to my kaloricketabulky.cz diary.\n\n` +
          `1. Call list_favorite_foods with query "${food}". If there are several matches, show them and ask which one I mean. If there are none, say so and offer search_food.\n` +
          `2. Call get_food_portions for the chosen food_id, so a count like "2 slices" is logged as portions, not guessed grams.\n` +
          `3. Amount: ${amount ?? 'not given — ask me'}. Meal: ${meal ?? 'not given — ask me'}. Date: ${date ?? 'today'}.\n` +
          `4. Tell me the food, amount, meal and date you are about to log, and call log_food only after I confirm.`,
      ),
  );
}
