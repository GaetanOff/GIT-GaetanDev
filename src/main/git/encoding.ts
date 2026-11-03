import type { TextEncoding } from '@shared/types'

/**
 * Files are not always UTF-8: legacy Windows projects often use Windows-1252,
 * some editors write UTF-16. Content is decoded with the encoding it really
 * has, and written back with that same encoding so bytes round-trip.
 */

/** Windows-1252 bytes 0x80–0x9F, the only range where it differs from Latin-1. */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
]
const CP1252_REVERSE = new Map(CP1252_HIGH.map((cp, i) => [cp, 0x80 + i]))

const utf8 = new TextDecoder('utf-8', { fatal: true })

export function detect(buf: Buffer): TextEncoding {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8-bom'
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le'
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be'
  try {
    utf8.decode(buf)
    return 'utf8'
  } catch {
    return 'windows-1252'
  }
}

export function decode(buf: Buffer, encoding: TextEncoding = detect(buf)): string {
  switch (encoding) {
    case 'utf8': return buf.toString('utf8')
    case 'utf8-bom': return buf.subarray(3).toString('utf8')
    case 'utf16le': return buf.subarray(2).toString('utf16le')
    case 'utf16be': {
      const swapped = Buffer.from(buf.subarray(2))
      swapped.swap16()
      return swapped.toString('utf16le')
    }
    case 'windows-1252': {
      let out = ''
      for (const b of buf) out += String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b)
      return out
    }
  }
}

export function encode(text: string, encoding: TextEncoding): Buffer {
  switch (encoding) {
    case 'utf8': return Buffer.from(text, 'utf8')
    case 'utf8-bom': return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'utf16le': return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'utf16be': {
      const body = Buffer.from(text, 'utf16le')
      body.swap16()
      return Buffer.concat([Buffer.from([0xfe, 0xff]), body])
    }
    case 'windows-1252': {
      // A character Windows-1252 has no byte for (text a merge brought in from a UTF-8 side) keeps
      // its UTF-8 bytes instead of becoming "?": the file then mixes encodings, but nothing is lost.
      const out: number[] = []
      for (const ch of text) {
        const c = ch.codePointAt(0)!
        const b = c < 0x100 ? c : CP1252_REVERSE.get(c)
        if (b !== undefined) out.push(b)
        else out.push(...Buffer.from(ch, 'utf8'))
      }
      return Buffer.from(out)
    }
  }
}

/**
 * Decodes git output that mixes UTF-8 metadata with file content in another
 * encoding (a diff of a Windows-1252 file): UTF-8 when it is valid, else 1252.
 */
export function decodeOutput(buf: Buffer): { text: string; encoding: TextEncoding } {
  const encoding = detect(buf) === 'utf8' ? 'utf8' : 'windows-1252'
  return { text: decode(buf, encoding), encoding }
}

export const ENCODING_LABEL: Record<TextEncoding, string> = {
  utf8: 'UTF-8', 'utf8-bom': 'UTF-8 BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', 'windows-1252': 'Windows-1252',
}
