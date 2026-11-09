// Observation tags retain JavaScript's missing/nonfinite values and exact UTF-16 text.
export function encode (value: any): any {
    if (value === undefined) { return ['u'] }
    if (value === null) { return ['z'] }
    if (typeof value === 'boolean') { return ['b', value] }
    if (typeof value === 'number') { return ['n', Object.is(value, -0) ? '-0' : Number.isFinite(value) ? value : String(value)] }
    if (typeof value === 'string') { return ['s', JSON.stringify(value)] }
    if (Array.isArray(value)) { return ['a', Array.from(value, encode)] }
    if (typeof value === 'object') { return ['o', Object.entries(value).map(([k, v]) => [JSON.stringify(k), encode(v)])] }
    return ['o', []]
}
export function decode (value: any): any {
    switch (value[0]) {
        case 'u': return undefined
        case 'z': return null
        case 'b': return value[1]
        case 'n': return typeof value[1] === 'number' ? value[1] : Number(value[1])
        case 's': return JSON.parse(value[1])
        case 'a': return value[1].map(decode)
        case 'o': return Object.fromEntries(value[1].map(([k, v]) => [JSON.parse(k), decode(v)]))
        default: throw new Error('Invalid Rust value result')
    }
}
