/**
 * Tests for the diary-entry reader.
 *
 * The fixtures are SYNTHETIC: the field names, value formats and quirks match
 * what www.kaloricketabulky.cz/user/diary/{date}/get returned for a real
 * account (observed in a logged-in browser), but every title, id and number
 * here is invented. No real diary data belongs in the repository.
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, test } from 'node:test';
import {
  KtAuthError,
  KtClient,
  KtError,
  assertCalendarDate,
  enumerateDays,
  parseDiaryDay,
  parseQuantity,
  pragueDate,
} from './client.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** Midnight Europe/Prague of the given day, as the site's `date` field (winter time, UTC+1). */
const pragueMidnightWinter = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - 3_600_000;

function line(over: Record<string, unknown>) {
  return {
    id: 'fake-line-id',
    type: 'foodstuff',
    guidType: 'fake-type-guid',
    title: 'Test food',
    unit: '100 x 1 g',
    energy: '100',
    energyUnit: 'kcal',
    protein: 10,
    carbohydrate: 5,
    fat: 2,
    fiber: 1,
    sugar: 0.5,
    saturatedFattyAcid: 0.4,
    salt: 0.1,
    calcium: 0.01,
    isRecipe: false,
    guidUserMeal: null,
    guidRecipe: null,
    mealContents: null,
    ...over,
  };
}

function slot(id: string, title: string, foodstuff: unknown[], energyTotal: string | null = null) {
  return { id, title, foodstuff, notes: [], templateNotes: null, energyTotal, energyTotalUnit: null };
}

const DAY = '10.11.2026';

function filledPayload() {
  const lines = [
    line({ id: 'a', title: 'Test skyr', unit: '200 g', energy: '130', protein: 22 }),
    line({ id: 'b', title: 'Test chléb', unit: '2 x krajíc (25 g)', energy: '1 043', protein: 3.3, fiber: null }),
    line({
      id: 'c',
      title: 'Test recept',
      unit: '0,5 x porce',
      energy: '178',
      protein: 7.8,
      guidUserMeal: 'fake-meal-guid',
    }),
    line({ id: 'd', title: 'Test pivo', unit: '500 x 1 ml', energy: '200', protein: null, carbohydrate: null, fat: null }),
    line({ id: 'e', title: 'Test hotovka (233 g)', unit: null, energy: '308', protein: 25 }),
  ];
  return {
    date: pragueMidnightWinter(2026, 11, 10),
    energyUnit: 'kcal',
    times: [
      slot('1', 'Snídaně', [lines[0], lines[1]], '1 173'),
      slot('2', 'Dopolední svačina', []),
      slot('3', 'Oběd', [lines[2], lines[3], lines[4]], '686'),
    ],
    activities: [],
    notes: [],
    // The real site sent 0 here on days with entries — the reader must not use it.
    proteinTotal: 0,
    energyTotal: 0,
    foodstuffCount: 5,
  };
}

function emptyPayload() {
  return {
    date: pragueMidnightWinter(2026, 11, 10),
    energyUnit: 'kcal',
    times: ['Snídaně', 'Dopolední svačina', 'Oběd'].map((t, i) => slot(String(i + 1), t, [])),
    activities: [],
    notes: [],
    proteinTotal: 0,
    energyTotal: 0,
    foodstuffCount: 0,
  };
}

const envelope = (data: unknown) => ({ requestId: null, code: 0, message: null, data });

// ---------------------------------------------------------------------------
// parseQuantity
// ---------------------------------------------------------------------------

test('parseQuantity reads every display shape seen on the real site', () => {
  const cases: Array<[string, Partial<ReturnType<typeof parseQuantity>>]> = [
    ['200 g', { total: 200, totalUnit: 'g', count: null, label: null }],
    ['300 ml', { total: 300, totalUnit: 'ml' }],
    ['50 x 1 g', { count: 50, total: 50, totalUnit: 'g', label: null, unitSize: 1 }],
    ['55 x 1 ml', { count: 55, total: 55, totalUnit: 'ml' }],
    ['1 500 x 1 ml', { count: 1500, total: 1500, totalUnit: 'ml' }],
    ['1 500 x 1 ml', { count: 1500, total: 1500 }], // non-breaking space as thousands separator
    ['3 x kus (19 g)', { count: 3, label: 'kus', unitSize: 19, total: 57, totalUnit: 'g' }],
    ['0,5 x balení (90 g)', { count: 0.5, label: 'balení', total: 45 }],
    ['porce (50 g)', { count: 1, label: 'porce', unitSize: 50, total: 50 }],
    ['malá porce (50 g)', { count: 1, label: 'malá porce', total: 50 }],
    ['plátek (16,7 g)', { count: 1, label: 'plátek', unitSize: 16.7, total: 16.7 }],
    ['5 x sklenice (500 ml)', { count: 5, label: 'sklenice', total: 2500, totalUnit: 'ml' }],
    ['0,84 x porce', { count: 0.84, label: 'porce', total: null, unitSize: null }],
    ['porce', { count: 1, label: 'porce', total: null }],
  ];
  for (const [raw, expected] of cases) {
    const q = parseQuantity(raw);
    assert.equal(q.raw, raw);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal((q as unknown as Record<string, unknown>)[key], value, `${raw} → ${key}`);
    }
  }
});

test('parseQuantity returns nulls, not guesses, for missing or unreadable quantities', () => {
  for (const raw of [null, undefined, '', '   ']) {
    const q = parseQuantity(raw);
    assert.equal(q.total, null);
    assert.equal(q.count, null);
  }
  assert.equal(parseQuantity(null).raw, null);
  // A shape we have never seen keeps its raw text but claims nothing about it.
  const odd = parseQuantity('12 (něco) x 3 g ?');
  assert.equal(odd.raw, '12 (něco) x 3 g ?');
  assert.equal(odd.total, null);
});

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

test('assertCalendarDate rejects days the site would silently roll over', () => {
  assert.equal(assertCalendarDate('28.02.2026'), '28.02.2026');
  assert.equal(assertCalendarDate('29.02.2028'), '29.02.2028');
  assert.throws(() => assertCalendarDate('31.02.2026'), /does not exist/);
  assert.throws(() => assertCalendarDate('29.02.2027'), /does not exist/);
  assert.throws(() => assertCalendarDate('2026-11-10'), /dd\.MM\.yyyy/);
});

test('enumerateDays is inclusive and crosses month and year ends', () => {
  assert.deepEqual(enumerateDays('30.12.2026', '02.01.2027'), ['30.12.2026', '31.12.2026', '01.01.2027', '02.01.2027']);
  assert.deepEqual(enumerateDays('10.11.2026', '10.11.2026'), ['10.11.2026']);
  assert.equal(enumerateDays('01.11.2026', '14.11.2026').length, 14);
});

test('enumerateDays refuses more than 14 days and reversed ranges', () => {
  assert.throws(() => enumerateDays('01.11.2026', '15.11.2026'), /maximum is 14/);
  assert.throws(() => enumerateDays('10.11.2026', '09.11.2026'), /after/);
  assert.throws(() => enumerateDays('31.02.2026', '01.03.2026'), /does not exist/);
});

test('pragueDate follows the Czech wall clock, not UTC', () => {
  assert.equal(pragueDate(new Date('2026-11-09T23:30:00Z')), '10.11.2026'); // 00:30 in Prague
  assert.equal(pragueDate(new Date('2026-07-09T22:30:00Z')), '10.07.2026'); // 00:30 in summer time
});

// ---------------------------------------------------------------------------
// parseDiaryDay
// ---------------------------------------------------------------------------

test('parses a filled day: meals, quantities, nutrients, recipes', () => {
  const day = parseDiaryDay(filledPayload(), DAY);
  assert.equal(day.date, DAY);
  assert.equal(day.entryCount, 5);
  assert.deepEqual(
    day.meals.map(m => [m.id, m.title, m.entries.length]),
    [
      ['1', 'Snídaně', 2],
      ['2', 'Dopolední svačina', 0],
      ['3', 'Oběd', 3],
    ],
  );
  assert.equal(day.meals[0]?.energyTotal, 1173);

  const [skyr, bread] = day.meals[0]?.entries ?? [];
  assert.equal(skyr?.title, 'Test skyr');
  assert.equal(skyr?.kind, 'food');
  assert.equal(skyr?.quantity.total, 200);
  assert.equal(skyr?.nutrients.protein, 22);
  assert.equal(bread?.energy, 1043); // "1 043" with thousands separator
  assert.equal(bread?.quantity.total, 50);
  assert.equal(bread?.nutrients.fibre, null); // missing stays null

  const [recipe, beer, noUnit] = day.meals[2]?.entries ?? [];
  assert.equal(recipe?.kind, 'recipe');
  assert.equal(recipe?.quantity.count, 0.5);
  assert.equal(recipe?.quantity.total, null);
  // Missing nutrient values are null — never 0.
  assert.equal(beer?.nutrients.protein, null);
  assert.equal(beer?.nutrients.carbohydrate, null);
  assert.equal(beer?.nutrients.fat, null);
  assert.equal(beer?.energy, 200);
  // A line the site gave no quantity for keeps that fact instead of inventing one.
  assert.equal(noUnit?.quantity.raw, null);
  assert.equal(noUnit?.quantity.total, null);
  assert.equal(noUnit?.title, 'Test hotovka (233 g)');
});

test('flags a recipe by the isRecipe flag as well as the saved-meal guid', () => {
  const payload = filledPayload();
  payload.times[0]?.foodstuff.push(line({ id: 'f', title: 'Test štrůdl', isRecipe: true }));
  payload.foodstuffCount = 6;
  const day = parseDiaryDay(payload, DAY);
  assert.equal(day.meals[0]?.entries[2]?.kind, 'recipe');
});

test('parses an empty day as zero entries, with the meal slots still present', () => {
  const day = parseDiaryDay(emptyPayload(), DAY);
  assert.equal(day.entryCount, 0);
  assert.equal(day.meals.length, 3);
});

test('rejects unexpected response shapes instead of reporting an empty day', () => {
  const noTimes = { ...emptyPayload(), times: undefined };
  const badSlot = { ...emptyPayload(), times: [{ id: '1', title: 'Snídaně' }] };
  const badLine = { ...emptyPayload(), foodstuffCount: 1, times: [slot('1', 'Snídaně', [{ id: 'x', unit: '1 g' }])] };
  const noDate = { ...emptyPayload(), date: undefined };
  const countMismatch = { ...filledPayload(), foodstuffCount: 9 };
  for (const [name, bad] of Object.entries({ noTimes, badSlot, badLine, noDate, countMismatch })) {
    assert.throws(() => parseDiaryDay(bad, DAY), KtError, name);
  }
  assert.throws(() => parseDiaryDay(null, DAY), KtError);
  assert.throws(() => parseDiaryDay('<html>', DAY), KtError);
  assert.throws(() => parseDiaryDay([], DAY), KtError);
});

test('rejects an answer for a different day than the one requested', () => {
  assert.throws(() => parseDiaryDay(filledPayload(), '11.11.2026'), /answered for 10\.11\.2026/);
});

// ---------------------------------------------------------------------------
// KtClient against a stubbed fetch
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let calls: string[] = [];

type Responder = (url: URL, init: RequestInit | undefined) => Response;

function stubFetch(responder: Responder) {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.pathname);
    return responder(url, init);
  }) as typeof fetch;
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

const loginOk = () => json({ code: 0, message: null, data: null }, { 'set-cookie': 'JSESSIONID=fake; Path=/; HttpOnly' });
const toLogin = () => new Response(null, { status: 302, headers: { location: 'https://www.kaloricketabulky.cz/login' } });
const diaryDate = (url: URL) => /\/user\/diary\/(\d{2}\.\d{2}\.\d{4})\/get/.exec(url.pathname)?.[1];

/** The site's day payload for a dd.MM.yyyy date (winter-time midnight; fine for the November test days). */
function payloadFor(date: string, filled: boolean) {
  const [d, m, y] = date.split('.').map(Number) as [number, number, number];
  const base = filled ? filledPayload() : emptyPayload();
  return { ...base, date: pragueMidnightWinter(y, m, d) };
}

const client = () => new KtClient({ email: 'test@example.invalid', password: 'not-a-real-password' });

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('getDayEntries logs in once, then reads the diary endpoint', async () => {
  stubFetch(url => {
    if (url.pathname === '/login/create') return loginOk();
    const date = diaryDate(url);
    assert.ok(date, `unexpected request ${url.pathname}`);
    return json(envelope(payloadFor(date, true)));
  });
  const day = await client().getDayEntries(DAY);
  assert.equal(day.entryCount, 5);
  assert.deepEqual(calls, ['/login/create', `/user/diary/${DAY}/get`]);
});

test('getDayEntries re-logs in once when the session has expired', async () => {
  let diaryHits = 0;
  stubFetch(url => {
    if (url.pathname === '/login/create') return loginOk();
    diaryHits += 1;
    if (diaryHits === 1) return toLogin();
    return json(envelope(payloadFor(DAY, false)));
  });
  const day = await client().getDayEntries(DAY);
  assert.equal(day.entryCount, 0);
  assert.equal(calls.filter(c => c === '/login/create').length, 2);
});

test('getDayEntries throws on an unexpected body, even a well-formed envelope with no data', async () => {
  for (const body of [envelope(null), envelope({ hello: 'world' }), { code: 0, data: 'nope' }]) {
    stubFetch(url => (url.pathname === '/login/create' ? loginOk() : json(body)));
    await assert.rejects(client().getDayEntries(DAY), KtError);
  }
  stubFetch(url => (url.pathname === '/login/create' ? loginOk() : new Response('<html>oops</html>', { status: 200 })));
  await assert.rejects(client().getDayEntries(DAY), /expected JSON/);
});

test('a wrong password surfaces as KtAuthError', async () => {
  stubFetch(() => json({ code: 5, message: 'Špatné heslo', data: null }));
  await assert.rejects(client().getDayEntries(DAY), (e: unknown) => e instanceof KtAuthError && /Špatné heslo/.test(e.message));
});

test('a login that issues no session cookie is an auth failure', async () => {
  stubFetch(() => json({ code: 0, message: null, data: null }));
  await assert.rejects(client().getDayEntries(DAY), KtAuthError);
});

test('getDayEntries rejects an impossible date before any request is made', async () => {
  stubFetch(() => {
    throw new Error('no request expected');
  });
  await assert.rejects(client().getDayEntries('31.02.2026'), /does not exist/);
  assert.deepEqual(calls, []);
});

test('getDiaryRange tells filled, empty and failed days apart and keeps going after a failure', async () => {
  stubFetch(url => {
    if (url.pathname === '/login/create') return loginOk();
    switch (diaryDate(url)) {
      case '09.11.2026':
        return json(envelope(payloadFor('09.11.2026', true)));
      case '10.11.2026':
        return json(envelope(payloadFor('10.11.2026', false)));
      case '11.11.2026':
        return json(envelope({ unexpected: true })); // unrecognised format
      default:
        return json(envelope(payloadFor('12.11.2026', true)));
    }
  });
  const outcomes = await client().getDiaryRange('09.11.2026', '12.11.2026');
  assert.deepEqual(
    outcomes.map(o => [o.date, o.status]),
    [
      ['09.11.2026', 'filled'],
      ['10.11.2026', 'empty'],
      ['11.11.2026', 'error'],
      ['12.11.2026', 'filled'],
    ],
  );
  const failed = outcomes[2];
  assert.ok(failed?.status === 'error' && /no meal list/.test(failed.error));
  // Days were fetched in order, one after another, on a single login.
  assert.deepEqual(calls, [
    '/login/create',
    '/user/diary/09.11.2026/get',
    '/user/diary/10.11.2026/get',
    '/user/diary/11.11.2026/get',
    '/user/diary/12.11.2026/get',
  ]);
});

test('getDiaryRange includes both end days and handles a single day', async () => {
  stubFetch(url => (url.pathname === '/login/create' ? loginOk() : json(envelope(payloadFor(diaryDate(url) ?? DAY, false)))));
  const outcomes = await client().getDiaryRange('10.11.2026', '10.11.2026');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.status, 'empty');
});

test('getDiaryRange aborts the whole request on a login failure — one login attempt, no per-day retries', async () => {
  stubFetch(() => json({ code: 5, message: 'Špatné heslo', data: null }));
  await assert.rejects(client().getDiaryRange('09.11.2026', '15.11.2026'), KtAuthError);
  assert.deepEqual(calls, ['/login/create']);
});

test('getDiaryRange aborts when the session cannot be re-established mid-range', async () => {
  stubFetch(url => {
    if (url.pathname === '/login/create') return loginOk();
    return diaryDate(url) === '09.11.2026' ? json(envelope(payloadFor('09.11.2026', true))) : toLogin();
  });
  await assert.rejects(client().getDiaryRange('09.11.2026', '13.11.2026'), KtAuthError);
  // login, day 1, day 2 (redirected), re-login, day 2 again (redirected) — and nothing for days 3–5.
  assert.deepEqual(calls, [
    '/login/create',
    '/user/diary/09.11.2026/get',
    '/user/diary/10.11.2026/get',
    '/login/create',
    '/user/diary/10.11.2026/get',
  ]);
});

test('getDiaryRange validates the range before logging in', async () => {
  stubFetch(() => {
    throw new Error('no request expected');
  });
  await assert.rejects(client().getDiaryRange('01.11.2026', '15.11.2026'), /maximum is 14/);
  await assert.rejects(client().getDiaryRange('12.11.2026', '10.11.2026'), /after/);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Activities and notes
// ---------------------------------------------------------------------------

test('reads activities and notes, and never lets the embedded user record through', () => {
  const payload = {
    ...emptyPayload(),
    activities: [
      { id: 'act1', title: 'Test chůze', unit: '155 min', energy: '483', steps: null, activityType: 3 },
      { id: 'act2', title: 'Test kroky', unit: null, energy: '107', steps: 6092, activityType: 8 },
    ],
    notes: [
      {
        id: 'note1',
        created: Date.UTC(2026, 10, 10, 9, 0),
        text: 'Test poznámka',
        user: { email: 'test@example.invalid', password: 'fake-hash-value', sex: 'X' },
      },
    ],
  };
  const day = parseDiaryDay(payload, DAY);
  assert.deepEqual(day.activities, [
    { id: 'act1', title: 'Test chůze', durationMinutes: 155, steps: null, energy: 483, energyUnit: 'kcal' },
    { id: 'act2', title: 'Test kroky', durationMinutes: null, steps: 6092, energy: 107, energyUnit: 'kcal' },
  ]);
  assert.deepEqual(day.notes, [{ id: 'note1', text: 'Test poznámka', created: '2026-11-10T09:00:00.000Z' }]);
  assert.doesNotMatch(JSON.stringify(day), /fake-hash-value|example\.invalid|password/);
});

test('an unreadable activity or note list becomes null, not an empty list, and does not fail the day', () => {
  const day = parseDiaryDay({ ...emptyPayload(), activities: 'nope', notes: [{ id: 'n', text: 5 }] }, DAY);
  assert.equal(day.activities, null);
  assert.equal(day.notes, null);
  assert.equal(day.entryCount, 0);
  assert.equal(parseDiaryDay({ ...emptyPayload(), activities: undefined, notes: undefined }, DAY).activities, null);
});

// ---------------------------------------------------------------------------
// Calendar validation on the existing write/read tools
// ---------------------------------------------------------------------------

test('logFood, logMeal and getDaySummary refuse a day that does not exist, before any request', async () => {
  stubFetch(() => {
    throw new Error('no request expected');
  });
  await assert.rejects(client().logFood({ foodId: 'f', amount: 1, meal: '1', date: '31.02.2026' }), /does not exist/);
  await assert.rejects(client().logMeal({ mealId: 'm', meal: '1', date: '31.02.2026' }), /does not exist/);
  await assert.rejects(client().getDaySummary('31.02.2026'), /does not exist/);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Deleting and editing diary lines
// ---------------------------------------------------------------------------

const withEntryIds = (p: ReturnType<typeof filledPayload>) => {
  for (const t of p.times) for (const l of t.foodstuff as Array<{ id: string }>) l.id = 'entry' + l.id.padEnd(8, '0');
  return p;
};
const ENTRY_A = 'entrya0000000'; // "Test skyr", 200 g
const ENTRY_C = 'entryc0000000'; // saved-recipe line
const GRAM = '0000000000000001';

test('deleteDiaryEntry checks the line, deletes exactly that id, then confirms the day', async () => {
  let present = true;
  stubFetch(url => {
    if (url.pathname === '/login/create') return loginOk();
    if (diaryDate(url)) {
      const p = withEntryIds(filledPayload());
      if (!present) {
        p.times[0]!.foodstuff = p.times[0]!.foodstuff.filter(l => (l as { id: string }).id !== ENTRY_A);
        p.foodstuffCount = 4;
      }
      return json(envelope(p));
    }
    if (url.pathname === `/user/diary/foodstuff/delete/${ENTRY_A}`) {
      present = false;
      return json({ requestId: null, code: 0, message: 'OK', data: null });
    }
    throw new Error(`unexpected ${url.pathname}`);
  });
  const result = await client().deleteDiaryEntry({ date: DAY, entryId: ENTRY_A });
  assert.equal(result.deleted.title, 'Test skyr');
  assert.equal(result.meal, 'Snídaně');
  assert.equal(result.confirmed, true);
  assert.deepEqual(calls, [
    '/login/create',
    `/user/diary/${DAY}/get`,
    `/user/diary/foodstuff/delete/${ENTRY_A}`,
    `/user/diary/${DAY}/get`,
  ]);
});

test('deleteDiaryEntry refuses an id that is not on that day, and a malformed id, without deleting', async () => {
  stubFetch(url => {
    if (url.pathname === '/login/create') return loginOk();
    if (diaryDate(url)) return json(envelope(withEntryIds(filledPayload())));
    throw new Error(`unexpected ${url.pathname}`);
  });
  await assert.rejects(client().deleteDiaryEntry({ date: DAY, entryId: 'entryzzzz0000' }), /No diary entry with id/);
  assert.ok(!calls.some(c => c.includes('/delete/')));

  calls = [];
  await assert.rejects(client().deleteDiaryEntry({ date: DAY, entryId: '../../user/settings' }), /Invalid entry id/);
  await assert.rejects(client().deleteDiaryEntry({ date: '31.02.2026', entryId: ENTRY_A }), /does not exist/);
  assert.deepEqual(calls, []);
});

test('deleteDiaryEntry reports confirmed=false when the line is still listed, and null when the re-read fails', async () => {
  let reads = 0;
  stubFetch(url => {
    if (url.pathname === '/login/create') return loginOk();
    if (diaryDate(url)) {
      reads += 1;
      return json(envelope(withEntryIds(filledPayload())));
    }
    return json({ code: 0, message: 'OK', data: null });
  });
  assert.equal((await client().deleteDiaryEntry({ date: DAY, entryId: ENTRY_A })).confirmed, false);

  reads = 0;
  stubFetch(url => {
    if (url.pathname === '/login/create') return loginOk();
    if (diaryDate(url)) {
      reads += 1;
      return reads === 1 ? json(envelope(withEntryIds(filledPayload()))) : json(envelope({ broken: true }));
    }
    return json({ code: 0, message: 'OK', data: null });
  });
  assert.equal((await client().deleteDiaryEntry({ date: DAY, entryId: ENTRY_A })).confirmed, null);
});

function editStub(opts: { form?: unknown } = {}) {
  const seen: { body?: Record<string, unknown>; method?: string; url?: string } = {};
  let amount = 200;
  stubFetch((url, init) => {
    if (url.pathname === '/login/create') return loginOk();
    if (diaryDate(url)) {
      const p = withEntryIds(filledPayload());
      (p.times[0]!.foodstuff[0] as { unit: string }).unit = `${amount} g`;
      return json(envelope(p));
    }
    if (url.pathname === `/user/diary/foodstuff/unit/form/${ENTRY_A}`) {
      return json(
        envelope(
          'form' in opts
            ? opts.form
            : {
                diaryGuid: ENTRY_A,
                multiplier: amount,
                unitGuid: GRAM,
                unitOptions: [
                  { id: GRAM, title: '1 g', multiplier: 1 },
                  { id: 'unit100', title: '100 g', multiplier: 100 },
                ],
              },
        ),
      );
    }
    if (url.pathname === '/user/diary/foodstuff/unit/edit') {
      seen.body = JSON.parse(String(init?.body));
      seen.method = init?.method;
      seen.url = url.pathname + url.search;
      amount = Number(seen.body?.['multiplier']);
      return json(envelope(null));
    }
    throw new Error(`unexpected ${url.pathname}`);
  });
  return seen;
}

test('updateDiaryEntry posts the unit form back whole with the new amount and reports before/after', async () => {
  const seen = editStub();
  const change = await client().updateDiaryEntry({ date: DAY, entryId: ENTRY_A, amount: 400 });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/user/diary/foodstuff/unit/edit?format=json&=');
  assert.equal(seen.body?.['multiplier'], 400);
  assert.equal(seen.body?.['unitGuid'], GRAM); // the entry keeps its current unit
  assert.equal(seen.body?.['diaryGuid'], ENTRY_A);
  assert.equal((seen.body?.['unitOptions'] as unknown[]).length, 2); // options travel back untouched
  assert.equal(change.before.quantity.total, 200);
  assert.equal(change.after?.quantity.total, 400);
});

test('updateDiaryEntry can switch to another of the entry\'s own units', async () => {
  const seen = editStub();
  await client().updateDiaryEntry({ date: DAY, entryId: ENTRY_A, amount: 2, unitId: 'unit100' });
  assert.equal(seen.body?.['unitGuid'], 'unit100');
  assert.equal(seen.body?.['multiplier'], 2);
});

test('updateDiaryEntry refuses recipe lines, unknown units, missing forms and bad amounts without posting', async () => {
  const seen = editStub();
  await assert.rejects(client().updateDiaryEntry({ date: DAY, entryId: ENTRY_C, amount: 1 }), /saved recipe/);
  await assert.rejects(client().updateDiaryEntry({ date: DAY, entryId: ENTRY_A, amount: 1, unitId: 'nope' }), /not valid.*Available/s);
  assert.equal(seen.body, undefined);

  editStub({ form: null }); // the site answers data:null for lines it cannot edit
  await assert.rejects(client().updateDiaryEntry({ date: DAY, entryId: ENTRY_A, amount: 1 }), /no way to change/);

  calls = [];
  for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(client().updateDiaryEntry({ date: DAY, entryId: ENTRY_A, amount }), /positive number/);
  }
  assert.deepEqual(calls, []);
});

test('an out-of-range note date becomes null instead of failing the whole day', () => {
  const day = parseDiaryDay({ ...emptyPayload(), notes: [{ id: 'n', text: 'x', created: 1e16 }] }, DAY);
  assert.deepEqual(day.notes, [{ id: 'n', text: 'x', created: null }]);
  assert.throws(() => parseDiaryDay({ ...emptyPayload(), date: 1e16 }, DAY), KtError);
});

test('entry ids with commas or other URL characters are refused', async () => {
  stubFetch(() => {
    throw new Error('no request expected');
  });
  for (const id of ['entrya0000000,entryc0000000', 'entry a0000000', 'entrya0000000?x=1', 'short']) {
    await assert.rejects(client().deleteDiaryEntry({ date: DAY, entryId: id }), /Invalid entry id/, id);
  }
  assert.deepEqual(calls, []);
});

test('a delete whose reply cannot be read still succeeds when the day shows the line gone', async () => {
  let deleted = false;
  stubFetch(url => {
    if (url.pathname === '/login/create') return loginOk();
    if (diaryDate(url)) {
      const p = withEntryIds(filledPayload());
      if (deleted) {
        p.times[0]!.foodstuff = p.times[0]!.foodstuff.filter(l => (l as { id: string }).id !== ENTRY_A);
        p.foodstuffCount = 4;
      }
      return json(envelope(p));
    }
    deleted = true; // the server processed it, but the body is not JSON
    return new Response('<html>ok</html>', { status: 200 });
  });
  const result = await client().deleteDiaryEntry({ date: DAY, entryId: ENTRY_A });
  assert.equal(result.confirmed, true);
});

test('a delete with an unreadable reply is an error when the line is demonstrably still there', async () => {
  stubFetch(url => {
    if (url.pathname === '/login/create') return loginOk();
    if (diaryDate(url)) return json(envelope(withEntryIds(filledPayload())));
    return new Response('<html>ok</html>', { status: 200 });
  });
  await assert.rejects(client().deleteDiaryEntry({ date: DAY, entryId: ENTRY_A }), /expected JSON/);
});

test('a login failure during a delete stays an auth error and is not mistaken for an unreadable reply', async () => {
  stubFetch(() => json({ code: 5, message: 'Špatné heslo', data: null }));
  await assert.rejects(client().deleteDiaryEntry({ date: DAY, entryId: ENTRY_A }), KtAuthError);
});
