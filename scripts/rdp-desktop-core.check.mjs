import {referenceSource} from './reference-source.mjs'
// Actual old/current TypeScript through both production Wasm modules; observations retain undefined and NaN.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {execFileSync} from 'node:child_process'
import {stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)))
const base='2bade577d9945ba4620a8fcb5636d6c7dee4ea61'
const artifact=file=>file.endsWith('.wasm')?fs.readFileSync(file).toString('base64'):JSON.parse(fs.readFileSync(file,'utf8').match(/export const WASM = ("[^"]*")/)[1])
if(!process.argv[2]||!process.argv[3])throw Error('usage: node scripts/rdp-desktop-core.check.mjs <desktop wasm/data.ts> <identity wasm/data.ts> [--bench]')
const DESKTOP_WASM=artifact(process.argv[2]),IDENTITY_WASM=artifact(process.argv[3])
const read=f=>fs.readFileSync(path.join(root,f),'utf8')
const before=f=>referenceSource('git',['show',base+':'+f],{cwd:root,encoding:'utf8'})
const clean=s=>s.replace(/^import .*\n/gm,'').replaceAll('export ','')
const names=['configText','configNumber','ownClipboard','clipboardSetting','clipboardWays','narrowest','setUpClipboard','splitPaste','vmId','parseWake','wakeFromText','specOf','xrdpFromHost','xrdpUnasked','hyperVSpec','desktopsFor','desktopIdOf','entryText']
function load(old){
    const source=old?before:read
    let code=clean(read('itabby-plugin/src/rust/core.ts'))
    code+='\nconst identity=(()=>{ const WASM=IDENTITY_WASM; '+clean(source('rdp-plugin/src/identity.ts'))+'; return identity })();\n'
    if(!old)code+=clean(read('itabby-plugin/src/rust/value.ts'))+'\n'
    if(!old)code+='const {desktopPolicy,scalarObservation,fieldsObservation,desktopObservation,wakeObservation}=(()=>{const WASM=DESKTOP_WASM;'+clean(read('rdp-plugin/src/desktopPolicy.ts'))+';return {desktopPolicy,scalarObservation,fieldsObservation,desktopObservation,wakeObservation}})();\n'
    for(const file of ['accounts','clipboard','hyperv','wake','osd','desktops'])code+='\n'+clean(source('rdp-plugin/src/'+file+'.ts'))
    code+='\n({'+names.join(',')+'})'
    return vm.runInNewContext(stripTypeScriptTypes(code,{mode:'strip'}),{IDENTITY_WASM,DESKTOP_WASM,WebAssembly,TextEncoder,TextDecoder,atob,Buffer},{filename:old?'old-desktop.ts':'new-desktop.ts'})
}
const old=load(true),now=load(false)
function plain(v){if(Array.isArray(v))return Array.from(v,plain);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,v])=>[k,plain(v)]));return v}
function outcome(fn,args){try{return {value:plain(fn(...args))}}catch(e){return {error:true}}}
let count=0
function check(name,...args){assert.deepEqual(outcome(now[name],args),outcome(old[name],args),name+' '+JSON.stringify(args).slice(0,400));count++}
const bad={toString:0,valueOf:0},guid='5F05E000-1234-ABCD-EF01-0123456789AB'
const values=[undefined,null,false,true,0,-0,NaN,Infinity,-Infinity,1,9,3389,65535,65536,-1,1.5,1e21,1e-7,'', ' ', '\ufeff9\u00a0','0x10','0b11','0o12','+0x1','-0','+Infinity','infinity','inf','NaN','1e309','1e-999','1_000','both','off','fromRemote','invalid','a#b','😀','\ud800',bad,{},[],[1],['x']]
for(const value of values){for(const name of ['configText','configNumber','ownClipboard','clipboardSetting','vmId','parseWake','desktopIdOf','entryText'])check(name,value)}
let seed=0x783d5201
const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0
const pick=a=>a[next()%a.length]
const text=()=>pick(['','alice','HOST','D\\u','a#b','\ud800','ΟΣ','@user#x','hyperv','😀','\u2028','\ufeff'])
for(let n=0;n<10000;n++){
    const bytes=Buffer.alloc(8);bytes.writeUInt32LE(next(),0);bytes.writeUInt32LE(next(),4)
    const value=bytes.readDoubleLE();check('configText',value);check('configNumber',value);check('configNumber',String(value))
}
function extra(){return {name:pick(values),via:pick(['alias','host','u@host:22',...values]),host:pick(['127.0.0.1','host',...values]),port:pick(values),kind:pick(['gnome','xrdp','windows',...values]),kindFromHost:pick([undefined,true,false,null,1]),clipboard:pick(values),username:text(),domain:text(),account:text(),gateway:pick(values),gatewayAccount:text(),hyperv:pick([' '+guid+' ','{'+guid+'}',guid+'}','{'+guid,...values]),wake:{hyperv:pick([guid,...values]),vm:pick(values),mac:pick(['aa:bb:cc:dd:ee:ff','aabbccddeeff','AA-BB-CC-DD-EE-FF','aa-bb:cc-dd-ee-ff',...values]),broadcast:pick(['999.1.2.3','001.002.003.004','1.2.3.4.5',...values]),port:pick(values)}}}
for(let n=0;n<7000;n++){
    const e=extra()
    for(const name of ['specOf','xrdpFromHost','xrdpUnasked','desktopIdOf','entryText'])check(name,e)
    check('parseWake',e.wake)
    check('wakeFromText',pick([' aa:bb:cc:dd:ee:ff ',' vm ','',text()]))
    check('vmId',e.hyperv)
    check('hyperVSpec',text(),text(),{found:pick(['running','off']),username:text()})
    const modes=Array.from({length:next()%5},()=>pick(['both','fromRemote','off',...values]))
    check('clipboardWays',...modes);check('narrowest',...modes)
    const target={key:pick(['u@host:22','outer@jump:22>u@host:22']),label:'alias',...next()%2?{}:{via:{}}}
    const entries=[e,{...e,name:'duplicate',clipboard:pick(['off','both','fromRemote'])},extra()]
    const found=pick([undefined,{kind:'gnome',xrdpPort:3389,xrdpUser:'user'},{kind:'xrdp',xrdpPort:0},{kind:'windows'},{kind:'gnome',xrdpPort:NaN},{kind:'gnome',xrdpPort:Infinity}])
    check('desktopsFor',target,entries,found,[{host:'same',name:'first',clipboard:'both'},{host:'same',name:'second',clipboard:pick(['off','fromRemote'])}],pick(['both','off','fromRemote']))
}
// Platform hooks and callbacks remain observable in their original order and retain object identity.
function setup(api,mode,hooks){
    const events=[],provider={onUploadStarted(){events.push('original-stop')}},ui={setEnableClipboard(v){events.push(['enable',v])},enableFileTransfer(p){events.push('register');if(hooks){p.onUploadStarted=function(){assert.equal(this,provider);events.push('stop')};p.onUploadFinished=function(){assert.equal(this,provider);events.push('resume')}}}}
    let sending=false;const result=api.setUpClipboard(ui,provider,mode,()=>sending)
    provider.onUploadFinished?.();sending=true;provider.onUploadFinished?.();result.stopSending()
    return {mode:result.mode,events}
}
for(const mode of ['both','off','fromRemote'])for(const hooks of [false,true]){assert.deepEqual(setup(now,mode,hooks),setup(old,mode,hooks));count++}
function paste(api,mask){
    const items=[{name:'one'},{name:'two'},{name:'three'}],seen=[]
    const result=api.splitPaste(items,(d)=>{seen.push('ways-'+d.name);return {toRemote:!!(mask&(1<<items.indexOf(d))),fromRemote:true}},d=>{seen.push('name-'+d.name);return d.name})
    for(const d of [...result.targets,...result.left])assert.ok(items.includes(d))
    return {result:plain(result),seen}
}
for(let mask=0;mask<8;mask++){assert.deepEqual(paste(now,mask),paste(old,mask));count++}
console.log(count+' actual TypeScript desktop policy outcomes and callback traces matched')
const api=new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(DESKTOP_WASM,'base64')),{}).exports
function raw(bytes){const p=api.allocate(bytes.length);assert.ok(p);try{new Uint8Array(api.memory.buffer,p,bytes.length).set(bytes);const out=api.request(p,bytes.length);return JSON.parse(new TextDecoder().decode(new Uint8Array(api.memory.buffer,out,api.response_len())))}finally{api.release(p,bytes.length)}}
for(const bytes of [Buffer.from('{'),Buffer.from([255]),Buffer.from(JSON.stringify({op:'config_text',args:[['s','null']]})),Buffer.from(JSON.stringify({op:'config_number',args:[['n','inf']]}))])assert.ok(raw(bytes).error)
const prefix=Buffer.from(JSON.stringify({op:'config_number',args:[['n','-0']]}).slice(0,-1)+',"future":"'),suffix=Buffer.from('"}')
const boundary=Buffer.concat([prefix,Buffer.alloc((8<<20)-prefix.length-suffix.length,120),suffix])
assert.ok(Object.is(raw(boundary).value[1],-0));assert.equal(api.allocate((8<<20)+1),0)
const valid=Buffer.from(JSON.stringify({op:'vm_id',args:[['s',JSON.stringify(guid)]]}))
assert.equal(JSON.parse(raw(valid).value[1]),guid.toLowerCase())
const warm=api.memory.buffer.byteLength
for(let n=0;n<100;n++)assert.equal(JSON.parse(raw(valid).value[1]),guid.toLowerCase())
assert.ok(api.memory.buffer.byteLength<=warm+(1<<20))
assert.throws(()=>api.memory.grow(2048),RangeError)
console.log('Compiled desktop policy malformed input, 8 MiB admission, ownership, memory ceiling and recovery passed')

if(process.argv.includes('--bench')){
    const target={key:'u@host:22',label:'alias'},extras=Array.from({length:20},(_,n)=>({via:'alias',host:'host'+(n%10),name:'Desktop '+n,clipboard:n%3?'both':'fromRemote'}))
    for(const [name,api] of [['Before',old],['After',now]]){
        const batches=[];let sum=0
        for(let r=0;r<5;r++){const start=performance.now();for(let n=0;n<100;n++)sum+=api.desktopsFor(target,extras,{kind:'windows'},[], 'both').length;batches.push(performance.now()-start)}
        console.log(name+' 100 desktop lists median_ms='+batches.sort((a,b)=>a-b)[2]+' checksum='+sum)
    }
    console.log('Module bytes: '+Buffer.from(DESKTOP_WASM,'base64').length)
}
