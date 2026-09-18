const DB = 'mamina-user-v0'
const VERSION = 1

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
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transact(store, mode, fn) {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode)
      let result
      try { result = fn(tx.objectStore(store)) } catch (e) { reject(e); return }
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('Transaction annulée.'))
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

export async function putAsset(key, value) { return transact('assets','readwrite',s=>s.put({key,value,updatedAt:new Date().toISOString()})) }
export async function getAsset(key) { const db=await openDb(); try{return (await requestResult(db.transaction('assets').objectStore('assets').get(key)))?.value ?? null}finally{db.close()} }
export async function deleteAsset(key) { return transact('assets','readwrite',s=>s.delete(key)) }

export async function pruneToMagazineIds(keepIds) {
  const keep=new Set(keepIds)
  const all=await listMagazines()
  for(const m of all) if(!keep.has(m.magazineId)) await deleteMagazine(m.magazineId)
}
