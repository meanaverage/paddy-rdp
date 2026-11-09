// scripts/build.mjs replaces this with the shared page-core loader before bundling.
export function rustCore (_encoded: string): (request: unknown) => any {
    return () => { throw new Error('Rust page loader was not built') }
}
