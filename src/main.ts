import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import {
  WORLD_IMAGERY_TILE_URL,
  WORLD_IMAGERY_ATTRIBUTION,
  fetchDetailMetadata,
  type ImageryMetadata,
} from './detail-imagery';
import { DEFAULT_BBOX, boundsOf, areaKm2, validateArea, type BBox } from './geo';
import {
  STAC,
  dateOf,
  cloudOf,
  findScenes,
  bestPair,
  safeTileURL,
  fetchTileJSON,
  type Scene,
} from './satellite';

type Side = 0 | 1;
type MapMode = 'detail' | 'map' | 'compare';
type Pair<T> = [T, T];
interface AppState {
  bbox: BBox;
  scenes: Pair<Scene[]>;
  selected: Pair<Scene | null>;
  layers: Pair<L.TileLayer | null>;
  mode: MapMode;
  busy: boolean;
  drawing: boolean;
  firstCorner: L.LatLng | null;
  revision: number;
  renderRevision: number;
  tileErrors: number;
}
interface TileLoadResult {
  successes: number;
  errors: number;
  timeout?: boolean;
}
function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error('Missing interface element: ' + selector);
  return element;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось загрузить снимки. Повторите поиск.';
}
const number = (n: number, d = 1) => n.toLocaleString('ru-RU', { maximumFractionDigits: d });
const dateLabel = (d: string) =>
  new Date(d).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
const shortDate = (d: string) => new Date(d).toLocaleDateString('ru-RU', { timeZone: 'UTC' });
function requireSelectedPair(): Pair<Scene> {
  const [before, after] = state.selected;
  if (!before || !after) throw new Error('Сначала выберите два снимка.');
  return [before, after];
}
function getPane(name: string): HTMLElement {
  const pane = map.getPane(name);
  if (!pane) throw new Error('Unknown map pane: ' + name);
  return pane;
}
const state: AppState = {
  bbox: [...DEFAULT_BBOX],
  scenes: [[], []],
  selected: [null, null],
  layers: [null, null],
  mode: 'detail',
  busy: false,
  drawing: false,
  firstCorner: null,
  revision: 0,
  renderRevision: 0,
  tileErrors: 0,
};
const map = L.map('map', { zoomControl: false, minZoom: 10, maxZoom: 19 }).setView(
  [52.295, 76.995],
  13,
);
L.control.zoom({ position: 'topright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
const baseLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution:
    '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
});
// World Imagery has no native tiles above z17 in the verified Pavlodar area.
// Higher zooms enlarge existing tiles instead of displaying its no-data images.
const DETAIL_NATIVE_ZOOM = 17;
const detailPane = map.createPane('detailImagery');
detailPane.style.zIndex = '250';
const detailLayer = L.tileLayer(WORLD_IMAGERY_TILE_URL, {
  pane: 'detailImagery',
  maxNativeZoom: DETAIL_NATIVE_ZOOM,
  maxZoom: 19,
  minZoom: 10,
  keepBuffer: 1,
  attribution: WORLD_IMAGERY_ATTRIBUTION,
});
const afterPane = map.createPane('satelliteAfter');
afterPane.style.zIndex = '300';
const beforePane = map.createPane('satelliteBefore');
beforePane.style.zIndex = '310';
const boundary = L.rectangle(boundsOf(state.bbox), {
  color: '#426495',
  weight: 2,
  fillOpacity: 0.03,
  interactive: false,
}).addTo(map);
let draft: L.Rectangle | null = null;
let marker: L.CircleMarker | null = null;
let metadataController: AbortController | null = null;
let metadataViewKey: string | null = null;
let metadataTimer: ReturnType<typeof setTimeout> | undefined;
let detailLoadTimer: ReturnType<typeof setTimeout> | undefined;
let detailLoadErrors = 0;
let detailLoadSuccesses = 0;
const metadataCache = new Map<string, ImageryMetadata>();
const fitArea = () => map.fitBounds(boundsOf(state.bbox), { padding: [45, 45], maxZoom: 15 });
fitArea();
function status(message: string, error = false) {
  $('#search-status').textContent = message;
  $('#search-status').classList.toggle('error', error);
}
function loading(message: string | null) {
  $('#map-loading').hidden = !message;
  $('#map-loading-text').textContent = message || '';
}
function updateArea() {
  const b = state.bbox;
  $('#area-size').textContent = number(areaKm2(b), 2) + ' км²';
  $('.heading-note span').textContent =
    number((b[1] + b[3]) / 2, 3) + '° N  ' + number((b[0] + b[2]) / 2, 3) + '° E';
}
updateArea();
const now = new Date();
const latestSummer = now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
for (const [selector, value] of [
  ['#year-before', 2020],
  ['#year-after', latestSummer],
] as const) {
  const select = $<HTMLSelectElement>(selector);
  select.replaceChildren();
  for (let y = 2018; y <= latestSummer; y++)
    select.add(new Option(String(y), String(y), false, y === value));
  select.onchange = () =>
    status('Период изменён. Нажмите «Найти снимки», чтобы обновить сравнение.');
}
function fillCard(i: Side) {
  const p = i ? 'after' : 'before',
    f = state.selected[i],
    select = $<HTMLSelectElement>('#' + p + '-scene');
  select.replaceChildren();
  if (!f) {
    $('#' + p + '-date').textContent =
      'Лето ' + $<HTMLSelectElement>(i ? '#year-after' : '#year-before').value;
    select.add(new Option('Нет выбранного снимка', ''));
    select.disabled = true;
    $('#' + p + '-meta').textContent = 'Найдите снимки для этой территории';
    $<HTMLAnchorElement>('#' + p + '-source').hidden = true;
    return;
  }
  for (const s of [...state.scenes[i]].sort((a, b) => dateOf(a).localeCompare(dateOf(b))))
    select.add(
      new Option(
        shortDate(dateOf(s)) + ' · облачность ' + number(cloudOf(s), 2) + '%',
        s.id,
        false,
        s.id === f.id,
      ),
    );
  select.disabled = state.busy;
  $('#' + p + '-date').textContent = dateLabel(dateOf(f));
  $('#' + p + '-meta').textContent =
    'Облачность всей сцены ' +
    number(cloudOf(f), 2) +
    '% · ' +
    (f.properties.platform || 'Sentinel-2').toUpperCase() +
    ' · 10 м';
  const link = $<HTMLAnchorElement>('#' + p + '-source');
  link.href = STAC + '/collections/sentinel-2-l2a/items/' + encodeURIComponent(f.id);
  link.hidden = false;
}
function setBusy(busy: boolean) {
  state.busy = busy;
  for (const s of [
    '#search-scenes',
    '#year-before',
    '#year-after',
    '#draw-area',
    '#reset-area',
    '#mode-detail',
    '#mode-map',
    '#mode-compare',
    '#zoom-detail',
  ])
    $<HTMLButtonElement | HTMLSelectElement>(s).disabled = busy;
  for (const p of ['before', 'after'])
    $<HTMLSelectElement>('#' + p + '-scene').disabled =
      busy || !state.selected[p === 'before' ? 0 : 1];
  $('#search-scenes').firstChild!.textContent = busy ? 'Ищем снимки… ' : 'Найти снимки ';
}
function clearLayers() {
  state.renderRevision++;
  for (const layer of state.layers) if (layer) map.removeLayer(layer);
  state.layers = [null, null];
}
function clearComparison() {
  clearLayers();
  state.scenes = [[], []];
  state.selected = [null, null];
  fillCard(0);
  fillCard(1);
  setMode(state.mode === 'compare' ? 'detail' : state.mode);
  $('#scene-count').textContent = 'Два периода · один участок';
}
function updateClip() {
  const size = map.getSize(),
    top = map.containerPointToLayerPoint([0, 0]),
    split = map.containerPointToLayerPoint([
      (size.x * Number($<HTMLInputElement>('#swipe').value)) / 100,
      size.y,
    ]);
  beforePane.style.clip =
    'rect(' + top.y + 'px, ' + split.x + 'px, ' + split.y + 'px, ' + top.x + 'px)';
  $('#swipe-divider').style.left = $<HTMLInputElement>('#swipe').value + '%';
}
function setMode(mode: MapMode) {
  if (mode === 'compare' && !state.layers.every(Boolean)) return;
  state.mode = mode;
  const compare = mode === 'compare';
  const detailed = mode === 'detail';
  map.setMaxZoom(compare ? 18 : 19);
  if (mode === 'map') baseLayer.addTo(map);
  else map.removeLayer(baseLayer);
  if (detailed) detailLayer.addTo(map);
  else {
    map.removeLayer(detailLayer);
    clearTimeout(detailLoadTimer);
    clearMetadata();
  }
  for (const layer of state.layers) {
    if (!layer) continue;
    if (compare) layer.addTo(map);
    else map.removeLayer(layer);
  }
  for (const pane of ['satelliteBefore', 'satelliteAfter'])
    getPane(pane).style.display = compare ? '' : 'none';
  for (const s of ['#before-label', '#after-label', '#swipe-divider', '#swipe-control'])
    $(s).hidden = !compare;
  $('#detail-info').hidden = !detailed;
  $('#center-mark').hidden = !detailed;
  $('#zoom-detail').hidden = !detailed;
  if (!detailed) $('#detail-notice').hidden = true;
  for (const [id, active] of [
    ['#mode-detail', detailed],
    ['#mode-map', mode === 'map'],
    ['#mode-compare', compare],
  ] as const) {
    $(id).classList.toggle('active', active);
    $(id).setAttribute('aria-pressed', String(active));
  }
  boundary.setStyle({
    color: mode === 'map' ? '#426495' : '#fff',
    weight: 2,
    fillOpacity: mode === 'map' ? 0.03 : 0,
    dashArray: mode === 'map' ? '' : '6 5',
  });
  $('#map-caption-text').textContent = compare
    ? 'Sentinel-2 · исследуемая область'
    : detailed
      ? 'World Imagery · подробная подложка'
      : 'OpenStreetMap · исследуемая область';
  $('#active-source').textContent = compare
    ? 'Sentinel-2'
    : detailed
      ? 'World Imagery'
      : 'OpenStreetMap';
  $('#active-source-note').textContent = compare
    ? 'Снимки по годам · 10 м / пиксель'
    : detailed
      ? 'Подробная спутниковая подложка'
      : 'Улицы и ориентиры';
  updateMapSummary();
  if (detailed) scheduleMetadata();
  updateClip();
}
function updateMapSummary() {
  if (state.mode === 'detail') {
    $('#map-summary').textContent = 'Подробная подложка · выбранные годы относятся к «Истории»';
    $('#map-resolution').textContent =
      map.getZoom() > DETAIL_NATIVE_ZOOM
        ? 'Увеличение исходной подложки'
        : 'Детализация зависит от участка';
  } else if (state.mode === 'map') {
    $('#map-summary').textContent = 'Карта улиц · граница области исследования';
    $('#map-resolution').textContent = 'OpenStreetMap';
  } else {
    const [before, after] = state.selected;
    $('#map-summary').textContent =
      before && after
        ? 'A — ' +
          new Date(dateOf(before)).getUTCFullYear() +
          ' / B — ' +
          new Date(dateOf(after)).getUTCFullYear()
        : 'Сравнение снимков Sentinel-2';
    $('#map-resolution').textContent = 'Исходные снимки: 10 м / пиксель';
  }
}
function clearMetadata() {
  clearTimeout(metadataTimer);
  metadataController?.abort();
  metadataController = null;
  metadataViewKey = null;
  $('#detail-date').textContent = 'Проверяем дату…';
  $('#detail-resolution').textContent = '—';
  $('#detail-provider').textContent = 'World Imagery';
  $('#detail-source').hidden = true;
  $('#detail-disclaimer').textContent =
    'Дата относится к точке в центре карты. Соседние участки могут быть сняты в другое время.';
}
function showMetadata(metadata: ImageryMetadata | null) {
  $('#detail-date').textContent = metadata?.date
    ? dateLabel(metadata.date)
    : 'Дата съёмки недоступна';
  $('#detail-resolution').textContent = metadata?.sourceResolutionM
    ? number(metadata.sourceResolutionM, 2) + ' м / пиксель'
    : 'Нет данных';
  $('#detail-provider').textContent = metadata?.provider || 'World Imagery';
  const link = $<HTMLAnchorElement>('#detail-source');
  link.hidden = !metadata;
  if (metadata) link.href = metadata.metadataUrl;
  $('#detail-disclaimer').textContent =
    (metadata?.sampleResolutionM
      ? 'Шаг подложки этого уровня: ' + number(metadata.sampleResolutionM, 2) + ' м. '
      : '') +
    'Данные относятся к точке в центре карты; соседние участки могут иметь другую дату и детализацию.';
}
function currentMetadataKey() {
  const center = map.getCenter();
  return [
    center.lng.toFixed(5),
    center.lat.toFixed(5),
    Math.min(map.getZoom(), DETAIL_NATIVE_ZOOM),
  ].join('/');
}
function scheduleMetadata(force = false) {
  if (state.mode !== 'detail') return;
  const key = currentMetadataKey();
  // A resized metadata panel emits moveend without changing the map center.
  // Keep its content stable instead of starting another loading/layout cycle.
  if (!force && key === metadataViewKey) return;
  clearMetadata();
  metadataViewKey = key;
  metadataTimer = setTimeout(() => void refreshMetadata(), 300);
}
async function refreshMetadata() {
  if (state.mode !== 'detail') return;
  metadataController?.abort();
  const controller = new AbortController();
  metadataController = controller;
  const center = map.getCenter();
  const zoom = Math.min(map.getZoom(), DETAIL_NATIVE_ZOOM);
  const key = currentMetadataKey();
  try {
    const metadata =
      metadataCache.get(key) ||
      (await fetchDetailMetadata(center.lng, center.lat, zoom, controller.signal));
    if (controller.signal.aborted || state.mode !== 'detail') return;
    if (metadata) {
      if (metadataCache.size >= 40) metadataCache.clear();
      metadataCache.set(key, metadata);
    }
    showMetadata(metadata);
  } catch (error) {
    if (!controller.signal.aborted && state.mode === 'detail') {
      showMetadata(null);
      $('#detail-date').textContent = 'Метаданные временно недоступны';
    }
  }
}
function detailNotice(message: string | null, retry = false) {
  $('#detail-notice').hidden = state.mode !== 'detail' || !message;
  $('#detail-notice-text').textContent = message || '';
  $('#retry-detail').hidden = !retry;
}
detailLayer.on('loading', () => {
  detailLoadErrors = 0;
  detailLoadSuccesses = 0;
  detailNotice('Загружаем подробную подложку…');
  clearTimeout(detailLoadTimer);
  detailLoadTimer = setTimeout(
    () => detailNotice('Подложка загружается дольше обычного.', true),
    20000,
  );
});
detailLayer.on('tileload', () => detailLoadSuccesses++);
detailLayer.on('tileerror', () => detailLoadErrors++);
detailLayer.on('load', () => {
  clearTimeout(detailLoadTimer);
  detailNotice(
    detailLoadErrors > 0
      ? detailLoadSuccesses
        ? 'Часть подложки не загрузилась.'
        : 'Подробная подложка недоступна. Можно открыть «Карту».'
      : null,
    detailLoadErrors > 0,
  );
});
$('#retry-detail').onclick = () => {
  detailLayer.redraw();
  scheduleMetadata(true);
};
async function renderPair() {
  const selected = requireSelectedPair();
  const revision = ++state.renderRevision;
  loading('Загружаем спутниковые снимки…');
  const jsons = await Promise.all(selected.map((f) => fetchTileJSON(f)));
  if (revision !== state.renderRevision) return;
  const previous = [...state.layers];
  state.tileErrors = 0;
  const layers = jsons.map((json, i) => {
    if (!json.tiles?.[0])
      throw new Error('У снимка нет доступных изображений. Выберите другую дату.');
    return L.tileLayer(safeTileURL(json.tiles[0]), {
      pane: i ? 'satelliteAfter' : 'satelliteBefore',
      tileSize: 256,
      maxNativeZoom: 14,
      maxZoom: 18,
      minZoom: 10,
      bounds: boundsOf(selected[i].bbox),
      keepBuffer: 1,
      attribution:
        '<a href="https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a" target="_blank" rel="noopener noreferrer">Copernicus Sentinel / Microsoft Planetary Computer</a>',
    });
  });
  state.layers = [layers[0], layers[1]];
  const waits = layers.map(
    (layer) =>
      new Promise<TileLoadResult>((resolve) => {
        let successes = 0,
          errors = 0;
        const timer = setTimeout(() => resolve({ successes, errors, timeout: true }), 40000);
        layer.on('tileload', () => successes++);
        layer.on('tileerror', () => {
          errors++;
          state.tileErrors++;
        });
        layer.once('load', () => {
          clearTimeout(timer);
          resolve({ successes, errors });
        });
        layer.addTo(map);
      }),
  );
  for (const layer of previous) if (layer) map.removeLayer(layer);
  setMode('compare');
  $('#before-label').textContent = 'A · ' + shortDate(dateOf(selected[0]));
  $('#after-label').textContent = 'B · ' + shortDate(dateOf(selected[1]));
  const results = await Promise.all(waits);
  if (revision !== state.renderRevision) return;
  loading(null);
  if (results.some((r) => r.successes === 0)) {
    setMode('detail');
    status('Изображения не загрузились. Повторите поиск или выберите другую дату.', true);
    return;
  }
  $('#map-summary').textContent =
    'A — ' +
    new Date(dateOf(selected[0])).getUTCFullYear() +
    ' / B — ' +
    new Date(dateOf(selected[1])).getUTCFullYear();
  const partial = results.some((r) => r.errors || r.timeout);
  status(
    partial
      ? 'Часть снимка не загрузилась. Приблизьте карту или повторите поиск.'
      : 'Снимки загружены. Двигайте разделитель, чтобы сравнить.',
    partial,
  );
}
async function searchScenes() {
  if (state.busy) return;
  const before = Number($<HTMLSelectElement>('#year-before').value),
    after = Number($<HTMLSelectElement>('#year-after').value);
  if (before >= after) {
    status('Год «До» должен быть раньше года «После».', true);
    return;
  }
  cancelDraw();
  const revision = ++state.revision;
  setBusy(true);
  loading('Подбираем летние снимки…');
  status('Ищем съёмки с облачностью сцены менее 30%…');
  try {
    const scenes = await Promise.all([
      findScenes(before, state.bbox),
      findScenes(after, state.bbox),
    ]);
    if (revision !== state.revision) return;
    if (scenes.some((list) => !list.length)) {
      clearComparison();
      const missing = scenes
        .map((list, i) => (list.length ? null : [before, after][i]))
        .filter(Boolean)
        .join(' и ');
      status(
        'За ' +
          missing +
          ' нет летних снимков с облачностью менее 30%, полностью покрывающих область. Выберите другую область или годы.',
        true,
      );
      return;
    }
    state.scenes = scenes;
    state.selected = bestPair(...scenes);
    fillCard(0);
    fillCard(1);
    $('#scene-count').textContent = 'Доступно дат: ' + scenes[0].length + ' / ' + scenes[1].length;
    fitArea();
    await renderPair();
  } catch (e) {
    if (revision === state.revision) {
      clearLayers();
      setMode('detail');
      status(errorMessage(e), true);
    }
  } finally {
    if (revision === state.revision) {
      loading(null);
      setBusy(false);
    }
  }
}
for (const [p, i] of [
  ['before', 0],
  ['after', 1],
] as const)
  $<HTMLSelectElement>('#' + p + '-scene').onchange = async (e) => {
    const scene = state.scenes[i].find(
      (f) => f.id === (e.currentTarget as HTMLSelectElement).value,
    );
    if (!scene) return;
    state.selected[i] = scene;
    fillCard(i);
    setBusy(true);
    try {
      await renderPair();
    } catch (error) {
      clearLayers();
      setMode('detail');
      status(errorMessage(error), true);
    } finally {
      loading(null);
      setBusy(false);
    }
  };
function setArea(b: BBox, isDefault = false) {
  validateArea(b);
  state.bbox = [...b];
  state.revision++;
  cancelDraw();
  boundary.setBounds(boundsOf(b));
  updateArea();
  clearComparison();
  $('#area-title').textContent = isDefault ? 'Павлодар · Восток' : 'Моя область · Павлодар';
  $('#area-description').textContent = isDefault
    ? 'Стартовая область для исследования. Границы можно изменить на карте.'
    : 'Выбранная вами область исследования. Границы можно изменить на карте.';
  status('Область выбрана. Нажмите «Найти снимки».');
  fitArea();
}
function cancelDraw() {
  state.drawing = false;
  state.firstCorner = null;
  if (draft) {
    map.removeLayer(draft);
    draft = null;
  }
  if (marker) {
    map.removeLayer(marker);
    marker = null;
  }
  $('#draw-instruction').hidden = true;
  $('#map').classList.remove('drawing');
  $('#draw-area').setAttribute('aria-pressed', 'false');
  map.doubleClickZoom.enable();
}
$('#draw-area').onclick = () => {
  if (state.drawing) {
    cancelDraw();
    return;
  }
  state.drawing = true;
  $('#draw-instruction').hidden = false;
  $('#map').classList.add('drawing');
  $('#draw-area').setAttribute('aria-pressed', 'true');
  map.doubleClickZoom.disable();
  status('На карте нажмите на два противоположных угла области.');
};
$('#cancel-draw').onclick = cancelDraw;
L.DomEvent.disableClickPropagation($('#draw-instruction'));
L.DomEvent.disableClickPropagation($('#swipe-divider'));
L.DomEvent.disableScrollPropagation($('#swipe-divider'));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancelDraw();
});
map.on('click', (e) => {
  if (!state.drawing || state.busy) return;
  if (!state.firstCorner) {
    state.firstCorner = e.latlng;
    marker = L.circleMarker(e.latlng, {
      radius: 4,
      color: '#426495',
      fillColor: '#fff',
      fillOpacity: 1,
    }).addTo(map);
    status('Теперь укажите противоположный угол.');
    return;
  }
  const b = L.latLngBounds(state.firstCorner, e.latlng);
  try {
    setArea([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
  } catch (error) {
    cancelDraw();
    status(errorMessage(error), true);
  }
});
map.on('mousemove', (e) => {
  if (!state.drawing || !state.firstCorner) return;
  const b = L.latLngBounds(state.firstCorner, e.latlng);
  if (!draft)
    draft = L.rectangle(b, {
      color: '#426495',
      weight: 1,
      dashArray: '5 4',
      fillOpacity: 0.08,
      interactive: false,
    }).addTo(map);
  else draft.setBounds(b);
});
map.on('move zoom resize', updateClip);
map.on('movestart', () => {
  if (state.mode === 'detail') clearMetadata();
});
map.on('moveend', () => {
  updateMapSummary();
  scheduleMetadata();
});
// Mode controls and metadata can resize the map without a window resize.
const mapResizeObserver = new ResizeObserver(() => {
  map.invalidateSize({ debounceMoveend: true });
});
mapResizeObserver.observe($('#map'));
$<HTMLInputElement>('#swipe').oninput = updateClip;
const handle = $('#swipe-divider span');
handle.onpointerdown = (e) => {
  e.preventDefault();
  e.stopPropagation();
  handle.setPointerCapture(e.pointerId);
};
handle.onpointermove = (e) => {
  if (!handle.hasPointerCapture(e.pointerId)) return;
  const rect = $('#map').getBoundingClientRect();
  $<HTMLInputElement>('#swipe').value = String(
    Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)),
  );
  updateClip();
};
handle.onpointerup = (e) => {
  if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
};
$('#search-scenes').onclick = searchScenes;
$('#reset-area').onclick = () => setArea(DEFAULT_BBOX, true);
$('#fit-area').onclick = fitArea;
$('#zoom-detail').onclick = () => {
  const b = state.bbox;
  map.setView([(b[1] + b[3]) / 2, (b[0] + b[2]) / 2], DETAIL_NATIVE_ZOOM);
};
$('#mode-detail').onclick = () => setMode('detail');
$('#mode-map').onclick = () => setMode('map');
$('#mode-compare').onclick = () => {
  const selected = state.selected;
  const requestedYears = [
    Number($<HTMLSelectElement>('#year-before').value),
    Number($<HTMLSelectElement>('#year-after').value),
  ];
  if (
    state.layers.every(Boolean) &&
    selected.every(
      (scene, i) => scene && new Date(dateOf(scene)).getUTCFullYear() === requestedYears[i],
    )
  ) {
    setMode('compare');
  } else void searchScenes();
};
fillCard(0);
fillCard(1);
setMode('detail');
