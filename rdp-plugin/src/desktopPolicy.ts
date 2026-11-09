import { rustCore } from './rust/core'
import { WASM } from './rust/rdp-desktop.data'
const call = rustCore(WASM)

import { encode, decode } from './rust/value'
export function desktopPolicy<T> (op: string, ...args: any[]): T {
    return decode(call({ op, args: args.map(encode) }))
}

// Only fields consumed by the policy cross the boundary. Other objects are observed
// as opaque truthy values; their conversion hooks and unrelated fields are never read.
const opaque = Object.freeze({})
export function scalarObservation (value: unknown): unknown {
    return value === null || ['undefined', 'string', 'number', 'boolean'].includes(typeof value) ? value : opaque
}
export function fieldsObservation (value: any, fields: string[]): any {
    return Object.fromEntries(fields.map(k => [k, scalarObservation(value?.[k])]))
}
export function wakeObservation (value: any): any {
    return fieldsObservation(value, ['hyperv', 'vm', 'mac', 'broadcast', 'port'])
}
export function desktopObservation (value: any): any {
    return { ...fieldsObservation(value, ['name', 'via', 'host', 'port', 'kind', 'username', 'domain', 'account', 'hyperv', 'gateway', 'gatewayAccount', 'clipboard', 'kindFromHost', 'kindTrusted']), wake: wakeObservation(value?.wake) }
}
