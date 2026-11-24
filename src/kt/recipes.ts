/**
 * The site's public recipe catalogue (`/recepty`): search and detail. These are
 * recipes written by other users, not the user's own saved meals (those are
 * `list_my_meals` / `get_meal_details`).
 */

import { KtError, isRecord, parseCzechNumber } from './util.js';

const RECIPE_ID = /^[0-9a-f]{32}$/;

/** Ids end up in a URL path, so accept nothing but the site's 32-character hex ids. */
export function assertRecipeId(id: string): string {
  if (!RECIPE_ID.test(id)) throw new KtError(`Invalid recipe id "${id}" — use an id from search_recipes`);
  return id;
}

export const RECIPE_SORTS = ['newest', 'best_rated', 'most_used'] as const;
export type RecipeSort = (typeof RECIPE_SORTS)[number];
export const RECIPE_SORT_CODES: Record<RecipeSort, string> = { newest: 'created', best_rated: 'rating', most_used: 'preference' };

export const RECIPE_FILTER_NUTRIENTS = ['energy', 'protein', 'carbohydrate', 'fat', 'fibre'] as const;
export type RecipeFilterNutrient = (typeof RECIPE_FILTER_NUTRIENTS)[number];
export const RECIPE_FILTER_CODES: Record<RecipeFilterNutrient, number> = { energy: 0, protein: 1, carbohydrate: 2, fat: 3, fibre: 4 };

export const PREPARATION_MINUTES = [15, 30, 45, 60, 70] as const;

export interface RecipeHit {
  id: string;
  title: string;
  link: string | null;
  /** Per 100 g of the finished recipe — this is what the site's list shows. */
  per100g: { energy: number | null; energyUnit: string; protein: number | null; carbohydrate: number | null; fat: number | null; fibre: number | null };
  rating: number | null;
  author: string | null;
}

export interface RecipeSearchResult {
  /** How many recipes match in total, over all pages. */
  total: number;
  recipes: RecipeHit[];
}

/** "88,9 kcal" → 88.9 and "kcal". */
export function parseEnergyText(raw: unknown): { value: number | null; unit: string } {
  if (typeof raw === 'number') return { value: Number.isFinite(raw) ? raw : null, unit: 'kcal' };
  if (typeof raw !== 'string') return { value: null, unit: 'kcal' };
  const m = /^\s*([\d\s  ]+(?:,\d+)?)\s*(kcal|kJ)?\s*$/i.exec(raw);
  return m ? { value: parseCzechNumber(m[1]), unit: m[2] ?? 'kcal' } : { value: null, unit: 'kcal' };
}

export function parseRecipeSearch(text: string): RecipeSearchResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new KtError(`recipe search: expected JSON, got ${text.slice(0, 120)}`);
  }
  if (isRecord(body) && typeof body['code'] === 'number' && body['code'] !== 0) {
    throw new KtError(`recipe search: ${typeof body['message'] === 'string' ? body['message'] : `code ${body['code']}`}`);
  }
  if (!isRecord(body) || !Array.isArray(body['data'])) throw new KtError('recipe search: response has no list of recipes');
  const total = parseCzechNumber(body['count']);
  if (total === null) throw new KtError('recipe search: response has no total count');
  const recipes = (body['data'] as unknown[]).map(raw => {
    if (!isRecord(raw) || typeof raw['id'] !== 'string' || typeof raw['title'] !== 'string') throw new KtError('recipe search: a recipe has no id or title');
    const energy = parseEnergyText(raw['energy']);
    return {
      id: raw['id'],
      title: raw['title'],
      link: typeof raw['url'] === 'string' ? `https://www.kaloricketabulky.cz/recepty/${encodeURIComponent(raw['url'])}` : null,
      per100g: {
        energy: energy.value,
        energyUnit: energy.unit,
        protein: parseCzechNumber(raw['protein']),
        carbohydrate: parseCzechNumber(raw['carbohydrate']),
        fat: parseCzechNumber(raw['fat']),
        fibre: parseCzechNumber(raw['fiber']),
      },
      rating: parseCzechNumber(raw['rating']),
      author: isRecord(raw['author']) && typeof raw['author']['nickname'] === 'string' ? raw['author']['nickname'] : null,
    };
  });
  return { total, recipes };
}

export interface RecipeDetail {
  id: string;
  title: string;
  link: string | null;
  energyUnit: string;
  /** Whole recipe, not one portion. */
  total: { energy: number | null; protein: number | null; carbohydrate: number | null; fat: number | null; fibre: number | null; sugar: number | null; saturatedFat: number | null; salt: number | null };
  totalWeightG: number | null;
  /** How many portions the author divides it into; null when the author gave none. */
  portions: number | null;
  ingredients: Array<{ title: string; amount: string | null; foodId: string | null }>;
  steps: string[];
  tags: string[];
  preparationMinutes: number | null;
  rating: number | null;
  ratingCount: number | null;
  author: string | null;
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export function parseRecipeDetail(data: unknown): RecipeDetail {
  if (!isRecord(data) || typeof data['id'] !== 'string' || typeof data['title'] !== 'string') throw new KtError('recipe detail: unknown recipe');
  const num = (k: string) => parseCzechNumber(data[k]);
  const content = Array.isArray(data['content']) ? (data['content'] as unknown[]) : null;
  if (content === null) throw new KtError('recipe detail: response has no ingredient list');
  const ingredients = content.map(raw => {
    const food = isRecord(raw) ? raw['foodstuff'] : null;
    if (!isRecord(raw) || !isRecord(food) || typeof food['title'] !== 'string') throw new KtError('recipe detail: an ingredient is malformed');
    return {
      title: food['title'],
      amount: typeof raw['unit'] === 'string' ? raw['unit'] : null,
      foodId: typeof food['id'] === 'string' ? food['id'] : null,
    };
  });
  const steps = Array.isArray(data['description']) ? (data['description'] as unknown[]).filter((s): s is string => typeof s === 'string').map(stripTags).filter(Boolean) : [];
  const tags = Array.isArray(data['tags'])
    ? (data['tags'] as unknown[]).flatMap(t => (isRecord(t) && typeof t['title'] === 'string' ? [t['title']] : []))
    : [];
  const portions = num('portions');
  return {
    id: data['id'],
    title: data['title'],
    link: typeof data['link'] === 'string' ? data['link'] : null,
    energyUnit: typeof data['energyUnit'] === 'string' ? data['energyUnit'] : 'kcal',
    total: {
      energy: num('energy'),
      protein: num('protein'),
      carbohydrate: num('carbohydrate'),
      fat: num('fat'),
      fibre: num('fiber'),
      sugar: num('sugar'),
      saturatedFat: num('saturatedFattyAcid'),
      salt: num('salt'),
    },
    totalWeightG: num('totalWeight'),
    portions: portions !== null && portions > 0 ? portions : null,
    ingredients,
    steps,
    tags,
    preparationMinutes: num('preparationTime'),
    rating: num('rating'),
    ratingCount: num('ratingCount'),
    author: isRecord(data['author']) && typeof data['author']['nickname'] === 'string' ? data['author']['nickname'] : null,
  };
}

/** Tag ids for the recipe filter: the site wants the tags' url slugs joined by "-". */
export interface RecipeTag {
  title: string;
  slug: string;
}

export function parseRecipeTags(data: unknown): RecipeTag[] {
  if (!Array.isArray(data)) throw new KtError('recipe tags: expected a list');
  return (data as unknown[]).map(raw => {
    if (!isRecord(raw) || typeof raw['title'] !== 'string' || typeof raw['url'] !== 'string') throw new KtError('recipe tags: a tag has no title or url');
    return { title: raw['title'], slug: raw['url'] };
  });
}
