import { WASM } from './rust/rdp-audio.data'

let module: WebAssembly.Module | null = null
const MAX_INPUT = 8 << 20

/** Per-owner binary PCM state. Returned arrays own copies, independent of the next call or memory growth. */
export class AudioCore {
    private api: any = null
    private failed = false
    peak = 0
    sent = 0
    received = 0

    private use<T> (call: (api: any) => T): T {
        if (this.failed) { throw new Error('Audio processing is unavailable') }
        try {
            if (!this.api) {
                if (!WASM) { throw new Error('Audio processing module was not built') }
                module ??= new WebAssembly.Module(Uint8Array.from(atob(WASM), c => c.charCodeAt(0)))
                this.api = new WebAssembly.Instance(module, {}).exports
            }
            return call(this.api)
        } catch (error) {
            // A fresh instance would silently lose the resampler phase and playback clock.
            if (error instanceof WebAssembly.RuntimeError) { this.failed = true; this.api = null }
            throw error
        }
    }

    private convert (input: Uint8Array, kind: number, channels: number, inputRate = 0, outputRate = 0): Uint8Array {
        if (input.byteLength > MAX_INPUT) { throw new RangeError('Audio input is too large') }
        return this.use(api => {
            const pointer = api.audio_prepare(input.byteLength)
            if (!pointer) { throw new RangeError('Audio input is too large') }
            new Uint8Array(api.memory.buffer, pointer, input.byteLength).set(input)
            const error = api.audio_process(kind, channels, inputRate, outputRate)
            if (error) { throw new Error(`Audio conversion refused (${error})`) }
            const output = new Uint8Array(api.memory.buffer, api.audio_output(), api.audio_output_len()).slice()
            this.peak = api.audio_control(5, 0, 0, 0)
            return output
        })
    }

    capture (input: Float32Array[], inputRate: number, outputRate: number, channels: number): Int16Array {
        const size = 4 + input.reduce((n, c) => n + 4 + c.length * 4, 0)
        if (size > MAX_INPUT) { throw new RangeError('Audio input is too large') }
        const packet = new Uint8Array(size), view = new DataView(packet.buffer)
        view.setUint32(0, input.length, true)
        let at = 4
        for (const channel of input) {
            view.setUint32(at, channel.length, true); at += 4
            for (const sample of channel) { view.setFloat32(at, sample, true); at += 4 }
        }
        const bytes = this.convert(packet, 0, channels, inputRate, outputRate)
        const result = new Int16Array(bytes.length / 2), samples = new DataView(bytes.buffer)
        for (let i = 0; i < result.length; i++) { result[i] = samples.getInt16(i * 2, true) }
        return result
    }

    playback (input: Uint8Array, channels: number): Float32Array {
        const bytes = this.convert(input, 1, channels)
        const result = new Float32Array(bytes.length / 4), samples = new DataView(bytes.buffer)
        for (let i = 0; i < result.length; i++) { result[i] = samples.getFloat32(i * 4, true) }
        return result
    }

    private control (operation: number, a = 0, b = 0, c = 0): number {
        return this.use(api => {
            const result = api.audio_control(operation, a, b, c)
            if (!Number.isFinite(result)) { throw new Error('Invalid audio timing observation') }
            return result
        })
    }
    resetCapture (): void { if (this.api) { this.control(0) } }
    schedule (now: number): number { return this.control(1, now) }
    played (duration: number): void { this.received = this.control(2, duration) }
    resetPlayback (): void { if (this.api) { this.control(3) } }
    captureSent (samples: number, channels: number, rate: number): void { this.sent = this.control(4, samples, channels, rate) }
    volume (level: number): number { return this.control(6, level) }
}
