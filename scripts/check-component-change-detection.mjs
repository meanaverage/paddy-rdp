#!/usr/bin/env node
// Verify every Angular @Component decorator in the plugin sources declares an explicit changeDetection strategy.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const REGEX_PREV_KEYWORDS = new Set([
    'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield',
])
const REGEX_PREV_PUNCT = new Set([
    '(', '[', '{', ',', ';', ':', '=', '!', '?', '&', '|', '^', '~', '+', '-', '*', '%', '<', '>', '=>', '...',
])
const VALID_STRATEGIES = new Set(['Eager', 'OnPush'])

function canStartRegex (tokens) {
    const prev = tokens[tokens.length - 1]
    if (!prev) return true
    if (prev.kind === 'punct') return REGEX_PREV_PUNCT.has(prev.text)
    if (prev.kind === 'ident') {
        const beforePrev = tokens[tokens.length - 2]
        if (beforePrev?.kind === 'punct' && beforePrev.text === '.') return false
        return REGEX_PREV_KEYWORDS.has(prev.text)
    }
    return false
}

export function tokenizeTypeScript (source) {
    const tokens = []
    const templateBraceDepths = []
    let i = 0
    let line = 1

    const scanTemplateBody = () => {
        const startLine = line
        let text = ''
        while (i < source.length) {
            const ch = source[i]
            if (ch === '\\') {
                if (i + 1 < source.length) {
                    if (source[i + 1] === '\n') line++
                    text += ch + source[i + 1]
                    i += 2
                } else {
                    text += ch
                    i++
                }
                continue
            }
            if (ch === '`') {
                i++
                tokens.push({ kind: 'template', text, line: startLine })
                return
            }
            if (ch === '$' && source[i + 1] === '{') {
                i += 2
                tokens.push({ kind: 'template', text, line: startLine })
                templateBraceDepths.push(0)
                return
            }
            if (ch === '\n') line++
            text += ch
            i++
        }
        tokens.push({ kind: 'template', text, line: startLine })
    }

    while (i < source.length) {
        const ch = source[i]
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
            i++
            continue
        }
        if (ch === '\n') {
            line++
            i++
            continue
        }
        // Single-line comment
        if (ch === '/' && source[i + 1] === '/') {
            i += 2
            while (i < source.length && source[i] !== '\n') i++
            continue
        }
        // Block comment
        if (ch === '/' && source[i + 1] === '*') {
            i += 2
            while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
                if (source[i] === '\n') line++
                i++
            }
            if (i < source.length) i += 2
            continue
        }
        // Regex literal
        if (ch === '/' && canStartRegex(tokens)) {
            const startLine = line
            let text = '/'
            let inClass = false
            i++
            while (i < source.length) {
                const c = source[i]
                if (c === '\\' && i + 1 < source.length) {
                    text += c + source[i + 1]
                    i += 2
                    continue
                }
                if (c === '[') inClass = true
                else if (c === ']') inClass = false
                else if (c === '/' && !inClass) {
                    text += '/'
                    i++
                    while (i < source.length && /[a-zA-Z]/.test(source[i])) {
                        text += source[i]
                        i++
                    }
                    break
                }
                if (c === '\n') {
                    line++
                    i++
                    break
                }
                text += c
                i++
            }
            tokens.push({ kind: 'regex', text, line: startLine })
            continue
        }
        // Quoted string literal
        if (ch === '\'' || ch === '"') {
            const quote = ch
            const startLine = line
            let text = ''
            i++
            while (i < source.length) {
                const c = source[i]
                if (c === '\\') {
                    if (i + 1 < source.length) {
                        if (source[i + 1] === '\n') line++
                        text += source[i + 1]
                        i += 2
                    } else {
                        i++
                    }
                    continue
                }
                if (c === quote) {
                    i++
                    break
                }
                if (c === '\n') line++
                text += c
                i++
            }
            tokens.push({ kind: 'string', text, line: startLine })
            continue
        }
        // Template literal
        if (ch === '`') {
            i++
            scanTemplateBody()
            continue
        }
        // Track brace depth inside `${...}` template interpolations
        if (ch === '{' && templateBraceDepths.length > 0) {
            templateBraceDepths[templateBraceDepths.length - 1]++
            tokens.push({ kind: 'punct', text: '{', line })
            i++
            continue
        }
        if (ch === '}' && templateBraceDepths.length > 0) {
            if (templateBraceDepths[templateBraceDepths.length - 1] === 0) {
                templateBraceDepths.pop()
                i++
                scanTemplateBody()
                continue
            }
            templateBraceDepths[templateBraceDepths.length - 1]--
            tokens.push({ kind: 'punct', text: '}', line })
            i++
            continue
        }
        // Identifier or keyword
        if (/[A-Za-z_$]/.test(ch)) {
            const start = i
            const startLine = line
            i++
            while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i++
            tokens.push({ kind: 'ident', text: source.slice(start, i), line: startLine })
            continue
        }
        // Numeric literal
        if (/[0-9]/.test(ch)) {
            const start = i
            const startLine = line
            i++
            while (i < source.length && /[0-9a-zA-Z._]/.test(source[i])) i++
            tokens.push({ kind: 'other', text: source.slice(start, i), line: startLine })
            continue
        }
        // Multi-character punctuation relevant to regex context
        if (ch === '=' && source[i + 1] === '>') {
            tokens.push({ kind: 'punct', text: '=>', line })
            i += 2
            continue
        }
        if ((ch === '+' && source[i + 1] === '+') || (ch === '-' && source[i + 1] === '-')) {
            tokens.push({ kind: 'punct', text: ch + ch, line })
            i += 2
            continue
        }
        if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
            tokens.push({ kind: 'punct', text: '...', line })
            i += 3
            continue
        }
        tokens.push({ kind: 'punct', text: ch, line })
        i++
    }
    return tokens
}

function parseImports (tokens) {
    const componentNames = new Set()
    const strategyNames = new Set()
    const namespaces = new Set()
    const nonAngularComponents = new Set()

    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].kind !== 'ident' || tokens[i].text !== 'import') continue
        // Skip dynamic import(...) and import.meta
        if (tokens[i + 1]?.kind === 'punct' && (tokens[i + 1].text === '(' || tokens[i + 1].text === '.')) continue
        // Skip side-effect import '...'
        if (tokens[i + 1]?.kind === 'string') {
            i++
            continue
        }
        let j = i + 1
        let isTypeOnlyImport = false
        if (tokens[j]?.kind === 'ident' && tokens[j].text === 'type') {
            // `import type { ... } from '...'` vs `import type from '...'`
            const afterType = tokens[j + 1]
            if (afterType && !(afterType.kind === 'ident' && afterType.text === 'from')) {
                isTypeOnlyImport = true
                j++
            }
        }
        const specifiers = []
        let defaultLocal = null
        let namespaceLocal = null
        if (tokens[j]?.kind === 'ident' && tokens[j].text !== 'from') {
            defaultLocal = tokens[j].text
            j++
        }
        while (j < tokens.length) {
            const t = tokens[j]
            if (t.kind === 'ident' && t.text === 'import') {
                i = j - 1
                break
            }
            if (t.kind === 'ident' && t.text === 'from' && tokens[j + 1]?.kind === 'string') {
                const mod = tokens[j + 1].text
                if (!isTypeOnlyImport) {
                    if (mod === '@angular/core') {
                        if (namespaceLocal) namespaces.add(namespaceLocal)
                        for (const spec of specifiers) {
                            if (spec.isType) continue
                            if (spec.imported === 'Component') componentNames.add(spec.local)
                            if (spec.imported === 'ChangeDetectionStrategy') strategyNames.add(spec.local)
                        }
                    } else {
                        if (defaultLocal === 'Component') nonAngularComponents.add('Component')
                        for (const spec of specifiers) {
                            if (!spec.isType && spec.local === 'Component') nonAngularComponents.add(spec.local)
                        }
                    }
                }
                i = j + 1
                break
            }
            if (t.kind === 'punct' && t.text === ';') {
                i = j
                break
            }
            if (t.kind === 'punct' && t.text === '*' && tokens[j + 1]?.kind === 'ident' && tokens[j + 1].text === 'as' && tokens[j + 2]?.kind === 'ident') {
                namespaceLocal = tokens[j + 2].text
                j += 3
                continue
            }
            if (t.kind === 'punct' && t.text === '{') {
                j++
                while (j < tokens.length && !(tokens[j].kind === 'punct' && tokens[j].text === '}')) {
                    let isType = false
                    if (tokens[j].kind === 'ident' && tokens[j].text === 'type' && tokens[j + 1]?.kind === 'ident' && tokens[j + 1].text !== 'as') {
                        isType = true
                        j++
                    }
                    if (tokens[j]?.kind === 'ident') {
                        const imported = tokens[j].text
                        let local = imported
                        j++
                        if (tokens[j]?.kind === 'ident' && tokens[j].text === 'as' && tokens[j + 1]?.kind === 'ident') {
                            local = tokens[j + 1].text
                            j += 2
                        }
                        specifiers.push({ imported, local, isType })
                    }
                    if (tokens[j]?.kind === 'punct' && tokens[j].text === ',') j++
                    else if (!(tokens[j]?.kind === 'punct' && tokens[j].text === '}')) j++
                }
                if (tokens[j]?.kind === 'punct' && tokens[j].text === '}') j++
                continue
            }
            j++
        }
    }

    return { componentNames, strategyNames, namespaces, nonAngularComponents }
}

function findMatchingDelimiter (tokens, openIndex, openChar, closeChar) {
    let depth = 0
    for (let i = openIndex; i < tokens.length; i++) {
        if (tokens[i].kind === 'punct') {
            if (tokens[i].text === openChar) depth++
            else if (tokens[i].text === closeChar) {
                depth--
                if (depth === 0) return i
            }
        }
    }
    return -1
}

function splitTopLevelObjectEntries (tokens, openBraceIndex, closeBraceIndex) {
    const entries = []
    let current = []
    let paren = 0
    let brace = 0
    let bracket = 0
    for (let i = openBraceIndex + 1; i < closeBraceIndex; i++) {
        const t = tokens[i]
        if (t.kind === 'punct') {
            if (t.text === '(') paren++
            else if (t.text === ')') paren--
            else if (t.text === '{') brace++
            else if (t.text === '}') brace--
            else if (t.text === '[') bracket++
            else if (t.text === ']') bracket--
            else if (t.text === ',' && paren === 0 && brace === 0 && bracket === 0) {
                if (current.length > 0) entries.push(current)
                current = []
                continue
            }
        }
        current.push(t)
    }
    if (current.length > 0) entries.push(current)
    return entries
}

function validateStrategyValue (valueTokens, imports, file, line) {
    // Expect either `<StrategyAlias>.(Eager|OnPush)` or `<Namespace>.ChangeDetectionStrategy.(Eager|OnPush)`
    if (
        valueTokens.length === 3
        && valueTokens[0].kind === 'ident'
        && valueTokens[1].kind === 'punct' && valueTokens[1].text === '.'
        && valueTokens[2].kind === 'ident'
    ) {
        const obj = valueTokens[0].text
        const member = valueTokens[2].text
        if (!VALID_STRATEGIES.has(member)) {
            return `${file}:${line}: @Component changeDetection must be ChangeDetectionStrategy.Eager or ChangeDetectionStrategy.OnPush (found ${obj}.${member})`
        }
        if (!imports.strategyNames.has(obj)) {
            return `${file}:${line}: @Component changeDetection references ${obj}.${member} without a value import of ChangeDetectionStrategy from '@angular/core'`
        }
        return null
    }
    if (
        valueTokens.length === 5
        && valueTokens[0].kind === 'ident'
        && valueTokens[1].kind === 'punct' && valueTokens[1].text === '.'
        && valueTokens[2].kind === 'ident' && valueTokens[2].text === 'ChangeDetectionStrategy'
        && valueTokens[3].kind === 'punct' && valueTokens[3].text === '.'
        && valueTokens[4].kind === 'ident'
    ) {
        const ns = valueTokens[0].text
        const member = valueTokens[4].text
        if (!VALID_STRATEGIES.has(member)) {
            return `${file}:${line}: @Component changeDetection must be ChangeDetectionStrategy.Eager or ChangeDetectionStrategy.OnPush (found ${ns}.ChangeDetectionStrategy.${member})`
        }
        if (!imports.namespaces.has(ns)) {
            return `${file}:${line}: @Component changeDetection references ${ns}.ChangeDetectionStrategy.${member} without a namespace import of '@angular/core'`
        }
        return null
    }
    const found = valueTokens.map(t => t.text).join('')
    return `${file}:${line}: @Component changeDetection must be ChangeDetectionStrategy.Eager or ChangeDetectionStrategy.OnPush (found ${found || '<empty>'})`
}

export function findComponentChangeDetectionIssues (source, file = '<source>') {
    const tokens = tokenizeTypeScript(source)
    const imports = parseImports(tokens)
    const issues = []
    let checked = 0

    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].kind !== 'punct' || tokens[i].text !== '@') continue
        const decoratorLine = tokens[i].line
        let callParenIndex = -1

        // Match `@Component(` (or alias) or `@ns.Component(`
        if (
            tokens[i + 1]?.kind === 'ident'
            && tokens[i + 2]?.kind === 'punct' && tokens[i + 2].text === '('
            && (imports.componentNames.has(tokens[i + 1].text)
                || (tokens[i + 1].text === 'Component' && !imports.nonAngularComponents.has('Component')))
        ) {
            callParenIndex = i + 2
        } else if (
            tokens[i + 1]?.kind === 'ident' && imports.namespaces.has(tokens[i + 1].text)
            && tokens[i + 2]?.kind === 'punct' && tokens[i + 2].text === '.'
            && tokens[i + 3]?.kind === 'ident' && tokens[i + 3].text === 'Component'
            && tokens[i + 4]?.kind === 'punct' && tokens[i + 4].text === '('
        ) {
            callParenIndex = i + 4
        }

        if (callParenIndex === -1) continue
        checked++

        const closeParenIndex = findMatchingDelimiter(tokens, callParenIndex, '(', ')')
        if (closeParenIndex === -1) {
            issues.push(`${file}:${decoratorLine}: unterminated @Component(...) decorator`)
            continue
        }
        const firstArg = tokens[callParenIndex + 1]
        if (!firstArg || firstArg.kind !== 'punct' || firstArg.text !== '{') {
            issues.push(`${file}:${decoratorLine}: @Component decorator must pass an object literal with an explicit changeDetection property`)
            continue
        }
        const closeBraceIndex = findMatchingDelimiter(tokens, callParenIndex + 1, '{', '}')
        if (closeBraceIndex === -1 || closeBraceIndex > closeParenIndex) {
            issues.push(`${file}:${decoratorLine}: unterminated object literal in @Component(...)`)
            continue
        }

        const entries = splitTopLevelObjectEntries(tokens, callParenIndex + 1, closeBraceIndex)
        const cdEntries = entries.filter(entry =>
            (entry[0]?.kind === 'ident' || entry[0]?.kind === 'string')
            && entry[0].text === 'changeDetection'
        )
        if (cdEntries.length === 0) {
            issues.push(`${file}:${decoratorLine}: @Component is missing an explicit changeDetection property (use ChangeDetectionStrategy.Eager or ChangeDetectionStrategy.OnPush)`)
            continue
        }
        if (cdEntries.length > 1) {
            issues.push(`${file}:${decoratorLine}: @Component declares changeDetection more than once`)
            continue
        }
        const entry = cdEntries[0]
        if (entry[1]?.kind !== 'punct' || entry[1].text !== ':') {
            issues.push(`${file}:${decoratorLine}: @Component changeDetection must use an explicit ChangeDetectionStrategy.Eager or ChangeDetectionStrategy.OnPush value`)
            continue
        }
        const valueIssue = validateStrategyValue(entry.slice(2), imports, file, entry[0].line)
        if (valueIssue) issues.push(valueIssue)
    }

    return { checked, issues }
}

function listTypeScriptFiles (directory) {
    const files = []
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) {
            files.push(...listTypeScriptFiles(full))
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            files.push(full)
        }
    }
    return files
}

export function checkComponentChangeDetection (rootDir, scanDirs = ['rdp-plugin/src', 'itabby-plugin/src']) {
    const primaryDir = path.join(rootDir, scanDirs[0])
    if (!fs.existsSync(primaryDir)) {
        throw new Error(`Expected plugin source directory does not exist: ${scanDirs[0]}`)
    }
    const tsFiles = []
    for (const relDir of scanDirs) {
        const fullDir = path.join(rootDir, relDir)
        if (fs.existsSync(fullDir)) {
            tsFiles.push(...listTypeScriptFiles(fullDir))
        }
    }
    tsFiles.sort((a, b) => a.localeCompare(b))

    let checked = 0
    const componentFiles = []
    const issues = []
    for (const fullFile of tsFiles) {
        const relFile = path.relative(rootDir, fullFile).split(path.sep).join('/')
        const source = fs.readFileSync(fullFile, 'utf8')
        const result = findComponentChangeDetectionIssues(source, relFile)
        if (result.checked > 0) {
            checked += result.checked
            componentFiles.push({ file: relFile, count: result.checked })
        }
        issues.push(...result.issues)
    }
    if (checked === 0) {
        issues.push(`No @Component decorators found under ${scanDirs.join(', ')}`)
    }
    return { checked, componentFiles, issues }
}

function sameFile (a, b) {
    try {
        return fs.realpathSync(a) === fs.realpathSync(b)
    } catch {
        return path.resolve(a) === path.resolve(b)
    }
}

const isMain = Boolean(process.argv[1]) && sameFile(process.argv[1], fileURLToPath(import.meta.url))
if (isMain) {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const result = checkComponentChangeDetection(root)
    if (result.issues.length > 0) {
        throw new Error(`Component changeDetection check failed:\n${result.issues.join('\n')}`)
    }
    console.log(`Verified ${result.checked} @Component decorator(s) declare explicit changeDetection`)
}
