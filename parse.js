// fastmark-md: a dependency-free Markdown renderer whose output is, string for string, what
// marked 18.1.3 renders with its defaults (gfm on, breaks off, pedantic off).
//
// The block pass walks the source by position with sticky regexes (marked's own patterns, so the
// edge cases agree) behind a cheap first-character dispatch, and builds a light block tree. Inline
// content is rendered straight to strings by a position scanner once every link definition is
// known, in the order marked's inline queue would visit it, so that the lexer state marked carries
// from one paragraph to the next (an open <a>, raw <code>) carries the same way here.
// Patterns and behaviour follow marked (MIT, see NOTICE).

// ---------------------------------------------------------------- escaping

const NEEDS_ESCAPE = /[&<>"']/;

function escapeAll(s) {
  if (!NEEDS_ESCAPE.test(s)) return s;
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    let r;
    switch (s.charCodeAt(i)) {
      case 38: r = '&amp;'; break;
      case 60: r = '&lt;'; break;
      case 62: r = '&gt;'; break;
      case 34: r = '&quot;'; break;
      case 39: r = '&#39;'; break;
      default: continue;
    }
    out += s.slice(last, i) + r;
    last = i + 1;
  }
  return last === 0 ? s : out + s.slice(last);
}

function isWordCode(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95;
}

function isHexCode(c) {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}

// Does an entity-like sequence (&#123; &#x1f; &name;) start at the '&' at i?
function entityAt(s, i) {
  let j = i + 1;
  let c = s.charCodeAt(j);
  if (c === 35) {
    c = s.charCodeAt(++j);
    let k = j;
    if (c === 120 || c === 88) {
      k = ++j;
      while (isHexCode(s.charCodeAt(k))) k++;
      if (k - j >= 1 && k - j <= 6 && s.charCodeAt(k) === 59) return true;
      return false;
    }
    while (s.charCodeAt(k) >= 48 && s.charCodeAt(k) <= 57) k++;
    return k - j >= 1 && k - j <= 7 && s.charCodeAt(k) === 59;
  }
  let k = j;
  while (isWordCode(s.charCodeAt(k))) k++;
  return k > j && s.charCodeAt(k) === 59;
}

// marked's escape(text) without encode: entity-like sequences keep their '&'.
function escapeText(s) {
  if (!NEEDS_ESCAPE.test(s)) return s;
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    let r;
    switch (s.charCodeAt(i)) {
      case 38: if (entityAt(s, i)) continue; r = '&amp;'; break;
      case 60: r = '&lt;'; break;
      case 62: r = '&gt;'; break;
      case 34: r = '&quot;'; break;
      case 39: r = '&#39;'; break;
      default: continue;
    }
    out += s.slice(last, i) + r;
    last = i + 1;
  }
  return last === 0 ? s : out + s.slice(last);
}

const NUMREF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMREF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function numrefReplace(m, dec, hex) {
  if (dec === undefined && hex === undefined) return '&amp;';
  const n = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
  if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
  return n === 38 ? '&amp;' : String.fromCodePoint(n);
}

// Numeric character references in inline text are decoded before escaping, as marked does.
function decodeNumeric(s) {
  if (s.indexOf('&#') < 0 || !NUMREF.test(s)) return s;
  return s.replace(NUMREF_OR_AMP, numrefReplace);
}

function encodeHref(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Characters encodeURI keeps, plus '%' (marked turns %25 back into %).
    if ((c >= 97 && c <= 122) || (c >= 63 && c <= 90) || (c >= 35 && c <= 59) || c === 33 || c === 61 || c === 95 || c === 126) continue;
    try {
      return encodeURI(s).replace(/%25/g, '%');
    } catch {
      return null;
    }
  }
  return s;
}

// ---------------------------------------------------------------- small helpers

// Strip trailing runs of ch.
function rtrimChar(s, ch) {
  let n = s.length;
  while (n > 0 && s[n - 1] === ch) n--;
  return s.slice(0, n);
}

function rtrimNewlines(s) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === 10) n--;
  return n === s.length ? s : s.slice(0, n);
}

// Expand tabs to the next multiple of four columns, starting at column col.
function expandTabs(s, col = 0) {
  let out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

const BLANK_LINE = /^[ \t]*$/;

// Drop the trailing blank lines of an indented code block or HTML block (marked's trimTrailingBlankLines).
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && BLANK_LINE.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Index of the first unbalanced closing bracket, -1 when none, -2 when some stay open.
function closingBracket(s, open, close) {
  if (s.indexOf(open) === -1 && s.indexOf(close) === -1) return -1;
  let level = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (ch === open) level++;
    else if (ch === close) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
function unescapePunct(s) {
  return s.indexOf('\\') < 0 ? s : s.replace(ANY_PUNCT, '$1');
}

function splitCells(row, count) {
  const cells = row
    .replace(/\|/g, (m, off, str) => {
      let esc = false;
      let p = off;
      while (--p >= 0 && str[p] === '\\') esc = !esc;
      return esc ? '|' : ' |';
    })
    .split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ---------------------------------------------------------------- block patterns (marked's, made sticky)

const TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HR_SRC = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HTML_START = ` {0,3}(?:<\\/?(?:${TAGS})(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`;
const FENCE_START = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const TABLE_SRC = ` *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|${HR_SRC}| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\\t)[^\\n]|${FENCE_START}| {0,3}(?:[*+-]|1[.)])[ \\t]|${HTML_START}).*(?:\\n|$))*)\\n*|$)`;
const PARA_BREAK = `${HR_SRC}| {0,3}#{1,6}(?:\\s|$)| {0,3}>|${FENCE_START}`;

const B_CODE = /((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/y;
const B_FENCES = /( {0,3})(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\2`*|(?=~)\2~*) *(?=\n|$)|$)/y;
const B_HEADING = / {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/y;
const B_HR = new RegExp(HR_SRC, 'y');
const B_BLOCKQUOTE = new RegExp(`( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(([^\\n]+(?:\\n(?!${PARA_BREAK}| {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)|${HTML_START}|[ \\t]+\\n)[^\\n]+)*))|[^\\n]*)(?:\\n|$))+`, 'y');
const B_LIST = /( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/y;
const B_HTML = new RegExp(` {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:<\\/\\1>[^\\n]*\\n*|$)|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|<\\/?(${TAGS})(?:[ \\t]+|\\n|\\/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *'[^'\\n]*'| *= *[^\\s"'=<>\`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<\\/[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))`, 'iy');
const B_DEF = / {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/y;
const B_TABLE = new RegExp(TABLE_SRC, 'y');
const LHEADING_SRC = '(?! {0,3}(?:[*+-]|\\d{1,9}[.)]) |(?: {4}| {0,3}\\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n)((?:.|\\n(?!\\s*?\\n| {0,3}(?:[*+-]|\\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
const B_LHEADING = new RegExp(LHEADING_SRC, 'y');
const LHEADING_AT_START = new RegExp('^' + LHEADING_SRC);
const B_PARAGRAPH = new RegExp(`[^\\n]+(?:\\n(?!${PARA_BREAK}| {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]|${HTML_START}|${TABLE_SRC}|[ \\t]+\\n)[^\\n]+)*`, 'y');
const SETEXT_LINE = /^ {0,3}(?:=+|-+)[ \t]*$/;

// Per-indent patterns of the list item scanner (marked caches them by min(3, indent - 1)).
const LIST_RULES = [0, 1, 2, 3].map((n) => ({
  bullet: new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
  hr: new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
  fence: new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`),
  heading: new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`),
  html: new RegExp(`^ {0,${n}}(?:<\\/?(?:${TAGS})(?: +|$|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'),
  quote: new RegExp(`^ {0,${n}}>`),
}));

const ITEM_RES = Object.create(null);
function itemRegex(marker) {
  let re = ITEM_RES[marker];
  if (re === undefined) {
    const bull = marker === '.' || marker === ')' ? `\\d{1,9}\\${marker}` : `\\${marker}`;
    re = ITEM_RES[marker] = new RegExp(`( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`, 'y');
  }
  return re;
}

// ---------------------------------------------------------------- lexer state (reset per parse)

let links = Object.create(null); // reference definitions, label -> { href, title }
let queue = []; // inline work in marked's inline queue order: objects with src, html
let top = true; // marked's lexer.state.top
let inLink = false;
let inRawBlock = false;
let linkEmitted = false;

function lineEnd(s, p) {
  const nl = s.indexOf('\n', p);
  return nl < 0 ? s.length : nl;
}

// ---------------------------------------------------------------- block lexer

function lexBlocks(s, out, joinPara) {
  const len = s.length;
  let pos = 0;
  let m;
  while (pos < len) {
    // Blank lines.
    let q = pos;
    for (;;) {
      let r = q;
      let c = s.charCodeAt(r);
      while (c === 32 || c === 9) c = s.charCodeAt(++r);
      if (r >= len) { q = len; break; }
      if (c !== 10) break;
      q = r + 1;
    }
    if (q > pos) {
      const last = out.length ? out[out.length - 1] : undefined;
      if (q - pos === 1 && last !== undefined) {
        if (last.raw !== undefined) last.raw += '\n';
      } else {
        out.push({ type: 'space', raw: s.slice(pos, q) });
      }
      pos = q;
      continue;
    }

    let ind = pos;
    while (ind - pos < 4 && s.charCodeAt(ind) === 32) ind++;
    const c = s.charCodeAt(ind);
    const last = out.length ? out[out.length - 1] : undefined;

    if (ind - pos === 4 || c === 9) {
      B_CODE.lastIndex = pos;
      if ((m = B_CODE.exec(s)) !== null) {
        const raw = trimBlankTail(m[0]);
        pos += raw.length;
        const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
        if (last !== undefined && (last.type === 'paragraph' || last.type === 'text')) {
          last.text += '\n' + text;
          queue[queue.length - 1].src = last.text;
        } else {
          out.push({ type: 'code', lang: undefined, text });
        }
        continue;
      }
    }

    if (ind - pos < 4) {
      if (c === 96 || c === 126) {
        B_FENCES.lastIndex = pos;
        if ((m = B_FENCES.exec(s)) !== null) {
          pos += m[0].length;
          out.push({ type: 'code', lang: m[3] ? unescapePunct(m[3].trim()) : m[3], text: fenceBody(m[0], m[4] || '') });
          continue;
        }
      } else if (c === 35) {
        B_HEADING.lastIndex = pos;
        if ((m = B_HEADING.exec(s)) !== null) {
          pos += rtrimNewlines(m[0]).length;
          let text = m[2].trim();
          if (text.endsWith('#')) {
            const t = rtrimChar(text, '#');
            if (!t || /[ \t]$/.test(t)) text = t.trim();
          }
          const tok = { type: 'heading', depth: m[1].length, src: text, html: '' };
          queue.push(tok);
          out.push(tok);
          continue;
        }
      }
      if (c === 45 || c === 95 || c === 42) {
        B_HR.lastIndex = pos;
        if ((m = B_HR.exec(s)) !== null) {
          pos += rtrimNewlines(m[0]).length;
          out.push({ type: 'hr' });
          continue;
        }
      }
      if (c === 62) {
        const tok = blockquote(s, pos);
        if (tok !== null) {
          pos += tok.raw.length;
          out.push(tok);
          continue;
        }
      }
      if (c === 42 || c === 43 || c === 45 || (c >= 48 && c <= 57)) {
        const tok = list(s, pos);
        if (tok !== null) {
          pos += tok.raw.length;
          out.push(tok);
          continue;
        }
      }
      if (c === 60) {
        B_HTML.lastIndex = pos;
        if ((m = B_HTML.exec(s)) !== null) {
          const raw = trimBlankTail(m[0]);
          pos += raw.length;
          out.push({ type: 'html', text: raw });
          continue;
        }
      } else if (c === 91) {
        B_DEF.lastIndex = pos;
        if ((m = B_DEF.exec(s)) !== null && (m[2].charCodeAt(0) === 60 || closingBracket(m[2], '(', ')') === -1)) {
          const raw = rtrimNewlines(m[0]);
          pos += raw.length;
          if (last !== undefined && (last.type === 'paragraph' || last.type === 'text')) {
            last.text += '\n' + raw;
            queue[queue.length - 1].src = last.text;
          } else {
            const tag = normLabel(m[1]);
            if (links[tag] === undefined) {
              links[tag] = {
                href: m[2] ? unescapePunct(m[2].replace(/^<(.*)>$/, '$1')) : '',
                title: m[3] ? unescapePunct(m[3].substring(1, m[3].length - 1)) : m[3],
              };
            }
            out.push({ type: 'def', raw });
          }
          continue;
        }
      }
    }

    // Table: the second line must open like a delimiter row.
    const eol = lineEnd(s, pos);
    if (eol < len) {
      let j = eol + 1;
      const lim = j + 3;
      while (j < lim && s.charCodeAt(j) === 32) j++;
      const d = s.charCodeAt(j);
      if (d === 124 || d === 58 || d === 45) {
        B_TABLE.lastIndex = pos;
        if ((m = B_TABLE.exec(s)) !== null && /[:|]/.test(m[2])) {
          const tok = table(m);
          if (tok !== null) {
            pos += rtrimNewlines(m[0]).length;
            out.push(tok);
            continue;
          }
        }
      }
      // Setext heading: some later line of the run must be an underline.
      if (maybeSetext(s, eol)) {
        B_LHEADING.lastIndex = pos;
        if ((m = B_LHEADING.exec(s)) !== null) {
          pos += rtrimNewlines(m[0]).length;
          const tok = { type: 'heading', depth: m[2].charCodeAt(0) === 61 ? 1 : 2, src: m[1].trim(), html: '' };
          queue.push(tok);
          out.push(tok);
          continue;
        }
      }
    }

    if (top) {
      B_PARAGRAPH.lastIndex = pos;
      m = B_PARAGRAPH.exec(s);
      const text = m[0];
      pos += text.length;
      if (joinPara && last !== undefined && last.type === 'paragraph') {
        last.text += '\n' + text;
        queue[queue.length - 1].src = last.text;
      } else {
        const tok = { type: 'paragraph', text, src: text, html: '', pre: '' };
        queue.push(tok);
        out.push(tok);
      }
      joinPara = false;
      continue;
    }

    // Outside the top level a line is a text token; consecutive ones merge.
    const text = s.slice(pos, eol);
    pos = eol;
    if (last !== undefined && last.type === 'text') {
      last.text += '\n' + text;
      queue[queue.length - 1].src = last.text;
    } else {
      const tok = { type: 'text', text, src: text, html: '', pre: '' };
      queue.push(tok);
      out.push(tok);
    }
  }
  top = true;
  return out;
}

function maybeSetext(s, eol) {
  const len = s.length;
  let p = eol + 1;
  while (p < len) {
    const e = lineEnd(s, p);
    let i = p;
    while (i < e && i - p < 3 && s.charCodeAt(i) === 32) i++;
    const c = s.charCodeAt(i);
    if (c === 61 || c === 45) {
      let j = i;
      while (s.charCodeAt(j) === c) j++;
      while (j < e && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
      if (j === e) return true;
    }
    if (BLANK_LINE.test(s.slice(p, e))) return false;
    p = e + 1;
  }
  return false;
}

function fenceBody(raw, text) {
  const m = /^(\s+)(?:```)/.exec(raw);
  if (m === null) return text;
  const n = m[1].length;
  return text
    .split('\n')
    .map((line) => {
      const o = /^\s+/.exec(line);
      return o === null ? line : line.slice(Math.min(o[0].length, n));
    })
    .join('\n');
}

const ALIGN_RIGHT = /^ *-+: *$/;
const ALIGN_CENTER = /^ *:-+: *$/;
const ALIGN_LEFT = /^ *:-+ *$/;

function table(m) {
  const head = splitCells(m[1]);
  const delims = m[2].replace(/^\||\| *$/g, '').split('|');
  if (head.length !== delims.length) return null;
  const rows = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  const align = delims.map((d) => (ALIGN_RIGHT.test(d) ? 'right' : ALIGN_CENTER.test(d) ? 'center' : ALIGN_LEFT.test(d) ? 'left' : null));
  const header = head.map((text) => {
    const cell = { src: text, html: '' };
    queue.push(cell);
    return cell;
  });
  const body = rows.map((row) =>
    splitCells(row, head.length).map((text) => {
      const cell = { src: text, html: '' };
      queue.push(cell);
      return cell;
    }),
  );
  return { type: 'table', align, header, rows: body };
}

const QUOTE_START = /^ {0,3}>/;

function blockquote(s, pos) {
  B_BLOCKQUOTE.lastIndex = pos;
  const t = B_BLOCKQUOTE.exec(s);
  if (t === null) return null;
  let lines = rtrimNewlines(t[0]).split('\n');
  let raw = '';
  let text = '';
  const toks = [];
  while (lines.length > 0) {
    let inQuote = false;
    const cur = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (QUOTE_START.test(lines[i])) {
        cur.push(lines[i]);
        inQuote = true;
      } else if (!inQuote) cur.push(lines[i]);
      else break;
    }
    lines = lines.slice(i);
    const h = cur.join('\n');
    const u = h
      .replace(/^( {0,3}>)([ \t]+)/gm, (g, b, w) => b + expandTabs(w, b.length))
      .replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1')
      .replace(/^ {0,3}>[ \t]?/gm, '');
    raw = raw ? raw + '\n' + h : h;
    text = text ? text + '\n' + u : u;
    const saveTop = top;
    top = true;
    lexBlocks(u, toks, true);
    top = saveTop;
    if (lines.length === 0) break;
    const k = toks[toks.length - 1];
    const kt = k === undefined ? '' : k.type;
    if (kt === 'code' || kt === 'heading' || kt === 'hr' || kt === 'html' || kt === 'table') break;
    if (kt === 'blockquote') {
      const b = lines.join('\n');
      const mm = k.raw + '\n' + b.replace(/^ {0,3}>[ \t]?/gm, '');
      const f = blockquote(mm, 0);
      toks[toks.length - 1] = f;
      const y = mm.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) raw = raw + '\n' + A.join('\n');
      text = text.substring(0, text.length - k.text.length) + f.text;
      lines = lines.slice(A.length);
      if (lines.length > 0 && QUOTE_START.test(lines[0])) continue;
      break;
    } else if (kt === 'list') {
      const b = k.raw + '\n' + lines.join('\n');
      const mm = list(b, 0);
      toks[toks.length - 1] = mm;
      const f = mm.raw.length > k.raw.length ? b.slice(k.raw.length + 1, mm.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        raw = raw + '\n' + y;
        text = text + '\n' + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { type: 'blockquote', raw, text, tokens: toks };
}

const LEADING_WS = /^[ \t]+/;

// /\n[ \t]*\n[ \t]*$/.test(s), scanning back from the end.
function endsWithBlankLine(s) {
  let i = s.length;
  let c;
  while ((c = s.charCodeAt(i - 1)) === 32 || c === 9) i--;
  if (c !== 10) return false;
  i--;
  while ((c = s.charCodeAt(i - 1)) === 32 || c === 9) i--;
  return c === 10;
}

// Could a fence, heading, HTML block, quote, bullet or rule start with this character?
function mayStartBlock(c) {
  return c === 96 || c === 126 || c === 35 || c === 60 || c === 62 || c === 42 || c === 43 || c === 45 || c === 95 || (c >= 48 && c <= 57);
}
const TASK = /^\[[ xX]\][ \t]+\S/;
const TASK_PREFIX = /^\[[ xX]\][ \t]+/;

function list(s, pos) {
  B_LIST.lastIndex = pos;
  const head = B_LIST.exec(s);
  if (head === null) return null;
  const len = s.length;
  let bull = head[1].trim();
  const ordered = bull.length > 1;
  const tok = { type: 'list', raw: '', ordered, start: ordered ? +bull.slice(0, -1) : '', loose: false, items: [] };
  const itemRe = itemRegex(bull[bull.length - 1]);
  let blankEnded = false;
  let p = pos;
  while (p < len) {
    let endsBlank = false;
    let itemText = '';
    itemRe.lastIndex = p;
    const t = itemRe.exec(s);
    if (t === null) break;
    B_HR.lastIndex = p;
    if (B_HR.test(s)) break;
    const itemStart = p;
    p += t[0].length;
    const nl = t[2].indexOf('\n');
    const line = nl < 0 ? t[2] : t[2].slice(0, nl);
    const b = t[1].length;
    let first = line.replace(LEADING_WS, (v) => expandTabs(v, b));
    let next = s.slice(p, lineEnd(s, p));
    let blank = !first.trim();
    let indent;
    if (blank) indent = b + 1;
    else {
      indent = first.search(/[^ ]/);
      indent = indent > 4 ? 1 : indent;
      itemText = first.slice(indent);
      indent += b;
    }
    if (blank && BLANK_LINE.test(next)) {
      p = Math.min(len, p + next.length + 1);
      endsBlank = true;
    }
    if (!endsBlank) {
      const lim = Math.max(0, Math.min(3, indent - 1));
      const rules = LIST_RULES[lim];
      while (p < len) {
        const e = lineEnd(s, p);
        const f = s.slice(p, e);
        let w = 0;
        let tabbed = false;
        for (;;) {
          const ch = f.charCodeAt(w);
          if (ch === 32) w++;
          else if (ch === 9) {
            tabbed = true;
            w++;
          } else break;
        }
        const z = tabbed ? expandTabs(f.slice(0, w)) + f.slice(w) : f;
        if (!tabbed && w <= lim && mayStartBlock(f.charCodeAt(w)) && (rules.fence.test(f) || rules.heading.test(f) || rules.html.test(f) || rules.quote.test(f) || rules.bullet.test(f) || rules.hr.test(f))) break;
        if (tabbed && (rules.fence.test(f) || rules.heading.test(f) || rules.html.test(f) || rules.quote.test(f) || rules.bullet.test(f) || rules.hr.test(f))) break;
        const fBlank = w === f.length || (f.charCodeAt(w) > 32 && f.charCodeAt(w) < 127 ? false : !f.trim());
        if ((tabbed ? z.search(/[^ ]/) : w === f.length ? -1 : w) >= indent || fBlank) {
          itemText += '\n' + z.slice(indent);
        } else {
          if (blank || first.replace(/\t/g, '    ').search(/[^ ]/) >= 4 || rules.fence.test(first) || rules.heading.test(first) || rules.html.test(first) || rules.hr.test(first)) break;
          itemText += '\n' + (/^ {0,3}(?:=+|-+) *$/.test(f) && LHEADING_AT_START.test(`${first}\n${f}`) ? `    ${z.replace(/^ {0,3}/, '')}` : f);
        }
        blank = fBlank;
        p = Math.min(len, e + 1);
        first = z.slice(indent);
      }
    }
    const raw = s.slice(itemStart, p);
    if (!tok.loose) {
      if (blankEnded) tok.loose = true;
      else if (endsWithBlankLine(raw)) blankEnded = true;
    }
    tok.items.push({ raw, task: TASK.test(itemText), text: itemText, tokens: null });
  }
  const items = tok.items;
  if (items.length === 0) return null;
  const lastItem = items[items.length - 1];
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  tok.raw = s.slice(pos, p).trimEnd();
  for (const item of items) {
    top = false;
    item.tokens = lexBlocks(item.text, []);
    if (!tok.loose) {
      tok.loose = item.tokens.some((x) => x.type === 'space' && /\n.*\n/.test(x.raw));
    }
  }
  for (const item of items) {
    const d = item.tokens[0];
    if (item.task && d !== undefined && (d.type === 'text' || d.type === 'paragraph')) {
      d.text = d.text.replace(TASK_PREFIX, '');
      for (let g = queue.length - 1; g >= 0; g--) {
        if (TASK.test(queue[g].src)) {
          queue[g].src = queue[g].src.replace(TASK_PREFIX, '');
          break;
        }
      }
      const k = /\[[ xX]\]/.exec(item.raw);
      if (k !== null) {
        const box = k[0] !== '[ ]' ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ';
        if (tok.loose) d.pre = box;
        else item.tokens.unshift({ type: 'checkbox', html: box });
      }
    }
  }
  if (tok.loose) {
    for (const item of items) for (const x of item.tokens) if (x.type === 'text') x.type = 'paragraph';
  }
  return tok;
}

// ---------------------------------------------------------------- inline patterns

const I_ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[]\\^_`{|}~';
const I_TAG = /<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>/y;
const I_AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/y;
const LABEL = '(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const LINK_SRC = `!?\\[(${LABEL})\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)`;
const I_LINK = new RegExp(LINK_SRC, 'y');
const LINK_AT_START = new RegExp('^' + LINK_SRC);
const REF = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const I_REFLINK = new RegExp(`!?\\[(${LABEL})\\]\\[(${REF})\\]`, 'y');
const I_NOLINK = new RegExp(`!?\\[(${REF})\\](?:\\[\\])?`, 'y');
const REFLINK_SEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
// BLOCK_SKIP with plain numbered groups (no per-match groups object), for the mask.
const MASK_SKIP = /\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)(`+)[^`]+\2(?!`)|<(?! )[^<>]*?>/g;
const PUNCT_OUTSIDE_CODE =/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const EM_LDELIM = /\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?|_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/uy;
const EM_RDELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const EM_RDELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const DEL_LDELIM = /~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/uy;
const DEL_RDELIM = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const PUNCT_SPACE = /^((?![*_])[\s\p{P}\p{S}])/u;
const ALNUM_U = /[\p{L}\p{N}]/u;
const I_URL = /(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/y;
const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const I_CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const CODE_AT_START = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const I_BR = /( {2,}|\\)\n(?!\s*$)[ \t]*/y;

// Character classes of marked's inline text pattern.
const C_ALNUM = 1; // [a-zA-Z0-9]
const C_EMAIL = 2; // [a-zA-Z0-9.!#$%&'*+/=?_`{|}~-] (the text pattern's e-mail run)
const C_STOP = 4; // [\\<![`*~_]: text stops before these
const C_URLSTART = 8; // [A-Za-z0-9._+-]: a GFM autolink may start here
const CLS = new Uint8Array(128);
for (let i = 48; i <= 57; i++) CLS[i] = C_ALNUM | C_EMAIL | C_URLSTART;
for (let i = 65; i <= 90; i++) CLS[i] = C_ALNUM | C_EMAIL | C_URLSTART;
for (let i = 97; i <= 122; i++) CLS[i] = C_ALNUM | C_EMAIL | C_URLSTART;
for (const ch of ".!#$%&'*+/=?_`{|}~-") CLS[ch.charCodeAt(0)] |= C_EMAIL;
for (const ch of '\\<![`*~_') CLS[ch.charCodeAt(0)] |= C_STOP;
for (const ch of '._+-') CLS[ch.charCodeAt(0)] |= C_URLSTART;

function cls(c) {
  return c < 128 ? CLS[c] : 0;
}

// An e-mail local part followed by '@' starts at i.
function emailAhead(s, i) {
  let c = s.charCodeAt(i);
  if (!(cls(c) & C_EMAIL)) return false;
  do c = s.charCodeAt(++i);
  while (cls(c) & C_EMAIL);
  return c === 64;
}

function mailtoAhead(s, i) {
  const c = s.charCodeAt(i);
  if (c === 109) return s.startsWith('mailto:', i);
  if (c === 120) return s.startsWith('xmpp:', i);
  return false;
}

// [hH][tT][tT][pP][sS]?:// or [fF][tT][pP]:// at i.
function protocolAhead(s, i) {
  const c = s.charCodeAt(i) | 32;
  if (c === 104) {
    if ((s.charCodeAt(i + 1) | 32) !== 116 || (s.charCodeAt(i + 2) | 32) !== 116 || (s.charCodeAt(i + 3) | 32) !== 112) return false;
    let j = i + 4;
    if ((s.charCodeAt(j) | 32) === 115) j++;
    return s.charCodeAt(j) === 58 && s.charCodeAt(j + 1) === 47 && s.charCodeAt(j + 2) === 47;
  }
  if (c === 102) {
    return (s.charCodeAt(i + 1) | 32) === 116 && (s.charCodeAt(i + 2) | 32) === 112 && s.charCodeAt(i + 3) === 58 && s.charCodeAt(i + 4) === 47 && s.charCodeAt(i + 5) === 47;
  }
  return false;
}

// Two or more spaces then a newline at i.
function hardBreakAhead(s, i) {
  if (s.charCodeAt(i) !== 32 || s.charCodeAt(i + 1) !== 32) return false;
  i += 2;
  while (s.charCodeAt(i) === 32) i++;
  return s.charCodeAt(i) === 10;
}

// End of the inline text token that starts at i (marked's GFM inline text pattern, split up).
// mail: s holds an '@', without which no e-mail lookahead can succeed.
function textEnd(s, i, mail) {
  const len = s.length;
  let c = s.charCodeAt(i);
  if (!(cls(c) & C_ALNUM) && mailtoAhead(s, i + 1)) return i + 1;
  let p = i + 1;
  if (c === 96 || c === 126) while (s.charCodeAt(p) === c) p++;
  if (p >= len) return len;
  c = s.charCodeAt(p);
  if (c === 96 || c === 126 || (c === 32 && hardBreakAhead(s, p)) || (mail && emailAhead(s, p))) return p;
  // A non-e-mail character followed by an e-mail local part and '@' ends the token after that
  // character; only the character just before the run that ends at some '@' can qualify.
  let qMail = -1;
  if (mail) {
    for (let at = s.indexOf('@', p); at >= 0; at = s.indexOf('@', at + 1)) {
      let r = at;
      while (r > p && cls(s.charCodeAt(r - 1)) & C_EMAIL) r--;
      if (r < at && r > p) {
        qMail = r - 1;
        break;
      }
    }
  }
  // The rest is the lazy part of the pattern; the irregexp scan beats a JS loop here.
  TEXT_STOP.lastIndex = p;
  const m = TEXT_STOP.exec(s);
  if (m !== null && (qMail < 0 || m.index <= qMail)) return m[1] === undefined ? m.index : m.index + 1;
  return qMail >= 0 ? qMail + 1 : len;
}

// Where the lazy part of the text pattern stops: before a special character, a protocol, or
// www. after whitespace or a delimiter; or (group 1) after a non-space before a hard break or a
// non-alphanumeric before mailto:/xmpp:. (The e-mail case is found from the '@' instead.)
const TEXT_STOP = /[\\<!\[`*~_]|(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|(?<![^\s*_~(])www\.|([^ ](?= {2,}\n)|[^a-zA-Z0-9](?=mailto:|xmpp:))/g;

// ---------------------------------------------------------------- inline masking (for emphasis)

function hasLinks() {
  for (const _ in links) return true;
  return false;
}

function linkInText(e) {
  if (!e.includes('[')) return false;
  for (const m of e.matchAll(BLOCK_SKIP)) if (LINK_AT_START.test(m[0]) && e.charAt(m.index - 1) !== '!') return true;
  for (const m of e.matchAll(REFLINK_SEARCH)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || links[normLabel(s.slice(r + 1, -1))] === undefined) && !(r > 1 && linkInText(s.slice(1, r - 1)))) return true;
  }
  return false;
}

function maskRef(r) {
  const o = r.lastIndexOf('[');
  if (links[normLabel(r.slice(o + 1, -1))] === undefined) return r;
  if (o > 1 && r.charAt(0) !== '!') {
    const i = r.slice(1, o - 1);
    if (linkInText(i)) return '[' + i.replace(REFLINK_SEARCH, maskRef) + '][' + 'a'.repeat(r.length - o - 2) + ']';
  }
  return '[' + 'a'.repeat(r.length - 2) + ']';
}

// Escaped punctuation becomes '+'; a code span keeps its fences and its backticks become '+'.
function maskPunct(t) {
  PUNCT_OUTSIDE_CODE.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = PUNCT_OUTSIDE_CODE.exec(t)) !== null) {
    const n = m[0];
    let rep;
    if (m[2] !== undefined) rep = '+'.repeat(n.length);
    else if (m[1] !== undefined) {
      const k = m[1].length;
      const inner = n.slice(k, -k);
      if (inner.indexOf('`') < 0) continue;
      rep = m[1] + inner.replace(/`/g, '+') + m[1];
    } else continue;
    out += t.slice(last, m.index) + rep;
    last = m.index + n.length;
  }
  return last === 0 ? t : out + t.slice(last);
}

// Links, code spans and raw tags become "[aaa]".
function maskSkip(t) {
  MASK_SKIP.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = MASK_SKIP.exec(t)) !== null) {
    const n = m[0].length;
    out += t.slice(last, m.index) + '[' + 'a'.repeat(n - 2) + ']';
    last = m.index + n;
  }
  return last === 0 ? t : out + t.slice(last);
}

function maskSource(e) {
  let t = e;
  const bracket = e.includes('[');
  const tick = e.includes('`');
  if (bracket && hasLinks()) t = t.replace(REFLINK_SEARCH, maskRef);
  if (tick || e.includes('\\')) t = maskPunct(t);
  if (bracket || tick || e.includes('<')) t = maskSkip(t);
  return t;
}

// Start of the last run of ch in s that is not preceded by whitespace (-1 when none).
function lastCloser(s, ch) {
  const n = s.length;
  let at = -1;
  let i = s.indexOf(ch);
  while (i >= 0) {
    let j = i + 1;
    while (j < n && s[j] === ch) j++;
    const o = i === 0 ? 10 : s.charCodeAt(i - 1);
    if (o !== 32 && o !== 9 && o !== 10 && o !== 13 && o !== 12) at = i;
    i = s.indexOf(ch, j);
  }
  return at;
}

// ---------------------------------------------------------------- inline renderer

class Ctx {
  constructor(src) {
    this.src = src;
    this.masked = null;
    this.ast = -2;
    this.und = -2;
    this.til = -2;
  }
  mask() {
    if (this.masked === null) this.masked = maskSource(this.src);
    return this.masked;
  }
  closer(ch) {
    if (ch === '*') return this.ast === -2 ? (this.ast = lastCloser(this.mask(), '*')) : this.ast;
    if (ch === '_') return this.und === -2 ? (this.und = lastCloser(this.mask(), '_')) : this.und;
    return this.til === -2 ? (this.til = lastCloser(this.mask(), '~')) : this.til;
  }
}

// Does a raw HTML tag or autolink that starts inside the label run past its end?
function labelSpillsTag(src, at, label) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    const ch = label[s];
    if (ch === '\\') {
      s++;
      continue;
    }
    if (ch === '`') {
      const i = CODE_AT_START.exec(label.slice(s));
      if (i !== null) {
        s += i[0].length - 1;
        continue;
      }
    }
    if (ch !== '<') continue;
    I_TAG.lastIndex = at + s;
    let o = I_TAG.exec(src);
    if (o === null) {
      I_AUTOLINK.lastIndex = at + s;
      o = I_AUTOLINK.exec(src);
    }
    if (o !== null) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// Result slots of the token functions below (one token at a time, so module scope is enough).
let tokEnd = 0;
let tokHtml = '';

// Shared tail of inline links, reference links and images (marked's outputLink).
function emitLink(end, raw, label, href, title, plain) {
  const text = label.indexOf('\\') < 0 ? label : label.replace(/\\([\[\]])/g, '$1');
  const image = raw.charCodeAt(0) === 33;
  const saveInLink = inLink;
  const saveEmitted = linkEmitted;
  const saveRaw = inRawBlock;
  inLink = true;
  linkEmitted = false;
  const inner = inline(text, plain || image);
  const emitted = linkEmitted;
  linkEmitted = saveEmitted;
  inLink = saveInLink;
  if (!image) {
    if (emitted) {
      inRawBlock = saveRaw;
      return false;
    }
    linkEmitted = true;
  }
  tokEnd = end;
  if (plain) {
    tokHtml = inner;
    return true;
  }
  const enc = encodeHref(href);
  if (image) {
    if (enc === null) tokHtml = escapeText(inner);
    else tokHtml = '<img src="' + escapeText(enc) + '" alt="' + escapeText(inner) + '"' + (title ? ' title="' + escapeText(title) + '"' : '') + '>';
  } else if (enc === null) tokHtml = inner;
  else tokHtml = '<a href="' + escapeText(enc) + '"' + (title ? ' title="' + escapeText(title) + '"' : '') + '>' + inner + '</a>';
  return true;
}

function linkToken(src, pos, plain) {
  I_LINK.lastIndex = pos;
  const t = I_LINK.exec(src);
  if (t === null) return false;
  let t0 = t[0];
  const t1 = t[1];
  let t2 = t[2];
  let t3 = t[3];
  if (labelSpillsTag(src, pos + (t0.charCodeAt(0) === 33 ? 2 : 1), t1)) return false;
  const s = t2.trim();
  if (s.charCodeAt(0) === 60) {
    if (!s.endsWith('>')) return false;
    const l = rtrimChar(s.slice(0, -1), '\\');
    if ((s.length - l.length) % 2 === 0) return false;
  } else {
    const l = closingBracket(t2, '(', ')');
    if (l === -2) return false;
    if (l > -1) {
      const h = (t0.indexOf('!') === 0 ? 5 : 4) + t1.length + l;
      t2 = t2.substring(0, l);
      t0 = t0.substring(0, h).trim();
      t3 = '';
    }
  }
  const r = rtrimChar(t0.slice(0, -1), '\\');
  if ((t0.length - r.length) % 2 === 0) return false;
  let href = t2.trim();
  const title = t3 ? t3.slice(1, -1) : '';
  if (href.charCodeAt(0) === 60) href = href.slice(1, -1);
  return emitLink(pos + t0.length, t0, t1, href && unescapePunct(href), title && unescapePunct(title), plain);
}

// 1: link rendered, 2: no definition (a one-character text token), 0: no match.
function refLinkToken(src, pos, plain) {
  I_REFLINK.lastIndex = pos;
  let n = I_REFLINK.exec(src);
  if (n === null) {
    I_NOLINK.lastIndex = pos;
    n = I_NOLINK.exec(src);
    if (n === null) return 0;
  }
  if (labelSpillsTag(src, pos + (n[0].charCodeAt(0) === 33 ? 2 : 1), n[1])) return 0;
  const def = links[normLabel(n[2] || n[1])];
  if (def === undefined) return 2;
  return emitLink(pos + n[0].length, n[0], n[1], def.href, def.title || null, plain) ? 1 : 0;
}

function lastCodePoint(t, l) {
  if (l <= 0) return '';
  const c = t.charCodeAt(l - 1);
  if (c >= 0xdc00 && c <= 0xdfff && l >= 2) {
    const h = t.charCodeAt(l - 2);
    if (h >= 0xd800 && h <= 0xdbff) return t.slice(l - 2, l);
  }
  return t[l - 1];
}

function emStrongToken(cx, pos, prev, plain) {
  const src = cx.src;
  EM_LDELIM.lastIndex = pos;
  const s = EM_LDELIM.exec(src);
  if (s === null || (!s[1] && !s[2] && !s[3] && !s[4])) return false;
  const r = s[0][0];
  const sameAsPrev = prev === r;
  const d = s[1] || s[3] || '';
  // Masking never adds delimiter characters, so when the source has none just before pos the
  // masked text has none either and the left-flanking checks can run before masking.
  if (src[pos - 1] !== r) {
    if (s[4] && ALNUM_U.test(prev)) return false;
    if (d && prev && !PUNCT_SPACE.test(prev)) return false;
  }
  const t = cx.mask();
  let l = pos;
  while (l > 0 && t[l - 1] === r) l--;
  const p = lastCodePoint(t, l);
  const h = p === '*' || p === '_' || PUNCT_SPACE.test(p);
  let n = prev;
  if (l < pos) n = p;
  const u = l < pos ? h : PUNCT_SPACE.test(n);
  if (s[4] && ALNUM_U.test(n)) return false;
  if (d && n && !u) return false;
  let k = 0;
  while (src[pos + k] === r) k++;
  const R = !!p.trim() && (!!d || (r === '*' && !h));
  const A = r === '*' ? EM_RDELIM_AST : EM_RDELIM_UND;
  const v = cx.closer(r);
  const Q = pos + k;
  if (v < Q) return false;
  const tail = t.slice(Q);
  const limit = v - Q;
  let m = k;
  let f = 0;
  const y = pos - l + k;
  A.lastIndex = 0;
  let mt;
  while ((mt = A.exec(tail)) !== null && mt.index <= limit) {
    const g = mt[1] || mt[2] || mt[3] || mt[4] || mt[5] || mt[6];
    if (!g) continue;
    let b = g.length;
    if (mt[3] || mt[4]) {
      m += b;
      continue;
    } else if (mt[5] || mt[6] || R) {
      if (sameAsPrev && (mt[5] || mt[6])) break;
      if (y % 3 && !((y + b) % 3)) {
        f += b;
        continue;
      }
    }
    m -= b;
    if (m > 0) continue;
    b = Math.min(b, b + m + f);
    const c0 = mt[0].charCodeAt(0);
    const te = c0 >= 0xd800 && c0 <= 0xdbff && mt[0].length > 1 ? 2 : 1;
    const end = pos + k + mt.index + te + b;
    A.lastIndex = 0;
    if (Math.min(k, b) % 2) {
      const inner = inline(src.slice(pos + 1, end - 1), plain);
      tokHtml = plain ? inner : '<em>' + inner + '</em>';
    } else {
      const inner = inline(src.slice(pos + 2, end - 2), plain);
      tokHtml = plain ? inner : '<strong>' + inner + '</strong>';
    }
    tokEnd = end;
    return true;
  }
  return false;
}

function delToken(cx, pos, prev, plain) {
  const src = cx.src;
  DEL_LDELIM.lastIndex = pos;
  const s = DEL_LDELIM.exec(src);
  if (s === null) return false;
  if (s[1] && prev && !PUNCT_SPACE.test(prev)) return false;
  const o = src.charCodeAt(pos + 1) === 126 ? 2 : 1;
  const t = cx.mask();
  const u = cx.closer('~');
  const d = pos + o;
  if (u < d) return false;
  const tail = t.slice(d);
  const limit = u - d;
  let p = o;
  DEL_RDELIM.lastIndex = 0;
  let mt;
  while ((mt = DEL_RDELIM.exec(tail)) !== null && mt.index <= limit) {
    const i = mt[1] || mt[2] || mt[3] || mt[4] || mt[5] || mt[6];
    if (!i) continue;
    let l = i.length;
    if (l !== o) continue;
    if (mt[3] || mt[4]) {
      p += l;
      continue;
    }
    p -= l;
    if (p > 0) continue;
    l = Math.min(l, l + p);
    const c0 = mt[0].charCodeAt(0);
    const g = c0 >= 0xd800 && c0 <= 0xdbff && mt[0].length > 1 ? 2 : 1;
    const end = pos + o + mt.index + g + l;
    DEL_RDELIM.lastIndex = 0;
    const inner = inline(src.slice(pos + o, end - o), plain);
    tokHtml = plain ? inner : '<del>' + inner + '</del>';
    tokEnd = end;
    return true;
  }
  return false;
}

function urlAhead(src, pos, c) {
  if (c === 119) {
    if (src.startsWith('www.', pos)) return true;
  } else if ((c | 32) === 104 || (c | 32) === 102) {
    if (protocolAhead(src, pos)) return true;
  } else if (c === 109 || c === 120) {
    if (mailtoAhead(src, pos)) return true;
  }
  // [A-Za-z0-9._+-]+@
  let i = pos;
  while (cls(c) & C_URLSTART) c = src.charCodeAt(++i);
  return c === 64 && i > pos;
}

function urlToken(src, pos, plain) {
  I_URL.lastIndex = pos;
  const t = I_URL.exec(src);
  if (t === null) return false;
  let raw = t[0];
  let href;
  if (t[2] === '@') href = 'mailto:' + raw;
  else {
    let prevRaw;
    do {
      prevRaw = raw;
      const b = BACKPEDAL.exec(raw);
      raw = b === null ? '' : b[0];
    } while (prevRaw !== raw);
    href = t[1] === 'www.' ? 'http://' + raw : raw;
  }
  tokEnd = pos + raw.length;
  tokHtml = plain ? raw : autolinkHtml(raw, href);
  return true;
}

function autolinkHtml(text, href) {
  const enc = encodeHref(href);
  return enc === null ? escapeAll(text) : '<a href="' + escapeAll(enc) + '">' + escapeAll(text) + '</a>';
}

// Render inline markdown to HTML (plain: the text marked's TextRenderer gives, for image alt text).
function inline(src, plain) {
  const len = src.length;
  const cx = new Ctx(src);
  const paren = src.indexOf(')') >= 0;
  const mail = src.indexOf('@') >= 0;
  let out = '';
  let text = ''; // pending merged text token
  let textOpen = false;
  let textRaw = false; // the pending text token was lexed inside raw HTML: no escaping
  let prev = '';
  let wasText = false;
  let pos = 0;
  while (pos < len) {
    if (!wasText) prev = '';
    wasText = false;
    const c = src.charCodeAt(pos);
    let hit = false;
    switch (c) {
      case 92: // backslash
        if (pos + 1 < len && I_ESCAPABLE.indexOf(src[pos + 1]) >= 0) {
          tokEnd = pos + 2;
          tokHtml = plain ? src[pos + 1] : escapeText(src[pos + 1]);
          hit = true;
        } else if (src.charCodeAt(pos + 1) === 10) {
          I_BR.lastIndex = pos;
          const m = I_BR.exec(src);
          if (m !== null) {
            tokEnd = pos + m[0].length;
            tokHtml = plain ? '' : '<br>';
            hit = true;
          }
        }
        break;
      case 60: {
        // <
        I_TAG.lastIndex = pos;
        let m = I_TAG.exec(src);
        if (m !== null) {
          const raw = m[0];
          if (!inLink && /^<a /i.test(raw)) inLink = true;
          else if (inLink && /^<\/a>/i.test(raw)) inLink = false;
          if (!inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(raw)) inRawBlock = true;
          else if (inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(raw)) inRawBlock = false;
          tokEnd = pos + raw.length;
          tokHtml = raw;
          hit = true;
          break;
        }
        I_AUTOLINK.lastIndex = pos;
        m = I_AUTOLINK.exec(src);
        if (m !== null) {
          tokEnd = pos + m[0].length;
          tokHtml = plain ? m[1] : autolinkHtml(m[1], m[2] === '@' ? 'mailto:' + m[1] : m[1]);
          hit = true;
        }
        break;
      }
      case 33: // !
      case 91: {
        // [
        if (c === 33 && src.charCodeAt(pos + 1) !== 91) break;
        if (paren && linkToken(src, pos, plain)) {
          hit = true;
          break;
        }
        const r = refLinkToken(src, pos, plain);
        if (r === 1) hit = true;
        else if (r === 2) {
          // The unmatched opening character becomes text, merged like any text token.
          const ch = src[pos];
          if (textOpen) text += ch;
          else {
            text = ch;
            textOpen = true;
            textRaw = false;
          }
          pos++;
          continue;
        }
        break;
      }
      case 42: // *
      case 95: // _
        if (emStrongToken(cx, pos, prev, plain)) hit = true;
        else if (c === 95 && !inLink && urlAhead(src, pos, c) && urlToken(src, pos, plain)) hit = true;
        break;
      case 96: {
        // `
        I_CODE.lastIndex = pos;
        const m = I_CODE.exec(src);
        if (m !== null) {
          let t = m[2].replace(/\n/g, ' ');
          if (/[^ ]/.test(t) && t.charCodeAt(0) === 32 && t.charCodeAt(t.length - 1) === 32) t = t.substring(1, t.length - 1);
          tokEnd = pos + m[0].length;
          tokHtml = plain ? t : '<code>' + escapeAll(t) + '</code>';
          hit = true;
        }
        break;
      }
      case 32:
        if (src.charCodeAt(pos + 1) === 32) {
          I_BR.lastIndex = pos;
          const m = I_BR.exec(src);
          if (m !== null) {
            tokEnd = pos + m[0].length;
            tokHtml = plain ? '' : '<br>';
            hit = true;
          }
        }
        break;
      case 126: // ~
        hit = delToken(cx, pos, prev, plain);
        break;
      default:
        if (!inLink && c < 128 && CLS[c] & C_URLSTART && urlAhead(src, pos, c)) hit = urlToken(src, pos, plain);
    }
    if (hit) {
      if (textOpen) {
        out += plain || textRaw ? text : escapeText(text);
        textOpen = false;
      }
      out += tokHtml;
      pos = tokEnd;
      continue;
    }
    // Plain text up to the next place another token could start.
    const end = textEnd(src, pos, mail);
    const raw = src.slice(pos, end);
    const piece = inRawBlock ? raw : decodeNumeric(raw);
    if (textOpen) text += piece;
    else {
      text = piece;
      textOpen = true;
      textRaw = inRawBlock;
    }
    const lc = src.charCodeAt(end - 1);
    if (lc !== 95) prev = src[end - 1];
    wasText = true;
    pos = end;
  }
  if (textOpen) out += plain || textRaw ? text : escapeText(text);
  return out;
}

// ---------------------------------------------------------------- block renderer

function renderBlocks(toks) {
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    switch (t.type) {
      case 'paragraph':
        out += '<p>' + t.pre + t.html + '</p>\n';
        break;
      case 'text':
        out += t.pre + t.html;
        break;
      case 'heading':
        out += '<h' + t.depth + '>' + t.html + '</h' + t.depth + '>\n';
        break;
      case 'code': {
        const lang = (t.lang || '').match(/^\S*/)[0];
        const body = t.text ? escapeAll(t.text.replace(/\n$/, '') + '\n') : '';
        out += (lang ? '<pre><code class="language-' + escapeText(lang) + '">' : '<pre><code>') + body + '</code></pre>\n';
        break;
      }
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        out += '<' + tag + (t.ordered && t.start !== 1 ? ' start="' + t.start + '"' : '') + '>\n';
        for (const item of t.items) out += '<li>' + renderBlocks(item.tokens) + '</li>\n';
        out += '</' + tag + '>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(t.tokens) + '</blockquote>\n';
        break;
      case 'html':
        out += t.text;
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let j = 0; j < t.header.length; j++) out += cell('th', t.align[j], t.header[j].html);
        out += '</tr>\n</thead>\n';
        if (t.rows.length) {
          out += '<tbody>';
          for (const row of t.rows) {
            out += '<tr>\n';
            for (let j = 0; j < row.length; j++) out += cell('td', t.align[j], row[j].html);
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
      case 'checkbox':
        out += t.html;
        break;
    }
  }
  return out;
}

function cell(tag, align, html) {
  return (align ? '<' + tag + ' align="' + align + '">' : '<' + tag + '>') + html + '</' + tag + '>\n';
}

// ---------------------------------------------------------------- entry point

/** The HTML marked 18.1.3 renders for `markdown` with its default options. */
export function parse(markdown) {
  links = Object.create(null);
  queue = [];
  top = true;
  inLink = false;
  inRawBlock = false;
  linkEmitted = false;
  const src = markdown.indexOf('\r') < 0 ? markdown : markdown.replace(/\r\n|\r/g, '\n');
  const toks = lexBlocks(src, [], false);
  for (let i = 0; i < queue.length; i++) {
    const q = queue[i];
    inRawBlock = false;
    q.html = inline(q.src, false);
  }
  const html = renderBlocks(toks);
  queue = [];
  links = Object.create(null);
  return html;
}
