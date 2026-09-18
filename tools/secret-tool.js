import { encryptCredentials } from '../src/backend/crypto.js'
const $=id=>document.getElementById(id)
$('make').onclick=async()=>{
  try{
    const blob=await encryptCredentials({apiId:Number($('apiId').value),apiHash:$('apiHash').value.trim()},$('password').value)
    const text=JSON.stringify(blob,null,2);$('out').textContent=text
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'application/json'}));a.download='telegram-secret.json';a.click();URL.revokeObjectURL(a.href)
  }catch(e){$('out').textContent='Erreur : '+e.message}
}
