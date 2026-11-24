/**
 * Ready-made prompts. In clients that support MCP prompts (Claude shows them
 * as slash-style shortcuts) they start a multi-step task without the user
 * having to spell out which tools to call.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertCalendarDate, todayCzech } from '../kt/client.js';
import { shiftDate } from '../kt/util.js';

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
      const start = from ? assertCalendarDate(from) : shiftDate(end, -6);
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
    'plateau_review',
    {
      title: 'Why is my weight not moving?',
      description: 'Look at the goals, the energy balance and the weight trend of the last weeks, find the likely reason weight is stuck and propose a change to the goals (nothing is changed without my agreement).',
      argsSchema: {
        weeks: z.string().optional().describe('How many weeks to look back, 2–12. Defaults to 4.'),
      },
    },
    ({ weeks }) => {
      const w = Math.min(12, Math.max(2, Number.parseInt(weeks ?? '4', 10) || 4));
      return text(
        `My weight is not going down as expected. Find out why using my kaloricketabulky.cz data. Reply in the language I write in.\n\n` +
          `1. Call get_goals: my goal, target weight, activity level, basal metabolism, energy goal and macro goals. Mention any warnings it returns.\n` +
          `2. Call get_energy_model with weeks ${w}. Read confidence and caveats out loud. If confidence is low or many days are not logged, say that the estimate is unreliable and what would make it better (logging every day, weighing under the same conditions) instead of drawing firm conclusions.\n` +
          `3. Call get_weight_history and, if useful, get_balance_range for the same weeks: how many days were actually logged, average intake against the goal, and whether weekends or single days stand out.\n` +
          `4. Decide which is the most likely cause: the diary is incomplete, intake is above the goal, the real expenditure is lower than the site assumes (difference_from_site), the activity level is set too high, or the period is simply too short to tell.\n` +
          `5. Propose at most one or two concrete changes with numbers (for example a different activity_level, an own_basal or own_target_energy, or a macro adjustment) and explain the effect. Do not suggest an energy goal below my basal metabolism or below 1200 kcal. A large or fast change needs a doctor or dietitian, so say that instead of proposing it.\n` +
          `6. Change nothing yet. Ask me whether to apply the proposal, and call update_goals only after I agree. Afterwards show me the before and after.`,
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
