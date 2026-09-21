import { assertBBox, coversArea, isBBox, parseGeometry } from './geo';
import type { AreaGeometry, BBox } from './geo';

export type { BBox } from './geo';
export const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1';

export interface Scene {
  id: string;
  bbox: BBox;
  geometry: AreaGeometry;
  properties: {
    datetime: string;
    'eo:cloud_cover': number;
    platform?: string;
  };
  assets: {
    tilejson: { href: string };
  };
}

export interface TileJSON {
  tiles: [string, ...string[]];
}

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
}

const INVALID_RESPONSE = 'Источник снимков вернул некорректные данные. Повторите поиск.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function dateOf(scene: Scene): string {
  return scene.properties.datetime;
}

export function cloudOf(scene: Scene): number {
  return scene.properties['eo:cloud_cover'];
}

export function safeTileURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Источник вернул неподдерживаемый адрес снимка.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'planetarycomputer.microsoft.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('Источник вернул неподдерживаемый адрес снимка.');
  }
  // Return the original string: URL serialization would escape tile placeholders.
  return value;
}

/** Fetch unknown JSON; the endpoint-specific parser must validate its shape. */
export async function fetchJSON(url: string, options: FetchOptions = {}): Promise<unknown> {
  const { timeoutMs = 30_000, signal, ...requestOptions } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('Некорректное время ожидания источника снимков.');
  }
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...requestOptions, signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `Источник снимков временно недоступен (${response.status}). Повторите поиск.`,
      );
    }
    const result: unknown = await response.json();
    return result;
  } catch (error: unknown) {
    if (timedOut) {
      throw new Error('Источник долго отвечает. Повторите поиск через несколько секунд.');
    }
    if (controller.signal.aborted) {
      throw new DOMException('Загрузка снимков отменена.', 'AbortError');
    }
    if (error instanceof SyntaxError) throw new Error(INVALID_RESPONSE);
    if (error instanceof TypeError) {
      throw new Error(
        'Не удалось связаться с источником снимков. Проверьте интернет и повторите поиск.',
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function parseScene(value: unknown): Scene | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.trim() === '' ||
    !isBBox(value.bbox) ||
    !isRecord(value.properties) ||
    !isRecord(value.assets) ||
    !isRecord(value.assets.tilejson) ||
    typeof value.assets.tilejson.href !== 'string'
  )
    return null;
  const datetime = value.properties.datetime;
  const cloudCover = value.properties['eo:cloud_cover'];
  if (
    typeof datetime !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/.test(datetime) ||
    !Number.isFinite(Date.parse(datetime)) ||
    typeof cloudCover !== 'number' ||
    !Number.isFinite(cloudCover) ||
    cloudCover < 0 ||
    cloudCover > 100
  )
    return null;
  const geometry = parseGeometry(value.geometry);
  if (!geometry) return null;
  let href: string;
  try {
    href = safeTileURL(value.assets.tilejson.href);
  } catch {
    return null;
  }
  const properties: Scene['properties'] = { datetime, 'eo:cloud_cover': cloudCover };
  if (typeof value.properties.platform === 'string')
    properties.platform = value.properties.platform;
  return {
    id: value.id,
    bbox: [...value.bbox],
    geometry,
    properties,
    assets: { tilejson: { href } },
  };
}

export async function findScenes(
  year: number,
  bbox: BBox,
  options: FetchOptions = {},
): Promise<Scene[]> {
  assertBBox(bbox);
  if (!Number.isInteger(year) || year < 2015 || year > new Date().getUTCFullYear()) {
    throw new Error('Выберите корректный год съёмки.');
  }
  const start = `${year}-06-01T00:00:00Z`;
  const end = `${year}-08-31T23:59:59Z`;
  const result = await fetchJSON(`${STAC}/search`, {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: ['sentinel-2-l2a'],
      bbox,
      datetime: `${start}/${end}`,
      query: { 'eo:cloud_cover': { lt: 30 } },
      sortby: [{ field: 'properties.eo:cloud_cover', direction: 'asc' }],
      limit: 100,
    }),
  });
  if (!isRecord(result) || !Array.isArray(result.features)) throw new Error(INVALID_RESPONSE);
  const unique = new Map<string, Scene>();
  let validScenes = 0;
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  for (const value of result.features) {
    const scene = parseScene(value);
    if (!scene) continue;
    validScenes += 1;
    const timestamp = Date.parse(dateOf(scene));
    if (
      timestamp < startTime ||
      timestamp > endTime ||
      cloudOf(scene) >= 30 ||
      !coversArea(scene, bbox)
    )
      continue;
    const day = new Date(timestamp).toISOString().slice(0, 10);
    const existing = unique.get(day);
    if (!existing || cloudOf(scene) < cloudOf(existing)) unique.set(day, scene);
  }
  if (result.features.length > 0 && validScenes === 0) throw new Error(INVALID_RESPONSE);
  return [...unique.values()].sort((first, second) => cloudOf(first) - cloudOf(second));
}

/** Favor low cloud cover and similar summer dates across the two years. */
export function bestPair(before: readonly Scene[], after: readonly Scene[]): [Scene, Scene] {
  const first = before[0];
  const second = after[0];
  if (!first || !second) throw new Error('Для сравнения нужны снимки за оба периода.');
  let best: [Scene, Scene] = [first, second];
  let score = Number.POSITIVE_INFINITY;
  const day = (scene: Scene): number => {
    const date = new Date(dateOf(scene));
    return Date.UTC(2000, date.getUTCMonth(), date.getUTCDate()) / 86_400_000;
  };
  for (const left of before) {
    for (const right of after) {
      const candidateScore =
        cloudOf(left) + cloudOf(right) + Math.abs(day(left) - day(right)) * 0.15;
      if (candidateScore < score) {
        score = candidateScore;
        best = [left, right];
      }
    }
  }
  return best;
}

export async function fetchTileJSON(scene: Scene, options: FetchOptions = {}): Promise<TileJSON> {
  const result = await fetchJSON(safeTileURL(scene.assets.tilejson.href), options);
  if (!isRecord(result) || !Array.isArray(result.tiles) || result.tiles.length === 0) {
    throw new Error('У снимка нет доступных изображений. Выберите другую дату.');
  }
  const tiles: string[] = [];
  for (const tile of result.tiles) {
    if (typeof tile !== 'string') throw new Error(INVALID_RESPONSE);
    tiles.push(safeTileURL(tile));
  }
  const first = tiles[0];
  if (!first) throw new Error(INVALID_RESPONSE);
  return { tiles: [first, ...tiles.slice(1)] };
}
