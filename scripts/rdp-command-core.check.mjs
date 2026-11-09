import {referenceSource} from './reference-source.mjs'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
if (!process.argv[2]) throw Error('usage: node scripts/rdp-command-core.check.mjs <output example>')
const old = referenceSource('git', ['show', '0e4d0fa9fff51c1970e5347b2c2dce6bb9ad3b07:rdp-plugin/src/ssh.ts'], {cwd:root,encoding:'utf8'})
const body = old.slice(old.indexOf('// Printed after'), old.indexOf('/**\n * Picks up data'))
const {Output,END,MAX_OUTPUT} = new Function(stripTypeScriptTypes(body.replaceAll('export ', ''),{mode:'strip'})+'\nreturn {Output,END,MAX_OUTPUT}')()
const child = spawn(path.resolve(process.argv[2]),[],{stdio:['pipe','pipe','inherit']})
const pending=[]
createInterface({input:child.stdout}).on('line',line=>pending.shift()?.resolve(JSON.parse(line)))
child.on('error',e=>pending.splice(0).forEach(p=>p.reject(e)))
child.on('exit',code=>pending.splice(0).forEach(p=>p.reject(Error(`output example exited ${code}`))))
let comparisons=0
async function check(chunks,strip) {
    const old = new Output(); let overflow=false,tail=''
    for(const bytes of chunks) { overflow = !old.add(bytes) || overflow; tail=(tail+Buffer.from(bytes)).slice(-4096) }
    const text=old.bytes().toString('utf8'),end=text.lastIndexOf(END)
    const units=Array.from({length:tail.length},(_,i)=>tail.charCodeAt(i))
    const expected=overflow?{error:'Remote command printed more than 4 MB where a few lines were expected: stopped reading it',tail:units}:{ok:strip&&end>=0?text.slice(0,end):text,tail:units}
    const got=await new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify({chunks:chunks.map(x=>[...x]),strip})+'\n')})
    assert.deepEqual(got,expected,`capture ${comparisons}`);comparisons++
}
try {
    for(const text of ['', 'hello', 'α😀', END, `before${END}after`, `${END}between${END}\n`, '\ufffd\0']) {
        const bytes=Buffer.from(text)
        for(let at=0;at<=bytes.length;at++) for(const strip of [false,true]) await check([bytes.subarray(0,at),bytes.subarray(at)],strip)
    }
    let seed=0x819238
    const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0
    for(let n=0;n<4000;n++) {
        const chunks=Array.from({length:1+random()%12},()=>Buffer.from(Array.from({length:random()%80},()=>random()>>>24)))
        if(n%3===0) chunks.splice(random()%chunks.length,0,Buffer.from(END))
        await check(chunks,n%2===0)
    }
    for(const bytes of [Buffer.from('😀'+'x'.repeat(4095)), Buffer.alloc(10000,255), Buffer.alloc(MAX_OUTPUT,120),Buffer.alloc(MAX_OUTPUT+1,120)]) {
        await check([bytes],true)
    }
    await check([Buffer.alloc(MAX_OUTPUT-1,120),Buffer.from('z'),Buffer.from('overflow'),Buffer.alloc(0)],false)
    // Run the production adapter: raw input normalization, timer observation and bounded UTF-16 stderr reconstruction.
    const facade=fs.readFileSync(path.join(root,'rdp-plugin/src/command.ts'),'utf8').replace(/^import .*\n/gm,'').replaceAll('export ','')
    let observed,reply={output:'answer',stderr:[0xd800,65],code:255},failure
    const invoke=async(command,args)=>{assert.equal(command,'rdp_command');observed=args;if(failure)throw failure;return reply}
    const api=new Function('invoke',stripTypeScriptTypes(facade,{mode:'strip'})+'\nreturn remoteCommand')(invoke)
    for(const delay of [0,1,1.5,-1,60000,2147483648,NaN,Infinity]) {
        const result=await api({kind:'managed',client:7,command:'fixture'},'A\ud800B',delay)
        assert.equal(observed.input,'A\ufffdB');assert.equal(observed.timeoutMs,Math.max(0,delay|0));assert.equal(result.stderr,'\ud800A');assert.equal(result.code,255)
    }
    failure='RDP_COMMAND_TIMEOUT';await assert.rejects(api({kind:'system',args:[]},'',25),/Remote command timed out after 0.025s/)
    console.log(`${comparisons} actual TypeScript output/marker/stderr comparisons and 9 facade cases passed`)
} finally { child.stdin.end() }
