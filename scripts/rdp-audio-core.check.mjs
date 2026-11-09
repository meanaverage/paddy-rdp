import {referenceSource} from './reference-source.mjs'
// Actual pre-port/current audio classes against controlled samples and Web Audio observations.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)))
const base='ed3133e64ed9b970bf38c72d55addfffa2c707d8'
if(!process.argv[2])throw Error('usage: node scripts/rdp-audio-core.check.mjs <wasm/data.ts> [--bench]')
const file=process.argv[2]
const WASM=file.endsWith('.wasm')?fs.readFileSync(file).toString('base64'):JSON.parse(fs.readFileSync(file,'utf8').match(/export const WASM = ("[^"]*")/)[1])
const read=f=>fs.readFileSync(path.join(root,f),'utf8')
const clean=s=>s.replace(/^import .*\n/gm,'').replaceAll('export ','')
function lower(source){
    return source.replace(/constructor \(([\s\S]*?)\) \{/g,(_,args)=>{
        const names=[...args.matchAll(/\b(?:(?:private|public|protected|readonly)\s+)+(\w+)/g)].map(m=>m[1])
        return 'constructor ('+args.replace(/\b(private|public|protected|readonly)\s+/g,'')+') {'+names.map(n=>'this.'+n+'='+n+';').join('')
    })
}
function factory(old,environment={}){
    let source=old?'':clean(read('rdp-plugin/src/audioCore.ts'))+'\n'
    for(const file of ['audio','microphone'])source+=clean(old?referenceSource('git',['show',base+':rdp-plugin/src/'+file+'.ts'],{cwd:root,encoding:'utf8'}):read('rdp-plugin/src/'+file+'.ts'))+'\n'
    return vm.runInNewContext(stripTypeScriptTypes(lower(source),{mode:'strip'})+'\n;({AudioPlayer,Microphone,Resampler'+(!old?',AudioCore':'')+'})',{
        WASM,WebAssembly,Uint8Array,Int16Array,Float32Array,ArrayBuffer,DataView,atob,console:{warn(){}},process:{platform:'darwin'},...environment,
    })
}
const plain=v=>JSON.parse(JSON.stringify(v))
let seed=0x78318265
const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0
const special=[0,-0,0.5,-0.5,1,-1,2,-2,NaN,Infinity,-Infinity,2**-126,2**-149]
function samples(channels,frames){
    return Array.from({length:channels},()=>Float32Array.from({length:frames},()=>random()%9===0?special[random()%special.length]:(random()/0xffffffff)*2-1))
}
const old=factory(true),now=factory(false)
let compared=0, sampleCount=0
for(const inputRate of [8000,11025,16000,22050,44100,48000,96000])for(const outputRate of [8000,16000,44100,48000])for(const channels of [1,2])for(const captured of [1,2,3]){
    const a=new old.Resampler(inputRate,outputRate,channels),b=new now.Resampler(inputRate,outputRate,channels)
    for(let n=0;n<16;n++){
        const input=samples(captured,[0,1,2,3,127,128,257,1000][n%8])
        if(n===10&&captured>1)input[1]=input[1].subarray(0,1)
        const expected=a.process(input),actual=b.process(input)
        assert.deepEqual(Array.from(actual),Array.from(expected),JSON.stringify({inputRate,outputRate,channels,captured,n}))
        compared++;sampleCount+=actual.length
    }
}
console.log(compared+' streaming blocks and '+sampleCount+' PCM samples matched actual TypeScript')
function playback(old){
    const clock={now:0,fail:null},events=[],buffers=[]
    class AudioContext {
        constructor(){this.state='suspended';this.destination={}}
        get currentTime(){return clock.now}
        createGain(){return {gain:{value:1},connect(){}}}
        resume(){events.push(['resume']);this.state='running';return Promise.resolve()}
        close(){events.push(['context-close']);return Promise.resolve()}
        createBuffer(channels,frames,rate){
            if(clock.fail==='buffer')throw Error('synthetic buffer failure')
            const planes=Array.from({length:channels},()=>new Float32Array(frames));buffers.push(planes)
            return {duration:frames/rate,getChannelData:c=>planes[c]}
        }
        createBufferSource(){
            if(clock.fail==='source')throw Error('synthetic source failure')
            return {connect(){},start(t){events.push(['start',t]);if(clock.fail==='start')throw Error('synthetic start failure')}}
        }
    }
    const cls=factory(old,{AudioContext}),player=new cls.AudioPlayer()
    return {clock,events,buffers,player,state:()=>({received:player.received,peak:player.peak,gain:player.gain?.gain.value??null,gainNegativeZero:Object.is(player.gain?.gain.value,-0),events,buffers:buffers.map(b=>b.map(c=>Array.from(c)))})}
}
const a=playback(true),b=playback(false)
for(let i=0;i<1000;i++){
    const t=random()%10000/1000,kind=random()%11,frames=random()%128,channels=random()%3+1
    a.clock.now=b.clock.now=t
    a.clock.fail=b.clock.fail=[null,null,null,'source','start','buffer'][random()%6]
    if(kind<7){
        const bytes=Uint8Array.from({length:frames*2*channels+random()%2},()=>random()%256)
        const m={type:'wave',sampleRate:[8000,44100,48000][random()%3],channels,data:bytes}
        a.player.callback(m);b.player.callback(m)
    }else if(kind===7){a.player.callback({type:'close'});b.player.callback({type:'close'})}
    else if(kind===8){a.player.close();b.player.close()}
    else {const m={type:'volume',left:random()%5-2,right:random()%5-2};a.player.callback(m);b.player.callback(m)}
    assert.deepEqual(plain(b.state()),plain(a.state()),'playback event '+i)
    a.buffers.length=b.buffers.length=a.events.length=b.events.length=0
}
console.log('1000 playback callback traces, counters, clock boundaries and failure stages matched')
for(const f of [a,b]){
    f.clock.fail=null
    f.player.callback({type:'wave',sampleRate:48000,channels:1,data:new Uint8Array([0,0])})
    f.player.callback({type:'volume',left:-0,right:-0})
}
assert.deepEqual(plain(b.state()),plain(a.state()),'Volume normalizes negative zero as Math.max does')
function microphone(cls){
    const events=[];let fail=false
    const mic=new cls.Microphone(pcm=>{events.push(['pcm',Array.from(pcm)]);if(fail)throw Error('synthetic send failure')},()=>events.push(['changed']),m=>events.push(['log',m]),m=>events.push(['error',m]))
    return {mic,events,setFail:v=>{fail=v},state:()=>({sent:mic.sent,peak:mic.peak,capturing:mic.capturing,events})}
}
const ma=microphone(old),mb=microphone(now)
for(let i=0;i<300;i++){
    const format={sampleRate:[8000,16000,44100,48000][random()%4],channels:random()%2+1}
    const rate=[44100,48000][random()%2],input=samples(random()%2+1,random()%257)
    if(i%11===0){ma.mic.stop();mb.mic.stop();ma.mic.format=mb.mic.format=null}
    if(i%7===0){ma.mic.stop();mb.mic.stop();ma.mic.format=mb.mic.format=format}
    ma.setFail(i%13===0);mb.setFail(i%13===0)
    ma.mic.captured(input,rate);mb.mic.captured(input,rate)
    assert.deepEqual(plain(mb.state()),plain(ma.state()),'capture callback '+i)
    ma.events.length=mb.events.length=0
}
console.log('300 microphone capture/reset/send-failure traces matched without device access')
const module=new WebAssembly.Module(Buffer.from(WASM,'base64'))
assert.deepEqual(WebAssembly.Module.imports(module),[])
const api=new WebAssembly.Instance(module,{}).exports
console.log('Initial audio owner linear memory: '+api.memory.buffer.byteLength)
assert.equal(api.audio_prepare((8<<20)+1),0)
let p=api.audio_prepare(8);new DataView(api.memory.buffer).setUint32(p,65536,true)
assert.equal(api.audio_process(0,1,48000,48000),2)
p=api.audio_prepare(4);new Uint8Array(api.memory.buffer,p,4).set([0,128,255,127])
assert.equal(api.audio_process(1,1,0,0),0)
const output=new Float32Array(new Uint8Array(api.memory.buffer,api.audio_output(),api.audio_output_len()).slice().buffer)
assert.deepEqual(Array.from(output),[-1,32767/32768])
const warm=api.memory.buffer.byteLength
for(let i=0;i<1000;i++){api.audio_prepare(4);assert.equal(api.audio_process(1,1,0,0),0)}
assert.equal(api.memory.buffer.byteLength,warm)
assert.deepEqual(Array.from(output),[-1,32767/32768],'Returned sample copies survive later calls')
// Real inclusive input/output bounds: 8 MiB of PCM16 becomes 16 MiB of float PCM.
p=api.audio_prepare(8<<20);assert.ok(p)
new Uint8Array(api.memory.buffer,p,8<<20).fill(0)
assert.equal(api.audio_process(1,2,0,0),0)
assert.equal(api.audio_output_len(),16<<20)
// A valid capture packet at exactly the same bound reaches the resampler.
const view=new DataView(api.memory.buffer)
view.setUint32(p,1,true);view.setUint32(p+4,((8<<20)-8)/4,true)
assert.equal(api.audio_process(0,1,48000,48000),0)
assert.equal(api.audio_output_len(),(((8<<20)-8)/4-1)*2)
assert.throws(()=>api.memory.grow(2048),RangeError)
const owner=new now.AudioCore(),other=new now.AudioCore(),input=[new Float32Array([0,1,0])]
owner.capture(input,48000,48000,1)
assert.equal(other.capture(input,48000,48000,1).length,2)
// Simulate a trapped export, independently of the allocator's internal strategy.
owner.api={audio_prepare(){throw new WebAssembly.RuntimeError('synthetic trap')}}
assert.throws(()=>owner.capture(input,48000,48000,1),WebAssembly.RuntimeError)
assert.throws(()=>owner.capture(input,48000,48000,1),/unavailable/)
assert.equal(other.capture(input,48000,48000,1).length,3)
console.log('Binary ABI malformed input, owned output, allocation reuse and 128 MiB ceiling passed; module bytes='+Buffer.from(WASM,'base64').length)
if(process.argv.includes('--bench')){
    const input=samples(2,960)
    for(const [name,cls]of [['Before',old],['After',now]]){
        const batches=[];let checksum=0
        for(let b=0;b<5;b++){
            const r=new cls.Resampler(48000,44100,2)
            const start=performance.now()
            for(let i=0;i<1000;i++){const pcm=r.process(input);checksum+=pcm.length+pcm[0]}
            batches.push(performance.now()-start)
        }
        console.log(name+' 1000 stereo blocks median_ms='+batches.sort((a,b)=>a-b)[2]+' checksum='+checksum)
    }
}
