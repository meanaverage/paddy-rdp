import {referenceSource} from './reference-source.mjs'
// All SSH traffic goes to the suite's throwaway loopback server and generated account key.
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
export default ({ sshPort, sshDir, username, evaluate, prelude }) => {
    const profile = {type:'ssh',name:'RDP command fixture',options:{host:'127.0.0.1',port:sshPort,user:username,auth:'publicKey',privateKeys:[`file://${sshDir}/client`]}}
    const args = ['-F','/dev/null','-o','UserKnownHostsFile=/dev/null','-o','StrictHostKeyChecking=no','-o','BatchMode=yes','-i',`${sshDir}/client`,'-p',String(sshPort),`${username}@127.0.0.1`]
    return [
        ['RDP command: managed SSH collects bounded output without disturbing the terminal and recovers after timeout', `
            const rd = await until(() => window.__remoteDesktop)
            const {invoke} = require('@tauri-apps/api/core')
            const config = window.tabby.get(core.ConfigService), previous = config.store.ssh.verifyHostKeys
            config.store.ssh.verifyHostKeys = false
            let t
            try {
                const opened = await zone.run(() => window.tabby.get(core.ProfilesService).openNewTabForProfile(${JSON.stringify(profile)}))
                t = opened.getAllTabs ? opened.getAllTabs()[0] : opened
                await ready(t)
                const input = 'α😀\\n'.repeat(20000)
                if (await rd.execRemote(t,'cat',input) !== input) throw Error('managed stdin/output changed')
                if (await rd.execRemote(t,"printf 'first__trd_exec_end__middle'") !== 'first__trd_exec_end__middle') throw Error('last marker handling changed')
                if (await rd.execRemote(t,"printf '\\\\360\\\\237'; sleep 0.01; printf '\\\\230\\\\200'") !== '😀') throw Error('UTF8 chunk boundary changed')
                if (await rd.execRemote(t,"printf 'kept'; exit 7") !== 'kept') throw Error('exit-status policy changed')
                const maximum = 4194304 - '__trd_exec_end__\\n'.length
                const make = n => "head -c " + n + " /dev/zero | tr '\\\\000' x"
                if ((await rd.execRemote(t,make(maximum))).length !== maximum) throw Error('inclusive managed output limit failed')
                let failed = false
                try { await rd.execRemote(t,make(maximum+1)) } catch(e) { failed = e.message.includes('more than 4 MB') }
                if(!failed) throw Error('managed overflow accepted')
                failed = false
                try { await rd.execRemote(t,'sleep 2','',1) } catch(e) { failed = e.message === 'Remote command timed out after 0.001s' }
                if(!failed) throw Error('managed deadline lost')
                if(await rd.execRemote(t,"printf 'recovered'") !== 'recovered') throw Error('timeout damaged transport')
                await until(async()=>await invoke('rdp_command_count')===0)
                await run(t,'echo terminal-$((6*7))','terminal-42')
                return true
            } finally {
                config.store.ssh.verifyHostKeys = previous
                if(t) await zone.run(()=>app.closeTab(holder(t),false))
            }
        `],
        ['RDP command: system SSH drains input and both outputs, retains status and enforces its deadline', `
            const {invoke} = require('@tauri-apps/api/core')
            const execute = (command,input='',timeoutMs=60000) => invoke('rdp_command',{target:{kind:'system',args:[...${JSON.stringify(args)},command]},input,timeoutMs})
            const input='α😀\\n'.repeat(20000)
            if((await execute('cat',input)).output!==input) throw Error('system stdin/output changed')
            const status=await execute("printf 'answer'; printf 'permission denied' >&2; exit 255")
            if(status.output!=='answer'||status.code!==255||!String.fromCharCode(...status.stderr).endsWith('permission denied')) throw Error('system stderr/status changed')
            const early=await execute('exit 42','x'.repeat(2*1024*1024))
            if(early.code!==42) throw Error('EPIPE replaced remote status')
            if((await execute("head -c 4194304 /dev/zero | tr '\\\\000' x")).output.length!==4194304) throw Error('inclusive system output limit failed')
            let failed=false
            try { await execute('head -c 4194305 /dev/zero') } catch(e) { failed=String(e).includes('more than 4 MB') }
            if(!failed) throw Error('system overflow accepted')
            failed=false
            try { await execute('sleep 2','',50) } catch(e) { failed=String(e)==='RDP_COMMAND_TIMEOUT' }
            if(!failed) throw Error('system deadline lost')
            await until(async()=>await invoke('rdp_command_count')===0)
            if((await execute("printf 'recovered'")).output!=='recovered') throw Error('system command failed after timeout')
            return true
        `],
        ['RDP command: another app window cannot use the originating windows SSH transport', async () => {
            let fixture
            try {
                fixture = await evaluate(prelude + `
                    const config=window.tabby.get(core.ConfigService), previous=config.store.ssh.verifyHostKeys
                    config.store.ssh.verifyHostKeys=false
                    const opened=await zone.run(()=>window.tabby.get(core.ProfilesService).openNewTabForProfile(${JSON.stringify(profile)}))
                    const t=opened.getAllTabs?opened.getAllTabs()[0]:opened
                    window.__rdpCommandOwner={tab:t,previous}
                    await ready(t)
                    const {getAllWindows}=require('@tauri-apps/api/window')
                    const labels=(await getAllWindows()).map(w=>w.label)
                    window.tabby.get(core.HostAppService).newWindow()
                    const label=await until(async()=>(await getAllWindows()).map(w=>w.label).find(l=>!labels.includes(l)))
                    return {client:t.sshSession.ssh.client.handleId,label}
                `)
                let result
                for(let i=0;i<100;i++) {
                    try {
                        result=await evaluate(`
                            if(!window.tabby) return null
                            try {
                                await window.require('@tauri-apps/api/core').invoke('rdp_command',{target:{kind:'managed',client:${fixture.client},command:"printf forbidden"},input:'',timeoutMs:1000})
                                return 'accepted'
                            } catch(e) { return String(e) }
                        `,fixture.label)
                        if(result!==null) break
                    } catch { /* the second page is still booting */ }
                    await new Promise(resolve=>setTimeout(resolve,100))
                }
                if(result!=='SSH transport does not belong to this window') throw Error('cross-window transport guard: '+result)
                return true
            } finally {
                if(fixture) await evaluate(`const w=(await window.require('@tauri-apps/api/window').getAllWindows()).find(w=>w.label===${JSON.stringify(fixture.label)}); if(w) await w.close(); return true`).catch(()=>null)
                await evaluate(prelude+`const owned=window.__rdpCommandOwner;if(owned){window.tabby.get(core.ConfigService).store.ssh.verifyHostKeys=owned.previous;await zone.run(()=>app.closeTab(holder(owned.tab),false));delete window.__rdpCommandOwner;}return true`).catch(()=>null)
            }
        }],
        ['RDP command: measure complete managed SSH collection cost', async () => {
            const old = referenceSource('git', ['show', '0e4d0fa9fff51c1970e5347b2c2dce6bb9ad3b07:rdp-plugin/src/ssh.ts'], {encoding:'utf8'})
            const source = stripTypeScriptTypes(old.replace(/^import .*\n/gm,'').replaceAll('export ',''),{mode:'strip'}) + '\nreturn execRemote'
            const timing = await evaluate(prelude + `
                const rd=await until(()=>window.__remoteDesktop)
                const before=new Function('Buffer',${JSON.stringify(source)})(Buffer)
                const config=window.tabby.get(core.ConfigService), previous=config.store.ssh.verifyHostKeys
                config.store.ssh.verifyHostKeys=false
                let t
                try {
                    const opened=await zone.run(()=>window.tabby.get(core.ProfilesService).openNewTabForProfile(${JSON.stringify(profile)}))
                    t=opened.getAllTabs?opened.getAllTabs()[0]:opened
                    await ready(t)
                    const command="head -c 65536 /dev/zero | tr '\\\\000' x"
                    const old=[],current=[]
                    for(let batch=0;batch<3;batch++) {
                        let start=performance.now()
                        for(let n=0;n<5;n++) if((await before(t,command)).length!==65536) throw Error('old benchmark output incomplete')
                        old.push(performance.now()-start);start=performance.now()
                        for(let n=0;n<5;n++) if((await rd.execRemote(t,command)).length!==65536) throw Error('new benchmark output incomplete')
                        current.push(performance.now()-start)
                    }
                    return {commands:5,bytesPerCommand:65536,batches:3,beforeMs:old.sort((a,b)=>a-b)[1],afterMs:current.sort((a,b)=>a-b)[1]}
                } finally {
                    config.store.ssh.verifyHostKeys=previous
                    if(t) await zone.run(()=>app.closeTab(holder(t),false))
                }
            `)
            console.log('     RDP managed-command benchmark (loopback SSH, complete IPC and output): '+JSON.stringify(timing))
            return true
        }],
    ]
}
