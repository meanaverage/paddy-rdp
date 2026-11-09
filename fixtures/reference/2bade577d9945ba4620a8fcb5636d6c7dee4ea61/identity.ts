import { rustCore } from './rust/core'
import { WASM } from './rust/rdp-identity.data'

const call = rustCore(WASM)
// Inner JSON string literals retain lone UTF-16 surrogates through the UTF-8 loader.
function decoded (value: any): any {
    if (typeof value === 'string') { return JSON.parse(value) }
    if (Array.isArray(value)) { return value.map(decoded) }
    if (value && typeof value === 'object') { return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decoded(v)])) }
    return value
}
export function identity<T> (op: string, a: string, b?: string, c?: string, hasVia?: boolean): T {
    return decoded(call({ op, a: JSON.stringify(a), b: b === undefined ? undefined : JSON.stringify(b), c: c === undefined ? undefined : JSON.stringify(c), hasVia }))
}
