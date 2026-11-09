import {referenceSource} from './reference-source.mjs'
// Compare the actual pre-port functions and current facade through the compiled Rust/Wasm boundary.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {execFileSync} from 'node:child_process'
import {stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)))
const artifact=process.argv[2]
if(!artifact)throw Error('usage: node scripts/rdp-identity-core.check.mjs <rdp-identity.data.ts|core.wasm> [--bench]')
const WASM=artifact.endsWith('.wasm')?fs.readFileSync(artifact).toString('base64'):JSON.parse(fs.readFileSync(artifact,'utf8').match(/export const WASM = ("[^"]*")/)[1])
const desktopArtifact=path.join(path.dirname(artifact),artifact.endsWith('.wasm')?'paddy_rdp_desktop_core.wasm':'rdp-desktop.data.ts')
const DESKTOP_WASM=desktopArtifact.endsWith('.wasm')?fs.readFileSync(desktopArtifact).toString('base64'):JSON.parse(fs.readFileSync(desktopArtifact,'utf8').match(/export const WASM = ("[^"]*")/)[1])
const base='c8685a4d3b7c8a5d48520deb1c6058c69b0bb36d'
const read=f=>fs.readFileSync(path.join(root,f),'utf8')
const before=f=>referenceSource('git',['show',`${base}:${f}`],{cwd:root,encoding:'utf8'})
const names=['viaMatches','sessionKey','keyFromConfig','isTargetKey','legacyKeyFromConfig','keyFields','nestedKey','shownKey','keyUser','signsInAs','isLoginOf','userScope','keyParts','rekeyed','signInName']
function load(old){
    let code=old?'':read('itabby-plugin/src/rust/core.ts')+'\n'+read('rdp-plugin/src/identity.ts')+'\n'
    if(!old)code+=read('itabby-plugin/src/rust/value.ts')+'\n'
    if(!old)code+='const {desktopPolicy,scalarObservation,fieldsObservation,desktopObservation,wakeObservation}=(()=>{const WASM=DESKTOP_WASM;\n'+read('rdp-plugin/src/desktopPolicy.ts')+';return {desktopPolicy,scalarObservation,fieldsObservation,desktopObservation,wakeObservation}})();\n'
    code+=(old?before:read)('rdp-plugin/src/accounts.ts')+'\n'+(old?before:read)('rdp-plugin/src/desktops.ts')
    code=stripTypeScriptTypes(code.replace(/^import .*\n/gm,'').replaceAll('export ',''),{mode:'strip'})+'\n({'+names.join(',')+'})'
    return vm.runInNewContext(code,{WASM,DESKTOP_WASM,WebAssembly,TextEncoder,TextDecoder,atob},{filename:old?'before-identity.ts':'after-identity.ts'})
}
const old=load(true),now=load(false)
const plain=x=>JSON.parse(JSON.stringify(x))
let observations=0
function check(name,...args){assert.deepEqual(plain(now[name](...args)),plain(old[name](...args)),name+' '+JSON.stringify(args).slice(0,300));observations++}
const values=['','alice','ALICE','alice@corp','D\\user','u#ops','a%23b','a%2fb','a%2Fb','@user#x','@gateway#x','>','#',':','%',String.fromCharCode(0),'\n','\r\n','\u2028','\u2029','\ufeff','\u0085','İ','ΟΣ','ΟΣ\u0301','ΣΟ','𝔄','𐐀','😀','\ud800','\udc00','x\ud800Y','Σ\ud800Α','__proto__','constructor']
let state=0x530a2e17
const next=()=>state=(Math.imul(state,1664525)+1013904223)>>>0
const pick=a=>a[next()%a.length]
const text=()=>Array.from({length:next()%5},()=>pick(values)).join('')
for(let n=0;n<8000;n++){
    const user=text(),host=text(),port=text(),outer=text(),destination=text()
    const config=pick(['','ignored\n'])+'user '+user+pick(['\n','\r','\r\n','\u2028','\u2029'])+'hostname '+host+'\nport '+port+'\nuser later\nhostname ignored\nport 99'
    check('keyFromConfig',config,destination);check('legacyKeyFromConfig',config,destination);check('nestedKey',outer,config,destination)
    const key=old.keyFromConfig(config,destination)
    for(const name of ['keyFields','isTargetKey','shownKey','keyUser','keyParts'])check(name,key)
    check('viaMatches',pick([host,user+'@'+host,host+':'+port,key,'alias']),{key,label:'alias',...n%3?{}:{via:''}})
}
for(let n=0;n<16000;n++){
    const key=text(),from=text(),to=text(),username=text(),domain=text(),id=text()
    for(const name of ['keyFields','isTargetKey','shownKey','keyUser','keyParts','userScope'])check(name,key)
    check('rekeyed',key,from,to);check('rekeyed',from+'#'+key,from,to)
    check('sessionKey',{key},{id:pick(['own',id])})
    check('signInName',{username,domain})
    check('signsInAs',{username,domain})
    check('isLoginOf',username,pick([key,domain+'\\'+username,username]))
}
for(const id of ['','desk','@user','@gateway','desk\n'])for(const u of ['','@user#','@user#alice','@user#alice\n','@user#x#bad'])for(const g of ['','@gateway#','@gateway#host:443','@gateway#x#bad']){
    const key='u@host:22#'+id+u+g
    check('keyParts',key);check('rekeyed',key,'u@host:22','new@host:22')
}
for(const username of [undefined,null,false,0,123,NaN,Infinity,{},[],{toString:0},...values])for(const domain of [undefined,null,123,{},...values.slice(0,8)])check('signsInAs',{username,domain})
for(let unit=0;unit<=0xffff;unit++)check('userScope',String.fromCharCode(unit))
// Rust's contextual lowercase must match the JavaScript engine's Unicode mapping,
// including supplementary code points. Surrogate units were checked separately above.
for(let cp=0;cp<0x110000;cp++)if(cp<0xd800||cp>0xdfff)check('keyFromConfig','',String.fromCodePoint(cp))
for(const around of ['Α','A',"'",'\u0301','\ud800','\udc00','😀',' '])for(const suffix of ['','Α','a',"'",'\u0301','\ud800'])check('keyFromConfig','',around+'Σ'+suffix)
console.log(`${observations} actual TypeScript identity outcomes matched, including all Unicode scalars and all UTF-16 code units`)
const api=new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(WASM,'base64')),{}).exports
function raw(bytes){const p=api.allocate(bytes.length);assert.ok(p);try{new Uint8Array(api.memory.buffer,p,bytes.length).set(bytes);const out=api.request(p,bytes.length);return JSON.parse(new TextDecoder().decode(new Uint8Array(api.memory.buffer,out,api.response_len())))}finally{api.release(p,bytes.length)}}
for(const bytes of [Buffer.from('{'),Buffer.from([0xff]),Buffer.from(JSON.stringify({op:'key_fields',a:'"\\u12"'})),Buffer.from(JSON.stringify({op:'key_fields',a:'null'})),Buffer.from(JSON.stringify({op:'key_fields',a:7}))])assert.ok(raw(bytes).error)
const prefix=Buffer.from(JSON.stringify({op:'key_fields',a:JSON.stringify('a@host:22')}).slice(0,-1)+',"future":"'),suffix=Buffer.from('"}')
const bound=Buffer.concat([prefix,Buffer.alloc((8<<20)-prefix.length-suffix.length,120),suffix]);assert.equal(JSON.parse(raw(bound).value.user),'a')
assert.equal(api.allocate((8<<20)+1),0)
assert.equal(JSON.parse(raw(Buffer.from(JSON.stringify({op:'user_scope',a:JSON.stringify('\ud800')}))).value),'@user#\ud800')
console.log('Compiled Wasm malformed/UTF-8 input, inclusive 8 MiB limit and recovery passed')
if(process.argv.includes('--bench')){
    const samples=Array.from({length:1000},(_,n)=>({config:`user user${n}\nhostname HOST${n}.example\nport 22\n`,destination:'alias',id:'desktop:3389'}))
    for(const [label,api] of [['Before',old],['After',now]]){
        const times=[];let sum=0
        for(let round=0;round<5;round++){
            const start=performance.now()
            for(const sample of samples){const key=api.keyFromConfig(sample.config,sample.destination);const scoped=api.sessionKey({key},{id:sample.id})+api.userScope('DOMAIN\\alice');sum+=api.keyFields(key).host.length+api.keyParts(scoped).desktopId.length;sum+=api.rekeyed(scoped,key,'new@host:22').length;sum+=Number(api.isTargetKey(key))}
            times.push(performance.now()-start)
        }
        console.log(`${label}: 1000 identity transactions median_ms=${times.sort((a,b)=>a-b)[2]} checksum=${sum}`)
    }
    console.log(`Module bytes: ${Buffer.from(WASM,'base64').length}`)
}
