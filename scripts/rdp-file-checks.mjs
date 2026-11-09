import {referenceSource} from './reference-source.mjs'
// Exercise the production parser through Tauri and import confirmation in an isolated app instance.
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'

export function rdpFileBenchmark ({ evaluate, prelude }) {
    return [['RDP file: measure parser and native IPC cost', async () => {
        const original = referenceSource('git', ['show', '0e4d0fa9fff51c1970e5347b2c2dce6bb9ad3b07:rdp-plugin/src/rdpFile.ts'], { encoding: 'utf8' })
        const source = stripTypeScriptTypes(original.replaceAll('export ', ''), { mode: 'strip' }) + '\nreturn parseRdpFile'
        const result = await evaluate(prelude + `
            const rd = await until(() => window.__remoteDesktop)
            const before = new Function(${JSON.stringify(source)})()
            const normal = Buffer.from('full address:s:desktop.example\\nusername:s:alice\\ndomain:s:EXAMPLE\\nredirectclipboard:i:0\\ndesktopscalefactor:i:150\\n')
            const prefix = Buffer.from('full address:s:desktop\\n')
            const limit = Buffer.concat([prefix, Buffer.alloc(1048576-prefix.length,32)])
            const results = []
            for (const [name,bytes,count] of [['normal',normal,100],['limit',limit,5]]) {
                const old = [], current = []
                for(let batch=0;batch<5;batch++) {
                    let start=performance.now()
                    for(let i=0;i<count;i++) if(!before(bytes)) throw Error('old benchmark fixture failed')
                    old.push(performance.now()-start)
                    start=performance.now()
                    for(let i=0;i<count;i++) if(!await rd.parseRdpFile(bytes)) throw Error('new benchmark fixture failed')
                    current.push(performance.now()-start)
                }
                results.push({name,bytes:bytes.length,count,beforeMs:old.sort((a,b)=>a-b)[2],afterMs:current.sort((a,b)=>a-b)[2]})
            }
            return results
        `)
        console.log('     RDP file benchmark (five-batch medians, full native IPC, no dialog or file I/O): ' + JSON.stringify(result))
        return true
    }]]
}

export default [
    ['RDP file: native parsing preserves encodings, clipboard restrictions, and size boundaries', `
        const rd = await until(() => window.__remoteDesktop)
        const { invoke } = require('@tauri-apps/api/core')
        const source = 'full address:s:[::1]:3390\\r\\nusername:s:alice\\r\\ndomain:s:EXAMPLE\\r\\nredirectclipboard:i:-00\\r\\nredirectclipboard:i:1\\r\\ndesktopscalefactor:i:150\\r\\n'
        const le = Buffer.from(source, 'utf16le')
        const be = Buffer.from(le); be.swap16()
        const expected = {host:'::1', port:3390, username:'alice', domain:'EXAMPLE', sharpness:'retina', clipboard:'off', ignored:[]}
        const normalized = v => JSON.stringify(Object.fromEntries(Object.entries(v).sort()))
        for (const bytes of [Buffer.from(source), le, Buffer.concat([Buffer.from([255,254]), le]), Buffer.concat([Buffer.from([254,255]), be])]) {
            if (normalized(await rd.parseRdpFile(bytes)) !== normalized(expected)) throw Error('native encoding result differs')
        }
        const lone = Buffer.concat([Buffer.from([255,254]), Buffer.from('full address:s:desktop\\nusername:s:A\\ud800B\\ud801', 'utf16le')])
        if ((await rd.parseRdpFile(lone)).username !== 'A\\ud800B\\ud801') throw Error('UTF16 identity lost')
        const padded = Buffer.from('xxfull address:s:desktopzz')
        if ((await rd.parseRdpFile(padded.subarray(2,padded.length-2))).host !== 'desktop') throw Error('byte offset lost')
        let rejected = false
        try { await rd.parseRdpFile(Uint8Array.from([254,255,0])) } catch (e) { rejected = e.message.includes('16-bits') }
        if (!rejected) throw Error('odd big-endian file accepted')
        const prefix = Buffer.from('full address:s:desktop\\n')
        const maximum = Buffer.concat([prefix, Buffer.alloc(1048576-prefix.length,32)])
        if ((await rd.parseRdpFile(maximum)).host !== 'desktop') throw Error('inclusive size limit rejected')
        rejected = false
        try { await invoke('rdp_file_parse', new Uint8Array(1048577)) } catch (e) { rejected = String(e).includes('1 MiB') }
        if (!rejected) throw Error('native limit not enforced')
        rejected = false
        try { await invoke('rdp_file_parse', {bytes:[1,2,3]}) } catch (e) { rejected = String(e).includes('Expected RDP file bytes') }
        if (!rejected) throw Error('nonbinary request accepted')
        if ((await rd.parseRdpFile(Buffer.from('full address:s:recovered'))).host !== 'recovered') throw Error('parser failed after rejected input')
        return true
    `],
    ['RDP file: asynchronous import reaches confirmation and Add only creates a restricted profile without connecting', `
        const rd = await until(() => window.__remoteDesktop)
        const desktop = rd.desktop
        const platform = desktop.platform, profiles = desktop.profiles
        const savedMessage = platform.showMessageBox, savedOpen = profiles.openNewTabForProfile
        const beforeProfiles = [...(desktop.config.store.profiles ?? [])]
        let confirmations = [], opens = 0, response = 2
        platform.showMessageBox = async options => { confirmations.push(options); return {response} }
        profiles.openNewTabForProfile = async () => { opens++; throw Error('synthetic import tried connecting') }
        const source = Buffer.from('full address:s:rust-rdp-import.invalid:3390\\nusername:s:alice\\ndomain:s:EXAMPLE\\ngatewayhostname:s:rust-rdp-gateway.invalid\\nredirectclipboard:i:00\\nredirectclipboard:i:1\\n')
        try {
            if (await desktop.importRdp(source, 'synthetic.rdp') !== null) throw Error('cancelled import created a profile')
            if (confirmations.length !== 1 || !confirmations[0].detail.includes('rust-rdp-import.invalid:3390') || !confirmations[0].detail.includes('rust-rdp-gateway.invalid') || !confirmations[0].detail.includes('clipboard off')) throw Error('confirmation lost parsed details')
            response = 1
            const result = await desktop.importRdp(source, 'synthetic.rdp')
            if (!result || result.options.host !== 'rust-rdp-import.invalid' || result.options.port !== 3390 || result.options.username !== 'alice' || result.options.domain !== 'EXAMPLE' || result.options.clipboard !== 'off' || result.options.account !== null || result.options.gatewayAccount !== null) throw Error('Add only lost imported settings or credential restrictions')
            if (opens || confirmations.length !== 2) throw Error('confirmation/connection ordering changed')
            return true
        } finally {
            platform.showMessageBox = savedMessage
            profiles.openNewTabForProfile = savedOpen
            desktop.config.store.profiles = beforeProfiles
            desktop.config.save()
        }
    `],
]
