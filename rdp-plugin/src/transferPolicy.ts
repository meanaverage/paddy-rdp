import { rustCore } from './rust/core'
import { WASM } from './rust/rdp-transfer.data'

/** One module instance per transfer, so provider identities never cross connections. */
export class TransferPolicy {
    private readonly call = rustCore(WASM)
    private failed = false
    private reserved = 0

    run<T> (op: string, fields: Record<string, unknown> = {}): T {
        // A trap must not silently recreate a counter and accept an old provider's answer.
        if (this.failed) { throw new Error('File transfer policy is unavailable') }
        try {
            const result = this.call({ op, ...fields })
            this.reserved = result.reserved
            return result.value
        } catch (error) {
            this.failed = true
            throw error
        }
    }

    roomReady (): void {
        if (!this.failed) { this.run('room_ready') }
    }

    dispose (): number[] {
        try {
            if (!this.failed) { return this.run('dispose') }
            return this.reserved ? [this.reserved] : []
        } catch {
            return this.reserved ? [this.reserved] : []
        } finally { this.reserved = 0 }
    }
}
