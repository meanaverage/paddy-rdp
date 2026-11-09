import { AudioCore } from './audioCore'

/**
 * Plays a remote desktop's audio (IronRDP's `audioPlayback` extension): blocks of 16-bit PCM, queued
 * back to back on a Web Audio clock. A little lead absorbs network jitter; if playback falls too far
 * behind (a stall, a busy tab), it skips ahead rather than letting the delay grow.
 */
export class AudioPlayer {
    private context: AudioContext | null = null
    private gain: GainNode | null = null
    private readonly core = new AudioCore()
    /** Seconds of audio received and scheduled (for tests and troubleshooting). */
    get received (): number { return this.core.received }
    /** Loudest sample seen, 0..1 (for tests: tells sound from silence). */
    get peak (): number { return this.core.peak }

    /** The callback for IronRDP's audioPlayback extension. */
    readonly callback = (message: any): void => {
        try {
            if (message?.type === 'wave') {
                this.play(message.sampleRate, message.channels, message.data)
            } else if (message?.type === 'volume') {
                this.volume((Number(message.left) + Number(message.right)) / 2)
            } else if (message?.type === 'close') {
                this.core.resetPlayback()
            }
        } catch (e) {
            console.warn('remote desktop audio:', e)
        }
    }

    private play (sampleRate: number, channels: number, data: Uint8Array): void {
        const frames = Math.floor(data.byteLength / 2 / channels)
        if (!frames || !channels) {
            return
        }
        this.context ??= new AudioContext({ latencyHint: 'interactive' })
        if (!this.gain) {
            this.gain = this.context.createGain()
            this.gain.connect(this.context.destination)
        }
        if (this.context.state === 'suspended') {
            this.context.resume().catch(() => null)
        }
        const buffer = this.context.createBuffer(channels, frames, sampleRate)
        const samples = this.core.playback(data, channels)
        for (let ch = 0; ch < channels; ch++) {
            buffer.getChannelData(ch).set(samples.subarray(ch * frames, (ch + 1) * frames))
        }
        const start = this.core.schedule(this.context.currentTime)
        const source = this.context.createBufferSource()
        source.buffer = buffer
        source.connect(this.gain)
        source.start(start)
        this.core.played(buffer.duration)
    }

    private volume (level: number): void {
        if (this.gain && Number.isFinite(level)) {
            this.gain.gain.value = this.core.volume(level)
        }
    }

    close (): void {
        this.context?.close().catch(() => null)
        this.context = null
        this.gain = null
    }
}
