const CACHE_PREFIX='mamina-shell-'
const CACHE_NAME=CACHE_PREFIX+'v1.1.34'
const SHELL=['./','./index.html','./master.html','./manifest.webmanifest','./apple-touch-icon-v08.png','./mamina-v08-192.png','./mamina-v08-512.png','./telegram-secret.json']

async function cacheResponse(cache,url,response){
  if(response?.ok)await cache.put(url,response.clone()).catch(()=>{})
  return response
}

async function fetchAndCache(cache,url){
  try{
    const response=await fetch(url,{cache:'reload'})
    await cacheResponse(cache,url,response)
    return response
  }catch{return null}
}

async function primeHtmlAssets(cache,url){
  const response=await fetchAndCache(cache,url)
  if(!response?.ok)return
  const text=await response.clone().text().catch(()=>'')
  const refs=[...text.matchAll(/(?:src|href)=["']([^"'#]+)["']/g)].map(m=>m[1])
  for(const ref of refs){
    try{
      const target=new URL(ref,new URL(url,self.registration.scope))
      if(target.origin!==location.origin)continue
      await fetchAndCache(cache,target.href)
    }catch{}
  }
}

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE_NAME)
    for(const item of SHELL)await fetchAndCache(cache,new URL(item,self.registration.scope).href)
    await primeHtmlAssets(cache,new URL('./index.html',self.registration.scope).href)
    await primeHtmlAssets(cache,new URL('./master.html',self.registration.scope).href)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const names=await caches.keys()
    await Promise.all(names.filter(name=>name.startsWith(CACHE_PREFIX)&&name!==CACHE_NAME).map(name=>caches.delete(name)))
    await self.clients.claim()
  })())
})

async function networkFirst(request,{fallbackIndex=false}={}){
  const cache=await caches.open(CACHE_NAME)
  try{
    const response=await fetch(request)
    await cacheResponse(cache,request,response)
    return response
  }catch{
    const cached=await cache.match(request)
    if(cached)return cached
    if(fallbackIndex)return cache.match(new URL('./index.html',self.registration.scope).href)
    throw new Error('offline')
  }
}

self.addEventListener('fetch',event=>{
  const request=event.request
  if(request.method!=='GET')return
  const url=new URL(request.url)
  if(url.origin!==location.origin)return
  const inScope=url.href.startsWith(self.registration.scope)
  if(!inScope)return
  if(request.mode==='navigate'){
    event.respondWith(networkFirst(request,{fallbackIndex:true}))
    return
  }
  const cacheable=['script','style','image','manifest','worker','font'].includes(request.destination)||url.pathname.endsWith('/telegram-secret.json')
  if(cacheable)event.respondWith(networkFirst(request))
})
