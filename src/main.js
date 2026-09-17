import { TelegramClient, InputMedia } from '@mtcute/web'
import { TELEGRAM_CONFIG } from './config.js'
import './style.css'

const $ = id => document.getElementById(id)
const STORAGE_NAME='mamina-telegram-user'
const LAST_DIALOG_KEY='mamina:last-dialog'
const CURSOR_PREFIX='mamina:cursor:'
let tg=null, dialogs=[], selectedDialog=null

function status(id,text,ok=null){const el=$(id);el.textContent=text;el.className='status'+(ok===true?' ok':ok===false?' error':'')}
function debug(v){$('debug').textContent += ($('debug').textContent?'\n':'') + (typeof v==='string'?v:JSON.stringify(v,(k,x)=>typeof x==='bigint'?x.toString():x,2))}
function peerId(peer){const v=peer?.id;return typeof v==='bigint'?v.toString():v&&typeof v==='object'&&'value'in v?String(v.value):String(v??'')}
function peerName(peer){return peer?.displayName||peer?.title||peer?.username||peer?.firstName||'(sans nom)'}
function senderName(m){const s=m?.sender;return s?.displayName||s?.username||s?.firstName||'—'}
function createClient(){if(!tg)tg=new TelegramClient({apiId:TELEGRAM_CONFIG.apiId,apiHash:TELEGRAM_CONFIG.apiHash,storage:STORAGE_NAME,logLevel:2});return tg}

async function ensureLogin(){
  const c=createClient(); status('loginStatus','Connexion à Telegram…')
  const self=await c.start({
    phone:async()=>{const v=prompt('Numéro Telegram (+33…)');if(!v)throw new Error('Connexion annulée.');return v.trim()},
    code:async()=>{const v=prompt('Code reçu dans Telegram');if(!v)throw new Error('Code annulé.');return v.trim()},
    password:async()=>{const v=prompt('Mot de passe Telegram 2FA');if(v===null)throw new Error('Connexion annulée.');return v}
  })
  status('loginStatus',`Connecté : ${self.displayName||''}${self.username?` (@${self.username})`:''}\nSession dans IndexedDB.`,true)
  return c
}

$('connect').onclick=async()=>{try{await ensureLogin()}catch(e){debug(e?.stack||e?.message||String(e));status('loginStatus',`Erreur : ${e?.message||e}`,false)}}
$('logout').onclick=async()=>{try{await createClient().logOut();tg=null;dialogs=[];selectedDialog=null;$('dialogSelect').innerHTML='<option value="">— charger les dialogs —</option>';status('loginStatus','Session révoquée.',true)}catch(e){status('loginStatus',`Erreur : ${e?.message||e}`,false)}}

$('loadDialogs').onclick=async()=>{
  try{
    const c=await ensureLogin(); status('dialogStatus','Chargement des dialogs…'); dialogs=[]
    for await(const d of c.iterDialogs({limit:200})) dialogs.push(d)
    const select=$('dialogSelect'); select.innerHTML='<option value="">— choisir un dialog —</option>'
    const lastId=localStorage.getItem(LAST_DIALOG_KEY)
    dialogs.forEach((d,i)=>{const o=document.createElement('option');const id=peerId(d.peer);o.value=String(i);o.textContent=`${peerName(d.peer)} · ${id}`;if(lastId&&id===lastId)o.selected=true;select.appendChild(o)})
    if(select.value!==''){selectedDialog=dialogs[Number(select.value)];status('dialogStatus',`Sélectionné : ${peerName(selectedDialog.peer)}`,true);renderStoredCursor()}
    else{selectedDialog=null;status('dialogStatus',`${dialogs.length} dialog(s) disponibles.`,true)}
  }catch(e){debug(e?.stack||e?.message||String(e));status('dialogStatus',`Erreur : ${e?.message||e}`,false)}
}

$('dialogSelect').onchange=()=>{
  const v=$('dialogSelect').value
  if(v===''){selectedDialog=null;status('dialogStatus','Aucun dialog sélectionné.');return}
  selectedDialog=dialogs[Number(v)]
  const id=peerId(selectedDialog.peer);localStorage.setItem(LAST_DIALOG_KEY,id)
  status('dialogStatus',`Sélectionné : ${peerName(selectedDialog.peer)}\nID : ${id}`,true)
  renderStoredCursor()
}

$('photo').onchange=()=>{
  const f=$('photo').files?.[0]
  if(!f){$('preview').style.display='none';return}
  $('preview').src=URL.createObjectURL(f);$('preview').style.display='block'
}

function requireDialog(){if(!selectedDialog?.peer)throw new Error('Choisis d’abord un dialog.');return selectedDialog.peer}

$('send').onclick=async()=>{
  const btn=$('send')
  try{
    const c=await ensureLogin(), peer=requireDialog(), text=$('text').value.trim(), file=$('photo').files?.[0]||null
    if(!text&&!file)throw new Error('Ajoute un texte et/ou une photo.')
    btn.disabled=true;status('sendStatus','Publication…')
    let sent
    if(file){
      $('uploadWrap').hidden=false;$('uploadProgress').value=0;$('uploadText').textContent='0 %'
      sent=await c.sendMedia(peer,InputMedia.photo(file),{
        caption:text||undefined,
        progressCallback:(u,t)=>{const p=t?Math.round(u/t*100):0;$('uploadProgress').value=p;$('uploadText').textContent=`${p} %`}
      })
    }else sent=await c.sendText(peer,text)
    status('sendStatus',`Publié ✓ — message #${sent.id}`,true)
    $('text').value='';$('photo').value='';$('preview').style.display='none';$('uploadWrap').hidden=true
  }catch(e){debug(e?.stack||e?.message||String(e));status('sendStatus',`Erreur : ${e?.message||e}`,false)}
  finally{btn.disabled=false}
}

function cursorKey(){return CURSOR_PREFIX+peerId(requireDialog())}
function getCursor(){const v=localStorage.getItem(cursorKey());return v?Number(v):0}
function setCursor(id){localStorage.setItem(cursorKey(),String(id))}
function renderStoredCursor(){const c=getCursor();status('syncStatus',c?`Dernier message synchronisé : #${c}`:'Aucune synchronisation précédente pour ce dialog.')}
function messageText(m){return m?.text||m?.caption||m?.message||''}
function hasMedia(m){return Boolean(m?.media||m?.photo||m?.document||m?.video||m?.animation)}

async function parentInfo(c,m){
  try{
    const p=await c.getReplyTo(m)
    if(!p)return null
    return {id:Number(p.id),author:senderName(p),text:messageText(p).slice(0,120)}
  }catch(e){debug(`getReplyTo(${m.id}) : ${e?.message||e}`);return null}
}

function formatDate(v){if(!v)return'';const d=v instanceof Date?v:new Date(v);if(Number.isNaN(d.getTime()))return'';return new Intl.DateTimeFormat('fr-FR',{dateStyle:'short',timeStyle:'short'}).format(d)}
function esc(v){return String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;")}

function renderMessages(items){
  const c=$('messages');c.innerHTML=''
  if(!items.length){c.innerHTML='<p class="hint">Aucun nouveau message.</p>';return}
  for(const item of items){
    const m=item.message,b=document.createElement('article');b.className='message'
    const parent=item.parent?`<div class="reply-preview">↳ réponse à #${item.parent.id} · ${esc(item.parent.author)}${item.parent.text?`<br>${esc(item.parent.text)}`:''}</div>`:''
    b.innerHTML=`<div class="message-meta"><span class="message-author">${esc(senderName(m))}</span><span class="badge">#${Number(m.id)}</span>${m.date?`<span>${esc(formatDate(m.date))}</span>`:''}</div>${parent}${messageText(m)?`<div class="message-text">${esc(messageText(m))}</div>`:''}${hasMedia(m)?'<div class="media-note">📎 média</div>':''}`
    c.appendChild(b)
  }
}

$('sync').onclick=async()=>{
  const btn=$('sync')
  try{
    const c=await ensureLogin(),peer=requireDialog(),prev=getCursor(),messages=[]
    btn.disabled=true
    if(!prev){
      status('syncStatus','Première synchronisation : lecture des 50 derniers messages…')
      messages.push(...Array.from(await c.getHistory(peer,{limit:50})))
    }else{
      status('syncStatus',`Synchronisation après #${prev}…`)
      for await(const m of c.iterHistory(peer,{minId:prev,limit:Infinity})) if(Number(m.id)>prev) messages.push(m)
    }
    messages.sort((a,b)=>Number(a.id)-Number(b.id))
    const items=[];for(const m of messages)items.push({message:m,parent:await parentInfo(c,m)})
    renderMessages(items)
    if(messages.length){const max=Math.max(...messages.map(m=>Number(m.id)));setCursor(max);status('syncStatus',`${messages.length} message(s) synchronisé(s). Nouveau curseur : #${max}`,true)}
    else status('syncStatus',`Aucun nouveau message depuis #${prev}.`,true)
  }catch(e){debug(e?.stack||e?.message||String(e));status('syncStatus',`Erreur : ${e?.message||e}`,false)}
  finally{btn.disabled=false}
}

window.addEventListener('load',()=>{
  if(TELEGRAM_CONFIG.apiId===12345678||TELEGRAM_CONFIG.apiHash==='0123456789abcdef0123456789abcdef')
    status('loginStatus','Configuration Telegram factice : remplace src/config.js avant le test.',false)
})
