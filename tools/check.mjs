import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const fail=message=>{console.error('CHECK FAILED:',message);process.exitCode=1}
const exists=rel=>fs.existsSync(path.join(root,rel))
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8')

const required=['index.html','master.html','vite.config.js','package.json','package-lock.json','public/manifest.webmanifest','public/telegram-secret.json','src/user/app.js','src/user/styles.css','src/backend/user-service.js']
for(const file of required)if(!exists(file))fail(`fichier requis absent: ${file}`)

const forbidden=['test-v2.html','src/main.js','src/style.css','src/config.js','src/frontend/app.js','src/frontend/styles.css']
for(const file of forbidden)if(exists(file))fail(`fichier obsolète encore présent: ${file}`)

function walk(dir){
  const out=[]
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name)
    if(entry.isDirectory())out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const jsFiles=[
  ...walk(path.join(root,'src')).filter(f=>f.endsWith('.js')),
  ...walk(path.join(root,'tools')).filter(f=>f.endsWith('.js')||f.endsWith('.mjs')),
  path.join(root,'vite.config.js'),
]
for(const file of jsFiles){
  const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'})
  if(r.status!==0)fail(`syntaxe invalide: ${path.relative(root,file)}\n${r.stderr||r.stdout}`)
  const src=fs.readFileSync(file,'utf8')
  const re=/(?:import\s+(?:[^'"]+?\s+from\s+)?|export\s+[^'"]*?from\s+)['"]([^'"]+)['"]/g
  for(const match of src.matchAll(re)){
    const spec=match[1]
    if(!spec.startsWith('.'))continue
    const target=path.resolve(path.dirname(file),spec)
    const candidates=[target,target+'.js',target+'.mjs',path.join(target,'index.js')]
    if(!candidates.some(fs.existsSync))fail(`import introuvable dans ${path.relative(root,file)}: ${spec}`)
  }
}

const html=read('index.html')
const ids=[...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m=>m[1])
const idSet=new Set(ids)
if(idSet.size!==ids.length){
  const dup=[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))]
  fail(`id HTML dupliqué: ${dup.join(', ')}`)
}
const app=read('src/user/app.js')
const refs=[...app.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m=>m[1])
const missing=[...new Set(refs.filter(id=>!idSet.has(id)))]
if(missing.length)fail(`références DOM absentes de index.html: ${missing.join(', ')}`)

const pkg=JSON.parse(read('package.json')),lock=JSON.parse(read('package-lock.json'))
if(pkg.version!==lock.version||pkg.version!==lock.packages?.['']?.version)fail('versions package.json/package-lock.json incohérentes')
const versionMatch=app.match(/const APP_VERSION='([^']+)'/)
if(!versionMatch||versionMatch[1]!==pkg.version)fail('APP_VERSION différent de package.json')

const vite=read('vite.config.js')
if(/secret-tool|freesoundTest|test-v2/.test(vite))fail('une page outil/test est encore publiée par Vite')
if(!/user:\s*resolve\([^\n]+index\.html/.test(vite))fail('entrée utilisateur Vite absente')

console.log(`CHECK OK · ${jsFiles.length} fichiers JS · ${idSet.size} ids DOM · v${pkg.version}`)
