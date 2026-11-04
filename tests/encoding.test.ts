import { describe, expect, it } from 'vitest'
import { decode, detect, encode } from '../src/main/git/encoding'

describe('encodings', () => {
  it('round-trips Windows-1252, its 0x80–0x9F range included', () => {
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x99, 0x81])
    expect(detect(bytes)).toBe('windows-1252')
    expect(encode(decode(bytes), 'windows-1252')).toEqual(bytes)
  })

  it('keeps characters Windows-1252 cannot hold as UTF-8 instead of "?"', () => {
    const out = encode('café → 中', 'windows-1252')
    expect(out).toEqual(Buffer.concat([Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20]), Buffer.from('→', 'utf8'), Buffer.from(' '), Buffer.from('中', 'utf8')]))
  })

  it('writes the BOM back for UTF-8 with BOM', () => {
    expect(encode('a', 'utf8-bom')).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))
  })
})
