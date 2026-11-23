/**
 * Client for the private JSON API behind www.kaloricketabulky.cz.
 *
 * The site is a Spring MVC app where any route accepts `?format=json` and
 * replies with a `{code, data, message}` envelope (`code: 0` means success).
 * Auth is a JSESSIONID cookie obtained by posting an md5 of the password.
 *
 * None of this is documented or guaranteed by Dine4Fit. Every call that
 * deviates from the shape we expect throws rather than guessing, so a
 * frontend change surfaces as a loud error instead of a wrong calorie count.
 */

import { createHash } from 'node:crypto';

const BASE = 'https://www.kaloricketabulky.cz';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** unitGuid for plain grams — accepted by every solid food. */
export const GRAM_UNIT = '0000000000000001';

/**
 * Pseudo-unit meaning "one portion of this recipe", offered only by the
 * meal-add form (alongside `0000000000000003` for percent).
 */
export const PORTION_UNIT = '0000000000000004';

/** Diary time slots, keyed by the `diaryTimeGuid` the site expects. */
export const MEALS = {
  '1': 'Snídaně',
  '2': 'Dopolední svačina',
  '3': 'Oběd',
  '4': 'Odpolední svačina',
  '5': 'Večeře',
  '6': 'Druhá večeře',
} as const;

export type MealId = keyof typeof MEALS;

export interface FoodHit {
  id: string;
  title: string;
  /** Energy per 100 g / 100 ml, as the site reports it in search results. */
  energyPer100: number | null;
  energyUnit: string;
  baseUnit: string;
  brand: string | null;
}

export interface UnitOption {
  id: string;
  title: string;
  /** Grams (or ml) that one of this unit corresponds to. */
  grams: number;
}

export interface FoodDetail {
  id: string;
  title: string;
  units: UnitOption[];
  /** The site's own default portion for this food. */
  defaultUnitId: string;
  defaultAmount: number;
}

export interface Nutrition {
  title: string;
  energy: number | null;
  energyUnit: string;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  sugar: number | null;
  fibre: number | null;
  saturatedFat: number | null;
  salt: number | null;
}

export interface MealSummary {
  id: string;
  title: string;
  /** Energy for the whole recipe, not per portion. */
  energy: number | null;
  energyUnit: string;
  portions: number;
}

export class KtError extends Error {}

/**
 * Login failed, or the session could not be (re)established. Callers that loop
 * over many requests abort on this instead of retrying the login every time.
 */
export class KtAuthError extends KtError {}

/** One logged diary line, as the site's diary page shows it. */
export interface EntryQuantity {
  /** The site's own display string, verbatim ("3 x kus (19 g)"); null when the site sends none. */
  raw: string | null;
  /** How many of the unit. The site omits "1 x", so a bare "porce" is count 1. */
  count: number | null;
  /** Portion unit name ("kus", "porce"); null for plain grams/millilitres. */
  label: string | null;
  /** Size of one unit, when the site states it ("kus (19 g)" → 19). */
  unitSize: number | null;
  unitSizeUnit: 'g' | 'ml' | null;
  /** count × unitSize; null whenever either part is unknown. */
  total: number | null;
  totalUnit: 'g' | 'ml' | null;
}

/** Nutrient amounts in grams for the logged quantity (not per 100 g). null = the site has no value. */
export interface EntryNutrients {
  protein: number | null;
  carbohydrate: number | null;
  fat: number | null;
  fibre: number | null;
  sugar: number | null;
  saturatedFat: number | null;
  salt: number | null;
}

export interface DiaryEntry {
  id: string;
  title: string;
  /** "recipe" when the line was logged from one of the user's saved recipes. */
  kind: 'food' | 'recipe';
  quantity: EntryQuantity;
  /** Energy for the logged quantity. */
  energy: number | null;
  energyUnit: string;
  nutrients: EntryNutrients;
}

export interface DiaryMeal {
  id: string;
  title: string;
  energyTotal: number | null;
  entries: DiaryEntry[];
}

/** An exercise line (walk, workout, step count). Energy is what the site credits as burned. */
export interface DiaryActivity {
  id: string;
  title: string;
  /** Parsed from "155 min"; null when the site gives no duration (step-count lines). */
  durationMinutes: number | null;
  steps: number | null;
  energy: number | null;
  energyUnit: string;
}

/** A free-text note on the day. Only these fields are read — the site embeds the whole user record in each note. */
export interface DiaryNote {
  id: string;
  text: string;
  /** ISO-8601 instant the note was written. */
  created: string | null;
}

export interface DiaryDay {
  /** dd.MM.yyyy, as requested (and confirmed by the site's own date field). */
  date: string;
  energyUnit: string;
  meals: DiaryMeal[];
  /** Number of food/recipe lines only; activities and notes do not count. */
  entryCount: number;
  /** null (not []) when the response had no readable activity list. */
  activities: DiaryActivity[] | null;
  /** null (not []) when the response had no readable note list. */
  notes: DiaryNote[] | null;
}

export interface EntryDeletion {
  date: string;
  meal: string;
  /** The line as it was before deletion. */
  deleted: DiaryEntry;
  /** true = re-read shows it gone, false = still listed, null = could not re-read. */
  confirmed: boolean | null;
}

export interface EntryChange {
  date: string;
  meal: string;
  before: DiaryEntry;
  /** null when the line could not be re-read after the change. */
  after: DiaryEntry | null;
}

/** Diary-line ids end up in a URL path, so accept nothing but plain alphanumerics. */
export function assertEntryId(id: string): string {
  if (!/^[A-Za-z0-9]{8,64}$/.test(id)) throw new Error(`Invalid entry id "${id}" — use an entry_id from get_day_entries`);
  return id;
}

export type DayOutcome =
  | { date: string; status: 'filled' | 'empty'; day: DiaryDay }
  | { date: string; status: 'error'; error: string };

/** Hard cap for get_diary_range, inclusive of both end days. */
export const MAX_RANGE_DAYS = 14;

/**
 * A food's base unit — the one whose multiplier is 1 (the site sends `null`
 * for it). Grams for solids, millilitres for liquids, and a liquid's unit list
 * does not contain the gram unit at all, so this must be read per food rather
 * than assumed.
 */
export function baseUnitOf(units: UnitOption[]): string {
  return units.find(u => u.grams === 0 || u.grams === 1)?.id ?? GRAM_UNIT;
}

/**
 * Czech number formatting: decimal comma, thin/regular space as the thousands
 * separator ("1 043", "20,43"). Returns null for absent or unparseable values
 * rather than a misleading 0.
 */
export function parseCzechNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalised = value.replace(/[\s  ]/g, '').replace(',', '.');
  if (normalised === '') return null;
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}

/** The site formats dates as dd.MM.yyyy everywhere. */
export function formatCzechDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${date.getFullYear()}`;
}

/** An instant as the dd.MM.yyyy date on the Czech wall clock. */
export function pragueDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Prague',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(instant);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')}`;
}

export function todayCzech(): string {
  // The diary runs on Czech wall-clock time; the server usually doesn't
  // (containers default to UTC, which would flip the date around midnight).
  return pragueDate(new Date());
}

/**
 * Dates come from the model, and one of them ends up in a URL path, so accept
 * nothing but the site's own dd.MM.yyyy shape.
 */
export function assertCzechDate(date: string): string {
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(date)) {
    throw new Error(`Invalid date "${date}" — expected dd.MM.yyyy, e.g. ${todayCzech()}`);
  }
  return date;
}

/** Epoch milliseconds of midnight UTC for a dd.MM.yyyy string, or null when it is not a real calendar day. */
function utcDayOf(date: string): number | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date);
  if (!m) return null;
  const [dd, mm, yyyy] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(yyyy, mm - 1, dd));
  const real = t.getUTCFullYear() === yyyy && t.getUTCMonth() === mm - 1 && t.getUTCDate() === dd;
  return real ? t.getTime() : null;
}

/**
 * Like assertCzechDate, but also rejects days that do not exist. The site
 * silently rolls 31.02.2026 over to 03.03.2026, which would answer for the
 * wrong day without any error, so the read tools validate the calendar too.
 */
export function assertCalendarDate(date: string): string {
  assertCzechDate(date);
  if (utcDayOf(date) === null) throw new Error(`Invalid date "${date}" — that day does not exist in the calendar`);
  return date;
}

/** Every day from `from` to `to`, both included, as dd.MM.yyyy. */
export function enumerateDays(from: string, to: string, maxDays = MAX_RANGE_DAYS): string[] {
  const start = utcDayOf(assertCalendarDate(from));
  const end = utcDayOf(assertCalendarDate(to));
  if (start === null || end === null) throw new Error('Invalid date range'); // unreachable after the asserts
  if (start > end) throw new Error(`Invalid range: "from" (${from}) is after "to" (${to})`);
  const DAY = 86_400_000;
  const count = Math.round((end - start) / DAY) + 1;
  if (count > maxDays) {
    throw new Error(`Range too long: ${count} days requested, the maximum is ${maxDays} (both end days included)`);
  }
  const days: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start + i * DAY);
    days.push(
      `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`,
    );
  }
  return days;
}

const NUM = String.raw`(\d[\d ]*(?:,\d+)?)`;
const LABEL = String.raw`([^()\d][^()]*?)`;
const QUANTITY_PATTERNS = {
  countTimesSize: new RegExp(String.raw`^${NUM} x ${NUM} (g|ml)$`), // "50 x 1 g"
  plain: new RegExp(String.raw`^${NUM} (g|ml)$`), // "200 g"
  countLabelSized: new RegExp(String.raw`^${NUM} x ${LABEL} \(${NUM} (g|ml)\)$`), // "3 x kus (19 g)"
  labelSized: new RegExp(String.raw`^${LABEL} \(${NUM} (g|ml)\)$`), // "porce (50 g)"
  countLabel: new RegExp(String.raw`^${NUM} x ${LABEL}$`), // "0,84 x porce"
  label: new RegExp(String.raw`^${LABEL}$`), // "porce"
};

/**
 * Best-effort reading of the site's quantity display string. The diary payload
 * carries no numeric amount, only this text, so the raw string is always kept
 * and anything that does not match a known shape comes back with nulls rather
 * than a guess. Never throws.
 */
export function parseQuantity(raw: unknown): EntryQuantity {
  const rawText = typeof raw === 'string' ? raw : null;
  const make = (p: Partial<EntryQuantity> = {}): EntryQuantity => ({
    raw: rawText,
    count: null,
    label: null,
    unitSize: null,
    unitSizeUnit: null,
    total: null,
    totalUnit: null,
    ...p,
  });
  if (rawText === null || rawText.trim() === '') return make();

  const text = rawText.replace(/[  ]/g, ' ').trim();
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  const unitOf = (u: string | undefined): 'g' | 'ml' | null => (u === 'g' || u === 'ml' ? u : null);
  const sized = (count: number, label: string | null, size: number, unit: 'g' | 'ml') =>
    make({ count, label, unitSize: size, unitSizeUnit: unit, total: round(count * size), totalUnit: unit });

  let m = QUANTITY_PATTERNS.countTimesSize.exec(text);
  if (m) {
    const count = parseCzechNumber(m[1]);
    const size = parseCzechNumber(m[2]);
    const unit = unitOf(m[3]);
    if (count !== null && size !== null && unit) return sized(count, null, size, unit);
    return make();
  }
  m = QUANTITY_PATTERNS.plain.exec(text);
  if (m) {
    const total = parseCzechNumber(m[1]);
    const unit = unitOf(m[2]);
    if (total !== null && unit) return make({ total, totalUnit: unit });
    return make();
  }
  m = QUANTITY_PATTERNS.countLabelSized.exec(text);
  if (m) {
    const count = parseCzechNumber(m[1]);
    const size = parseCzechNumber(m[3]);
    const unit = unitOf(m[4]);
    if (count !== null && size !== null && unit && m[2]) return sized(count, m[2], size, unit);
    return make();
  }
  m = QUANTITY_PATTERNS.labelSized.exec(text);
  if (m) {
    const size = parseCzechNumber(m[2]);
    const unit = unitOf(m[3]);
    if (size !== null && unit && m[1]) return sized(1, m[1], size, unit);
    return make();
  }
  m = QUANTITY_PATTERNS.countLabel.exec(text);
  if (m) {
    const count = parseCzechNumber(m[1]);
    if (count !== null && m[2]) return make({ count, label: m[2] });
    return make();
  }
  m = QUANTITY_PATTERNS.label.exec(text);
  if (m?.[1]) return make({ count: 1, label: m[1] });
  return make();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseDiaryEntry(raw: unknown, dayEnergyUnit: string, where: string): DiaryEntry {
  if (!isRecord(raw)) throw new KtError(`${where}: diary line is not an object`);
  if (typeof raw['title'] !== 'string') throw new KtError(`${where}: diary line has no title`);
  // A saved recipe is a normal "foodstuff" line that carries the recipe's guid.
  const isRecipe = typeof raw['guidUserMeal'] === 'string' || raw['isRecipe'] === true;
  return {
    id: String(raw['id'] ?? ''),
    title: raw['title'],
    kind: isRecipe ? 'recipe' : 'food',
    quantity: parseQuantity(raw['unit']),
    energy: parseCzechNumber(raw['energy']),
    energyUnit: typeof raw['energyUnit'] === 'string' ? raw['energyUnit'] : dayEnergyUnit,
    nutrients: {
      protein: parseCzechNumber(raw['protein']),
      carbohydrate: parseCzechNumber(raw['carbohydrate']),
      fat: parseCzechNumber(raw['fat']),
      fibre: parseCzechNumber(raw['fiber']),
      sugar: parseCzechNumber(raw['sugar']),
      saturatedFat: parseCzechNumber(raw['saturatedFattyAcid']),
      salt: parseCzechNumber(raw['salt']),
    },
  };
}

/** All-or-nothing: one unreadable activity makes the whole list "unknown" rather than silently partial. */
function parseActivities(raw: unknown, dayEnergyUnit: string): DiaryActivity[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DiaryActivity[] = [];
  for (const a of raw as unknown[]) {
    if (!isRecord(a) || typeof a['title'] !== 'string') return null;
    const minutes = typeof a['unit'] === 'string' ? /^(\d[\d ]*(?:,\d+)?) min$/.exec(a['unit'].replace(/[  ]/g, ' ').trim()) : null;
    out.push({
      id: String(a['id'] ?? ''),
      title: a['title'],
      durationMinutes: minutes ? parseCzechNumber(minutes[1]) : null,
      steps: parseCzechNumber(a['steps']),
      energy: parseCzechNumber(a['energy']),
      energyUnit: typeof a['energyUnit'] === 'string' ? a['energyUnit'] : dayEnergyUnit,
    });
  }
  return out;
}

/** ISO string for an epoch-ms value, or null when it is not a valid date (toISOString would throw). */
function isoOrNull(epoch: number): string | null {
  const d = new Date(epoch);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseNotes(raw: unknown): DiaryNote[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DiaryNote[] = [];
  for (const n of raw as unknown[]) {
    if (!isRecord(n) || typeof n['text'] !== 'string') return null;
    const created = n['created'];
    out.push({
      id: String(n['id'] ?? ''),
      text: n['text'],
      created: typeof created === 'number' ? isoOrNull(created) : null,
    });
  }
  return out;
}

/**
 * Turns the payload of `/user/diary/{date}/get` into typed entries. Anything
 * structurally unexpected throws — an unrecognised response must never look
 * like an empty day. The payload's own day-level totals are deliberately
 * ignored: they were 0 on days that had entries.
 */
export function parseDiaryDay(data: unknown, requestedDate: string): DiaryDay {
  const where = `diary ${requestedDate}`;
  if (!isRecord(data)) throw new KtError(`${where}: expected an object`);
  if (!Array.isArray(data['times'])) throw new KtError(`${where}: response has no meal list`);

  // The site answers for whatever day it parsed, so confirm it is the one asked for.
  const epoch = data['date'];
  if (typeof epoch !== 'number' || Number.isNaN(new Date(epoch).getTime())) throw new KtError(`${where}: response has no valid date`);
  const answered = pragueDate(new Date(epoch));
  if (answered !== requestedDate) throw new KtError(`${where}: the site answered for ${answered}`);

  const energyUnit = typeof data['energyUnit'] === 'string' ? data['energyUnit'] : 'kcal';
  const meals: DiaryMeal[] = data['times'].map((slot: unknown, i: number) => {
    if (!isRecord(slot)) throw new KtError(`${where}: meal ${i} is not an object`);
    if (typeof slot['title'] !== 'string') throw new KtError(`${where}: meal ${i} has no title`);
    if (!Array.isArray(slot['foodstuff'])) throw new KtError(`${where}: meal "${slot['title']}" has no entry list`);
    return {
      id: String(slot['id'] ?? i),
      title: slot['title'],
      energyTotal: parseCzechNumber(slot['energyTotal']),
      entries: slot['foodstuff'].map((raw: unknown) => parseDiaryEntry(raw, energyUnit, `${where} / ${String(slot['title'])}`)),
    };
  });

  const entryCount = meals.reduce((n, m) => n + m.entries.length, 0);
  const declared = data['foodstuffCount'];
  if (typeof declared === 'number' && declared !== entryCount) {
    throw new KtError(`${where}: site reports ${declared} entries but ${entryCount} were present`);
  }
  return {
    date: requestedDate,
    energyUnit,
    meals,
    entryCount,
    activities: parseActivities(data['activities'], energyUnit),
    notes: parseNotes(data['notes']),
  };
}

export interface KtCredentials {
  email: string;
  password: string;
}

export class KtClient {
  private cookie: string | null = null;
  private loginInFlight: Promise<void> | null = null;

  constructor(private readonly credentials: KtCredentials) {}

  private async request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; redirectedToLogin: boolean; text: string }> {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'application/json',
    };
    if (this.cookie) headers['Cookie'] = this.cookie;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(BASE + path, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
    });

    // Capture a rotated session cookie whenever the site issues one.
    const setCookie = response.headers.getSetCookie?.() ?? [];
    const jsession = setCookie.find(c => c.startsWith('JSESSIONID='));
    if (jsession) this.cookie = jsession.split(';')[0] ?? null;

    // Spring Security answers unauthenticated /user/** with a 302 to /login.
    const location = response.headers.get('location') ?? '';
    const redirectedToLogin = response.status >= 300 && response.status < 400 && location.includes('/login');

    return { status: response.status, redirectedToLogin, text: await response.text() };
  }

  private parseEnvelope(text: string, context: string): unknown {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new KtError(`${context}: expected JSON, got ${text.slice(0, 120)}`);
    }
    // Two envelope shapes exist: most routes send {code, message, data}, but
    // some list endpoints send {requestId, count, data} with no code at all.
    // Unwrap `data` whenever it is present, and only enforce `code` when it is.
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const envelope = body as { code?: number; message?: string; data?: unknown };
      if (typeof envelope.code === 'number' && envelope.code !== 0) {
        throw new KtError(`${context}: ${envelope.message ?? `code ${envelope.code}`}`);
      }
      if ('data' in envelope && envelope.data !== null) return envelope.data;
    }
    return body;
  }

  /** Logs in, reusing an in-flight attempt so concurrent tool calls don't stampede. */
  private async login(): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      try {
        this.cookie = null;
        const passwordHash = createHash('md5').update(this.credentials.password).digest('hex');
        const { text } = await this.request('/login/create?format=json', {
          method: 'POST',
          body: { email: this.credentials.email, password: passwordHash },
        });
        this.parseEnvelope(text, 'login');
        if (!this.cookie) throw new KtError('login succeeded but no session cookie was issued');
      } catch (error) {
        // Tagged so loops over many requests can stop at the first login failure.
        if (error instanceof KtAuthError) throw error;
        throw new KtAuthError(error instanceof Error ? error.message : String(error), { cause: error });
      }
    })().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  /** Runs an authenticated call, logging in on first use and once on session expiry. */
  private async authed(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    if (!this.cookie) await this.login();
    let result = await this.request(path, init);
    if (result.redirectedToLogin) {
      await this.login();
      result = await this.request(path, init);
      if (result.redirectedToLogin) throw new KtAuthError(`${path}: still unauthenticated after re-login`);
    }
    return this.parseEnvelope(result.text, path);
  }

  /**
   * Full-text or EAN search. Works anonymously, so no login is forced here.
   * A 13-digit barcode resolves to the matching product.
   */
  async search(query: string, limit = 10): Promise<FoodHit[]> {
    const { text } = await this.request(
      `/autocomplete/foodstuff-activity-meal?format=json&query=${encodeURIComponent(query)}`,
    );
    const data = this.parseEnvelope(text, 'search');
    if (!Array.isArray(data)) throw new KtError('search: expected an array of results');

    return data
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && (row as Record<string, unknown>)['clazz'] === 'foodstuff')
      .slice(0, limit)
      .map(row => ({
        id: String(row['id']),
        title: String(row['title']),
        energyPer100: parseCzechNumber(row['value']),
        energyUnit: typeof row['energyUnit'] === 'string' ? row['energyUnit'] : 'kcal',
        baseUnit: typeof row['unit'] === 'string' ? row['unit'] : 'g',
        brand: typeof row['brandName'] === 'string' ? row['brandName'] : null,
      }));
  }

  /**
   * The site's own add-entry form for a food. This is the source of truth for
   * which portion units exist ("kus (55 g)"), so "3 eggs" maps onto the site's
   * model instead of us guessing gram weights.
   */
  async getFoodDetail(foodId: string): Promise<FoodDetail> {
    const { text } = await this.request(
      `/foodstuff/detail/form/${encodeURIComponent(foodId)}?format=json&default=true`,
    );
    const form = this.parseEnvelope(text, 'food detail') as Record<string, unknown>;
    if (typeof form['guid'] !== 'string') throw new KtError(`food detail: unknown food id ${foodId}`);

    const rawUnits = Array.isArray(form['unitOptions']) ? form['unitOptions'] : [];
    const units: UnitOption[] = rawUnits
      .filter((u): u is Record<string, unknown> => !!u && typeof u === 'object')
      .map(u => ({
        id: String(u['id']),
        title: String(u['title']),
        grams: parseCzechNumber(u['multiplier']) ?? 0,
      }));
    // The site echoes back whatever guid is requested, even for foods that do
    // not exist, so the guid check above no longer catches bad ids. A real
    // food always offers at least its base unit; an empty list means the id
    // is unknown.
    if (units.length === 0) throw new KtError(`food detail: unknown food id ${foodId}`);

    return {
      id: form['guid'],
      title: String(form['title'] ?? ''),
      units,
      defaultUnitId: typeof form['unitGuid'] === 'string' ? form['unitGuid'] : GRAM_UNIT,
      defaultAmount: parseCzechNumber(form['multiplier']) ?? 100,
    };
  }

  /** Nutrition for a given quantity, scaled server-side by the site itself. */
  async getNutrition(foodId: string, amount: number, unitId: string): Promise<Nutrition> {
    const { text } = await this.request(
      `/foodstuff/detail/${encodeURIComponent(foodId)}/${amount}/${encodeURIComponent(unitId)}?format=json`,
    );
    const data = this.parseEnvelope(text, 'nutrition') as Record<string, unknown>;
    const food = data['foodstuff'];
    if (!food || typeof food !== 'object') throw new KtError('nutrition: response had no foodstuff block');
    const f = food as Record<string, unknown>;

    return {
      title: String(f['title'] ?? ''),
      energy: parseCzechNumber(f['energy']),
      energyUnit: typeof data['energyUnit'] === 'string' ? data['energyUnit'] : 'kcal',
      protein: parseCzechNumber(f['protein']),
      carbs: parseCzechNumber(f['carbohydrate']),
      fat: parseCzechNumber(f['fat']),
      sugar: parseCzechNumber(f['sugar']),
      fibre: parseCzechNumber(f['fiber']),
      saturatedFat: parseCzechNumber(f['saturatedFattyAcid']),
      salt: parseCzechNumber(f['salt']),
    };
  }

  /**
   * Creates a diary entry. We fetch the site's own form first and override only
   * the four fields that describe this portion, so any field we don't know
   * about keeps whatever value the site considers correct.
   *
   * The trailing `&=` is the site's (empty) CSRF token pair — its own frontend
   * appends it the same way.
   */
  async logFood(args: {
    foodId: string;
    amount: number;
    unitId?: string;
    meal: MealId;
    date?: string;
  }): Promise<void> {
    // Checked before anything is fetched or written: the site would silently
    // file 31.02. under 03.03. instead of refusing it.
    const date = args.date === undefined ? todayCzech() : assertCalendarDate(args.date);

    // Fetch the form with a session established, exactly as the site's own
    // frontend does: it carries user-specific fields (favourite, preferred
    // unit) that we must post back unchanged.
    const form = (await this.authed(
      `/foodstuff/detail/form/${encodeURIComponent(args.foodId)}?format=json&default=true`,
    )) as Record<string, unknown>;
    if (typeof form['guid'] !== 'string') throw new KtError(`log food: unknown food id ${args.foodId}`);

    // The site's own frontend posts the fetched form back whole, option
    // arrays included — deviate from that and the server may reject the write
    // ("Potravinu se nepodařilo zapsat do deníku").
    const payload: Record<string, unknown> = { ...form };
    payload['multiplier'] = args.amount;
    payload['unitGuid'] = args.unitId ?? form['unitGuid'] ?? GRAM_UNIT;
    payload['diaryTimeGuid'] = args.meal;
    payload['date'] = date;

    await this.authed('/user/foodstuff/add?format=json&=', { method: 'POST', body: payload });
  }

  /** Raw daily summary. Shape is not fully documented, so it is passed through. */
  async getDaySummary(date?: string): Promise<unknown> {
    return this.authed(`/statistic/summary/${date === undefined ? todayCzech() : assertCalendarDate(date)}/get?format=json`);
  }

  /**
   * The individual entries logged on one day, grouped by meal. Reads the same
   * endpoint the site's own diary page uses (`/user/diary/{date}/get`), which —
   * unlike the summary — lists every logged line with its quantity and
   * nutrients. Omit the date for today.
   */
  async getDayEntries(date?: string): Promise<DiaryDay> {
    const day = date === undefined ? todayCzech() : assertCalendarDate(date);
    const data = await this.authed(`/user/diary/${day}/get?format=json`);
    return parseDiaryDay(data, day);
  }

  /**
   * getDayEntries for every day from `from` to `to`, both included, one day at
   * a time. A day that fails to load is reported as such and the rest carry
   * on; a login failure aborts the whole range, since every remaining day
   * would only repeat it.
   */
  async getDiaryRange(from: string, to: string): Promise<DayOutcome[]> {
    const outcomes: DayOutcome[] = [];
    for (const date of enumerateDays(from, to)) {
      try {
        const day = await this.getDayEntries(date);
        outcomes.push({ date, status: day.entryCount === 0 ? 'empty' : 'filled', day });
      } catch (error) {
        if (error instanceof KtAuthError) throw error;
        outcomes.push({ date, status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcomes;
  }

  // ---------------------------------------------------------------------
  // Changing existing diary lines
  // ---------------------------------------------------------------------

  /** Finds one line on a day by its diary-line id. Throws when it is not there, so nothing is ever changed blind. */
  private async findEntry(date: string, entryId: string): Promise<{ meal: DiaryMeal; entry: DiaryEntry }> {
    const day = await this.getDayEntries(date);
    for (const meal of day.meals) {
      const entry = meal.entries.find(e => e.id === entryId);
      if (entry) return { meal, entry };
    }
    throw new KtError(`No diary entry with id ${entryId} on ${date}. Ids come from get_day_entries and belong to one day.`);
  }

  /**
   * Deletes one food or recipe line from a day. The line is looked up first
   * and the day re-read afterwards, so the caller learns what was removed and
   * whether it is really gone. The site deletes through a plain GET, taking
   * one or more comma-separated ids; only ever one is sent here.
   */
  async deleteDiaryEntry(args: { date: string; entryId: string }): Promise<EntryDeletion> {
    const date = assertCalendarDate(args.date);
    const id = assertEntryId(args.entryId);
    const { meal, entry } = await this.findEntry(date, id);

    const isGone = (day: DiaryDay) => !day.meals.some(m => m.entries.some(e => e.id === id));
    try {
      await this.authed(`/user/diary/foodstuff/delete/${id}?format=json`);
    } catch (error) {
      if (error instanceof KtAuthError) throw error;
      // The reply could not be read, but the delete may still have gone through.
      // Report failure only if the line is demonstrably still there; otherwise
      // the caller would retry and be told "no such entry".
      const gone = await this.getDayEntries(date).then(isGone, () => false);
      if (!gone) throw error;
    }

    // The delete has landed; a failed read-back must not become an error, or a retry would hit "no such entry".
    const confirmed = await this.getDayEntries(date).then(isGone, () => null);
    return { date, meal: meal.title, deleted: entry, confirmed };
  }

  /**
   * Changes the logged quantity of one food line. Works the way the site's own
   * edit dialog does: fetch that line's unit form, change `multiplier` (and
   * optionally the unit) and post the form back whole. Saved-recipe lines have
   * no such form — the site cannot change their amount — so they are refused.
   */
  async updateDiaryEntry(args: { date: string; entryId: string; amount: number; unitId?: string }): Promise<EntryChange> {
    const date = assertCalendarDate(args.date);
    const id = assertEntryId(args.entryId);
    if (!Number.isFinite(args.amount) || args.amount <= 0) throw new KtError('amount must be a positive number');

    const { meal, entry } = await this.findEntry(date, id);
    if (entry.kind === 'recipe') {
      throw new KtError(`"${entry.title}" was logged from a saved recipe, and the site cannot change the amount of such a line. Delete it and log it again instead.`);
    }

    const form = await this.authed(`/user/diary/foodstuff/unit/form/${id}?format=json`);
    if (!isRecord(form) || form['diaryGuid'] !== id || typeof form['unitGuid'] !== 'string' || !Array.isArray(form['unitOptions'])) {
      throw new KtError(`"${entry.title}": the site offers no way to change this line's quantity`);
    }
    const options = (form['unitOptions'] as unknown[]).filter(isRecord);
    const unitId = args.unitId ?? form['unitGuid'];
    if (!options.some(o => o['id'] === unitId)) {
      throw new KtError(
        `Unit ${unitId} is not valid for "${entry.title}". Available: ` +
          options.map(o => `${String(o['title'])} (${String(o['id'])})`).join(', '),
      );
    }

    await this.authed('/user/diary/foodstuff/unit/edit?format=json&=', {
      method: 'POST',
      body: { ...form, multiplier: args.amount, unitGuid: unitId },
    });

    // As with delete: the write has landed, so the read-back is best-effort.
    const after = await this.findEntry(date, id).then(
      found => found.entry,
      () => null,
    );
    return { date, meal: meal.title, before: entry, after };
  }

  // ---------------------------------------------------------------------
  // Meals (the site's word for a saved recipe)
  // ---------------------------------------------------------------------

  /** The user's saved recipes. */
  async listMeals(): Promise<MealSummary[]> {
    const data = await this.authed('/user/settings/meal/list?format=json&limit=100');
    if (!Array.isArray(data)) throw new KtError('meal list: expected an array');
    return data
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
      .map(m => ({
        id: String(m['guid']),
        title: String(m['title'] ?? ''),
        energy: parseCzechNumber(m['energy']),
        energyUnit: typeof m['energyUnit'] === 'string' ? m['energyUnit'] : 'kcal',
        portions: parseCzechNumber(m['portions']) ?? 1,
      }));
  }

  /**
   * Builds one ingredient entry for a recipe payload.
   *
   * The site expects each ingredient to carry its own full unit list, so we
   * fetch the food's form and copy it. `count` is a multiple of the chosen
   * unit, not a weight: 2 × "porce (250 ml)" is 500 ml. Defaulting to the
   * food's base unit (multiplier 1) makes `amount` mean grams for solids and
   * millilitres for liquids, which is what a recipe author expects.
   */
  private async buildMealItem(
    index: number,
    ingredient: { foodId: string; amount: number; unitId?: string },
  ): Promise<Record<string, unknown>> {
    const detail = await this.getFoodDetail(ingredient.foodId);
    const unitId = ingredient.unitId ?? baseUnitOf(detail.units);
    if (!detail.units.some(u => u.id === unitId)) {
      throw new KtError(
        `${detail.title}: unit ${unitId} is not valid for this food. Available: ` +
          detail.units.map(u => `${u.title} (${u.id})`).join(', '),
      );
    }
    return {
      selected: true,
      guid: String(index),
      foodstuffGuid: detail.id,
      title: detail.title,
      count: ingredient.amount,
      countOriginal: ingredient.amount,
      // Display-only; the site recomputes the recipe's energy server-side.
      energy: 0,
      energyUnit: 'kcal',
      selectedUnitGuid: unitId,
      selectedUnitGuidOriginal: unitId,
      units: detail.units.map(u => ({ id: u.id, title: u.title, multiplier: u.grams })),
      weight: null,
      time: null,
      favorite: null,
      isLiquid: null,
    };
  }

  /** Creates a saved recipe. Returns the new meal's id. */
  async createMeal(args: {
    title: string;
    ingredients: Array<{ foodId: string; amount: number; unitId?: string }>;
  }): Promise<string> {
    if (args.ingredients.length === 0) throw new KtError('a recipe needs at least one ingredient');

    const foodstuff = [];
    for (const [i, ingredient] of args.ingredients.entries()) {
      foodstuff.push(await this.buildMealItem(i, ingredient));
    }

    const created = await this.authed('/user/meal/create?format=json&=', {
      method: 'POST',
      body: {
        guid: null,
        title: args.title,
        diaryTimeGuid: null,
        diaryTimeOptions: null,
        date: null,
        timeUser: null,
        time: null,
        foodstuff,
      },
    });
    if (typeof created !== 'string') throw new KtError('meal create: no id returned');
    return created;
  }

  /**
   * Logs a whole saved recipe into the diary.
   *
   * Partial portions are deliberately not offered. The meal-add form exposes
   * `count` against portion/percent/gram pseudo-units, but the server ignores
   * it and logs the entire recipe whichever unit is used — measured against a
   * 249 kcal recipe, `count` of 0.5 portions and of half the total weight both
   * added the full 249. Rather than accept a `portions` argument that silently
   * does nothing, log the whole recipe and let the caller log ingredients
   * individually when they ate part of one.
   */
  async logMeal(args: { mealId: string; meal: MealId; date?: string }): Promise<void> {
    const date = args.date === undefined ? todayCzech() : assertCalendarDate(args.date);
    const form = (await this.authed(
      `/user/meal/add/form/${encodeURIComponent(args.mealId)}?format=json`,
    )) as Record<string, unknown>;

    // As in logFood: post the form back whole, as the site's frontend does.
    const payload: Record<string, unknown> = { ...form };
    payload['diaryTimeGuid'] = args.meal;
    payload['date'] = date;
    payload['selectedUnitGuid'] = PORTION_UNIT;
    payload['count'] = 1;

    await this.authed('/user/meal/add?format=json&=', { method: 'POST', body: payload });
  }

  /** Permanently deletes a saved recipe. */
  async deleteMeal(mealId: string): Promise<void> {
    await this.authed(`/user/settings/meal/delete/${encodeURIComponent(mealId)}?format=json`);
  }
}
