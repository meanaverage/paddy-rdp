import { invoke } from '@tauri-apps/api/core'

interface Captured {
    output: string
    stderr: number[]
    code: number | null
}

/** The page supplies its existing transport/argv; Rust owns output bounds, deadlines and resource cleanup. */
export async function remoteCommand (
    target: { kind: 'managed', client: number, command: string } | { kind: 'system', args: string[] },
    input = '', timeoutMs = 60000,
): Promise<{ output: string, stderr: string, code: number | null }> {
    try {
        const result = await invoke<Captured>('rdp_command', {
            target,
            // Node's old stdin write encoded lone surrogates as U+FFFD; JSON must carry that same text.
            input: Buffer.from(input).toString('utf8'),
            // Window timers use a signed 32-bit millisecond delay, with negatives treated as zero.
            timeoutMs: Math.max(0, timeoutMs | 0),
        })
        return { ...result, stderr: String.fromCharCode(...result.stderr) }
    } catch (error) {
        const message = String(error)
        throw new Error(message === 'RDP_COMMAND_TIMEOUT' ? `Remote command timed out after ${timeoutMs / 1000}s` : message)
    }
}
