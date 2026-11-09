import {referenceSource} from './reference-source.mjs'
// Compare actual pre-port TypeScript with the current facade and compiled Rust parser.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const binary = process.argv[2]
if (!binary) throw Error('usage: node scripts/rdp-file-core.check.mjs <parse example binary>')
const base = '0e4d0fa9fff51c1970e5347b2c2dce6bb9ad3b07'
const original = referenceSource('git', ['show', `${base}:rdp-plugin/src/rdpFile.ts`], { cwd: root, encoding: 'utf8' })
const current = fs.readFileSync(path.join(root, 'rdp-plugin/src/rdpFile.ts'), 'utf8')
const child = spawn(path.resolve(binary), [], { stdio: ['pipe', 'pipe', 'inherit'] })
const pending = []
createInterface({ input: child.stdout }).on('line', line => pending.shift()?.resolve(JSON.parse(line)))
child.on('error', error => { for (const p of pending.splice(0)) p.reject(error) })
child.on('exit', code => { for (const p of pending.splice(0)) p.reject(Error(`parser exited ${code}`)) })
async function invoke(command, bytes) {
    assert.equal(command, 'rdp_file_parse')
    assert.ok(bytes instanceof Uint8Array)
    const response = await new Promise((resolve, reject) => {
        pending.push({ resolve, reject })
        child.stdin.write(JSON.stringify([...bytes]) + '\n')
    })
    if (response.error) throw response.error
    return response.ok
}
function load(source, invoke) {
    const code = stripTypeScriptTypes(source.replace(/^import .*\n/gm, '').replaceAll('export ', ''), { mode: 'strip' })
    return new Function('invoke', `${code}\nreturn {parseRdpFile, MAX_RDP_FILE, MICROPHONE_NOTE}`)(invoke)
}
const before = load(original), after = load(current, invoke)
assert.equal(before.MAX_RDP_FILE, after.MAX_RDP_FILE)
assert.equal(before.MICROPHONE_NOTE, after.MICROPHONE_NOTE)
let observations = 0
async function outcome(fn, data) {
    try { return { ok: await fn(data) } } catch (e) { return { error: e.message } }
}
async function compare(data, label = '') {
    const a = await outcome(after.parseRdpFile, data), b = await outcome(before.parseRdpFile, data)
    assert.deepEqual(a, b, `${label}: ${Buffer.from(data).toString('hex').slice(0, 180)}`)
    observations++
}
function encoded(text) {
    const le = Buffer.from(text, 'utf16le')
    return [Buffer.from(text), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]), le,
        Buffer.concat([Buffer.from([0xff, 0xfe]), le]), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(le).swap16()])]
}
async function file(text) { for (const bytes of encoded(text)) await compare(bytes) }
try {
    await file('full address:s:desktop.example\r\nusername:s:alice\r\ndomain:s:EXAMPLE\r\ndesktopscalefactor:i:150\r\nredirectclipboard:i:0\r\n')
    const independent = await after.parseRdpFile(Buffer.from('full address:s:[::1]:3390\nserver port:i:0\nredirectclipboard:i:0\nredirectclipboard:i:1\n'))
    assert.deepEqual(independent, { host: '::1', port: 3390, clipboard: 'off', ignored: [] })
    const hosts = ['', 'desktop', 'desktop:3390', '[::1]:3390', '::1', '::', 'a:b:c', '[odd host]', '[x]', '[]', '[x][y]',
        'host#other', '[::1]#other', 'host:0', 'host:65535', 'host:65536', 'host:+3389', 'host:3e3', 'host:1.5',
        'with space', 'host\0', 'host\u0085', 'host\u200b', '例え.テスト', '\ud800', '\ud801', 'a😀', 'a\udfff', '[]:3389']
    for (const host of hosts) await file(`full address:s:${host}\nusername:s:A\ud800B\ud801\ndomain:s:\udfff\n`)
    const numbers = ['', '0', '00', '+0', '-000', '-0.0', '0.0', '0e0', '1', '99', '100', '149.99999999999999', '150', '151',
        '65535', '65535.000000000001', '65536', '3389', '+3389', '3.389e3', '0xd3d', '0XD3D', '0b110100111101', '0o6475',
        '-0xd3d', '0x_d3d', '3_389', '0b', '0o', '0x', 'Infinity', 'infinity', '+inf', '-Infinity', 'NaN', '.5', '1.', '1.e2',
        '1e309', '1e-9999', '0x' + 'f'.repeat(256), '0x' + 'f'.repeat(257), '\u00a03389\ufeff', '3\u00859', '３３８９']
    for (const n of numbers) for (const key of ['server port', 'desktopscalefactor', 'redirectclipboard']) {
        await file(`full address:s:desktop\n${key}:i:${n}\n`)
        if (key === 'redirectclipboard') await file(`full address:s:desktop\n${key}:i:${n}\n${key}:i:1\n`)
    }
    const notes = ['audiomode', 'audiocapturemode', 'redirectdrives', 'drivestoredirect', 'redirectprinters', 'redirectsmartcards',
        'redirectcomports', 'usbdevicestoredirect', 'use multimon', 'screen mode id', 'gatewayhostname', 'promptcredentialonce',
        'gatewaycredentialssource', 'remoteapplicationmode', 'alternate shell', 'enablecredsspsupport', '__proto__', 'constructor', 'prototype']
    for (const v of ['', '0', '1', '2', '4', '5', '*', '00', '01', 'value\ud800']) {
        for (const method of ['', '0', '1', '4', '00']) {
            await file(`full address:s:desktop\ngatewayhostname:s:gw\ngatewayusagemethod:i:${method}\ndesktopwidth:i:123\ndesktopheight:i:\n` + notes.map(k => `${k}:s:${v}`).join('\n'))
        }
    }
    const whitespace = ['\t', '\v', '\f', '\r', '\n', ' ', '\u00a0', '\u1680', '\u2000', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff', '\u0085', '\u180e', '\u200b']
    for (const w of whitespace) for (const line of [`${w}FULL ADDRESS${w}:${w}S${w}:desktop`, `full address:s:${w}desktop${w}`, `full address:s:desk${w}top`, `full address:s:desktop\nusername:s:name${w}`]) await file(line)
    for (const ending of ['', '\n', '\r', '\r\n', '\r\r\n', '\u2028', '\u2029']) await file('full address:s:desktop' + ending)
    for (const bytes of [[], [0xff], [0xfe], [0xef, 0xbb], [0xfe, 0xff, 0], [0xff, 0xfe, 0]]) await compare(Uint8Array.from(bytes))
    let seed = 0x19ab381
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
    const choose = list => list[random() % list.length]
    for (let n = 0; n < 1600; n++) {
        let lines = [`full address:s:${choose(hosts)}`]
        for (let j = 0; j < 1 + n % 15; j++) {
            const key = choose([...notes, 'full address', 'username', 'domain', 'server port', 'desktopscalefactor', 'redirectclipboard', 'gatewayusagemethod', 'desktopwidth', 'desktopheight'])
            lines.push(`${random() % 3 ? key : key.toUpperCase()}:${choose(['s', 'i', 'b', 'S', 'x', ' i ', '\tB\t'])}:${choose([...numbers, ...hosts])}`)
        }
        if (n % 7 === 0) lines.reverse()
        const formats = encoded(lines.join(choose(['\n', '\r\n', '\r', '\n\n'])))
        await compare(formats[n % formats.length], `generated ${n}`)
    }
    for (let n = 0; n < 2200; n++) {
        const suffix = Uint8Array.from({ length: random() % 100 }, () => random() >>> 24)
        const bytes = Buffer.concat([Buffer.from('full address:s:desktop\nusername:s:'), suffix])
        await compare(bytes, `malformed UTF8 ${n}`)
        if (n < 200) for (const bom of [[0xff, 0xfe], [0xfe, 0xff]]) await compare(Buffer.concat([Buffer.from(bom), Buffer.from('full address:s:desktop\nusername:s:', 'utf16le'), suffix]), `UTF16 ${n}`)
    }
    // Subarray offsets must not send or parse the bytes on either side.
    const padded = Buffer.from('xxfull address:s:desktopzz')
    await compare(padded.subarray(2, padded.length - 2), 'subarray')
    const prefix = Buffer.from('full address:s:desktop\n')
    for (const fill of [' ', 'x', '\n']) await compare(Buffer.concat([prefix, Buffer.alloc(after.MAX_RDP_FILE - prefix.length, fill)]), `inclusive limit ${fill}`)
    for (const key of ['username', 'full address', 'server port', 'desktopscalefactor']) {
        const start = Buffer.from(`full address:s:desktop\n${key}:s:`)
        await compare(Buffer.concat([start, Buffer.alloc(after.MAX_RDP_FILE - start.length, key === 'server port' || key === 'desktopscalefactor' ? '0' : 'x')]), `maximum ${key}`)
    }
    const over = Buffer.alloc(after.MAX_RDP_FILE + 1)
    assert.deepEqual(await outcome(after.parseRdpFile, over), { error: 'RDP file exceeds 1 MiB' })
    await assert.rejects(invoke('rdp_file_parse', over), error => error === 'RDP file exceeds 1 MiB')
    await compare(Buffer.from('full address:s:recovered'), 'after errors')
    console.log(`${observations} actual TypeScript import outcomes match; independent address/clipboard and inclusive/over-limit checks passed`)
} finally {
    child.stdin.end()
}
