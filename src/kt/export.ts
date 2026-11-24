/**
 * CSV export of diary entries, for pasting into Excel or Google Sheets.
 *
 * Numbers use a dot as the decimal separator and unknown values are empty
 * cells (never 0). Cells that would be read as a formula by a spreadsheet are
 * prefixed with an apostrophe, since food names come from a public database.
 */

import type { DayOutcome, DiaryEntry } from './client.js';

export const CSV_COLUMNS = [
  'date',
  'meal',
  'title',
  'kind',
  'quantity',
  'quantity_total',
  'quantity_unit',
  'energy',
  'energy_unit',
  'protein_g',
  'carbohydrate_g',
  'fat_g',
  'fibre_g',
  'sugar_g',
  'saturated_fat_g',
  'salt_g',
] as const;

function cell(value: string | number | null): string {
  if (value === null) return '';
  let text = typeof value === 'number' ? String(value) : value;
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function row(date: string, meal: string, e: DiaryEntry): string {
  const n = e.nutrients;
  return [
    date,
    meal,
    e.title,
    e.kind,
    e.quantity.raw,
    e.quantity.total,
    e.quantity.totalUnit,
    e.energy,
    e.energyUnit,
    n.protein,
    n.carbohydrate,
    n.fat,
    n.fibre,
    n.sugar,
    n.saturatedFat,
    n.salt,
  ]
    .map(cell)
    .join(',');
}

/** One header row, then one row per entry. Days that failed to load contribute no rows. */
export function entriesToCsv(outcomes: DayOutcome[]): { csv: string; rows: number } {
  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const o of outcomes) {
    if (o.status === 'error') continue;
    for (const meal of o.day.meals) for (const e of meal.entries) lines.push(row(o.date, meal.title, e));
  }
  return { csv: lines.join('\r\n') + '\r\n', rows: lines.length - 1 };
}
