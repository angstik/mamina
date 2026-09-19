import './styles.css'
import { UserMaminaService } from '../backend/user-service.js'
import { clearLogs as clearTechLogs, formatLogs, onLog, info, error as logError } from '../backend/log.js'

const $=id=>document.getElementById(id)
const service=new UserMaminaService()

let magazines=[]
let currentModel=null
let displayArticles=[]
let currentArticleIndex=0
let reactionOrder='asc'
let articleOrderMode='magazine'
let appName='MamiNa'
let composerArticleKey=null
let safetyTimer=null
let reconnectTimer=null
let connectionClock=null
let readTimer=null
let resumeTimer=null
let lastResumeAt=0
let telegramState='offline'
let lastConnectedAt=Number(localStorage.getItem('MAMINA_LAST_CONNECTED_AT')||0)
const homeUrls=[]
const readerUrls=[]

function status(id,text,ok=null){const e=$(id);if(!e)return;e.textContent=text;e.className='status'+(ok===true?' ok':ok===false?' error':'')}
function debug(e){
  const text=e?.stack||e?.message||(e===null?'Rejet null':e===undefined?'Rejet undefined':String(e))
  if($('debug'))$('debug').textContent+=($('debug').textContent?'\n':'')+text
  logError('ui',text,e)
}
function esc(s){return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;')}
function formatDate(iso){if(!iso)return'';const d=new Date(`${iso}T12:00:00`);return Number.isNaN(d.getTime())?iso:new Intl.DateTimeFormat('fr-FR',{day:'numeric',month:'long',year:'numeric'}).format(d)}
function formatShortDate(iso){if(!iso)return'';const d=new Date(`${iso}T12:00:00`);return Number.isNaN(d.getTime())?iso:new Intl.DateTimeFormat('fr-FR',{day:'numeric',month:'long'}).format(d)}
function objectUrl(blob,bucket=readerUrls){const u=URL.createObjectURL(blob);bucket.push(u);return u}
function freeHomeUrls(){while(homeUrls.length)URL.revokeObjectURL(homeUrls.pop())}
function freeReaderUrls(){while(readerUrls.length)URL.revokeObjectURL(readerUrls.pop())}

function renderTechLogs(){
  const el=$('techLogs');if(!el)return
  el.textContent=formatLogs()||'Aucun journal.'
  el.scrollTop=el.scrollHeight
}
function updateNetworkUi(){if($('networkState'))$('networkState').textContent=navigator.onLine?'En ligne':'Hors ligne'}
function setLastSync(text){if($('lastSyncState'))$('lastSyncState').textContent=text}

function elapsedShort(ms){
  if(!Number.isFinite(ms)||ms<0)return'—'
  const s=Math.floor(ms/1000)
  if(s<60)return`${s}s`
  const m=Math.floor(s/60)
  if(m<60)return`${m}m`
  const h=Math.floor(m/60)
  return`${h}h`
}
function refreshConnectionPills(){
  const connected=telegramState==='connected'
  const age=lastConnectedAt?Date.now()-lastConnectedAt:Infinity
  const stale=age>=9*60*60*1000
  const text=connected?'●':lastConnectedAt?(stale?'9h+':elapsedShort(age)):'—'
  const klass=connected?'connected':stale?'stale':lastConnectedAt?'recent':'unknown'
  for(const id of ['connectionPillHome','connectionPillReader']){
    const el=$(id);if(!el)continue
    el.textContent=text
    el.className=`connection-pill ${klass}`
    el.title=connected?'Telegram connecté':lastConnectedAt?`Dernière connexion il y a ${elapsedShort(age)}`:'Aucune connexion Telegram connue'
  }
}
function setConnectionUi(state){
  telegramState=state||'offline'
  if(telegramState==='connected'){
    lastConnectedAt=Date.now()
    localStorage.setItem('MAMINA_LAST_CONNECTED_AT',String(lastConnectedAt))
  }
  const names={offline:'hors ligne',connecting:'connexion…',updating:'rattrapage…',connected:'connecté'}
  const text=names[telegramState]||telegramState||'—'
  if($('connectionBadge'))$('connectionBadge').textContent=`Telegram : ${text}`
  if($('telegramState'))$('telegramState').textContent=text
  refreshConnectionPills()

  if(telegramState!=='connected' && navigator.onLine && document.visibilityState==='visible' && service.hasGateway()){
    setTimeout(()=>resumeConnection(`state:${telegramState}`),1400)
  }
}

function setAppName(value){
  appName=String(value||'MamiNa').trim()||'MamiNa'
  $('homeAppName').textContent=appName
  $('readerAppName').textContent=appName
  document.title=appName
}

async function loadLocalSettings(){
  const cfg=await service.getSettings()
  reactionOrder=cfg.reactionOrder
  articleOrderMode=cfg.articleOrderMode
  setAppName(cfg.appTitle||'MamiNa')
  $('reactionOrder').value=reactionOrder
}
async function renderLocalHome(){
  try{
    await loadLocalSettings()
    magazines=await service.magazineSummaries()
    await renderMagazineList()
    $('settingsPanel').hidden=false
    if(magazines.length)$('syncStatus').textContent='Données locales prêtes'
  }catch(e){debug(e)}
}

async function resumeConnection(reason){
  if(!service.hasGateway()||!navigator.onLine)return
  const now=Date.now()
  if(now-lastResumeAt<2500)return
  lastResumeAt=now
  clearTimeout(resumeTimer)
  resumeTimer=setTimeout(async()=>{
    try{
      info('lifecycle',`Reprise application: ${reason}`,{online:navigator.onLine,visibility:document.visibilityState})
      await service.ensureConnected(reason)
      backgroundSync(false)
    }catch(e){
      debug(e)
      if($('syncStatus'))$('syncStatus').textContent=`Telegram indisponible · lecture locale active`
    }
  },120)
}

function renderMarkup(text=''){
  let s=esc(text)
  s=s.replace(/\[color=(#[0-9a-fA-F]{6})\]([\s\S]*?)\[\/color\]/g,'<span style="color:$1">$2</span>')
  s=s.replace(/\*\*([\s\S]+?)\*\*/g,'<strong>$1</strong>')
  s=s.replace(/__([\s\S]+?)__/g,'<u>$1</u>')
  s=s.replace(/~~([\s\S]+?)~~/g,'<s>$1</s>')
  return s.replace(/\n/g,'<br>')
}

/* Local-first startup: cached magazines are usable before Telegram/password. */
async function initializeLocal(){
  updateNetworkUi()
  renderTechLogs()
  refreshConnectionPills()
  await renderLocalHome()
  clearInterval(connectionClock)
  connectionClock=setInterval(refreshConnectionPills,1000)
}
initializeLocal()

async function boot(){
  $('start').disabled=true
  try{
    status('setupStatus','Déverrouillage…')
    await service.unlock($('password').value)

    // Hide the connection panel immediately: local navigation does not wait for Telegram.
    $('setup').hidden=true
    await renderLocalHome()
    status('setupStatus','Connexion Telegram en arrière-plan…')

    let me
    try{
      me=await service.login()
    }catch(e){
      debug(e)
      $('setup').hidden=false
      status('setupStatus','Telegram indisponible. Les données locales restent accessibles.',false)
      return
    }

    const {models,selected}=await service.restoreOrSelectDialog()
    if(!selected){
      if(!models.length)throw new Error('Aucun groupe Telegram avec sujets disponible.')
      const sel=$('groupSelect');sel.innerHTML=''
      models.forEach((m,i)=>{const o=document.createElement('option');o.value=i;o.textContent=m.title;sel.appendChild(o)})
      window.__maminaGroups=models
      $('setup').hidden=false
      $('groupChooser').hidden=false
      status('setupStatus',`Connecté : ${me.displayName||me.username||'Telegram'}. Choisis le groupe.`,true)
      return
    }

    status('setupStatus',`Connecté : ${me.displayName||me.username||'Telegram'}`,true)
    startNetworkLayer()
  }catch(e){debug(e);$('setup').hidden=false;status('setupStatus','Erreur : '+(e.message||e),false)}
  finally{$('start').disabled=false}
}
$('start').onclick=boot

$('chooseGroup').onclick=async()=>{
  try{
    const models=window.__maminaGroups||[]
    const model=models[+$('groupSelect').value]
    if(!model)throw new Error('Choisis un groupe.')
    await service.selectDialog(model)
    $('groupChooser').hidden=true
    $('setup').hidden=true
    startNetworkLayer()
  }catch(e){debug(e);status('setupStatus','Erreur : '+e.message,false)}
}

function startNetworkLayer(){
  service.onConnectionState=setConnectionUi
  setConnectionUi(service.connectionState())

  service.onChanged=async()=>{
    await refreshLocalAfterSync()
    if(currentModel){
      const articleKey=currentArticle()?.articleKey
      const id=currentModel.magazine.magazineId
      currentModel=await service.openMagazine(id)
      await rebuildReaderKeepingArticle(articleKey)
    }
  }

  clearInterval(safetyTimer)
  safetyTimer=setInterval(()=>{
    if(document.visibilityState==='visible'&&navigator.onLine)backgroundSync(false)
  },30000)

  clearInterval(reconnectTimer)
  reconnectTimer=setInterval(()=>{
    if(document.visibilityState==='visible'&&navigator.onLine&&service.hasGateway()&&service.connectionState()!=='connected'){
      resumeConnection('watchdog')
    }
  },10000)

  backgroundSync(true)
}

async function refreshLocalAfterSync(){
  magazines=await service.magazineSummaries()
  const cfg=await service.getSettings()
  setAppName(cfg.appTitle||appName)
  await renderMagazineList()
}

async function backgroundSync(showStatus=true){
  if(!service.hasGateway()||!service.hasDialog()){
    if(showStatus)$('syncStatus').textContent='Lecture locale · Telegram non initialisé'
    return
  }
  try{
    $('syncStatus').classList.remove('sync-error')
    if(showStatus)$('syncStatus').textContent='Synchronisation en arrière-plan…'
    info('ui.sync','Début synchronisation',{manual:showStatus})
    await service.syncAll()
    await refreshLocalAfterSync()
    const at=new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})
    $('syncStatus').textContent=`À jour · ${at}`
    setLastSync(at)
  }catch(e){
    debug(e)
    const msg=e?.message||String(e)
    $('syncStatus').textContent=`Lecture locale · synchro indisponible`
    $('syncStatus').classList.add('sync-error')
    setLastSync(`Erreur : ${msg}`)
  }
}
$('syncNow').onclick=()=>backgroundSync(true)

$('reactionOrder').onchange=async()=>{
  reactionOrder=$('reactionOrder').value
  await service.setReactionOrder(reactionOrder)
  if(currentModel)await renderReader(false)
}

$('verboseLogs').checked=Number(localStorage.getItem('MTCUTE_LOG_LEVEL')||2)>=4
$('verboseLogs').onchange=()=>{
  localStorage.setItem('MTCUTE_LOG_LEVEL',$('verboseLogs').checked?'4':'2')
  info('settings','Niveau de logs mtcute modifié',{level:$('verboseLogs').checked?4:2,restartRequired:true})
  alert('Le niveau de logs mtcute sera appliqué au prochain démarrage de MamiNa.')
}
$('copyLogs').onclick=async()=>{
  try{
    await navigator.clipboard.writeText(formatLogs())
    $('copyLogs').textContent='Copié ✓'
    setTimeout(()=>$('copyLogs').textContent='Copier les logs',1200)
  }catch(e){debug(e);alert('Copie impossible. Tu peux sélectionner les logs manuellement.')}
}
$('clearLogs').onclick=()=>{clearTechLogs();renderTechLogs()}
onLog(()=>renderTechLogs())

async function renderMagazineList(){
  const host=$('magazines');host.innerHTML='';freeHomeUrls()
  if(!magazines.length){host.innerHTML='<p class="empty">Aucune revue locale. Connecte Telegram une première fois pour synchroniser.</p>';return}
  for(const m of magazines){
    const card=document.createElement('button');card.className='magazine-card';card.type='button'
    const cover=m.cover?`<img src="${objectUrl(m.cover,homeUrls)}" alt="Couverture">`:''
    card.innerHTML=`${cover}<div class="magazine-info"><div class="magazine-title">${esc(m.title||'Gazette Famileo')}${m.issue?` · N°${m.issue}`:''}</div><div>${esc(formatDate(m.date))}</div><div class="magazine-stats"><span>${Number(m.reactionCount||0)} réactions</span><span class="unread">${Number(m.unreadCount||0)} non lues</span></div></div>`
    card.onclick=()=>openMagazine(m.magazineId)
    host.appendChild(card)
  }
}

async function openMagazine(id){
  try{
    // No synchronization here. Use the local cache first.
    currentModel=await service.openMagazineLocalFirst(id)
    await loadLocalSettings()
    displayArticles=orderArticles(currentModel.articles,articleOrderMode)
    const firstUnread=displayArticles.findIndex(a=>a.unreadCount>0)
    currentArticleIndex=firstUnread>=0?firstUnread:0
    $('home').hidden=true;$('reader').hidden=false
    await renderReader(true)
  }catch(e){
    debug(e)
    alert(e.message||String(e))
  }
}
$('back').onclick=async()=>{
  if(!$('composerModal').hidden)return
  clearTimeout(readTimer)
  $('reader').hidden=true;$('home').hidden=false
  freeReaderUrls();currentModel=null;displayArticles=[]
  await refreshLocalAfterSync()
}

function magazineOrderValue(a){
  const slotRank={h:0,p:0,b:1}
  return [Number(a.page||0),slotRank[a.slot]??0]
}
function latestCommentId(a, unreadOnly=false){
  let best=0
  for(const c of a.comments||[]){
    if(unreadOnly && (c.isOutgoing||c.id<=a.lastReadMessageId))continue
    best=Math.max(best,Number(c.id||0))
  }
  return best
}
function orderArticles(articles,mode){
  const arr=[...articles]
  if(mode==='magazine'){
    return arr.sort((a,b)=>{
      const A=magazineOrderValue(a),B=magazineOrderValue(b)
      return A[0]-B[0]||A[1]-B[1]
    })
  }
  return arr.sort((a,b)=>{
    const bucket=x=>x.unreadCount>0?0:(x.comments?.length?1:2)
    const ba=bucket(a),bb=bucket(b)
    if(ba!==bb)return ba-bb
    if(ba===0){
      const d=latestCommentId(b,true)-latestCommentId(a,true)
      if(d)return d
    }else if(ba===1){
      const d=latestCommentId(b,false)-latestCommentId(a,false)
      if(d)return d
    }
    const A=magazineOrderValue(a),B=magazineOrderValue(b)
    return A[0]-B[0]||A[1]-B[1]
  })
}
function currentArticle(){return displayArticles[currentArticleIndex]||null}
async function rebuildReaderKeepingArticle(articleKey){
  if(!currentModel)return
  displayArticles=orderArticles(currentModel.articles,articleOrderMode)
  const idx=displayArticles.findIndex(a=>a.articleKey===articleKey)
  currentArticleIndex=idx>=0?idx:0
  await renderReader(true)
}
$('articleOrderButton').onclick=async()=>{
  const key=currentArticle()?.articleKey
  articleOrderMode=articleOrderMode==='magazine'?'activity':'magazine'
  await service.setArticleOrderMode(articleOrderMode)
  await rebuildReaderKeepingArticle(key)
}

async function renderReader(jumpToCurrent=true){
  if(!currentModel)return
  freeReaderUrls()
  $('readerAppName').textContent=appName
  $('readerDate').textContent=formatShortDate(currentModel.magazine.date)
  $('articleOrderButton').textContent=articleOrderMode==='magazine'?'Revue':'Récent'
  $('articleOrderButton').title=articleOrderMode==='magazine'
    ?'Ordre de la revue — toucher pour classer par activité'
    :'Non lus récents, puis lus récents, puis revue — toucher pour revenir à la revue'

  const deck=$('articleDeck')
  deck.innerHTML=''
  const articles=displayArticles

  for(let i=0;i<articles.length;i++){
    const a=articles[i]
    const page=document.createElement('section')
    page.className='article-page'
    page.dataset.index=i
    page.dataset.articleKey=a.articleKey

    const visual=document.createElement('div')
    visual.className='article-visual'
    visual.innerHTML=`<div class="subtle">Chargement article p${a.page}-${a.slot}…</div><button class="add-message" aria-label="Ajouter une réaction">＋</button>`
    page.appendChild(visual)

    const list=document.createElement('div')
    list.className='reaction-list'
    list.dataset.articleKey=a.articleKey
    page.appendChild(list)

    deck.appendChild(page)
    visual.querySelector('.add-message').onclick=()=>openComposer(a.articleKey)
    renderReactionList(a,list)
  }

  updateReaderPage()
  if(jumpToCurrent){
    requestAnimationFrame(()=>{
      deck.scrollLeft=currentArticleIndex*deck.clientWidth
      activateArticle(currentArticleIndex)
    })
  }else preloadAround(currentArticleIndex)
}

async function loadArticleVisual(index){
  if(!currentModel||index<0||index>=displayArticles.length)return
  const page=$('articleDeck').querySelector(`.article-page[data-index="${index}"]`)
  const visual=page?.querySelector('.article-visual')
  if(!visual||visual.querySelector('img')||visual.dataset.loading==='1')return
  visual.dataset.loading='1'
  try{
    const a=displayArticles[index]
    const blob=await service.getArticleImage(a.articleKey)
    const img=document.createElement('img')
    img.src=objectUrl(blob,readerUrls);img.alt=`Article page ${a.page} ${a.slot}`
    visual.querySelector('.subtle')?.remove();visual.prepend(img)
  }catch(e){debug(e)}finally{delete visual.dataset.loading}
}
function preloadAround(index){for(const i of [index,index-1,index+1])loadArticleVisual(i)}

function orderedComments(article){
  const arr=[...(article.comments||[])]
  return reactionOrder==='desc'?arr.sort((a,b)=>b.id-a.id):arr.sort((a,b)=>a.id-b.id)
}
function renderReactionList(article,list){
  list.innerHTML=''
  const comments=orderedComments(article)
  if(!comments.length){list.innerHTML='<div class="empty">Aucune réaction.</div>';return}
  for(const c of comments){
    const d=document.createElement('div')
    d.className='reaction'+(!c.isOutgoing&&c.id>article.lastReadMessageId?' unread-reaction':'')
    d.dataset.messageId=c.id
    d.innerHTML=`<div class="reaction-meta">${esc(c.author)} · ${new Date(c.date||Date.now()).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</div><div class="reaction-text">${renderMarkup(c.displayText||'')}</div>`
    list.appendChild(d)
  }
}

let scrollTimer=null
$('articleDeck').addEventListener('scroll',()=>{
  if(!$('composerModal').hidden)return
  clearTimeout(scrollTimer)
  scrollTimer=setTimeout(()=>{
    const deck=$('articleDeck')
    const idx=Math.max(0,Math.min(displayArticles.length-1,Math.round(deck.scrollLeft/deck.clientWidth)))
    if(idx!==currentArticleIndex){currentArticleIndex=idx;activateArticle(idx)}
    updateReaderPage()
  },90)
},{passive:true})

function updateReaderPage(){
  const a=currentArticle()
  $('readerPage').textContent=a?`Article ${currentArticleIndex+1}/${displayArticles.length} · p${a.page}-${a.slot}`:''
}
function activateArticle(index){
  if(!currentModel)return
  currentArticleIndex=index;updateReaderPage();preloadAround(index)
  const a=displayArticles[index]
  const list=$('articleDeck').querySelector(`.reaction-list[data-article-key="${CSS.escape(a.articleKey)}"]`)
  requestAnimationFrame(()=>positionReactions(a,list))

  clearTimeout(readTimer)
  readTimer=setTimeout(async()=>{
    try{
      await service.markArticleRead(a.articleKey)
      const incoming=(a.comments||[]).filter(c=>!c.isOutgoing).map(c=>c.id)
      a.lastReadMessageId=Math.max(a.lastReadMessageId||0,...incoming,0)
      a.unreadCount=0
      renderReactionList(a,list)
    }catch(e){debug(e)}
  },1400)
}
function positionReactions(article,list){
  if(!list)return
  const unread=[...(article.comments||[])].filter(c=>!c.isOutgoing&&c.id>article.lastReadMessageId).sort((a,b)=>a.id-b.id)
  if(unread.length){
    const target=list.querySelector(`[data-message-id="${unread[0].id}"]`)
    target?.scrollIntoView({block:'start'})
  }else if(reactionOrder==='asc')list.scrollTop=list.scrollHeight
  else list.scrollTop=0
}

/* Rich composer */
function openComposer(articleKey){
  composerArticleKey=articleKey
  $('composerText').innerHTML=''
  $('composerModal').hidden=false
  $('reader').classList.add('composer-open')
  $('back').disabled=true
  $('formatRow').hidden=false
  $('colorRow').hidden=true
  $('sendStatus').textContent=''
  updateComposerKeyboardOffset()
  setTimeout(()=>$('composerText').focus(),60)
}
function closeComposer(){
  $('composerModal').hidden=true
  $('reader').classList.remove('composer-open')
  $('back').disabled=false
  composerArticleKey=null
  $('colorRow').hidden=true
  $('formatRow').hidden=false
  $('composerSheet').style.removeProperty('--keyboard-offset')
}
$('cancelComposer').onclick=closeComposer

function execFormat(command,value=null){
  $('composerText').focus()
  try{document.execCommand(command,false,value)}catch(e){debug(e)}
}
document.querySelectorAll('[data-command]').forEach(b=>{
  b.addEventListener('pointerdown',e=>e.preventDefault())
  b.onclick=()=>execFormat(b.dataset.command)
})
$('clearText').onclick=()=>{$('composerText').innerHTML='';$('composerText').focus()}
$('deleteText').onclick=()=>{
  $('composerText').focus()
  const sel=window.getSelection()
  if(sel&&sel.rangeCount&& !sel.isCollapsed){sel.getRangeAt(0).deleteContents()}
  else document.execCommand('delete')
}

$('colorButton').onclick=async()=>{
  $('formatRow').hidden=true
  $('colorRow').hidden=false
  await renderColors()
}
async function renderColors(){
  const row=$('colorRow');row.innerHTML=''
  const cfg=await service.getSettings()
  const colors=['#000000',...(cfg.recentColors||[]),'#FF0000','#FFD400','#0066FF','#00A651']
  const unique=[...new Set(colors)]
  for(const color of unique){
    const b=document.createElement('button')
    b.className='color-choice';b.style.background=color;b.title=color
    b.addEventListener('pointerdown',e=>e.preventDefault())
    b.onclick=()=>chooseColor(color)
    row.appendChild(b)
  }
  const label=document.createElement('label')
  label.className='color-picker-label';label.title='Autre couleur'
  const input=document.createElement('input');input.type='color'
  input.oninput=()=>chooseColor(input.value)
  label.appendChild(input);row.appendChild(label)
}
async function chooseColor(color){
  execFormat('foreColor',color)
  const swatch=document.querySelector('.color-swatch')
  if(swatch)swatch.style.background=color
  $('colorRow').hidden=true
  $('formatRow').hidden=false
  await service.rememberColor(color)
  setTimeout(()=>$('composerText').focus(),0)
}
function rgbToHex(value){
  const s=String(value||'').trim()
  if(/^#[0-9a-f]{6}$/i.test(s))return s.toUpperCase()
  const m=s.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i)
  if(!m)return null
  return '#'+[m[1],m[2],m[3]].map(x=>Math.max(0,Math.min(255,+x)).toString(16).padStart(2,'0')).join('').toUpperCase()
}
function nodeToMarkup(node){
  if(node.nodeType===Node.TEXT_NODE)return node.nodeValue||''
  if(node.nodeType!==Node.ELEMENT_NODE)return''
  const tag=node.tagName.toLowerCase()
  if(tag==='br')return'\n'

  let inner=''
  const children=[...node.childNodes]
  for(const child of children)inner+=nodeToMarkup(child)

  if(tag==='div'||tag==='p')inner += '\n'
  if(tag==='b'||tag==='strong')inner=`**${inner}**`
  if(tag==='u')inner=`__${inner}__`
  if(tag==='s'||tag==='strike')inner=`~~${inner}~~`

  let color=null
  if(tag==='font')color=rgbToHex(node.getAttribute('color'))
  if(!color && node.style?.color)color=rgbToHex(node.style.color)
  if(color)inner=`[color=${color}]${inner}[/color]`
  return inner
}
function editorMarkup(){
  let text=''
  for(const n of [...$('composerText').childNodes])text+=nodeToMarkup(n)
  return text.replace(/\n{3,}/g,'\n\n').trim()
}
function updateComposerKeyboardOffset(){
  if($('composerModal').hidden)return
  const vv=window.visualViewport
  if(!vv){$('composerSheet').style.setProperty('--keyboard-offset','0px');return}
  const offset=Math.max(0,window.innerHeight-vv.height-vv.offsetTop)
  $('composerSheet').style.setProperty('--keyboard-offset',`${Math.round(offset)}px`)
}
window.visualViewport?.addEventListener('resize',updateComposerKeyboardOffset)
window.visualViewport?.addEventListener('scroll',updateComposerKeyboardOffset)

$('sendText').onclick=async()=>{
  const btn=$('sendText')
  try{
    const text=editorMarkup()
    if(!text.trim())throw new Error('Message vide.')
    if(!service.hasGateway()||service.connectionState()!=='connected'){
      throw new Error('Telegram n’est pas connecté. Le message n’a pas été envoyé.')
    }
    btn.disabled=true;status('sendStatus','Envoi…')
    currentModel=await service.postText(composerArticleKey,text)
    const key=composerArticleKey
    closeComposer()
    await rebuildReaderKeepingArticle(key)
  }catch(e){debug(e);status('sendStatus','Erreur : '+(e.message||e),false)}
  finally{btn.disabled=false}
}

window.addEventListener('online',()=>{updateNetworkUi();resumeConnection('online')})
window.addEventListener('offline',()=>{updateNetworkUi();setConnectionUi('offline');$('syncStatus').textContent='Hors ligne · données locales'})
window.addEventListener('focus',()=>resumeConnection('focus'))
window.addEventListener('pageshow',()=>resumeConnection('pageshow'))
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')resumeConnection('visibilitychange')})
window.addEventListener('pagehide',()=>{clearTimeout(readTimer);freeHomeUrls();freeReaderUrls();info('lifecycle','Application suspendue / pagehide')})
