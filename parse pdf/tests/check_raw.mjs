import fs from 'node:fs'
import {RawPdfIndex} from '../../src/backend/pdf-raw.js'
for(const file of ['Document_PDF_2.pdf','Document_PDF.pdf']){
  const raw=await RawPdfIndex.load(new Uint8Array(fs.readFileSync(new URL(`./fixtures/${file}`,import.meta.url))))
  if(raw.pages.length!==16)throw new Error(`${file}: pages=${raw.pages.length}`)
  let boxes=0,placements=0
  for(let p=2;p<=15;p++){const g=await raw.pageGeometry(p);const b=g.rects.filter(r=>r.width>400&&r.height>100);if(b.length!==2)throw new Error(`${file}: p${p} boxes=${b.length}`);boxes+=b.length;placements+=g.images.length}
  if(boxes!==28)throw new Error(`${file}: boxes=${boxes}`)
  console.log(file,'OK', {pages:raw.pages.length,boxes,placements})
}
