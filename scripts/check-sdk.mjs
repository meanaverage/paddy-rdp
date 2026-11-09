import fs from 'node:fs'
import {createHash} from 'node:crypto'
const root=new URL('../',import.meta.url)
const manifest=JSON.parse(fs.readFileSync(new URL('sdk-provenance.json',root),'utf8'))
for(const [file,digest] of Object.entries(manifest.shipped)){
    const actual=createHash('sha256').update(fs.readFileSync(new URL(file,root))).digest('hex')
    if(actual!==digest)throw Error('SDK snapshot changed without provenance update: '+file)
}
console.log('Verified '+Object.keys(manifest.shipped).length+' SDK snapshot files')
