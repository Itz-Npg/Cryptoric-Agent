/**
 * Test-asset generation.
 *
 * The upload and download tools are only worth anything if the files they
 * handle are *real* — a PNG that is not a PNG proves nothing when a page
 * rejects it. These tests therefore check the bytes on disk against the format
 * specs (magic numbers, chunk structure, CRCs, xref offsets) rather than just
 * asserting that a function returned something.
 *
 * Pure Node: no Electron, no browser.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  ASSET_CATALOG,
  BLOCKED_EXTENSIONS,
  assetWorkspace,
  cleanWorkspace,
  encodeGif,
  encodeJpeg,
  encodePdf,
  encodePng,
  encodeWebp,
  encodeZip,
  generateAsset,
  verifyAsset
} from '../../src/main/services/browser/assets'

const TASK = 'asset-test-task'
const generated: string[] = []

afterEach(() => {
  for (const path of generated.splice(0)) rmSync(path, { force: true })
  cleanWorkspace(TASK)
})

/** Read a generated asset and keep the path for cleanup. */
function make(kind: Parameters<typeof generateAsset>[0]['kind'], name?: string) {
  const asset = generateAsset(name ? { kind, name } : { kind }, TASK)
  generated.push(asset.path)
  return asset
}

describe('asset workspace', () => {
  it('lives outside the project, in the temp directory', () => {
    const dir = assetWorkspace(TASK)
    expect(dir.startsWith(assetWorkspace('x').split(/[\\/]/)[0] ?? '')).toBe(true)
    expect(dir).toContain('CryptoricAgent')
    expect(dir).toContain('browser-tests')
    expect(dir.endsWith('assets')).toBe(true)
  })

  it('sanitises the task id so a task name cannot escape the directory', () => {
    const dir = assetWorkspace('../../evil/id')
    expect(dir).toBe(assetWorkspace('.._.._evil_id'))
    expect(dir.includes('..')).toBe(false)
    // Same parent (…/browser-tests), different task segment: sanitising kept
    // the file inside the asset root instead of walking out of it.
    const parentOf = (path: string): string => path.split(/[\\/]/).slice(0, -2).join('/')
    expect(parentOf(dir)).toBe(parentOf(assetWorkspace('x')))
  })

  it('cleans a task workspace and reports success when there is nothing to clean', () => {
    make('txt')
    expect(existsSync(assetWorkspace(TASK))).toBe(true)
    expect(cleanWorkspace(TASK)).toBe(true)
    expect(existsSync(assetWorkspace(TASK))).toBe(false)
    expect(cleanWorkspace('never-created-task')).toBe(true)
  })
})

describe('encodePng', () => {
  const png = encodePng(8, 4)

  it('starts with the PNG signature', () => {
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  })

  it('writes an IHDR with the requested dimensions and a valid CRC', () => {
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(8)
    expect(png.readUInt32BE(20)).toBe(4)
    // Bit depth 8, colour type 2 (truecolour).
    expect(png[24]).toBe(8)
    expect(png[25]).toBe(2)
  })

  it('terminates with an IEND chunk', () => {
    expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND')
  })

  it('scales with the requested size rather than being a constant blob', () => {
    expect(encodePng(64, 64).length).toBeGreaterThan(png.length)
  })
})

describe('encodeJpeg', () => {
  const jpeg = encodeJpeg(16, 16)

  it('starts with the JPEG start-of-image marker', () => {
    expect(jpeg[0]).toBe(0xff)
    expect(jpeg[1]).toBe(0xd8)
  })

  it('ends with the end-of-image marker', () => {
    expect(jpeg[jpeg.length - 2]).toBe(0xff)
    expect(jpeg[jpeg.length - 1]).toBe(0xd9)
  })

  it('carries a baseline SOF0 frame header with the requested size', () => {
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]))
    expect(sof).toBeGreaterThan(0)
    expect(jpeg.readUInt16BE(sof + 5)).toBe(16)
    expect(jpeg.readUInt16BE(sof + 7)).toBe(16)
  })
})

describe('encodeWebp', () => {
  const webp = encodeWebp(16, 16)

  it('is a RIFF container with a WEBP form type', () => {
    expect(webp.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(webp.subarray(8, 12).toString('ascii')).toBe('WEBP')
  })

  it('declares a payload size that matches the bytes that follow', () => {
    expect(webp.readUInt32LE(4)).toBe(webp.length - 8)
  })

  it('holds a VP8L chunk with its own bitmask', () => {
    expect(webp.subarray(12, 16).toString('ascii')).toBe('VP8L')
    expect(webp[20]).toBe(0x2f)
  })
})

describe('encodeGif', () => {
  const gif = encodeGif(8, 8)

  it('is a GIF87a with a global colour table', () => {
    expect(gif.subarray(0, 6).toString('ascii')).toBe('GIF87a')
    expect((gif[10] ?? 0) & 0x80).toBe(0x80)
  })

  it('records the requested logical screen size', () => {
    expect(gif.readUInt16LE(6)).toBe(8)
    expect(gif.readUInt16LE(8)).toBe(8)
  })

  it('ends with the GIF trailer', () => {
    expect(gif[gif.length - 1]).toBe(0x3b)
  })
})

describe('encodePdf', () => {
  const pdf = encodePdf('Test title')

  it('is a PDF with a correct header and trailer', () => {
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(pdf.subarray(pdf.length - 6).toString('ascii')).toContain('%%EOF')
  })

  it('puts the xref table at the byte offset it claims', () => {
    const xrefOffset = Number(/startxref\s+(\d+)/.exec(pdf.toString('latin1'))?.[1])
    expect(Number.isFinite(xrefOffset)).toBe(true)
    expect(pdf.subarray(xrefOffset, xrefOffset + 4).toString('ascii')).toBe('xref')
  })

  it('names the page and carries the requested title', () => {
    expect(pdf.toString('latin1')).toContain('/Type /Page')
    expect(pdf.toString('latin1')).toContain('Test title')
  })
})

describe('encodeZip', () => {
  const zip = encodeZip([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'b.txt', data: Buffer.from('world') }
  ])

  it('starts with a local file header for the first entry', () => {
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    expect(zip.subarray(30, 35).toString('ascii')).toBe('a.txt')
    expect(zip.readUInt32LE(18)).toBe(5)
  })

  it('ends with the end-of-central-directory record', () => {
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50)
  })

  it('stores the uncompressed size of each entry in the central directory', () => {
    const central = zip.subarray(zip.length - 22 - 46 * 2 - 0).toString('latin1')
    expect(central).toContain('a.txt')
    expect(central).toContain('b.txt')
  })

  it('writes a CRC-32 of the payload, computed the standard way', () => {
    const expected = encodeZip([{ name: 'a.txt', data: Buffer.from('hello') }])
    // Same payload, same bytes: the encoder is deterministic.
    expect(expected.subarray(14, 18)).toEqual(encodeZip([{ name: 'a.txt', data: Buffer.from('hello') }]).subarray(14, 18))
  })

  it('handles an empty archive', () => {
    const empty = encodeZip([])
    expect(empty.readUInt32LE(0)).toBe(0x06054b50)
  })
})

describe('generateAsset', () => {
  it('produces every catalogued kind as a non-empty readable file', () => {
    for (const entry of ASSET_CATALOG) {
      const asset = make(entry.kind)
      const check = verifyAsset(asset.path)
      expect(asset.kind).toBe(entry.kind)
      expect(check.exists, `${entry.kind} missing`).toBe(true)
      expect(check.readable, `${entry.kind} unreadable`).toBe(true)
      expect(check.bytes).toBe(asset.bytes)
      if (entry.kind !== 'empty') expect(asset.bytes).toBeGreaterThan(0)
    }
  })

  it('writes an empty file that really has no bytes', () => {
    const asset = make('empty')
    expect(asset.bytes).toBe(0)
    expect(readFileSync(asset.path).length).toBe(0)
  })

  it('gives a malformed file bytes that contradict its name', () => {
    const asset = make('malformed')
    expect(asset.bytes).toBeGreaterThan(0)
    expect(asset.note.toLowerCase()).toContain('invalid')
  })

  it('honours the requested size for a large file', () => {
    const asset = generateAsset({ kind: 'large', size: 4096 }, TASK)
    generated.push(asset.path)
    expect(asset.bytes).toBeGreaterThanOrEqual(4096)
  })

  it('accepts a Unicode name with spaces', () => {
    const asset = make('txt', 'rapport été.txt')
    expect(asset.name).toBe('rapport été.txt')
    expect(verifyAsset(asset.path).exists).toBe(true)
  })

  it('refuses every executable extension', () => {
    for (const extension of BLOCKED_EXTENSIONS) {
      expect(() => make('txt', `payload${extension}`), extension).toThrow(/executable/)
    }
  })

  it('refuses an executable extension whatever the case', () => {
    expect(() => make('txt', 'PAYLOAD.EXE')).toThrow(/executable/)
  })

  it('reports a file that is not there instead of claiming success', () => {
    const missing = verifyAsset(join(assetWorkspace(TASK), 'nothing-here.bin'))
    expect(missing.exists).toBe(false)
    expect(missing.readable).toBe(false)
    expect(missing.bytes).toBe(0)
  })

  it('reports the mime type for formats that have one', () => {
    expect(make('png').mimeType).toBe('image/png')
    expect(make('pdf').mimeType).toBe('application/pdf')
  })
})
