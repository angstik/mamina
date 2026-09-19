import './styles.css'
import { UserMaminaService } from '../backend/user-service.js'
import { clearLogs as clearTechLogs, formatLogs, onLog, info, error as logError } from '../backend/log.js'

const $=id=>document.getElementById(id)
const service=new UserMaminaService()

let magazines=[],currentModel=null,displayArticles=[],currentArticleIndex=0
let reactionOrder='asc',articleOrderMode='magazine',appName='MamiNa'
let composerArticleKey=null,safetyTimer=null,reconnectTimer=null,connectionClock=null,readTimer=null
let telegramState='offline',reconnecting=false,lastConnectedAt=Number(localStorage.getItem('MAMINA_LAST_CONNECTED_AT')||0)
let currentColor='#000000',savedRange=null
const homeUrls=[],readerUrls=[]

const status=(id,text,ok=null)=>{const e=$(id);if(!e)return;e.textContent=text;e.className='status'+(ok===true?' ok':ok===false?' error':'')}
const debug=e=>logError('ui',e?.stack||e?.message||String(e),e)
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;')
const objectUrl=(blob,bucket)=>{const u=URL.createObjectURL(blob);bucket.push(u);return u}
const freeUrls=b=>{while(b.length)URL.revokeObjectURL(b.pop())}
const fmtDate=iso=>{if(!iso)return'';const d=new Date(`${iso}T12:00:00`);return new Intl.DateTimeFormat('fr-FR',{day:'numeric',month:'long',year:'numeric'}).format(d)}
const fmtShort=iso=>{if(!iso)return'';const d=new Date(`${iso}T12:00:00`);return new Intl.DateTimeFormat('fr-FR',{day:'numeric',month:'long'}).format(d)}
const slotName=s=>s==='h'?'haut':s==='b'?'bas':'pleine page'

function applyTheme(v){if(v==='system')document.documentElement.removeAttribute('data-theme');else document.documentElement.dataset.theme=v}
function setAppName(v){appName=String(v||'MamiNa').trim()||'MamiNa';$('homeAppName').textContent=appName;$('readerAppName').textContent=appName;document.title=appName}
async function loadSettings(){const c=await service.getSettings();reactionOrder=c.reactionOrder;articleOrderMode=c.articleOrderMode;applyTheme(c.theme);setAppName(c.appTitle);$('reactionOrder').value=reactionOrder;$('themeSelect').value=c.theme;$('adminAppTitle').value=c.appTitle}
function elapsed(ms){const s=Math.floor(ms/1000);if(s<60)return`${s}s`;const m=Math.floor(s/60);if(m<60)return`${m}m`;return`${Math.floor(m/60)}h`}
function refreshPills(){const age=lastConnectedAt?Date.now()-lastConnectedAt:Infinity,connected=telegramState==='connected'&&!reconnecting,stale=age>=9*3600000,text=connected?'●':lastConnectedAt?(stale?'9h+':elapsed(age)):'—',cls=reconnecting?'reconnecting':connected?'connected':stale?'stale':lastConnectedAt?'recent':'unknown';for(const id of ['connectionPillHome','connectionPillReader']){const e=$(id);e.textContent=text;e.className=`connection-pill ${cls}`;e.disabled=reconnecting}}
function setConnectionUi(s){telegramState=s||'offline';if(s==='connected'){lastConnectedAt=Date.now();localStorage.setItem('MAMINA_LAST_CONNECTED_AT',lastConnectedAt)}$('telegramState').textContent=s||'—';refreshPills()}
async function refreshPending(){const n=await service.pendingCount();for(const id of ['pendingHome','pendingReader']){const e=$(id);e.textContent=n;e.hidden=!n}$('pendingSettings').textContent=n}
async function localHome(){await loadSettings();magazines=await service.magazineSummaries();await renderMagazineList();await refreshPending()}
async function init(){$('networkState').textContent=navigator.onLine?'En ligne':'Hors ligne';await localHome();renderLogs();connectionClock=setInterval(refreshPills,1000)}
init()

function askTelegram(kind){const modal=$('telegramAuthModal'),input=$('telegramAuthInput'),title=$('telegramAuthTitle'),hint=$('telegramAuthHint'),cfg={phone:{title:'Numéro Telegram',type:'tel',autocomplete:'tel',inputmode:'tel',placeholder:'+33 6 12 34 56 78',hint:'Format international. Le téléphone peut proposer ton numéro automatiquement.'},code:{title:'Code Telegram',type:'text',autocomplete:'one-time-code',inputmode:'numeric',placeholder:'12345',hint:'Code reçu par Telegram.'},password:{title:'Mot de passe Telegram',type:'password',autocomplete:'current-password',inputmode:'text',placeholder:'Mot de passe 2FA',hint:'Seulement si la double authentification Telegram est active.'}}[kind];title.textContent=cfg.title;hint.textContent=cfg.hint;input.type=cfg.type;input.autocomplete=cfg.autocomplete;input.inputMode=cfg.inputmode;input.placeholder=cfg.placeholder;input.value='';return new Promise((resolve,reject)=>{const clean=()=>{$('telegramAuthForm').onsubmit=null;$('telegramAuthCancel').onclick=null};$('telegramAuthForm').onsubmit=e=>{e.preventDefault();const v=input.value.trim();if(!v)return;clean();modal.close();resolve(v)};$('telegramAuthCancel').onclick=()=>{clean();modal.close();reject(new Error('Connexion Telegram annulée.'))};modal.showModal();setTimeout(()=>input.focus(),70)})}
service.setAuthProvider({phone:()=>askTelegram('phone'),code:()=>askTelegram('code'),password:()=>askTelegram('password')})

$('start').onclick=async()=>{$('start').disabled=true;try{status('setupStatus','Déverrouillage…');await service.unlock($('password').value);$('setup').hidden=true;await localHome();const me=await service.login(),{models,selected}=await service.restoreOrSelectDialog();if(!selected){const s=$('groupSelect');s.innerHTML='';models.forEach((m,i)=>{const o=document.createElement('option');o.value=i;o.textContent=m.title;s.appendChild(o)});window.__groups=models;$('setup').hidden=false;$('groupChooser').hidden=false;status('setupStatus',`Connecté : ${me.displayName||'Telegram'} — choisis le groupe.`,true);return}startNetwork()}catch(e){debug(e);$('setup').hidden=false;status('setupStatus','Erreur : '+(e.message||e),false)}finally{$('start').disabled=false}}
$('chooseGroup').onclick=async()=>{try{const m=(window.__groups||[])[+$('groupSelect').value];await service.selectDialog(m);$('setup').hidden=true;startNetwork()}catch(e){debug(e)}}
function startNetwork(){service.onConnectionState=setConnectionUi;setConnectionUi(service.connectionState());service.onChanged=async()=>{await localHome();if(currentModel){const k=currentArticle()?.articleKey;currentModel=await service.openMagazineLocalFirst(currentModel.magazine.magazineId);await rebuild(k)}};clearInterval(safetyTimer);safetyTimer=setInterval(()=>{if(document.visibilityState==='visible'&&navigator.onLine)backgroundSync()},30000);clearInterval(reconnectTimer);reconnectTimer=setInterval(()=>{if(document.visibilityState==='visible'&&navigator.onLine&&service.connectionState()!=='connected')forceReconnect()},10000);backgroundSync()}
async function forceReconnect(){if(reconnecting||!service.hasGateway()||!navigator.onLine)return;reconnecting=true;refreshPills();try{await service.ensureConnected('pill/watchdog');setConnectionUi(service.connectionState());await service.flushOutbox();await refreshPending();await backgroundSync()}catch(e){debug(e)}finally{reconnecting=false;refreshPills()}}
$('connectionPillHome').onclick=forceReconnect;$('connectionPillReader').onclick=forceReconnect
async function backgroundSync(){if(!service.hasGateway()||!service.hasDialog())return;try{await service.syncAll();await localHome();$('lastSyncState').textContent=new Date().toLocaleTimeString('fr-FR');await refreshPending()}catch(e){debug(e)}}
const resume=()=>{if(document.visibilityState==='visible'&&navigator.onLine)forceReconnect()}
window.addEventListener('online',()=>{$('networkState').textContent='En ligne';resume()});window.addEventListener('offline',()=>{$('networkState').textContent='Hors ligne';setConnectionUi('offline')});window.addEventListener('focus',resume);window.addEventListener('pageshow',resume);document.addEventListener('visibilitychange',resume)

async function renderMagazineList(){const h=$('magazines');h.innerHTML='';freeUrls(homeUrls);if(!magazines.length){h.innerHTML='<p class="empty">Aucune revue locale.</p>';return}for(const m of magazines){const b=document.createElement('button');b.className='magazine-card';b.innerHTML=`${m.cover?`<img src="${objectUrl(m.cover,homeUrls)}">`:''}<div class="magazine-info"><div class="magazine-title">${esc(m.title)}${m.issue?` · N°${m.issue}`:''}</div><div>${esc(fmtDate(m.date))}</div><div class="magazine-stats"><span>${m.reactionCount||0} réactions</span><span class="unread">${m.unreadCount||0} non lues</span></div></div>`;b.onclick=()=>openMagazine(m.magazineId);h.appendChild(b)}}
async function openMagazine(id){try{currentModel=await service.openMagazineLocalFirst(id);await loadSettings();displayArticles=orderArticles(currentModel.articles);const u=displayArticles.findIndex(a=>a.unreadCount>0);currentArticleIndex=u>=0?u:0;$('home').hidden=true;$('reader').hidden=false;await renderReader()}catch(e){alert(e.message);debug(e)}}
$('back').onclick=async()=>{if(!$('composerModal').hidden)return;$('reader').hidden=true;$('home').hidden=false;freeUrls(readerUrls);currentModel=null;await localHome()}

function magRank(a){return[Number(a.page||0),({h:0,p:0,b:1}[a.slot]??0)]}
function latest(a,unread=false){let n=0;for(const c of a.comments||[]){if(c.pending)continue;if(unread&&(c.isOutgoing||c.id<=a.lastReadMessageId))continue;n=Math.max(n,+c.id||0)}return n}
function orderArticles(rows){const a=[...rows];if(articleOrderMode==='magazine')return a.sort((x,y)=>{const X=magRank(x),Y=magRank(y);return X[0]-Y[0]||X[1]-Y[1]});return a.sort((x,y)=>{const bucket=v=>v.unreadCount>0?0:(v.comments?.some(c=>!c.pending)?1:2),bx=bucket(x),by=bucket(y);if(bx!==by)return bx-by;const d=by===0?latest(y,true)-latest(x,true):by===1?latest(y)-latest(x):0;if(d)return d;const X=magRank(x),Y=magRank(y);return X[0]-Y[0]||X[1]-Y[1]})}
const currentArticle=()=>displayArticles[currentArticleIndex]
async function rebuild(key){displayArticles=orderArticles(currentModel.articles);const i=displayArticles.findIndex(a=>a.articleKey===key);currentArticleIndex=i>=0?i:0;await renderReader()}

function renderMarkup(t=''){let s=esc(t);s=s.replace(/\[color=(#[0-9a-fA-F]{6})\]([\s\S]*?)\[\/color\]/g,'<span style="color:$1">$2</span>').replace(/\*\*([\s\S]+?)\*\*/g,'<strong>$1</strong>').replace(/__([\s\S]+?)__/g,'<u>$1</u>').replace(/~~([\s\S]+?)~~/g,'<s>$1</s>');return s.replace(/\n/g,'<br>')}
async function renderReader(){freeUrls(readerUrls);$('readerDate').textContent=fmtShort(currentModel.magazine.date);const d=$('articleDeck');d.innerHTML='';displayArticles.forEach((a,i)=>{const p=document.createElement('section');p.className='article-page';p.dataset.index=i;const v=document.createElement('div');v.className='article-visual';v.innerHTML=`<div class="subtle">Chargement…</div><div class="article-actions"><button class="article-float message-order" title="Ordre des messages">${reactionOrder==='asc'?'↑':'↓'}</button><button class="article-float add-message" title="Ajouter">＋</button></div>`;p.appendChild(v);const list=document.createElement('div');list.className='reaction-list';renderComments(a,list);p.appendChild(list);d.appendChild(p);v.querySelector('.add-message').onclick=()=>openComposer(a.articleKey);v.querySelector('.message-order').onclick=async()=>{reactionOrder=reactionOrder==='asc'?'desc':'asc';await service.setReactionOrder(reactionOrder);await rebuild(a.articleKey)};installArticleGestures(v,i)});requestAnimationFrame(()=>{d.scrollLeft=currentArticleIndex*d.clientWidth;activate(currentArticleIndex)})}
function renderComments(a,list){list.innerHTML='';let c=[...(a.comments||[])];if(reactionOrder==='desc')c.reverse();if(!c.length){list.innerHTML='<div class="empty">Aucune réaction.</div>';return}for(const x of c){const e=document.createElement('div');e.className='reaction'+(x.pending?' pending':'')+(!x.isOutgoing&&!x.pending&&x.id>a.lastReadMessageId?' unread-reaction':'');e.dataset.messageId=x.id;e.innerHTML=`<div class="reaction-meta">${esc(x.author)}${x.pending?'':` · ${new Date(x.date||Date.now()).toLocaleString('fr-FR')}`}</div><div class="reaction-text">${renderMarkup(x.displayText||'')}</div>`;if(x.pending)e.onclick=()=>openComposer(a.articleKey);list.appendChild(e)}}
async function loadVisual(i){const p=$('articleDeck').querySelector(`[data-index="${i}"]`),v=p?.querySelector('.article-visual');if(!v||v.querySelector('img'))return;try{const b=await service.getArticleImage(displayArticles[i].articleKey),img=document.createElement('img');img.src=objectUrl(b,readerUrls);v.querySelector('.subtle')?.remove();v.prepend(img);v._pz?.apply()}catch(e){debug(e)}}
function warmAround(i){const keys=[];for(const j of [i,i+1,i-1,i+2,i-2])if(j>=0&&j<displayArticles.length)keys.push(displayArticles[j].articleKey);service.warmArticleImages(keys)}
function activate(i){currentArticleIndex=i;$('readerPage').textContent=`Article ${i+1}/${displayArticles.length} · p${currentArticle().page}-${currentArticle().slot}`;[i,i-1,i+1].forEach(loadVisual);setTimeout(()=>warmAround(i),0);const a=currentArticle(),list=$('articleDeck').querySelector(`[data-index="${i}"] .reaction-list`),unread=(a.comments||[]).filter(c=>!c.pending&&!c.isOutgoing&&c.id>a.lastReadMessageId).sort((x,y)=>x.id-y.id);requestAnimationFrame(()=>{if(unread.length)list.querySelector(`[data-message-id="${unread[0].id}"]`)?.scrollIntoView({block:'start'});else list.scrollTop=reactionOrder==='asc'?list.scrollHeight:0});clearTimeout(readTimer);readTimer=setTimeout(()=>service.markArticleRead(a.articleKey),1400)}
let scrollTimer;$('articleDeck').onscroll=()=>{if(!$('composerModal').hidden)return;clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>{const d=$('articleDeck'),i=Math.max(0,Math.min(displayArticles.length-1,Math.round(d.scrollLeft/d.clientWidth)));if(i!==currentArticleIndex)activate(i)},90)}

function goArticle(delta){const next=Math.max(0,Math.min(displayArticles.length-1,currentArticleIndex+delta));if(next===currentArticleIndex)return;const d=$('articleDeck');d.scrollTo({left:next*d.clientWidth,behavior:'smooth'});setTimeout(()=>activate(next),180)}
function installArticleGestures(container,index){
  let scale=1,tx=0,ty=0,start=null,pinch=null,lastTap=0
  const apply=()=>{const img=container.querySelector('img');if(img)img.style.transform=`translate(${tx}px,${ty}px) scale(${scale})`}
  const reset=()=>{scale=1;tx=0;ty=0;apply()}
  container._pz={get scale(){return scale},reset,apply}

  container.addEventListener('touchstart',e=>{
    if(e.target.closest('button'))return
    if(e.touches.length===1)start={x:e.touches[0].clientX,y:e.touches[0].clientY,tx,ty}
    if(e.touches.length===2){const[a,b]=e.touches;pinch={d:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),scale}}
  },{passive:true})

  container.addEventListener('touchmove',e=>{
    if(e.touches.length===2&&pinch){e.preventDefault();const[a,b]=e.touches,d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);scale=Math.max(1,Math.min(4,pinch.scale*d/pinch.d));apply()}
    else if(e.touches.length===1&&start&&scale>1){e.preventDefault();tx=start.tx+e.touches[0].clientX-start.x;ty=start.ty+e.touches[0].clientY-start.y;apply()}
  },{passive:false})

  container.addEventListener('touchend',e=>{
    if(start&&scale===1&&e.changedTouches?.length){
      const dx=e.changedTouches[0].clientX-start.x,dy=e.changedTouches[0].clientY-start.y
      if(Math.abs(dx)>55&&Math.abs(dx)>Math.abs(dy)*1.15){goArticle(dx<0?1:-1);start=null;pinch=null;return}
    }
    start=null;pinch=null
  })

  container.addEventListener('pointerup',e=>{
    if(e.pointerType==='touch')return
    const now=Date.now()
    if(now-lastTap<340){handleDoubleTap(container,index,e.clientX,e.clientY);lastTap=0}else lastTap=now
  })
  container.addEventListener('touchend',e=>{
    if(e.changedTouches?.length!==1)return
    const now=Date.now()
    if(now-lastTap<330){const t=e.changedTouches[0];handleDoubleTap(container,index,t.clientX,t.clientY);lastTap=0}else lastTap=now
  })
}
function handleDoubleTap(container,index,clientX,clientY){
  if(container._pz?.scale!==1){container._pz.reset();return}
  const a=displayArticles[index],r=container.getBoundingClientRect(),nx=(clientX-r.left)/r.width,ny=(clientY-r.top)/r.height,b=a.textBounds
  const inText=b&&nx>=b.x0&&nx<=b.x1&&ny>=b.y0&&ny<=b.y1
  if(inText)openFocusText(a)
  else openFocusImage(container.querySelector('img')?.src)
}
function openFocusText(a){$('focusImageStage').hidden=true;$('focusTextStage').hidden=false;$('focusText').textContent=a.articleText||a.pageText||'';$('focusOverlay').hidden=false}
function openFocusImage(src){if(!src)return;$('focusTextStage').hidden=true;$('focusImageStage').hidden=false;$('focusImage').src=src;$('focusOverlay').hidden=false;installFocusPanZoom()}
function closeFocus(){$('focusOverlay').hidden=true;$('focusImage').style.transform='';$('focusImage').src=''}
let focusTap=0
$('focusOverlay').addEventListener('pointerup',()=>{const n=Date.now();if(n-focusTap<350){closeFocus();focusTap=0}else focusTap=n})
function installFocusPanZoom(){const stage=$('focusImageStage'),img=$('focusImage');let scale=1,tx=0,ty=0,pinch=null,start=null;const apply=()=>img.style.transform=`translate(${tx}px,${ty}px) scale(${scale})`;stage.ontouchstart=e=>{if(e.touches.length===2){const[a,b]=e.touches;pinch={d:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),scale}}else if(e.touches.length===1)start={x:e.touches[0].clientX,y:e.touches[0].clientY,tx,ty}};stage.ontouchmove=e=>{if(e.touches.length===2&&pinch){e.preventDefault();const[a,b]=e.touches;scale=Math.max(1,Math.min(5,pinch.scale*Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY)/pinch.d));apply()}else if(e.touches.length===1&&start&&scale>1){e.preventDefault();tx=start.tx+e.touches[0].clientX-start.x;ty=start.ty+e.touches[0].clientY-start.y;apply()}};stage.ontouchend=()=>{start=null;pinch=null}}

$('openSettingsHome').onclick=()=>{$('settingsView').hidden=false}
$('closeSettings').onclick=()=>{$('settingsView').hidden=true}
$('themeSelect').onchange=async()=>{applyTheme($('themeSelect').value);await service.setTheme($('themeSelect').value)}
$('reactionOrder').onchange=async()=>{reactionOrder=$('reactionOrder').value;await service.setReactionOrder(reactionOrder);if(currentModel)await rebuild(currentArticle()?.articleKey)}
function renderLogs(){$('techLogs').textContent=formatLogs()||'Aucun journal.'}onLog(renderLogs)
$('clearLogs').onclick=()=>{clearTechLogs();renderLogs()};$('copyLogs').onclick=()=>navigator.clipboard.writeText(formatLogs())
$('verboseLogs').checked=Number(localStorage.getItem('MTCUTE_LOG_LEVEL')||2)>=4;$('verboseLogs').onchange=()=>localStorage.setItem('MTCUTE_LOG_LEVEL',$('verboseLogs').checked?'4':'2')

let adminGroups=[],adminTopics=[]
$('adminRefreshGroups').onclick=async()=>{try{adminGroups=await service.adminListForumDialogs();const s=$('adminGroupSelect');s.innerHTML='';adminGroups.forEach((g,i)=>{const o=document.createElement('option');o.value=i;o.textContent=g.title;s.appendChild(o)});status('adminStatus',`${adminGroups.length} groupes avec sujets.`,true)}catch(e){status('adminStatus','Erreur : '+e.message,false)}}
$('adminGroupSelect').onchange=async()=>{const g=adminGroups[+$('adminGroupSelect').value];if(g){await service.selectDialog(g);await refreshPending()}}
$('adminRefreshTopics').onclick=async()=>{try{adminTopics=await service.adminListTopics();const s=$('adminTopicSelect');s.innerHTML='';adminTopics.forEach((t,i)=>{const o=document.createElement('option');o.value=i;o.textContent=t.title||`Sujet ${t.id}`;s.appendChild(o)});status('adminStatus',`${adminTopics.length} sujets.`,true)}catch(e){status('adminStatus','Erreur : '+e.message,false)}}
$('saveAdminTitle').onclick=async()=>{try{const t=await service.setAppTitle($('adminAppTitle').value);setAppName(t);status('adminTitleStatus',`Nom enregistré : ${t}`,true)}catch(e){status('adminTitleStatus','Erreur : '+e.message,false)}}
$('adminPublish').onclick=async()=>{const f=$('adminPdf').files?.[0],trace=$('adminTrace');trace.textContent='';try{if(!f)throw new Error('Choisis un PDF.');$('adminPublish').disabled=true;const r=await service.adminCreateMagazine(f,{onStep:e=>{trace.textContent+=`${new Date(e.at).toLocaleTimeString()} ${e.name} ${JSON.stringify(e.detail||{})}\n`}});status('adminStatus',`Publié : ${r.articles.length} articles détectés.`,true);await localHome()}catch(e){status('adminStatus','Erreur : '+e.message,false)}finally{$('adminPublish').disabled=false}}

/* Rich editor */
function saveSelection(){const sel=getSelection();if(sel?.rangeCount&&$('composerText').contains(sel.anchorNode))savedRange=sel.getRangeAt(0).cloneRange()}
function restoreSelection(){if(!savedRange)return;const sel=getSelection();sel.removeAllRanges();sel.addRange(savedRange)}
function rgbHex(v){if(/^#[0-9a-f]{6}$/i.test(v||''))return v.toUpperCase();const m=String(v||'').match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);return m?'#'+[m[1],m[2],m[3]].map(x=>(+x).toString(16).padStart(2,'0')).join('').toUpperCase():null}
function updateToolbar(){if($('composerModal').hidden)return;restoreSelection();for(const b of document.querySelectorAll('.format-toggle')){let active=false;try{active=document.queryCommandState(b.dataset.command)}catch{}b.classList.toggle('active',active);b.setAttribute('aria-pressed',active?'true':'false')}let c=null;try{c=rgbHex(document.queryCommandValue('foreColor'))}catch{};if(c)currentColor=c;document.querySelector('.color-swatch').style.background=currentColor}
document.addEventListener('selectionchange',()=>{if(!$('composerModal').hidden){saveSelection();setTimeout(updateToolbar,0)}})

async function openComposer(k){
  composerArticleKey=k
  const pending=await service.pendingForArticle(k)
  $('composerText').innerHTML=pending?renderMarkup(pending.text):''
  $('composerModal').hidden=false;$('reader').classList.add('composer-open')
  $('formatRow').hidden=false;$('colorRow').hidden=true;$('sendStatus').textContent=''
  const a=displayArticles.find(x=>x.articleKey===k)
  const idx=displayArticles.findIndex(x=>x.articleKey===k)
  $('readerDate').textContent=`${idx+1}/${displayArticles.length} - page ${a.page} ${slotName(a.slot)}`
  currentColor='#000000';document.querySelector('.color-swatch').style.background=currentColor
  setTimeout(()=>{placeCaretEnd($('composerText'));$('composerText').focus();saveSelection();updateToolbar();positionComposer()},55)
}
function closeComposer(){$('composerModal').hidden=true;$('reader').classList.remove('composer-open');$('readerDate').textContent=fmtShort(currentModel.magazine.date);composerArticleKey=null;savedRange=null}
function placeCaretEnd(el){const r=document.createRange();r.selectNodeContents(el);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r)}
$('cancelComposer').onclick=closeComposer
for(const b of document.querySelectorAll('.format-toggle')){b.onpointerdown=e=>e.preventDefault();b.onclick=()=>{restoreSelection();$('composerText').focus();document.execCommand(b.dataset.command,false);saveSelection();setTimeout(updateToolbar,0)}}
$('clearText').onclick=()=>{$('composerText').innerHTML='';$('composerText').focus();saveSelection();updateToolbar()}
$('composerOptions').onclick=()=>{}
$('colorButton').onpointerdown=e=>{e.preventDefault();saveSelection()}
$('colorButton').onclick=async()=>{saveSelection();$('formatRow').hidden=true;$('colorRow').hidden=false;await colors();restoreSelection();$('composerText').focus();positionComposer()}
async function colors(){const row=$('colorRow');row.innerHTML='';const cfg=await service.getSettings(),cs=[...new Set(['#000000',...(cfg.recentColors||[]),'#FF0000','#FFD400','#0066FF','#00A651'])];for(const c of cs){const b=document.createElement('button');b.className='color-choice';b.style.background=c;b.onpointerdown=e=>e.preventDefault();b.onclick=()=>chooseColor(c);row.appendChild(b)}const lab=document.createElement('label');lab.className='color-picker-label';const inp=document.createElement('input');inp.type='color';inp.value=currentColor;inp.oninput=()=>chooseColor(inp.value);lab.appendChild(inp);row.appendChild(lab)}
async function chooseColor(c){currentColor=String(c).toUpperCase();restoreSelection();$('composerText').focus();document.execCommand('foreColor',false,currentColor);await service.rememberColor(currentColor);$('colorRow').hidden=true;$('formatRow').hidden=false;document.querySelector('.color-swatch').style.background=currentColor;setTimeout(()=>{$('composerText').focus();saveSelection();updateToolbar();positionComposer()},0)}
function nodeMarkup(n){if(n.nodeType===3)return n.nodeValue||'';if(n.nodeType!==1)return'';const t=n.tagName.toLowerCase();if(t==='br')return'\n';let x='';for(const c of n.childNodes)x+=nodeMarkup(c);if(t==='div'||t==='p')x+='\n';if(t==='b'||t==='strong')x=`**${x}**`;if(t==='u')x=`__${x}__`;if(t==='s'||t==='strike')x=`~~${x}~~`;const col=rgbHex(t==='font'?n.getAttribute('color'):n.style?.color);if(col)x=`[color=${col}]${x}[/color]`;return x}
function editorMarkup(){let x='';for(const n of $('composerText').childNodes)x+=nodeMarkup(n);return x.replace(/\n{3,}/g,'\n\n').trim()}
function positionComposer(){if($('composerModal').hidden)return;const vv=visualViewport,sheet=$('composerSheet');if(!vv){sheet.style.top='auto';sheet.style.bottom='0';return}const h=sheet.offsetHeight;sheet.style.bottom='auto';sheet.style.top=`${Math.max(0,vv.offsetTop+vv.height-h)}px`}
visualViewport?.addEventListener('resize',positionComposer);visualViewport?.addEventListener('scroll',positionComposer)
$('composerText').addEventListener('input',()=>{saveSelection();updateToolbar();positionComposer()})
$('sendText').onclick=async()=>{const b=$('sendText');try{const t=editorMarkup();if(!t)throw new Error('Message vide.');b.disabled=true;currentModel=await service.postText(composerArticleKey,t);const k=composerArticleKey;closeComposer();await refreshPending();await rebuild(k)}catch(e){status('sendStatus','Erreur : '+e.message,false)}finally{b.disabled=false}}

if(new URLSearchParams(location.search).get('settings')==='admin'){setTimeout(()=>{$('settingsView').hidden=false;$('adminPanel').open=true},150)}
