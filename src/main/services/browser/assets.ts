/**
 * Test asset generator.
 *
 * Every asset is produced locally and deterministically. Nothing is downloaded,
 * because an upload test does not need a real photograph — it needs a file with
 * the right bytes — and fetching one would put a third party in the middle of a
 * test that Cryptoric can run offline.
 *
 * Two rules shape the output:
 *
 *  - **Nothing goes in the user's project.** Assets live under the application
 *    temp directory, per task, and are removed when the task ends. A generated
 *    fixture in a working tree is a commit someone did not ask for.
 *  - **Bytes are predictable.** The same request produces the same file, so a
 *    test that passes once passes again, and a byte-level upload checksum is
 *    reproducible.
 */

import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, rmSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Extensions the generator will never produce.
 *
 * An upload test that silently hands a page an executable is a security test
 * nobody asked for. Refusing at the source is the only place this can be
 * guaranteed, because by the time a file exists on disk it is already a file
 * someone could pass to `browser_upload_file`.
 */
export const BLOCKED_EXTENSIONS = [
  '.exe', '.scr', '.bat', '.cmd', '.com', '.pif', '.msi', '.msp',
  '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.hta', '.cpl', '.jar', '.app', '.dmg', '.pkg', '.deb', '.rpm', '.apk'
]

export interface GeneratedAsset {
  path: string
  name: string
  kind: AssetKind
  bytes: number
  mimeType: string
  /** A short, stable description the agent can reason about. */
  note: string
}

export type AssetKind =
  | 'png' | 'jpg' | 'webp' | 'svg' | 'gif'
  | 'txt' | 'csv' | 'json' | 'xml' | 'pdf' | 'zip'
  | 'empty' | 'malformed' | 'large'

export interface AssetRequest {
  kind: AssetKind
  /** Overrides the default file name. Unicode and spaces are permitted. */
  name?: string
  /** Pixel dimensions for raster formats. */
  width?: number
  height?: number
  /** Bytes for `large`; rows for `csv`; characters for `txt`. */
  size?: number
}

const MIME: Record<AssetKind, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  empty: 'application/octet-stream',
  malformed: 'application/octet-stream',
  large: 'application/octet-stream'
}

const EXTENSION: Record<AssetKind, string> = {
  png: '.png',
  jpg: '.jpg',
  webp: '.webp',
  svg: '.svg',
  gif: '.gif',
  txt: '.txt',
  csv: '.csv',
  json: '.json',
  xml: '.xml',
  pdf: '.pdf',
  zip: '.zip',
  empty: '.bin',
  malformed: '.bin',
  large: '.bin'
}

/** Per-task workspace for generated assets. Never inside a project. */
export function assetWorkspace(taskId = 'adhoc'): string {
  const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'adhoc'
  return join(tmpdir(), 'CryptoricAgent', 'browser-tests', safe, 'assets')
}

export function ensureWorkspace(taskId?: string): string {
  const dir = assetWorkspace(taskId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Remove a task's asset workspace. Safe to call when it does not exist. */
export function cleanWorkspace(taskId = 'adhoc'): boolean {
  const dir = assetWorkspace(taskId)
  if (!existsSync(dir)) return true
  try {
    rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i] ?? 0
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * A minimal, valid PNG with a recognisable gradient.
 *
 * Written by hand rather than through an encoder so the bytes are identical on
 * every machine, and small enough that generating a dozen is free.
 */
export function encodePng(width = 64, height = 64): Buffer {
  const raw = Buffer.alloc(height * (width * 3 + 1))
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0 // filter type: none
    offset += 1
    for (let x = 0; x < width; x += 1) {
      raw[offset] = (x * 255) / Math.max(1, width - 1)
      raw[offset + 1] = (y * 255) / Math.max(1, height - 1)
      raw[offset + 2] = 128
      offset += 3
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const parts: Buffer[] = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    // PNG carries a zlib stream (RFC 1950), not a raw DEFLATE one: a two-byte
    // header and an Adler-32 trailer are part of the format, and a decoder
    // rejects the file without them.
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]
  return Buffer.concat(parts)
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * A baseline JPEG built from a constant-colour frame.
 *
 * A hand-assembled baseline frame rather than a full encoder: the point is a
 * file the browser accepts as `image/jpeg`, not photographic quality.
 */
export function encodeJpeg(width = 32, height = 32): Buffer {
  const quant = Buffer.alloc(64).fill(0x10)
  const segments: Buffer[] = [
    Buffer.from([0xff, 0xd8]),
    jfifSegment(),
    // Quantisation table (luminance), the frame header, then the two Huffman
    // tables the scan header will refer to: DC class 0 and AC class 1.
    tableSegment(0xdb, 0x00, quant),
    sof0Segment(width, height),
    tableSegment(0xc4, 0x00, makeHuffmanTable()),
    tableSegment(0xc4, 0x10, makeHuffmanTable()),
    sosSegment()
  ]

  // Entropy-coded data. Every block here encodes as "DC difference zero, end of
  // block", which is one bit of each Huffman code per MCU — so a run of zero
  // bytes is the bit pattern for a flat mid-grey block. A 0xFF byte would be
  // read as a marker, so the run is terminated with EOI instead of padding.
  const mcus = Math.max(1, Math.ceil(width / 8) * Math.ceil(height / 8))
  segments.push(Buffer.concat([Buffer.alloc(mcus, 0x00), Buffer.from([0xff, 0xd9])]))
  return Buffer.concat(segments)
}

function jfifSegment(): Buffer {
  const body = Buffer.from([
    0x4a, 0x46, 0x49, 0x46, 0x00, // JFIF\0
    0x01, 0x01,                   // version 1.1
    0x00,                         // no density units
    0x00, 0x01, 0x00, 0x01,       // x/y density
    0x00, 0x00                    // no thumbnail
  ])
  return markerSegment(0xe0, body)
}

function tableSegment(marker: number, tableClass: number, payload: Buffer): Buffer {
  return markerSegment(marker, Buffer.concat([Buffer.from([tableClass]), payload]))
}

function sof0Segment(width: number, height: number): Buffer {
  // precision + height + width + component count + one 3-byte component
  // descriptor. Allocating more than that leaves trailing bytes that a decoder
  // reads as further components, which is how a "valid" JPEG becomes undecodable.
  const body = Buffer.alloc(9)
  body[0] = 8 // sample precision
  body.writeUInt16BE(height, 1)
  body.writeUInt16BE(width, 3)
  body[5] = 1 // one component
  body[6] = 1 // component id
  body[7] = 0x11 // quant table 0
  body[8] = 0 // no chroma subsampling
  return markerSegment(0xc0, body)
}

/**
 * Start of scan.
 *
 * The component's byte is `DC table << 4 | AC table`, and it has to name tables
 * that actually exist: the DC table was defined in class 0 and the AC table in
 * class 1, so the byte must be 0x10. Pointing it at AC table 0 — which was never
 * defined — is what turns a structurally perfect JPEG into one no decoder will
 * open.
 */
function sosSegment(): Buffer {
  const body = Buffer.from([0x01, 0x01, 0x10, 0x00, 0x3f, 0x00])
  return markerSegment(0xda, body)
}

function markerSegment(marker: number, body: Buffer): Buffer {
  const length = Buffer.alloc(2)
  length.writeUInt16BE(body.length + 2, 0)
  return Buffer.concat([Buffer.from([0xff, marker]), length, body])
}

/**
 * A JPEG Huffman table of the shape a decoder will accept.
 *
 * One code per bit length 1..15, so the table needs fifteen symbols rather than
 * sixteen; `counts[0]` must stay zero because an all-ones code is not a legal
 * prefix.
 */
function makeHuffmanTable(): Buffer {
  const counts = Buffer.alloc(16)
  counts.fill(1, 1, 16)
  const symbols = Buffer.alloc(15)
  for (let i = 0; i < 15; i += 1) symbols[i] = i
  return Buffer.concat([counts, symbols])
}

/**
 * Little-endian bit writer.
 *
 * VP8L packs its header and its entropy stream least-significant-bit first,
 * which is the opposite of every other format here; getting it wrong produces a
 * file with a correct `RIFF`/`WEBP` container and an undecodable body.
 */
class BitWriter {
  private readonly bytes: number[] = []
  private current = 0
  private used = 0

  write(value: number, bits: number): void {
    for (let i = 0; i < bits; i += 1) {
      this.current |= ((value >>> i) & 1) << this.used
      this.used += 1
      if (this.used === 8) {
        this.bytes.push(this.current)
        this.current = 0
        this.used = 0
      }
    }
  }

  finish(): Buffer {
    if (this.used > 0) {
      this.bytes.push(this.current)
      this.current = 0
      this.used = 0
    }
    return Buffer.from(this.bytes)
  }
}

/**
 * A WebP file containing a real VP8L lossless bitmap.
 *
 * Hand-assembled rather than guessed at: a file whose header says WebP but whose
 * body is not a valid VP8 stream is rejected by the browser, which is the opposite
 * of what an upload test needs.
 */
export function encodeWebp(width = 32, height = 32): Buffer {
  // RIFF container
  const vp8l = encodeVp8l(width, height)
  const header = Buffer.from('VP8L', 'ascii')
  const chunkSize = Buffer.alloc(4)
  chunkSize.writeUInt32LE(vp8l.length, 0)
  const riffSize = Buffer.alloc(4)
  riffSize.writeUInt32LE(4 + 8 + vp8l.length, 0)
  const riff = Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, Buffer.from('WEBP', 'ascii'), header, chunkSize, vp8l])
  return riff
}

/**
 * A VP8L lossless stream holding a solid colour image.
 *
 * Written from the format description rather than copied from a sample: no
 * transform, no colour cache, no meta-Huffman group, then five "simple" Huffman
 * codes of one symbol each (which encode every pixel as four zero bits), then
 * the pixels themselves.
 */
function encodeVp8l(width: number, height: number): Buffer {
  const w = Math.max(1, Math.min(16384, Math.round(width))) - 1
  const h = Math.max(1, Math.min(16384, Math.round(height))) - 1

  const bits = new BitWriter()
  bits.write(0x2f, 8) // signature
  bits.write(w, 14) // width - 1
  bits.write(h, 14) // height - 1
  bits.write(0, 1) // alpha_is_used
  bits.write(0, 3) // version

  bits.write(0, 1) // no transform
  bits.write(0, 1) // no colour cache
  bits.write(0, 1) // no meta-Huffman image

  // Green+length, red, blue, alpha, distance. A simple code of one symbol
  // costs four bits: simple flag, symbol count minus one, "not 8-bit", symbol.
  for (let alphabet = 0; alphabet < 5; alphabet += 1) {
    bits.write(1, 1)
    bits.write(0, 1)
    bits.write(0, 1)
    bits.write(0, 1)
  }

  // Every pixel is the same solid colour, so each contributes four zero bits.
  const pixels = (w + 1) * (h + 1)
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    bits.write(0, 1) // green
    bits.write(0, 1) // red
    bits.write(0, 1) // blue
    bits.write(0, 1) // alpha
  }
  return bits.finish()
}

/** A valid GIF87a with a two-colour palette and one image block. */
export function encodeGif(width = 16, height = 16): Buffer {
  const header = Buffer.from('GIF87a', 'ascii')
  const screen = Buffer.alloc(7)
  screen.writeUInt16LE(width, 0)
  screen.writeUInt16LE(height, 2)
  screen[4] = 0x80 // global colour table, 2 entries
  screen[5] = 0 // background index
  screen[6] = 0 // aspect ratio

  const palette = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff])

  const descriptor = Buffer.alloc(10)
  descriptor[0] = 0x2c
  descriptor.writeUInt16LE(0, 1)
  descriptor.writeUInt16LE(0, 3)
  descriptor.writeUInt16LE(width, 5)
  descriptor.writeUInt16LE(height, 7)
  descriptor[9] = 0

  // Uncompressed LZW: emit a clear code, then one literal per pixel, then end.
  const minCodeSize = Buffer.from([0x02])
  const pixels: number[] = []
  for (let i = 0; i < width * height; i += 1) pixels.push(i % 2 === 0 ? 0 : 1)

  const bits: number[] = []
  const push = (code: number, size: number): void => {
    for (let b = 0; b < size; b += 1) bits.push((code >> b) & 1)
  }
  let code = 3
  let size = 2
  push(code, size) // clear
  for (const pixel of pixels) {
    push(pixel, size)
    code += 1
    if (code >= 1 << size && size < 12) size += 1
  }
  push(code, size) // end of information

  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let b = 0; b < 8; b += 1) byte |= (bits[i + b] ?? 0) << b
    data.push(byte)
  }
  const blocks: number[] = []
  for (let i = 0; i < data.length; i += 255) {
    const slice = data.slice(i, i + 255)
    blocks.push(slice.length, ...slice)
  }
  blocks.push(0)

  return Buffer.concat([header, screen, palette, descriptor, minCodeSize, Buffer.from(blocks), Buffer.from([0x3b])])
}

/**
 * A structurally valid PDF with one page.
 *
 * The cross-reference table is written with the correct byte offsets, because a
 * PDF with a plausible-looking but wrong xref is rejected by every real reader —
 * including the one an upload validator is likely to use.
 */
export function encodePdf(title = 'Cryptoric test asset'): Buffer {
  const objects: string[] = []
  const body: string[] = ['BT', `/F1 18 Tf`, '72 720 Td', `(${escapePdf(title)}) Tj`, 'ET']

  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>')
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  objects.push(`<< /Length ${body.join('\n').length} >>\nstream\n${body.join('\n')}\nendstream`)

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefAt = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

function escapePdf(text: string): string {
  return text.replace(/([\\()])/g, '\\$1')
}

/**
 * A ZIP archive with stored (uncompressed) entries.
 *
 * The local headers, central directory and end-of-central-directory record all
 * carry correct CRC-32 values, so `unzip`, PowerShell and Explorer agree the
 * archive is intact.
 */
export function encodeZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const crc = crc32(file.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 name flag
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date: 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(file.data.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, file.data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(0, 10)
    entry.writeUInt16LE(0, 12)
    entry.writeUInt16LE(0x21, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(file.data.length, 20)
    entry.writeUInt32LE(file.data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)

    offset += local.length + name.length + file.data.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuffer, end])
}

/** Deterministic pseudo-random bytes: the same size always yields the same file. */
function deterministicBytes(size: number, seed = 'cryptoric'): Buffer {
  const out = Buffer.alloc(size)
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1
  for (let i = 0; i < size; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    out[i] = state & 0xff
  }
  return out
}

function buildCsv(rows: number, columns: number): Buffer {
  const lines: string[] = []
  for (let row = 0; row < rows; row += 1) {
    const cells: string[] = []
    for (let column = 0; column < columns; column += 1) {
      cells.push(column === 0 ? `row-${row}` : `value-${row}-${column}`)
    }
    lines.push(cells.join(','))
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
}

function buildJson(items: number): Buffer {
  const rows = Array.from({ length: items }, (_, index) => ({
    id: index,
    name: `Cryptoric item ${index}`,
    email: `item-${index}@example.test`,
    active: index % 2 === 0
  }))
  return Buffer.from(JSON.stringify(rows, null, 2), 'utf8')
}

/**
 * Produce one asset.
 *
 * Refuses executable extensions outright. A caller that wants a `.exe` in a
 * browser test should have to build it themselves, deliberately.
 */
export function generateAsset(request: AssetRequest, taskId?: string): GeneratedAsset {
  const dir = ensureWorkspace(taskId)
  const kind = request.kind
  const extension = EXTENSION[kind]
  const name = request.name ?? `cryptoric-test-${kind}${extension}`
  const lower = name.toLowerCase()
  const blocked = BLOCKED_EXTENSIONS.find((ext) => lower.endsWith(ext))
  if (blocked) {
    throw new Error(
      `Refusing to generate "${name}": ${blocked} is an executable extension. ` +
        'Upload tests should use document or image formats.'
    )
  }

  const path = join(dir, name)
  let data: Buffer
  let note: string

  switch (kind) {
    case 'png':
      data = encodePng(request.width ?? 64, request.height ?? 64)
      note = `Valid PNG, ${request.width ?? 64}×${request.height ?? 64}`
      break
    case 'jpg':
      data = encodeJpeg(request.width ?? 32, request.height ?? 32)
      note = `Valid baseline JPEG, ${request.width ?? 32}×${request.height ?? 32}`
      break
    case 'webp':
      data = encodeWebp(request.width ?? 32, request.height ?? 32)
      note = `Valid WebP container with a VP8L stream`
      break
    case 'svg':
      data = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${request.width ?? 64}" height="${request.height ?? 64}"><rect width="100%" height="100%" fill="#22d3ee"/></svg>`,
        'utf8'
      )
      note = 'Valid SVG document'
      break
    case 'gif':
      data = encodeGif(request.width ?? 16, request.height ?? 16)
      note = `Valid GIF87a, ${request.width ?? 16}×${request.height ?? 16}`
      break
    case 'txt':
      data = Buffer.from('Cryptoric test asset.\n'.repeat(Math.max(1, request.size ?? 4)), 'utf8')
      note = 'Plain text'
      break
    case 'csv':
      data = buildCsv(request.size ?? 10, 4)
      note = `CSV with ${request.size ?? 10} rows and 4 columns`
      break
    case 'json':
      data = buildJson(request.size ?? 5)
      note = `JSON array with ${request.size ?? 5} items`
      break
    case 'xml':
      data = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>\n<cryptoric><asset kind="xml" rows="${request.size ?? 5}"/></cryptoric>\n`,
        'utf8'
      )
      note = 'Valid XML document'
      break
    case 'pdf':
      data = encodePdf()
      note = 'Valid single-page PDF with a correct cross-reference table'
      break
    case 'zip':
      data = encodeZip([
        { name: 'readme.txt', data: Buffer.from('Cryptoric archive test asset.\n', 'utf8') },
        { name: 'data/rows.csv', data: buildCsv(5, 3) }
      ])
      note = 'Valid ZIP archive with 2 stored entries'
      break
    case 'empty':
      data = Buffer.alloc(0)
      note = 'Zero-byte file, for empty-upload handling'
      break
    case 'malformed':
      // A file whose magic bytes contradict its extension: the case an upload
      // validator is supposed to reject.
      data = Buffer.concat([Buffer.from('PK'), deterministicBytes(256, 'corrupt')])
      note = 'Truncated archive header followed by noise — invalid for every real format'
      break
    case 'large':
      data = deterministicBytes(request.size ?? 2 * 1024 * 1024)
      note = `${data.length} deterministic bytes, for size-limit testing`
      break
  }

  mkdirSync(dir, { recursive: true })
  writeFileSync(path, data)

  return { path, name, kind, bytes: data.length, mimeType: MIME[kind], note }
}

/** The asset kinds a caller may request, with a one-line description each. */
export const ASSET_CATALOG: { kind: AssetKind; description: string }[] = [
  { kind: 'png', description: 'Valid PNG image' },
  { kind: 'jpg', description: 'Valid baseline JPEG image' },
  { kind: 'webp', description: 'Valid WebP image' },
  { kind: 'svg', description: 'Valid SVG image' },
  { kind: 'gif', description: 'Valid GIF87a image' },
  { kind: 'txt', description: 'Plain text file' },
  { kind: 'csv', description: 'CSV table' },
  { kind: 'json', description: 'JSON document' },
  { kind: 'xml', description: 'XML document' },
  { kind: 'pdf', description: 'Single-page PDF' },
  { kind: 'zip', description: 'ZIP archive' },
  { kind: 'empty', description: 'Zero-byte file' },
  { kind: 'malformed', description: 'File whose bytes contradict its extension' },
  { kind: 'large', description: 'Deterministic large file for size-limit testing' }
]

/** Verify an asset really exists and really has bytes. Never trusts the request. */
export function verifyAsset(path: string): { exists: boolean; bytes: number; readable: boolean } {
  if (!existsSync(path)) return { exists: false, bytes: 0, readable: false }
  const bytes = statSync(path).size
  let readable = false
  try {
    readFileSync(path)
    readable = true
  } catch {
    readable = false
  }
  return { exists: true, bytes, readable }
}