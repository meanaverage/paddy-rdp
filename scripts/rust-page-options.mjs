import fs from 'node:fs'
import path from 'node:path'

export function pageOptions(args, defaultOutput) {
    let output = defaultOutput, hasOutput = false, offline = false
    const modules = []
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--offline') offline = true
        else if (arg === '--module') {
            const name = args[++i]
            if (!name || name.startsWith('-')) throw new Error('--module requires a module name')
            modules.push(name)
        } else if (arg.startsWith('-') || hasOutput) throw new Error(`Unexpected argument: ${arg}`)
        else { output = arg; hasOutput = true }
    }
    return { output: path.resolve(output), offline, modules }
}

export function pageBuilds(root, modules) {
    const builds = fs.readdirSync(path.join(root, 'src-tauri')).sort().flatMap(name => {
        const dir = path.join(root, 'src-tauri', name), config = path.join(dir, 'page.json')
        return fs.existsSync(config) ? [{ name, dir, ...JSON.parse(fs.readFileSync(config, 'utf8')) }] : []
    })
    for (const module of modules) {
        if (!builds.some(build => build.module === module)) throw new Error(`Unknown page module: ${module}`)
    }
    return modules.length ? builds.filter(build => modules.includes(build.module)) : builds
}
