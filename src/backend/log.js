const KEY='mamina:tech-logs:v1'
const MAX=400
const listeners=new Set()

function safe(value){
  if(value==null)return value
  if(value instanceof Error)return {name:value.name,message:value.message,stack:value.stack}
  try{return JSON.parse(JSON.stringify(value,(k,v)=>typeof v==='bigint'?v.toString():v))}catch{return String(value)}
}

export function techLog(level,scope,message,detail=null){
  const row={at:new Date().toISOString(),level,scope,message,detail:safe(detail)}
  let rows=[]
  try{rows=JSON.parse(localStorage.getItem(KEY)||'[]')}catch{}
  rows.push(row)
  if(rows.length>MAX)rows=rows.slice(-MAX)
  try{localStorage.setItem(KEY,JSON.stringify(rows))}catch{}
  for(const fn of listeners){try{fn(row)}catch{}}
  const method=level==='error'?'error':level==='warn'?'warn':'log'
  console[method](`[Mamina:${scope}] ${message}`,detail??'')
  return row
}
export const info=(s,m,d)=>techLog('info',s,m,d)
export const warn=(s,m,d)=>techLog('warn',s,m,d)
export const error=(s,m,d)=>techLog('error',s,m,d)
export function logs(){try{return JSON.parse(localStorage.getItem(KEY)||'[]')}catch{return[]}}
export function clearLogs(){localStorage.removeItem(KEY);for(const fn of listeners){try{fn(null)}catch{}}}
export function onLog(fn){listeners.add(fn);return()=>listeners.delete(fn)}
export function formatLogs(){return logs().map(r=>`${new Date(r.at).toLocaleString('fr-FR')}  ${r.level.toUpperCase()}  ${r.scope}  ${r.message}${r.detail!=null?'\n'+JSON.stringify(r.detail,null,2):''}`).join('\n\n')}
