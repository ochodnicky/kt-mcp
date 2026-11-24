/**
 * Shared helpers for tests that run the client against a stubbed fetch.
 * Not a test itself. Everything here produces SYNTHETIC data in the shapes the
 * real site was observed to use; no real diary content belongs in the repository.
 */

import { KtClient } from './client.js';

export const realFetch = globalThis.fetch;
export const state: { calls: string[]; bodies: Array<{ path: string; method: string; body: unknown }> } = { calls: [], bodies: [] };

export type Responder = (url: URL, init: RequestInit | undefined) => Response;

export function stubFetch(responder: Responder): void {
  state.calls = [];
  state.bodies = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    state.calls.push(url.pathname);
    if (init?.body !== undefined) state.bodies.push({ path: url.pathname, method: init.method ?? 'GET', body: JSON.parse(String(init.body)) });
    return responder(url, init);
  }) as typeof fetch;
}

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

export const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

export const envelope = (data: unknown, message: string | null = null) => ({ requestId: null, code: 0, message, data });
export const loginOk = () => json({ code: 0, message: null, data: null }, { 'set-cookie': 'JSESSIONID=fake; Path=/; HttpOnly' });
export const toLogin = () => new Response(null, { status: 302, headers: { location: 'https://www.kaloricketabulky.cz/login' } });
export const okReply = (message = 'OK') => json(envelope(null, message));

export const client = () => new KtClient({ email: 'test@example.invalid', password: 'not-a-real-password' });

/** Noon UTC of a dd.MM.yyyy day — Prague's date for that instant is the same day all year round. */
export function noonEpoch(date: string): number {
  const [d, m, y] = date.split('.').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, 12);
}

export const PAST = '10.11.2026';
export const OTHER_PAST = '09.11.2026';

export function dayDate(url: URL): string | undefined {
  return /\/user\/diary\/(\d{2}\.\d{2}\.\d{4})\/get/.exec(url.pathname)?.[1];
}

export function foodLine(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    type: 'foodstuff',
    title,
    unit: '100 x 1 g',
    energy: '100',
    energyUnit: 'kcal',
    protein: 10,
    carbohydrate: 5,
    fat: 2,
    fiber: null,
    sugar: null,
    saturatedFattyAcid: null,
    salt: 0.1,
    isRecipe: false,
    guidUserMeal: null,
    ...over,
  };
}

export interface FakeDay {
  meals?: Record<string, unknown[]>; // meal id -> lines
  activities?: unknown[];
  notes?: unknown[]; // whole-day notes
  mealNotes?: Record<string, unknown[]>;
}

/** A diary-day payload as the site sends it. */
export function dayPayload(date: string, d: FakeDay = {}) {
  const ids = ['1', '2', '3', '4', '5', '6'];
  const titles = ['Snídaně', 'Dopolední svačina', 'Oběd', 'Odpolední svačina', 'Večeře', 'Druhá večeře'];
  const times = ids.map((id, i) => ({
    id,
    title: titles[i],
    foodstuff: d.meals?.[id] ?? [],
    notes: d.mealNotes?.[id] ?? [],
    energyTotal: null,
  }));
  return {
    date: noonEpoch(date),
    energyUnit: 'kcal',
    times,
    activities: d.activities ?? [],
    notes: d.notes ?? [],
    proteinTotal: 0,
    foodstuffCount: Object.values(d.meals ?? {}).reduce((n, l) => n + l.length, 0),
  };
}

export const note = (id: string, text: string) => ({
  id,
  created: Date.UTC(2026, 10, 10, 9, 0),
  text,
  // The site embeds the whole user record in every note; tests plant fakes to prove none of it escapes.
  user: { email: 'test@example.invalid', password: 'fake-hash-value' },
});

export const activityLine = (id: string, title: string, unit: string | null, energy = '100', steps: number | null = null) => ({
  id,
  type: 'activity',
  title,
  unit,
  energy,
  energyUnit: 'kcal',
  steps,
});

/** A `/user/diary/summary/{date}/get` payload. */
export function balancePayload(over: { intake?: string; output?: string; target?: string } = {}) {
  return {
    items: [{ code: 'total', unit: 'kcal', goal: '2 000', actual: over.intake ?? '1 800', percent: 90 }],
    itemsDynamic: [
      [
        { code: 'protein', title: 'Bílkoviny', unit: 'g', goal: '150', actual: '120', percent: 80 },
        { code: 'fat', title: 'Tuky', unit: 'g', goal: '70,5', actual: '65', percent: 92 },
      ],
      [{ code: 'calcium', title: 'Vápník', unit: 'mg', goal: '1 000', actual: '900', percent: 90 }],
    ],
    activityEnergyTotal: 300,
    weight: '81,9',
    balance: {
      intake: over.intake ?? '1 800',
      target: over.target ?? '2 000',
      output: over.output ?? '2 500',
      energyIntakeMaintenance: '2 500',
      energyDeficit: '-500',
      basal: '1 750',
      intakeRest: '200',
    },
  };
}

/**
 * A `/user/settings/profile/form` payload as the site sends it. The personal
 * fields (e-mail, hash, tokens) are planted fakes so tests can prove they never leave.
 */
export function profileForm(over: Record<string, unknown> = {}) {
  const nutrient = (code: string, title: string, computedValue: string, value: number | null = null) => ({
    active: true,
    code,
    computedValue,
    ratio: null,
    sort: 0,
    title,
    value,
  });
  return {
    email: 'test@example.invalid',
    password1: null,
    password2: null,
    gopayToken: 'fake-token',
    guid: 'fake-support-code',
    agreements: [{ selected: true, type: 'TERMS_AND_CONDITIONS' }],
    lang: 'cs',
    sex: 'M',
    height: 175,
    year: 1992,
    weight: 81.9,
    targetWeight: 72,
    mode: 1,
    amr: 1.2,
    considerActivity: true,
    energyUnit: 'kcal',
    computedBasal: '1 748',
    computedTargetEnergy: '1 783',
    ownBasal: null,
    ownTargetEnergy: null,
    ownDailyDose: true,
    ownNutrients: [
      nutrient('protein', 'Bílkoviny', '123', 144),
      nutrient('carbohydrate', 'Sacharidy', '189', 163),
      nutrient('fat', 'Tuky', '55,5', 55),
      nutrient('fiber', 'Vláknina', '27,5', 28),
      nutrient('sugar', 'Cukry', '35,8'),
    ],
    drinkRegime: 3.28,
    modeOpen: false,
    targetWeightOpen: false,
    amrOpen: false,
    ownBasalOpen: false,
    ownTargetEnergyOpen: false,
    weightOpen: false,
    ...over,
  };
}

/** The nutrient figures beyond the basic seven, all unknown. Spread into a hand-built DiaryEntry's nutrients. */
export const NO_EXTRA_NUTRIENTS = {
  calcium: null,
  cholesterol: null,
  sodium: null,
  transFat: null,
  monounsaturatedFat: null,
  polyunsaturatedFat: null,
  alcohol: null,
};
