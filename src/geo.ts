/** Geographic bounds in west, south, east, north order (WGS 84). */
export type BBox = [number, number, number, number];
export type Position = [number, number];
export type Ring = Position[];

export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: Ring[];
}

export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: Ring[][];
}

export type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;

export const DEFAULT_BBOX: BBox = [76.965, 52.276, 77.025, 52.314];
export const CITY_BBOX: BBox = [76.65, 52.1, 77.45, 52.6];

export function isBBox(value: unknown): value is BBox {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const [west, south, east, north]: unknown[] = value;
  return (
    typeof west === 'number' &&
    Number.isFinite(west) &&
    typeof south === 'number' &&
    Number.isFinite(south) &&
    typeof east === 'number' &&
    Number.isFinite(east) &&
    typeof north === 'number' &&
    Number.isFinite(north) &&
    west >= -180 &&
    east <= 180 &&
    south >= -90 &&
    north <= 90 &&
    west < east &&
    south < north
  );
}

export function assertBBox(value: unknown): asserts value is BBox {
  if (!isBBox(value)) throw new Error('Укажите корректные границы области.');
}

export function boundsOf(bbox: BBox): [[number, number], [number, number]] {
  return [
    [bbox[1], bbox[0]],
    [bbox[3], bbox[2]],
  ];
}

export function areaKm2(bbox: BBox): number {
  assertBBox(bbox);
  const radians = Math.PI / 180;
  return (
    6371.0088 ** 2 *
    Math.abs(Math.sin(bbox[3] * radians) - Math.sin(bbox[1] * radians)) *
    (bbox[2] - bbox[0]) *
    radians
  );
}

export function validateArea(value: unknown): asserts value is BBox {
  assertBBox(value);
  if (
    value[0] < CITY_BBOX[0] ||
    value[1] < CITY_BBOX[1] ||
    value[2] > CITY_BBOX[2] ||
    value[3] > CITY_BBOX[3]
  ) {
    throw new Error('В пилотной версии выберите область в Павлодаре и ближайших окрестностях.');
  }
  const area = areaKm2(value);
  if (area > 150) {
    throw new Error('Выберите область меньше 150 км², чтобы рассмотреть изменения.');
  }
  if (area < 0.01) {
    throw new Error('Область слишком мала для снимков 10 м. Выберите хотя бы 1 гектар.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRing(value: unknown): Ring | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const ring: Ring = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) return null;
    const longitude: unknown = entry[0];
    const latitude: unknown = entry[1];
    if (
      typeof longitude !== 'number' ||
      !Number.isFinite(longitude) ||
      typeof latitude !== 'number' ||
      !Number.isFinite(latitude) ||
      longitude < -180 ||
      longitude > 180 ||
      latitude < -90 ||
      latitude > 90
    ) {
      return null;
    }
    ring.push([longitude, latitude]);
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) return null;
  return ring;
}

function parsePolygon(value: unknown): Ring[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rings: Ring[] = [];
  for (const entry of value) {
    const ring = parseRing(entry);
    if (!ring) return null;
    rings.push(ring);
  }
  return rings;
}

/** Read and copy only the GeoJSON coordinates needed for footprint coverage. */
export function parseGeometry(value: unknown): AreaGeometry | null {
  if (!isRecord(value)) return null;
  if (value.type === 'Polygon') {
    const coordinates = parsePolygon(value.coordinates);
    return coordinates ? { type: 'Polygon', coordinates } : null;
  }
  if (
    value.type !== 'MultiPolygon' ||
    !Array.isArray(value.coordinates) ||
    value.coordinates.length === 0
  )
    return null;
  const coordinates: Ring[][] = [];
  for (const entry of value.coordinates) {
    const polygon = parsePolygon(entry);
    if (!polygon) return null;
    coordinates.push(polygon);
  }
  return { type: 'MultiPolygon', coordinates };
}

/** -1 outside, 0 on the boundary, 1 inside. */
function pointLocation(point: Position, ring: Ring): -1 | 0 | 1 {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const current = ring[i];
    const previous = ring[j];
    if (!current || !previous) return -1;
    const [xi, yi] = current;
    const [xj, yj] = previous;
    const cross = (point[0] - xi) * (yj - yi) - (point[1] - yi) * (xj - xi);
    // A zero-length closing edge must only contain its one endpoint.
    if (
      Math.abs(cross) <= 1e-12 &&
      point[0] >= Math.min(xi, xj) &&
      point[0] <= Math.max(xi, xj) &&
      point[1] >= Math.min(yi, yj) &&
      point[1] <= Math.max(yi, yj)
    )
      return 0;
    if (
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside ? 1 : -1;
}

export function pointInRing(point: Position, ring: Ring): boolean {
  return pointLocation(point, ring) !== -1;
}

/** Whether a nonempty part of an edge enters the open bounding rectangle. */
function edgeEntersArea(start: Position, end: Position, bbox: BBox): boolean {
  let from = 0;
  let to = 1;
  const axes: [number, number, number, number][] = [
    [start[0], end[0] - start[0], bbox[0], bbox[2]],
    [start[1], end[1] - start[1], bbox[1], bbox[3]],
  ];
  for (const [origin, delta, lower, upper] of axes) {
    if (delta === 0) {
      if (origin <= lower || origin >= upper) return false;
      continue;
    }
    const first = (lower - origin) / delta;
    const second = (upper - origin) / delta;
    from = Math.max(from, Math.min(first, second));
    to = Math.min(to, Math.max(first, second));
    if (from >= to) return false;
  }
  return from < to;
}

function ringEntersArea(ring: Ring, bbox: BBox): boolean {
  for (let i = 1; i < ring.length; i += 1) {
    const start = ring[i - 1];
    const end = ring[i];
    if (start && end && edgeEntersArea(start, end, bbox)) return true;
  }
  return false;
}

/** Require one footprint polygon to cover the complete area, including holes. */
export function coversArea(feature: { geometry: AreaGeometry }, bbox: BBox): boolean {
  const polygons =
    feature.geometry.type === 'Polygon'
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
  const points: Position[] = [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[2], bbox[3]],
    [bbox[0], bbox[3]],
    [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
  ];
  return polygons.some(([outer, ...holes]) => {
    if (
      !outer ||
      !points.every((point) => pointInRing(point, outer)) ||
      ringEntersArea(outer, bbox)
    )
      return false;
    return holes.every(
      (hole) =>
        !points.some((point) => pointLocation(point, hole) === 1) && !ringEntersArea(hole, bbox),
    );
  });
}
