/** Pure Rust cores run in the page without changing synchronous callers into asynchronous mutations. */
export function rustCore (encoded: string): (request: unknown) => any {
    let instance: WebAssembly.Instance | null = null
    let module: WebAssembly.Module | null = null
    const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true })
    return request => {
        if (!encoded) { throw new Error('Rust page core was not built') }
        const input = encoder.encode(JSON.stringify(request, (_key, value) => typeof value === 'string'
            ? value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD') : value))
        if (input.length > 8 * 1024 * 1024) { throw new Error('Request is too large') }
        if (!module) {
            const decoded = atob(encoded), bytes = new Uint8Array(decoded.length)
            for (let i = 0; i < decoded.length; i++) { bytes[i] = decoded.charCodeAt(i) }
            module = new WebAssembly.Module(bytes)
        }
        instance ??= new WebAssembly.Instance(module, {})
        const api = instance.exports as unknown as { memory: WebAssembly.Memory, allocate(n: number): number, release(p: number, n: number): void, request(p: number, n: number): number, response_len(): number }
        let result: { value?: unknown, error?: string }
        try {
            const ptr = api.allocate(input.length)
            if (!ptr) { throw new Error('Rust page core could not allocate the request') }
            try {
                new Uint8Array(api.memory.buffer, ptr, input.length).set(input)
                const out = api.request(ptr, input.length), length = api.response_len()
                if (length > 16 * 1024 * 1024) { throw new Error('Response is too large') }
                result = JSON.parse(decoder.decode(new Uint8Array(api.memory.buffer, out, length)))
            } finally { api.release(ptr, input.length) }
        } catch (error) { instance = null; throw error }
        if (result.error) { throw new Error(result.error) }
        return result.value
    }
}
