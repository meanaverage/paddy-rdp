import { remoteCommand } from './command'
import { BaseTabComponent } from 'tabby-core'
import { Duplex } from 'stream'
import { SSHChannelStream } from './sshChannelStream'

/** An SSH terminal tab (tabby-ssh), duck-typed so this plugin doesn't import tabby-ssh. */
export interface SSHTab extends BaseTabComponent {
    sshSession?: { ssh?: any, open?: boolean, willDestroy$?: { subscribe (o: (() => void) | { next?: () => void, complete?: () => void }): { unsubscribe (): void } } } | null
    /** Reconnects the tab's SSH session (tabby-ssh). */
    reconnect?: () => Promise<void>
    profile?: { type?: string, name?: string, options?: { host?: string, user?: string, port?: number } }
    element: { nativeElement: HTMLElement }
    frontend?: { focus (): void } | null
}

export function isSSHTab (tab: BaseTabComponent | null | undefined): tab is SSHTab {
    // The profile is set when the tab is created; sshSession only once it connects.
    return (tab as SSHTab | null)?.profile?.type === 'ssh' && !!(tab as SSHTab).element?.nativeElement
}

// SSH sessions Tabby has torn down. They still say `open` afterwards, and the tab keeps them until it reconnects.
const destroyed = new WeakSet<object>()
const watched = new WeakSet<object>()

/** Whether the tab's SSH connection is up (not closed, not torn down). */
export function isConnected (tab: SSHTab): boolean {
    const session = tab.sshSession
    if (!session) {
        return false
    }
    if (!watched.has(session)) {
        watched.add(session)
        // willDestroy$ completes after it fires, so subscribing late still reports it.
        const mark = () => destroyed.add(session)
        session.willDestroy$?.subscribe({ next: mark, complete: mark })
    }
    return !!session.open && !destroyed.has(session)
}

function client (tab: SSHTab): any {
    const ssh = tab.sshSession?.ssh
    if (!isConnected(tab) || typeof ssh?.openTCPForwardChannel !== 'function') {
        throw new Error('The SSH connection is not open')
    }
    return ssh
}

/** A direct-tcpip channel to host:port as the remote sees it (e.g. its own 127.0.0.1), as a Node stream. */
export async function openTcpStream (tab: SSHTab, host: string, port: number): Promise<Duplex> {
    const ssh = client(tab)
    const session = tab.sshSession
    const channel = await ssh.activateChannel(await ssh.openTCPForwardChannel({
        addressToConnectTo: host,
        portToConnectTo: port,
        originatorAddress: '127.0.0.1',
        originatorPort: 0,
    }))
    const stream = new SSHChannelStream(channel)
    // When Tabby tears the SSH session down (dropped connection, Reconnect), its channels don't report closing:
    // end the stream then, so the desktop notices instead of freezing.
    const gone = session?.willDestroy$?.subscribe(() => stream.destroy(new Error('the SSH connection closed')))
    stream.once('close', () => gone?.unsubscribe())
    return stream
}

/**
 * A command on the remote whose stdin and stdout are the stream (a session channel, no PTY): e.g. `ssh -W` run there,
 * for a tunnel that goes on from the remote. Its stderr is not part of it.
 */
export async function execStream (tab: SSHTab, command: string): Promise<Duplex> {
    const ssh = client(tab)
    const session = tab.sshSession
    const channel = await ssh.activateChannel(await ssh.openSessionChannel())
    const stream = new SSHChannelStream(channel)
    await channel.requestExec(command)
    const gone = session?.willDestroy$?.subscribe(() => stream.destroy(new Error('the SSH connection closed')))
    stream.once('close', () => gone?.unsubscribe())
    return stream
}

/**
 * One round trip to the SSH server: opening a session channel waits for the server's confirmation, and nothing
 * runs on the remote until a command is requested on it, so this costs next to nothing there.
 */
export async function pingRemote (tab: SSHTab): Promise<number> {
    const ssh = client(tab)
    const started = performance.now()
    const channel = await ssh.openSessionChannel()
    const ms = performance.now() - started
    ssh.activateChannel(channel).then((c: any) => c.close()).catch(() => null)
    return ms
}

/** A bounded non-interactive command collected natively on this pane's authenticated SSH transport. */
export async function execRemote (tab: SSHTab, command: string, stdin = '', timeoutMs = 60000): Promise<string> {
    return (await remoteCommand({ kind: 'managed', client: sshClientHandle(tab), command }, stdin, timeoutMs)).output
}

/** Native channel routing keeps desktop traffic out of the page's SSH event stream. */
export function sshClientHandle (tab: SSHTab): number {
    const handle = (client(tab) as any).client?.handleId
    if (typeof handle !== 'number') { throw new Error('The SSH connection has no native handle') }
    return handle
}
