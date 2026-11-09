// Real packaged facades and IronRDP FileReader behavior; transport output is a private sink.
const setup=`
    const rd=await until(()=>window.__remoteDesktop), rdp=await rd.desktop.ironrdp.create('warn')
    const responses=[], logs=[], pending=[]
    let allowed=true, spent=0
    const overlay=document.createElement('div')
    class LocalProvider extends rdp.RdpFileTransferProvider {
        sendInitiateFileCopy(entries) { this.advertised=entries }
        sendSubmitFileContents(streamId,error,data) { responses.push({streamId,error,data:Array.from(data)}) }
    }
    const flow={room:()=>true,whenRoom:()=>Promise.resolve(),spend:n=>{spent+=n},refund:n=>{spent=Math.max(0,spent-n)}}
    const make=(Provider=LocalProvider)=>{
        const f=new rd.fileTransfer.FileTransfer({RdpFileTransferProvider:Provider},overlay,msg=>logs.push(msg),()=>({toRemote:allowed,fromRemote:true}),flow)
        f.toast=()=>{}
        return f
    }
    const request=(streamId,size=3,flags=2)=>({streamId,index:0,flags,position:0,size})
`
export default [
    ['RDP transfer: real vendor reads preserve remote IDs, overlap rejection and clipboard restrictions',setup+`
        const f=make(), text='synthetic clipboard bytes'
        try {
            const done=f.send([new File([text],'sample.txt')])
            if (!done || f.provider.advertised.length!==1) throw new Error('Files were not advertised')
            f.provider.handleFileContentsRequest(request(0xffffffff,8,1))
            if (responses[0].streamId!==0xffffffff || responses[0].error || new DataView(Uint8Array.from(responses[0].data).buffer).getBigUint64(0,true)!==BigInt(text.length)) throw new Error('File size or unsigned stream ID changed')
            f.provider.handleFileContentsRequest(request(41,text.length))
            f.provider.handleFileContentsRequest(request(41,text.length))
            await done
            const replies=responses.filter(r=>r.streamId===41)
            if (replies.length!==2 || !replies[0].error || replies[0].data.length || replies[1].error || new TextDecoder().decode(Uint8Array.from(replies[1].data))!==text) throw new Error('Duplicate stream affected the original read')
            if (spent!==8+text.length) throw new Error('Read reservation was not released exactly once')
            f.provider.handleFileContentsRequest(request(41,text.length))
            await until(()=>responses.filter(r=>r.streamId===41).length===3)
            if (spent!==8+2*text.length) throw new Error('Re-paste changed request accounting')
            allowed=false;f.revoke();f.provider.handleFileContentsRequest(request(42,text.length))
            const last=responses.at(-1)
            if (last.streamId!==42 || !last.error || last.data.length) throw new Error('Revoked clipboard returned file data')
            return true
        } finally { f.dispose();overlay.remove() }
    `],
    ['RDP transfer: native disk reads retain their charges across replacement and stop answering after disposal',setup+`
        const fs=require('fs'),path=require('path'),dir=await fs.promises.mkdtemp(path.join(require('os').tmpdir(),'rdp-transfer-'))
        const f=make(), file=path.join(dir,'sample.txt'), text='synthetic disk bytes'
        let g
        try {
            await fs.promises.writeFile(file,text)
            const entries=()=>rd.fileTransfer.entriesFor([file]).entries
            f.send(entries());f.provider.handleFileContentsRequest(request(51,text.length))
            const done=f.send(entries());f.provider.handleFileContentsRequest(request(52,text.length))
            if (spent!==2*65536) throw new Error('Pending disk memory was released before I/O settled')
            await done;await until(()=>responses.some(r=>r.streamId===51))
            const old=responses.filter(r=>r.streamId===51),current=responses.filter(r=>r.streamId===52)
            if (old.length!==1 || !old[0].error || old[0].data.length || current.length!==1 || current[0].error || new TextDecoder().decode(Uint8Array.from(current[0].data))!==text) throw new Error('Replacement mixed disk responses between offers')
            if (spent!==text.length) throw new Error('Settled disk reservations were not refunded')
            const before=responses.length,baseline=spent
            g=make();g.send(entries());g.provider.handleFileContentsRequest(request(53,text.length));g.dispose()
            await g.disk;await new Promise(r=>setTimeout(r,0))
            if (responses.length!==before || spent!==baseline) throw new Error('Disposed disk callback answered or changed another reservation')
            return true
        } finally { f.dispose();g?.dispose();overlay.remove();await fs.promises.rm(dir,{recursive:true,force:true}) }
    `],
    ['RDP transfer: late provider completions cannot answer a new offer on a reused remote stream',setup+`
        class DeferredProvider extends LocalProvider {
            handleFileContentsRequest(r) { this.acknowledgePaste();pending.push({...r}) }
        }
        const f=make(DeferredProvider)
        try {
            f.send([new File(['old'],'old.txt')]);f.provider.handleFileContentsRequest(request(61))
            const old=pending[0].streamId
            f.send([new File(['new'],'new.txt')]);f.provider.handleFileContentsRequest(request(61))
            const current=pending[1].streamId,before=responses.length
            if (current===old || spent!==65536) throw new Error('Provider identity or replacement reservation was reused')
            f.provider.sendSubmitFileContents(old,false,new Uint8Array([111,108,100]))
            if (responses.length!==before || spent!==65536) throw new Error('Old provider response reached the new stream')
            f.provider.sendSubmitFileContents(current,false,new Uint8Array([110,101,119]))
            if (responses.at(-1).streamId!==61 || responses.at(-1).error || spent!==3) throw new Error('Current provider response was lost')
            f.provider.sendSubmitFileContents(current,false,new Uint8Array([110,101,119]))
            if (responses.length!==before+1 || spent!==3) throw new Error('Repeated completion changed accounting')
            return true
        } finally { f.dispose();overlay.remove() }
    `],
]
