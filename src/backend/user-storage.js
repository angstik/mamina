const DB = 'mamina-user-v0'
const VERSION = 2

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('magazines')) {
        const s = db.createObjectStore('magazines', { keyPath: 'magazineId' })
        s.createIndex('date', 'date')
        s.createIndex('topicKey', 'topicKey', { unique: true })
      }
      if (!db.objectStoreNames.contains('articles')) {
        const s = db.createObjectStore('articles', { keyPath: 'articleKey' })
        s.createIndex('magazineId', 'magazineId')
      }
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'key' })
        s.createIndex('magazineId', 'magazineId')
        s.createIndex('articleKey', 'articleKey')
        s.createIndex('topicKey', 'topicKey')
      }
      if (!db.objectStoreNames.contains('readState')) db.createObjectStore('readState', { keyPath: 'articleKey' })
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings')
      if (!db.objectStoreNames.contains('topics')) db.createObjectStore('topics', { keyPath: 'topicKey' })
      if (!db.objectStoreNames.contains('outbox')) {
        const s = db.createObjectStore('outbox', { keyPath: 'articleKey' })
        s.createIndex('magazineId', 'magazineId')
        s.createIndex('createdAt', 'createdAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transact(store, mode, fn) {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      let settled = false
      const fail = err => {
        if (settled) return
        settled = true
        reject(err instanceof Error ? err : new Error(`IndexedDB: ${String(err ?? 'erreur inconnue')}`))
      }

      let tx
      try { tx = db.transaction(store, mode) }
      catch (e) { fail(e); return }

      let result
      try { result = fn(tx.objectStore(store)) }
      catch (e) { fail(e); return }

      if (result && typeof result === 'object' && 'onsuccess' in result && 'onerror' in result) {
        result.onerror = () => fail(
          result.error || tx.error || new Error(`IndexedDB ${store}: requête échouée.`)
        )
      }

      tx.oncomplete = () => {
        if (settled) return
        settled = true
        resolve(result && typeof result === 'object' && 'result' in result ? result.result : result)
      }
      tx.onerror = () => fail(
        tx.error || (result && result.error) || new Error(`IndexedDB ${store}: transaction échouée.`)
      )
      tx.onabort = () => fail(
        tx.error || (result && result.error) || new Error(`IndexedDB ${store}: transaction annulée.`)
      )
    })
  } finally { db.close() }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export const settings = {
  async get(key, fallback=null) {
    const db=await openDb(); try { const v=await requestResult(db.transaction('settings').objectStore('settings').get(key)); return v ?? fallback } finally { db.close() }
  },
  async set(key, value) { return transact('settings','readwrite',s=>s.put(value,key)) },
}

export async function putMagazine(row) { return transact('magazines','readwrite',s=>s.put(row)) }
export async function getMagazine(id) { const db=await openDb(); try{return await requestResult(db.transaction('magazines').objectStore('magazines').get(id))}finally{db.close()} }
export async function getMagazineByTopic(topicKey) { const db=await openDb(); try{return await requestResult(db.transaction('magazines').objectStore('magazines').index('topicKey').get(topicKey))}finally{db.close()} }
export async function listMagazines() { const db=await openDb(); try{const a=await requestResult(db.transaction('magazines').objectStore('magazines').getAll()); return (a||[]).sort((x,y)=>String(y.date||'').localeCompare(String(x.date||'')) || Number(y.topicId)-Number(x.topicId))}finally{db.close()} }
export async function deleteMagazine(id) { return transact('magazines','readwrite',s=>s.delete(id)) }

export async function putTopicState(row) { return transact('topics','readwrite',s=>s.put(row)) }
export async function getTopicState(topicKey) { const db=await openDb(); try{return await requestResult(db.transaction('topics').objectStore('topics').get(topicKey))}finally{db.close()} }

export async function replaceArticles(magazineId, rows) {
  const db=await openDb()
  try {
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('articles','readwrite'), store=tx.objectStore('articles'), idx=store.index('magazineId')
      const r=idx.openCursor(IDBKeyRange.only(magazineId))
      r.onsuccess=()=>{const c=r.result;if(c){c.delete();c.continue()}else for(const row of rows)store.put(row)}
      r.onerror=()=>reject(r.error);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)
    })
  } finally { db.close() }
}
export async function listArticles(magazineId) { const db=await openDb(); try{const a=await requestResult(db.transaction('articles').objectStore('articles').index('magazineId').getAll(magazineId)); return (a||[]).sort((x,y)=>x.page-y.page || ({h:0,p:0,b:1}[x.slot]??0)-({h:0,p:0,b:1}[y.slot]??0))}finally{db.close()} }

export async function putMessages(rows) {
  if (!rows.length) return
  const db=await openDb(); try { await new Promise((resolve,reject)=>{const tx=db.transaction('messages','readwrite'),s=tx.objectStore('messages');for(const r of rows)s.put(r);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)}) } finally { db.close() }
}
export async function listMessagesByMagazine(magazineId) { const db=await openDb(); try{const a=await requestResult(db.transaction('messages').objectStore('messages').index('magazineId').getAll(magazineId)); return (a||[]).sort((x,y)=>x.id-y.id)}finally{db.close()} }
export async function listMessagesByArticle(articleKey) { const db=await openDb(); try{const a=await requestResult(db.transaction('messages').objectStore('messages').index('articleKey').getAll(articleKey)); return (a||[]).sort((x,y)=>x.id-y.id)}finally{db.close()} }
export async function deleteMessagesByMagazine(magazineId) { const rows=await listMessagesByMagazine(magazineId); const db=await openDb(); try{await new Promise((resolve,reject)=>{const tx=db.transaction('messages','readwrite'),s=tx.objectStore('messages');for(const r of rows)s.delete(r.key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}finally{db.close()} }

export async function getReadState(articleKey) { const db=await openDb(); try{return await requestResult(db.transaction('readState').objectStore('readState').get(articleKey))}finally{db.close()} }
export async function putReadState(articleKey,lastReadMessageId) { return transact('readState','readwrite',s=>s.put({articleKey,lastReadMessageId:Number(lastReadMessageId)||0,updatedAt:new Date().toISOString()})) }
export async function listReadStates() { const db=await openDb(); try{return await requestResult(db.transaction('readState').objectStore('readState').getAll())||[]}finally{db.close()} }

async function encodeAsset(value) {
  if (value instanceof Blob) {
    return {
      assetEncoding: 'blob-bytes-v1',
      mime: value.type || 'application/octet-stream',
      bytes: new Uint8Array(await value.arrayBuffer()),
    }
  }
  if (value instanceof Uint8Array) {
    return {
      assetEncoding: 'uint8-v1',
      bytes: new Uint8Array(value),
    }
  }
  if (value instanceof ArrayBuffer) {
    return {
      assetEncoding: 'uint8-v1',
      bytes: new Uint8Array(value.slice(0)),
    }
  }
  return { assetEncoding: 'raw-v1', value }
}

function decodeAsset(encoded) {
  if (encoded == null) return null
  if (!encoded.assetEncoding) return encoded

  if (encoded.assetEncoding === 'blob-bytes-v1') {
    const bytes = encoded.bytes instanceof Uint8Array
      ? encoded.bytes
      : new Uint8Array(encoded.bytes || [])
    return new Blob([bytes], { type: encoded.mime || 'application/octet-stream' })
  }
  if (encoded.assetEncoding === 'uint8-v1') {
    return encoded.bytes instanceof Uint8Array
      ? encoded.bytes
      : new Uint8Array(encoded.bytes || [])
  }
  return encoded.value ?? null
}

export async function putAsset(key, value) {
  const encoded = await encodeAsset(value)
  return transact(
    'assets',
    'readwrite',
    s => s.put({key,value:encoded,updatedAt:new Date().toISOString()})
  )
}

export async function getAsset(key) {
  const db=await openDb()
  try {
    const row=await requestResult(db.transaction('assets').objectStore('assets').get(key))
    return decodeAsset(row?.value ?? null)
  } finally { db.close() }
}

export async function deleteAsset(key) {
  return transact('assets','readwrite',s=>s.delete(key))
}

export async function deleteAssetsByPrefix(prefix) {
  const wanted=String(prefix||'')
  if(!wanted)return 0
  const db=await openDb()
  let deleted=0
  try {
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('assets','readwrite'),store=tx.objectStore('assets'),req=store.openCursor()
      req.onsuccess=()=>{
        const c=req.result
        if(!c)return
        if(String(c.key||'').startsWith(wanted)){c.delete();deleted++}
        c.continue()
      }
      req.onerror=()=>reject(req.error)
      tx.oncomplete=resolve
      tx.onerror=()=>reject(tx.error||req.error)
    })
    return deleted
  } finally { db.close() }
}

export async function pruneToMagazineIds(keepIds) {
  const keep=new Set(keepIds)
  const all=await listMagazines()
  for(const m of all) if(!keep.has(m.magazineId)) await deleteMagazine(m.magazineId)
}


export async function putOutbox(row) {
  if (!row?.articleKey) throw new Error('Outbox: articleKey manquant.')
  return transact('outbox','readwrite',store=>store.put({
    ...row,
    createdAt: row.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }))
}
export async function getOutbox(articleKey) {
  const db=await openDb()
  try{return await requestResult(db.transaction('outbox').objectStore('outbox').get(articleKey))}
  finally{db.close()}
}
export async function listOutbox() {
  const db=await openDb()
  try{
    const rows=await requestResult(db.transaction('outbox').objectStore('outbox').getAll())
    return (rows||[]).sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')))
  }finally{db.close()}
}
export async function deleteOutbox(articleKey) {
  return transact('outbox','readwrite',store=>store.delete(articleKey))
}
export async function countOutbox() {
  const db=await openDb()
  try{return Number(await requestResult(db.transaction('outbox').objectStore('outbox').count())||0)}
  finally{db.close()}
}


function roughByteSize(value, seen=new WeakSet()) {
  if (value == null) return 0
  const t=typeof value
  if (t==='string') return value.length*2
  if (t==='number' || t==='bigint') return 8
  if (t==='boolean') return 4
  if (value instanceof Uint8Array) return value.byteLength
  if (value instanceof ArrayBuffer) return value.byteLength
  if (ArrayBuffer.isView(value)) return value.byteLength
  if (value instanceof Blob) return value.size
  if (value instanceof Date) return 16
  if (t!=='object') return 0
  if (seen.has(value)) return 0
  seen.add(value)

  let total=0
  if (Array.isArray(value)) {
    for (let i=0;i<value.length;i++) total+=roughByteSize(value[i],seen)
    return total
  }
  for (const key of Object.keys(value)) {
    total+=key.length*2
    total+=roughByteSize(value[key],seen)
  }
  return total
}

async function estimateStoreBytes(db, storeName) {
  return new Promise((resolve,reject)=>{
    let bytes=0,count=0
    const tx=db.transaction(storeName,'readonly')
    const req=tx.objectStore(storeName).openCursor()
    req.onsuccess=()=>{
      const c=req.result
      if(!c)return
      count++
      bytes+=roughByteSize(c.key)
      bytes+=roughByteSize(c.value)
      c.continue()
    }
    req.onerror=()=>reject(req.error)
    tx.oncomplete=()=>resolve({bytes,count})
    tx.onerror=()=>reject(tx.error||req.error)
  })
}

export async function estimateLocalStorage() {
  const db=await openDb()
  try {
    const stores={}
    let totalBytes=0,totalCount=0
    const names=Array.from(db.objectStoreNames)
    for (const name of names) {
      const info=await estimateStoreBytes(db,name)
      stores[name]=info
      totalBytes+=info.bytes
      totalCount+=info.count
    }
    return {database:DB,totalBytes,totalCount,stores}
  } finally {
    db.close()
  }
}


export async function clearPublicationCache() {
  const db=await openDb()
  try {
    await new Promise((resolve,reject)=>{
      const names=['magazines','articles','messages','readState','topics','outbox','assets']
      const tx=db.transaction(names,'readwrite')
      for(const name of names){
        const store=tx.objectStore(name)
        if(name!=='assets'){
          store.clear()
          continue
        }
        // Keep only account-level assets that are independent of the selected
        // family group. Everything PDF/article/catalog related is group-bound.
        const req=store.openCursor()
        req.onsuccess=()=>{
          const c=req.result
          if(!c)return
          if(c.key!=='user-avatar')c.delete()
          c.continue()
        }
        req.onerror=()=>reject(req.error)
      }
      tx.oncomplete=resolve
      tx.onerror=()=>reject(tx.error||new Error('Purge cache locale impossible.'))
      tx.onabort=()=>reject(tx.error||new Error('Purge cache locale annulée.'))
    })
  } finally {
    db.close()
  }
}
