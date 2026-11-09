// Exercise the compiled module boundary, including ownership across repeated calls and its hard memory ceiling.
import fs from 'node:fs'
import assert from 'node:assert/strict'
const file=process.argv[2]
if (!file) throw new Error('usage: node scripts/rust-page.check.mjs <generated .data.ts>')
const encoded=JSON.parse(fs.readFileSync(file,'utf8').match(/export const WASM = ("[^"]*")/)[1])
const module=new WebAssembly.Module(Buffer.from(encoded,'base64'))
assert.deepEqual(WebAssembly.Module.imports(module), [], 'The pure core has no host imports')
const api=new WebAssembly.Instance(module,{}).exports
assert.equal(api.allocate((8<<20)+1),0,'Oversized requests are rejected before allocation')
const call=input=>{
 const bytes=Buffer.from(JSON.stringify(input)),ptr=api.allocate(bytes.length)
 try {new Uint8Array(api.memory.buffer,ptr,bytes.length).set(bytes);const out=api.request(ptr,bytes.length);return JSON.parse(new TextDecoder().decode(new Uint8Array(api.memory.buffer,out,api.response_len())))}
 finally {api.release(ptr,bytes.length)}
}
assert.ok(call({op:'unknown'}).error)
const sample={op:'parse',source:'<text>Words 😀</text>'.repeat(1000)}
if(file.includes('answer')){
 for(let i=0;i<5;i++) assert.ok(call(sample).value.nodes.length)
 const warm=api.memory.buffer.byteLength
 for(let i=0;i<100;i++) assert.ok(call(sample).value.nodes.length)
 assert.ok(api.memory.buffer.byteLength <= warm+(1<<20),'Input and output allocations are reused')
 assert.equal(call({op:'parse',source:'<row>'.repeat(129)}).value.diagnostics[0].code,'too_deep')
 assert.ok(call({op:'parse',source:'recovered'}).value)
}
assert.throws(()=>api.memory.grow(2048),RangeError,'A module cannot exceed its 128 MiB ceiling')
console.log('Rust page core ownership, import and memory bounds passed')
