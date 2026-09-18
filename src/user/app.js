import './styles.css'
import { UserMaminaService } from '../backend/user-service.js'

const $=id=>document.getElementById(id)
const service=new UserMaminaService()
let magazines=[]
let currentModel=null
let currentArticleIndex=0
let reactionOrder='asc'
let composerArticleKey=null
let safetyTimer=null
let readTimer=null
const homeUrls=[]
const readerUrls=[]

function status(id,text,ok=null){const e=$(id);e.textContent=text;e.className='status'+(ok===true?' ok':ok===false?' error':'')}
function debug(e){$('debug').textContent+=($('debug').textContent?'\n':'')+(e?.stack||e?.message||String(e))}
function esc(s){return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;')}
function formatDate(iso){if(!iso)return'';const d=new Date(`${iso}T12:00:00`);return Number.isNaN(d.getTime())?iso:new Intl.DateTimeFormat('fr-FR',{day:'numeric',month:'long',year:'numeric'}).format(d)}
function objectUrl(blob,bucket=readerUrls){const u=URL.createObjectURL(blob);bucket.push(u);return u}
function freeHomeUrls(){while(homeUrls.length)URL.revokeObjectURL(homeUrls.pop())}
function freeReaderUrls(){while(readerUrls.length)URL.revokeObjectURL(readerUrls.pop())}

function renderMarkup(text=''){
  let s=esc(text)
  s=s.replace(/\[color=(#[0-9a-fA-F]{6})\]([\s\S]*?)\[\/color\]/g,'<span style="color:$1">$2</span>')
  s=s.replace(/\*\*([\s\S]+?)\*\*/g,'<strong>$1</strong>')
  s=s.replace(/__([\s\S]+?)__/g,'<u>$1</u>')
  s=s.replace(/~~([\s\S]+?)~~/g,'<s>$1</s>')
  return s.replace(/\n/g,'<br>')
}

async function boot(){
  $('start').disabled=true
  try{
    status('setupStatus','Déverrouillage…')
    await service.unlock($('password').value)
    status('setupStatus','Connexion Telegram…')
    const me=await service.login()
    const {models,selected}=await service.restoreOrSelectDialog()
    if(!selected){
      if(!models.length)throw new Error('Aucun groupe Telegram avec sujets disponible.')
      const sel=$('groupSelect');sel.innerHTML=''
      models.forEach((m,i)=>{const o=document.createElement('option');o.value=i;o.textContent=m.title;sel.appendChild(o)})
      $('groupChooser').hidden=false
      $('groupChooser').dataset.models='ready'
      window.__maminaGroups=models
      status('setupStatus',`Connecté : ${me.displayName||me.username||'Telegram'}. Choisis le groupe.`,true)
      return
    }
    status('setupStatus',`Connecté : ${me.displayName||me.username||'Telegram'}`,true)
    await enterApp()
  }catch(e){debug(e);status('setupStatus','Erreur : '+(e.message||e),false)}finally{$('start').disabled=false}
}

$('start').onclick=boot
$('chooseGroup').onclick=async()=>{
  try{
    const models=window.__maminaGroups||[]
    const model=models[+$('groupSelect').value]
    if(!model)throw new Error('Choisis un groupe.')
    await service.selectDialog(model)
    $('groupChooser').hidden=true
    await enterApp()
  }catch(e){debug(e);status('setupStatus','Erreur : '+e.message,false)}
}

async function enterApp(){
  $('setup').hidden=true
  $('settingsPanel').hidden=false
  const cfg=await service.getSettings();reactionOrder=cfg.reactionOrder;$('reactionOrder').value=reactionOrder
  service.onChanged=async()=>{await refreshList(false); if(currentModel){const id=currentModel.magazine.magazineId; currentModel=await service.openMagazine(id); await renderReader(true)}}
  await refreshList(true)
  clearInterval(safetyTimer)
  safetyTimer=setInterval(()=>refreshList(false).catch(debug),30000)
}

async function refreshList(showStatus=true){
  try{
    if(showStatus)$('syncStatus').textContent='Synchronisation…'
    magazines=await service.syncAll()
    await renderMagazineList()
    $('syncStatus').textContent=`À jour · ${new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}`
  }catch(e){debug(e);$('syncStatus').textContent='Erreur de synchronisation'}
}
$('syncNow').onclick=()=>refreshList(true)

$('reactionOrder').onchange=async()=>{reactionOrder=$('reactionOrder').value;await service.setReactionOrder(reactionOrder);if(currentModel)await renderReader(true)}

async function renderMagazineList(){
  const host=$('magazines');host.innerHTML='';freeHomeUrls()
  if(!magazines.length){host.innerHTML='<p class="empty">Aucune revue Mamina trouvée.</p>';return}
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
    $('syncStatus').textContent='Ouverture de la revue…'
    currentModel=await service.openMagazine(id)
    const firstUnread=currentModel.articles.findIndex(a=>a.unreadCount>0)
    currentArticleIndex=firstUnread>=0?firstUnread:0
    $('home').hidden=true;$('reader').hidden=false
    await renderReader(true)
    $('syncStatus').textContent='À jour'
  }catch(e){debug(e);alert(e.message)}
}

$('back').onclick=async()=>{
  clearTimeout(readTimer)
  $('reader').hidden=true;$('home').hidden=false
  freeReaderUrls();currentModel=null
  magazines=await service.magazineSummaries()
  await renderMagazineList()
}

async function renderReader(jumpToCurrent=true){
  if(!currentModel)return
  freeReaderUrls()
  $('readerTitle').textContent=`${currentModel.magazine.title||'Gazette'}${currentModel.magazine.issue?` · N°${currentModel.magazine.issue}`:''}`
  const deck=$('articleDeck');deck.innerHTML=''
  const articles=currentModel.articles
  for(let i=0;i<articles.length;i++){
    const a=articles[i],page=document.createElement('section');page.className='article-page';page.dataset.index=i;page.dataset.articleKey=a.articleKey
    const visual=document.createElement('div');visual.className='article-visual';visual.innerHTML=`<div class="subtle">Chargement article p${a.page}-${a.slot}…</div><button class="add-message" aria-label="Ajouter une réaction">＋</button>`
    page.appendChild(visual)
    const list=document.createElement('div');list.className='reaction-list';list.dataset.articleKey=a.articleKey;page.appendChild(list)
    deck.appendChild(page)
    visual.querySelector('.add-message').onclick=()=>openComposer(a.articleKey)
    renderReactionList(a,list)
  }
  updateReaderPage()
  if(jumpToCurrent)requestAnimationFrame(()=>{deck.scrollLeft=currentArticleIndex*deck.clientWidth;activateArticle(currentArticleIndex)})
  else preloadAround(currentArticleIndex)
}

async function loadArticleVisual(index){
  if(!currentModel || index<0 || index>=currentModel.articles.length)return
  const page=$('articleDeck').querySelector(`.article-page[data-index="${index}"]`)
  const visual=page?.querySelector('.article-visual')
  if(!visual || visual.querySelector('img') || visual.dataset.loading==='1')return
  visual.dataset.loading='1'
  try{
    const a=currentModel.articles[index],blob=await service.getArticleImage(a.articleKey),img=document.createElement('img')
    img.src=objectUrl(blob,readerUrls);img.alt=`Article page ${a.page} ${a.slot}`
    visual.querySelector('.subtle')?.remove();visual.prepend(img)
  }catch(e){debug(e)}finally{delete visual.dataset.loading}
}
function preloadAround(index){for(const i of [index,index-1,index+1])loadArticleVisual(i)}

function orderedComments(article){const arr=[...article.comments];return reactionOrder==='desc'?arr.sort((a,b)=>b.id-a.id):arr.sort((a,b)=>a.id-b.id)}
function renderReactionList(article,list){
  list.innerHTML=''
  const comments=orderedComments(article)
  if(!comments.length){list.innerHTML='<div class="empty">Aucune réaction.</div>';return}
  for(const c of comments){
    const d=document.createElement('div');d.className='reaction'+(!c.isOutgoing&&c.id>article.lastReadMessageId?' unread-reaction':'');d.dataset.messageId=c.id
    d.innerHTML=`<div class="reaction-meta">${esc(c.author)} · ${new Date(c.date||Date.now()).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</div><div class="reaction-text">${renderMarkup(c.displayText||'')}</div>`
    list.appendChild(d)
  }
}

let scrollTimer=null
$('articleDeck').addEventListener('scroll',()=>{
  clearTimeout(scrollTimer)
  scrollTimer=setTimeout(()=>{
    const deck=$('articleDeck');const idx=Math.max(0,Math.min(currentModel?.articles.length-1||0,Math.round(deck.scrollLeft/deck.clientWidth)))
    if(idx!==currentArticleIndex){currentArticleIndex=idx;activateArticle(idx)}
    updateReaderPage()
  },100)
},{passive:true})

function updateReaderPage(){if(!currentModel)return;const a=currentModel.articles[currentArticleIndex];$('readerPage').textContent=a?`Article ${currentArticleIndex+1}/${currentModel.articles.length} · p${a.page}-${a.slot}`:''}
function activateArticle(index){
  if(!currentModel)return
  currentArticleIndex=index;updateReaderPage();preloadAround(index)
  const a=currentModel.articles[index],list=$(`articleDeck`).querySelector(`.reaction-list[data-article-key="${CSS.escape(a.articleKey)}"]`)
  requestAnimationFrame(()=>positionReactions(a,list))
  clearTimeout(readTimer)
  readTimer=setTimeout(async()=>{try{await service.markArticleRead(a.articleKey);a.lastReadMessageId=Math.max(a.lastReadMessageId,...a.comments.filter(c=>!c.isOutgoing).map(c=>c.id),0);a.unreadCount=0;renderReactionList(a,list)}catch(e){debug(e)}},1400)
}
function positionReactions(article,list){
  if(!list)return
  const unread=[...article.comments].filter(c=>!c.isOutgoing&&c.id>article.lastReadMessageId).sort((a,b)=>a.id-b.id)
  if(unread.length){const target=list.querySelector(`[data-message-id="${unread[0].id}"]`);target?.scrollIntoView({block:'start'})}
  else if(reactionOrder==='asc')list.scrollTop=list.scrollHeight
  else list.scrollTop=0
}

function openComposer(articleKey){composerArticleKey=articleKey;$('composerText').value='';$('composerModal').hidden=false;$('sendStatus').textContent='';renderColors();setTimeout(()=>$('composerText').focus(),50)}
function closeComposer(){$('composerModal').hidden=true;composerArticleKey=null;$('colorRow').hidden=true}
$('cancelComposer').onclick=closeComposer
$('composerModal').addEventListener('click',e=>{if(e.target===$('composerModal'))closeComposer()})

function wrapSelection(tokenStart,tokenEnd=tokenStart){
  const t=$('composerText'),a=t.selectionStart,b=t.selectionEnd,v=t.value
  t.value=v.slice(0,a)+tokenStart+v.slice(a,b)+tokenEnd+v.slice(b)
  const start=a+tokenStart.length,end=start+(b-a);t.focus();t.setSelectionRange(start,end)
}
document.querySelectorAll('[data-wrap]').forEach(b=>b.onclick=()=>wrapSelection(b.dataset.wrap))
$('clearText').onclick=()=>{$('composerText').value='';$('composerText').focus()}
$('deleteText').onclick=()=>{const t=$('composerText'),a=t.selectionStart,b=t.selectionEnd;if(a!==b)t.setRangeText('',a,b,'end');else if(a>0)t.setRangeText('',a-1,a,'end');t.focus()}
$('colorButton').onclick=()=>{$('colorRow').hidden=!$('colorRow').hidden;if(!$('colorRow').hidden)renderColors()}

async function renderColors(){
  const row=$('colorRow');row.innerHTML=''
  const cfg=await service.getSettings();const colors=['#000000',...(cfg.recentColors||[]),'#FF0000','#FFD400','#0066FF'];const unique=[...new Set(colors)]
  for(const color of unique){const b=document.createElement('button');b.className='color-choice';b.style.background=color;b.title=color;b.onclick=()=>chooseColor(color);row.appendChild(b)}
  const label=document.createElement('label');label.className='color-picker-label';label.title='Autre couleur';const input=document.createElement('input');input.type='color';input.oninput=()=>chooseColor(input.value);label.appendChild(input);row.appendChild(label)
}
async function chooseColor(color){
  const t=$('composerText'),a=t.selectionStart,b=t.selectionEnd,v=t.value,open=`[color=${color.toUpperCase()}]`,close='[/color]'
  t.value=v.slice(0,a)+open+v.slice(a,b)+close+v.slice(b)
  const caret=a+open.length+(b-a);t.focus();if(a===b)t.setSelectionRange(a+open.length,a+open.length);else t.setSelectionRange(a+open.length,caret)
  $('colorRow').hidden=true
  document.querySelector('.color-swatch').style.background=color
  await service.rememberColor(color)
}

$('sendText').onclick=async()=>{
  const btn=$('sendText')
  try{
    const text=$('composerText').value
    if(!text.trim())throw new Error('Message vide.')
    btn.disabled=true;status('sendStatus','Envoi…')
    currentModel=await service.postText(composerArticleKey,text)
    closeComposer();await renderReader(true)
  }catch(e){debug(e);status('sendStatus','Erreur : '+e.message,false)}finally{btn.disabled=false}
}

window.addEventListener('pagehide',()=>{clearInterval(safetyTimer);clearTimeout(readTimer);freeHomeUrls();freeReaderUrls()})
