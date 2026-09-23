import './styles.css'
import { UserMaminaService } from '../backend/user-service.js'
import { clearLogs as clearTechLogs, formatLogs, onLog, info, error as logError } from '../backend/log.js'

const APP_VERSION='1.1.12'
const READER_STATE_KEY='MAMINA_READER_STATE'
const HEARTBEAT_KEY='MAMINA_HEARTBEAT'
const STORED_PASSWORD_KEY='MAMINA_STORED_PASSWORD'
const $=id=>document.getElementById(id)
const service=new UserMaminaService()

let magazines=[],currentModel=null,displayArticles=[],currentArticleIndex=0
let reactionOrder='asc',articleOrderMode='magazine',appName='MamiNa'
let composerArticleKey=null,safetyTimer=null,reconnectTimer=null,connectionClock=null,readTimer=null
let telegramState='offline',reconnecting=false,lastConnectedAt=Number(localStorage.getItem('MAMINA_LAST_CONNECTED_AT')||0)
let currentColor='#000000',savedRange=null,lastArticleCopy={text:'',at:0}
let typingState={bold:false,italic:false,underline:false,strikeThrough:false,color:null}
let activityTimer=null
const homeUrls=[],readerUrls=[]
const zoomStates=new Map()
const playedMotionVisits=new Set()
let motionVisitToken=0,motionPlaybackTimer=null,motionDraft=null,motionPrevZoom=null,motionDraw=null
const activeMotionArticles=new Set()
const DEFAULT_MOTION_EMOJI=['❤️','😂','👍','😍','😢','🎉','😘','🥰','👏','🙏','🔥','✨']
const EMOJI_RECENT_KEY='MAMINA_EMOJI_RECENT'
const EMOJI_USAGE_KEY='MAMINA_EMOJI_USAGE'
const motionAuthorUrls=[]
const avatarChoiceUrls=[]
const focusZoomStates=new Map()
let focusArticleKey=null,focusPhotoUrl=null

const status=(id,text,ok=null)=>{const e=$(id);if(!e)return;e.textContent=text;e.className='status'+(ok===true?' ok':ok===false?' error':'')}
const debug=e=>logError('ui',e?.stack||e?.message||String(e),e)
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;')
const objectUrl=(blob,bucket)=>{const u=URL.createObjectURL(blob);bucket.push(u);return u}
const freeUrls=b=>{while(b.length)URL.revokeObjectURL(b.pop())}
const fmtDate=iso=>{if(!iso)return'';const d=new Date(`${iso}T12:00:00`);return new Intl.DateTimeFormat('fr-FR',{day:'numeric',month:'long',year:'numeric'}).format(d)}
const fmtShort=iso=>{if(!iso)return'';const d=new Date(`${iso}T12:00:00`);return new Intl.DateTimeFormat('fr-FR',{day:'numeric',month:'long'}).format(d)}
const slotName=s=>s==='h'?'haut':s==='b'?'bas':'pleine page'

window.addEventListener('error',e=>logError('window.error',e.message||'Erreur globale',e.error||{filename:e.filename,lineno:e.lineno,colno:e.colno}))
window.addEventListener('unhandledrejection',e=>logError('window.rejection',e.reason?.message||String(e.reason),e.reason))
setInterval(()=>localStorage.setItem(HEARTBEAT_KEY,String(Date.now())),5000)

function setArticleBadge(text,{timeout=1900}={}){
  if($('reader').hidden)return
  const page=$('articleDeck').querySelector(`[data-index="${currentArticleIndex}"]`)
  const badge=page?.querySelector('.article-source-badge')
  if(!badge)return
  clearTimeout(badge._hideTimer)
  badge.textContent=text
  badge.hidden=false
  if(timeout>0)badge._hideTimer=setTimeout(()=>{badge.hidden=true},timeout)
}
function showActivity(text){
  if(!text)return
  clearTimeout(activityTimer)
  if(!$('reader').hidden){
    setArticleBadge(text,{timeout:1900})
    $('activityReader').hidden=true
    return
  }
  const e=$('activityHome')
  e.textContent=text
  e.hidden=false
  activityTimer=setTimeout(()=>{e.hidden=true},2400)
}
service.setActivityListener(evt=>showActivity(evt.text))

function applyTheme(v){if(v==='system')document.documentElement.removeAttribute('data-theme');else document.documentElement.dataset.theme=v}
function setAppName(v){appName=String(v||'MamiNa').trim()||'MamiNa';$('homeAppName').textContent=appName;$('readerAppName').textContent=appName;document.title=appName}
async function loadSettings(){
  const c=await service.getSettings()
  reactionOrder=c.reactionOrder
  articleOrderMode=c.articleOrderMode
  applyTheme(c.theme)
  setAppName(c.appTitle)
  $('reactionOrder').value=reactionOrder
  $('themeSelect').value=c.theme
  $('adminAppTitle').value=c.appTitle
  $('adminStoragePassword').checked=Boolean(c.storagePassword)
  if(!c.storagePassword)localStorage.removeItem(STORED_PASSWORD_KEY)
  const hasStored=Boolean(localStorage.getItem(STORED_PASSWORD_KEY))
  $('rememberMaminaPassword').textContent=c.storagePassword?'Activé':'Désactivé'
  $('storedMaminaPasswordState').textContent=c.storagePassword?(hasStored?'Mot de passe mémorisé sur cet appareil.':'Aucun mot de passe mémorisé.'):'Piloté par params : stockage désactivé.'
  $('clearStoredMaminaPassword').disabled=!hasStored
  $('appVersion').textContent=APP_VERSION
}
function elapsed(ms){const s=Math.floor(ms/1000);if(s<60)return`${s}s`;const m=Math.floor(s/60);if(m<60)return`${m}m`;return`${Math.floor(m/60)}h`}
function refreshPills(){
  const age=lastConnectedAt?Date.now()-lastConnectedAt:Infinity
  const connected=telegramState==='connected'&&!reconnecting
  const stale=age>=9*3600000
  const text=connected?'●':lastConnectedAt?(stale?'9h+':elapsed(age)):'—'
  const cls=reconnecting?'reconnecting':connected?'connected':stale?'stale':lastConnectedAt?'recent':'unknown'
  for(const id of ['connectionPillHome','connectionPillReader']){
    const e=$(id);e.textContent=text;e.className=`connection-pill ${cls}`;e.disabled=reconnecting
  }
}
function setConnectionUi(s){
  telegramState=s||'offline'
  if(s==='connected'){lastConnectedAt=Date.now();localStorage.setItem('MAMINA_LAST_CONNECTED_AT',String(lastConnectedAt))}
  $('telegramState').textContent=s||'—'
  refreshPills()
}
async function refreshPending(){
  const n=await service.pendingCount()
  for(const id of ['pendingHome','pendingReader']){
    const e=$(id);e.textContent=n;e.classList.toggle('zero',n===0)
  }
  $('pendingSettings').textContent=n
}
async function localHome(){
  await loadSettings()
  magazines=await service.magazineSummaries()
  await renderMagazineList()
  await refreshPending()
}
async function showWelcomeSplash(force=false){
  try{
    const profile=await service.localUserProfile()
    if(!profile?.name && !force)return
    const splash=$('splash')
    $('splashHello').textContent=profile?.name?`Bonjour ${profile.name}`:'Bienvenue'
    if(profile?.avatar){
      const url=URL.createObjectURL(profile.avatar)
      $('splashAvatar').src=url
      $('splashAvatar').hidden=false
      setTimeout(()=>URL.revokeObjectURL(url),3000)
    }else $('splashAvatar').hidden=true
    splash.hidden=false
    splash.style.opacity='1'
    setTimeout(()=>{splash.style.opacity='0';setTimeout(()=>splash.hidden=true,430)},2200)
  }catch{}
}
async function init(){
  $('networkState').textContent=navigator.onLine?'En ligne':'Hors ligne'
  const previousBeat=Number(localStorage.getItem(HEARTBEAT_KEY)||0)
  await showWelcomeSplash()
  try{await service.migrateDerivedArticleGeometry()}catch(e){debug(e)}
  await localHome()
  renderLogs()
  connectionClock=setInterval(refreshPills,1000)
  const saved=readReaderState()
  if(saved?.magazineId){
    if(previousBeat && Date.now()-previousBeat<30000) info('lifecycle','Reprise automatique après rechargement probable',{saved})
    await openMagazine(saved.magazineId,saved.articleKey,true)
  }
  const cfg=await service.getSettings()
  const stored=cfg.storagePassword?localStorage.getItem(STORED_PASSWORD_KEY)||'':''
  if(stored){$('password').value=stored;setTimeout(()=>$('start').click(),120)}
}
init()

function askTelegram(kind){
  const modal=$('telegramAuthModal'),input=$('telegramAuthInput'),title=$('telegramAuthTitle'),hint=$('telegramAuthHint')
  const cfg={
    phone:{title:'Numéro Telegram',type:'tel',autocomplete:'tel',inputmode:'tel',placeholder:'06 12 34 56 78',hint:'Si tu saisis un numéro français sans +, MamiNa ajoute automatiquement +33.'},
    code:{title:'Code Telegram',type:'text',autocomplete:'one-time-code',inputmode:'numeric',placeholder:'12345',hint:'Code reçu par Telegram.'},
    password:{title:'Mot de passe Telegram',type:'password',autocomplete:'current-password',inputmode:'text',placeholder:'Mot de passe 2FA',hint:'Seulement si la double authentification Telegram est active.'},
  }[kind]
  title.textContent=cfg.title;hint.textContent=cfg.hint;input.type=cfg.type;input.autocomplete=cfg.autocomplete;input.inputMode=cfg.inputmode;input.placeholder=cfg.placeholder;input.value=''
  return new Promise((resolve,reject)=>{
    const clean=()=>{$('telegramAuthForm').onsubmit=null;$('telegramAuthCancel').onclick=null}
    $('telegramAuthForm').onsubmit=e=>{e.preventDefault();const v=input.value.trim();if(!v)return;clean();modal.close();resolve(v)}
    $('telegramAuthCancel').onclick=()=>{clean();modal.close();reject(new Error('Connexion Telegram annulée.'))}
    modal.showModal();setTimeout(()=>input.focus(),70)
  })
}
service.setAuthProvider({phone:()=>askTelegram('phone'),code:()=>askTelegram('code'),password:()=>askTelegram('password')})

$('start').onclick=async()=>{
  $('start').disabled=true
  try{
    status('setupStatus','Déverrouillage…')
    showActivity('Déverrouillage des accès…')
    const maminaPassword=$('password').value
    await service.unlock(maminaPassword)
    if(await service.maminaPasswordStorageEnabled())localStorage.setItem(STORED_PASSWORD_KEY,maminaPassword)
    else localStorage.removeItem(STORED_PASSWORD_KEY)
    $('setup').hidden=true
    await localHome()
    const me=await service.login()
    await showWelcomeSplash(true)
    const {models,selected}=await service.restoreOrSelectDialog()
    if(!selected){
      const s=$('groupSelect');s.innerHTML=''
      models.forEach((m,i)=>{const o=document.createElement('option');o.value=i;o.textContent=m.title;s.appendChild(o)})
      window.__groups=models
      $('setup').hidden=false;$('groupChooser').hidden=false
      status('setupStatus',`Connecté : ${me.displayName||'Telegram'} — choisis le groupe.`,true)
      return
    }
    startNetwork()
  }catch(e){
    debug(e);$('setup').hidden=false;status('setupStatus','Erreur : '+(e.message||e),false)
  }finally{$('start').disabled=false}
}
$('chooseGroup').onclick=async()=>{try{const m=(window.__groups||[])[+$('groupSelect').value];await service.selectDialog(m);$('setup').hidden=true;startNetwork()}catch(e){debug(e)}}

function startNetwork(){
  service.onConnectionState=setConnectionUi
  setConnectionUi(service.connectionState())
  service.onChanged=async()=>{
    await localHome()
    if(currentModel){
      const fresh=await service.openMagazineLocalFirst(currentModel.magazine.magazineId)
      currentModel=fresh
      const byKey=new Map(fresh.articles.map(a=>[a.articleKey,a]))
      displayArticles=displayArticles.map(a=>byKey.has(a.articleKey)?{...a,...byKey.get(a.articleKey)}:a)
      rerenderCommentOrderOnly()
      updateReaderPageLabel()
      updateMotionReplayHeader()
      await refreshPending()
    }
  }
  clearInterval(safetyTimer)
  safetyTimer=setInterval(()=>{if(document.visibilityState==='visible'&&navigator.onLine)backgroundSync()},30000)
  clearInterval(reconnectTimer)
  reconnectTimer=setInterval(()=>{if(document.visibilityState==='visible'&&navigator.onLine&&service.connectionState()!=='connected')forceReconnect('watchdog')},10000)
  backgroundSync()
}
async function forceReconnect(reason='manual'){
  if(reconnecting||!service.hasGateway()||!navigator.onLine)return
  reconnecting=true;refreshPills();showActivity('Reconnexion à Telegram…')
  try{
    await service.reconnectAndFlush(reason)
    setConnectionUi('connected')
    await refreshPending()
    await backgroundSync()
  }catch(e){debug(e)}
  finally{reconnecting=false;refreshPills()}
}
$('connectionPillHome').onclick=()=>forceReconnect('pastille')
$('connectionPillReader').onclick=()=>forceReconnect('pastille')
async function refreshOpenMagazineLocal(){
  if(!currentModel?.magazine?.magazineId)return
  const keep=currentArticle()?.articleKey
  const fresh=await service.openMagazineLocalFirst(currentModel.magazine.magazineId)
  currentModel=fresh
  const byKey=new Map(fresh.articles.map(a=>[a.articleKey,a]))
  displayArticles=displayArticles.map(a=>byKey.has(a.articleKey)?{...a,...byKey.get(a.articleKey)}:a)
  const idx=displayArticles.findIndex(a=>a.articleKey===keep)
  if(idx>=0)currentArticleIndex=idx
  rerenderCommentOrderOnly()
  updateReaderPageLabel()
  updateMotionReplayHeader()
}
async function backgroundSync(){
  if(!service.hasGateway()||!service.hasDialog())return
  try{
    await service.syncAll()
    await service.flushOutbox(true)
    await localHome()
    await refreshOpenMagazineLocal()
    $('lastSyncState').textContent=new Date().toLocaleTimeString('fr-FR')
    await refreshPending()
  }catch(e){debug(e)}
}
const resume=()=>{if(document.visibilityState==='visible'&&navigator.onLine)forceReconnect('reprise')}
window.addEventListener('online',()=>{$('networkState').textContent='En ligne';setTimeout(()=>forceReconnect('retour réseau'),150)})
window.addEventListener('offline',()=>{$('networkState').textContent='Hors ligne';setConnectionUi('offline')})
window.addEventListener('focus',resume)
window.addEventListener('pageshow',resume)
document.addEventListener('visibilitychange',resume)

/* Home */
async function renderMagazineList(){
  const h=$('magazines');h.innerHTML='';freeUrls(homeUrls)
  if(!magazines.length){h.innerHTML='<p class="empty">Aucune revue locale.</p>';return}
  for(const m of magazines){
    const b=document.createElement('button');b.className='magazine-card'
    b.innerHTML=`${m.cover?`<img src="${objectUrl(m.cover,homeUrls)}" alt="Couverture">`:''}<div class="magazine-info"><div class="magazine-title">${esc(m.title)}${m.issue?` · N°${m.issue}`:''}</div><div>${esc(fmtDate(m.date))}</div><div class="magazine-stats"><span>${m.reactionCount||0} réactions</span><span>✨ ${m.motionCount||0}</span><span class="unread">${m.unreadCount||0} non lues</span></div></div>`
    b.onclick=()=>openMagazine(m.magazineId)
    h.appendChild(b)
  }
}
function readReaderState(){try{return JSON.parse(localStorage.getItem(READER_STATE_KEY)||'null')}catch{return null}}
function saveReaderState(articleKey=currentArticle()?.articleKey){
  if(!currentModel?.magazine?.magazineId)return
  localStorage.setItem(READER_STATE_KEY,JSON.stringify({magazineId:currentModel.magazine.magazineId,articleKey:articleKey||null,at:Date.now()}))
}
function clearReaderState(){localStorage.removeItem(READER_STATE_KEY)}

async function openMagazine(id,preferredArticleKey=null,restoring=false){
  try{
    showActivity(restoring?'Restauration de la revue…':'Ouverture locale de la revue…')
    currentModel=await service.openMagazineLocalFirst(id)
    await loadSettings()
    displayArticles=orderArticles(currentModel.articles)
    const preferred=preferredArticleKey?displayArticles.findIndex(a=>a.articleKey===preferredArticleKey):-1
    const unread=displayArticles.findIndex(a=>a.unreadCount>0)
    currentArticleIndex=preferred>=0?preferred:(unread>=0?unread:0)
    $('home').hidden=true;$('reader').hidden=false
    saveReaderState(displayArticles[currentArticleIndex]?.articleKey)
    await renderReader()
    setTimeout(()=>maybeOfferFamileoAvatar(),420)
    if(displayArticles.some(a=>!a.photoBounds||!a.authorName)){
      setTimeout(async()=>{
        try{
          await service.ensureCurrentPdf()
          const keep=currentArticle()?.articleKey
          currentModel=await service.currentView()
          displayArticles=orderArticles(currentModel.articles)
          const idx=displayArticles.findIndex(a=>a.articleKey===keep)
          if(idx>=0)currentArticleIndex=idx
        }catch(e){debug(e)}
      },500)
    }
  }catch(e){
    if(restoring)clearReaderState();else alert(e.message)
    debug(e)
  }
}
$('back').onclick=async()=>{
  if(!$('contributionPopup').hidden){closeContributionPopup();return}
  if(!$('avatarPopup').hidden){closeAvatarPopup();return}
  if(!$('motionComposer').hidden){closeMotionComposer({restoreZoom:true});return}
  if(!$('composerModal').hidden)return
  clearReaderState();$('reader').hidden=true;$('home').hidden=false
  freeUrls(readerUrls);zoomStates.clear();await service.closeMagazine();currentModel=null;await localHome()
}

function magRank(a){return[Number(a.page||0),({h:0,p:0,b:1}[a.slot]??0)]}
function latest(a,unread=false){let n=0;for(const c of a.comments||[]){if(c.pending)continue;if(unread&&(c.isOutgoing||c.id<=a.lastReadMessageId))continue;n=Math.max(n,+c.id||0)}return n}
function orderArticles(rows){
  const a=[...rows]
  if(articleOrderMode==='magazine')return a.sort((x,y)=>{const X=magRank(x),Y=magRank(y);return X[0]-Y[0]||X[1]-Y[1]})
  return a.sort((x,y)=>{
    const bucket=v=>v.unreadCount>0?0:(v.comments?.some(c=>!c.pending)?1:2),bx=bucket(x),by=bucket(y)
    if(bx!==by)return bx-by
    const d=by===0?latest(y,true)-latest(x,true):by===1?latest(y)-latest(x):0
    if(d)return d
    const X=magRank(x),Y=magRank(y);return X[0]-Y[0]||X[1]-Y[1]
  })
}
const currentArticle=()=>displayArticles[currentArticleIndex]
const slotLong=s=>s==='h'?'haut':s==='b'?'bas':''
function ownContributions(article=currentArticle()){
  if(!article)return[]
  const rows=[]
  for(const m of article.comments||[]){if(m.isOutgoing||m.pending)rows.push({kind:'message',date:m.date||'',id:Number(m.id||0),row:m})}
  for(const m of article.motions||[]){if(m.isOutgoing||m.pending)rows.push({kind:'motion',date:m.date||'',id:Number(m.id||0),row:m})}
  return rows.sort((a,b)=>{const da=Date.parse(a.date)||0,db=Date.parse(b.date)||0;return da-db||a.id-b.id})
}
function updateReaderPageLabel(){
  const a=currentArticle(),host=$('readerPage');if(!a||!host)return
  const suffix=slotLong(a.slot),label=`Article ${currentArticleIndex+1}/${displayArticles.length} - Page ${a.page}${suffix?' '+suffix:''}`
  host.innerHTML=''
  const span=document.createElement('span');span.className='reader-page-text';span.textContent=label;host.appendChild(span)
  if(ownContributions(a).length){const b=document.createElement('button');b.type='button';b.className='reader-page-more';b.textContent='…';b.title='Mes contributions';b.setAttribute('aria-label','Mes contributions');b.onclick=e=>{e.stopPropagation();openContributionPopup()};host.appendChild(b)}
}
function motionOptionLabel(mode){return({stable:'Stable',grow:'Agrandit',shrink:'Rétrécit',pulse:'Petit-grand-petit','inverse-pulse':'Grand-petit-grand',explosion:'Explosion',rain:'Pluie',cloud:'Nuage',random:'Aléatoire'})[mode]||'Animation'}
function closeContributionPopup(){$('contributionPopup').hidden=true;$('contributionPopupStatus').textContent=''}
async function refreshReaderAfterContributionChange(view,articleKey){
  currentModel=view
  const fresh=view?.articles?.find(a=>a.articleKey===articleKey),idx=displayArticles.findIndex(a=>a.articleKey===articleKey)
  if(fresh&&idx>=0)displayArticles[idx]=fresh
  const list=$('articleDeck').querySelector(`[data-index="${idx}"] .reaction-list`);if(list&&fresh)renderComments(fresh,list)
  updateReaderPageLabel();updateMotionReplayHeader();await refreshPending()
}
function renderContributionPopup(){
  const host=$('contributionPopupList'),items=ownContributions();host.innerHTML=''
  if(!items.length){host.innerHTML='<div class="empty">Aucune contribution à supprimer.</div>';return}
  for(const item of items){
    const row=item.row,e=document.createElement('div');e.className='contribution-row'
    const preview=document.createElement('div');preview.className='contribution-preview'
    const kind=document.createElement('div');kind.className='contribution-kind';kind.textContent=(item.kind==='motion'?'Animation':'Message')+(row.pending?' · hors ligne':'')
    const body=document.createElement('div')
    if(item.kind==='motion'){
      body.className='contribution-motion'
      const motion=row.motion||row.meta?.motion||{},emojis=(motion.emoji||[]).map(codepointsToString).join(' ')
      body.textContent=`${emojis||'✨'} · ${motionOptionLabel(motion.scale)}`
    }else{body.className='contribution-message';body.textContent=row.displayText||row.text||''}
    preview.append(kind,body)
    const del=document.createElement('button');del.type='button';del.className='contribution-delete';del.textContent='🗑️';del.title='Supprimer';del.setAttribute('aria-label','Supprimer cette contribution')
    del.onclick=async()=>{del.disabled=true;status('contributionPopupStatus','Suppression…');try{const view=await service.deleteOwnContribution({articleKey:currentArticle().articleKey,kind:item.kind,messageId:row.pending?null:row.id,pendingId:row.pendingId||null});await refreshReaderAfterContributionChange(view,currentArticle().articleKey);renderContributionPopup();requestAnimationFrame(()=>{const h=$('contributionPopupList');h.scrollTop=h.scrollHeight});status('contributionPopupStatus','Supprimé.',true)}catch(err){debug(err);status('contributionPopupStatus','Erreur : '+(err.message||err),false);del.disabled=false}}
    e.append(preview,del);host.appendChild(e)
  }
  requestAnimationFrame(()=>{host.scrollTop=host.scrollHeight})
}
function openContributionPopup(){if(!ownContributions().length)return;renderContributionPopup();$('contributionPopup').hidden=false}
$('contributionPopupClose').onclick=closeContributionPopup
$('contributionPopup').addEventListener('click',e=>{if(e.target===$('contributionPopup'))closeContributionPopup()})

function closeAvatarPopup(){freeUrls(avatarChoiceUrls);$('avatarPopup').hidden=true;$('avatarPopupStatus').textContent=''}
$('avatarPopupClose').onclick=closeAvatarPopup
$('avatarPopup').addEventListener('click',e=>{if(e.target===$('avatarPopup'))closeAvatarPopup()})
function waitForImage(img,timeout=3500){return new Promise(resolve=>{if(img?.complete&&img.naturalWidth)return resolve(img);let done=false;const end=()=>{if(done)return;done=true;clearTimeout(timer);resolve(img?.naturalWidth?img:null)};const timer=setTimeout(end,timeout);img?.addEventListener('load',end,{once:true});img?.addEventListener('error',end,{once:true})})}
async function fillAvatarChoiceImage(button,article,index){
  try{await loadVisual(index);const img=await waitForImage(articleImg(index));if(!img||$('avatarPopup').hidden)return;const url=cropImage(img,article.avatarBounds);if(!url)return;const placeholder=button.querySelector('.avatar-placeholder');if(placeholder){const pic=document.createElement('img');pic.alt=`Avatar ${article.authorName||''}`;pic.src=url;placeholder.replaceWith(pic);avatarChoiceUrls.push(url)}}catch(e){debug(e)}
}
async function maybeOfferFamileoAvatar(){
  if(!currentModel||!['connected','updating'].includes(service.connectionState())||!$('avatarPopup').hidden)return
  try{
    const state=await service.avatarAssociationState();if(state.own)return
    const assigned=new Set((state.assignedNames||[]).map(x=>String(x).trim().toLocaleLowerCase('fr'))),seen=new Set(),choices=[]
    for(let i=0;i<displayArticles.length;i++){
      const a=displayArticles[i],name=String(a.authorName||'').trim(),key=name.toLocaleLowerCase('fr')
      if(!name||!a.avatarBounds||seen.has(key)||assigned.has(key))continue
      seen.add(key);choices.push({name,article:a,index:i})
    }
    if(!choices.length)return
    const host=$('avatarPopupGrid');host.innerHTML='';freeUrls(avatarChoiceUrls)
    for(const choice of choices){
      const b=document.createElement('button');b.type='button';b.className='avatar-choice';b.innerHTML=`<div class="avatar-placeholder">${esc(choice.name.slice(0,1).toUpperCase())}</div><span>${esc(choice.name)}</span>`
      b.onclick=async()=>{for(const x of host.querySelectorAll('button'))x.disabled=true;status('avatarPopupStatus','Association…');try{await service.assignFamileoAvatar(choice.name);status('avatarPopupStatus','Avatar associé.',true);setTimeout(closeAvatarPopup,280)}catch(err){debug(err);status('avatarPopupStatus','Erreur : '+(err.message||err),false);for(const x of host.querySelectorAll('button'))x.disabled=false}}
      host.appendChild(b);fillAvatarChoiceImage(b,choice.article,choice.index)
    }
    $('avatarPopup').hidden=false
  }catch(e){debug(e)}
}
async function rebuild(key){
  displayArticles=orderArticles(currentModel.articles)
  const i=displayArticles.findIndex(a=>a.articleKey===key)
  currentArticleIndex=i>=0?i:0
  await renderReader()
}
function updateArticleOrderButton(){
  const b=$('articleOrderButton')
  if(!b)return
  b.textContent=articleOrderMode==='magazine'?'Revue':'Récent'
  b.title=articleOrderMode==='magazine'
    ?'Ordre de la revue — toucher pour classer par activité'
    :'Non lus récents, puis lus récents, puis ordre revue'
}
$('articleOrderButton').onclick=async()=>{
  if(!$('composerModal').hidden)return
  const keep=currentArticle()?.articleKey
  articleOrderMode=articleOrderMode==='magazine'?'activity':'magazine'
  await service.setArticleOrderMode(articleOrderMode)
  displayArticles=orderArticles(currentModel.articles)
  const idx=displayArticles.findIndex(a=>a.articleKey===keep)
  currentArticleIndex=idx>=0?idx:0
  await renderReader()
}

$('messageOrderHeader').onclick=async()=>{
  reactionOrder=reactionOrder==='asc'?'desc':'asc'
  $('messageOrderHeader').textContent=reactionOrder==='asc'?'↑':'↓'
  await service.setReactionOrder(reactionOrder)
  rerenderCommentOrderOnly()
}
$('motionReplayHeader').onclick=()=>{
  const a=currentArticle()
  if(!a?.motions?.length||activeMotionArticles.has(a.articleKey))return
  playArticleMotions(a,currentArticleIndex,{force:true})
}

function renderMarkup(t=''){
  let s=esc(t)
  s=s.replace(/\[mark\]([\s\S]*?)\[\/mark\]/g,'<mark style="background:#dff1ff">$1</mark>')
  s=s.replace(/\[color=(#[0-9a-fA-F]{6})\]([\s\S]*?)\[\/color\]/g,'<span style="color:$1">$2</span>')
  s=s.replace(/\*\*([\s\S]+?)\*\*/g,'<strong>$1</strong>')
  s=s.replace(/__([\s\S]+?)__/g,'<u>$1</u>')
  s=s.replace(/~~([\s\S]+?)~~/g,'<s>$1</s>')
  s=s.replace(/(^|[^*])\*([^*\n]+?)\*/g,'$1<em>$2</em>')
  return s.replace(/\n/g,'<br>')
}
async function renderReader(){
  freeUrls(readerUrls)
  $('readerDate').textContent=fmtShort(currentModel.magazine.date)
  updateArticleOrderButton()
  $('messageOrderHeader').textContent=reactionOrder==='asc'?'↑':'↓'
  const d=$('articleDeck');d.innerHTML=''
  displayArticles.forEach((a,i)=>{
    const p=document.createElement('section');p.className='article-page';p.dataset.index=i
    const v=document.createElement('div');v.className='article-visual'
    v.innerHTML=`<div class="subtle">Chargement…</div><span class="article-source-badge" hidden></span><div class="article-actions"><button class="article-float add-motion" title="Réaction animée">♥</button><button class="article-float add-message" title="Ajouter">＋</button></div><svg class="motion-draw-layer" hidden aria-hidden="true"><path class="motion-draw-path"></path></svg><div class="motion-play-layer" aria-hidden="true"></div>`
    p.appendChild(v)
    const list=document.createElement('div');list.className='reaction-list';renderComments(a,list);p.appendChild(list)
    d.appendChild(p)
    v.querySelector('.add-message').onclick=()=>openComposer(a.articleKey)
    v.querySelector('.add-motion').onclick=()=>openMotionComposer(i)
    installArticleGestures(v,i)
  })
  d.classList.add('aligning')
  requestAnimationFrame(()=>{
    d.scrollLeft=currentArticleIndex*d.clientWidth
    activate(currentArticleIndex)
    requestAnimationFrame(()=>{d.scrollLeft=currentArticleIndex*d.clientWidth;d.classList.remove('aligning')})
  })
}
function renderComments(a,list){
  list.innerHTML=''
  let c=[...(a.comments||[])];if(reactionOrder==='desc')c.reverse()
  if(!c.length){list.innerHTML='<div class="empty">Aucune réaction.</div>';return}
  for(const x of c){
    const e=document.createElement('div')
    e.className='reaction'+(x.pending?' pending':'')+(!x.isOutgoing&&!x.pending&&x.id>a.lastReadMessageId?' unread-reaction':'')
    e.dataset.messageId=x.id
    e.innerHTML=`<div class="reaction-meta">${esc(x.author)}${x.pending?'':` · ${new Date(x.date||Date.now()).toLocaleString('fr-FR')}`}</div><div class="reaction-text">${renderMarkup(x.displayText||'')}</div>`
    if(x.pending)e.onclick=()=>openComposer(a.articleKey)
    list.appendChild(e)
  }
}
function rerenderCommentOrderOnly(){
  for(let i=0;i<displayArticles.length;i++){
    const page=$('articleDeck').querySelector(`[data-index="${i}"]`)
    const list=page?.querySelector('.reaction-list')
    if(list)renderComments(displayArticles[i],list)
  }
  const list=$('articleDeck').querySelector(`[data-index="${currentArticleIndex}"] .reaction-list`)
  if(list)requestAnimationFrame(()=>{list.scrollTop=reactionOrder==='asc'?list.scrollHeight:0})
}
async function loadVisual(i){
  const p=$('articleDeck').querySelector(`[data-index="${i}"]`),v=p?.querySelector('.article-visual')
  if(!v||v.querySelector('img'))return
  try{
    const result=await service.getArticleImageInfo(displayArticles[i].articleKey)
    const img=document.createElement('img')
    img.src=objectUrl(result.blob,readerUrls)
    img.onload=()=>{
      const desired=Math.min(innerHeight*.58, v.clientWidth*(img.naturalHeight/img.naturalWidth))
      if(Number.isFinite(desired)&&desired>180) v.style.flexBasis=`${Math.round(desired)}px`
      v._pz?.apply()
      if(i===currentArticleIndex){const deck=$('articleDeck');deck.scrollLeft=i*deck.clientWidth}
    }
    v.querySelector('.subtle')?.remove()
    const badge=v.querySelector('.article-source-badge')
    if(badge){
      clearTimeout(badge._hideTimer)
      badge.textContent=result.source
      badge.hidden=false
      badge._hideTimer=setTimeout(()=>{badge.hidden=true},1800)
    }
    v.prepend(img);v._pz?.apply()
  }catch(e){debug(e)}
}
function warmAround(i){
  const keys=[]
  for(const j of [i+1,i-1])if(j>=0&&j<displayArticles.length)keys.push(displayArticles[j].articleKey)
  if(keys.length)setTimeout(()=>service.warmArticleImages(keys),120)
}
function activate(i){
  hideMotionAuthors()
  currentArticleIndex=i
  saveReaderState(currentArticle()?.articleKey)
  updateReaderPageLabel()
  updateMotionReplayHeader()
  ;[i,i-1,i+1].forEach(loadVisual)
  setTimeout(()=>warmAround(i),0)
  const a=currentArticle(),list=$('articleDeck').querySelector(`[data-index="${i}"] .reaction-list`)
  const unread=(a.comments||[]).filter(c=>!c.pending&&!c.isOutgoing&&c.id>a.lastReadMessageId).sort((x,y)=>x.id-y.id)
  requestAnimationFrame(()=>{if(unread.length)list.querySelector(`[data-message-id="${unread[0].id}"]`)?.scrollIntoView({block:'start'});else list.scrollTop=reactionOrder==='asc'?list.scrollHeight:0})
  clearTimeout(readTimer);readTimer=setTimeout(()=>service.markArticleRead(a.articleKey),1400)
  scheduleArticleMotions(a,i)
}
let scrollTimer
$('articleDeck').onscroll=()=>{if(!$('composerModal').hidden||!$('motionComposer').hidden)return;clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>{const d=$('articleDeck'),i=Math.max(0,Math.min(displayArticles.length-1,Math.round(d.scrollLeft/d.clientWidth))),left=i*d.clientWidth;if(Math.abs(d.scrollLeft-left)>1)d.scrollTo({left,behavior:'auto'});if(i!==currentArticleIndex)activate(i)},90)}
function goArticle(delta){if(!$('composerModal').hidden||!$('motionComposer').hidden)return;const next=Math.max(0,Math.min(displayArticles.length-1,currentArticleIndex+delta));if(next===currentArticleIndex)return;const d=$('articleDeck');d.scrollTo({left:next*d.clientWidth,behavior:'smooth'});setTimeout(()=>activate(next),190)}

function clampPan(container,img,scale,tx,ty){
  if(!img||scale<=1)return {tx:0,ty:0}
  const cw=container.clientWidth,ch=container.clientHeight
  const nw=img.naturalWidth||cw,nh=img.naturalHeight||ch
  const fit=Math.min(cw/nw,ch/nh),bw=nw*fit,bh=nh*fit
  const mx=Math.max(0,(bw*scale-cw)/2),my=Math.max(0,(bh*scale-ch)/2)
  return {tx:Math.max(-mx,Math.min(mx,tx)),ty:Math.max(-my,Math.min(my,ty))}
}
function installArticleGestures(container,index){
  const key=displayArticles[index].articleKey
  let st=zoomStates.get(key)||{scale:1,tx:0,ty:0}
  let start=null,pinch=null,lastTap=0,lastMove=null,raf=null
  const img=()=>container.querySelector('img')
  const persist=()=>zoomStates.set(key,{scale:st.scale,tx:st.tx,ty:st.ty})
  const apply=()=>{
    const im=img();if(!im)return
    const c=clampPan(container,im,st.scale,st.tx,st.ty);st.tx=c.tx;st.ty=c.ty
    im.style.transform=`translate(${st.tx}px,${st.ty}px) scale(${st.scale})`;persist()
  }
  const reset=()=>{st={scale:1,tx:0,ty:0};apply()}
  const setState=next=>{st={scale:Math.max(1,Math.min(4,Number(next?.scale)||1)),tx:Number(next?.tx)||0,ty:Number(next?.ty)||0};apply()}
  container._pz={get scale(){return st.scale},reset,apply,snapshot:()=>({...st}),setState}

  container.addEventListener('touchstart',e=>{
    if(motionDraw?.v===container)return
    if(e.target.closest('button'))return
    if(raf)cancelAnimationFrame(raf)
    if(e.touches.length===1){
      const t=e.touches[0];start={x:t.clientX,y:t.clientY,tx:st.tx,ty:st.ty,time:performance.now()}
      lastMove={x:t.clientX,y:t.clientY,time:performance.now(),vx:0,vy:0}
    }else if(e.touches.length===2){
      const[a,b]=e.touches;pinch={d:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),scale:st.scale}
    }
  },{passive:true})
  container.addEventListener('touchmove',e=>{
    if(motionDraw?.v===container)return
    if(e.touches.length===2&&pinch){
      e.preventDefault()
      const[a,b]=e.touches
      st.scale=Math.max(1,Math.min(4,pinch.scale*Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY)/pinch.d))
      apply()
    }else if(e.touches.length===1&&start&&st.scale>1){
      e.preventDefault()
      const t=e.touches[0],now=performance.now(),dt=Math.max(1,now-lastMove.time)
      st.tx=start.tx+t.clientX-start.x;st.ty=start.ty+t.clientY-start.y
      lastMove={x:t.clientX,y:t.clientY,time:now,vx:(t.clientX-lastMove.x)/dt,vy:(t.clientY-lastMove.y)/dt}
      apply()
    }
  },{passive:false})
  container.addEventListener('touchend',e=>{
    if(motionDraw?.v===container){start=null;pinch=null;return}
    if(start&&e.changedTouches?.length){
      const t=e.changedTouches[0],dx=t.clientX-start.x,dy=t.clientY-start.y,dur=performance.now()-start.time
      if($('composerModal').hidden&&$('motionComposer').hidden&&st.scale===1&&Math.abs(dx)>55&&Math.abs(dx)>Math.abs(dy)*1.15){goArticle(dx<0?1:-1);start=null;pinch=null;return}
      if(st.scale>1&&lastMove){
        let vx=lastMove.vx*18,vy=lastMove.vy*18
        const inertia=()=>{
          vx*=.91;vy*=.91;st.tx+=vx;st.ty+=vy;apply()
          if(Math.abs(vx)+Math.abs(vy)>.35)raf=requestAnimationFrame(inertia)
        }
        raf=requestAnimationFrame(inertia)
      }
      if(Math.abs(dx)<14&&Math.abs(dy)<14&&dur<280){
        const now=Date.now()
        if(now-lastTap<330){handleDoubleTap(container,index,t.clientX,t.clientY);lastTap=0}else lastTap=now
      }
    }
    start=null;pinch=null
  })
}

function motionPage(index=currentArticleIndex){return $('articleDeck').querySelector(`[data-index="${index}"]`)}
function motionVisual(index=currentArticleIndex){return motionPage(index)?.querySelector('.article-visual')}
function motionImage(index=currentArticleIndex){return motionVisual(index)?.querySelector('img')}
function clamp01Motion(n){return Math.max(0,Math.min(1,Number(n)||0))}
function codepointsToString(value){
  if(typeof value!=='string')return''
  if(!/^[0-9A-F]+(?:-[0-9A-F]+)*$/i.test(value))return value
  try{return value.split('-').map(x=>String.fromCodePoint(parseInt(x,16))).join('')}catch{return''}
}
function stringToCodepoints(value){return Array.from(String(value||'')).map(ch=>ch.codePointAt(0).toString(16).toUpperCase()).join('-')}
function motionPointAt(curve,t){
  const u=1-t,p0=curve.p0,p1=curve.p1,p2=curve.p2,p3=curve.p3
  return [u*u*u*p0[0]+3*u*u*t*p1[0]+3*u*t*t*p2[0]+t*t*t*p3[0],u*u*u*p0[1]+3*u*u*t*p1[1]+3*u*t*t*p2[1]+t*t*t*p3[1]]
}
function motionDerivatives(curve,t,rect){
  const u=1-t,p0=curve.p0,p1=curve.p1,p2=curve.p2,p3=curve.p3
  const dx=(3*u*u*(p1[0]-p0[0])+6*u*t*(p2[0]-p1[0])+3*t*t*(p3[0]-p2[0]))*rect.width
  const dy=(3*u*u*(p1[1]-p0[1])+6*u*t*(p2[1]-p1[1])+3*t*t*(p3[1]-p2[1]))*rect.height
  const ddx=(6*u*(p2[0]-2*p1[0]+p0[0])+6*t*(p3[0]-2*p2[0]+p1[0]))*rect.width
  const ddy=(6*u*(p2[1]-2*p1[1]+p0[1])+6*t*(p3[1]-2*p2[1]+p1[1]))*rect.height
  const len=Math.max(.001,Math.hypot(dx,dy)),tx=dx/len,ty=dy/len,nx=-ty,ny=tx,side=(ddx*nx+ddy*ny)>=0?1:-1
  return {tx,ty,nx:nx*side,ny:ny*side}
}
function motionScaleAt(mode,t){
  const small=.16,big=4.80,range=big-small
  if(mode==='grow')return small+range*t
  if(mode==='shrink')return big-range*t
  if(mode==='pulse')return small+range*Math.sin(Math.PI*t)
  if(mode==='inverse-pulse')return big-range*Math.sin(Math.PI*t)
  return 1
}
function motionEmojiBlend(emojis,t){
  if(emojis.length<=1)return {a:emojis[0]||'',b:'',mix:0}
  const boundaries=emojis.length===2?[.5]:[1/3,2/3],window=.14
  for(let i=0;i<boundaries.length;i++){
    const b=boundaries[i],from=Math.max(0,b-window),to=Math.min(1,b+window)
    if(t>=from&&t<=to)return {a:emojis[i],b:emojis[i+1],mix:(t-from)/Math.max(.001,to-from)}
  }
  const idx=emojis.length===2?(t<.5?0:1):Math.min(2,Math.floor(t*3))
  return {a:emojis[idx],b:'',mix:0}
}
function renderedImageRect(img){
  const er=img.getBoundingClientRect(),bw=Math.max(1,img.clientWidth||er.width),bh=Math.max(1,img.clientHeight||er.height),nw=Math.max(1,img.naturalWidth||bw),nh=Math.max(1,img.naturalHeight||bh)
  const fit=Math.min(bw/nw,bh/nh),rw=nw*fit,rh=nh*fit,ratioW=rw/bw,ratioH=rh/bh,w=er.width*ratioW,h=er.height*ratioH
  return {left:er.left+(er.width-w)/2,top:er.top+(er.height-h)/2,width:w,height:h,right:er.left+(er.width+w)/2,bottom:er.top+(er.height+h)/2}
}
function imageRectInContainer(container,img){
  const cr=container.getBoundingClientRect(),ir=renderedImageRect(img)
  return {left:ir.left-cr.left,top:ir.top-cr.top,width:ir.width,height:ir.height,screen:ir}
}
function fitBezier(points){
  if(points.length<2)return null
  const pts=[]
  let prev=null,total=0
  for(const p of points){
    if(prev){const d=Math.hypot(p.x-prev.x,p.y-prev.y);if(d<2.5)continue;total+=d}
    pts.push({...p,s:total});prev=p
  }
  if(pts.length<2||total<8)return null
  const p0=[pts[0].nx,pts[0].ny],p3=[pts.at(-1).nx,pts.at(-1).ny]
  let aa=0,ab=0,bb=0,rx1=0,rx2=0,ry1=0,ry2=0
  for(const p of pts){
    const t=total?p.s/total:0,u=1-t,a=3*u*u*t,b=3*u*t*t
    const cx=u*u*u*p0[0]+t*t*t*p3[0],cy=u*u*u*p0[1]+t*t*t*p3[1]
    aa+=a*a;ab+=a*b;bb+=b*b;rx1+=a*(p.nx-cx);rx2+=b*(p.nx-cx);ry1+=a*(p.ny-cy);ry2+=b*(p.ny-cy)
  }
  const det=aa*bb-ab*ab
  let p1,p2
  if(Math.abs(det)>1e-8){
    p1=[(rx1*bb-rx2*ab)/det,(ry1*bb-ry2*ab)/det]
    p2=[(aa*rx2-ab*rx1)/det,(aa*ry2-ab*ry1)/det]
  }else{
    const one=pts[Math.max(1,Math.floor((pts.length-1)/3))],two=pts[Math.max(1,Math.floor((pts.length-1)*2/3))]
    p1=[one.nx,one.ny];p2=[two.nx,two.ny]
  }
  const clampP=p=>p.map(clamp01Motion)
  const duration=Math.max(1500,Math.min(3800,Math.round(1150+total*2.0)))
  return {curve:{p0:clampP(p0),p1:clampP(p1),p2:clampP(p2),p3:clampP(p3)},duration}
}
function renderMotionSelection(){
  const host=$('motionSelected');host.innerHTML=''
  for(const [i,e] of (motionDraft?.emoji||[]).entries()){
    const b=document.createElement('button');b.type='button';b.textContent=e;b.title='Retirer';b.onclick=()=>{motionDraft.emoji.splice(i,1);renderMotionSelection();updateMotionPanel()};host.appendChild(b)
  }
  if(!host.children.length)host.innerHTML='<span class="subtle">Aucun emoji sélectionné</span>'
}
function safeJson(key,fallback){try{return JSON.parse(localStorage.getItem(key)||'null')??fallback}catch{return fallback}}
function emojiGraphemes(value){
  const text=String(value||'')
  const seg=typeof Intl?.Segmenter==='function'?new Intl.Segmenter('fr',{granularity:'grapheme'}):null
  const parts=seg?[...seg.segment(text)].map(x=>x.segment):Array.from(text)
  return parts.filter(x=>/\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u20E3/u.test(x))
}
function rememberMotionEmoji(emoji){
  const e=String(emoji||'');if(!e)return
  const recent=safeJson(EMOJI_RECENT_KEY,[]).filter(x=>x!==e);recent.unshift(e);localStorage.setItem(EMOJI_RECENT_KEY,JSON.stringify(recent.slice(0,20)))
  const usage=safeJson(EMOJI_USAGE_KEY,{}),row=usage[e]||{count:0,last:0};usage[e]={count:Number(row.count||0)+1,last:Date.now()};localStorage.setItem(EMOJI_USAGE_KEY,JSON.stringify(usage))
}
function quickMotionEmoji(){
  const recent=safeJson(EMOJI_RECENT_KEY,[]),usage=safeJson(EMOJI_USAGE_KEY,{})
  const out=[];for(const e of recent.slice(0,6))if(!out.includes(e))out.push(e)
  const frequent=Object.entries(usage).sort((a,b)=>Number(b[1]?.count||0)-Number(a[1]?.count||0)||Number(b[1]?.last||0)-Number(a[1]?.last||0)).map(x=>x[0])
  for(const e of frequent)if(out.length<12&&!out.includes(e))out.push(e)
  for(const e of DEFAULT_MOTION_EMOJI)if(out.length<12&&!out.includes(e))out.push(e)
  return out.slice(0,12)
}
function addMotionEmoji(e){
  if(!motionDraft||motionDraft.emoji.length>=3||!e)return
  motionDraft.emoji.push(e);rememberMotionEmoji(e);renderMotionSelection();populateMotionEmoji(true);updateMotionPanel()
}
function populateMotionEmoji(force=false){
  const host=$('motionEmojiGrid');if(host.children.length&&!force)return
  host.innerHTML=''
  for(const e of quickMotionEmoji()){const b=document.createElement('button');b.type='button';b.textContent=e;b.title='Emoji récent/fréquent';b.onclick=()=>addMotionEmoji(e);host.appendChild(b)}
  const keyboard=document.createElement('button');keyboard.type='button';keyboard.className='motion-keyboard-button';keyboard.textContent='⌨️';keyboard.title='Choisir avec le clavier emoji';keyboard.onclick=()=>{const input=$('motionEmojiInput');input.value='';input.focus({preventScroll:true})};host.appendChild(keyboard)
}
function updateMotionPanel(){
  const ready=Boolean(motionDraft?.curve),hasEmoji=Boolean(motionDraft?.emoji?.length)
  const send=$('motionSend')
  $('motionControls').hidden=!ready
  $('motionReplay').hidden=!ready
  $('motionRedraw').hidden=!ready
  send.hidden=!ready
  send.classList.toggle('ready',ready)
  send.disabled=false
  $('motionNext').hidden=ready
  $('motionNext').disabled=!hasEmoji
  $('motionEmojiGrid').hidden=false
  $('motionTitle').textContent=ready?'Prévisualisation':'Réaction animée'
  $('motionHint').textContent=ready?'Rejoue, ajuste ou envoie':hasEmoji?'Ajoute jusqu’à 3 emoji puis trace':'Choisis 1 à 3 emoji'
}
function openMotionComposer(index){
  if(!$('composerModal').hidden||!$('focusOverlay').hidden)return
  const a=displayArticles[index],v=motionVisual(index)
  if(!a||!v)return
  clearTimeout(motionPlaybackTimer)
  motionPrevZoom=v._pz?.snapshot?.()||{scale:1,tx:0,ty:0}
  motionDraft={articleKey:a.articleKey,index,emoji:[],curve:null,size:.08,scale:'stable',duration:2200}
  populateMotionEmoji(true);renderMotionSelection();updateMotionPanel()
  $('motionSize').value='8';$('motionSizeLabel').textContent='8';$('motionScaleMode').value='stable';$('motionStatus').textContent=''
  $('motionComposer').hidden=false
  $('articleDeck').classList.add('motion-active')
  v.classList.add('motion-mode')
}
function closeMotionComposer({restoreZoom=true}={}){
  if(!motionDraft)return
  const v=motionVisual(motionDraft.index)
  stopMotionDrawing()
  v?.classList.remove('motion-mode')
  if(restoreZoom&&motionPrevZoom)v?._pz?.setState?.(motionPrevZoom)
  motionDraft=null;motionPrevZoom=null
  $('motionComposer').hidden=true
  $('articleDeck').classList.remove('motion-active')
  updateMotionReplayHeader()
}
function startMotionDrawing(){
  if(!motionDraft?.emoji?.length)return
  const v=motionVisual(motionDraft.index),img=motionImage(motionDraft.index),svg=v?.querySelector('.motion-draw-layer'),path=svg?.querySelector('.motion-draw-path')
  if(!v||!img||!svg||!path)return
  $('motionPanel').style.opacity='.72'
  $('motionHint').textContent='Trace la trajectoire sur l’article'
  svg.hidden=false;svg.classList.add('active');path.setAttribute('d','')
  motionDraw={v,img,svg,path,points:[],pointerId:null}
  const push=e=>{
    const ir=renderedImageRect(img),cr=v.getBoundingClientRect(),nx=(e.clientX-ir.left)/Math.max(1,ir.width),ny=(e.clientY-ir.top)/Math.max(1,ir.height)
    if(nx<0||nx>1||ny<0||ny>1)return
    motionDraw.points.push({x:e.clientX-cr.left,y:e.clientY-cr.top,nx,ny})
    path.setAttribute('d',motionDraw.points.map((p,i)=>`${i?'L':'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '))
  }
  svg.onpointerdown=e=>{e.preventDefault();motionDraw.pointerId=e.pointerId;svg.setPointerCapture?.(e.pointerId);motionDraw.points=[];push(e)}
  svg.onpointermove=e=>{if(motionDraw?.pointerId!==e.pointerId)return;e.preventDefault();push(e)}
  svg.onpointerup=e=>{if(motionDraw?.pointerId!==e.pointerId)return;e.preventDefault();push(e);finishMotionDrawing()}
  svg.onpointercancel=()=>stopMotionDrawing()
}
function stopMotionDrawing(){
  const d=motionDraw
  if(!d)return
  d.svg.classList.remove('active');d.svg.hidden=true;d.path.setAttribute('d','');d.svg.onpointerdown=d.svg.onpointermove=d.svg.onpointerup=d.svg.onpointercancel=null
  motionDraw=null;$('motionPanel').style.opacity=''
}
function drawFittedCurve(index,curve,ms=650){
  const v=motionVisual(index),img=motionImage(index),svg=v?.querySelector('.motion-draw-layer'),path=svg?.querySelector('.motion-draw-path')
  if(!v||!img||!svg||!path)return
  const r=imageRectInContainer(v,img),p=k=>[r.left+curve[k][0]*r.width,r.top+curve[k][1]*r.height]
  const a=p('p0'),b=p('p1'),c=p('p2'),d=p('p3')
  path.setAttribute('d',`M ${a[0]} ${a[1]} C ${b[0]} ${b[1]}, ${c[0]} ${c[1]}, ${d[0]} ${d[1]}`);svg.hidden=false
  setTimeout(()=>{if(!motionDraw){svg.hidden=true;path.setAttribute('d','')}},ms)
}
function finishMotionDrawing(){
  const d=motionDraw;if(!d)return
  const fit=fitBezier(d.points)
  stopMotionDrawing()
  if(!fit){status('motionStatus','Trace trop court. Recommence.',false);return}
  motionDraft.curve=fit.curve;motionDraft.duration=fit.duration
  const v=motionVisual(motionDraft.index);v?._pz?.reset?.()
  updateMotionPanel();drawFittedCurve(motionDraft.index,motionDraft.curve)
  setTimeout(()=>playMotionPreview(),140)
}
function motionParticleEmoji(emojis,i){return emojis[i%emojis.length]}
function motionPlaybackDuration(motion){return Math.max(1200,Math.min(4500,(Number(motion?.duration)||2200)*1.18))}
function playExplosionMotion(motion,index,{delay=0}={}){
  const v=motionVisual(index),img=motionImage(index),layer=v?.querySelector('.motion-play-layer')
  if(!v||!img||!layer||!motion?.curve)return Promise.resolve()
  const emojis=(motion.emoji||[]).map(codepointsToString).filter(Boolean);if(!emojis.length)return Promise.resolve()
  const rect=imageRectInContainer(v,img),size=Math.max(22,Math.min(96,(Number(motion.size)||.075)*rect.width)),duration=motionPlaybackDuration(motion)
  const spans=Array.from({length:9},(_,i)=>{const e=document.createElement('span');e.className='motion-play-emoji';e.textContent=motionParticleEmoji(emojis,i);e.style.fontSize=`${size}px`;layer.appendChild(e);return e})
  return new Promise(resolve=>{const start=performance.now()+delay;const frame=now=>{if(now<start){requestAnimationFrame(frame);return}const t=Math.min(1,(now-start)/duration),ease=1-Math.pow(1-t,3),pt=motionPointAt(motion.curve,t),cx=rect.left+pt[0]*rect.width,cy=rect.top+pt[1]*rect.height,burst=Math.min(rect.width,rect.height)*(.05+.19*Math.sin(Math.min(1,t/.72)*Math.PI/2))*ease;for(let i=0;i<spans.length;i++){const angle=(Math.PI*2*i/spans.length)-Math.PI/2,wobble=Math.sin((t*3+i)*Math.PI)*burst*.10,r=burst*(.82+((i%3)*.12)),x=cx+Math.cos(angle)*r+Math.cos(angle+Math.PI/2)*wobble,y=cy+Math.sin(angle)*r+Math.sin(angle+Math.PI/2)*wobble,sc=.38+1.42*Math.sin(Math.min(1,t/.55)*Math.PI/2),opacity=t>.84?Math.max(0,(1-t)/.16):1;spans[i].style.opacity=String(opacity);spans[i].style.transform=`translate3d(${x-size/2}px,${y-size/2}px,0) scale(${sc})`}if(t<1&&spans.some(e=>document.body.contains(e)))requestAnimationFrame(frame);else{spans.forEach(e=>e.remove());resolve()}};requestAnimationFrame(frame)})
}
function playRainMotion(motion,index,{delay=0}={}){
  const v=motionVisual(index),img=motionImage(index),layer=v?.querySelector('.motion-play-layer');if(!v||!img||!layer||!motion?.curve)return Promise.resolve()
  const emojis=(motion.emoji||[]).map(codepointsToString).filter(Boolean);if(!emojis.length)return Promise.resolve()
  const rect=imageRectInContainer(v,img),size=Math.max(22,Math.min(96,(Number(motion.size)||.075)*rect.width)),duration=motionPlaybackDuration(motion)
  const count=7
  const spans=Array.from({length:count},(_,i)=>{const e=document.createElement('span');e.className='motion-play-emoji';e.textContent=motionParticleEmoji(emojis,i);e.style.fontSize=`${size}px`;layer.appendChild(e);return e})
  return new Promise(resolve=>{const start=performance.now()+delay;const frame=now=>{if(now<start){requestAnimationFrame(frame);return}const t=Math.min(1,(now-start)/duration),ease=1-Math.pow(1-t,2),opacity=t>.82?Math.max(0,(1-t)/.18):1;for(let i=0;i<spans.length;i++){const seed=(i+.5)/count,pt=motionPointAt(motion.curve,seed),d=motionDerivatives(motion.curve,seed,rect),travel=Math.min(rect.width,rect.height)*(.10+.25*ease)*(0.88+(i%3)*.08),along=Math.sin(t*Math.PI)*Math.min(rect.width,rect.height)*.025,x=rect.left+pt[0]*rect.width+d.nx*travel+d.tx*along,y=rect.top+pt[1]*rect.height+d.ny*travel+d.ty*along,sc=.55+1.05*Math.sin(Math.min(1,t/.6)*Math.PI/2);spans[i].style.opacity=String(opacity);spans[i].style.transform=`translate3d(${x-size/2}px,${y-size/2}px,0) scale(${sc})`}if(t<1&&spans.some(e=>document.body.contains(e)))requestAnimationFrame(frame);else{spans.forEach(e=>e.remove());resolve()}};requestAnimationFrame(frame)})
}
function playCloudMotion(motion,index,{delay=0}={}){
  const v=motionVisual(index),img=motionImage(index),layer=v?.querySelector('.motion-play-layer');if(!v||!img||!layer||!motion?.curve)return Promise.resolve()
  const emojis=(motion.emoji||[]).map(codepointsToString).filter(Boolean);if(!emojis.length)return Promise.resolve()
  const rect=imageRectInContainer(v,img),size=Math.max(22,Math.min(96,(Number(motion.size)||.075)*rect.width)),duration=motionPlaybackDuration(motion)
  const specs=Array.from({length:7},(_,i)=>({start:.08+i*.10,end:(i%2?1:-1)*(.16+.06*i),amp:Math.min(rect.width,rect.height)*(.05+.015*i),phase:(i+1)*1.3,side:i%2?1:-1}))
  const spans=specs.map((q,i)=>{const e=document.createElement('span');e.className='motion-play-emoji';e.textContent=motionParticleEmoji(emojis,i);e.style.fontSize=`${size}px`;layer.appendChild(e);return e})
  return new Promise(resolve=>{const start=performance.now()+delay;const frame=now=>{if(now<start){requestAnimationFrame(frame);return}const t=Math.min(1,(now-start)/duration),opacity=t>.84?Math.max(0,(1-t)/.16):1;for(let i=0;i<spans.length;i++){const q=specs[i],ct=clamp01Motion(q.start+q.end*t),pt=motionPointAt(motion.curve,ct),d=motionDerivatives(motion.curve,ct,rect),wave=Math.sin(Math.PI*t)*Math.sin(q.phase+t*Math.PI*2)*q.amp*q.side,x=rect.left+pt[0]*rect.width+d.nx*wave,y=rect.top+pt[1]*rect.height+d.ny*wave,sc=.52+1.18*Math.sin(Math.PI*Math.min(1,t/.72));spans[i].style.opacity=String(opacity);spans[i].style.transform=`translate3d(${x-size/2}px,${y-size/2}px,0) scale(${sc})`}if(t<1&&spans.some(e=>document.body.contains(e)))requestAnimationFrame(frame);else{spans.forEach(e=>e.remove());resolve()}};requestAnimationFrame(frame)})
}
function curveMotionMetrics(curve,rect){
  const pts=[],n=28
  for(let i=0;i<=n;i++){const t=i/n,p=motionPointAt(curve,t);pts.push({x:p[0]*rect.width,y:p[1]*rect.height})}
  let length=0,turn=0
  for(let i=1;i<pts.length;i++)length+=Math.hypot(pts[i].x-pts[i-1].x,pts[i].y-pts[i-1].y)
  for(let i=2;i<pts.length;i++){
    const ax=pts[i-1].x-pts[i-2].x,ay=pts[i-1].y-pts[i-2].y,bx=pts[i].x-pts[i-1].x,by=pts[i].y-pts[i-1].y
    turn+=Math.atan2(ax*by-ay*bx,ax*bx+ay*by)
  }
  const chord=Math.max(1,Math.hypot(pts.at(-1).x-pts[0].x,pts.at(-1).y-pts[0].y))
  return {length,turn,roundish:Math.abs(turn)>1.15&&length/chord>1.25}
}
function playRandomMotion(motion,index,{delay=0}={}){
  const v=motionVisual(index),img=motionImage(index),layer=v?.querySelector('.motion-play-layer');if(!v||!img||!layer||!motion?.curve)return Promise.resolve()
  const emojis=(motion.emoji||[]).map(codepointsToString).filter(Boolean);if(!emojis.length)return Promise.resolve()
  const rect=imageRectInContainer(v,img),size=Math.max(22,Math.min(96,(Number(motion.size)||.075)*rect.width)),duration=motionPlaybackDuration(motion),metrics=curveMotionMetrics(motion.curve,rect)
  const center=motionPointAt(motion.curve,.5),cx=rect.left+center[0]*rect.width,cy=rect.top+center[1]*rect.height,base=Math.max(48,Math.min(metrics.length*.58,Math.hypot(rect.width,rect.height)*.72)),rotationSign=metrics.turn>=0?1:-1
  const specs=Array.from({length:7},()=>({angle:Math.random()*Math.PI*2,distance:base*(.42+Math.random()*.72),accel:1.15+Math.random()*2.4,orth:(Math.random()*2-1)*base*(.08+Math.random()*.14),waves:1+Math.floor(Math.random()*3),phase:Math.random()*Math.PI*2,spin:metrics.roundish?rotationSign*(.45+Math.random()*1.25):0}))
  const spans=specs.map((q,i)=>{const e=document.createElement('span');e.className='motion-play-emoji';e.textContent=motionParticleEmoji(emojis,i);e.style.fontSize=`${size}px`;layer.appendChild(e);return e})
  return new Promise(resolve=>{const start=performance.now()+delay;const frame=now=>{if(now<start){requestAnimationFrame(frame);return}const t=Math.min(1,(now-start)/duration),opacity=t>.86?Math.max(0,(1-t)/.14):1;for(let i=0;i<spans.length;i++){const q=specs[i],radial=Math.pow(t,q.accel),angle=q.angle+q.spin*t,rx=Math.cos(angle),ry=Math.sin(angle),ox=-ry,oy=rx,side=Math.sin(q.phase+t*Math.PI*2*q.waves)*q.orth*Math.sin(Math.PI*t),dist=q.distance*radial,x=cx+rx*dist+ox*side,y=cy+ry*dist+oy*side,sc=.44+1.36*Math.sin(Math.PI*Math.min(1,t/.82));spans[i].style.opacity=String(opacity);spans[i].style.transform=`translate3d(${x-size/2}px,${y-size/2}px,0) scale(${sc})`}if(t<1&&spans.some(e=>document.body.contains(e)))requestAnimationFrame(frame);else{spans.forEach(e=>e.remove());resolve()}};requestAnimationFrame(frame)})
}
function playMotion(motion,index,{preview=false,delay=0}={}){
  if(motion?.scale==='explosion')return playExplosionMotion(motion,index,{delay})
  if(motion?.scale==='rain')return playRainMotion(motion,index,{delay})
  if(motion?.scale==='cloud')return playCloudMotion(motion,index,{delay})
  if(motion?.scale==='random')return playRandomMotion(motion,index,{delay})
  const v=motionVisual(index),img=motionImage(index),layer=v?.querySelector('.motion-play-layer');if(!v||!img||!layer||!motion?.curve)return Promise.resolve()
  const emojis=(motion.emoji||[]).map(codepointsToString).filter(Boolean);if(!emojis.length)return Promise.resolve()
  const spanA=document.createElement('span'),spanB=document.createElement('span');spanA.className='motion-play-emoji blend';spanB.className='motion-play-emoji blend';spanA.textContent=emojis[0];spanB.textContent='';layer.append(spanA,spanB)
  const rect=imageRectInContainer(v,img),size=Math.max(22,Math.min(96,(Number(motion.size)||.075)*rect.width)),duration=motionPlaybackDuration(motion),mode=motion.scale||'stable';spanA.style.fontSize=`${size}px`;spanB.style.fontSize=`${size}px`
  return new Promise(resolve=>{const start=performance.now()+delay;const frame=now=>{if(now<start){requestAnimationFrame(frame);return}const t=Math.min(1,(now-start)/duration),pt=motionPointAt(motion.curve,t),x=rect.left+pt[0]*rect.width,y=rect.top+pt[1]*rect.height,blend=motionEmojiBlend(emojis,t),fade=t>.88?Math.max(0,(1-t)/.12):1,sc=motionScaleAt(mode,t),base=`translate3d(${x-size/2}px,${y-size/2}px,0) scale(${sc})`;if(spanA.textContent!==blend.a)spanA.textContent=blend.a;if(spanB.textContent!==blend.b)spanB.textContent=blend.b;spanA.style.opacity=String(fade*(1-blend.mix));spanB.style.opacity=String(fade*blend.mix);spanA.style.transform=base;spanB.style.transform=base;if(t<1&&document.body.contains(spanA))requestAnimationFrame(frame);else{spanA.remove();spanB.remove();resolve()}};requestAnimationFrame(frame)})
}
async function showMotionAuthors(rows=[]){
  const host=$('motionAuthorsHeader');freeUrls(motionAuthorUrls);host.innerHTML=''
  const uniq=[];for(const row of rows){const id=row.senderId||`name:${row.author}`;if(!uniq.some(x=>x.id===id))uniq.push({id,row})}
  for(const {row} of uniq.slice(0,5)){
    const avatar=await service.motionAuthorAvatar(row.senderId,{isOutgoing:row.isOutgoing})
    if(avatar){const img=document.createElement('img');img.className='motion-author-avatar';img.alt=row.author||'Auteur';img.title=row.author||'';img.src=objectUrl(avatar,motionAuthorUrls);host.appendChild(img)}
    else{const f=document.createElement('span');f.className='motion-author-avatar motion-author-fallback';f.textContent=String(row.author||'?').trim().slice(0,1).toUpperCase();f.title=row.author||'';host.appendChild(f)}
  }
  host.hidden=!host.children.length
}
function hideMotionAuthors(){const host=$('motionAuthorsHeader');host.hidden=true;host.innerHTML='';freeUrls(motionAuthorUrls)}
function playArticleMotions(article,index,{force=false}={}){
  const rows=article?.motions||[],key=article?.articleKey
  if(!key||!rows.length||activeMotionArticles.has(key))return Promise.resolve(false)
  activeMotionArticles.add(key);updateMotionReplayHeader();showMotionAuthors(rows).catch(()=>{})
  const jobs=rows.map((r,i)=>playMotion(r.motion||r.meta?.motion,index,{delay:i*100}))
  return Promise.all(jobs).finally(()=>{activeMotionArticles.delete(key);hideMotionAuthors();updateMotionReplayHeader()}).then(()=>true)
}
function updateMotionReplayHeader(){
  const b=$('motionReplayHeader'),a=currentArticle(),has=Boolean(a?.motions?.length),pending=Boolean(a?.motions?.some(m=>m.pending))
  b.hidden=!has||!$('composerModal').hidden||!$('motionComposer').hidden
  b.disabled=!has||activeMotionArticles.has(a?.articleKey)
  b.classList.toggle('pending-outbox',pending)
}
function playMotionPreview(){
  if(!motionDraft?.curve)return
  motionDraft.size=Number($('motionSize').value)/100
  motionDraft.scale=$('motionScaleMode').value
  playMotion({...motionDraft,emoji:motionDraft.emoji.map(stringToCodepoints)},motionDraft.index,{preview:true})
}
function scheduleArticleMotions(article,index){
  clearTimeout(motionPlaybackTimer)
  updateMotionReplayHeader()
  if(!(article.motions||[]).length)return
  const token=++motionVisitToken,key=`${token}:${article.articleKey}`
  motionPlaybackTimer=setTimeout(()=>{
    if(currentArticleIndex!==index||currentArticle()?.articleKey!==article.articleKey||!$('motionComposer').hidden||!$('composerModal').hidden||!$('focusOverlay').hidden)return
    const v=motionVisual(index)
    if(!v||Math.abs((v._pz?.scale||1)-1)>.02){scheduleArticleMotions(article,index);return}
    if(playedMotionVisits.has(key)||activeMotionArticles.has(article.articleKey))return
    playedMotionVisits.add(key)
    playArticleMotions(article,index)
  },2000)
}
$('motionEmojiInput').addEventListener('input',e=>{
  const values=emojiGraphemes(e.currentTarget.value)
  for(const emoji of values){if((motionDraft?.emoji?.length||0)>=3)break;addMotionEmoji(emoji)}
  e.currentTarget.value=''
  if((motionDraft?.emoji?.length||0)>=3)e.currentTarget.blur()
})
$('motionCancel').onclick=()=>closeMotionComposer({restoreZoom:true})
$('motionNext').onclick=()=>{status('motionStatus','',null);startMotionDrawing()}
$('motionRedraw').onclick=()=>{motionDraft.curve=null;updateMotionPanel();startMotionDrawing()}
$('motionReplay').onclick=playMotionPreview
$('motionSize').oninput=()=>{$('motionSizeLabel').textContent=$('motionSize').value;if(motionDraft){motionDraft.size=Number($('motionSize').value)/100}}
$('motionScaleMode').onchange=()=>{if(motionDraft)motionDraft.scale=$('motionScaleMode').value}
$('motionSend').onclick=async()=>{
  if(!motionDraft?.curve)return
  const button=$('motionSend')
  try{
    button.disabled=true;status('motionStatus','Envoi…')
    motionDraft.size=Number($('motionSize').value)/100;motionDraft.scale=$('motionScaleMode').value
    const payload={version:1,emoji:motionDraft.emoji.map(stringToCodepoints),curve:motionDraft.curve,size:motionDraft.size,scale:motionDraft.scale,duration:motionDraft.duration}
    currentModel=await service.postEmojiMotion(motionDraft.articleKey,payload)
    const fresh=currentModel.articles.find(a=>a.articleKey===motionDraft.articleKey),idx=displayArticles.findIndex(a=>a.articleKey===motionDraft.articleKey)
    if(fresh&&idx>=0)displayArticles[idx]={...displayArticles[idx],...fresh}
    const queued=Boolean(fresh?.motions?.some(m=>m.pending))
    closeMotionComposer({restoreZoom:false});updateReaderPageLabel();updateMotionReplayHeader();await refreshPending();setArticleBadge(queued?'Animation en attente':'Animation envoyée')
  }catch(e){debug(e);status('motionStatus','Erreur : '+(e.message||e),false)}finally{button.disabled=false}
}

function defaultPhotoBounds(a){
  if(a.photoBounds)return a.photoBounds
  if(a.layout==='text_below'){
    const limit=a.textBounds?Math.max(.42,Math.min(.78,a.textBounds.y0-.03)):.68
    return {x0:0,y0:0,x1:1,y1:limit}
  }
  if(a.layout==='text_right'){
    const limit=a.textBounds?Math.max(.38,Math.min(.7,a.textBounds.x0-.03)):.56
    return {x0:0,y0:0,x1:limit,y1:1}
  }
  return a.slot==='h'?{x0:0,y0:0,x1:.54,y1:1}:a.slot==='b'?{x0:0,y0:0,x1:1,y1:.65}:{x0:0,y0:0,x1:.55,y1:1}
}
function handleDoubleTap(container,index,clientX,clientY){
  if(container._pz?.scale!==1){container._pz.reset();return}
  const a=displayArticles[index],im=container.querySelector('img')
  if(!im)return
  const r=im.getBoundingClientRect()
  const nx=(clientX-r.left)/r.width,ny=(clientY-r.top)/r.height,b=a.textBounds
  if(nx<0||nx>1||ny<0||ny>1)return
  const inText=b&&nx>=b.x0&&nx<=b.x1&&ny>=b.y0&&ny<=b.y1
  if(inText)openFocusText(a,index)
  else openFocusPhoto(a,index)
}
function cropImage(img,bounds){
  if(!img||!img.naturalWidth)return null
  const b=bounds||{x0:0,y0:0,x1:1,y1:1}
  const x=Math.max(0,Math.floor(b.x0*img.naturalWidth)),y=Math.max(0,Math.floor(b.y0*img.naturalHeight))
  const w=Math.max(1,Math.floor((b.x1-b.x0)*img.naturalWidth)),h=Math.max(1,Math.floor((b.y1-b.y0)*img.naturalHeight))
  const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,x,y,w,h,0,0,w,h)
  const url=c.toDataURL('image/jpeg',.88)
  try{c.width=1;c.height=1}catch{}
  return url
}
function articleImg(index){return $('articleDeck').querySelector(`[data-index="${index}"] .article-visual img`)}
async function openFocusPhoto(a,index){
  try{
    focusArticleKey=a.articleKey
    $('focusTextStage').hidden=true
    $('focusImageStage').hidden=false
    $('focusOverlay').hidden=false
    $('focusImage').removeAttribute('src')
    const result=await service.getArticlePhotoInfo(a.articleKey)
    if(focusPhotoUrl)URL.revokeObjectURL(focusPhotoUrl)
    focusPhotoUrl=URL.createObjectURL(result.blob)
    $('focusImage').src=focusPhotoUrl
    $('focusImage').onload=()=>installFocusPanZoom(a.articleKey)
  }catch(e){debug(e);setArticleBadge('Photo indisponible')}
}
function openFocusText(a,index){
  focusArticleKey=a.articleKey
  $('focusImageStage').hidden=true;$('focusTextStage').hidden=false
  $('focusAuthor').textContent=a.authorName||'Article'
  $('focusArticleDate').textContent=a.articleDateLabel||''
  $('focusText').textContent=a.bodyText||a.articleText||a.pageText||''
  const av=cropImage(articleImg(index),a.avatarBounds)
  if(av){$('focusAuthorAvatar').src=av;$('focusAuthorAvatar').hidden=false}else $('focusAuthorAvatar').hidden=true
  $('focusOverlay').hidden=false
}
function closeFocus(){
  $('focusOverlay').hidden=true
  $('focusImage').style.transform=''
  $('focusImage').onload=null
  $('focusImage').removeAttribute('src')
  if(focusPhotoUrl){URL.revokeObjectURL(focusPhotoUrl);focusPhotoUrl=null}
  focusArticleKey=null
}
$('focusCloseButton').onclick=closeFocus
$('focusTextStage').addEventListener('dblclick',e=>{e.preventDefault();closeFocus()})
let focusTextTap={time:0,x:0,y:0}
$('focusTextStage').addEventListener('touchend',e=>{
  if(e.changedTouches?.length!==1)return
  const t=e.changedTouches[0],now=Date.now()
  const close=now-focusTextTap.time<340 && Math.hypot(t.clientX-focusTextTap.x,t.clientY-focusTextTap.y)<28
  focusTextTap={time:now,x:t.clientX,y:t.clientY}
  if(close){e.preventDefault();closeFocus();focusTextTap={time:0,x:0,y:0}}
},{passive:false})
$('focusTextStage').addEventListener('copy',()=>{
  const txt=getSelection()?.toString()||''
  if(txt){lastArticleCopy={text:txt,at:Date.now()}}
})
function installFocusPanZoom(articleKey){
  const stage=$('focusImageStage'),img=$('focusImage')
  let st={...(focusZoomStates.get(articleKey)||{scale:1,tx:0,ty:0})},pinch=null,start=null,lastMove=null,raf=null,lastTap=0
  const persist=()=>focusZoomStates.set(articleKey,{scale:st.scale,tx:st.tx,ty:st.ty})
  const apply=()=>{const c=clampPan(stage,img,st.scale,st.tx,st.ty);st.tx=c.tx;st.ty=c.ty;img.style.transform=`translate(${st.tx}px,${st.ty}px) scale(${st.scale})`;persist()}
  const reset=()=>{st={scale:1,tx:0,ty:0};apply()}
  apply()
  stage.ontouchstart=e=>{
    if(e.target.closest('#focusCloseButton'))return
    if(raf)cancelAnimationFrame(raf)
    if(e.touches.length===2){const[a,b]=e.touches;pinch={d:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),scale:st.scale}}
    else if(e.touches.length===1){const t=e.touches[0];start={x:t.clientX,y:t.clientY,tx:st.tx,ty:st.ty,time:performance.now()};lastMove={x:t.clientX,y:t.clientY,time:performance.now(),vx:0,vy:0}}
  }
  stage.ontouchmove=e=>{
    if(e.touches.length===2&&pinch){e.preventDefault();const[a,b]=e.touches;st.scale=Math.max(1,Math.min(5,pinch.scale*Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY)/pinch.d));apply()}
    else if(e.touches.length===1&&start&&st.scale>1){e.preventDefault();const t=e.touches[0],now=performance.now(),dt=Math.max(1,now-lastMove.time);st.tx=start.tx+t.clientX-start.x;st.ty=start.ty+t.clientY-start.y;lastMove={x:t.clientX,y:t.clientY,time:now,vx:(t.clientX-lastMove.x)/dt,vy:(t.clientY-lastMove.y)/dt};apply()}
  }
  stage.ontouchend=e=>{
    if(start&&e.changedTouches?.length){
      const t=e.changedTouches[0],dx=t.clientX-start.x,dy=t.clientY-start.y,dur=performance.now()-start.time
      if(Math.abs(dx)<14&&Math.abs(dy)<14&&dur<280){
        const now=Date.now()
        if(now-lastTap<330){
          e.preventDefault()
          if(st.scale>1.02)reset()
          else{
            const r=stage.getBoundingClientRect(),zx=t.clientX-r.left,zy=t.clientY-r.top,next=2.5
            st.scale=next;st.tx=(r.width/2-zx)*(next-1);st.ty=(r.height/2-zy)*(next-1);apply()
          }
          lastTap=0
        }else lastTap=now
      }else if(st.scale>1&&lastMove){
        let vx=lastMove.vx*18,vy=lastMove.vy*18
        const inertia=()=>{vx*=.91;vy*=.91;st.tx+=vx;st.ty+=vy;apply();if(Math.abs(vx)+Math.abs(vy)>.35)raf=requestAnimationFrame(inertia)}
        raf=requestAnimationFrame(inertia)
      }
    }
    start=null;pinch=null
  }
  stage.onpointerdown=e=>{if(e.pointerType==='mouse')stage.setPointerCapture?.(e.pointerId)}
  let mouse=null
  stage.onpointermove=e=>{if(e.pointerType!=='mouse'||!mouse||st.scale<=1)return;st.tx=mouse.tx+e.clientX-mouse.x;st.ty=mouse.ty+e.clientY-mouse.y;apply()}
  stage.onpointerup=e=>{if(e.pointerType!=='mouse')return;if(mouse){mouse=null;return}const now=Date.now();if(now-lastTap<330){if(st.scale>1.02)reset();else{const r=stage.getBoundingClientRect(),next=2.5;st.scale=next;st.tx=(r.width/2-(e.clientX-r.left))*(next-1);st.ty=(r.height/2-(e.clientY-r.top))*(next-1);apply()}lastTap=0}else lastTap=now}
  stage.onpointerdown=e=>{if(e.pointerType==='mouse'){mouse={x:e.clientX,y:e.clientY,tx:st.tx,ty:st.ty};stage.setPointerCapture?.(e.pointerId)}}
  stage.ondblclick=e=>{e.preventDefault();if(st.scale>1.02)reset();else{const r=stage.getBoundingClientRect(),next=2.5;st.scale=next;st.tx=(r.width/2-(e.clientX-r.left))*(next-1);st.ty=(r.height/2-(e.clientY-r.top))*(next-1);apply()}}
}

function formatBytes(value){
  const n=Number(value||0)
  if(!Number.isFinite(n)||n<=0)return '0 o'
  const units=['o','Ko','Mo','Go']
  let v=n,u=0
  while(v>=1024&&u<units.length-1){v/=1024;u++}
  return `${v>=100||u===0?v.toFixed(0):v>=10?v.toFixed(1):v.toFixed(2)} ${units[u]}`
}

async function estimateLoadedAppBytes(){
  const urls=new Set()
  const base=new URL(location.href)
  base.search=''
  base.hash=''
  urls.add(base.href)

  for(const el of document.querySelectorAll('script[src],link[href]')){
    const raw=el.src||el.href
    if(!raw)continue
    const u=new URL(raw,location.href)
    if(u.origin===location.origin)urls.add(u.href)
  }

  let bytes=0
  const resources=performance.getEntriesByType('resource')
  const perfByUrl=new Map(resources.map(r=>[r.name,r]))
  for(const r of resources){
    try{
      const u=new URL(r.name)
      if(u.origin!==location.origin)continue
      urls.add(u.href)
      const size=Number(r.encodedBodySize||r.transferSize||0)
      if(size>0)bytes+=size
    }catch{}
  }

  // Fetch only resources whose size was not reported by Resource Timing.
  for(const url of urls){
    const perf=perfByUrl.get(url)
    const known=Number(perf?.encodedBodySize||perf?.transferSize||0)
    if(known>0)continue
    try{
      const res=await fetch(url,{cache:'force-cache'})
      if(!res.ok)continue
      const len=Number(res.headers.get('content-length')||0)
      if(len>0)bytes+=len
      else bytes+=(await res.arrayBuffer()).byteLength
    }catch{}
  }
  return bytes
}

const STORE_LABELS={
  assets:'PDF / images / avatar',
  messages:'Messages',
  articles:'Articles / index',
  magazines:'Revues',
  outbox:'Messages à transmettre',
  readState:'État de lecture',
  topics:'Sujets Telegram',
  settings:'Réglages locaux',
}

async function refreshStorageStats(){
  const button=$('refreshStorageStats')
  button.disabled=true
  status('storageStatus','Calcul des tailles…')
  try{
    const [db,appBytes,origin]=await Promise.all([
      service.storageStats(),
      estimateLoadedAppBytes(),
      navigator.storage?.estimate?.() || Promise.resolve({usage:0,quota:0}),
    ])

    $('appCodeSize').textContent=formatBytes(appBytes)
    $('indexedDbSize').textContent=`≈ ${formatBytes(db.totalBytes)}`
    $('originUsage').textContent=formatBytes(origin.usage||0)
    $('originQuota').textContent=formatBytes(origin.quota||0)

    const host=$('indexedDbBreakdown')
    host.innerHTML=''
    const rows=Object.entries(db.stores)
      .sort((a,b)=>b[1].bytes-a[1].bytes)
    for(const [name,info] of rows){
      const row=document.createElement('div')
      row.className='storage-breakdown-row'
      row.innerHTML=`<span>${esc(STORE_LABELS[name]||name)} · ${info.count}</span><strong>≈ ${formatBytes(info.bytes)}</strong>`
      host.appendChild(row)
    }
    status('storageStatus','Tailles actualisées.',true)
  }catch(e){
    debug(e)
    status('storageStatus','Calcul impossible : '+(e.message||e),false)
  }finally{
    button.disabled=false
  }
}

/* Settings */
$('openSettingsHome').onclick=()=>{
  $('settingsView').hidden=false
  refreshStorageStats()
}
$('closeSettings').onclick=()=>{$('settingsView').hidden=true}
$('refreshStorageStats').onclick=refreshStorageStats
$('clearStoredMaminaPassword').onclick=async()=>{localStorage.removeItem(STORED_PASSWORD_KEY);$('password').value='';await loadSettings();status('storageStatus','Mot de passe MamiNa supprimé de cet appareil.',true)}
$('themeSelect').onchange=async()=>{applyTheme($('themeSelect').value);await service.setTheme($('themeSelect').value)}
$('reactionOrder').onchange=async()=>{reactionOrder=$('reactionOrder').value;await service.setReactionOrder(reactionOrder);if(currentModel)await rebuild(currentArticle()?.articleKey)}
$('forceUpdate').onclick=async()=>{
  try{
    $('forceUpdate').disabled=true
    status('updateStatus','Synchronisation et recherche de mise à jour…')
    showActivity('Mise à jour forcée…')
    if(service.hasGateway() && navigator.onLine){
      try{
        await service.reconnectAndFlush('mise à jour forcée')
        await service.syncAll()
        await refreshPending()
      }catch(e){debug(e)}
    }
    await fetch(`./?update=${Date.now()}`,{cache:'reload'})
    status('updateStatus','Rechargement…',true)
    location.replace(`${location.pathname}?refresh=${Date.now()}`)
  }catch(e){
    status('updateStatus','Erreur : '+e.message,false)
    $('forceUpdate').disabled=false
  }
}
function renderLogs(){$('techLogs').textContent=formatLogs()||'Aucun journal.'}
onLog(renderLogs)
$('clearLogs').onclick=()=>{clearTechLogs();renderLogs()}
$('copyLogs').onclick=()=>navigator.clipboard.writeText(formatLogs())
$('verboseLogs').checked=Number(localStorage.getItem('MTCUTE_LOG_LEVEL')||2)>=4
$('verboseLogs').onchange=()=>localStorage.setItem('MTCUTE_LOG_LEVEL',$('verboseLogs').checked?'4':'2')

let adminGroups=[],adminTopics=[],lastAdminErrorText=''
function rememberAdminError(e,context='Administration'){
  const trace=$('adminTrace')?.textContent||''
  lastAdminErrorText=[
    context,
    `version=${APP_VERSION}`,
    `message=${e?.message||String(e)}`,
    e?.stack?`stack=${e.stack}`:'',
    trace?`trace=\n${trace.trim()}`:'',
  ].filter(Boolean).join('\n')
  $('copyAdminError').hidden=false
}
$('copyAdminError').onclick=async()=>{
  if(!lastAdminErrorText)return
  try{
    await navigator.clipboard.writeText(lastAdminErrorText)
    status('adminStatus','Erreur copiée.',true)
  }catch(e){
    status('adminStatus','Copie impossible : '+(e.message||e),false)
  }
}
$('adminSaveParams').onclick=async()=>{try{$('adminSaveParams').disabled=true;status('adminParamsStatus','Mise à jour params…');const r=await service.adminSaveParams({storagePassword:$('adminStoragePassword').checked});if(!$('adminStoragePassword').checked)localStorage.removeItem(STORED_PASSWORD_KEY);status('adminParamsStatus',`OK · message ${r.paramsMessageId}`,true);await loadSettings()}catch(e){rememberAdminError(e,'Mise à jour params');status('adminParamsStatus','Erreur : '+e.message,false)}finally{$('adminSaveParams').disabled=false}}
$('adminInitSystem').onclick=async()=>{try{const sha=$('catalogShaFile').files?.[0],json=$('catalogJsonFile').files?.[0],bin=$('catalogBinFile').files?.[0];$('adminInitSystem').disabled=true;$('copyAdminError').hidden=true;lastAdminErrorText='';status('adminSystemStatus','Publication params/catalog…');const r=await service.adminInitializeSystem({shaFile:sha,catalogJsonFile:json,catalogBinFile:bin});status('adminSystemStatus',`OK · params ${r.paramsTopicId}, catalog ${r.catalogTopicId}`,true);await $('adminRefreshTopics').onclick?.()}catch(e){rememberAdminError(e,'Initialisation params/catalog');status('adminSystemStatus','Erreur : '+e.message,false)}finally{$('adminInitSystem').disabled=false}}
$('adminRefreshGroups').onclick=async()=>{try{adminGroups=await service.adminListForumDialogs();const s=$('adminGroupSelect');s.innerHTML='';adminGroups.forEach((g,i)=>{const o=document.createElement('option');o.value=i;o.textContent=g.title;s.appendChild(o)});const recipe=adminGroups.findIndex(g=>String(g.title||'').trim().toLowerCase()==='famileo_recette');if(recipe>=0){s.value=String(recipe);await service.selectDialog(adminGroups[recipe])}status('adminStatus',`${adminGroups.length} groupes avec sujets.${recipe>=0?' famileo_recette sélectionné.':''}`,true)}catch(e){status('adminStatus','Erreur : '+e.message,false)}}
$('adminGroupSelect').onchange=async()=>{const g=adminGroups[+$('adminGroupSelect').value];if(g){await service.selectDialog(g);await refreshPending()}}
$('adminRefreshTopics').onclick=async()=>{try{adminTopics=await service.adminListTopics();const s=$('adminTopicSelect');s.innerHTML='';adminTopics.forEach((t,i)=>{const o=document.createElement('option');o.value=i;o.textContent=t.title||`Sujet ${t.id}`;s.appendChild(o)});status('adminStatus',`${adminTopics.length} sujets.`,true)}catch(e){status('adminStatus','Erreur : '+e.message,false)}}
$('saveAdminTitle').onclick=async()=>{try{const t=await service.setAppTitle($('adminAppTitle').value);setAppName(t);status('adminTitleStatus',`Nom enregistré : ${t}`,true)}catch(e){status('adminTitleStatus','Erreur : '+e.message,false)}}
$('adminPublish').onclick=async()=>{const f=$('adminPdf').files?.[0],trace=$('adminTrace');trace.textContent='';$('copyAdminError').hidden=true;lastAdminErrorText='';try{if(!f)throw new Error('Choisis un PDF.');$('adminPublish').disabled=true;const r=await service.adminCreateMagazine(f,{onStep:e=>{trace.textContent+=`${new Date(e.at).toLocaleTimeString()} ${e.name} ${JSON.stringify(e.detail||{})}\n`}});status('adminStatus',`Publié : ${r.articles.length} articles détectés.`,true);await localHome()}catch(e){rememberAdminError(e,`Publication PDF ${f?.name||''}`);status('adminStatus','Erreur : '+e.message,false)}finally{$('adminPublish').disabled=false}}

/* Rich editor */
function saveSelection(){
  if(toolbarGesture)return
  const sel=getSelection()
  if(sel?.rangeCount&&$('composerText').contains(sel.anchorNode)){
    savedRange=sel.getRangeAt(0).cloneRange()
  }
}
function forceSaveSelection(){
  const sel=getSelection()
  if(sel?.rangeCount&&$('composerText').contains(sel.anchorNode)){
    savedRange=sel.getRangeAt(0).cloneRange()
  }
}
function restoreSelection(){
  if(!savedRange)return false
  try{
    const sel=getSelection()
    sel.removeAllRanges()
    sel.addRange(savedRange)
    return true
  }catch{return false}
}
function placeCaretEnd(el){
  const r=document.createRange()
  r.selectNodeContents(el)
  r.collapse(false)
  const sel=getSelection()
  sel.removeAllRanges()
  sel.addRange(r)
  savedRange=r.cloneRange()
}
function rgbHex(v){
  if(/^#[0-9a-f]{6}$/i.test(v||''))return v.toUpperCase()
  const m=String(v||'').match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
  return m?'#'+[m[1],m[2],m[3]].map(x=>(+x).toString(16).padStart(2,'0')).join('').toUpperCase():null
}
function defaultEditorColor(){
  const explicit=document.documentElement.dataset.theme
  const dark=explicit==='dark'||(!explicit&&matchMedia('(prefers-color-scheme: dark)').matches)
  return dark?'#FFFFFF':'#000000'
}
function explicitCaretColor(){
  const sel=getSelection()
  let n=sel?.anchorNode
  if(n?.nodeType===3)n=n.parentElement
  while(n&&n!==$('composerText')){
    const c=rgbHex(n.style?.color||(n.tagName==='FONT'?n.getAttribute('color'):''))
    if(c)return c
    n=n.parentElement
  }
  return null
}
function setFormatVisual(button,active){
  button.classList.toggle('active',Boolean(active))
  button.setAttribute('aria-pressed',active?'true':'false')
}
let toolbarGesture=false

function selectionRange(){
  const sel=getSelection()
  if(!sel?.rangeCount)return null
  const range=sel.getRangeAt(0)
  if(!$('composerText').contains(range.commonAncestorContainer))return null
  return range
}
function typingCarrierAtCaret(){
  const sel=getSelection()
  let n=sel?.anchorNode
  if(n?.nodeType===3)n=n.parentElement
  return n?.closest?.('.typing-carrier')||null
}
function syncTypingStateFromCaret(){
  const range=selectionRange()
  if(!range||!range.collapsed||typingCarrierAtCaret())return
  try{typingState.bold=document.queryCommandState('bold')}catch{}
  try{typingState.italic=document.queryCommandState('italic')}catch{}
  try{typingState.underline=document.queryCommandState('underline')}catch{}
  try{typingState.strikeThrough=document.queryCommandState('strikeThrough')}catch{}
  const explicit=explicitCaretColor()
  typingState.color=explicit||defaultEditorColor()
  currentColor=typingState.color
}
function updateToolbar(){
  if($('composerModal').hidden||toolbarGesture)return
  const range=selectionRange()
  if(range && !range.collapsed){
    for(const b of document.querySelectorAll('.format-toggle')){
      let active=false
      try{active=document.queryCommandState(b.dataset.command)}catch{}
      setFormatVisual(b,active)
    }
    const explicit=explicitCaretColor()
    if(explicit)currentColor=explicit
  }else{
    for(const b of document.querySelectorAll('.format-toggle')){
      setFormatVisual(b,Boolean(typingState[b.dataset.command]))
    }
    currentColor=typingState.color||defaultEditorColor()
  }
  document.querySelector('.color-swatch').style.background=currentColor
}

function moveCaretOutsideCarrier(){
  const carrier=typingCarrierAtCaret()
  if(!carrier)return
  const onlyMarker=(carrier.textContent||'').replace(/\u200B/g,'').length===0
  const range=document.createRange()
  if(onlyMarker){
    range.setStartBefore(carrier)
    carrier.remove()
  }else{
    range.setStartAfter(carrier)
  }
  range.collapse(true)
  const sel=getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  savedRange=range.cloneRange()
}
function applyTypingCarrier(){
  const editor=$('composerText')
  editor.focus({preventScroll:true})
  restoreSelection()
  moveCaretOutsideCarrier()

  const range=selectionRange()
  if(!range||!range.collapsed)return

  const span=document.createElement('span')
  span.className='typing-carrier'
  span.dataset.typing='1'
  span.style.fontWeight=typingState.bold?'700':'normal'
  span.style.fontStyle=typingState.italic?'italic':'normal'
  const decorations=[]
  if(typingState.underline)decorations.push('underline')
  if(typingState.strikeThrough)decorations.push('line-through')
  span.style.textDecoration=decorations.join(' ')||'none'
  span.style.color=typingState.color||defaultEditorColor()

  const marker=document.createTextNode('\u200B')
  span.appendChild(marker)
  range.insertNode(span)

  const caret=document.createRange()
  caret.setStart(marker,1)
  caret.collapse(true)
  const sel=getSelection()
  sel.removeAllRanges()
  sel.addRange(caret)
  savedRange=caret.cloneRange()
}
document.addEventListener('selectionchange',()=>{
  if($('composerModal').hidden||toolbarGesture)return
  saveSelection()
  syncTypingStateFromCaret()
  requestAnimationFrame(updateToolbar)
})

function openComposer(k){
  composerArticleKey=k
  const article=displayArticles.find(x=>x.articleKey===k)
  const pending=article?.comments?.find(c=>c.pending)
  $('composerText').innerHTML=pending?renderMarkup(pending.displayText||pending.text||''):''
  $('composerModal').hidden=false
  $('reader').classList.add('composer-open')
  $('formatRow').hidden=false
  $('colorRow').hidden=true

  const idx=displayArticles.findIndex(x=>x.articleKey===k)
  $('readerDate').textContent=`${idx+1}/${displayArticles.length} - page ${article.page} ${slotName(article.slot)}`
  currentColor=defaultEditorColor()
  typingState={bold:false,italic:false,underline:false,strikeThrough:false,color:currentColor}
  document.querySelector('.color-swatch').style.background=currentColor

  const editor=$('composerText')
  editor.focus({preventScroll:true})
  placeCaretEnd(editor)
  try{document.execCommand('styleWithCSS',false,false)}catch{}
  forceSaveSelection()
  syncTypingStateFromCaret()
  updateToolbar()
  requestAnimationFrame(positionComposer)
}
function closeComposer(){
  $('composerModal').hidden=true
  $('reader').classList.remove('composer-open')
  $('reader').style.height=''
  $('readerDate').textContent=fmtShort(currentModel.magazine.date)
  composerArticleKey=null
  savedRange=null
  toolbarGesture=false
  typingState={bold:false,italic:false,underline:false,strikeThrough:false,color:null}
}
$('cancelComposer').onpointerdown=e=>e.preventDefault()
$('cancelComposer').onclick=closeComposer

function applyFormatButton(button){
  const editor=$('composerText')
  editor.focus({preventScroll:true})
  restoreSelection()
  const range=selectionRange()
  if(!range)return

  // Keep the already reliable selected-text path unchanged.
  if(!range.collapsed){
    try{document.execCommand(button.dataset.command,false,null)}catch(e){debug(e)}
    let active=false
    try{active=document.queryCommandState(button.dataset.command)}catch{}
    setFormatVisual(button,active)
    forceSaveSelection()
  }else{
    const command=button.dataset.command
    typingState[command]=!typingState[command]
    setFormatVisual(button,typingState[command])
    applyTypingCarrier()
  }

  setTimeout(()=>{
    toolbarGesture=false
    editor.focus({preventScroll:true})
    restoreSelection()
    forceSaveSelection()
    updateToolbar()
  },45)
}

for(const b of document.querySelectorAll('.format-toggle')){
  b.addEventListener('pointerdown',e=>{
    e.preventDefault()
    e.stopPropagation()
    toolbarGesture=true
    forceSaveSelection()
  })
  b.addEventListener('pointerup',e=>{
    e.preventDefault()
    e.stopPropagation()
    applyFormatButton(e.currentTarget)
  })
  b.addEventListener('click',e=>{
    e.preventDefault()
    e.stopPropagation()
  })
}
$('clearText').onpointerdown=e=>e.preventDefault()
$('clearText').onclick=()=>{
  $('composerText').innerHTML=''
  $('composerText').focus({preventScroll:true})
  placeCaretEnd($('composerText'))
  typingState={bold:false,italic:false,underline:false,strikeThrough:false,color:defaultEditorColor()}
  currentColor=typingState.color
  forceSaveSelection()
  updateToolbar()
}
$('composerOptions').onpointerdown=e=>e.preventDefault()
$('composerOptions').onclick=()=>{}

$('colorButton').onpointerdown=e=>{e.preventDefault();toolbarGesture=true;forceSaveSelection()}
$('colorButton').onclick=async()=>{
  forceSaveSelection();$('formatRow').hidden=true;$('colorRow').hidden=false
  await colors();restoreSelection();$('composerText').focus({preventScroll:true});positionComposer()
}
async function colors(){
  const row=$('colorRow');row.innerHTML=''
  const cfg=await service.getSettings(),base=defaultEditorColor(),cs=[...new Set([base,...(cfg.recentColors||[]),'#FF0000','#FFD400','#0066FF','#00A651'])]
  for(const c of cs){
    const b=document.createElement('button');b.className='color-choice';b.style.background=c
    b.onpointerdown=e=>e.preventDefault();b.onclick=()=>chooseColor(c);row.appendChild(b)
  }
  const lab=document.createElement('label');lab.className='color-picker-label'
  const inp=document.createElement('input');inp.type='color';inp.value=currentColor;inp.oninput=()=>chooseColor(inp.value)
  lab.appendChild(inp);row.appendChild(lab)
}
async function chooseColor(c){
  currentColor=String(c).toUpperCase()
  const editor=$('composerText')
  editor.focus({preventScroll:true})
  restoreSelection()
  const range=selectionRange()

  // Selected-text color path remains exactly the normal browser command.
  if(range && !range.collapsed){
    try{document.execCommand('foreColor',false,currentColor)}catch(e){debug(e)}
  }else{
    typingState.color=currentColor
    applyTypingCarrier()
  }

  await service.rememberColor(currentColor)
  $('colorRow').hidden=true
  $('formatRow').hidden=false
  document.querySelector('.color-swatch').style.background=currentColor
  setTimeout(()=>{
    toolbarGesture=false
    editor.focus({preventScroll:true})
    restoreSelection()
    forceSaveSelection()
    updateToolbar()
    positionComposer()
  },0)
}
function nodeMarkup(n){
  if(n.nodeType===3)return (n.nodeValue||'').replace(/\u200B/g,'')
  if(n.nodeType!==1)return''
  const t=n.tagName.toLowerCase();if(t==='br')return'\n'
  let x='';for(const c of n.childNodes)x+=nodeMarkup(c)
  if(t==='div'||t==='p')x+='\n'
  if(t==='b'||t==='strong')x=`**${x}**`
  if(t==='i'||t==='em')x=`*${x}*`
  if(t==='u')x=`__${x}__`
  if(t==='s'||t==='strike')x=`~~${x}~~`
  if(n.classList?.contains('typing-carrier')){
    if(/700|bold/i.test(n.style.fontWeight||''))x=`**${x}**`
    if((n.style.fontStyle||'')==='italic')x=`*${x}*`
    const deco=n.style.textDecoration||''
    if(deco.includes('underline'))x=`__${x}__`
    if(deco.includes('line-through'))x=`~~${x}~~`
  }
  if(n.classList?.contains('article-paste'))x=`[mark]${x}[/mark]`
  const col=rgbHex(t==='font'?n.getAttribute('color'):n.style?.color);if(col)x=`[color=${col}]${x}[/color]`
  return x
}
function editorMarkup(){let x='';for(const n of $('composerText').childNodes)x+=nodeMarkup(n);return x.replace(/\n{3,}/g,'\n\n').trim()}
function positionComposer(){
  if($('composerModal').hidden)return
  const vv=visualViewport,sheet=$('composerSheet')
  const top=vv?Math.max(vv.offsetTop,vv.offsetTop+vv.height-sheet.offsetHeight):innerHeight-sheet.offsetHeight
  sheet.style.top=`${Math.round(top)}px`;sheet.style.bottom='auto'
  $('reader').style.height=`${Math.round(top)}px`
}
visualViewport?.addEventListener('resize',positionComposer)
visualViewport?.addEventListener('scroll',positionComposer)
$('composerText').addEventListener('input',()=>{
  forceSaveSelection()
  updateToolbar()
  positionComposer()
})
$('composerText').addEventListener('paste',e=>{
  const text=e.clipboardData?.getData('text/plain')||''
  const fromArticle=text && lastArticleCopy.text && Date.now()-lastArticleCopy.at<5*60*1000 &&
    (text===lastArticleCopy.text || lastArticleCopy.text.includes(text))
  if(!fromArticle)return

  e.preventDefault()
  const sel=getSelection()
  if(!sel?.rangeCount)return
  const range=sel.getRangeAt(0)
  range.deleteContents()

  const quote=document.createElement('span')
  quote.className='article-paste'
  quote.textContent=text

  // Caret deliberately leaves the highlighted span so following typing uses
  // the current editor style instead of extending the quote highlight.
  const normal=document.createTextNode('\u200B')
  const frag=document.createDocumentFragment()
  frag.append(quote,normal)
  range.insertNode(frag)

  const after=document.createRange()
  after.setStart(normal,1)
  after.collapse(true)
  sel.removeAllRanges()
  sel.addRange(after)
  savedRange=after.cloneRange()

  currentColor=defaultEditorColor()
  try{document.execCommand('foreColor',false,currentColor)}catch{}
  updateToolbar()
})

$('sendText').onpointerdown=e=>e.preventDefault()
$('sendText').onclick=async()=>{
  const b=$('sendText')
  try{
    const t=editorMarkup();if(!t)throw new Error('Message vide.')
    b.disabled=true
    showActivity(telegramState==='connected'?'Envoi du message…':'Message conservé localement…')
    // Keep keyboard/editor in place until storage/network work is finished.
    const k=composerArticleKey
    currentModel=await service.postText(k,t)
    const updated=currentModel.articles.find(a=>a.articleKey===k)
    const idx=displayArticles.findIndex(a=>a.articleKey===k)
    if(updated&&idx>=0){
      displayArticles[idx]={...displayArticles[idx],...updated}
      const list=$('articleDeck').querySelector(`[data-index="${idx}"] .reaction-list`)
      if(list)renderComments(displayArticles[idx],list)
    }
    updateReaderPageLabel()
    await refreshPending()
    closeComposer()
  }catch(e){debug(e)}
  finally{b.disabled=false}
}

if(new URLSearchParams(location.search).get('settings')==='admin'){
  setTimeout(()=>{$('settingsView').hidden=false;$('adminPanel').open=true},150)
}
