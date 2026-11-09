/**
 * A desktop's diagnostic log file (Settings › Remote Desktop › Settings › Diagnostics): what the connection does, from
 * the plugin and from IronRDP at its debug or trace level, for a bug report. One file per desktop opened while the
 * setting is on, named after the time and the desktop, in a folder of the user's own, readable by the user alone
 * (mode 600 in a 700 folder; on Windows, the roaming profile's own permissions).
 *
 * What is written is washed first (see `washed`): IronRDP's licensing and security PDUs print their keying material
 * as its length only (its patch 56), and anything that still looks like a key, a token or a blob of bytes is replaced
 * with its length here too, so a trace a user hands over carries the shape of the exchange and not its secrets.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export type DiagnosticLevel = 'off' | 'debug' | 'trace'

export const DIAGNOSTIC_LEVELS: DiagnosticLevel[] = ['off', 'debug', 'trace']

export function diagnosticLevel (value: unknown): DiagnosticLevel {
    return value === 'debug' || value === 'trace' ? value : 'off'
}

/** Where the files go: next to Tabby's config (its own, per-user folder), or in the home folder without one. */
export function logDirectory (configPath: string | null | undefined): string {
    return configPath ? path.join(path.dirname(configPath), 'tabby-rdp-logs') : path.join(os.homedir(), '.tabby-rdp-logs')
}

/**
 * Makes the folder, the user's alone. Paddy's fs makes a folder without the mode asked for (its default, which others
 * can list), so the mode is set after.
 */
export async function makeLogDirectory (dir: string): Promise<void> {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.promises.chmod(dir, 0o700)
}

/** The longest a line is kept (a PDU printed whole can run to megabytes). */
export const MAX_LINE = 4096
/** The most a file takes; past it, a last line says so and the rest is dropped. */
export const MAX_BYTES = 32 * 1024 * 1024

/**
 * `line` with what could be a secret taken out: a list of bytes as Rust prints one (`[12, 34, …]`, eight or more),
 * a run of 32 or more hex digits (a key, a token, a fingerprint), and the proxy's token where one is given. Each is
 * replaced with its length, so that the shape of what was logged stays.
 */
export function washed (line: string, token?: string | null): string {
    if (token) {
        line = line.split(token).join('<token withheld>')
    }
    line = line.replace(/\[\s*(?:\d{1,3}\s*,\s*){7,}\d{1,3}\s*,?\s*\]/g, list => `<${(list.match(/\d{1,3}/g) ?? []).length} bytes withheld>`)
    line = line.replace(/\b[0-9A-Fa-f]{32,}\b/g, hex => `<${hex.length} hex digits withheld>`)
    return line
}

/** What the log file is named: the moment it was opened and the desktop, as a file name can have them. */
export function logFileName (name: string, at = new Date()): string {
    const stamp = at.toISOString().replace(/\.\d+Z$/, '').replace('T', '_').replace(/:/g, '-')
    const safe = name.replace(/[^\p{L}\p{N}._@-]+/gu, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 60) || 'desktop'
    return `tabby-rdp_${stamp}_${safe}.log`
}

export class DiagnosticLog {
    readonly file: string
    private handle: Promise<fs.promises.FileHandle | null>
    private tail: Promise<void> = Promise.resolve()
    /** Lines not yet written, which go in one write (see line). */
    private pending = ''
    private written = 0
    private full = false
    private closed = false
    /** Why the file couldn't be opened, if it couldn't. */
    failure: string | null = null

    constructor (dir: string, name: string, readonly level: Exclude<DiagnosticLevel, 'off'>, private token: () => string | null | undefined = () => null, header: string[] = []) {
        this.file = path.join(dir, logFileName(name))
        this.handle = makeLogDirectory(dir)
            .then(() => fs.promises.open(this.file, 'a', 0o600))
            .catch((error: any) => {
                this.failure = error?.message ?? String(error)
                return null
            })
        this.line('log', `tabby-rdp diagnostic log, level ${level}: ${name}`)
        for (const text of header) {
            this.line('log', text)
        }
        this.line('log', 'Keys, passwords, licenses, tokens and other byte strings are left out of this file (shown as their length).')
    }

    /** Writes a line as `<time> <source> <text>`, washed and cut; from the plugin (`source` 'plugin') or IronRDP. */
    line (source: string, text: string): void {
        if (this.closed || this.full) {
            return
        }
        const cut = text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}… (${text.length - MAX_LINE} characters more)` : text
        const entry = `${new Date().toISOString()} ${source} ${washed(cut, this.token())}\n`
        this.written += entry.length
        let out = entry
        if (this.written > MAX_BYTES) {
            this.full = true
            out = `${new Date().toISOString()} log The log has reached ${MAX_BYTES / 1024 / 1024} MB; nothing more is written.\n`
        }
        // The lines that come while a write is under way go together in the next one: each write is a call to the
        // app's native side in Paddy, which a trace's thousands of lines a second would queue up behind one by one.
        const first = !this.pending
        this.pending += out
        if (first) {
            this.tail = this.tail.then(async () => {
                const handle = await this.handle
                const text = this.pending
                this.pending = ''
                await handle?.appendFile(text)
            }).catch(() => undefined)
        }
    }

    /** Writes what is queued and closes the file. */
    close (): Promise<void> {
        if (this.closed) {
            return this.tail
        }
        this.closed = true
        this.tail = this.tail.then(async () => {
            const handle = await this.handle
            await handle?.close()
        }).catch(() => undefined)
        return this.tail
    }
}
