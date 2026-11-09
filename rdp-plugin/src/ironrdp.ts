/** The shared, immutable part of IronRDP: its compiled code and its glue factory, never an instance or its memory. */
export interface IronRDPSource {
    module: WebAssembly.Module
    createBackend: (module: WebAssembly.Module, level: string, logSink?: (line: string) => void) => Promise<any>
}

/** Loads and compiles once; every connection attempt gets fresh glue, classes, memory and allocator. */
export class IronRDPLoader {
    private source: Promise<IronRDPSource> | null = null

    constructor (private load: () => Promise<IronRDPSource>) { }

    /** `logSink`: given each of the instance's log lines in place of the console (the diagnostic log file). */
    async create (level: string, logSink?: (line: string) => void): Promise<any> {
        const pending = this.source ??= this.load()
        let source: IronRDPSource
        try {
            source = await pending
        } catch (error) {
            if (this.source === pending) {
                this.source = null
            }
            throw error
        }
        // A failed/trapped instance does not invalidate shared compiled code or another desktop's instance.
        return source.createBackend(source.module, level, logSink)
    }
}
