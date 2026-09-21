/** Public Esri World Imagery endpoints; no API key is required. */
export const WORLD_IMAGERY_MAPSERVER_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';

export const WORLD_IMAGERY_TILE_URL = `${WORLD_IMAGERY_MAPSERVER_URL}/tile/{z}/{y}/{x}`;

export const WORLD_IMAGERY_ATTRIBUTION =
  'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, Vantor, Earthstar Geographics, and the GIS User Community';

/** Describes only the queried center point at the requested tile zoom. */
export interface ImageryMetadata {
  /** Source acquisition date, in YYYY-MM-DD format; not the publication date. */
  date: string | null;
  sourceResolutionM: number | null;
  /** Sampling resolution of the imagery; distinct from its source resolution. */
  sampleResolutionM: number | null;
  provider: string;
  metadataUrl: string;
  sourceLayerId: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function acquisitionDate(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const compact = String(value);
  if (!/^\d{8}$/.test(compact)) return null;
  const year = Number(compact.slice(0, 4));
  const month = Number(compact.slice(4, 6));
  const day = Number(compact.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function providerName(attributes: Record<string, unknown>): string {
  for (const field of ['NICE_DESC', 'NICE_NAME', 'SRC_DESC']) {
    const value = attributes[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return 'Esri World Imagery';
}

/**
 * Query one resolution metadata layer for the map center. The service's scale
 * bands map z17 to layer 11, z18 to 10, z19 to 9, and so on. A coarser layer can
 * describe a different image, so unavailable metadata is never filled from it.
 * Network failures/timeouts return null; caller cancellation rejects AbortError.
 */
export async function fetchDetailMetadata(
  lng: number,
  lat: number,
  zoom: number,
  signal?: AbortSignal,
): Promise<ImageryMetadata | null> {
  signal?.throwIfAborted();
  if (
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(zoom) ||
    lat < -85.051129 ||
    lat > 85.051129 ||
    zoom < 0
  ) {
    return null;
  }

  const tileZoom = Math.round(zoom);
  const layerId = Math.max(5, Math.min(18, 28 - tileZoom));
  const longitude = ((((lng + 180) % 360) + 360) % 360) - 180;
  const parameters = new URLSearchParams({
    f: 'json',
    geometry: `${longitude},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'SRC_DATE,SRC_RES,SAMP_RES,NICE_DESC,NICE_NAME,SRC_DESC,MinMapLevel,MaxMapLevel',
    returnGeometry: 'false',
  });
  const metadataUrl = `${WORLD_IMAGERY_MAPSERVER_URL}/${layerId}/query?${parameters}`;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(metadataUrl, { signal: controller.signal });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    signal?.throwIfAborted();
    if (
      !isRecord(payload) ||
      'error' in payload ||
      payload.exceededTransferLimit === true ||
      !Array.isArray(payload.features)
    ) {
      return null;
    }

    const candidates: ImageryMetadata[] = [];
    for (const feature of payload.features) {
      if (!isRecord(feature) || !isRecord(feature.attributes)) continue;
      const attributes = feature.attributes;
      const minZoom = finiteNumber(attributes.MinMapLevel);
      const maxZoom = finiteNumber(attributes.MaxMapLevel);
      if (minZoom === null || maxZoom === null || tileZoom < minZoom || tileZoom > maxZoom) {
        continue;
      }
      candidates.push({
        date: acquisitionDate(attributes.SRC_DATE),
        sourceResolutionM: positiveNumber(attributes.SRC_RES),
        sampleResolutionM: positiveNumber(attributes.SAMP_RES),
        provider: providerName(attributes),
        metadataUrl,
        sourceLayerId: layerId,
      });
    }

    const first = candidates[0];
    if (!first) return null;
    // At overlapping footprint boundaries, conflicting records are ambiguous.
    if (
      candidates.some(
        (item) =>
          item.date !== first.date ||
          item.sourceResolutionM !== first.sourceResolutionM ||
          item.sampleResolutionM !== first.sampleResolutionM ||
          item.provider !== first.provider,
      )
    ) {
      return null;
    }
    return first;
  } catch {
    if (signal?.aborted) {
      throw new DOMException('Imagery metadata request cancelled', 'AbortError');
    }
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
