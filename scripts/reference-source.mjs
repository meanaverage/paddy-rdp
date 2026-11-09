// Frozen pre-migration oracles; no access to Paddy's private Git history is needed.
import fs from 'node:fs'
import {createHash} from 'node:crypto'
const root=new URL('../',import.meta.url)
const manifest=JSON.parse(fs.readFileSync(new URL('fixtures/reference/manifest.json',root),'utf8'))
export function referenceSource(command,args){
 if(command!=='git'||args.length!==2||args[0]!=='show')throw Error('Expected a frozen git-show reference')
 const record=manifest.sources[args[1]]
 if(!record)throw Error('Unknown reference: '+args[1])
 const bytes=fs.readFileSync(new URL(record.file,root))
 if(createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw Error('Reference checksum mismatch: '+args[1])
 return bytes.toString('utf8')
}
