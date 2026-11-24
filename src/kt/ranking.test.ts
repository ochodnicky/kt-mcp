/** Ranking tests. All data is synthetic. */

import { NO_EXTRA_NUTRIENTS } from './testkit.js';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { KtError, parseQuantity, type DayOutcome, type DiaryEntry } from './client.js';
import { rankNutrient } from './ranking.js';

function entry(title: string, over: Partial<DiaryEntry> & { protein?: number | null; raw?: string | null } = {}): DiaryEntry {
  const { protein = 10, raw = '100 g', ...rest } = over;
  return {
    id: 'entry' + title,
    title,
    kind: 'food',
    quantity: parseQuantity(raw),
    energy: 100,
    energyUnit: 'kcal',
    nutrients: { protein, carbohydrate: null, fat: 1, fibre: null, sugar: null, saturatedFat: null, salt: null, ...NO_EXTRA_NUTRIENTS },
    ...rest,
  };
}

function filled(date: string, ...entries: DiaryEntry[]): DayOutcome {
  return {
    date,
    status: 'filled',
    day: {
      date,
      energyUnit: 'kcal',
      entryCount: entries.length,
      activities: null,
      notes: null,
      meals: [{ id: '1', title: 'Snídaně', energyTotal: null, notes: null, entries }],
    },
  };
}

test('sums a food across days, orders by total and counts days and lines', () => {
  const r = rankNutrient(
    [
      filled('09.11.2026', entry('Skyr', { protein: 20.123 }), entry('Chléb', { protein: 3 })),
      filled('10.11.2026', entry('skyr ', { protein: 25 }), entry('Maso', { protein: 40 })),
    ],
    'protein',
    10,
  );
  assert.deepEqual(r.ranking.map(f => [f.title, f.total, f.lines, f.days]), [
    ['Skyr', 45.12, 2, 2], // matched case- and whitespace-insensitively, rounded to 2 places
    ['Maso', 40, 1, 1],
    ['Chléb', 3, 1, 1],
  ]);
  assert.equal(r.grandTotal, 88.12);
  assert.equal(r.unit, 'g');
});

test('unknown values are never counted as zero', () => {
  const r = rankNutrient(
    [
      filled('09.11.2026', entry('Pivo', { protein: null }), entry('Skyr', { protein: 20 })),
      filled('10.11.2026', entry('Pivo', { protein: null }), entry('Skyr', { protein: null })),
    ],
    'protein',
    10,
  );
  assert.deepEqual(r.unknown, [{ title: 'Pivo', kind: 'food', lines: 2 }]);
  assert.equal(r.ranking.length, 1);
  assert.equal(r.ranking[0]?.title, 'Skyr');
  assert.equal(r.ranking[0]?.total, 20);
  assert.equal(r.ranking[0]?.unknownLines, 1); // its total is a minimum
  assert.equal(r.grandTotal, 20);
});

test('a food and a saved recipe with the same name stay separate', () => {
  const r = rankNutrient([filled('09.11.2026', entry('Bábovka', { protein: 5 }), entry('Bábovka', { protein: 7, kind: 'recipe' }))], 'protein', 10);
  assert.deepEqual(r.ranking.map(f => [f.kind, f.total]), [['recipe', 7], ['food', 5]]);
});

test('quantity totals add up only when every line has a known quantity in one unit', () => {
  const r = rankNutrient(
    [
      filled('09.11.2026', entry('A', { raw: '100 g' }), entry('B', { raw: '3 x kus (19 g)' }), entry('C', { raw: '200 ml' }), entry('D', { raw: null })),
      filled('10.11.2026', entry('A', { raw: '50 g' }), entry('B', { raw: '1 x kus (19 g)' }), entry('C', { raw: '100 g' }), entry('D', { raw: '10 g' })),
    ],
    'protein',
    10,
  );
  const by = Object.fromEntries(r.ranking.map(f => [f.title, f]));
  assert.deepEqual([by['A']?.quantityTotal, by['A']?.quantityUnit], [150, 'g']);
  assert.deepEqual([by['B']?.quantityTotal, by['B']?.quantityUnit], [76, 'g']);
  assert.deepEqual([by['C']?.quantityTotal, by['C']?.quantityUnit], [null, null]); // ml and g mixed
  assert.deepEqual([by['D']?.quantityTotal, by['D']?.quantityUnit], [null, null]); // one line has no quantity
});

test('limit cuts the list but not the grand total, and says how many foods were cut', () => {
  const r = rankNutrient([filled('09.11.2026', entry('A', { protein: 30 }), entry('B', { protein: 20 }), entry('C', { protein: 10 }))], 'protein', 2);
  assert.deepEqual(r.ranking.map(f => f.title), ['A', 'B']);
  assert.equal(r.omittedFoods, 1);
  assert.equal(r.grandTotal, 60);
});

test('failed and empty days are counted and the failed dates listed', () => {
  const empty: DayOutcome = { date: '10.11.2026', status: 'empty', day: { date: '10.11.2026', energyUnit: 'kcal', meals: [], entryCount: 0, activities: null, notes: null } };
  const r = rankNutrient(
    [filled('09.11.2026', entry('A')), empty, { date: '11.11.2026', status: 'error', error: 'boom' }],
    'protein',
    10,
  );
  assert.deepEqual(r.counts, { filled: 1, empty: 1, error: 1 });
  assert.deepEqual(r.failedDates, ['11.11.2026']);
});

test('ranks other nutrients and energy, and refuses to add mixed energy units', () => {
  const day = filled('09.11.2026', entry('A', { energy: 300 }), entry('B', { energy: 120 }));
  const r = rankNutrient([day], 'energy', 10);
  assert.equal(r.unit, 'kcal');
  assert.equal(r.ranking[0]?.total, 300);
  assert.equal(rankNutrient([day], 'fat', 10).ranking[0]?.total, 1);
  assert.equal(rankNutrient([day], 'fibre', 10).ranking.length, 0); // all unknown
  assert.equal(rankNutrient([day], 'fibre', 10).unknown.length, 2);

  const kj = filled('10.11.2026', entry('C', { energy: 500, energyUnit: 'kJ' }));
  assert.throws(() => rankNutrient([day, kj], 'energy', 10), KtError);
});

test('grand total is null, not 0, when no value is known; quantity covers only the lines that count', () => {
  const none = rankNutrient([filled('09.11.2026', entry('Pivo', { protein: null }))], 'protein', 10);
  assert.equal(none.grandTotal, null);
  assert.equal(none.ranking.length, 0);
  assert.equal(none.unknown.length, 1);

  // The second line has no known protein, so its 500 ml must not inflate the quantity next to the total.
  const r = rankNutrient(
    [filled('09.11.2026', entry('Mléko', { protein: 4, raw: '100 ml' }), entry('Mléko', { protein: null, raw: '500 ml' }))],
    'protein',
    10,
  );
  assert.equal(r.ranking[0]?.total, 4);
  assert.equal(r.ranking[0]?.quantityTotal, 100);
  assert.equal(r.ranking[0]?.unknownLines, 1);
});
