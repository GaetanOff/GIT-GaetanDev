import type { Segment } from './intraline'

/**
 * A small line tokenizer for syntax colouring. It works one line at a time —
 * diffs, blame and conflicts only ever render a window of lines — so it is
 * fast and needs no grammar files. Multi-line constructs are approximated:
 * a line that starts inside a block comment is recognised by its leading `*`.
 */

export type Token = 'kw' | 'str' | 'num' | 'com' | 'fn' | 'type' | 'tag' | 'attr' | 'prop' | 'lit' | 'meta'

type Rule = [RegExp, Token | null]

const words = (list: string, flags = '') => new RegExp(`\\b(?:${list.split(' ').join('|')})\\b`, `y${flags}`)

const STR_DQ: Rule = [/"(?:[^"\\]|\\.)*"?/y, 'str']
const STR_SQ: Rule = [/'(?:[^'\\]|\\.)*'?/y, 'str']
const STR_BT: Rule = [/`(?:[^`\\]|\\.)*`?/y, 'str']
const NUM: Rule = [/\b(?:0x[\da-f_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?)[a-z]*\b/iy, 'num']
const CALL: Rule = [/[A-Za-z_$][\w$]*(?=\s*\()/y, 'fn']
const TYPE: Rule = [/\b[A-Z][A-Za-z0-9_]*\b/y, 'type']
const IDENT: Rule = [/[A-Za-z_$][\w$]*/y, null]

const CLIKE_KW = 'abstract as async await break case catch class const continue default defer delete do else enum export extends final finally fn for foreach from func function go goto if impl implements import in instanceof interface internal is let loop match mod module namespace new override package private protected pub public readonly return sealed static struct super switch this throw throws trait try type typeof unsafe use using var virtual void where while with yield'
const LITERALS = 'true false null undefined nil None True False NaN Infinity self Self'

const clike: Rule[] = [
  [/\/\/.*/y, 'com'],
  [/\/\*.*?(?:\*\/|$)/y, 'com'],
  [/#\s*(?:include|define|if|ifdef|ifndef|endif|pragma|region|endregion)\b.*/y, 'meta'],
  [/@[A-Za-z_][\w.]*/y, 'meta'],
  STR_DQ, STR_SQ, STR_BT, NUM,
  [words(LITERALS), 'lit'],
  [words(CLIKE_KW), 'kw'],
  CALL, TYPE, IDENT,
]

const hashy = (kw: string): Rule[] => [
  [/#.*/y, 'com'],
  [/"""|'''/y, 'str'],
  STR_DQ, STR_SQ, NUM,
  [/@[A-Za-z_][\w.]*/y, 'meta'],
  [/\$\{?[A-Za-z_][\w]*\}?/y, 'prop'],
  [words(LITERALS), 'lit'],
  [words(kw), 'kw'],
  CALL, TYPE, IDENT,
]

const PY_KW = 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case print'
const SH_KW = 'if then else elif fi for while until do done case esac in function return local export source echo exit set unset readonly shift'
const RB_KW = 'alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require attr_accessor'

const sql: Rule[] = [
  [/--.*/y, 'com'],
  [/\/\*.*?(?:\*\/|$)/y, 'com'],
  STR_SQ, STR_DQ, NUM,
  [words('select from where and or not insert into values update set delete create table alter drop index view join left right inner outer full on group by order having limit offset as distinct union all case when then else end is null primary key foreign references default constraint begin commit rollback with returning exists in like between', 'i'), 'kw'],
  CALL, IDENT,
]

const markup: Rule[] = [
  [/<!--.*?(?:-->|$)/y, 'com'],
  [/<\/?[A-Za-z][\w:.-]*/y, 'tag'],
  [/\/?>/y, 'tag'],
  [/[A-Za-z_:@][\w:.-]*(?==)/y, 'attr'],
  STR_DQ, STR_SQ,
  [/\{[^}]*\}/y, 'meta'],
  [/&\w+;/y, 'lit'],
]

const css: Rule[] = [
  [/\/\*.*?(?:\*\/|$)/y, 'com'],
  [/\/\/.*/y, 'com'],
  STR_DQ, STR_SQ,
  [/#[\da-f]{3,8}\b/iy, 'num'],
  [/-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch)?\b/y, 'num'],
  [/[a-z-]+(?=\s*:)/y, 'prop'],
  [/@[a-z-]+/y, 'kw'],
  [/[.#][A-Za-z_][\w-]*/y, 'type'],
  [/![a-z]+/y, 'kw'],
  [/[a-z-]+(?=\()/y, 'fn'],
  [/\$[\w-]+|--[\w-]+/y, 'prop'],
  IDENT,
]

const json: Rule[] = [
  [/"(?:[^"\\]|\\.)*"(?=\s*:)/y, 'prop'],
  STR_DQ, NUM,
  [words('true false null'), 'lit'],
]

const yaml: Rule[] = [
  [/#.*/y, 'com'],
  [/^\s*-?\s*[\w.\-/ ]+(?=\s*:(?:\s|$))/y, 'prop'],
  STR_DQ, STR_SQ, NUM,
  [words('true false null yes no on off'), 'lit'],
  [/[&*][\w-]+/y, 'meta'],
]

const markdown: Rule[] = [
  [/^#{1,6} .*/y, 'kw'],
  [/`[^`]*`/y, 'str'],
  [/\*\*[^*]+\*\*|__[^_]+__/y, 'type'],
  [/\[[^\]]*\]\([^)]*\)/y, 'fn'],
  [/^\s*(?:[-*+]|\d+\.)\s/y, 'meta'],
  [/^>.*/y, 'com'],
]

const ini: Rule[] = [
  [/[;#].*/y, 'com'],
  [/^\s*\[[^\]]*\]/y, 'tag'],
  [/^\s*[\w.-]+(?=\s*=)/y, 'prop'],
  STR_DQ, STR_SQ, NUM,
  [words('true false'), 'lit'],
]

const LANGS: Record<string, Rule[]> = {
  clike, sql, markup, css, json, yaml, markdown, ini,
  python: hashy(PY_KW), shell: hashy(SH_KW), ruby: hashy(RB_KW), hash: hashy(''),
}

const EXT: Record<string, string> = {
  ts: 'clike', tsx: 'clike', js: 'clike', jsx: 'clike', mjs: 'clike', cjs: 'clike', mts: 'clike', cts: 'clike',
  java: 'clike', cs: 'clike', go: 'clike', rs: 'clike', c: 'clike', h: 'clike', cpp: 'clike', cc: 'clike', hpp: 'clike',
  kt: 'clike', kts: 'clike', swift: 'clike', php: 'clike', dart: 'clike', scala: 'clike', groovy: 'clike', gradle: 'clike',
  py: 'python', pyw: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'shell', psm1: 'shell', rb: 'ruby', r: 'hash',
  pl: 'hash', dockerfile: 'hash', makefile: 'hash', mk: 'hash', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini',
  sql: 'sql', html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', svelte: 'markup', vue: 'markup', xaml: 'markup',
  csproj: 'markup', props: 'markup', targets: 'markup', config: 'markup', razor: 'markup', cshtml: 'markup',
  css: 'css', scss: 'css', sass: 'css', less: 'css', json: 'json', jsonc: 'json', json5: 'json',
  yml: 'yaml', yaml: 'yaml', md: 'markdown', markdown: 'markdown', gitignore: 'hash', gitattributes: 'hash', editorconfig: 'ini',
}

export function langFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'dockerfile' || name === 'makefile') return 'hash'
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  return EXT[ext] ?? null
}

interface Span { s: number; e: number; c: Token }

const cache = new Map<string, Span[]>()

function tokenize(text: string, lang: string): Span[] {
  const key = `${lang}\0${text}`
  const hit = cache.get(key)
  if (hit) return hit
  const rules = LANGS[lang]
  const spans: Span[] = []
  // Continuation lines of a /* … */ block.
  if ((lang === 'clike' || lang === 'css') && /^\s*\*(?!\*?\/\S)/.test(text) && !/^\s*\*\s*[\w$]+\s*[=(]/.test(text)) {
    spans.push({ s: 0, e: text.length, c: 'com' })
  } else if (text.length <= 2000) {
    let i = 0
    outer: while (i < text.length) {
      for (const [re, cls] of rules) {
        re.lastIndex = i
        const m = re.exec(text)
        if (m && m[0].length) {
          if (cls) spans.push({ s: i, e: i + m[0].length, c: cls })
          i += m[0].length
          continue outer
        }
      }
      i++
    }
  }
  if (cache.size > 20_000) cache.clear()
  cache.set(key, spans)
  return spans
}

export interface Piece {
  t: string
  c?: Token
  /** Part of a word-level change. */
  m?: boolean
}

/** Splits a line into coloured pieces, also cut at word-diff boundaries so both can be shown. */
export function pieces(text: string, lang: string | null, segs?: Segment[]): Piece[] {
  const spans = lang ? tokenize(text, lang) : []
  if (!spans.length && !segs) return [{ t: text }]

  const marks: [number, number][] = []
  if (segs) {
    let pos = 0
    for (const s of segs) {
      if (s.changed) marks.push([pos, pos + s.text.length])
      pos += s.text.length
    }
  }
  const cuts = new Set<number>([0, text.length])
  for (const s of spans) { cuts.add(s.s); cuts.add(s.e) }
  for (const [a, b] of marks) { cuts.add(a); cuts.add(b) }
  const points = [...cuts].sort((a, b) => a - b)

  const out: Piece[] = []
  let si = 0
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k]
    const b = points[k + 1]
    if (a === b) continue
    while (si < spans.length && spans[si].e <= a) si++
    const span = spans[si] && spans[si].s <= a ? spans[si] : undefined
    const m = marks.some(([x, y]) => a >= x && b <= y)
    out.push({ t: text.slice(a, b), c: span?.c, m: m || undefined })
  }
  return out
}
