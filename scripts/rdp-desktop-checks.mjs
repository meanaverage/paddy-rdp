// Production desktop policy through the packaged RDP plugin. No host command or credential-store access.
export default [
    ['RDP desktop policy: configuration keeps consent, wake rules and exact identities', String.raw`
        const api = (await until(() => window.__remoteDesktop)).identities
        const entry = {host:'desk',port:'0xD3D',kind:'xrdp',wake:{vm:'guest'},username:'\ud800',clipboard:'unknown'}
        const spec = api.specOf(entry)
        if (spec.id !== 'desk:3389' || spec.kindTrusted !== false || api.xrdpUnasked(spec) || spec.clipboard !== 'off') throw new Error('Host trust or clipboard restriction widened')
        if (spec.username !== '\ud800' || spec.wake.vm !== 'guest') throw new Error('Configuration identity changed')
        if (!api.xrdpUnasked(api.specOf({...entry,kindFromHost:false}))) throw new Error('Explicit user kind choice was lost')
        if (api.specOf({...entry,host:'bad#key'}) !== null || api.specOf({...entry,port:65536}) !== null) throw new Error('Invalid desktop admitted')
        if (api.desktopIdOf({port:'inf'}) !== '127.0.0.1:NaN' || api.specOf({port:0}).port !== 3389) throw new Error('Numeric compatibility changed')
        const wol = api.specOf({host:'desk',wake:{mac:'AA-BB-CC-DD-EE-FF',broadcast:'999.1.2.3',port:'10'}}).wake
        if (wol.mac !== 'AA-BB-CC-DD-EE-FF' || wol.broadcast !== '999.1.2.3' || wol.port !== 10) throw new Error('Wake parsing dialect changed')
        const id='5f05e000-1234-abcd-ef01-0123456789ab'
        const hv=api.specOf({hyperv:'{'+id.toUpperCase()+'}',host:'ignored',port:0,clipboard:'fromRemote'})
        if (hv.id !== 'hyperv:'+id || hv.port !== 2179 || hv.wake.hyperv !== id || hv.clipboard !== 'fromRemote') throw new Error('Hyper-V spec changed')
        return true
    `],
    ['RDP desktop policy: duplicate entries narrow clipboard and nested hosts stay separate', `
        const api=(await until(() => window.__remoteDesktop)).identities
        const target={key:'u@host:22',label:'alias'}
        const extras=[{via:'alias',host:'desk',name:'first'},{via:'host',host:'desk',name:'second',clipboard:'fromRemote'}]
        const list=api.desktopsFor(target,extras,{kind:'gnome',xrdpPort:3390},[{host:'desk',clipboard:'off'}],'both')
        if (list.length !== 3 || list[1].name !== 'first' || list[1].clipboard !== 'off' || list[2].id !== '127.0.0.1:3390') throw new Error('Duplicate ordering or restriction changed')
        if (list[0].kindTrusted !== undefined || list[2].kindTrusted !== undefined) throw new Error('Reported desktop became trusted')
        const nested=api.desktopsFor({...target,key:'outer@jump:22>u@host:22',via:{}},extras)
        if (nested.length !== 1 || nested[0].id !== 'own') throw new Error('Nested host borrowed configured desktops')
        return true
    `],
    ['RDP desktop policy: real IronRDP clipboard hooks respect restricted modes', `
        const rd=await until(() => window.__remoteDesktop), policy=rd.clipboardPolicy
        for (const mode of ['both','fromRemote','off']) {
            const rdp=await rd.desktop.ironrdp.create('warn')
            const el=document.createElement('iron-remote-desktop')
            let ui, started=0, finished=0, disposed=0, sending=false
            const enable=[]
            const provider={onUploadStarted(){started++},onUploadFinished(){finished++},dispose(){disposed++}}
            el.module=rdp.Backend
            el.style.cssText='position:fixed;width:20px;height:20px;left:-100px;top:0'
            el.addEventListener('ready',e=>{ui=e.detail.irgUserInteraction},{once:true})
            document.body.append(el)
            try {
                await until(()=>ui)
                const set=ui.setEnableClipboard
                ui.setEnableClipboard=value=>{enable.push(value);set(value)}
                const result=policy.setUpClipboard(ui,provider,mode,()=>sending)
                if (result.mode !== mode || started !== (mode==='both'?0:1)) throw new Error('Vendor hook setup changed')
                provider.onUploadFinished()
                if (finished !== 0) throw new Error('Restricted clipboard resumed')
                sending=true;provider.onUploadFinished()
                if (finished !== 1) throw new Error('Allowed clipboard failed to resume')
                result.stopSending()
                if (started !== (mode==='both'?1:2)) throw new Error('Stop hook was not retained')
                if (JSON.stringify(enable) !== JSON.stringify(mode==='off'?[false]:[])) throw new Error('Clipboard channel disable changed')
            } finally { ui?.shutdown();el.remove() }
            if (!disposed) throw new Error('Vendor provider was not disposed')
        }
        const items=[{name:'one'},{name:'two'},{name:'three'}]
        const result=policy.splitPaste(items,d=>({toRemote:d===items[1],fromRemote:true}),d=>d.name)
        if (result.targets[0] !== items[1] || result.left[0] !== items[0] || result.left[1] !== items[2] || !result.note.includes('one and three')) throw new Error('Paste partition changed')
        return true
    `],
]
