import { loadEncryptedSecret, decryptCredentials } from './crypto.js'
import { TelegramGateway } from './telegram.js'
import { FamileoPdf } from './pdf.js'
import { parseMeta, stripMeta } from './protocol.js'
import {
  settings, putMagazine, getMagazine, getMagazineByTopic, listMagazines,
  putTopicState, getTopicState, replaceArticles, listArticles,
  putMessages, listMessagesByMagazine, deleteMessagesByMagazine,
  getReadState, putReadState, listReadStates,
  putAsset, getAsset, deleteAsset, pruneToMagazineIds,
  putOutbox, getOutbox, listOutbox, deleteOutbox, countOutbox,
} from './user-storage.js'
import { info, warn, error as logError } from './log.js'

function idOfPeer(peer) { return String(typeof peer?.id === 'bigint' ? peer.id : peer?.id?.value ?? peer?.id ?? '') }
function topicKey(peer, topicId) { return `${idOfPeer(peer)}:${Number(topicId)}` }
function isMagazineTopic(topic) { return /famileo/i.test(String(topic?.title || '')) }
function topicIdOf(topic) { return Number(topic?.id || topic?.topicId || 0) }
function rowMetaText(message) { return message?.text || message?.caption || '' }

function canvasBlob(canvas, type='image/jpeg', quality=.82) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    try { canvas.width=1; canvas.height=1 } catch {}
    blob ? resolve(blob) : reject(new Error('Conversion image impossible.'))
  }, type, quality))
}

function resolveRowsToArticles(rows, articles) {
  const articleKeys = new Set(articles.map(a => a.articleKey))
  const roots = new Map()
  for (const row of rows) {
    if (row.meta?.kind === 'root' && row.meta.articleKey) {
      const list = roots.get(row.meta.articleKey) || []
      list.push(row)
      roots.set(row.meta.articleKey, list)
    }
  }
  for (const list of roots.values()) list.sort((a,b)=>a.id-b.id)
  const rootById = new Map()
  for (const [ak,list] of roots) for (const root of list) rootById.set(root.id,ak)
  const rowById = new Map(rows.map(r=>[r.id,r]))
  const byArticle = new Map(articles.map(a=>[a.articleKey,[]]))

  const resolveArticle = row => {
    if (row.meta?.articleKey && articleKeys.has(row.meta.articleKey)) return row.meta.articleKey
    let id=row.replyToId, guard=0
    while(id && guard++<50) {
      if(rootById.has(id)) return rootById.get(id)
      const p=rowById.get(id)
      id=p?.replyToId || null
    }
    return null
  }

  for (const row of rows) {
    if (row.meta?.kind === 'message' || (!row.meta && row.replyToId)) {
      const ak = resolveArticle(row)
      if (!ak || !byArticle.has(ak)) continue
      byArticle.get(ak).push({ ...row, articleKey:ak, displayText:stripMeta(row.text) })
    }
  }
  return { roots, byArticle }
}

export class UserMaminaService {
  constructor() {
    this.gateway=null
    this.dialog=null
    this.dialogModel=null
    this.current=null
    this.syncing=null
    this.updateUnsubscribe=null
    this.onChanged=null
    this.onConnectionState=null
    this.authProvider=null
    this.onActivity=null
    this.pdfLoadPromise=null
    this.renderChain=Promise.resolve()
  }

  setAuthProvider(provider) { this.authProvider=provider || null }
  setActivityListener(fn) { this.onActivity=typeof fn==='function'?fn:null }
  activity(text, detail=null) { try { this.onActivity?.({text,detail,at:new Date().toISOString()}) } catch {} }

  async unlock(password) {
    const blob=await loadEncryptedSecret()
    const creds=await decryptCredentials(blob,password)
    this.gateway=new TelegramGateway(creds,{authProvider:this.authProvider})
    this.gateway.onConnectionState(state=>this.onConnectionState?.(state))
  }

  async login() {
    if(!this.gateway) throw new Error('Secrets non déverrouillés.')
    this.activity('Connexion à Telegram…')
    const me=await this.gateway.login()
    this.activity('Profil Telegram…')
    try {
      const profile=await this.gateway.selfProfile()
      if(profile.name) await settings.set('userName',profile.name)
      if(profile.username) await settings.set('userUsername',profile.username)
      if(profile.avatar) await putAsset('user-avatar',new Uint8Array(profile.avatar))
    } catch(e) {
      warn('telegram.profile','Profil local non mis à jour',{message:e?.message||String(e)})
    }
    this.installUpdates()
    try { await this.flushOutbox(true) } catch(e) { warn('outbox','Envoi différé après login incomplet',{message:e?.message||String(e)}) }
    this.activity('Telegram prêt')
    return me
  }

  async localUserProfile() {
    const name=await settings.get('userName','')
    const username=await settings.get('userUsername','')
    const bytes=await getAsset('user-avatar')
    const avatar=bytes ? new Blob([bytes],{type:'image/jpeg'}) : null
    return {name,username,avatar}
  }

  installUpdates() {
    if(this.updateUnsubscribe || !this.gateway) return
    let timer=null
    this.updateUnsubscribe=this.gateway.onNewMessage(()=>{
      clearTimeout(timer)
      timer=setTimeout(async()=>{
        try { await this.syncAll(); this.onChanged?.() } catch(e) { console.error('Mamina sync update',e) }
      },700)
    })
  }

  async listForumDialogs() {
    const rows=await this.gateway.dialogs()
    return rows.map(TelegramGateway.dialogModel).filter(x=>x.isForum)
  }

  async restoreOrSelectDialog(dialogModel=null) {
    const rows=await this.gateway.dialogs()
    const models=rows.map(TelegramGateway.dialogModel).filter(x=>x.isForum)
    const wanted=dialogModel ? idOfPeer((dialogModel.dialog||dialogModel).peer) : await settings.get('groupId','')
    const selected=models.find(m=>idOfPeer(m.dialog.peer)===String(wanted)) || (models.length===1?models[0]:null)
    if(selected) await this.selectDialog(selected)
    return {models,selected}
  }

  async selectDialog(model) {
    this.dialog=model.dialog||model
    this.dialogModel=model.dialog?model:TelegramGateway.dialogModel(model)
    await settings.set('groupId',idOfPeer(this.dialog.peer))
    this.current=null
  }

  async syncAll() {
    if(!this.dialog) throw new Error('Aucun groupe sélectionné.')
    if(this.gateway?.connectionState==='connected') {
      try { await this.flushOutbox() } catch(e) { warn('outbox','Flush avant synchro incomplet',{message:e?.message||String(e)}) }
    }
    this.activity('Synchronisation Telegram…')
    info('sync','Synchronisation demandée',{group:this.dialogModel?.title||null})
    if(this.syncing) return this.syncing
    this.syncing=this._syncAll().then(result=>{info('sync','Synchronisation terminée',{magazines:result?.length||0});return result}).catch(e=>{logError('sync','Synchronisation échouée',e);throw e}).finally(()=>{this.syncing=null})
    return this.syncing
  }

  async _syncAll() {
    const peer=this.dialog.peer
    this.activity('Telegram · lecture des sujets')
    info('sync','Lecture des sujets Telegram')
    const allTopics=await this.gateway.topics(peer)
    info('sync','Sujets reçus',{count:allTopics.length})
    const topics=allTopics.filter(isMagazineTopic).sort((a,b)=>topicIdOf(b)-topicIdOf(a))
    info('sync','Sujets Famileo détectés',{count:topics.length,titles:topics.slice(0,10).map(t=>t.title)})
    const cached=await listMagazines()
    const cachedByTopic=new Map(cached.map(m=>[m.topicKey,m]))
    let found=[]

    // Scan a bounded set of recent Famileo topics; stop when ten magazines are known.
    const scanTopics=topics.slice(0,30)
    for(let topicIndex=0;topicIndex<scanTopics.length;topicIndex++) {
      const topic=scanTopics[topicIndex]
      this.activity(`Messages · revue ${Math.min(topicIndex+1,10)}/${Math.min(scanTopics.length,10)}`)
      const tid=topicIdOf(topic); if(!tid) continue
      const key=topicKey(peer,tid)
      let magazine=cachedByTopic.get(key)
      info('sync.topic','Traitement sujet',{title:topic.title||'',topicId:tid,cached:Boolean(magazine)})
      if(!magazine) magazine=await this.discoverTopic(topic)
      else magazine=await this.syncKnownTopic(magazine)
      if(magazine) found.push(magazine)
      if(found.length>=10) break
    }

    // Keep already cached magazines that may not have appeared in the first page of topics.
    for(const m of cached) if(!found.some(x=>x.magazineId===m.magazineId)) found.push(m)
    found.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')) || b.topicId-a.topicId)
    found=found.slice(0,10)
    if(found.length) await settings.set('appTitle',String(found[0].appTitle||'MamiNa'))

    for(const m of found.slice(0,2)) await this.ensureFullCache(m)
    for(const m of found.slice(2)) await this.dropFullCache(m)

    const keepIds=found.map(m=>m.magazineId)
    const before=await listMagazines()
    for(const old of before) if(!keepIds.includes(old.magazineId)){ await deleteAsset(`cover:${old.magazineId}`); await deleteAsset(`pdf:${old.magazineId}`); await deleteAsset(`staging-pdf:${old.magazineId}`); await deleteMessagesByMagazine(old.magazineId); await replaceArticles(old.magazineId,[]) }
    await pruneToMagazineIds(keepIds)
    await settings.set('magazineOrder',found.map(m=>m.magazineId))
    return this.magazineSummaries()
  }

  async discoverTopic(topic) {
    const peer=this.dialog.peer, tid=topicIdOf(topic), key=topicKey(peer,tid)
    info('sync.discover','Découverte du sujet',{title:topic.title||'',topicId:tid})
    this.activity(`Telegram · messages du sujet ${tid}`)
    const raw=await this.gateway.topicMessages(peer,tid,{limit:Infinity})
    this.activity(`Telegram · ${raw.length} message${raw.length>1?'s':''} reçu${raw.length>1?'s':''}`)
    const rows=raw.map(TelegramGateway.messageModel)
    const pdfIndex=rows.findIndex(r=>r.meta?.kind==='pdf')
    if(pdfIndex<0){info('sync.discover','Pas de marqueur PDF Mamina',{topicId:tid});return null}
    const pdfRow=rows[pdfIndex]
    const rawPdf=raw[pdfIndex]
    if(!rawPdf?.media) return null

    info('sync.discover','Téléchargement PDF',{topicId:tid,messageId:pdfRow.id})
    const bytes=await this.gateway.downloadMessageMedia(rawPdf)
    info('sync.discover','Analyse PDF',{bytes:bytes?.byteLength||bytes?.length||0})
    this.activity('PDF · analyse locale')
    const pdf=await FamileoPdf.load(bytes,{trace:(scope,message,detail)=>info(scope,message,detail)})
    info('sync.discover','PDF analysé',{
      magazineId:pdf.magazine?.magazineId||null,
      issue:pdf.magazine?.issue??null,
      date:pdf.magazine?.date||null,
      pages:pdf.magazine?.pageCount??null,
    })

    if(pdfRow.meta?.sha256 && pdf.magazine.sha256!==pdfRow.meta.sha256) {
      throw new Error(`Hash PDF incohérent pour ${topic.title||tid}.`)
    }

    const articles=pdf.articles()
    info('sync.discover','Articles détectés',{
      topicId:tid,
      count:articles.length,
      slots:articles.reduce((acc,a)=>{acc[a.slot]=(acc[a.slot]||0)+1;return acc},{}),
    })

    const resolved=resolveRowsToArticles(rows,articles)

    info('sync.discover','Rendu couverture',{topicId:tid})
    const coverCanvas=await pdf.renderCover()
    info('sync.discover','Conversion couverture en image',{
      width:coverCanvas.width,
      height:coverCanvas.height,
    })
    const cover=await canvasBlob(coverCanvas)
    info('sync.discover','Stockage couverture',{
      magazineId:pdf.magazine.magazineId,
      bytes:cover.size||0,
    })
    this.activity('Base locale · couverture')
    await putAsset(`cover:${pdf.magazine.magazineId}`,cover)
    info('sync.discover','Couverture stockée',{
      magazineId:pdf.magazine.magazineId,
      storage:'Uint8Array+MIME',
    })

    const read=await this.readMap()
    const comments=[...resolved.byArticle.values()].flat()
    const unread=comments.filter(c=>!c.isOutgoing && c.id>(read.get(c.articleKey)||0)).length
    const record={
      ...pdf.magazine,
      appTitle:String(pdfRow.meta?.appTitle||'MamiNa'),
      topicId:tid, topicKey:key, topicTitle:topic.title||'', pdfMessageId:pdfRow.id,
      reactionCount:comments.length, unreadCount:unread, fullyCached:false,
      lastMessageId:rows.reduce((m,r)=>Math.max(m,r.id),0), updatedAt:new Date().toISOString(),
    }
    this.activity('Base locale · index revue')
    await putMagazine(record)
    await replaceArticles(record.magazineId,articles.map(a=>({...a,magazineId:record.magazineId})))
    await putTopicState({topicKey:key,topicId:tid,cursor:record.lastMessageId,updatedAt:record.updatedAt})
    // Temporarily retain bytes so promotion to top-2 needs no second download.
    await putAsset(`staging-pdf:${record.magazineId}`,bytes)
    try { await pdf.doc?.cleanup?.(); await pdf.doc?.destroy?.() } catch {}
    info('sync.discover','Revue découverte',{magazineId:record.magazineId,articles:articles.length,reactions:comments.length})
    return record
  }

  async syncKnownTopic(magazine) {
    const peer=this.dialog.peer, state=await getTopicState(magazine.topicKey)
    info('sync.known','Synchronisation revue connue',{magazineId:magazine.magazineId,topicId:magazine.topicId})
    const cursor=Number(state?.cursor||magazine.lastMessageId||0)
    this.activity(`Telegram · messages N°${magazine.issue||''}`)
    const raw=await this.gateway.topicMessages(peer,magazine.topicId,{minId:cursor,limit:Infinity})
    this.activity(raw.length?`Telegram · ${raw.length} nouveau${raw.length>1?'x':''} message${raw.length>1?'s':''}`:'Telegram · aucun nouveau message')
    if(!raw.length){info('sync.known','Aucun nouveau message',{magazineId:magazine.magazineId,cursor});return magazine}
    const rows=raw.map(TelegramGateway.messageModel).filter(r=>r.id>cursor)
    const messages=rows.filter(r=>r.meta?.kind==='message')
    let unreadAdd=0
    for(const m of messages) {
      if(m.isOutgoing) continue
      const rs=await getReadState(m.meta?.articleKey||'')
      if(m.id>Number(rs?.lastReadMessageId||0)) unreadAdd++
    }
    const next={...magazine,reactionCount:Number(magazine.reactionCount||0)+messages.length,unreadCount:Number(magazine.unreadCount||0)+unreadAdd,lastMessageId:Math.max(cursor,...rows.map(r=>r.id)),updatedAt:new Date().toISOString()}
    this.activity('Base locale · mise à jour des messages')
    await putMagazine(next)
    await putTopicState({topicKey:magazine.topicKey,topicId:magazine.topicId,cursor:next.lastMessageId,updatedAt:next.updatedAt})

    if(magazine.fullyCached && rows.length) await this.mergeFullRows(next,rows)
    return next
  }

  async ensureFullCache(magazine) {
    this.activity(`Cache local · ${magazine.issue?`N°${magazine.issue}`:'revue'}`)
    const fresh=await getMagazine(magazine.magazineId) || magazine
    let pdfBytes=await getAsset(`pdf:${fresh.magazineId}`)
    if(!pdfBytes) pdfBytes=await getAsset(`staging-pdf:${fresh.magazineId}`)

    // Critical fast path: a fully cached magazine must not be reparsed every
    // 30-second synchronization cycle.
    if(fresh.fullyCached && pdfBytes) return fresh

    let raw=null, rows=null
    if(!pdfBytes || !fresh.fullyCached) {
      raw=await this.gateway.topicMessages(this.dialog.peer,fresh.topicId,{limit:Infinity})
      rows=raw.map(TelegramGateway.messageModel)
      const pdfIdx=rows.findIndex(r=>r.meta?.kind==='pdf')
      if(pdfIdx<0) throw new Error(`PDF Mamina introuvable dans ${fresh.topicTitle}.`)
      if(!pdfBytes) pdfBytes=await this.gateway.downloadMessageMedia(raw[pdfIdx])
    }

    let articles=await listArticles(fresh.magazineId)
    if(!articles.length) {
      const pdf=await FamileoPdf.load(pdfBytes)
      articles=pdf.articles().map(a=>({...a,magazineId:fresh.magazineId}))
      await replaceArticles(fresh.magazineId,articles)
      try { await pdf.doc?.cleanup?.(); await pdf.doc?.destroy?.() } catch {}
    }
    await putAsset(`pdf:${fresh.magazineId}`,pdfBytes)
    await deleteAsset(`staging-pdf:${fresh.magazineId}`)

    if(!rows) {
      raw=await this.gateway.topicMessages(this.dialog.peer,fresh.topicId,{limit:Infinity})
      rows=raw.map(TelegramGateway.messageModel)
    }
    await deleteMessagesByMagazine(fresh.magazineId)
    await this.persistResolvedMessages(fresh,articles,rows)
    const resolved=resolveRowsToArticles(rows,articles)
    const comments=[...resolved.byArticle.values()].flat()
    const unread=await this.countUnread(comments)
    const next={...fresh,reactionCount:comments.length,unreadCount:unread,fullyCached:true,lastMessageId:rows.reduce((m,r)=>Math.max(m,r.id),0),updatedAt:new Date().toISOString()}
    await putMagazine(next)
    await putTopicState({topicKey:next.topicKey,topicId:next.topicId,cursor:next.lastMessageId,updatedAt:next.updatedAt})
    return next
  }

  async dropFullCache(magazine) {
    const fresh=await getMagazine(magazine.magazineId) || magazine
    if(fresh.fullyCached) {
      const oldArticles=await listArticles(fresh.magazineId)
      await deleteMessagesByMagazine(fresh.magazineId)
      for(const a of oldArticles) await deleteAsset(`article:${a.articleKey}`)
      await replaceArticles(fresh.magazineId,[])
      await deleteAsset(`pdf:${fresh.magazineId}`)
      await putMagazine({...fresh,fullyCached:false})
    }
    await deleteAsset(`staging-pdf:${fresh.magazineId}`)
  }

  async mergeFullRows(magazine, rows) {
    const articles=await listArticles(magazine.magazineId)
    if(!articles.length) return
    await this.persistResolvedMessages(magazine,articles,rows)
  }

  async persistResolvedMessages(magazine,articles,rows) {
    const existing=await listMessagesByMagazine(magazine.magazineId)
    const all=[...existing.map(x=>({...x})),...rows]
    const resolved=resolveRowsToArticles(all,articles)
    const comments=[...resolved.byArticle.values()].flat()
    const payload=comments.map(c=>({
      ...c,
      key:`${magazine.magazineId}:${c.id}`,
      magazineId:magazine.magazineId,
      topicKey:magazine.topicKey,
      articleKey:c.articleKey,
    }))
    await putMessages(payload)
  }

  async readMap() {
    const states=await listReadStates()
    return new Map(states.map(s=>[s.articleKey,Number(s.lastReadMessageId||0)]))
  }

  async countUnread(comments) {
    const map=await this.readMap()
    return comments.filter(c=>!c.isOutgoing && c.id>(map.get(c.articleKey)||0)).length
  }

  async magazineSummaries(rows=null) {
    const magazines=(rows||await listMagazines()).slice(0,10)
    return Promise.all(magazines.map(async m=>({...m,cover:await getAsset(`cover:${m.magazineId}`)})))
  }

  async openMagazineLocalFirst(magazineId) {
    const magazine=await getMagazine(magazineId)
    if(!magazine) throw new Error('Revue inconnue.')

    const bytes=await getAsset(`pdf:${magazineId}`)
    const storedArticles=await listArticles(magazineId)
    const rows=await listMessagesByMagazine(magazineId)

    // Fast path: no PDF.js parse on every opening. Articles and messages are
    // already indexed in IndexedDB. PDF.js is loaded lazily only if an image
    // is not in the local asset cache.
    if(magazine.fullyCached && bytes && storedArticles.length) {
      const same=this.current?.magazine?.magazineId===magazineId
      this.current={
        magazine,
        pdf:same ? this.current.pdf : null,
        pdfBytes:bytes,
        articles:storedArticles,
        rows,
      }
      return this.currentView()
    }

    if(!this.gateway || !this.dialog) {
      throw new Error('Cette revue n’est pas entièrement disponible hors ligne. Connecte Telegram pour la charger.')
    }
    return this.openMagazine(magazineId)
  }

  async openMagazine(magazineId) {
    const magazine=await getMagazine(magazineId)
    if(!magazine) throw new Error('Revue inconnue.')
    let bytes=await getAsset(`pdf:${magazineId}`)
    let rows
    if(magazine.fullyCached && bytes) {
      rows=await listMessagesByMagazine(magazineId)
      const pdf=await FamileoPdf.load(bytes,{trace:(scope,message,detail)=>info(scope,message,detail)})
      this.current={magazine,pdf,articles:pdf.articles(),rows}
    } else {
      const raw=await this.gateway.topicMessages(this.dialog.peer,magazine.topicId,{limit:Infinity})
      const models=raw.map(TelegramGateway.messageModel)
      const pdfIdx=models.findIndex(r=>r.meta?.kind==='pdf')
      if(pdfIdx<0) throw new Error('PDF introuvable dans le sujet.')
      bytes=await this.gateway.downloadMessageMedia(raw[pdfIdx])
      const pdf=await FamileoPdf.load(bytes,{trace:(scope,message,detail)=>info(scope,message,detail)})
      const articles=pdf.articles()
      const resolved=resolveRowsToArticles(models,articles)
      rows=[...resolved.byArticle.values()].flat()
      this.current={magazine,pdf,articles,rows}
    }
    return this.currentView()
  }

  async currentView() {
    if(!this.current) return null
    const {magazine,pdf,articles,rows}=this.current
    const read=await this.readMap()
    const commentsBy=new Map(articles.map(a=>[a.articleKey,[]]))
    for(const row of rows) if(row.articleKey && commentsBy.has(row.articleKey)) commentsBy.get(row.articleKey).push(row)
    const outbox=await listOutbox()
    const pendingBy=new Map(outbox.map(x=>[x.articleKey,x]))
    const withState=articles.map(a=>{
      const comments=(commentsBy.get(a.articleKey)||[]).sort((x,y)=>x.id-y.id)
      const pending=pendingBy.get(a.articleKey)
      if(pending) comments.push({
        id:Number.MAX_SAFE_INTEGER,
        articleKey:a.articleKey,
        author:'Moi',
        isOutgoing:true,
        pending:true,
        date:pending.createdAt,
        displayText:pending.text,
        text:pending.text,
      })
      const lastRead=read.get(a.articleKey)||0
      return {...a,comments,lastReadMessageId:lastRead,unreadCount:comments.filter(c=>!c.isOutgoing&&c.id>lastRead).length}
    })
    return {magazine,articles:withState,pdf}
  }

  async markArticleRead(articleKey) {
    if(!this.current) return
    const rows=this.current.rows.filter(r=>r.articleKey===articleKey && !r.isOutgoing)
    if(!rows.length) return
    const max=Math.max(...rows.map(r=>r.id))
    await putReadState(articleKey,max)
    const magazine=await getMagazine(this.current.magazine.magazineId)
    if(magazine) {
      const all=this.current.rows
      const unread=await this.countUnread(all)
      await putMagazine({...magazine,unreadCount:unread})
      this.current.magazine={...magazine,unreadCount:unread}
    }
  }

  async queueText(articleKey,text) {
    if(!this.current) throw new Error('Aucune revue ouverte.')
    const article=this.current.articles.find(a=>a.articleKey===articleKey)
    if(!article) throw new Error('Article inconnu.')
    const clean=String(text||'').trim()
    if(!clean) throw new Error('Message vide.')

    // Keyed by articleKey: at most one pending message per discussion.
    await putOutbox({
      articleKey,
      magazineId:this.current.magazine.magazineId,
      topicId:this.current.magazine.topicId,
      text:clean,
      format:'mamina-markdown-v1',
    })
    info('outbox','Message mis en attente',{articleKey})
    return this.currentView()
  }

  async postText(articleKey,text) {
    if(!this.current) throw new Error('Aucune revue ouverte.')
    const clean=String(text||'').trim()
    if(!clean) throw new Error('Message vide.')

    const online = typeof navigator==='undefined' || navigator.onLine!==false
    if(!this.gateway || !this.dialog || !online || this.gateway.connectionState!=='connected') {
      return this.queueText(articleKey,clean)
    }

    try {
      await this._sendTextNow({
        articleKey,
        magazineId:this.current.magazine.magazineId,
        topicId:this.current.magazine.topicId,
        text:clean,
        format:'mamina-markdown-v1',
      })
      const magazine=await getMagazine(this.current.magazine.magazineId)
      if(magazine) await this.syncKnownTopic(magazine)
      return this.openMagazineLocalFirst(this.current.magazine.magazineId)
    } catch(e) {
      // Network/connection loss during send: preserve the user's text locally.
      warn('outbox','Envoi direct impossible, message conservé localement',{
        articleKey,message:e?.message||String(e),
      })
      return this.queueText(articleKey,clean)
    }
  }

  async _sendTextNow(item) {
    if(!this.gateway || !this.dialog) throw new Error('Telegram non initialisé.')
    const magazine=await getMagazine(item.magazineId)
    if(!magazine) throw new Error('Revue de la file d’attente introuvable.')

    let bytes=await getAsset(`pdf:${magazine.magazineId}`)
    if(!bytes) bytes=await getAsset(`staging-pdf:${magazine.magazineId}`)
    if(!bytes) throw new Error('PDF local requis pour résoudre l’article en attente.')

    const pdf=await FamileoPdf.load(bytes)
    try {
      const article=pdf.articles().find(a=>a.articleKey===item.articleKey)
      if(!article) throw new Error('Article de la file d’attente introuvable.')
      const full=await this.gateway.topicMessages(this.dialog.peer,Number(item.topicId),{limit:Infinity})
      const {rootId}=await this.gateway.ensureRoot(
        this.dialog.peer,Number(item.topicId),pdf.magazine,article,full
      )
      await this.gateway.postTextComment(
        this.dialog.peer,Number(item.topicId),rootId,item.articleKey,item.text,item.format||'mamina-markdown-v1'
      )
    } finally {
      try { await pdf.doc?.cleanup?.(); await pdf.doc?.destroy?.() } catch {}
    }
  }

  async flushOutbox(force=false) {
    if(!this.gateway || !this.dialog) return 0
    const connected=this.gateway.connectionState==='connected' || this.gateway.connectionState==='updating' || this.gateway.isConnected()
    if(!connected && !force) return 0
    const rows=await listOutbox()
    if(rows.length) this.activity(`Envoi différé · ${rows.length} message${rows.length>1?'s':''}`)
    let sent=0
    for(const item of rows) {
      try {
        await this._sendTextNow(item)
        await deleteOutbox(item.articleKey)
        sent++
        info('outbox','Message différé envoyé',{articleKey:item.articleKey})
      } catch(e) {
        warn('outbox','Message différé toujours en attente',{
          articleKey:item.articleKey,message:e?.message||String(e),
        })
        // Keep remaining messages; a permission/network failure may affect all.
        if(this.gateway.connectionState!=='connected') break
      }
    }
    return sent
  }

  async reconnectAndFlush(reason='manual') {
    if(!this.gateway) throw new Error('Telegram non initialisé.')
    this.activity('Reconnexion à Telegram…')
    await this.gateway.ensureConnected(reason)
    if(!this.dialog) {
      const restored=await this.restoreOrSelectDialog()
      if(!restored.selected) throw new Error('Groupe Telegram non sélectionné.')
    }
    const sent=await this.flushOutbox(true)
    this.activity(sent?`Messages différés envoyés · ${sent}`:'Telegram connecté')
    return sent
  }

  async pendingCount() { return countOutbox() }
  async pendingForArticle(articleKey) { return getOutbox(articleKey) }

  async ensureCurrentPdf() {
    if(!this.current) throw new Error('Aucune revue ouverte.')
    if(this.current.pdf) return this.current.pdf
    if(this.pdfLoadPromise) return this.pdfLoadPromise

    const currentRef=this.current
    this.pdfLoadPromise=(async()=>{
      const bytes=currentRef.pdfBytes || await getAsset(`pdf:${currentRef.magazine.magazineId}`)
      if(!bytes) throw new Error('PDF local indisponible.')
      const pdf=await FamileoPdf.load(bytes)
      currentRef.pdf=pdf
      currentRef.pdfBytes=bytes
      const parsed=pdf.articles()
      if(parsed.length){
        currentRef.articles=parsed
        try { await replaceArticles(currentRef.magazine.magazineId,parsed) } catch {}
      }
      return pdf
    })()
    try { return await this.pdfLoadPromise }
    finally { this.pdfLoadPromise=null }
  }

  async getArticleImageInfo(articleKey) {
    if(!this.current) throw new Error('Aucune revue ouverte.')
    const assetKey=`article:${articleKey}`
    const cached=await getAsset(assetKey)
    if(cached) return {blob:cached,source:'local'}

    const task=async()=>{
      const secondCheck=await getAsset(assetKey)
      if(secondCheck) return {blob:secondCheck,source:'local'}
      let article=this.current?.articles.find(a=>a.articleKey===articleKey)
      if(!article) throw new Error('Article inconnu.')
      this.activity('Préparation de l’article…')
      const pdf=await this.ensureCurrentPdf()
      article=this.current?.articles.find(a=>a.articleKey===articleKey) || article
      const canvas=await pdf.renderArticle(article)
      const blob=await canvasBlob(canvas,'image/jpeg',.84)
      if(this.current?.magazine?.fullyCached) await putAsset(assetKey,blob)
      return {blob,source:'PDF'}
    }
    const result=this.renderChain.then(task,task)
    this.renderChain=result.then(()=>undefined,()=>undefined)
    return result
  }

  async getArticleImage(articleKey) {
    return (await this.getArticleImageInfo(articleKey)).blob
  }

  async warmArticleImages(articleKeys=[]) {
    if(!this.current?.magazine?.fullyCached) return
    for(const key of articleKeys){
      try {
        const cached=await getAsset(`article:${key}`)
        if(!cached) await this.getArticleImageInfo(key)
      } catch(e) {
        warn('cache','Préchargement article impossible',{articleKey:key,message:e?.message||String(e)})
      }
      await new Promise(resolve=>{
        if('requestIdleCallback' in globalThis) requestIdleCallback(()=>resolve(),{timeout:350})
        else setTimeout(resolve,40)
      })
    }
  }

  async closeMagazine() {
    const current=this.current
    try { await this.renderChain } catch {}
    this.current=null
    this.pdfLoadPromise=null
    try { await current?.pdf?.doc?.cleanup?.() } catch {}
    try { await current?.pdf?.doc?.destroy?.() } catch {}
  }

  async ensureConnected(reason='app-resume') {
    if(!this.gateway) throw new Error('Telegram non initialisé.')
    return this.gateway.ensureConnected(reason)
  }

  connectionState() { return this.gateway?.connectionState || 'offline' }
  hasGateway() { return Boolean(this.gateway) }
  hasDialog() { return Boolean(this.dialog) }

  async adminListForumDialogs() {
    return this.listForumDialogs()
  }

  async adminListTopics() {
    if(!this.dialog) throw new Error('Aucun groupe sélectionné.')
    return this.gateway.topics(this.dialog.peer)
  }

  async adminCreateMagazine(file,{onStep,progressCallback}={}) {
    if(!this.dialog) throw new Error('Aucun groupe sélectionné.')
    if(!file) throw new Error('PDF manquant.')
    const step=(name,detail={})=>onStep?.({name,detail,at:new Date().toISOString()})
    try {
      step('magazine.pdf.read.start',{name:file.name,size:file.size,type:file.type})
      const pdf=await FamileoPdf.load(file)
      const appTitle=await settings.get('appTitle','MamiNa')
      const magazine={...pdf.magazine,appTitle}
      const articles=pdf.articles()
      try { await pdf.doc?.cleanup?.(); await pdf.doc?.destroy?.() } catch {}
      step('magazine.pdf.read.done',{
        magazineId:magazine.magazineId,issue:magazine.issue,date:magazine.date,articles:articles.length
      })
      const title=`${magazine.date?magazine.date.slice(0,7):'Revue'} — Famileo${magazine.issue?` N°${magazine.issue}`:''}`
      step('magazine.topic.create.start',{title})
      const {topicId}=await this.gateway.createTopic(this.dialog.peer,title)
      step('magazine.topic.create.done',{topicId})
      await this.gateway.postMagazinePdf(this.dialog.peer,topicId,file,magazine,{progressCallback,onStep})
      step('magazine.done',{topicId})
      await this.syncAll()
      return {topicId,magazine,articles}
    } catch(error) {
      onStep?.({
        name:'magazine.error',
        detail:{message:error?.message||String(error),stack:error?.stack||null},
        at:new Date().toISOString(),
      })
      throw error
    }
  }

  async setAppTitle(value) {
    const title=String(value||'').trim()||'MamiNa'
    await settings.set('appTitle',title)
    return title
  }

  async getSettings() {
    return {
      reactionOrder:await settings.get('reactionOrder','asc'),
      articleOrderMode:await settings.get('articleOrderMode','magazine'),
      recentColors:await settings.get('recentColors',[]),
      appTitle:await settings.get('appTitle','MamiNa'),
      theme:await settings.get('theme','system'),
    }
  }
  async setReactionOrder(order) {
    if(!['asc','desc'].includes(order))throw new Error('Ordre invalide.')
    await settings.set('reactionOrder',order)
  }
  async setTheme(theme) {
    if(!['system','light','dark'].includes(theme)) throw new Error('Thème invalide.')
    await settings.set('theme',theme)
  }
  async setArticleOrderMode(mode) {
    if(!['magazine','activity'].includes(mode))throw new Error('Ordre d’articles invalide.')
    await settings.set('articleOrderMode',mode)
  }
  async rememberColor(color) {
    const normalized=String(color||'').toUpperCase()
    if(!/^#[0-9A-F]{6}$/.test(normalized)) return
    const old=await settings.get('recentColors',[])
    await settings.set('recentColors',[normalized,...old.filter(x=>x!==normalized)].slice(0,3))
  }
}
