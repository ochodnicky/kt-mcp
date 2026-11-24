/**
 * Tests for favourite activities, the weekly routine, changing a logged
 * activity and day templates. The client runs against a stubbed fetch; the
 * data is synthetic (see testkit.ts).
 */

import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { KtError } from './client.js';
import { parseFavoriteActivities, parseRegularActivities, parseTemplateContents } from './planning.js';
import { PAST, activityLine, client, dayPayload, envelope, foodLine, json, loginOk, okReply, restoreFetch, state, stubFetch } from './testkit.js';

afterEach(restoreFetch);

type Route = [match: string | RegExp, handler: (url: URL, init?: RequestInit) => Response];
function serve(routes: Route[]): void {
  stubFetch((url, init) => {
    if (url.pathname === '/login/create') return loginOk();
    for (const [match, handler] of routes) {
      if (typeof match === 'string' ? url.pathname === match : match.test(url.pathname)) return handler(url, init);
    }
    throw new Error(`unexpected request ${url.pathname}`);
  });
}

const writes = () => state.bodies.filter(b => b.path !== '/login/create');
const A16 = '6b51b3ca4c9383e1';
const R1 = 'a'.repeat(32);
const R2 = 'b'.repeat(32);
const T1 = 'c'.repeat(32);
const T2 = 'd'.repeat(32);

// ---------------------------------------------------------------------------
// Favourite activities
// ---------------------------------------------------------------------------

const favRow = (id: string, title: string) => ({ id, title, category: 'Plavání', energy: '0,15', energyForUser: '12,13', usage: null, favId: 'x' });

test('favourite activities come with the catalogue figure and the figure for the user\'s weight, and nothing else', () => {
  const [a] = parseFavoriteActivities([favRow(A16, 'Test plavání')]);
  assert.deepEqual(a, { id: A16, title: 'Test plavání', category: 'Plavání', kcalPerKgPerMinute: 0.15, kcalPerMinute: 12.13 });
  assert.throws(() => parseFavoriteActivities({}), /expected a list/);
  assert.throws(() => parseFavoriteActivities([{ title: 'no id' }]), /unreadable/);
});

test('adding and removing a favourite activity confirms it from the list the site then shows', async () => {
  let favourite = false;
  serve([
    ['/user/settings/favorite/activity', () => json(envelope(favourite ? [favRow(A16, 'Test plavání')] : []))],
    [
      /^\/user\/settings\/favorite\/activity\/(add|remove)\//,
      url => {
        favourite = url.pathname.includes('/add/');
        return okReply();
      },
    ],
  ]);
  const c = client();
  assert.equal((await c.setFavoriteActivity(A16, true)).confirmed, true);
  assert.ok(state.calls.includes(`/user/settings/favorite/activity/add/${A16}`));
  assert.equal((await c.setFavoriteActivity(A16, false)).confirmed, true);
  await assert.rejects(c.setFavoriteActivity('../x', true), /Invalid entry id/);
});

// ---------------------------------------------------------------------------
// Weekly routine
// ---------------------------------------------------------------------------

const emptyWeek = () => ({ monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] }) as Record<string, unknown[]>;
const regRow = (id: string, over: Record<string, unknown> = {}) => ({ id, title: 'Test plavání', time: 0.5, timeUnit: 'hrs', energy: '327', energyUnit: 'kcal', guidActivity: A16, ...over });

test('the weekly routine is flattened per weekday, with minutes worked out from the site\'s hours', () => {
  const week = emptyWeek();
  week['sunday'] = [regRow(R1)];
  week['monday'] = [regRow(R2, { time: 45, timeUnit: 'min', guidActivity: null }), regRow('e'.repeat(32), { timeUnit: 'furlongs' })];
  const list = parseRegularActivities(week);
  assert.deepEqual(list.map(r => [r.weekday, r.minutes, r.activityId]), [['monday', 45, null], ['monday', null, A16], ['sunday', 30, A16]]);
  assert.throws(() => parseRegularActivities({ monday: [] }), /no list for tuesday/);
  assert.throws(() => parseRegularActivities(null), /expected an object/);
});

const regularForm = (over: Record<string, unknown> = {}) => ({
  guid: A16,
  title: 'Test plavání',
  time: 1,
  timeUnit: 'hrs',
  days: [
    { title: 'Po', day: 2, selected: false },
    { title: 'Út', day: 3, selected: false },
    { title: 'St', day: 4, selected: false },
    { title: 'Čt', day: 5, selected: false },
    { title: 'Pá', day: 6, selected: false },
    { title: 'So', day: 7, selected: false },
    { title: 'Ne', day: 1, selected: false },
  ],
  ...over,
});

function regularRoutes(week: () => Record<string, unknown[]>, form = regularForm, onAdd?: (body: unknown) => void): Route[] {
  return [
    ['/user/settings/activity/regular', () => json(envelope(week()))],
    [`/user/activity/regular/add/form/${A16}`, () => json(envelope(form()))],
    [
      '/user/activity/regular/add',
      (_url, init) => {
        onAdd?.(JSON.parse(String(init?.body)));
        return okReply();
      },
    ],
  ];
}

test('a weekly activity is posted with only the chosen weekdays selected and the time in hours, and the new lines are reported', async () => {
  const week = emptyWeek();
  serve(
    regularRoutes(
      () => week,
      regularForm,
      () => {
        week['monday'] = [regRow(R1)];
        week['thursday'] = [regRow(R2)];
      },
    ),
  );
  const r = await client().addRegularActivity({ activityId: A16, weekdays: ['monday', 'thursday', 'monday'], minutes: 45 });
  const body = writes().find(b => b.path === '/user/activity/regular/add')!.body as { time: number; days: Array<{ day: number; selected: boolean }> };
  assert.equal(body.time, 0.75);
  assert.deepEqual(body.days.filter(d => d.selected).map(d => d.day).sort(), [2, 5]);
  assert.equal(body.days.length, 7);
  assert.deepEqual(r.added.map(a => a.weekday).sort(), ['monday', 'thursday']);
});

test('nothing is written for an activity that is already regular on a chosen day, a bad duration, no weekday or a unit that is not hours', async () => {
  const week = emptyWeek();
  week['monday'] = [regRow(R1)];
  serve(regularRoutes(() => week));
  const c = client();
  await assert.rejects(c.addRegularActivity({ activityId: A16, weekdays: ['monday'], minutes: 30 }), /already a regular activity on monday/);
  await assert.rejects(c.addRegularActivity({ activityId: A16, weekdays: [], minutes: 30 }), /at least one weekday/);
  await assert.rejects(c.addRegularActivity({ activityId: A16, weekdays: ['friday'], minutes: 0 }), /between 1 and 1440/);
  await assert.rejects(c.addRegularActivity({ activityId: A16, weekdays: ['friday'], minutes: 0.4 }), /between 1 and 1440/);
  await assert.rejects(c.addRegularActivity({ activityId: '../x', weekdays: ['friday'], minutes: 30 }), /Invalid entry id/);
  assert.deepEqual(writes(), [], 'no write for the clash, the missing weekday, the bad durations or the bad id');
  serve(regularRoutes(() => emptyWeek(), () => regularForm({ timeUnit: 'min' })));
  await assert.rejects(client().addRegularActivity({ activityId: A16, weekdays: ['friday'], minutes: 30 }), /does not support/);
  assert.deepEqual(writes(), [], 'no write for a unit that is not hours');
});

test('only a regular activity the site lists can be deleted, and an unreadable reply is judged by the list afterwards', async () => {
  let week = emptyWeek();
  week['sunday'] = [regRow(R1)];
  serve([
    ['/user/settings/activity/regular', () => json(envelope(week))],
    [
      /^\/user\/settings\/activity\/regular\/delete\//,
      () => {
        week = emptyWeek();
        return new Response('<html>oops</html>');
      },
    ],
  ]);
  const c = client();
  await assert.rejects(c.deleteRegularActivity(R2), /No regular activity/);
  await assert.rejects(c.deleteRegularActivity('../weight'), /Invalid regular activity id/);
  assert.equal(state.calls.some(p => p.includes('/regular/delete/')), false);
  const r = await c.deleteRegularActivity(R1);
  assert.deepEqual([r.deleted.weekday, r.confirmed], ['sunday', true]);
  assert.ok(state.calls.includes(`/user/settings/activity/regular/delete/${R1}`));
});

// ---------------------------------------------------------------------------
// Changing a logged activity
// ---------------------------------------------------------------------------

const ACT_ID = 'act000000001';
function activityRoutes(form: () => unknown, minutes: () => number, onEdit?: (body: Record<string, unknown>) => void): Route[] {
  return [
    [
      /^\/user\/diary\/\d{2}\.\d{2}\.\d{4}\/get$/,
      url => {
        const date = /\/user\/diary\/(\d{2}\.\d{2}\.\d{4})\/get/.exec(url.pathname)![1]!;
        return json(envelope(dayPayload(date, { activities: [activityLine(ACT_ID, 'Test plavání', `${minutes()} min`, '300')] })));
      },
    ],
    [`/user/diary/activity/unit/form/${ACT_ID}`, () => json(envelope(form()))],
    [
      '/user/diary/activity/unit/edit',
      (_url, init) => {
        onEdit?.(JSON.parse(String(init?.body)));
        return okReply();
      },
    ],
  ];
}
const unitForm = (over: Record<string, unknown> = {}) => ({ diaryGuid: ACT_ID, multiplier: 0.5, unit: 'hrs', energy: 327.4, ...over });

test('an activity\'s duration is changed by posting the site\'s own form back with the new hours, and read back', async () => {
  let minutes = 30;
  serve(activityRoutes(() => unitForm(), () => minutes, body => (minutes = Math.round((body['multiplier'] as number) * 60))));
  const r = await client().updateActivity({ date: PAST, activityId: ACT_ID, minutes: 45 });
  const body = writes().find(b => b.path === '/user/diary/activity/unit/edit')!.body as Record<string, unknown>;
  assert.deepEqual(body, { diaryGuid: ACT_ID, multiplier: 0.75, unit: 'hrs', energy: 327.4 });
  assert.deepEqual([r.before.durationMinutes, r.after?.durationMinutes], [30, 45]);
});

test('nothing is posted for an unknown activity, one the site cannot edit, one not in hours or a silly duration', async () => {
  const c = client();
  serve(activityRoutes(() => unitForm(), () => 30));
  await assert.rejects(c.updateActivity({ date: PAST, activityId: 'nosuchact001', minutes: 45 }), /No activity with id/);
  await assert.rejects(c.updateActivity({ date: PAST, activityId: ACT_ID, minutes: 0 }), /between 1 and 1440/);
  await assert.rejects(c.updateActivity({ date: PAST, activityId: ACT_ID, minutes: 0.2 }), /between 1 and 1440/);
  await assert.rejects(c.updateActivity({ date: PAST, activityId: '../x', minutes: 30 }), /Invalid entry id/);
  assert.deepEqual(writes(), [], 'no write for an unknown activity, a silly duration or a bad id');
  serve(activityRoutes(() => ({ requestId: null, code: 0, message: null, data: null }), () => 30));
  await assert.rejects(client().updateActivity({ date: PAST, activityId: ACT_ID, minutes: 45 }), /offers no way to change/);
  assert.deepEqual(writes(), [], 'no write when the site offers no form');
  serve(activityRoutes(() => unitForm({ unit: 'steps' }), () => 30));
  await assert.rejects(client().updateActivity({ date: PAST, activityId: ACT_ID, minutes: 45 }), /does not support/);
  assert.deepEqual(writes(), [], 'no write for a unit that is not hours');
});

// ---------------------------------------------------------------------------
// Day templates
// ---------------------------------------------------------------------------

const tplRow = (id: string, title: string) => ({ id, title, link: null, energyUnit: 'kcal', visibility: 'private', times: null, activities: null, notes: null, datesToAdd: null, coeficientMultiplier: null });
const tplForm = (id: string, title: string) => ({
  ...tplRow(id, title),
  times: [
    { id: '1', title: 'Snídaně', foodstuff: [{ guid: 'g1', foodstuffGuid: 'f1', userMealGuid: null, title: 'okurka', unitSimple: '10 g' }], notes: [] },
    { id: '2', title: 'Dopolední svačina', foodstuff: [], notes: [] },
    { id: '3', title: 'Oběd', foodstuff: [{ guid: 'g2', foodstuffGuid: null, userMealGuid: 'm1', title: 'můj guláš', unitSimple: '1 porce' }], notes: [] },
  ],
  activities: null,
  notes: [{ guid: 'n1', text: 'Test poznámka', guidDiaryTime: null }],
});

test('a template shows its foods per meal, tells recipes from foods and leaves out empty meals', () => {
  const c = parseTemplateContents(tplForm(T1, 'Test den'));
  assert.deepEqual(c.meals.map(m => m.meal), ['Snídaně', 'Oběd']);
  assert.deepEqual(c.meals[1]!.items, [{ title: 'můj guláš', amount: '1 porce', kind: 'recipe' }]);
  assert.deepEqual([c.foodCount, c.notes], [2, ['Test poznámka']]);
  assert.throws(() => parseTemplateContents({ id: T1, title: 'x' }), /no meal list/);
});

test('saving a day as a template needs food in the day, never asks for activities and finds the new template', async () => {
  let templates = [tplRow(T2, 'Starší')];
  serve([
    [
      /^\/user\/diary\/\d{2}\.\d{2}\.\d{4}\/get$/,
      url => {
        const date = /\/user\/diary\/(\d{2}\.\d{2}\.\d{4})\/get/.exec(url.pathname)![1]!;
        return json(envelope(dayPayload(date, date === PAST ? { meals: { '1': [foodLine('e1', 'Test skyr')] } } : {})));
      },
    ],
    ['/user/templates/list', () => json(envelope(templates))],
    [
      /^\/user\/templates\/diary\/.*\/create$/,
      () => {
        templates = [...templates, tplRow(T1, 'Test den')];
        return okReply();
      },
    ],
  ]);
  const c = client();
  const r = await c.saveDayAsTemplate({ date: PAST, title: '  Test den  ', includeNotes: true });
  assert.deepEqual(writes().find(b => b.path.endsWith('/create'))!.body, { title: 'Test den', includeActivities: false, includeNotes: true });
  assert.deepEqual([r.template?.id, r.entries], [T1, 1]);
  await assert.rejects(c.saveDayAsTemplate({ date: '11.11.2026', title: 'Prázdný' }), /no food entries/);
  await assert.rejects(c.saveDayAsTemplate({ date: PAST, title: '   ' }), /title must be/);
  assert.equal(writes().filter(b => b.path.endsWith('/create')).length, 1);
});

function applyRoutes(entries: () => number, onWrite?: (body: Record<string, unknown>) => void): Route[] {
  return [
    ['/user/templates/list', () => json(envelope([tplRow(T1, 'Test den')]))],
    [`/user/templates/form/${T1}`, () => json(envelope(tplForm(T1, 'Test den')))],
    [
      /^\/user\/diary\/\d{2}\.\d{2}\.\d{4}\/get$/,
      url => {
        const date = /\/user\/diary\/(\d{2}\.\d{2}\.\d{4})\/get/.exec(url.pathname)![1]!;
        const lines = Array.from({ length: entries() }, (_, i) => foodLine(`e${i}`, `Test ${i}`));
        return json(envelope(dayPayload(date, { meals: { '1': lines } })));
      },
    ],
    [
      '/user/templates/diary/write',
      (_url, init) => {
        onWrite?.(JSON.parse(String(init?.body)));
        return okReply();
      },
    ],
  ];
}

test('applying a template posts the site\'s own template data with the days, and compares each day before and after', async () => {
  let n = 0;
  serve(applyRoutes(() => n, () => (n += 2)));
  const r = await client().applyDayTemplate({ templateId: T1, dates: [PAST, '11.11.2026', PAST] });
  const body = writes().find(b => b.path === '/user/templates/diary/write')!.body as Record<string, unknown>;
  assert.deepEqual(body['datesToAdd'], [PAST, '11.11.2026']);
  assert.equal(body['id'], T1);
  assert.equal(Array.isArray(body['times']), true);
  assert.deepEqual(body['notes'], [{ guid: 'n1', text: 'Test poznámka', guidDiaryTime: null }]);
  assert.deepEqual(r.days.map(d => [d.entriesBefore, d.entriesAfter]), [[0, 2], [0, 2]]);
  assert.equal(r.expectedFoods, 2);
});

test('a template is not written for an unknown id, no day, more than 7 days or a day that does not exist', async () => {
  serve(applyRoutes(() => 0));
  const c = client();
  await assert.rejects(c.applyDayTemplate({ templateId: T2, dates: [PAST] }), /No day template/);
  await assert.rejects(c.applyDayTemplate({ templateId: '../x', dates: [PAST] }), /Invalid template id/);
  await assert.rejects(c.applyDayTemplate({ templateId: T1, dates: [] }), /between 1 and 7/);
  await assert.rejects(c.applyDayTemplate({ templateId: T1, dates: Array.from({ length: 8 }, (_, i) => `0${i + 1}.11.2026`) }), /between 1 and 7/);
  await assert.rejects(c.applyDayTemplate({ templateId: T1, dates: ['31.02.2026'] }), /does not exist/);
  assert.deepEqual(writes(), []);
  assert.equal(state.calls.includes('/user/templates/diary/write'), false);
});

test('deleting a template posts the listed template, refuses an id the site does not list and judges an unreadable reply by the list', async () => {
  let templates = [tplRow(T1, 'Test den')];
  serve([
    ['/user/templates/list', () => json(envelope(templates))],
    [
      '/user/templates/delete',
      () => {
        templates = [];
        return new Response('<html>oops</html>');
      },
    ],
  ]);
  const c = client();
  await assert.rejects(c.deleteDayTemplate(T2), /No day template/);
  assert.equal(writes().length, 0);
  const r = await c.deleteDayTemplate(T1);
  assert.deepEqual([r.deleted, r.confirmed], ['Test den', true]);
  assert.equal((writes().find(b => b.path === '/user/templates/delete')!.body as { id: string }).id, T1);
});

test('reading a template that is not listed is refused before the form is requested', async () => {
  serve([['/user/templates/list', () => json(envelope([tplRow(T1, 'Test den')]))]]);
  await assert.rejects(client().getDayTemplate(T2), (e: unknown) => e instanceof KtError && /No day template/.test(e.message));
  assert.equal(state.calls.some(p => p.includes('/templates/form/')), false);
});

// ---------------------------------------------------------------------------
// Review follow-ups
// ---------------------------------------------------------------------------

test('minutes are posted as whole minutes, so what is written and what is read back agree', async () => {
  let minutes = 30;
  serve(activityRoutes(() => unitForm(), () => minutes, body => (minutes = Math.round((body['multiplier'] as number) * 60))));
  const r = await client().updateActivity({ date: PAST, activityId: ACT_ID, minutes: 45.4 });
  assert.equal((writes().find(b => b.path === '/user/diary/activity/unit/edit')!.body as { multiplier: number }).multiplier, 0.75);
  assert.equal(r.after?.durationMinutes, 45);

  serve(regularRoutes(() => emptyWeek(), regularForm, () => undefined));
  await client().addRegularActivity({ activityId: A16, weekdays: ['friday'], minutes: 29.6 });
  assert.equal((writes().find(b => b.path === '/user/activity/regular/add')!.body as { time: number }).time, 0.5);
});

test('a template is written with its identity and contents only: no multiplier, no share or write switches', async () => {
  let n = 0;
  const listed = { ...tplRow(T1, 'Test den'), coeficientMultiplier: 3, userGuidToShare: 'someone', write: true, share: true, searchable: true };
  serve([
    ...applyRoutes(() => n, () => (n += 2)).filter(([m]) => m !== '/user/templates/list'),
    ['/user/templates/list', () => json(envelope([listed]))],
  ]);
  await client().applyDayTemplate({ templateId: T1, dates: [PAST] });
  const body = writes().find(b => b.path === '/user/templates/diary/write')!.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['activities', 'coeficientMultiplier', 'datesToAdd', 'energyUnit', 'id', 'notes', 'times', 'title', 'visibility']);
  assert.equal(body['coeficientMultiplier'], null);
});

test('when the template write fails after some days were written, the error gives the counts and says not to repeat', async () => {
  let written = false;
  serve([
    ...applyRoutes(() => (written ? 2 : 0)).filter(([m]) => m !== '/user/templates/diary/write'),
    [
      '/user/templates/diary/write',
      () => {
        written = true;
        return new Response('<html>timeout</html>');
      },
    ],
  ]);
  await assert.rejects(
    client().applyDayTemplate({ templateId: T1, dates: [PAST] }),
    (e: Error) => /partly written/.test(e.message) && /10\.11\.2026 0 -> 2 entries/.test(e.message) && /do not repeat/.test(e.message),
  );
});

test('when the template write fails and nothing changed, the original error is shown', async () => {
  serve([...applyRoutes(() => 0).filter(([m]) => m !== '/user/templates/diary/write'), ['/user/templates/diary/write', () => new Response('<html>nope</html>')]]);
  await assert.rejects(client().applyDayTemplate({ templateId: T1, dates: [PAST] }), (e: Error) => /expected JSON/.test(e.message) && !/partly/.test(e.message));
});

test('a weekly activity whose reply cannot be read is reported as added when the routine shows it, and is not retried blindly', async () => {
  const week = emptyWeek();
  serve([
    ...regularRoutes(() => week).filter(([m]) => m !== '/user/activity/regular/add'),
    [
      '/user/activity/regular/add',
      () => {
        week['friday'] = [regRow(R1)];
        return new Response('<html>oops</html>');
      },
    ],
  ]);
  await assert.rejects(client().addRegularActivity({ activityId: A16, weekdays: ['friday'], minutes: 30 }), (e: Error) => /friday was added/.test(e.message) && /Do not repeat/.test(e.message));

  serve([...regularRoutes(() => emptyWeek()).filter(([m]) => m !== '/user/activity/regular/add'), ['/user/activity/regular/add', () => new Response('<html>oops</html>')]]);
  await assert.rejects(client().addRegularActivity({ activityId: A16, weekdays: ['friday'], minutes: 30 }), /expected JSON/);
});
