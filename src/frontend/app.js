import './styles.css'
import { MaminaService } from '../backend/service.js'

const $=id=>document.getElementById(id)
const service=new MaminaService()
let dialogs=[],topics=[],model=null
function status(id,text,ok=null){const e=$(id);e.textContent=text;e.className=ok===true?'ok':ok===false?'error':''}
function debug(e){$('debug').textContent += ($('debug').textContent?'\n':'') + (e?.stack||e?.message||String(e))}
async function run(id,fn){try{return await fn()}catch(e){debug(e);status(id,'Erreur : '+(e?.message||e),false);throw e}}

$('unlock').onclick=()=>run('unlockStatus',async()=>{await service.unlock($('password').value);status('unlockStatus','Secrets déverrouillés en mémoire.',true)})
$('login').onclick=()=>run('telegramStatus',async()=>{const me=await service.login();status('telegramStatus',`Connecté : ${me.displayName||me.username||'Telegram'}`,true)})
$('loadDialogs').onclick=()=>run('telegramStatus',async()=>{
  dialogs=await service.listDialogs()
  const s=$('dialogs')
  s.innerHTML='<option value="">— groupe —</option>'

  const forums=document.createElement('optgroup')
  forums.label='Groupes avec sujets'
  const others=document.createElement('optgroup')
  others.label='Autres dialogues'

  dialogs.forEach((d,i)=>{
    const o=document.createElement('option')
    o.value=i
    o.textContent=(d.isForum?'🧵 ':'')+d.title
    ;(d.isForum?forums:others).appendChild(o)
  })

  if(forums.children.length)s.appendChild(forums)
  if(others.children.length)s.appendChild(others)
  status('telegramStatus',`${forums.children.length} avec sujets · ${others.children.length} autres.`,true)
})
$('dialogs').onchange=async()=>{if($('dialogs').value==='')return;await service.selectDialog(dialogs[+$('dialogs').value]);$('topics').innerHTML='<option value="">— sujet —</option>';topics=[]}
$('loadTopics').onclick=()=>run('topicStatus',async()=>{topics=await service.listTopics();const s=$('topics');s.innerHTML='<option value="">— sujet —</option>';topics.forEach((t,i)=>{const o=document.createElement('option');o.value=i;o.textContent=t.title||`Sujet ${t.id}`;s.appendChild(o)});status('topicStatus',`${topics.length} sujets chargés.`,true)})
$('openTopic').onclick=()=>run('topicStatus',async()=>{if($('topics').value==='')throw new Error('Choisis un sujet.');await service.selectTopic(topics[+$('topics').value]);status('topicStatus','Téléchargement / parsing de la revue…');model=await service.loadMagazine();await renderModel();status('topicStatus','Revue chargée.',true)})
$('createMagazine').onclick=()=>run('topicStatus',async()=>{const file=$('newPdf').files?.[0];if(!file)throw new Error('Choisis un PDF.');status('topicStatus','Analyse du PDF, création du sujet et upload…');const result=await service.createMagazineTopic(file);model={magazine:result.magazine,articles:result.articles.map(a=>({...a,comments:[],rootId:null,duplicateRootIds:[]}))};await renderModel();status('topicStatus',`Sujet créé. ${result.articles.length} articles détectés.`,true)})
$('sync').onclick=()=>run('topicStatus',async()=>{model=await service.refresh();await renderModel();status('topicStatus','Synchronisation terminée.',true)})

async function renderModel(){
  if(!model)return
  $('magazine').innerHTML=`<p><strong>${escapeHtml(model.magazine.title)}</strong> · ${model.magazine.issue?`N°${model.magazine.issue} · `:''}${model.magazine.date||''}<br><span class="hint">${escapeHtml(model.magazine.magazineId)}</span></p>`
  const host=$('articles');host.innerHTML=''
  for(const article of model.articles){
    const section=document.createElement('article');section.className='article'
    const head=document.createElement('div');head.className='article-head';head.innerHTML=`<strong>Page ${article.page} — ${article.slot}</strong><span class="tag">${article.rootId?'file #'+article.rootId:'file non initialisée'}</span>`;section.appendChild(head)
    if(article.duplicateRootIds?.length){const w=document.createElement('div');w.className='hint';w.textContent='Doublons root détectés : '+article.duplicateRootIds.join(', ')+' — la plus ancienne est canonique.';section.appendChild(w)}
    const canvas=await service.pdf.renderArticle(article);section.appendChild(canvas)
    const comments=document.createElement('div')
    for(const c of article.comments){const d=document.createElement('div');d.className='comment';d.innerHTML=`<div class="comment-meta">${escapeHtml(c.author)} · #${c.id}</div><div>${escapeHtml(c.displayText||'')}${c.hasMedia?' 📎':''}</div>`;comments.appendChild(d)}
    if(!article.comments.length)comments.innerHTML='<p class="hint">Aucun commentaire.</p>'
    section.appendChild(comments)
    const composer=document.createElement('div');composer.className='composer';composer.innerHTML='<textarea placeholder="Commentaire"></textarea><input type="file" accept="image/*"><button>Publier sur cette file</button>'
    composer.querySelector('button').onclick=async()=>{const text=composer.querySelector('textarea').value;const imageFile=composer.querySelector('input').files?.[0]||null;composer.querySelector('button').disabled=true;try{model=await service.postComment(article,{text,imageFile});await renderModel()}catch(e){alert(e.message);debug(e)}finally{composer.querySelector('button').disabled=false}}
    section.appendChild(composer);host.appendChild(section)
  }
}
function escapeHtml(s){return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;')}
