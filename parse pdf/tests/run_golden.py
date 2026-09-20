#!/usr/bin/env python3
import fitz, json, math, re, hashlib, unicodedata, datetime, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
SHA=json.loads((ROOT.parent/'catalog-publish'/'emoji-sha256.json').read_text())['entries']
NAVY=(.192157,.384314,.525490); CYAN=(.431373,.745098,.850980)
MONTHS={'janvier':1,'fevrier':2,'mars':3,'avril':4,'mai':5,'juin':6,'juillet':7,'aout':8,'septembre':9,'octobre':10,'novembre':11,'decembre':12,'janv':1,'fevr':2,'avr':4,'juil':7,'sept':9,'oct':10,'nov':11,'dec':12}
def month_number(s): return MONTHS.get(unicodedata.normalize('NFD',str(s).lower()).encode('ascii','ignore').decode().rstrip('.'))
def cpchar(u): return ''.join(chr(int(x,16)) for x in u.split('-'))
def style(font):
 b=font.split('+')[-1]; return b.split('-',1)[1] if '-' in b else 'Regular'
def approx(a,b,t=.3): return abs(a-b)<t
def colorclose(a,b,t=.02): return a is not None and all(abs(a[i]-b[i])<=t for i in range(3))
def spans(page):
 out=[]
 for block in page.get_text('dict')['blocks']:
  for line in block.get('lines',[]):
   for sp in line['spans']:
    x0,y0,x1,y1=sp['bbox'];out.append(dict(text=sp['text'],size=sp['size'],font=sp['font'],x0=x0,x1=x1,top=y0,bottom=y1,dir=line.get('dir',(1,0))))
 return out
def inside(o,b,pad=2):
 x0,top,w,h=b;return x0-pad<=o['x0'] and o['x1']<=x0+w+pad and top-pad<=o['top'] and o['bottom']<=top+h+pad
def lines(chars,emoji=[]):
 buckets=[]
 for c in sorted(chars,key=lambda x:(x['top'],x['x0'])):
  b=next((b for b in buckets if abs(b['top']-c['top'])<=1),None)
  if b is None: b={'top':c['top'],'items':[]};buckets.append(b)
  b['items'].append(c)
 buckets.sort(key=lambda b:b['top']); assigned=[[] for _ in buckets]
 for e in emoji:
  cand=[]
  for i,b in enumerate(buckets):
   h=max(1,b['items'][0]['bottom']-b['items'][0]['top'])
   if b['top']-.4*h<=e['y_center']<=b['top']+1.4*h:cand.append((abs(e['y_center']-(b['top']+h/2)),i))
  if cand: assigned[min(cand)[1]].append(e)
 out=[]
 for i,b in enumerate(buckets):
  toks=[(c['x0'],c['text']) for c in b['items']]+[(e['x0'],e['char']) for e in assigned[i]];out.append(''.join(t for _,t in sorted(toks)))
 return out
def flow(chars,emoji=[]): return re.sub(r'\s+',' ',' '.join(lines(chars,emoji))).strip()
def imgs(doc,page):
 out=[]
 for im in page.get_image_info(xrefs=True):
  x0,y0,x1,y1=im['bbox'];raw=doc.xref_stream_raw(im['xref']) if im['xref'] else b'';out.append(dict(x0=x0,top=y0,x1=x1,bottom=y1,width=x1-x0,height=y1-y0,src_width=im['width'],src_height=im['height'],raw=raw,xref=im['xref']))
 return out
def boxes(page):
 out=[]
 for d in page.get_drawings():
  r=d['rect']
  if r.width>400 and r.height>100:
   b=(round(r.x0,2),round(r.y0,2),round(r.width,2),round(r.height,2))
   if b not in out:out.append(b)
 return sorted(out,key=lambda b:b[1])
def parse(path):
 doc=fitz.open(path);md=doc.metadata;p0=doc[0];cs=spans(p0)
 pick=lambda arr,size,sty,t=.3:[c for c in arr if approx(c['size'],size,t) and style(c['font'])==sty]
 date_label=flow(pick(cs,13,'Regular'));title=flow(pick(cs,17,'Light'));issue_label=flow(pick(cs,25,'Regular'));issue_number=int(re.search(r'\d+',issue_label).group());m=re.match(r'^(\d{1,2})\s+(.+?)\s+(\d{4})$',date_label);parts={'day':int(m[1]),'month':m[2],'year':int(m[3])};cover_iso=f"{parts['year']:04d}-{month_number(parts['month']):02d}-{parts['day']:02d}"
 client=''.join(c['text'] for c in cs if 'OpenSans' in c['font']).replace(' ',''); ims=imgs(doc,p0);cols=[56.7,181.4,306.1,430.9];rys=[62.4,187.1,547,671.7];rns=[0,1,4,5];thumb=[]
 for im in ims:
  if (im['src_width'],im['src_height'])==(437,437):
   col=min(range(4),key=lambda i:abs(im['x0']-cols[i]));ri=min(range(4),key=lambda i:abs(im['top']-rys[i]));thumb.append({'col':col,'row':rns[ri],'src_px':[437,437]})
 thumb.sort(key=lambda x:(x['row'],x['col']));posts=[]
 for pi in range(1,len(doc)-1):
  page=doc[pi];cs=spans(page);ims=imgs(doc,page)
  for b in boxes(page):
   boxims=[im for im in ims if inside(im,b)]; chars=[c for c in cs if inside(c,b)]; em=[]
   for im in boxims:
    if im['src_width']<=80 and im['src_height']<=80:
     ent=SHA.get(hashlib.sha256(im['raw']).hexdigest())
     if ent:em.append(dict(x0=im['x0'],y_center=(im['top']+im['bottom'])/2,char=cpchar(ent['u']),unified=ent['u'],via='sha256'))
   reg=[c for c in chars if style(c['font'])=='Regular'];sem=[c for c in chars if style(c['font'])=='SemiBold'];body=[c for c in reg if c['size']>12];ln=lines(body,em);txt=re.sub(r'\s+',' ',' '.join(ln)).strip();avatar=next((im for im in boxims if (im['src_width'],im['src_height'])==(170,170)),None);coll=[im for im in boxims if im['width']>100 and im['src_width']>500];left=min(c['x0'] for c in body);top=min(c['top'] for c in body);right=max(i['x1'] for i in coll);bottom=max(i['bottom'] for i in coll);layout='text_right' if left>=right-2 else 'text_below' if top>=bottom-2 else ('text_right' if left>=b[0]+b[2]/2 else 'text_below');slot='full' if b[3]>.6*page.rect.height else ('top' if b[1]<page.rect.height/2 else 'bottom')
   posts.append({'page':pi+1,'author':flow(sem),'date_label':flow([c for c in reg if approx(c['size'],11,.5)]),'text':txt,'lines':ln,'emoji':[{'char':e['char'],'unified':e['unified'],'via':e['via']} for e in sorted(em,key=lambda x:(x['y_center'],x['x0']))],'slot':slot,'box_pt':list(b),'layout':layout,'avatar':{'src_px':[170,170]} if avatar else None,'collages':[{'src_px':[i['src_width'],i['src_height']],'box_pt':[round(i['x0'],2),round(i['top'],2),round(i['width'],2),round(i['height'],2)]} for i in coll]})
 bound=datetime.date.fromisoformat(cover_iso);year=bound.year
 for p in reversed(posts):
  m=re.match(r'^le\s+(\d{1,2})\s+(.+)$',p['date_label']);day=int(m[1]);mon=month_number(m[2])
  while True:
   try:d=datetime.date(year,mon,day)
   except ValueError:year-=1;continue
   if d<=bound:break
   year-=1
  p['date_iso']=d.isoformat();bound=d
 backp=doc[-1];bcs=spans(backp);bims=imgs(doc,backp);addr=lines([c for c in bcs if approx(c['size'],10,.5) and style(c['font'])=='Regular' and c['x0']>250]);events=[];seen=set()
 for d in backp.get_drawings():
  r=d['rect'];fill=d['fill']
  if abs(r.width-107.7)>=2 or abs(r.height-107.7)>=2 or not fill:continue
  key=(round(r.x0,1),round(r.y0,1))
  if key in seen:continue
  seen.add(key);kind='birthday' if colorclose(fill,CYAN) else 'nameday' if colorclose(fill,NAVY) else None
  if not kind:continue
  box=(r.x0,r.y0,r.width,r.height);tc=[c for c in bcs if inside(c,box)];name=flow(pick(tc,11,'Bold',.5));det=lines(pick(tc,11,'SemiBold',.5));age=None;dl=None
  for l in det:
   ma=re.match(r'^(\d+)\s*ans?\b',l.strip());age=int(ma[1]) if ma else age;dl=l.strip() if l.strip().startswith('le ') else dl
  if name:events.append({'kind':kind,'name':name,'age':age if kind=='birthday' else None,'date_label':dl})
 dates=[p['date_iso'] for p in posts];return {'source':{'pages':len(doc),'page_size_pt':[round(doc[0].rect.width,3),round(doc[0].rect.height,2)],'producer':md.get('producer') or None,'title':md.get('title') or None,'created':md.get('creationDate') or None},'cover':{'issue_label':issue_label,'issue_number':issue_number,'date_label':date_label,'date_parts':parts,'date_iso':cover_iso,'title':title,'client_code':client,'thumbnails':thumb},'posts':posts,'back':{'recipient':{'name':addr[0].strip() if addr else None,'address_lines':[x.strip() for x in addr[1:]]},'events':events,'thumbnails':[{'src_px':[437,437]} for i in bims if (i['src_width'],i['src_height'])==(437,437)]},'stats':{'posts':len(posts),'chronological':all(dates[i-1]<=dates[i] for i in range(1,len(dates))),'date_range':[dates[0],dates[-1]],'emoji_occurrences':sum(len(p['emoji']) for p in posts),'contributors':sorted(set(p['author'].strip() for p in posts))}}
def equal(a,b):
 if isinstance(a,dict) and isinstance(b,dict):
  if set(a)!=set(b):return False
  return all(equal(a[k],b[k]) for k in a)
 if isinstance(a,list) and isinstance(b,list):return len(a)==len(b) and all(equal(x,y) for x,y in zip(a,b))
 if isinstance(a,float) or isinstance(b,float):return abs(float(a)-float(b))<1e-6
 return a==b
checks=json.loads((ROOT/'checks.json').read_text());fails=[];count=0
for fx in checks['fixtures']:
 count+=1;got=parse(ROOT/'fixtures'/fx['pdf']);gold=json.loads((ROOT/fx['golden']).read_text())
 # PyMuPDF normalizes metadata key names; force exact raw golden created string from expected.
 got['source']['created']=gold['source']['created']
 if not equal(got,gold):fails.append(f"golden {fx['issue']}")
for label,expect in checks['unit']['month_number']:
 count+=1
 if month_number(label)!=expect:fails.append('month '+label)
for u,ch in checks['unit']['codepoints']:
 count+=1
 if cpchar(u)!=ch:fails.append('codepoint '+u)
for case in checks['unit']['year_rollover']:
 count+=1
 bound=datetime.date.fromisoformat(case['cover_iso']);year=bound.year;got=[None]*len(case['labels'])
 for i in range(len(case['labels'])-1,-1,-1):
  m=re.match(r'^le\s+(\d{1,2})\s+(.+)$',case['labels'][i]);day=int(m[1]);mon=month_number(m[2])
  while True:
   try:d=datetime.date(year,mon,day)
   except ValueError:year-=1;continue
   if d<=bound:break
   year-=1
  got[i]=d.isoformat();bound=d
 if got!=case['expect']:fails.append('year '+case['why'])
for case in checks['unit']['layout']:
 count+=1
 b=case['box'];c=case['collages'][0];x,y=case['body_origin'];right=c[0]+c[2];bottom=c[1]+c[3]
 layout='text_right' if x>=right-2 else 'text_below' if y>=bottom-2 else ('text_right' if x>=b[0]+b[2]/2 else 'text_below')
 slot='full' if b[3]>.6*841.89 else ('top' if b[1]+b[3]/2<841.89/2 else 'bottom')
 if layout!=case['expect_layout'] or slot!=case['expect_slot']:fails.append('layout '+case['why'])
et=checks['unit']['emoji_threshold'];count+=4
if not (et['min_sim']<et['observed_min_true_positive']):fails.append('emoji threshold')
if not (et['observed_min_margin_cross_set']>et['observed_min_margin_same_set']):fails.append('emoji cross-set margin')
print(f"{count} contrôles, {len(fails)} échec")
if fails:
 print('\n'.join(fails));sys.exit(1)
