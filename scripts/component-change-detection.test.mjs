import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
    checkComponentChangeDetection,
    findComponentChangeDetectionIssues,
} from './check-component-change-detection.mjs'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

test('repository plugin sources declare explicit changeDetection on every @Component', () => {
    const result = checkComponentChangeDetection(REPO_ROOT)
    assert.deepEqual(result.issues, [])
    assert.ok(result.checked >= 4, `expected at least 4 components, got ${result.checked}`)
    const byFile = new Map(result.componentFiles.map(entry => [entry.file, entry.count]))
    assert.ok((byFile.get('rdp-plugin/src/rdpProfile.ts') ?? 0) >= 2)
    assert.ok((byFile.get('rdp-plugin/src/settingsPage.ts') ?? 0) >= 1)
    assert.ok((byFile.get('rdp-plugin/src/settingsToggle.ts') ?? 0) >= 1)
})

test('CLI entry point succeeds on the repository tree', () => {
    const stdout = execFileSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts/check-component-change-detection.mjs')],
        { cwd: REPO_ROOT, encoding: 'utf8' },
    )
    const match = /^Verified (\d+) @Component decorator\(s\) declare explicit changeDetection\r?\n$/.exec(stdout)
    assert.ok(match, `unexpected CLI output: ${JSON.stringify(stdout)}`)
    assert.ok(Number(match[1]) >= 4)
})

test('accepts explicit Eager and OnPush across named, aliased, and namespace imports', () => {
    const named = `
import { ChangeDetectionStrategy, Component } from '@angular/core'
@Component({
    selector: 'app-eager',
    template: '',
    changeDetection: ChangeDetectionStrategy.Eager,
})
export class EagerComponent {}

@Component({
    selector: 'app-onpush',
    template: '',
    'changeDetection': ChangeDetectionStrategy.OnPush
})
export class OnPushComponent {}
`
    assert.deepEqual(findComponentChangeDetectionIssues(named, 'named.ts'), { checked: 2, issues: [] })

    const aliased = `
import { Component as NgComponent, ChangeDetectionStrategy as CD } from "@angular/core"
@NgComponent({ selector: 'app-a', template: '', changeDetection: CD.Eager })
export class AliasedComponent {}
`
    assert.deepEqual(findComponentChangeDetectionIssues(aliased, 'aliased.ts'), { checked: 1, issues: [] })

    const namespaced = `
import * as ng from '@angular/core'
@ng.Component({ selector: 'app-n', template: '', changeDetection: ng.ChangeDetectionStrategy.OnPush })
export class NamespacedComponent {}
`
    assert.deepEqual(findComponentChangeDetectionIssues(namespaced, 'ns.ts'), { checked: 1, issues: [] })
})

test('rejects @Component missing changeDetection with exact file and line (LF and CRLF)', () => {
    const lf = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({ selector: "ok", template: "", changeDetection: ChangeDetectionStrategy.Eager })',
        'export class First {}',
        '',
        '@Component({',
        '    selector: "missing",',
        '    template: "",',
        '})',
        'export class Second {}',
    ].join('\n')
    const lfResult = findComponentChangeDetectionIssues(lf, 'sample.ts')
    assert.equal(lfResult.checked, 2)
    assert.equal(lfResult.issues.length, 1)
    assert.match(lfResult.issues[0], /^sample\.ts:5: @Component is missing an explicit changeDetection property/)

    const crlf = lf.replaceAll('\n', '\r\n')
    const crlfResult = findComponentChangeDetectionIssues(crlf, 'sample.ts')
    assert.deepEqual(crlfResult, lfResult)
})

test('rejects deprecated Default and non-enum changeDetection values', () => {
    const deprecated = `
import { ChangeDetectionStrategy, Component } from '@angular/core'
@Component({
    selector: 'x',
    changeDetection: ChangeDetectionStrategy.Default,
})
export class DefaultComponent {}
`
    const res1 = findComponentChangeDetectionIssues(deprecated, 'dep.ts')
    assert.equal(res1.checked, 1)
    assert.equal(res1.issues.length, 1)
    assert.match(res1.issues[0], /^dep\.ts:5: @Component changeDetection must be ChangeDetectionStrategy\.Eager or ChangeDetectionStrategy\.OnPush \(found ChangeDetectionStrategy\.Default\)$/)

    const namespacedDeprecated = `
import * as ng from '@angular/core'
@ng.Component({
    selector: 'x',
    changeDetection: ng.ChangeDetectionStrategy.Default,
})
export class DefaultNsComponent {}
`
    const resNs = findComponentChangeDetectionIssues(namespacedDeprecated, 'dep-ns.ts')
    assert.equal(resNs.issues.length, 1)
    assert.match(resNs.issues[0], /^dep-ns\.ts:5: .*ng\.ChangeDetectionStrategy\.Default/)

    const numeric = `
import { ChangeDetectionStrategy, Component } from '@angular/core'
@Component({ selector: 'x', changeDetection: 1 })
export class NumericComponent {}
`
    const res2 = findComponentChangeDetectionIssues(numeric, 'num.ts')
    assert.equal(res2.issues.length, 1)
    assert.match(res2.issues[0], /^num\.ts:3: @Component changeDetection must be .* \(found 1\)$/)

    const shorthand = `
import { Component } from '@angular/core'
const changeDetection = 1
@Component({ selector: 'x', changeDetection })
export class ShorthandComponent {}
`
    const res3 = findComponentChangeDetectionIssues(shorthand, 'short.ts')
    assert.equal(res3.issues.length, 1)
    assert.match(res3.issues[0], /^short\.ts:4: @Component changeDetection must use an explicit/)
})

test('requires a runtime value import of ChangeDetectionStrategy from @angular/core', () => {
    const missingImport = `
import { Component } from '@angular/core'
@Component({ selector: 'x', changeDetection: ChangeDetectionStrategy.Eager })
export class MissingImportComponent {}
`
    const res1 = findComponentChangeDetectionIssues(missingImport, 'missing-import.ts')
    assert.equal(res1.issues.length, 1)
    assert.match(res1.issues[0], /without a value import of ChangeDetectionStrategy from '@angular\/core'/)

    const typeOnlyImport = `
import './polyfill'
import type { ChangeDetectionStrategy } from '@angular/core'
import { Component } from '@angular/core'
@Component({ selector: 'x', changeDetection: ChangeDetectionStrategy.Eager })
export class TypeOnlyComponent {}
`
    const res2 = findComponentChangeDetectionIssues(typeOnlyImport, 'type-only.ts')
    assert.equal(res2.issues.length, 1)
    assert.match(res2.issues[0], /without a value import of ChangeDetectionStrategy/)

    const inlineTypeSpecifier = `
import { Component, type ChangeDetectionStrategy } from '@angular/core'
@Component({ selector: 'x', changeDetection: ChangeDetectionStrategy.OnPush })
export class InlineTypeComponent {}
`
    const res3 = findComponentChangeDetectionIssues(inlineTypeSpecifier, 'inline-type.ts')
    assert.equal(res3.issues.length, 1)
    assert.match(res3.issues[0], /without a value import of ChangeDetectionStrategy/)

    const unimportedNamespace = `
import { Component } from '@angular/core'
@Component({ selector: 'x', changeDetection: ng.ChangeDetectionStrategy.Eager })
export class MissingNsComponent {}
`
    const res4 = findComponentChangeDetectionIssues(unimportedNamespace, 'missing-ns.ts')
    assert.equal(res4.issues.length, 1)
    assert.match(res4.issues[0], /without a namespace import of '@angular\/core'/)

    const sideEffectBeforeReexport = `
import './polyfill'
export { ChangeDetectionStrategy } from '@angular/core'
import { Component } from '@angular/core'
@Component({ selector: 'x', changeDetection: ChangeDetectionStrategy.Eager })
export class ReexportNotLocalComponent {}
`
    const res5 = findComponentChangeDetectionIssues(sideEffectBeforeReexport, 'reexport.ts')
    assert.equal(res5.issues.length, 1)
    assert.match(res5.issues[0], /without a value import of ChangeDetectionStrategy from '@angular\/core'/)
})

test('ignores changeDetection inside nested objects, comments, strings, templates, and regexes', () => {
    const tricky = `
import { ChangeDetectionStrategy, Component } from '@angular/core'
// @Component({ selector: 'fake-line' })
/* @Component({ selector: 'fake-block' }) */
const s = "@Component({ selector: 'fake-str' })"
const t = \`@Component({ selector: 'fake-tpl', inner: \${ { a: 1 } } })\`
const r1 = /@Component\\(['"\\\`\\/]/g
let x = 1
const div = x++ / 2
const obj = { return: 4 }
const div2 = obj.return / 2

@Component({
    selector: 'nested-only',
    // changeDetection: ChangeDetectionStrategy.Eager,
    /* changeDetection: ChangeDetectionStrategy.OnPush */
    template: \`<div>changeDetection: ChangeDetectionStrategy.Eager \${ { changeDetection: ChangeDetectionStrategy.Eager } }</div>\`,
    host: { class: 'a', changeDetection: ChangeDetectionStrategy.Eager },
})
export class NestedOnlyComponent {}
`
    const res = findComponentChangeDetectionIssues(tricky, 'tricky.ts')
    assert.equal(res.checked, 1)
    assert.equal(res.issues.length, 1)
    assert.match(res.issues[0], /^tricky\.ts:13: @Component is missing an explicit changeDetection property/)
})

test('rejects duplicate changeDetection properties and non-object or malformed @Component arguments', () => {
    const duplicate = `
import { ChangeDetectionStrategy, Component } from '@angular/core'
@Component({
    selector: 'dup',
    changeDetection: ChangeDetectionStrategy.Eager,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DupComponent {}
`
    const dupRes = findComponentChangeDetectionIssues(duplicate, 'dup.ts')
    assert.equal(dupRes.issues.length, 1)
    assert.match(dupRes.issues[0], /^dup\.ts:3: @Component declares changeDetection more than once/)

    const nonObject = `
import { Component } from '@angular/core'
const meta = {}
@Component(meta)
export class DynamicComponent {}
`
    const dynRes = findComponentChangeDetectionIssues(nonObject, 'dyn.ts')
    assert.equal(dynRes.issues.length, 1)
    assert.match(dynRes.issues[0], /^dyn\.ts:4: @Component decorator must pass an object literal/)

    const unterminated = `
import { Component } from '@angular/core'
@Component({ selector: 'broken'
`
    const untermRes = findComponentChangeDetectionIssues(unterminated, 'broken.ts')
    assert.equal(untermRes.issues.length, 1)
    assert.match(untermRes.issues[0], /^broken\.ts:3: unterminated @Component/)
})

test('ignores non-Angular Component decorators imported from other modules', () => {
    const namedOther = `
import { Component } from 'other-framework'
@Component({ selector: 'x' })
export class OtherNamed {}
`
    assert.deepEqual(findComponentChangeDetectionIssues(namedOther, 'other.ts'), { checked: 0, issues: [] })

    const defaultOther = `
import Component from 'other-framework'
@Component({ selector: 'x' })
export class OtherDefault {}
`
    assert.deepEqual(findComponentChangeDetectionIssues(defaultOther, 'other-default.ts'), { checked: 0, issues: [] })
})

test('fails closed when source directory is missing or contains zero @Component decorators', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paddy-rdp-cd-'))
    try {
        assert.throws(
            () => checkComponentChangeDetection(tmp),
            /Expected plugin source directory does not exist: rdp-plugin\/src/,
        )
        const srcDir = path.join(tmp, 'rdp-plugin', 'src')
        fs.mkdirSync(srcDir, { recursive: true })
        fs.writeFileSync(path.join(srcDir, 'empty.ts'), 'export const value = 1\n')
        const emptyResult = checkComponentChangeDetection(tmp)
        assert.equal(emptyResult.checked, 0)
        assert.equal(emptyResult.issues.length, 1)
        assert.match(emptyResult.issues[0], /No @Component decorators found/)
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
    }
})
