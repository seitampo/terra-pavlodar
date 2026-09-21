'use strict';
// Public Sentinel-2 imagery via Microsoft Planetary Computer; no credentials.
const STAC='https://planetarycomputer.microsoft.com/api/stac/v1';
const DEFAULT_BBOX=[76.965,52.276,77.025,52.314];
const CITY_BBOX=[76.65,52.1,77.45,52.6];
const $=s=>document.querySelector(s);
const state={bbox:[...DEFAULT_BBOX],scenes:[[],[]],selected:[null,null],layers:[null,null],mode:'map',busy:false,drawing:false,firstCorner:null,revision:0,renderRevision:0,tileErrors:0};
const boundsOf=b=>[[b[1],b[0]],[b[3],b[2]]];
const dateOf=f=>f.properties.datetime;
const cloudOf=f=>Number(f.properties['eo:cloud_cover']);
const number=(n,d=1)=>n.toLocaleString('ru-RU',{maximumFractionDigits:d});
const dateLabel=d=>new Date(d).toLocaleDateString('ru-RU',{day:'2-digit',month:'long',year:'numeric',timeZone:'UTC'});
const shortDate=d=>new Date(d).toLocaleDateString('ru-RU',{timeZone:'UTC'});
const areaKm2=b=>6371.0088**2*Math.abs(Math.sin(b[3]*Math.PI/180)-Math.sin(b[1]*Math.PI/180))*(b[2]-b[0])*Math.PI/180;
const map=L.map('map',{zoomControl:false,minZoom:10,maxZoom:18}).setView([52.295,76.995],13);
L.control.zoom({position:'topright'}).addTo(map);
L.control.scale({imperial:false,position:'bottomleft'}).addTo(map);
const baseLayer=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>'}).addTo(map);
map.createPane('satelliteAfter').style.zIndex=300;
map.createPane('satelliteBefore').style.zIndex=310;
const boundary=L.rectangle(boundsOf(state.bbox),{color:'#426495',weight:2,fillOpacity:.03,interactive:false}).addTo(map);
let draft=null,marker=null;
const fitArea=()=>map.fitBounds(boundsOf(state.bbox),{padding:[45,45],maxZoom:15});
fitArea();
function status(message,error=false){$('#search-status').textContent=message;$('#search-status').classList.toggle('error',error);}
function loading(message){$('#map-loading').hidden=!message;$('#map-loading-text').textContent=message||'';}
function updateArea(){const b=state.bbox;$('#area-size').textContent=number(areaKm2(b),2)+' км²';$('.heading-note span').textContent=number((b[1]+b[3])/2,3)+'° N  '+number((b[0]+b[2])/2,3)+'° E';}
updateArea();
const now=new Date();
const latestSummer=now.getUTCMonth()>=8?now.getUTCFullYear():now.getUTCFullYear()-1;
for(const [selector,value] of [['#year-before',2020],['#year-after',latestSummer]]){
 const select=$(selector);select.replaceChildren();
 for(let y=2018;y<=latestSummer;y++)select.add(new Option(String(y),String(y),false,y===value));
 select.onchange=()=>status('Период изменён. Нажмите «Найти снимки», чтобы обновить сравнение.');
}
function pointInRing(p,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [xi,yi]=ring[i],[xj,yj]=ring[j];if((yi>p[1])!==(yj>p[1])&&p[0]<(xj-xi)*(p[1]-yi)/(yj-yi)+xi)inside=!inside;}return inside;}
function coversArea(f,b){const g=f.geometry,polygons=g?.type==='Polygon'?[g.coordinates]:g?.type==='MultiPolygon'?g.coordinates:[];const corners=[[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]],[(b[0]+b[2])/2,(b[1]+b[3])/2]];return polygons.some(rings=>corners.every(p=>pointInRing(p,rings[0])&&!rings.slice(1).some(h=>pointInRing(p,h))));}
async function fetchJSON(url,options={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
 try{const r=await fetch(url,{...options,signal:controller.signal});if(!r.ok)throw new Error('Источник снимков временно недоступен ('+r.status+'). Повторите поиск.');return await r.json();}
 catch(e){if(e.name==='AbortError')throw new Error('Источник долго отвечает. Повторите поиск через несколько секунд.');if(e instanceof TypeError)throw new Error('Не удалось связаться с источником снимков. Проверьте интернет и повторите поиск.');throw e;}finally{clearTimeout(timer);}
}
async function findScenes(year,b){
 const result=await fetchJSON(STAC+'/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({collections:['sentinel-2-l2a'],bbox:b,datetime:year+'-06-01T00:00:00Z/'+year+'-08-31T23:59:59Z',query:{'eo:cloud_cover':{lt:30}},sortby:[{field:'properties.eo:cloud_cover',direction:'asc'}],limit:100})});
 const unique=new Map();for(const f of result.features||[]){if(!f.assets?.tilejson?.href||!coversArea(f,b))continue;const d=dateOf(f).slice(0,10);if(!unique.has(d)||cloudOf(f)<cloudOf(unique.get(d)))unique.set(d,f);}return [...unique.values()].sort((a,b)=>cloudOf(a)-cloudOf(b));
}
function bestPair(a,b){const day=f=>new Date('2000'+dateOf(f).slice(4)).getTime()/86400000;let best=[a[0],b[0]],score=Infinity;for(const x of a)for(const y of b){const s=cloudOf(x)+cloudOf(y)+Math.abs(day(x)-day(y))*.15;if(s<score){score=s;best=[x,y];}}return best;}
function fillCard(i){
 const p=i?'after':'before',f=state.selected[i],select=$('#'+p+'-scene');select.replaceChildren();
 if(!f){$('#'+p+'-date').textContent='Лето '+$(i?'#year-after':'#year-before').value;select.add(new Option('Нет выбранного снимка',''));select.disabled=true;$('#'+p+'-meta').textContent='Найдите снимки для этой территории';$('#'+p+'-source').hidden=true;return;}
 for(const s of [...state.scenes[i]].sort((a,b)=>dateOf(a).localeCompare(dateOf(b))))select.add(new Option(shortDate(dateOf(s))+' · облачность '+number(cloudOf(s),2)+'%',s.id,false,s.id===f.id));
 select.disabled=state.busy;$('#'+p+'-date').textContent=dateLabel(dateOf(f));$('#'+p+'-meta').textContent='Облачность всей сцены '+number(cloudOf(f),2)+'% · '+(f.properties.platform||'Sentinel-2').toUpperCase()+' · 10 м';const link=$('#'+p+'-source');link.href=STAC+'/collections/sentinel-2-l2a/items/'+encodeURIComponent(f.id);link.hidden=false;
}
function setBusy(busy){state.busy=busy;for(const s of ['#search-scenes','#year-before','#year-after','#draw-area','#reset-area'])$(s).disabled=busy;for(const p of ['before','after'])$('#'+p+'-scene').disabled=busy||!state.selected[p==='before'?0:1];$('#search-scenes').firstChild.textContent=busy?'Ищем снимки… ':'Найти снимки ';}
function clearLayers(){state.renderRevision++;for(const layer of state.layers)if(layer)map.removeLayer(layer);state.layers=[null,null];}
function clearComparison(){clearLayers();state.scenes=[[],[]];state.selected=[null,null];fillCard(0);fillCard(1);setMode('map');$('#mode-compare').disabled=true;$('#scene-count').textContent='Два периода · один участок';$('#map-summary').textContent='Выберите годы и найдите снимки';}
function updateClip(){const size=map.getSize(),top=map.containerPointToLayerPoint([0,0]),split=map.containerPointToLayerPoint([size.x*Number($('#swipe').value)/100,size.y]);map.getPane('satelliteBefore').style.clip='rect('+top.y+'px, '+split.x+'px, '+split.y+'px, '+top.x+'px)';$('#swipe-divider').style.left=$('#swipe').value+'%';}
function setMode(mode){
 if(mode==='compare'&&!state.layers.every(Boolean))return;state.mode=mode;const compare=mode==='compare';baseLayer.setOpacity(compare?0:1);
 for(const pane of ['satelliteBefore','satelliteAfter'])map.getPane(pane).style.display=compare?'':'none';
 for(const s of ['#before-label','#after-label','#swipe-divider','#swipe-control'])$(s).hidden=!compare;
 for(const [id,active] of [['#mode-map',!compare],['#mode-compare',compare]]){$(id).classList.toggle('active',active);$(id).setAttribute('aria-pressed',String(active));}
 boundary.setStyle({color:compare?'#fff':'#426495',weight:2,fillOpacity:compare?0:.03,dashArray:compare?'6 5':null});$('#map-caption-text').textContent=compare?'Sentinel-2 · исследуемая область':'Исследуемая область';updateClip();
}
function safeTileURL(url){const u=new URL(url);if(u.protocol!=='https:'||u.hostname!=='planetarycomputer.microsoft.com')throw new Error('Источник вернул неподдерживаемый адрес снимка.');return url;}
async function renderPair(){
 const revision=++state.renderRevision;loading('Загружаем спутниковые снимки…');
 const jsons=await Promise.all(state.selected.map(f=>fetchJSON(safeTileURL(f.assets.tilejson.href))));if(revision!==state.renderRevision)return;
 const previous=[...state.layers];state.tileErrors=0;
 const layers=jsons.map((json,i)=>{if(!json.tiles?.[0])throw new Error('У снимка нет доступных изображений. Выберите другую дату.');return L.tileLayer(safeTileURL(json.tiles[0]),{pane:i?'satelliteAfter':'satelliteBefore',tileSize:256,maxNativeZoom:14,maxZoom:18,minZoom:10,bounds:boundsOf(state.selected[i].bbox),keepBuffer:1,attribution:'<a href="https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a" target="_blank" rel="noopener noreferrer">Copernicus Sentinel / Microsoft Planetary Computer</a>'});});
 state.layers=layers;
 const waits=layers.map(layer=>new Promise(resolve=>{let successes=0,errors=0;const timer=setTimeout(()=>resolve({successes,errors,timeout:true}),40000);layer.on('tileload',()=>successes++);layer.on('tileerror',()=>{errors++;state.tileErrors++;});layer.once('load',()=>{clearTimeout(timer);resolve({successes,errors});});layer.addTo(map);}));
 for(const layer of previous)if(layer)map.removeLayer(layer);$('#mode-compare').disabled=false;setMode('compare');
 $('#before-label').textContent='A · '+shortDate(dateOf(state.selected[0]));$('#after-label').textContent='B · '+shortDate(dateOf(state.selected[1]));
 const results=await Promise.all(waits);if(revision!==state.renderRevision)return;loading(null);
 if(results.some(r=>r.successes===0)){setMode('map');status('Изображения не загрузились. Повторите поиск или выберите другую дату.',true);$('#map-summary').textContent='Снимки найдены, изображения недоступны';return;}
 $('#map-summary').textContent='A — '+new Date(dateOf(state.selected[0])).getUTCFullYear()+' / B — '+new Date(dateOf(state.selected[1])).getUTCFullYear();
 const partial=results.some(r=>r.errors||r.timeout);status(partial?'Часть снимка не загрузилась. Приблизьте карту или повторите поиск.':'Снимки загружены. Двигайте разделитель, чтобы сравнить.',partial);
}
async function searchScenes(){
 if(state.busy)return;const before=Number($('#year-before').value),after=Number($('#year-after').value);if(before>=after){status('Год «До» должен быть раньше года «После».',true);return;}
 cancelDraw();const revision=++state.revision;setBusy(true);loading('Подбираем летние снимки…');status('Ищем съёмки с облачностью сцены менее 30%…');
 try{const scenes=await Promise.all([findScenes(before,state.bbox),findScenes(after,state.bbox)]);if(revision!==state.revision)return;
  if(scenes.some(list=>!list.length)){clearComparison();const missing=scenes.map((list,i)=>list.length?null:[before,after][i]).filter(Boolean).join(' и ');status('За '+missing+' нет летних снимков с облачностью менее 30%, полностью покрывающих область. Выберите другую область или годы.',true);return;}
  state.scenes=scenes;state.selected=bestPair(...scenes);fillCard(0);fillCard(1);$('#scene-count').textContent='Доступно дат: '+scenes[0].length+' / '+scenes[1].length;fitArea();await renderPair();
 }catch(e){if(revision===state.revision){clearLayers();setMode('map');$('#mode-compare').disabled=true;status(e.message||'Не удалось загрузить снимки. Повторите поиск.',true);}}
 finally{if(revision===state.revision){loading(null);setBusy(false);}}
}
for(const [p,i] of [['before',0],['after',1]])$('#'+p+'-scene').onchange=async e=>{const scene=state.scenes[i].find(f=>f.id===e.target.value);if(!scene)return;state.selected[i]=scene;fillCard(i);setBusy(true);try{await renderPair();}catch(error){clearLayers();setMode('map');$('#mode-compare').disabled=true;status(error.message,true);}finally{loading(null);setBusy(false);}};
function validateArea(b){
 if(!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||b[0]>=b[2]||b[1]>=b[3])throw new Error('Укажите корректные границы области.');
 if(b[0]<CITY_BBOX[0]||b[1]<CITY_BBOX[1]||b[2]>CITY_BBOX[2]||b[3]>CITY_BBOX[3])throw new Error('В пилотной версии выберите область в Павлодаре и ближайших окрестностях.');
 if(areaKm2(b)>150)throw new Error('Выберите область меньше 150 км², чтобы рассмотреть изменения.');
 if(areaKm2(b)<.01)throw new Error('Область слишком мала для снимков 10 м. Выберите хотя бы 1 гектар.');
}
function setArea(b,isDefault=false){validateArea(b);state.bbox=[...b];state.revision++;cancelDraw();boundary.setBounds(boundsOf(b));updateArea();clearComparison();$('#area-title').textContent=isDefault?'Павлодар · Восток':'Моя область · Павлодар';status('Область выбрана. Нажмите «Найти снимки».');fitArea();}
function cancelDraw(){state.drawing=false;state.firstCorner=null;if(draft){map.removeLayer(draft);draft=null;}if(marker){map.removeLayer(marker);marker=null;}$('#draw-instruction').hidden=true;$('#map').classList.remove('drawing');$('#draw-area').setAttribute('aria-pressed','false');map.doubleClickZoom.enable();}
$('#draw-area').onclick=()=>{if(state.drawing){cancelDraw();return;}state.drawing=true;$('#draw-instruction').hidden=false;$('#map').classList.add('drawing');$('#draw-area').setAttribute('aria-pressed','true');map.doubleClickZoom.disable();status('На карте нажмите на два противоположных угла области.');};
$('#cancel-draw').onclick=cancelDraw;
L.DomEvent.disableClickPropagation($('#draw-instruction'));
L.DomEvent.disableClickPropagation($('#swipe-divider'));
L.DomEvent.disableScrollPropagation($('#swipe-divider'));
window.addEventListener('keydown',e=>{if(e.key==='Escape')cancelDraw();});
map.on('click',e=>{if(!state.drawing||state.busy)return;if(!state.firstCorner){state.firstCorner=e.latlng;marker=L.circleMarker(e.latlng,{radius:4,color:'#426495',fillColor:'#fff',fillOpacity:1}).addTo(map);status('Теперь укажите противоположный угол.');return;}const b=L.latLngBounds(state.firstCorner,e.latlng);try{setArea([b.getWest(),b.getSouth(),b.getEast(),b.getNorth()]);}catch(error){cancelDraw();status(error.message,true);}});
map.on('mousemove',e=>{if(!state.drawing||!state.firstCorner)return;const b=L.latLngBounds(state.firstCorner,e.latlng);if(!draft)draft=L.rectangle(b,{color:'#426495',weight:1,dashArray:'5 4',fillOpacity:.08,interactive:false}).addTo(map);else draft.setBounds(b);});
map.on('move zoom resize',updateClip);$('#swipe').oninput=updateClip;
const handle=$('#swipe-divider span');
handle.onpointerdown=e=>{e.preventDefault();e.stopPropagation();handle.setPointerCapture(e.pointerId);};
handle.onpointermove=e=>{if(!handle.hasPointerCapture(e.pointerId))return;const rect=$('#map').getBoundingClientRect();$('#swipe').value=String(Math.max(0,Math.min(100,(e.clientX-rect.left)/rect.width*100)));updateClip();};
handle.onpointerup=e=>{if(handle.hasPointerCapture(e.pointerId))handle.releasePointerCapture(e.pointerId);};
$('#search-scenes').onclick=searchScenes;$('#reset-area').onclick=()=>setArea(DEFAULT_BBOX,true);$('#fit-area').onclick=fitArea;$('#mode-map').onclick=()=>setMode('map');$('#mode-compare').onclick=()=>setMode('compare');
fillCard(0);fillCard(1);
function snapshot(){return{bbox:state.bbox,areaKm2:Math.round(areaKm2(state.bbox)*100)/100,mode:state.mode,busy:state.busy,split:Number($('#swipe').value),scenes:state.selected.map(f=>f?{id:f.id,date:dateOf(f),cloudCoverScene:cloudOf(f),source:STAC+'/collections/sentinel-2-l2a/items/'+f.id}:null),status:$('#search-status').textContent};}
if(document.modelContext?.registerTool){
 const lifecycle=new AbortController();const register=tool=>{try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}};
 register({name:'get_satellite_comparison',title:'Текущее сравнение снимков',description:'Read the selected Pavlodar area, image dates, whole-scene cloud cover and loading status.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute(input){if(input&&Object.keys(input).length)throw new Error('No arguments accepted.');return snapshot();}});
 register({name:'set_comparison_split',title:'Передвинуть границу сравнения',description:'Move the visible before/after divider. Does not change the selected scenes or area.',inputSchema:{type:'object',properties:{percent:{type:'number',minimum:0,maximum:100}},required:['percent'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(!input||Object.keys(input).some(k=>k!=='percent')||typeof input.percent!=='number'||!Number.isFinite(input.percent)||input.percent<0||input.percent>100)throw new Error('percent must be a number from 0 to 100.');if(state.mode!=='compare')throw new Error('Load a comparison first.');$('#swipe').value=String(input.percent);updateClip();return snapshot();}});
 window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
searchScenes();
