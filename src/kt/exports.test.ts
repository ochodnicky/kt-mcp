/** Tests for the CSV export and the balance averages. Synthetic data. */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseQuantity, type BalanceOutcome, type DayBalance, type DayOutcome, type DiaryEntry } from './client.js';
import { summarizeBalances } from './balance.js';
import { CSV_COLUMNS, entriesToCsv } from './export.js';

function entry(title: string, over: Partial<DiaryEntry> = {}): DiaryEntry {
  return {
    id: 'e',
    title,
    kind: 'food',
    quantity: parseQuantity('100 g'),
    energy: 100,
    energyUnit: 'kcal',
    nutrients: { protein: 10, carbohydrate: null, fat: 0, fibre: null, sugar: null, saturatedFat: null, salt: 0.5 },
    ...over,
  };
}

const day = (date: string, entries: DiaryEntry[]): DayOutcome => ({
  date,
  status: entries.length ? 'filled' : 'empty',
  day: { date, energyUnit: 'kcal', entryCount: entries.length, activities: null, notes: null, meals: [{ id: '1', title: 'Snídaně', energyTotal: null, notes: null, entries }] },
});

test('CSV has a header, one row per entry, dot decimals, and empty cells for unknown values', () => {
  const { csv, rows } = entriesToCsv([day('10.11.2026', [entry('Skyr', { energy: 130.5 })])]);
  const [header, first] = csv.trim().split('\r\n');
  assert.equal(header, CSV_COLUMNS.join(','));
  assert.equal(rows, 1);
  // date, meal, title, kind, quantity, total, unit, energy, energy_unit, protein, carbs(null), fat(0), fibre(null), sugar(null), satfat(null), salt
  assert.equal(first, '10.11.2026,Snídaně,Skyr,food,100 g,100,g,130.5,kcal,10,,0,,,,0.5');
});

test('CSV quotes commas, quotes and newlines, and defuses spreadsheet formulas', () => {
  const { csv } = entriesToCsv([day('10.11.2026', [entry('Chléb, žitný "Breadway"'), entry('=HYPERLINK("http://x")'), entry('+1'), entry('@SUM(A1)'), entry('-2')])]);
  assert.match(csv, /"Chléb, žitný ""Breadway"""/);
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  assert.match(csv, /,'\+1,/);
  assert.match(csv, /,'@SUM\(A1\),/);
  assert.match(csv, /,'-2,/);
});

test('CSV skips failed days and empty days contribute no rows', () => {
  const { rows } = entriesToCsv([day('09.11.2026', []), { date: '10.11.2026', status: 'error', error: 'boom' }, day('11.11.2026', [entry('A'), entry('B')])]);
  assert.equal(rows, 2);
});

const balance = (date: string, over: Partial<DayBalance> = {}): BalanceOutcome => ({
  date,
  status: 'ok',
  balance: {
    date,
    energyUnit: 'kcal',
    intake: 2000,
    target: 2200,
    output: 2600,
    basal: 1750,
    maintenance: 2600,
    plannedDeficit: -400,
    remaining: 200,
    netBalance: -600,
    activityEnergy: 300,
    weight: 82,
    nutrients: [{ code: 'protein', title: 'Bílkoviny', unit: 'g', goal: 150, actual: 120, percent: 80 }],
    ...over,
  },
});

test('balance averages cover logged days only; a zero-intake day is not a fast', () => {
  const s = summarizeBalances([
    balance('08.11.2026'),
    balance('09.11.2026', { intake: 0, netBalance: -2600, nutrients: [{ code: 'protein', title: 'Bílkoviny', unit: 'g', goal: 150, actual: 0, percent: 0 }] }),
    balance('10.11.2026', { intake: 2400, netBalance: -200, output: 2600, nutrients: [{ code: 'protein', title: 'Bílkoviny', unit: 'g', goal: 150, actual: 140, percent: 93 }] }),
    { date: '11.11.2026', status: 'error', error: 'boom' },
  ]);
  assert.deepEqual(s.days, { ok: 3, error: 1, logged: 2 });
  assert.deepEqual(s.failedDates, ['11.11.2026']);
  assert.equal(s.averageIntake, 2200);
  assert.equal(s.averageNetBalance, -400);
  assert.equal(s.nutrients[0]?.averageActual, 130);
  assert.equal(s.nutrients[0]?.days, 2);
});

test('balance summary is null, not zero, when nothing was logged', () => {
  const s = summarizeBalances([balance('09.11.2026', { intake: 0 })]);
  assert.equal(s.days.logged, 0);
  assert.equal(s.averageIntake, null);
  assert.equal(s.averageNetBalance, null);
  assert.equal(s.energyUnit, null);
});
