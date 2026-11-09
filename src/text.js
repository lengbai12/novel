// Local TXT and EPUB import. Port of novel_text.py and novel_app.py import_book().

const MAX_UPLOAD_BYTES = 33554432;
const MAX_TEXT_CHARACTERS = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_MEMBER_BYTES = 16 * 1024 * 1024;
const MAX_MEMBERS = 3000;
const CHUNK_CHARACTERS = 12000;
const BAD_ARCHIVE = 'EPUB 不是有效的电子书压缩包。';
const HTML_ENCODING = 'EPUB 正文编码无效。';

const HEADING_NUMBER = '零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟\\p{Nd}';
const HEADING = new RegExp(
  `^(?:第\\s*[${HEADING_NUMBER}]+\\s*[章回节卷](?:\\s*.*|[：:、.．—－-].*)?` +
    '|chapter\\s+(?:\\p{Nd}+|[ivxlcdm]+|[a-z]+(?:[ -][a-z]+)*)(?:(?![\\p{L}\\p{N}_]).*)?)$',
  'iu',
);
const HEADING_UNIT = new RegExp(`^第\\s*[${HEADING_NUMBER}]+\\s*([章回节卷])`, 'u');
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ufeff\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

const HTML_SKIP = new Set(['script', 'style', 'nav', 'noscript', 'template', 'iframe', 'object', 'svg', 'canvas', 'form']);
const HTML_BLOCK = new Set(['p', 'div', 'section', 'article', 'blockquote', 'pre', 'li', 'ul', 'ol', 'dl', 'dt', 'dd',
  'table', 'tr', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const HTML_VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param',
  'source', 'track', 'wbr']);
const HTML_HEADINGS = new Set(['h1', 'h2', 'h3']);

const codePoints = (text) => [...text].length;
const localTag = (name) => name.split(':').pop().toLowerCase();
const foldKey = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function clean(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0085\u2028\u2029]/gu, '\n')
    .replace(UNSAFE, '');
}

function titleText(text) {
  return clean(text).split(/\s+/u).join(' ').trim();
}

function isHeading(candidate) {
  if (codePoints(candidate) > 160 || !HEADING.test(candidate)) return false;
  // Headings do not end in sentence punctuation, and paragraphs commonly do.
  if (/[。！？；;]/.test(candidate)) return false;
  const unit = HEADING_UNIT.exec(candidate);
  if (unit && unit[1] === '节') {
    const after = candidate.slice(unit[0].length);
    // "第一节课是..." is a sentence; a real section needs a separator or end of line.
    if (after && !/^(?:\s+|[：:、.．—－-])/.test(after)) return false;
    // "第一节 课是生物，正是……" uses the section word as narrative.
    if (/[，,]/.test(candidate)) return false;
  }
  return true;
}

function boundedChapters(title, text) {
  if (!text.trim()) return [];
  const half = CHUNK_CHARACTERS / 2;
  const chunks = [];
  let start = 0;
  while (text.length - start > CHUNK_CHARACTERS) {
    let end = start + CHUNK_CHARACTERS;
    const paragraph = text.lastIndexOf('\n\n', end - 2);
    if (paragraph >= start + half) {
      end = paragraph + 2;
    } else {
      const line = text.lastIndexOf('\n', end - 1);
      if (line >= start + half) end = line + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) chunks.push(text.slice(start));
  if (chunks.length === 1) return [[title, chunks[0]]];
  return chunks.map((part, i) => [`${title}（第 ${i + 1} 部分）`, part]);
}

function textChapters(text) {
  const headings = [];
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const candidate = line.trim();
    if (isHeading(candidate)) headings.push([offset, offset + line.length, candidate]);
    offset += line.length;
  }

  // A contents page has several headings separated only by short title/page
  // lines, unlike chapters with prose. Keep those entries in frontmatter.
  const contents = new Set();
  let runStart = 0;
  for (let index = 0; index < headings.length; index++) {
    const [, end, candidate] = headings[index];
    const nextStart = index + 1 < headings.length ? headings[index + 1][0] : text.length;
    const between = text.slice(end, nextStart);
    const shortEntry = codePoints(between.trim()) <= 160 &&
      between.split('\n').filter((line) => line.trim()).length <= 3 &&
      !/[。！？!?]/.test(between);
    if (shortEntry) continue;
    if (index - runStart >= 3) {
      // Include the final listing entry when a later real chapter repeats
      // it, or when the run is explicitly introduced as a contents page.
      // Otherwise keep this boundary: it may already be the first chapter.
      const runAt = headings[runStart][0];
      const prefix = text.slice(Math.max(0, runAt - 2000), runAt);
      const labelled = /(?:(?<![\p{L}\p{N}_])contents(?![\p{L}\p{N}_])|目\s*录)/iu.test(prefix);
      const key = foldKey(candidate);
      const repeated = headings.slice(index + 1).some(([, , later]) => foldKey(later) === key);
      const listedBefore = headings.slice(runStart, index).some(([, , earlier]) => foldKey(earlier) === key);
      const last = index + (repeated || (labelled && !listedBefore) ? 1 : 0);
      for (let i = runStart; i < last; i++) contents.add(i);
    }
    runStart = index + 1;
  }
  if (headings.length - runStart >= 3) {
    for (let i = runStart; i < headings.length; i++) contents.add(i);
  }

  const chapters = [];
  let heading = '正文';
  let sectionStart = 0;
  let found = false;
  for (let index = 0; index < headings.length; index++) {
    if (contents.has(index)) continue;
    const [start, , candidate] = headings[index];
    if (start > sectionStart && text.slice(sectionStart, start).trim()) {
      chapters.push(...boundedChapters(found ? heading : '前言', text.slice(sectionStart, start)));
      sectionStart = start;
    } else if (found) {
      sectionStart = start;
    }
    // Leading whitespace stays attached to the first chapter.
    heading = candidate;
    found = true;
  }
  chapters.push(...boundedChapters(heading, text.slice(sectionStart)));
  return chapters;
}

const startsWithBytes = (bytes, prefix) => prefix.every((byte, i) => bytes[i] === byte);

function decodeTxt(bytes) {
  if (startsWithBytes(bytes, [0xff, 0xfe]) || startsWithBytes(bytes, [0xfe, 0xff]) ||
      startsWithBytes(bytes, [0x00, 0x00, 0xfe, 0xff])) {
    throw new Error('TXT 请使用 UTF-8 或 GB18030 编码，不支持 UTF-16/UTF-32。');
  }
  const encodings = startsWithBytes(bytes, [0xef, 0xbb, 0xbf]) ? ['utf-8'] : ['utf-8', 'gb18030'];
  for (const encoding of encodings) {
    try {
      return clean(new TextDecoder(encoding, {fatal: true}).decode(bytes));
    } catch {
      // Try the next encoding.
    }
  }
  throw new Error('TXT 编码无效，请另存为 UTF-8 或 GB18030 后重试。');
}

// Decodes XML or XHTML bytes using the BOM or the declared encoding.
function decodeMarkup(bytes) {
  if (startsWithBytes(bytes, [0xff, 0xfe, 0x00, 0x00]) || startsWithBytes(bytes, [0x00, 0x00, 0xfe, 0xff])) {
    // TextDecoder has no UTF-32 support.
    throw new Error(HTML_ENCODING);
  }
  let label = 'utf-8';
  if (startsWithBytes(bytes, [0xff, 0xfe])) label = 'utf-16le';
  else if (startsWithBytes(bytes, [0xfe, 0xff])) label = 'utf-16be';
  else if (!startsWithBytes(bytes, [0xef, 0xbb, 0xbf])) {
    const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 512));
    const match = /<\?xml\b[^>]*\bencoding\s*=\s*['"]([A-Za-z0-9._-]+)['"]/i.exec(head);
    if (match) label = match[1];
  }
  try {
    return new TextDecoder(label, {fatal: true}).decode(bytes);
  } catch {
    throw new Error(HTML_ENCODING);
  }
}

function parseXml(bytes, label) {
  const doc = new DOMParser().parseFromString(decodeMarkup(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length || !doc.documentElement) {
    throw new Error(`EPUB 的${label}格式损坏。`);
  }
  return doc.documentElement;
}

const localName = (element) => element.localName.toLowerCase();
const childElements = (element) => Array.from(element.children);
const descendantElements = (element) => Array.from(element.getElementsByTagName('*'));

function archiveName(name) {
  return name.split('/').filter((part) => part && part !== '.').join('/');
}

function resourcePath(base, reference) {
  let path;
  try {
    path = decodeURIComponentStrict(reference.split(/[?#]/)[0]);
  } catch {
    throw new Error('EPUB 包含无效或外部资源路径。');
  }
  const parts = base ? base.split('/').slice(0, -1) : [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('EPUB 的资源路径越过了书籍根目录。');
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  if (!parts.length) throw new Error('EPUB 的资源路径无效。');
  return parts.join('/');
}

// Decodes only %XX sequences and fails on invalid UTF-8, like urllib unquote(errors='strict').
function decodeURIComponentStrict(path) {
  return path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => decodeURIComponent(run));
}

const CRC_TABLE = Array.from({length: 256}, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Reads the central directory. ZIP64 archives are not supported.
function readEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = new TextDecoder('utf-8');
  try {
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(BAD_ARCHIVE);
    const count = view.getUint16(eocd + 10, true);
    const offset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || offset === 0xffffffff) throw new Error(BAD_ARCHIVE);
    const entries = [];
    let position = offset;
    for (let n = 0; n < count; n++) {
      if (view.getUint32(position, true) !== 0x02014b50) throw new Error(BAD_ARCHIVE);
      const nameLength = view.getUint16(position + 28, true);
      entries.push({
        name: names.decode(bytes.subarray(position + 46, position + 46 + nameLength)),
        flags: view.getUint16(position + 8, true),
        method: view.getUint16(position + 10, true),
        crc: view.getUint32(position + 16, true),
        compressedSize: view.getUint32(position + 20, true),
        size: view.getUint32(position + 24, true),
        externalAttr: view.getUint32(position + 38, true),
        localOffset: view.getUint32(position + 42, true),
      });
      position += 46 + nameLength + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
    }
    return entries;
  } catch {
    throw new Error(BAD_ARCHIVE);
  }
}

async function inflate(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function extract(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.localOffset;
  if (view.getUint32(local, true) !== 0x04034b50) throw new Error('corrupt');
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const raw = bytes.subarray(start, start + entry.compressedSize);
  if (raw.length !== entry.compressedSize) throw new Error('corrupt');
  let data;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = await inflate(raw);
  else throw new Error('corrupt');
  if (crc32(data) !== entry.crc) throw new Error('corrupt');
  return data;
}

async function epub(bytes, defaultTitle) {
  const entries = readEntries(bytes);
  if (entries.length > MAX_MEMBERS) throw new Error('EPUB 文件数量超过 3000 个。');
  const members = new Map();
  let expanded = 0;
  for (const entry of entries) {
    if (entry.flags & 1) throw new Error('不支持加密或受 DRM 保护的 EPUB。');
    const name = archiveName(entry.name);
    if (((entry.externalAttr >>> 16) & 0o170000) === 0o120000) {
      throw new Error('EPUB 不允许包含符号链接。');
    }
    if (entry.size > MAX_MEMBER_BYTES) throw new Error('EPUB 中单个文件解压后超过 16 MiB。');
    expanded += entry.size;
    if (expanded > MAX_ARCHIVE_BYTES) throw new Error('EPUB 解压后总大小超过 64 MiB。');
    if (members.has(name)) throw new Error('EPUB 包含重复的文件路径。');
    members.set(name, {...entry, name, isDirectory: entry.name.endsWith('/')});
  }
  if ([...members.keys()].some((name) => name.toLowerCase() === 'meta-inf/encryption.xml')) {
    throw new Error('不支持加密或受 DRM 保护的 EPUB。');
  }

  const load = async (name) => {
    const entry = members.get(name);
    if (!entry || entry.isDirectory) throw new Error(`EPUB 缺少所需文件：${name}`);
    let data;
    try {
      data = await extract(bytes, entry);
    } catch {
      throw new Error(`EPUB 文件损坏或压缩方式不受支持：${name}`);
    }
    if (data.length > MAX_MEMBER_BYTES || data.length !== entry.size) {
      throw new Error('EPUB 文件解压大小无效或超过限制。');
    }
    return data;
  };

  const container = parseXml(await load('META-INF/container.xml'), '目录文件');
  if (localName(container) !== 'container') throw new Error('EPUB 的目录文件格式无效。');
  const rootfiles = descendantElements(container).filter((node) => localName(node) === 'rootfile');
  if (!rootfiles.length) throw new Error('EPUB 未指定 OPF 书籍目录。');
  const rootfile = rootfiles.find((node) => node.getAttribute('media-type') === 'application/oebps-package+xml') ||
    rootfiles[0];
  const packagePath = resourcePath('', rootfile.getAttribute('full-path') || '');
  const pkg = parseXml(await load(packagePath), 'OPF 文件');
  if (localName(pkg) !== 'package') throw new Error('EPUB 的 OPF 文件格式无效。');

  let title = defaultTitle;
  const metadata = childElements(pkg).find((node) => localName(node) === 'metadata');
  if (metadata) {
    for (const node of childElements(metadata)) {
      if (localName(node) !== 'title') continue;
      const value = titleText(node.textContent);
      if (value) {
        title = value;
        break;
      }
    }
  }
  const manifest = childElements(pkg).find((node) => localName(node) === 'manifest');
  const spine = childElements(pkg).find((node) => localName(node) === 'spine');
  if (!manifest || !spine) throw new Error('EPUB 缺少正文清单或阅读顺序。');
  const items = new Map();
  for (const node of childElements(manifest)) {
    if (localName(node) !== 'item') continue;
    const id = node.getAttribute('id') || '';
    if (!id || items.has(id)) throw new Error('EPUB 的正文清单标识无效或重复。');
    items.set(id, {
      path: resourcePath(packagePath, node.getAttribute('href') || ''),
      mediaType: (node.getAttribute('media-type') || '').toLowerCase(),
      properties: new Set((node.getAttribute('properties') || '').toLowerCase().split(/\s+/).filter(Boolean)),
    });
  }

  const chapters = [];
  let characterCount = 0;
  for (const node of childElements(spine)) {
    if (localName(node) !== 'itemref') continue;
    const item = items.get(node.getAttribute('idref') || '');
    if (!item) throw new Error('EPUB 的阅读顺序引用了不存在的正文。');
    if (item.properties.has('nav') || item.mediaType.startsWith('image/')) continue;
    if (item.mediaType !== 'application/xhtml+xml' && item.mediaType !== 'text/html') {
      throw new Error(`EPUB 的正文格式不受支持：${item.mediaType || '未声明格式'}`);
    }
    let parsed;
    try {
      parsed = chapterHTML(decodeMarkup(await load(item.path)));
    } catch {
      throw new Error(`EPUB 正文格式无效：${item.path}`);
    }
    if (!parsed.hasDocument) throw new Error(`EPUB 正文缺少 HTML 文档结构：${item.path}`);
    if (!parsed.text) continue;
    characterCount += parsed.text.length;
    if (characterCount > MAX_TEXT_CHARACTERS) {
      throw new Error('小说正文超过 64 Mi 字元安全上限，请拆分后导入。');
    }
    chapters.push(...boundedChapters(parsed.title || `第 ${chapters.length + 1} 章`, parsed.text));
  }
  return {title, chapters};
}

// Collects visible prose and headings from an XHTML spine document.
function chapterHTML(source) {
  const state = {parts: [], documentTitle: [], firstHeading: [], headingDepth: 0, headingComplete: false};

  const breakParagraph = () => {
    if (state.parts.length && state.parts[state.parts.length - 1] !== '\n\n') state.parts.push('\n\n');
  };

  const visitText = (data, context) => {
    if (context.hidden) return;
    if (context.title) state.documentTitle.push(data);
    if (context.head) return;
    // HTML source indentation is not prose spacing; block tags supply paragraphs.
    let text = clean(data);
    if (!context.pre) text = text.replace(/\s+/gu, ' ');
    if (text) {
      state.parts.push(text);
      if (state.headingDepth) state.firstHeading.push(text);
    }
  };

  const visitElement = (element, parent) => {
    const name = localTag(element.tagName);
    const attributes = {};
    for (const attribute of element.attributes) attributes[localTag(attribute.name)] = attribute.value;
    const semantics = (attributes.type || '').toLowerCase().split(/\s+/);
    const role = (attributes.role || '').toLowerCase().split(/\s+/);
    const style = (attributes.style || '').toLowerCase().replace(/\s+/g, '');
    const hidden = parent.hidden || HTML_SKIP.has(name) || 'hidden' in attributes ||
      (attributes['aria-hidden'] || '').toLowerCase() === 'true' ||
      semantics.some((token) => ['toc', 'landmarks', 'page-list'].includes(token)) ||
      role.some((token) => ['navigation', 'doc-toc', 'doc-pagelist'].includes(token)) ||
      style.includes('display:none') || style.includes('visibility:hidden');
    const context = {
      hidden,
      head: parent.head || name === 'head',
      pre: parent.pre || name === 'pre',
      title: parent.title || name === 'title',
    };

    if (HTML_VOID.has(name)) {
      if (!parent.hidden && !parent.head) {
        if (name === 'br') state.parts.push('\n');
        else if (name === 'hr') breakParagraph();
      }
      return;
    }

    const visible = !context.hidden && !context.head;
    if (visible && HTML_BLOCK.has(name)) breakParagraph();
    const counts = visible && HTML_HEADINGS.has(name) && !state.headingComplete;
    if (counts) state.headingDepth++;
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) visitText(child.data, context);
      else if (child.nodeType === Node.ELEMENT_NODE) visitElement(child, context);
    }
    if (counts) {
      state.headingDepth--;
      if (!state.headingDepth) state.headingComplete = !!titleText(state.firstHeading.join(''));
    }
    if (visible && HTML_BLOCK.has(name)) breakParagraph();
  };

  const doc = new DOMParser().parseFromString(source, 'text/html');
  visitElement(doc.documentElement, {hidden: false, head: false, pre: false, title: false});
  const title = titleText(state.firstHeading.join('')) || titleText(state.documentTitle.join(''));
  const text = clean(state.parts.join(''))
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // The parser always creates html and body, so the document check reads the source tags.
  const hasDocument = /<(?:[^\s/>:]+:)?(?:html|body)[\s/>]/i.test(source);
  return {title, text, hasDocument};
}

// Returns [title, text] pairs in reading order, each at most CHUNK_CHARACTERS long.
async function importNovel(filename, bytes) {
  if (!bytes.length) throw new Error('上传文件为空。');
  const basename = filename.replace(/\\/g, '/').split('/').pop();
  const dot = basename.lastIndexOf('.');
  const extension = dot > 0 && /[^.]/.test(basename.slice(0, dot)) ? basename.slice(dot) : '';
  const stem = dot > 0 && extension ? basename.slice(0, dot) : basename;
  const defaultTitle = titleText(stem) || '未命名小说';
  let title;
  let chapters;
  if (extension.toLowerCase() === '.txt') {
    title = defaultTitle;
    const text = decodeTxt(bytes);
    if (codePoints(text) > MAX_TEXT_CHARACTERS) {
      throw new Error('小说正文超过 64 Mi 字元安全上限，请拆分后导入。');
    }
    chapters = textChapters(text);
  } else if (extension.toLowerCase() === '.epub') {
    ({title, chapters} = await epub(bytes, defaultTitle));
  } else {
    throw new Error('仅支持 .txt 和 .epub 格式的小说。');
  }
  if (!chapters.length || !chapters.some(([, text]) => text.trim())) {
    throw new Error('小说中没有可阅读的正文。');
  }
  return {title, chapters};
}

export async function parseBook(filename, buffer) {
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error('文件超过32MiB上限；未截断，请拆分文件后导入。');
  }
  const {title, chapters} = await importNovel(filename, new Uint8Array(buffer));
  return {
    title,
    chapters: chapters.map(([heading, text], index) => ({number: index + 1, title: heading, text})),
  };
}
