import { invoke } from '@tauri-apps/api/core'

/**
 * .rdp files (Remote Desktop Connection's format): one `key:type:value` setting per line, type `s` (string), `i`
 * (integer) or `b` (binary). Where to connect and as whom is taken, and the few settings the plugin keeps per desktop;
 * the rest is either the plugin's own business (settings that apply to every desktop) or not supported, and the
 * import says which of those the file asked for.
 */
export interface RdpFile {
    host: string
    port: number
    username?: string
    domain?: string
    /** `desktopscalefactor` of 150 or more: the desktop wants a high-DPI scale, which is this plugin's Retina sharpness. */
    sharpness?: 'retina' | 'standard'
    /** The RD Gateway the file connects through (`gatewayhostname`, unless `gatewayusagemethod` turns it off). */
    gateway?: string
    /**
     * `redirectclipboard:i:0` (0 in decimal digits, however many, with or without a sign: `00`, `+0`, `-0`; on any of
     * its lines): the clipboard off for this desktop (the profile's own clipboard sharing). A file never turns it on:
     * `redirectclipboard:i:1` is mstsc's default, and leaves the setting to say.
     */
    clipboard?: 'off'
    /** Settings the file carries that the plugin doesn't apply, in words, for the import's note. */
    ignored: string[]
}

/**
 * The note for a file that asks for the microphone: not applied while the setting is off. With it on, every desktop
 * gets the microphone, and the import says so instead (see RemoteDesktopService.importRdp).
 */
export const MICROPHONE_NOTE = 'the microphone (Settings › Remote Desktop › Microphone)'

/** The file picker and native parser independently enforce the same inclusive 1 MiB limit. */
export const MAX_RDP_FILE = 1024 * 1024

type NativeRdpFile = Omit<RdpFile, 'host' | 'username' | 'domain' | 'gateway' | 'ignored'> & {
    host: number[]
    username?: number[]
    domain?: number[]
    gateway?: number[]
    ignored: number[][]
}

/** Code units preserve malformed UTF-16 file names without replacing distinct surrogates during JSON IPC. */
function text (units: number[]): string {
    let result = ''
    for (let offset = 0; offset < units.length; offset += 4096) {
        result += String.fromCharCode(...units.slice(offset, offset + 4096))
    }
    return result
}

/** The supported import settings, decoded and checked by the portable native Rust library. */
export async function parseRdpFile (data: Uint8Array): Promise<RdpFile | null> {
    if (data.length > MAX_RDP_FILE) { throw new Error('RDP file exceeds 1 MiB') }
    let parsed: NativeRdpFile | null
    try {
        parsed = await invoke<NativeRdpFile | null>('rdp_file_parse', data)
    } catch (error) {
        throw error instanceof Error ? error : new Error(String(error))
    }
    if (!parsed) { return null }
    const { host, username, domain, gateway, ignored, ...options } = parsed
    return {
        ...options,
        host: text(host),
        ...username ? { username: text(username) } : {},
        ...domain ? { domain: text(domain) } : {},
        ...gateway ? { gateway: text(gateway) } : {},
        ignored: ignored.map(text),
    }
}
