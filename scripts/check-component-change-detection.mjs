#!/usr/bin/env node
// Verify every Angular @Component decorator in rdp-plugin/src declares an explicit changeDetection strategy.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCAN_DIR = 'rdp-plugin/src'
const ANGULAR_IMPORT_RE = /^import[ \t]*\{([\w\s,]+)\}[ \t]*from[ \t]*['"]@angular\/core['"][ \t]*;?[ \t]*$/gm
const COMPONENT_RE = /@(?:[\w$]+\.)?Component\b/g
const CANONICAL_BLOCK_RE = /^@Component\(\{[ \t]*\n([\s\S]*?)\n\}\)[ \t]*$/my
const COMMENT_OR_STR_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`/g
const CD_MENTION_RE = /(?<![\w$])(['"]?)changeDetection\1(?![\w$])/g
const CANONICAL_CD_LINE_RE = /^[ \t]+changeDetection[ \t]*:[ \t]*ChangeDetectionStrategy\.(Eager|OnPush)[ \t]*,?[ \t]*$/
const lineAt = (text, index) => text.slice(0, index).split('\n').length
const blank = token => token.replace(/[^\n]/g, ' ')

function checkDecoratorBlock (body, decoratorLine, hasStrategyImport, file) {
    const clean = body.replace(COMMENT_OR_STR_RE, (token, offset, str) => {
        if ((token === "'changeDetection'" || token === '"changeDetection"') && /^\s*:/.test(str.slice(offset + token.length))) {
            return token
        }
        return token.startsWith('`') && token.includes('${') ? '`' : blank(token)
    })
    let top = clean
    while (/\{[^{}]*\}/.test(top)) top = top.replace(/\{[^{}]*\}/g, blank)
    if (clean.includes('`') || clean.includes('/*') || /[{}]/.test(top)) {
        return { issue: `${file}:${decoratorLine}: @Component block has malformed syntax or unbalanced delimiters` }
    }
    if (/\.\.\./.test(top)) return { issue: `${file}:${decoratorLine}: @Component must not use object spread (...)` }
    if (/(?:^|,)[ \t]*\[[^?:]+\][ \t]*:/m.test(top)) return { issue: `${file}:${decoratorLine}: @Component must not use computed property keys` }
    const mentions = [...top.matchAll(CD_MENTION_RE)]
    if (mentions.length === 0) return { issue: `${file}:${decoratorLine}: @Component is missing an explicit changeDetection property (use ChangeDetectionStrategy.Eager or ChangeDetectionStrategy.OnPush)` }
    if (mentions.length > 1) return { issue: `${file}:${decoratorLine}: @Component declares changeDetection more than once` }
    const bodyLine = lineAt(top, mentions[0].index)
    const entryLine = decoratorLine + bodyLine
    const valid = CANONICAL_CD_LINE_RE.exec(top.split('\n')[bodyLine - 1])
    if (!valid) return { issue: `${file}:${entryLine}: @Component changeDetection must be ChangeDetectionStrategy.Eager or ChangeDetectionStrategy.OnPush` }
    if (!hasStrategyImport) return { issue: `${file}:${entryLine}: @Component changeDetection requires a value import of ChangeDetectionStrategy from '@angular/core'` }
    return { strategy: valid[1] }
}

export function findComponentChangeDetectionIssues (source, file = '<source>') {
    const text = source.replace(/\r\n/g, '\n')
    const issues = []
    const strategies = []
    let hasStrategyImport = false
    for (const m of text.matchAll(ANGULAR_IMPORT_RE)) {
        const specs = m[1].split(',').map(s => s.trim()).filter(Boolean)
        if (specs.includes('ChangeDetectionStrategy')) hasStrategyImport = true
        if (specs.some(s => /^Component\s+as\s+/.test(s))) {
            issues.push(`${file}:${lineAt(text, m.index)}: @angular/core Component import must not be aliased`)
        }
    }
    let checked = 0
    for (const m of text.matchAll(COMPONENT_RE)) {
        checked++
        const decoratorLine = lineAt(text, m.index)
        CANONICAL_BLOCK_RE.lastIndex = m.index
        const block = CANONICAL_BLOCK_RE.exec(text)
        if (!block || block[1].search(COMPONENT_RE) !== -1) {
            issues.push(`${file}:${decoratorLine}: @Component must use canonical multi-line @Component({ ... }) form`)
            continue
        }
        const outcome = checkDecoratorBlock(block[1], decoratorLine, hasStrategyImport, file)
        if (outcome.issue) issues.push(outcome.issue)
        else strategies.push(outcome.strategy)
    }
    return { checked, strategies, issues }
}

function listTypeScriptFiles (dir) {
    const files = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) files.push(...listTypeScriptFiles(full))
        else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(full)
    }
    return files
}

export function checkComponentChangeDetection (rootDir) {
    const srcDir = path.join(rootDir, SCAN_DIR)
    if (!fs.existsSync(srcDir)) throw new Error(`Expected plugin source directory does not exist: ${SCAN_DIR}`)
    const tsFiles = listTypeScriptFiles(srcDir)
        .map(fullFile => ({ fullFile, relFile: path.relative(rootDir, fullFile).split(path.sep).join('/') }))
        .sort((a, b) => (a.relFile < b.relFile ? -1 : a.relFile > b.relFile ? 1 : 0))
    let checked = 0
    const componentFiles = []
    const strategies = []
    const issues = []
    for (const { fullFile, relFile } of tsFiles) {
        const result = findComponentChangeDetectionIssues(fs.readFileSync(fullFile, 'utf8'), relFile)
        if (result.checked > 0) {
            checked += result.checked
            componentFiles.push({ file: relFile, count: result.checked, strategies: result.strategies })
            strategies.push(...result.strategies)
        }
        issues.push(...result.issues)
    }
    if (checked === 0) issues.push(`No @Component decorators found under ${SCAN_DIR}`)
    return { checked, componentFiles, strategies, issues }
}

const isMain = Boolean(process.argv[1]) && (() => {
    try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) }
    catch { return false }
})()

if (isMain) {
    const root = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../', import.meta.url))
    const result = checkComponentChangeDetection(root)
    if (result.issues.length > 0) throw new Error(`Component changeDetection check failed:\n${result.issues.join('\n')}`)
    console.log(`Verified ${result.checked} @Component decorator(s) declare explicit changeDetection`)
}
