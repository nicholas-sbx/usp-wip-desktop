// npm test: fails if a source file contains invisible format characters
// (bidi overrides, zero-width characters...), which can make code read
// differently from what it does ("Trojan Source"). Use \u escapes instead.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = new URL('.', import.meta.url).pathname
const INVISIBLE = /\p{Cf}/u

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (/\.(m?js|vue|html|css)$/.test(entry.name)) yield path
  }
}

test('no invisible format characters in source files', () => {
  const offenders = []
  for (const file of sourceFiles(ROOT)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const m = line.match(INVISIBLE)
        if (m) offenders.push(`${file}:${i + 1} U+${m[0].codePointAt(0).toString(16)}`)
      })
  }
  assert.deepEqual(offenders, [])
})
