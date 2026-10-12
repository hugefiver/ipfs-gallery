import { describe, expect, it } from 'vitest'
import { parseManifest } from '../../src/core/manifest'
import { DEFAULT_LIMITS } from '../../src/shared/limits'
import { ROOT, OTHER, ref, utf8 } from './fixtures'

const manifest = ref(ROOT, 'album', 'gallery.json')
describe('bounded version 1 manifest interpretation', () => {
  it('gives JSON, YAML and TOML equivalent items and editorial data', () => {
    const sources = [
      ['json', JSON.stringify({ version: 1, title: '花', description: '<b>text</b>', items: [{ path: '../images/a.png', title: '春', alt: '花瓣', tags: ['red'], type: 'image', width: 2, height: 3, thumbnail: { cid: OTHER, path: 'small.png' } }] })],
      ['yaml', `version: 1\ntitle: 花\ndescription: <b>text</b>\nitems:\n  - path: ../images/a.png\n    title: 春\n    alt: 花瓣\n    tags: [red]\n    type: image\n    width: 2\n    height: 3\n    thumbnail:\n      cid: ${OTHER}\n      path: small.png\n`],
      ['toml', `version = 1\ntitle = "花"\ndescription = "<b>text</b>"\n[[items]]\npath = "../images/a.png"\ntitle = "春"\nalt = "花瓣"\ntags = ["red"]\ntype = "image"\nwidth = 2\nheight = 3\n[items.thumbnail]\ncid = "${OTHER}"\npath = "small.png"`],
    ] as const
    const values = sources.map(([format, text]) => parseManifest(utf8(text), ref(ROOT, 'album', `gallery.${format}`), DEFAULT_LIMITS))
    const editorial = values.map((result) => ({ ...result, items: result.items.map((item) => ({ ...item, id: '', sourceLabel: '' })) }))
    expect(editorial[0]).toEqual(editorial[1]); expect(editorial[1]).toEqual(editorial[2])
    expect(values[0]!.items[0]!.ref).toEqual(ref(ROOT, 'images', 'a.png'))
    expect(values[0]!.items[0]!.thumbnail).toEqual(ref(OTHER, 'small.png'))
    expect(values[0]!.description).toBe('<b>text</b>')
  })
  it.each([
    JSON.stringify({ version: 1, items: [{ cid: OTHER }] }),
    `version = 1\n[[items]]\ncid = "${OTHER}"`,
    `version: 1\nitems:\n  - cid: ${OTHER}`,
  ])('recognizes extensionless metadata only after complete schema validation', (text) => {
    expect(parseManifest(utf8(text), ref(ROOT), DEFAULT_LIMITS).items[0]!.ref).toEqual(ref(OTHER))
  })
  it('resolves parent-relative and explicit-CID paths without URI decoding', () => {
    const value = parseManifest(utf8(JSON.stringify({ version: 1, items: [
      { path: './photos/../a%2Fb' }, { cid: OTHER, path: 'photos/../z' },
    ] })), manifest, DEFAULT_LIMITS)
    expect(value.items.map((item) => item.ref)).toEqual([ref(ROOT, 'album', 'a%2Fb'), ref(OTHER, 'z')])
  })
  it('retains separate editorial items with deterministic, distinct IDs', () => {
    const bytes = utf8(JSON.stringify({ version: 1, items: [{ cid: OTHER, title: 'one' }, { cid: OTHER, title: 'two' }] }))
    const first = parseManifest(bytes, manifest, DEFAULT_LIMITS)
    expect(first).toEqual(parseManifest(bytes, manifest, DEFAULT_LIMITS))
    expect(new Set(first.items.map((item) => item.id)).size).toBe(2)
  })
  it('uses the known extension exclusively', () => {
    expect(() => parseManifest(utf8('version: 1\nitems: []'), manifest, DEFAULT_LIMITS)).toThrow()
  })
  it.each([
    { version: 2, items: [] }, { version: 1, items: [], surprise: true }, { version: 1 },
    { version: 1, items: [{ path: '../../escape' }] }, { version: 1, items: [{ path: '/absolute' }] },
    { version: 1, items: [{ path: 'https://example.org/a' }] }, { version: 1, items: [{ path: 'a//b' }] },
    { version: 1, items: [{ cid: `${OTHER}/p` }] }, { version: 1, items: [{ path: 'a', width: 1 }] },
    { version: 1, items: [{ path: 'a', width: 1.5, height: 1 }] },
    { version: 1, items: [{ path: 'a', type: 'svg' }] }, { version: 1, items: [{ path: 'a', surprise: 1 }] },
    { version: 1, items: [{ path: 'a', thumbnail: { path: 'javascript:alert(1)' } }] },
    { version: 1, items: [{ path: 'a', tags: Array(21).fill('x') }] },
    { version: 1, title: 'x'.repeat(201), items: [] },
  ])('rejects invalid schema and unsafe references %#', (value) => {
    expect(() => parseManifest(utf8(JSON.stringify(value)), manifest, DEFAULT_LIMITS)).toThrow()
  })
  it('does not invent a parent for a bare metadata file CID, including thumbnails', () => {
    expect(() => parseManifest(utf8('{"version":1,"items":[{"path":"a"}]}'), ref(ROOT), DEFAULT_LIMITS)).toThrow()
    expect(() => parseManifest(utf8(JSON.stringify({ version: 1, items: [{ cid: OTHER, thumbnail: { path: 'a' } }] })), ref(ROOT), DEFAULT_LIMITS)).toThrow()
  })
  it.each([
    ['json', '{"version":1,"items":[],"__proto__":{"polluted":true}}'],
    ['yaml', 'version: 1\nitems: []\nconstructor: {prototype: {polluted: true}}'],
    ['toml', 'version = 1\nitems = []\n__proto__ = { polluted = true }'],
    ['yaml', 'version: 1\nitems: &a [*a]'],
    ['yaml', `version: 1\nitems:\n - cid: !unsafe ${OTHER}`],
    ['yaml', 'version: 1\nversion: 1\nitems: []'],
    ['yaml', 'version: 1\nitems: []\n---\nversion: 1\nitems: []'],
  ])('rejects unsafe %s parser structures', (extension, source) => {
    expect(() => parseManifest(utf8(source), ref(ROOT, `gallery.${extension}`), DEFAULT_LIMITS)).toThrow()
    expect(Object.prototype).not.toHaveProperty('polluted')
  })
  it('bounds bytes, parse depth, nodes, arrays and item counts', () => {
    const empty = utf8('{"version":1,"items":[]}')
    expect(() => parseManifest(empty, manifest, { ...DEFAULT_LIMITS, maxManifestBytes: 4 })).toThrow()
    expect(() => parseManifest(empty, manifest, { ...DEFAULT_LIMITS, maxManifestNodes: 2 })).toThrow()
    const deep = utf8(JSON.stringify({ version: 1, items: [{ path: 'a', thumbnail: { cid: OTHER } }] }))
    expect(() => parseManifest(deep, manifest, { ...DEFAULT_LIMITS, maxManifestDepth: 2 })).toThrow()
    expect(() => parseManifest(utf8('{"version":1,"items":[{"path":"a"},{"path":"b"}]}'), manifest, { ...DEFAULT_LIMITS, maxItems: 1 })).toThrow()
    expect(() => parseManifest(new Uint8Array([255, 254, 0]), manifest, DEFAULT_LIMITS)).toThrow()
  })
  it('reports parser-native TOML depth exhaustion as a resource limit', () => {
    const source = `version = 1\nitems = ${'['.repeat(18)}0${']'.repeat(18)}`
    expect(() => parseManifest(utf8(source), ref(ROOT, 'gallery.toml'), DEFAULT_LIMITS))
      .toThrow(expect.objectContaining({ error: expect.objectContaining({ code: 'LIMIT' }) }))
  })
})
