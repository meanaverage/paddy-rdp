import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
const CLI_PATH = path.join(REPO_ROOT, 'scripts/check-component-change-detection.mjs')

test('repository plugin sources declare ChangeDetectionStrategy.Eager on all 4 @Component decorators', () => {
    const result = checkComponentChangeDetection(REPO_ROOT)
    assert.deepEqual(result, {
        checked: 4,
        componentFiles: [
            { file: 'rdp-plugin/src/rdpProfile.ts', count: 2, strategies: ['Eager', 'Eager'] },
            { file: 'rdp-plugin/src/settingsPage.ts', count: 1, strategies: ['Eager'] },
            { file: 'rdp-plugin/src/settingsToggle.ts', count: 1, strategies: ['Eager'] },
        ],
        strategies: ['Eager', 'Eager', 'Eager', 'Eager'],
        issues: [],
    })
})

test('CLI subprocess succeeds on repository tree and fails on temp tree with nested failing .ts while ignoring .d.ts', () => {
    const okRun = spawnSync(process.execPath, [CLI_PATH], { cwd: REPO_ROOT, encoding: 'utf8' })
    assert.equal(okRun.status, 0, `expected exit 0, got ${okRun.status}: ${okRun.stderr}`)
    assert.match(okRun.stdout, /^Verified 4 @Component decorator\(s\) declare explicit changeDetection\r?\n$/)

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paddy-rdp-cd-'))
    try {
        const srcDir = path.join(tmp, 'rdp-plugin', 'src')
        const subDir = path.join(srcDir, 'sub')
        fs.mkdirSync(subDir, { recursive: true })
        fs.writeFileSync(
            path.join(srcDir, 'ok.ts'),
            [
                "import { ChangeDetectionStrategy, Component } from '@angular/core'",
                '@Component({',
                "    selector: 'app-ok',",
                '    changeDetection: ChangeDetectionStrategy.Eager,',
                '})',
                'export class OkComponent {}',
                '',
            ].join('\n'),
        )
        fs.writeFileSync(
            path.join(srcDir, 'types.d.ts'),
            "@Component({ selector: 'ignored-dts' })\nexport declare class IgnoredDts {}\n",
        )
        fs.writeFileSync(
            path.join(srcDir, 'notes.txt'),
            "@Component({ selector: 'ignored-txt' })\n",
        )
        fs.writeFileSync(
            path.join(subDir, 'bad.ts'),
            [
                "import { ChangeDetectionStrategy, Component } from '@angular/core'",
                '',
                '@Component({',
                "    selector: 'app-bad',",
                "    template: '',",
                '})',
                'export class BadComponent {}',
                '',
            ].join('\n'),
        )

        const dirResult = checkComponentChangeDetection(tmp)
        assert.equal(dirResult.checked, 2)
        assert.deepEqual(dirResult.strategies, ['Eager'])
        assert.deepEqual(dirResult.componentFiles, [
            { file: 'rdp-plugin/src/ok.ts', count: 1, strategies: ['Eager'] },
            { file: 'rdp-plugin/src/sub/bad.ts', count: 1, strategies: [] },
        ])
        assert.equal(dirResult.issues.length, 1)
        assert.match(
            dirResult.issues[0],
            /^rdp-plugin\/src\/sub\/bad\.ts:3: @Component is missing an explicit changeDetection property/,
        )

        const failRun = spawnSync(process.execPath, [CLI_PATH, tmp], { cwd: REPO_ROOT, encoding: 'utf8' })
        assert.notEqual(failRun.status, 0, 'expected non-zero exit code on failing temp tree')
        assert.match(failRun.stderr, /Component changeDetection check failed:/)
        assert.match(
            failRun.stderr,
            /rdp-plugin\/src\/sub\/bad\.ts:3: @Component is missing an explicit changeDetection property/,
        )
        assert.doesNotMatch(failRun.stderr, /types\.d\.ts/)
        assert.doesNotMatch(failRun.stderr, /notes\.txt/)
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
    }
})

test('accepts canonical Eager and OnPush across LF, CRLF, multi-line imports, comments, and nested objects', () => {
    const lf = [
        'import {',
        '    ChangeDetectionStrategy,',
        '    Component,',
        "} from '@angular/core'",
        '@Component({',
        "    selector: 'app-eager',",
        "    template: 'changeDetection',",
        "    // apostrophe can't break comment stripping",
        "    host: { '[class.a]': 'true' },",
        '    changeDetection: ChangeDetectionStrategy.Eager, // trailing note',
        '})',
        'export class EagerComponent {}',
        '',
        '@Component({',
        "    selector: 'app-onpush',",
        '    changeDetection: ChangeDetectionStrategy.OnPush',
        '})',
        'export class OnPushComponent {}',
        '',
    ].join('\n')
    const expected = { checked: 2, strategies: ['Eager', 'OnPush'], issues: [] }
    assert.deepEqual(findComponentChangeDetectionIssues(lf, 'valid.ts'), expected)
    assert.deepEqual(findComponentChangeDetectionIssues(lf.replaceAll('\n', '\r\n'), 'valid.ts'), expected)
})

test('rejects missing changeDetection with exact line (LF and CRLF) even when present in comments, strings, or nested objects', () => {
    const lf = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        "    selector: 'ok',",
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        '})',
        'export class First {}',
        '',
        '@Component({',
        "    selector: 'missing',",
        '    // changeDetection: ChangeDetectionStrategy.Eager,',
        '    /*',
        '    changeDetection: ChangeDetectionStrategy.OnPush,',
        '    */',
        '    template: `',
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        '`,',
        '    host: {',
        '        changeDetection: ChangeDetectionStrategy.Eager,',
        '    },',
        '    providers: [{ provide: X, useValue: { changeDetection: ChangeDetectionStrategy.Eager } }],',
        '})',
        'export class Second {}',
    ].join('\n')
    const lfResult = findComponentChangeDetectionIssues(lf, 'sample.ts')
    assert.equal(lfResult.checked, 2)
    assert.deepEqual(lfResult.strategies, ['Eager'])
    assert.equal(lfResult.issues.length, 1)
    assert.match(lfResult.issues[0], /^sample\.ts:8: @Component is missing an explicit changeDetection property/)

    const crlfResult = findComponentChangeDetectionIssues(lf.replaceAll('\n', '\r\n'), 'sample.ts')
    assert.deepEqual(crlfResult, lfResult)
})

test('rejects Default, invalid expressions, duplicates, spreads, and computed keys', () => {
    const deprecated = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        "    selector: 'x',",
        '    changeDetection: ChangeDetectionStrategy.Default,',
        '})',
        'export class DefaultComponent {}',
    ].join('\n')
    const depRes = findComponentChangeDetectionIssues(deprecated, 'dep.ts')
    assert.equal(depRes.checked, 1)
    assert.deepEqual(depRes.strategies, [])
    assert.deepEqual(depRes.issues, [
        'dep.ts:4: @Component changeDetection must be ChangeDetectionStrategy.Eager or ChangeDetectionStrategy.OnPush',
    ])

    const numeric = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        '    changeDetection: 1,',
        '})',
    ].join('\n')
    assert.match(findComponentChangeDetectionIssues(numeric, 'num.ts').issues[0], /^num\.ts:3: @Component changeDetection must be/)

    const shorthand = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        'const changeDetection = ChangeDetectionStrategy.Eager',
        '@Component({',
        '    changeDetection,',
        '})',
    ].join('\n')
    assert.match(findComponentChangeDetectionIssues(shorthand, 'short.ts').issues[0], /^short\.ts:4: @Component changeDetection must be/)

    const sameLineProp = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        "    selector: 'x', changeDetection: ChangeDetectionStrategy.Eager,",
        '})',
    ].join('\n')
    assert.match(findComponentChangeDetectionIssues(sameLineProp, 'same.ts').issues[0], /^same\.ts:3: @Component changeDetection must be/)

    const duplicate = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        "    selector: 'dup',",
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        '    changeDetection: ChangeDetectionStrategy.OnPush,',
        '})',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(duplicate, 'dup.ts').issues, [
        'dup.ts:2: @Component declares changeDetection more than once',
    ])

    const quotedDupSingle = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        "    'changeDetection': ChangeDetectionStrategy.Default,",
        '})',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(quotedDupSingle, 'qdup1.ts').issues, [
        'qdup1.ts:2: @Component declares changeDetection more than once',
    ])

    const quotedDupDouble = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        '    "changeDetection": ChangeDetectionStrategy.Default,',
        '})',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(quotedDupDouble, 'qdup2.ts').issues, [
        'qdup2.ts:2: @Component declares changeDetection more than once',
    ])

    const spread = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        '    ...meta,',
        '})',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(spread, 'spread.ts').issues, [
        'spread.ts:2: @Component must not use object spread (...)',
    ])

    const computed = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        "    ['changeDetection']: ChangeDetectionStrategy.Default,",
        '})',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(computed, 'comp.ts').issues, [
        'comp.ts:2: @Component must not use computed property keys',
    ])

    const nestedComputed = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        '    [keys[0]]: ChangeDetectionStrategy.Default,',
        '})',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(nestedComputed, 'comp2.ts').issues, [
        'comp2.ts:2: @Component must not use computed property keys',
    ])
})

test('rejects non-canonical @Component forms, aliased imports, and delimiter-splitting bypasses', () => {
    const oneLine = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        "@Component({ selector: 'x', changeDetection: ChangeDetectionStrategy.Eager })",
        'export class OneLine {}',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(oneLine, 'one.ts').issues, [
        'one.ts:2: @Component must use canonical multi-line @Component({ ... }) form',
    ])

    const dynamic = [
        "import { Component } from '@angular/core'",
        '@Component(meta)',
        'export class Dynamic {}',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(dynamic, 'dyn.ts').issues, [
        'dyn.ts:2: @Component must use canonical multi-line @Component({ ... }) form',
    ])

    const namespaced = [
        "import * as ng from '@angular/core'",
        '@ng.Component({',
        '    changeDetection: ng.ChangeDetectionStrategy.Eager,',
        '})',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(namespaced, 'ns.ts').issues, [
        'ns.ts:2: @Component must use canonical multi-line @Component({ ... }) form',
    ])

    const indented = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        'function make () {',
        '    @Component({',
        '        changeDetection: ChangeDetectionStrategy.Eager,',
        '})',
        '    class Inner {}',
        '    return Inner',
        '}',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(indented, 'indent.ts').issues, [
        'indent.ts:3: @Component must use canonical multi-line @Component({ ... }) form',
    ])

    const aliasedImport = [
        "import { ChangeDetectionStrategy, Component as NgComponent } from '@angular/core'",
        '@NgComponent({',
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        '})',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(aliasedImport, 'alias.ts').issues, [
        'alias.ts:1: @angular/core Component import must not be aliased',
    ])

    const unterminatedSwallow = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        "    selector: 'broken',",
        'export class Broken {}',
        '@Component({',
        "    selector: 'good',",
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        '})',
        'export class Good {}',
    ].join('\n')
    const swallowRes = findComponentChangeDetectionIssues(unterminatedSwallow, 'swallow.ts')
    assert.equal(swallowRes.checked, 2)
    assert.deepEqual(swallowRes.issues, [
        'swallow.ts:2: @Component must use canonical multi-line @Component({ ... }) form',
    ])

    const templateSplit = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        '    template: `',
        '})',
        '`,',
        '    changeDetection: ChangeDetectionStrategy.Default,',
        '})',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(templateSplit, 'tpl-split.ts').issues, [
        'tpl-split.ts:2: @Component block has malformed syntax or unbalanced delimiters',
    ])

    const nestedBacktick = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        '    template: `${`',
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        '`}`,',
        '})',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(nestedBacktick, 'nested-bt.ts').issues, [
        'nested-bt.ts:2: @Component block has malformed syntax or unbalanced delimiters',
    ])

    const commentSplit = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        '    /*',
        '})',
        '    */',
        '    changeDetection: ChangeDetectionStrategy.Default,',
        '})',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(commentSplit, 'cmt-split.ts').issues, [
        'cmt-split.ts:2: @Component block has malformed syntax or unbalanced delimiters',
    ])

    const braceSplit = [
        "import { ChangeDetectionStrategy, Component } from '@angular/core'",
        '@Component({',
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        '    extra: wrap({',
        '        a: 1,',
        '})',
        '    ,',
        '    changeDetection: ChangeDetectionStrategy.Default,',
        '})',
    ].join('\n')
    assert.deepEqual(findComponentChangeDetectionIssues(braceSplit, 'brace-split.ts').issues, [
        'brace-split.ts:2: @Component block has malformed syntax or unbalanced delimiters',
    ])
})

test('catches invalid @Component after tricky preceding TypeScript syntax', () => {
    const tricky = [
        "import { Component } from '@angular/core'",
        "if (x) /'/.test(y)",
        "const tpl = `${/'/.test(x)}`",
        "const half = w! / 2 // don't break parsing",
        'const actions = { import: () => {} }',
        "export { ChangeDetectionStrategy } from '@angular/core'",
        '',
        '@Component({',
        "    selector: 'after-tricky-missing',",
        '})',
        'export class MissingAfterTricky {}',
        '',
        '@Component({',
        "    selector: 'after-tricky-reexport',",
        '    changeDetection: ChangeDetectionStrategy.Eager,',
        '})',
        'export class ReexportAfterTricky {}',
    ].join('\n')
    const res = findComponentChangeDetectionIssues(tricky, 'tricky.ts')
    assert.equal(res.checked, 2)
    assert.deepEqual(res.strategies, [])
    assert.deepEqual(res.issues, [
        'tricky.ts:8: @Component is missing an explicit changeDetection property (use ChangeDetectionStrategy.Eager or ChangeDetectionStrategy.OnPush)',
        "tricky.ts:15: @Component changeDetection requires a value import of ChangeDetectionStrategy from '@angular/core'",
    ])
})

test('requires a runtime value import of ChangeDetectionStrategy from @angular/core', () => {
    const cases = [
        ['missing.ts', "import { Component } from '@angular/core'"],
        ['type-only.ts', "import type { ChangeDetectionStrategy } from '@angular/core'\nimport { Component } from '@angular/core'"],
        ['inline-type.ts', "import { Component, type ChangeDetectionStrategy } from '@angular/core'"],
        ['reexport.ts', "import './polyfill'\nexport { ChangeDetectionStrategy } from '@angular/core'\nimport { Component } from '@angular/core'"],
        ['other-pkg.ts', "import { ChangeDetectionStrategy } from 'other-pkg'\nimport { Component } from '@angular/core'"],
        ['aliased-cd.ts', "import { Component, ChangeDetectionStrategy as CD } from '@angular/core'"],
    ]
    for (const [name, header] of cases) {
        const src = [
            header,
            '@Component({',
            "    selector: 'x',",
            '    changeDetection: ChangeDetectionStrategy.Eager,',
            '})',
            'export class Sample {}',
        ].join('\n')
        const res = findComponentChangeDetectionIssues(src, name)
        assert.equal(res.checked, 1, name)
        assert.deepEqual(res.strategies, [], name)
        assert.equal(res.issues.length, 1, name)
        assert.match(res.issues[0], /requires a value import of ChangeDetectionStrategy from '@angular\/core'/, name)
    }
})

test('fails closed when rdp-plugin/src is missing or contains zero @Component decorators', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paddy-rdp-cd-empty-'))
    try {
        assert.throws(
            () => checkComponentChangeDetection(tmp),
            /Expected plugin source directory does not exist: rdp-plugin\/src/,
        )
        const srcDir = path.join(tmp, 'rdp-plugin', 'src')
        fs.mkdirSync(srcDir, { recursive: true })
        fs.writeFileSync(path.join(srcDir, 'empty.ts'), 'export const value = 1\n')
        fs.writeFileSync(path.join(srcDir, 'ignored.d.ts'), '@Component({})\nexport declare class X {}\n')
        const emptyResult = checkComponentChangeDetection(tmp)
        assert.equal(emptyResult.checked, 0)
        assert.deepEqual(emptyResult.issues, ['No @Component decorators found under rdp-plugin/src'])
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
    }
})
