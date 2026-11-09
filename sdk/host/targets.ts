import { remoteCommand } from './command'
import { Injectable } from '@angular/core'
import { invoke } from '@tauri-apps/api/core'
import { BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { probesIn } from './probe'
import { execRemote, sshClientHandle, isConnected, isSSHTab, pingRemote, SSHTab } from './ssh'
/** Streams the host can open; gateway negotiation belongs to the RDP component. */
export type Upstream =
    | { kind: 'tcp', host: string, port: number }
    | { kind: 'process', program: string, args: string[] }
    | { kind: 'sshTcp', client: number, host: string, port: number }
    | { kind: 'sshExec', client: number, command: string }
const shq = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
async function identity<T>(op: string, a: string, b: string, c?: string): Promise<T> {
    const result = await invoke<string>('ssh_target_identity', { request: { op, a: JSON.stringify(a), b: JSON.stringify(b), c: c === undefined ? undefined : JSON.stringify(c) } })
    return JSON.parse(result)
}
/** Tabby profile type of remote desktop tabs (see rdpProfile.ts). */
export const RDP_PROFILE_TYPE = 'rdp'

/** Somewhere a remote desktop can be reached: a remote account, plus how to talk to it. */
export interface RemoteTarget {
    /**
     * Canonical `user@hostname:port` (resolved with `ssh -G`); one desktop per key. DIRECT_KEY for a direct connection;
     * for a machine reached with ssh typed in an SSH tab, under that tab's key (see nestedKey).
     */
    key: string
    /** Short name for status messages, the on-screen display and menus: what the user calls it (a profile's name). */
    label: string
    /** The host's address or name, where the protocol wants one rather than a label (e.g. the RDP destination). */
    hostname?: string
    /** A stream to host:port as the remote sees it: its own 127.0.0.1, or a machine it can reach (a VM). */
    openTcp (host: string, port: number): Promise<Upstream>
    /** Runs a command on the remote with stdin, returns stdout. */
    exec (command: string, stdin: string): Promise<string>
    /** Whether the SSH connection is up now (false: wait for it before reconnecting). */
    isOpen (): boolean
    /** Asks the SSH connection to come back, where Tabby owns it. */
    reconnectSSH?: () => Promise<void>
    /** The Tabby SSH profile the connection was opened from (RDP profiles going through it are among its desktops). */
    profileId?: string
    /** Provenance for a system ssh process; this does not turn its local PTY into a managed SSH tab. */
    systemSSH?: SSHCommand
    processId?: number
    identity?: { host: string, user: string, port: number }
    /** A remote desktop tab's one desktop, connected to directly: no SSH host, no console, no desktop of its own. */
    direct?: any
    /** Round-trip time to the SSH server in ms, where it is cheap to measure (Tabby's own connection). */
    ping?: () => Promise<number>
    /** The SSH tab's host this is reached through, where it isn't that host itself (ssh typed in its console). */
    via?: string
}

/** A terminal pane the desktop can be layered over (an SSH tab, or a local terminal running `ssh`), or a remote desktop tab. */
export interface DesktopPane extends BaseTabComponent {
    element: { nativeElement: HTMLElement }
    frontend?: { focus (): void } | null
    profile?: { type?: string, name?: string, options?: { host?: string, user?: string, port?: number } }
    /** tabby-local session: getChildProcesses(): Promise<{ pid, ppid, command }[]> */
    session?: any
}

function isLocalTerminal (tab: BaseTabComponent | null | undefined): tab is DesktopPane {
    const t = tab as DesktopPane | null
    return t?.profile?.type === 'local' && !!t.element?.nativeElement && typeof t.session?.getChildProcesses === 'function'
}

/** A remote desktop tab (RDP profile, connecting directly): the desktop fills it, there is no terminal under it. */
export function isRDPTab (tab: BaseTabComponent | null | undefined): boolean {
    const t = tab as DesktopPane | null
    return t?.profile?.type === RDP_PROFILE_TYPE && !!t.element?.nativeElement
}

/** The pane a tab or tab-header action refers to: the pane itself, or a split's focused pane. */
export function desktopPaneOf (tab: BaseTabComponent | null | undefined): DesktopPane | null {
    const pane = tab instanceof SplitTabComponent ? tab.getFocusedTab() : tab
    return isSSHTab(pane) || isLocalTerminal(pane) || isRDPTab(pane) ? pane as DesktopPane : null
}

// ---- system ssh --------------------------------------------------------------------------------

export interface SSHCommand {
    /** Options for our own connections, derived from the user's. */
    options: string[]
    destination: string
}

/**
 * `user@hostname:port` as ssh itself resolves it (config aliases, defaults; see keyFromConfig), and the key the plugin
 * made of the same answer up to 0.5.0 (see RemoteTargets.keyChanged).
 */
async function resolveKey (options: string[], destination: string): Promise<ResolvedSSH> {
    const out = await invoke<string>('rdp_ssh_config', { options: options.map(String), destination: String(destination) }).catch(error => { throw new Error(String(error)) })
    const field = (name: string) => out.match(new RegExp(`^${name} (.+)$`, 'm'))?.[1]?.trim()
    return { key: await identity<string>('key_from_config', out, destination), former: await identity<string>('legacy_key', out, destination),
        identity: { host: field('hostname') ?? destination, user: field('user') ?? '', port: Number(field('port') ?? 22) } }
}

interface ResolvedSSH { key: string, former: string, identity: { host: string, user: string, port: number } }

/** A target reached with the system `ssh`, non-interactively (keys/agent/control master only). */
export class SystemSSHTarget implements RemoteTarget {
    constructor (readonly key: string, readonly label: string, readonly systemSSH: SSHCommand,
        readonly processId?: number, readonly identity?: ResolvedSSH['identity']) { }

    private args (...extra: string[]): string[] {
        const endpoint = this.identity ? [`-oHostName=${this.identity.host}`, `-oUser=${this.identity.user}`, `-oPort=${this.identity.port}`] : []
        return [...endpoint, ...this.systemSSH.options, '-o', 'BatchMode=yes', ...extra, this.systemSSH.destination]
    }

    async openTcp (host: string, port: number): Promise<Upstream> {
        return { kind: 'process', program: 'ssh', args: this.args('-o', 'ExitOnForwardFailure=yes', '-W', `${host.includes(':') ? `[${host}]` : host}:${port}`) }
    }

    // Each tunnel and command is its own ssh process.
    isOpen (): boolean { return true }

    async exec (command: string, stdin: string): Promise<string> {
        const result = await remoteCommand({ kind: 'system', args: [...this.args('-T'), command] }, stdin)
        if (result.code === 255) {
            throw new Error(sshFailure(this.label, result.stderr, result.code))
        }
        return result.output
    }
}

function sshFailure (label: string, stderr: string, code: number | null): string {
    // What the host said last (a refused channel's reason, its banner): as much of it as a host's error is shown
    // elsewhere.
    const last = (stderr.trim().split('\n').pop() ?? '').slice(0, 1000)
    if (/permission denied|password|keyboard-interactive/i.test(last)) {
        return `Couldn't open a second SSH connection to ${label} without a password. Use an SSH key or agent (or a ControlMaster), or open the host as a Tabby SSH profile.`
    }
    return `ssh to ${label} failed${last ? `: ${last}` : ` (exit ${code})`}`
}

// ---- Tabby SSH tabs ----------------------------------------------------------------------------

class TabbySSHTarget implements RemoteTarget {
    constructor (readonly key: string, readonly label: string, private tab: SSHTab, readonly hostname?: string) { }
    async openTcp (host: string, port: number): Promise<Upstream> { return { kind: 'sshTcp', client: sshClientHandle(this.tab), host, port } }
    exec (command: string, stdin: string): Promise<string> { return execRemote(this.tab, command, stdin) }
    isOpen (): boolean { return isConnected(this.tab) }
    ping (): Promise<number> { return pingRemote(this.tab) }
    async execStream (command: string): Promise<Upstream> { return { kind: 'sshExec', client: sshClientHandle(this.tab), command } }
    get reconnectSSH (): (() => Promise<void>) | undefined {
        return typeof this.tab.reconnect === 'function' ? () => this.tab.reconnect!() : undefined
    }
    get profileId (): string | undefined { return (this.tab.profile as { id?: string } | undefined)?.id }
}

// ---- ssh typed in an SSH tab ---------------------------------------------------------------------

/** An `ssh` running in the foreground of a terminal on an SSH tab's host (typed at its prompt). */
export interface NestedSSH {
    cmd: SSHCommand
    /** Its terminal there. */
    tty: string
}

/**
 * Remote script: the user's `ssh` clients in the foreground of a terminal, one `TRD_SSH <n>|<tty>|<args>` line each, the
 * arguments separated by \037 (from /proc where there is one, so that quoted ones stay whole). Each one's terminal gets a
 * probe, `$PROBE-<n>` (see probe.ts), which shows which Tabby pane that terminal is.
 */
const nestedSSHScript = (probe: string) => `PROBE=${shq(probe)}\n` + String.raw`
n=0
for p in $(pgrep -u "$(id -u)" -x ssh 2>/dev/null); do
    set -- $(ps -o tty= -o stat= -p "$p" 2>/dev/null)
    case "$1:$2" in ?*:*+*) ;; *) continue ;; esac
    [ "$1" = "?" ] && continue
    n=$((n + 1))
    if [ -r "/proc/$p/cmdline" ]; then args=$(tr '\000' '\037' < "/proc/$p/cmdline"); else args=$(ps -o args= -p "$p" | tr ' ' '\037'); fi
    printf 'TRD_SSH %s|%s|%s\n' "$n" "$1" "$args"
    printf '\033]7777;probe;%s-%s\007' "$PROBE" "$n" > "/dev/$1" 2>/dev/null || true
done
`

const HOP = '\n__trd_hop '

/**
 * A command's output through the host's ssh, and how that ssh ended: the line NestedSSHTarget.exec adds at the end,
 * `__trd_hop <exit status> <ssh's last line of errors>`. Found from the end and taken apart by hand, not with a pattern
 * whose parts can take the same characters, which a long last line of the host's making could make cost the square of
 * its length. The error keeps any CR in it (OpenSSH ends its messages with CR LF). Null without that line.
 */
function hopResult (out: string): { output: string, status: string, error: string } | null {
    const at = out.lastIndexOf(HOP)
    if (at < 0) {
        return null
    }
    let line = out.slice(at + HOP.length)
    if (line.endsWith('\n')) {
        line = line.slice(0, -1)
    }
    const space = line.indexOf(' ')
    const status = space < 0 ? line : line.slice(0, space)
    if (!/^\d+$/.test(status) || line.includes('\n')) {
        return null
    }
    return { output: out.slice(0, at), status, error: space < 0 ? '' : line.slice(space + 1) }
}

/**
 * A machine reached from an SSH tab's host with the `ssh` typed there: each command and tunnel runs that host's own
 * ssh, non-interactively (its keys, or a forwarded agent). Like SystemSSHTarget, one hop further.
 */
class NestedSSHTarget implements RemoteTarget {
    constructor (readonly key: string, readonly label: string, private outer: TabbySSHTarget, private cmd: SSHCommand) { }

    get via (): string { return this.outer.label }

    private ssh (...extra: string[]): string {
        return ['ssh', ...this.cmd.options, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...extra, this.cmd.destination].map(shq).join(' ')
    }

    openTcp (host: string, port: number): Promise<Upstream> {
        return this.outer.execStream(`exec ${this.ssh('-o', 'ExitOnForwardFailure=yes', '-W', `${host.includes(':') ? `[${host}]` : host}:${port}`)} 2>/dev/null`)
    }

    async exec (command: string, stdin: string): Promise<string> {
        // ssh's exit status and last error line come after the output, so a failed login says why.
        const out = await this.outer.exec(`e=$(mktemp); ${this.ssh('-T')} ${shq(command)} 2>"$e"; r=$?; ` +
            `printf '\n__trd_hop %s %s\n' "$r" "$(tail -n 1 "$e")"; rm -f "$e"`, stdin)
        const hop = hopResult(out)
        if (hop?.status === '255') {
            // The host's ssh's words, as long as it likes: as much as a status line shows.
            const why = hop.error.trim().slice(0, 1000)
            throw new Error(/permission denied|password|keyboard-interactive|host key/i.test(why)
                ? `${this.outer.label} couldn't log in to ${this.label} by itself (${why}). The desktop goes through ${this.outer.label}'s own ssh, which needs a key for ${this.label} there, or agent forwarding.`
                : `ssh from ${this.outer.label} to ${this.label} failed${why ? `: ${why}` : ''}`)
        }
        return hop ? hop.output : out
    }

    isOpen (): boolean { return this.outer.isOpen() }
    ping (): Promise<number> { return this.outer.ping() }
}

// ---- detection ---------------------------------------------------------------------------------

/**
 * Works out which remote a pane is logged into. SSH tabs: their profile. Local terminals: an `ssh`
 * process running under the shell. Results are cached so the header can be updated synchronously.
 */
@Injectable({ providedIn: 'root' })
export class RemoteTargets {
    private cache = new WeakMap<DesktopPane, { target: RemoteTarget | null, pid?: number }>()
    private keys = new Map<string, Promise<ResolvedSSH>>()

    protected profileTarget (_pane: DesktopPane): RemoteTarget | null | undefined { return undefined }
    protected keyChanged (_from: string, _to: string): void { }

    /** Last known target of a pane (undefined: not looked up yet). */
    cached (pane: DesktopPane): RemoteTarget | null | undefined {
        return this.cache.get(pane)?.target
    }

    async targetOf (pane: DesktopPane): Promise<RemoteTarget | null> {
        let target: RemoteTarget | null = null
        let pid: number | undefined
        try {
            const supplied = this.profileTarget(pane)
            if (supplied !== undefined) {
                target = supplied
            } else if (isSSHTab(pane)) {
                const o = pane.profile?.options ?? {}
                const known = this.cache.get(pane)?.target
                // Named as its profile is (Tabby's imports end in "(.ssh/config)"), else by its address.
                const named = (pane.profile?.name ?? '').replace(/\s*\(\.ssh\/config\)$/, '').trim()
                target = known ?? new TabbySSHTarget(
                    await this.key(['-l', o.user ?? '', '-p', String(o.port ?? 22)], o.host ?? ''),
                    named || o.host || 'remote', pane, o.host || undefined)
            } else {
                const found = await this.localSSH(pane)
                pid = found?.pid
                const known = this.cache.get(pane)
                if (found && known?.target && known.pid === found.pid) {
                    target = known.target
                } else if (found) {
                    const resolved = await this.resolve(found.cmd.options, found.cmd.destination)
                    target = new SystemSSHTarget(resolved.key, found.cmd.destination, found.cmd, found.pid, resolved.identity)
                }
            }
        } catch {
            target = null
        }
        this.cache.set(pane, { target, pid })
        return target
    }

    /**
     * `ssh` clients typed at a prompt in this pane, on its SSH tab's host: only those whose terminal there is this pane's
     * (see probe.ts), since other panes and tabs can be on the same host. Empty elsewhere.
     */
    async nestedSSH (pane: DesktopPane): Promise<NestedSSH[]> {
        const outer = await this.targetOf(pane)
        if (!(outer instanceof TabbySSHTarget)) {
            return []
        }
        const probe = `trd${Math.random().toString(36).slice(2, 10)}`
        const { result: out, ids } = await probesIn(pane, probe, () => outer.exec('sh -s', nestedSSHScript(probe)))
        return invoke<NestedSSH[]>('rdp_nested_ssh', { output: out, probe, ids: [...ids] })
    }

    /**
     * A target for an `ssh` found by nestedSSH(), going through the pane's SSH connection. Its key is under the pane's
     * (see nestedKey): what the host there says about the machine, `ssh -G` included, is only that host's word.
     */
    async nestedTarget (pane: DesktopPane, nested: NestedSSH): Promise<RemoteTarget | null> {
        const outer = await this.targetOf(pane)
        if (!(outer instanceof TabbySSHTarget)) {
            return null
        }
        const config = await outer.exec(`${['ssh', ...nested.cmd.options, '-G', nested.cmd.destination].map(shq).join(' ')} 2>/dev/null`, '')
        return new NestedSSHTarget(await identity<string>('nested_key', outer.key, config, nested.cmd.destination), nested.cmd.destination, outer, nested.cmd)
    }

    private async key (options: string[], destination: string): Promise<string> {
        return (await this.resolve(options, destination)).key
    }

    /** Resolve configured aliases without opening a connection. Used for exact profile association. */
    resolve (options: string[], destination: string): Promise<ResolvedSSH> {
        const id = JSON.stringify([options, destination])
        let key = this.keys.get(id)
        if (!key) {
            key = resolveKey(options, destination).then(resolved => {
                this.keyChanged(resolved.former, resolved.key)
                return resolved
            })
            key.catch(() => this.keys.delete(id))
            this.keys.set(id, key)
        }
        return key
    }

    /**
     * The nearest `ssh` client running in the pane: a descendant of the terminal's own process.
     *
     * Found from one `ps` snapshot of the process tree rather than Tabby's child-process list: that list
     * starts from a "true PID" Tabby picks by following the shell's only child a couple of seconds after
     * start, which can be a short-lived helper (prompt/plugin startup) that is gone by the time you type
     * `ssh`, leaving the list empty for good.
     */
    private async localSSH (pane: DesktopPane): Promise<{ pid: number, cmd: SSHCommand } | null> {
        if (process.platform === 'win32') {
            return null
        }
        const root: number | undefined = await pane.session.pty?.getPID?.().catch(() => undefined)
        if (!root) {
            return null
        }
        return invoke('rdp_local_ssh', { root, observedAtMs: Date.now() })
    }
}
