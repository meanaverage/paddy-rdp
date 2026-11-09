import {referenceSource} from './reference-source.mjs'
// Actual pre-port/current FileTransfer classes, including provider callbacks and queued disk promises.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)))
const base='ca663bab74dea6d62048c5d83bf100901fcaebf9'
if(!process.argv[2])throw Error('usage: node scripts/rdp-transfer-core.check.mjs <wasm/data.ts> [--bench]')
const file=process.argv[2]
const WASM=file.endsWith('.wasm')?fs.readFileSync(file).toString('base64'):JSON.parse(fs.readFileSync(file,'utf8').match(/export const WASM = ("[^"]*")/)[1])
const read=f=>fs.readFileSync(path.join(root,f),'utf8')
const clean=s=>s.replace(/^import .*\n/gm,'').replace(/^export \{.*\} from .*\n/gm,'').replaceAll('export ','')
function lowerProperties(source){
    // Node strips types but cannot lower parameter properties. Only this syntax
    // is expanded; all scheduling and callback bodies remain the source bodies.
    return source.replace(/constructor \(([\s\S]*?)\) \{/g,(_,args)=>{
        const names=[...args.matchAll(/(?:private|readonly)\s+(\w+)/g)].map(m=>m[1])
        return 'constructor ('+args.replace(/\b(private|readonly)\s+/g,'')+') {'+names.map(n=>'this.'+n+'='+n+';').join('')
    })
}
function factory(old,clock){
    let source=''
    if(!old)source=clean(read('itabby-plugin/src/rust/core.ts'))+'\n'+clean(read('rdp-plugin/src/transferPolicy.ts'))+'\n'
    source+=clean(old?referenceSource('git',['show',base+':rdp-plugin/src/fileTransfer.ts'],{cwd:root,encoding:'utf8'}):read('rdp-plugin/src/fileTransfer.ts'))
    source=stripTypeScriptTypes(lowerProperties(source),{mode:'strip'})
    source+='\n;({FileTransfer,DiskFile'+(!old?',TransferPolicy':'')+'})'
    class Clock extends Date {static now(){return clock.now}}
    return vm.runInNewContext(source,{WASM,fs,os,path,execFile(){throw Error('Unexpected subprocess')},DiskStorage:class{},DISK_PATH:Symbol('disk'),Buffer,Blob,Uint8Array,ArrayBuffer,Date:Clock,process:{platform:'darwin'},WebAssembly,TextEncoder,TextDecoder,atob,setTimeout,clearTimeout,console},{filename:old?'old-transfer.ts':'new-transfer.ts'})
}
const plain=v=>JSON.parse(JSON.stringify(v))
const overlay=()=>({addEventListener(){},removeEventListener(){},classList:{add(){},remove(){},toggle(){}},contains(){return false}})
function fixture(old){
    const clock={now:1000},classes=factory(old,clock),events=[],pending=[],disk=[]
    let mode='defer',allowed=true,room=true,resume,spent=0
    class Provider {
        on(){} off(){}
        acknowledgePaste(){events.push(['ack'])}
        handleFileContentsRequest(r){
            events.push(['serve',plain(r)])
            if(mode==='throw')throw Error('synthetic unreadable')
            if((r.flags&1)||mode==='sync'||mode==='answer-throw')this.sendSubmitFileContents(r.streamId,false,new Uint8Array((r.flags&1)?8:3))
            else pending.push({...r})
            if(mode==='answer-throw')throw Error('after answer')
        }
        sendSubmitFileContents(id,error,data){events.push(['submit',id,error,data.length])}
        uploadFiles(entries){events.push(['upload',entries.length]);return {completion:new Promise(()=>{})}}
        isUploadInProgress(){return false}
        dispose(){events.push(['dispose'])}
    }
    const flow={
        room(){events.push(['room',room]);return room},
        spend(n){spent+=n;events.push(['spend',n])},
        refund(n){spent=Math.max(0,spent-n);events.push(['refund',n])},
        whenRoom(){events.push(['wait-room']);return new Promise(r=>{resume=r})},
    }
    const transfer=new classes.FileTransfer({RdpFileTransferProvider:Provider},overlay(),msg=>events.push(['log',msg]),()=>({toRemote:allowed,fromRemote:true}),flow)
    transfer.toast=(text)=>events.push(['toast',text])
    const blob={size:32,lastModified:0,type:'',slice(){return new Blob(['synthetic'])}}
    const browser=()=>[{name:'example',file:blob,isDirectory:false}]
    function sendDisk(){
        const file=new classes.DiskFile('/synthetic/file',{size:32,mtimeMs:0,dev:1,ino:2},'example')
        file.read=(start,end)=>new Promise((resolve,reject)=>{events.push(['disk',start,end]);disk.push({resolve,reject})})
        transfer.send([{name:'example',file,isDirectory:false}])
    }
    transfer.send(browser());events.length=0
    return {old,clock,classes,transfer,events,pending,disk,get spent(){return spent},
        request(r){transfer.provider.handleFileContentsRequest(r)},
        answer(index,error=false){const r=pending[index];if(r)transfer.provider.sendSubmitFileContents(r.streamId,error,new Uint8Array(error?0:3))},
        mode(v){mode=v},allow(v){allowed=v},room(v){room=v},wake(){room=true;resume?.()},
        send(){transfer.send(browser())},sendDisk,
        settle(index,error=false){const d=disk[index];if(d)error?d.reject(Error('synthetic disk failure')):d.resolve(Buffer.from('abc'))},
        state(){
            if(old)return {waiting:plain(transfer.waiting),reading:transfer.reading.map(r=>({streamId:r.streamId,bytes:r.bytes,since:r.since,number:r.number})),served:[...transfer.served].map(([n,s])=>[n,s.streamId,s.reading?.streamId??null]),numbered:transfer.numbered,roomAwaited:transfer.roomAwaited,disposed:transfer.disposed,spent}
            const s=transfer.policy.run('snapshot')
            return {waiting:plain(s.waiting),reading:s.reading.map(({id,...r})=>plain(r)),served:Object.entries(s.served).map(([n,v])=>[Number(n),v.streamId,s.reading.find(r=>r.id===v.reading)?.streamId??null]),numbered:s.numbered,roomAwaited:s.roomAwaited,disposed:transfer.disposed,spent}
        },
    }
}
const request=(streamId,size=1024,flags=2,index=0,position=0)=>({streamId,index,flags,position,size})
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
let comparisons=0
async function scenario(name,steps){
    const a=fixture(true),b=fixture(false)
    try{
        for(const [i,step] of steps.entries()){
            step(a);step(b);await flush()
            assert.deepEqual(plain(b.events),plain(a.events),name+' events at '+i)
            assert.deepEqual(plain(b.state()),plain(a.state()),name+' state at '+i)
            a.events.length=b.events.length=0;comparisons++
        }
    }finally{a.transfer.dispose();b.transfer.dispose()}
}
await scenario('synchronous answers, exceptions and repeated completion',[
    f=>f.request(request(7,8,1)),f=>f.mode('sync'),f=>f.request(request(8)),f=>f.mode('throw'),f=>f.request(request(9)),
    f=>f.mode('answer-throw'),f=>f.request(request(10)),f=>f.mode('defer'),f=>f.request(request(11)),
    f=>f.request(request(11)),f=>f.answer(0),f=>f.answer(0),f=>f.request(request(11)),f=>f.answer(0),f=>f.answer(1),
])
await scenario('full read and wait budgets',[
    ...Array.from({length:4},(_,i)=>f=>f.request(request(i,16<<20))),
    ...Array.from({length:257},(_,i)=>f=>f.request(request(i+4,16<<20))),
    f=>f.request(request(400,8,1)),f=>f.answer(0),f=>f.answer(1),f=>f.transfer.revoke(),f=>f.answer(2),f=>f.send(),f=>f.answer(3),
])
await scenario('clock expiry and reused remote stream',[
    f=>f.request(request(0xffffffff,0)),f=>{f.clock.now=65999;f.transfer.expire()},f=>{f.clock.now=-100;f.transfer.expire()},
    f=>{f.clock.now=66000;f.transfer.expire()},f=>f.request(request(0xffffffff,0)),f=>f.answer(0),f=>f.answer(1),
])
await scenario('flow wait, restriction and disposal',[
    f=>f.room(false),f=>f.request(request(1)),f=>f.request(request(2)),f=>f.allow(false),f=>f.wake(),
    f=>f.allow(true),f=>f.room(false),f=>f.request(request(3)),f=>f.transfer.dispose(),f=>f.wake(),
])
await scenario('pending disk read survives offer replacement and cannot answer the new offer',[
    f=>f.sendDisk(),f=>f.request(request(1,10)),f=>{f.clock.now=100000;f.transfer.expire()},
    f=>f.sendDisk(),f=>f.request(request(1,10)),f=>f.request(request(2,10)),f=>f.settle(0),f=>f.settle(1),f=>f.answer(0),
    f=>f.request(request(3,10)),f=>f.allow(false),f=>f.transfer.revoke(),f=>f.settle(2),f=>f.allow(true),
    f=>f.request(request(4,10)),f=>f.settle(3,true),f=>f.request(request(5,10)),f=>f.transfer.dispose(),f=>f.settle(4),
])
let seed=0x87231467
const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0
for(let run=0;run<12;run++){
    const steps=[]
    for(let i=0;i<400;i++){
        const op=next()%10,n=next()
        if(op<4){const r=request(n%400,[0,1,65536,16<<20,0xffffffff][next()%5],next()%4,next()%2?0:-1,next()%2?0:2**53);steps.push(f=>f.request(r))}
        else if(op===4)steps.push(f=>f.answer(n%Math.max(1,f.pending.length),!!(n%2)))
        else if(op===5)steps.push(f=>{f.clock.now+=n%100000;f.transfer.expire()})
        else if(op===6)steps.push(f=>f.send())
        else if(op===7)steps.push(f=>{f.allow(!!(n%2));f.transfer.revoke()})
        else if(op===8)steps.push(f=>f.mode(['sync','defer','throw','answer-throw'][n%4]))
        else steps.push(f=>f.wake())
    }
    await scenario('generated sequence '+run,steps)
}
console.log(comparisons+' actual TypeScript scheduling states and callback traces matched')

// IEEE-754 integer precision is the independent limit: the old increment can
// alias provider identities and route an older completion to the newer stream.
const exhausted=fixture(true)
try {
    exhausted.transfer.numbered=Number.MAX_SAFE_INTEGER
    exhausted.request(request(101));exhausted.request(request(102))
    assert.equal(exhausted.pending[0].streamId,exhausted.pending[1].streamId)
    exhausted.answer(0)
    assert.equal(exhausted.events.find(e=>e[0]==='submit')[1],102)
} finally {exhausted.transfer.dispose()}
// The native provider_counter_stops_before_javascript_can_alias_ids check
// exercises this exact boundary and requires refusal without state changes.
console.log('Original provider-counter alias reproduced at the safe-integer boundary')

// Each connection has an independent module, and a failed call can never recreate provider IDs.
const cls=factory(false,{now:0}).TransferPolicy, one=new cls(),two=new cls()
assert.equal(one.run('reserve',{request:request(1)}),1)
assert.equal(two.run('waiting'),0)
assert.throws(()=>one.run('invalid'))
assert.throws(()=>one.run('serve',{request:request(1),reading:1}))
assert.deepEqual(plain(one.dispose()),[65536]);assert.deepEqual(plain(one.dispose()),[])
console.log('Connection isolation and permanent failure with reservation cleanup passed')

const module=new WebAssembly.Module(Buffer.from(WASM,'base64'))
assert.deepEqual(WebAssembly.Module.imports(module),[])
const api=new WebAssembly.Instance(module,{}).exports
console.log('Initial per-owner linear memory: '+api.memory.buffer.byteLength)
function raw(bytes){
    const p=api.allocate(bytes.length);assert.ok(p)
    try{new Uint8Array(api.memory.buffer,p,bytes.length).set(bytes);const out=api.request(p,bytes.length);return JSON.parse(new TextDecoder().decode(new Uint8Array(api.memory.buffer,out,api.response_len())))}
    finally{api.release(p,bytes.length)}
}
for(const bytes of [Buffer.from('{'),Buffer.from([255]),Buffer.from('{"op":"admit","request":{}}')])assert.ok(raw(bytes).error)
const prefix=Buffer.from('{"op":"waiting","future":"'),suffix=Buffer.from('"}')
const limit=Buffer.concat([prefix,Buffer.alloc((8<<20)-prefix.length-suffix.length,120),suffix])
assert.equal(raw(limit).value.value,0);assert.equal(api.allocate((8<<20)+1),0)
const ready=Buffer.from('{"op":"waiting"}'),warm=api.memory.buffer.byteLength
for(let n=0;n<100;n++)assert.equal(raw(ready).value.value,0)
assert.ok(api.memory.buffer.byteLength<=warm+(1<<20));assert.throws(()=>api.memory.grow(2048),RangeError)

// An admitted but dense JSON value exhausts the real 128 MiB Wasm ceiling.
// The stateful adapter must not use the stateless loader's fresh-instance recovery.
const trapped=new cls();const reading=trapped.run('reserve',{request:request(7)})
assert.equal(trapped.run('serve',{request:request(7),reading}),1)
assert.throws(()=>trapped.run('waiting',{future:Array(4000000).fill(0)}),e=>e.name==='RuntimeError')
assert.throws(()=>trapped.run('serve',{request:request(99),reading:null}),/unavailable/)
assert.deepEqual(plain(trapped.dispose()),[65536])
console.log('Malformed input, 8 MiB boundary, ownership, 128 MiB ceiling and post-trap identity rejection passed')

if(process.argv.includes('--bench')){
    for(const old of [true,false]){
        const batches=[];let sum=0
        for(let round=0;round<5;round++){
            const f=fixture(old);f.mode('sync')
            const start=performance.now()
            for(let n=0;n<1000;n++)f.request(request(n))
            batches.push(performance.now()-start);sum+=f.spent;f.transfer.dispose()
        }
        console.log((old?'Before':'After')+' 1000 complete callback requests median_ms='+batches.sort((a,b)=>a-b)[2]+' checksum='+sum)
    }
    console.log('Module bytes: '+Buffer.from(WASM,'base64').length)
}
