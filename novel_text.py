"""Import local TXT and EPUB novels without extracting archive files."""

from __future__ import annotations

import codecs
import io
import posixpath
import re
import stat
import zipfile
import zlib
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

MAX_UPLOAD_BYTES = 33554432
MAX_TEXT_CHARACTERS = 64 * 1024 * 1024
_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
_MAX_MEMBER_BYTES = 16 * 1024 * 1024
_MAX_MEMBERS = 3000
_CHUNK_CHARACTERS = 12000
_HEADING = re.compile(
    r"^(?:第\s*[零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟\d]+"
    r"\s*[章回节卷](?:\s*.*|[：:、.．—－-].*)?"
    r"|chapter\s+(?:\d+|[ivxlcdm]+|[a-z]+(?:[ -][a-z]+)*)(?:\b.*)?)$",
    re.IGNORECASE,
)
_HEADING_UNIT = re.compile(
    r"^第\s*[零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟\d]+\s*([章回节卷])"
)


def _is_heading(candidate: str) -> bool:
    """A line that names a chapter, not a paragraph whose first sentence starts similarly."""
    if len(candidate) > 160 or not _HEADING.fullmatch(candidate):
        return False
    # Headings do not end in sentence punctuation, and paragraphs commonly do.
    if re.search(r"[。！？；;]", candidate):
        return False
    unit = _HEADING_UNIT.match(candidate)
    if unit and unit.group(1) == "节":
        after = candidate[unit.end():]
        # "第一节课是..." is a sentence; a real section needs a separator or end of line.
        if after and not re.match(r"^(?:\s+|[：:、.．—－-])", after):
            return False
        # "第一节 课是生物，正是……" uses the section word as narrative.
        if re.search(r"[，,]", candidate):
            return False
    return True


_UNSAFE = dict.fromkeys(
    [n for n in range(32) if n not in (9, 10)]
    + list(range(127, 160))
    + [0xFEFF, 0x061C, 0x200E, 0x200F]
    + list(range(0x202A, 0x202F))
    + list(range(0x2066, 0x206A))
)


def _clean(text: str) -> str:
    return (
        text.replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\u0085", "\n")
        .replace("\u2028", "\n")
        .replace("\u2029", "\n")
        .translate(_UNSAFE)
    )


def _title(text: str) -> str:
    return " ".join(_clean(text).split()).strip()


def _bounded_chapters(title: str, text: str) -> list[tuple[str, str]]:
    if not text.strip():
        return []
    chunks = []
    start = 0
    while len(text) - start > _CHUNK_CHARACTERS:
        end = start + _CHUNK_CHARACTERS
        boundary = text.rfind("\n\n", start, end)
        if boundary >= start + _CHUNK_CHARACTERS // 2:
            end = boundary + 2
        else:
            boundary = text.rfind("\n", start, end)
            if boundary >= start + _CHUNK_CHARACTERS // 2:
                end = boundary + 1
        chunks.append(text[start:end])
        start = end
    if start < len(text):
        chunks.append(text[start:])
    if len(chunks) == 1:
        return [(title, chunks[0])]
    return [(f"{title}（第 {i} 部分）", part) for i, part in enumerate(chunks, 1)]


def _text_chapters(text: str) -> list[tuple[str, str]]:
    headings = []
    offset = 0
    for line in text.splitlines(keepends=True):
        candidate = line.strip()
        if len(candidate) <= 160 and _is_heading(candidate):
            headings.append((offset, offset + len(line), candidate))
        offset += len(line)

    # A contents page has several headings separated only by short title/page
    # lines, unlike chapters with prose. Keep those entries in frontmatter.
    contents = set()
    run_start = 0
    for index, (_, end, _) in enumerate(headings):
        next_start = headings[index + 1][0] if index + 1 < len(headings) else len(text)
        between = text[end:next_start]
        short_entry = (
            len(between.strip()) <= 160
            and sum(bool(line.strip()) for line in between.splitlines()) <= 3
            and not re.search(r"[。！？!?]", between)
        )
        if short_entry:
            continue
        if index - run_start >= 3:
            # Include the final listing entry when a later real chapter repeats
            # it, or when the run is explicitly introduced as a contents page.
            # Otherwise keep this boundary: it may already be the first chapter.
            prefix = text[max(0, headings[run_start][0] - 2000):headings[run_start][0]]
            labelled = bool(re.search(r"(?:\bcontents\b|目\s*录)", prefix, re.IGNORECASE))
            key = re.sub(r"[\W_]+", "", headings[index][2].casefold())
            repeated = any(
                re.sub(r"[\W_]+", "", later.casefold()) == key
                for _, _, later in headings[index + 1:]
            )
            listed_before = any(
                re.sub(r"[\W_]+", "", earlier.casefold()) == key
                for _, _, earlier in headings[run_start:index]
            )
            contents.update(range(run_start, index + int(repeated or (labelled and not listed_before))))
        run_start = index + 1
    if len(headings) - run_start >= 3:
        contents.update(range(run_start, len(headings)))

    chapters = []
    heading = "正文"
    section_start = 0
    found = False
    for index, (start, _, candidate) in enumerate(headings):
        if index in contents:
            continue
        if start > section_start and text[section_start:start].strip():
            chapters.extend(
                _bounded_chapters(heading if found else "前言", text[section_start:start])
            )
            section_start = start
        elif found:
            section_start = start
        # Leading whitespace stays attached to the first chapter.
        heading = candidate
        found = True
    chapters.extend(_bounded_chapters(heading, text[section_start:]))
    return chapters


def _decode_txt(content: bytes) -> str:
    if content.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE, codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        raise ValueError("TXT 请使用 UTF-8 或 GB18030 编码，不支持 UTF-16/UTF-32。")
    encodings = ("utf-8-sig",) if content.startswith(codecs.BOM_UTF8) else ("utf-8", "gb18030")
    for encoding in encodings:
        try:
            return _clean(content.decode(encoding, errors="strict"))
        except UnicodeDecodeError:
            pass
    raise ValueError("TXT 编码无效，请另存为 UTF-8 或 GB18030 后重试。")


def _local_name(name: str) -> str:
    return name.rsplit("}", 1)[-1].rsplit(":", 1)[-1].lower()


def _xml(content: bytes, label: str) -> ElementTree.Element:
    declaration_check = content.replace(b"\x00", b"").lower()
    if b"<!doctype" in declaration_check or b"<!entity" in declaration_check:
        raise ValueError(f"EPUB 的{label}含有不安全的 XML 声明。")
    try:
        return ElementTree.fromstring(content)
    except (ElementTree.ParseError, ValueError, LookupError) as exc:
        raise ValueError(f"EPUB 的{label}格式损坏。") from exc


def _archive_name(name: str) -> str:
    if not name or "\\" in name or name.startswith("/") or ":" in name or any(ord(c) < 32 for c in name):
        raise ValueError("EPUB 包含不安全的文件路径。")
    parts = name.split("/")
    if ".." in parts:
        raise ValueError("EPUB 包含越界的文件路径。")
    return "/".join(part for part in parts if part and part != ".")


def _resolve(base: str, reference: str) -> str:
    try:
        url = urlsplit(reference)
        if url.scheme or url.netloc:
            raise ValueError("EPUB 包含外部资源路径，不支持联网读取。")
        path = unquote(url.path, encoding="utf-8", errors="strict")
    except (UnicodeError, ValueError) as exc:
        raise ValueError("EPUB 包含无效或外部资源路径。") from exc
    if not path or path.startswith("/") or "\\" in path or ":" in path or any(ord(c) < 32 for c in path):
        raise ValueError("EPUB 包含不安全的资源路径。")
    parts = base.split("/")[:-1] if base else []
    for part in path.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                raise ValueError("EPUB 的资源路径越过了书籍根目录。")
            parts.pop()
        else:
            parts.append(part)
    if not parts:
        raise ValueError("EPUB 的资源路径无效。")
    return "/".join(parts)


def _decode_html(content: bytes) -> str:
    if content.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        encoding = "utf-32"
    elif content.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        encoding = "utf-16"
    elif content.startswith(codecs.BOM_UTF8):
        encoding = "utf-8-sig"
    else:
        match = re.search(br"<\?xml\b[^>]*\bencoding\s*=\s*['\"]([A-Za-z0-9._-]+)['\"]", content[:512], re.I)
        encoding = match.group(1).decode("ascii") if match else "utf-8"
    try:
        return content.decode(encoding, errors="strict")
    except (UnicodeError, LookupError) as exc:
        raise ValueError("EPUB 正文编码无效。") from exc


class _ChapterHTML(HTMLParser):
    """Collect visible prose and headings from an XHTML spine document."""

    _SKIP = {"script", "style", "nav", "noscript", "template", "iframe", "object", "svg", "canvas", "form"}
    _BLOCK = {"p", "div", "section", "article", "blockquote", "pre", "li", "ul", "ol", "dl", "dt", "dd", "table", "tr", "hr", "h1", "h2", "h3", "h4", "h5", "h6"}
    _VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, bool]] = []
        self.hidden_depth = 0
        self.head_depth = 0
        self.pre_depth = 0
        self.title_depth = 0
        self.heading_depth = 0
        self.parts: list[str] = []
        self.document_title: list[str] = []
        self.first_heading: list[str] = []
        self.heading_complete = False
        self.has_document = False

    def _break(self) -> None:
        if self.parts and self.parts[-1] != "\n\n":
            self.parts.append("\n\n")

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = _local_name(tag)
        attributes = {_local_name(key): value or "" for key, value in attrs}
        if tag in {"html", "body"}:
            self.has_document = True
        semantics = set(attributes.get("type", "").lower().split())
        role = set(attributes.get("role", "").lower().split())
        style = re.sub(r"\s+", "", attributes.get("style", "").lower())
        hidden = (
            tag in self._SKIP
            or "hidden" in attributes
            or attributes.get("aria-hidden", "").lower() == "true"
            or bool(semantics & {"toc", "landmarks", "page-list"})
            or bool(role & {"navigation", "doc-toc", "doc-pagelist"})
            or "display:none" in style
            or "visibility:hidden" in style
        )
        if tag in self._VOID:
            if not self.hidden_depth and not self.head_depth:
                if tag == "br":
                    self.parts.append("\n")
                elif tag == "hr":
                    self._break()
            return
        self.stack.append((tag, hidden))
        if hidden:
            self.hidden_depth += 1
        if tag == "head":
            self.head_depth += 1
        if tag == "pre":
            self.pre_depth += 1
        if tag == "title":
            self.title_depth += 1
        if not self.hidden_depth and not self.head_depth:
            if tag in self._BLOCK:
                self._break()
            if tag in {"h1", "h2", "h3"} and not self.heading_complete:
                self.heading_depth += 1

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if _local_name(tag) not in self._VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = _local_name(tag)
        index = next((i for i in range(len(self.stack) - 1, -1, -1) if self.stack[i][0] == tag), None)
        if index is None:
            return
        removed = self.stack[index:]
        del self.stack[index:]
        was_visible = not self.hidden_depth and not self.head_depth
        for name, hidden in reversed(removed):
            if hidden:
                self.hidden_depth -= 1
            if name == "head":
                self.head_depth -= 1
            if name == "pre":
                self.pre_depth -= 1
            if name == "title":
                self.title_depth -= 1
            if name in {"h1", "h2", "h3"} and self.heading_depth:
                self.heading_depth -= 1
                if not self.heading_depth:
                    self.heading_complete = bool(_title("".join(self.first_heading)))
        if was_visible and tag in self._BLOCK:
            self._break()

    def handle_data(self, data: str) -> None:
        if self.hidden_depth:
            return
        if self.title_depth:
            self.document_title.append(data)
        if self.head_depth:
            return
        # HTML source indentation is not prose spacing; block tags supply paragraphs.
        text = _clean(data)
        if not self.pre_depth:
            text = re.sub(r"\s+", " ", text)
        if text:
            self.parts.append(text)
            if self.heading_depth:
                self.first_heading.append(text)

    def result(self) -> tuple[str, str]:
        title = _title("".join(self.first_heading)) or _title("".join(self.document_title))
        text = _clean("".join(self.parts))
        text = re.sub(r"[ \t]*\n[ \t]*", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        return title, text


def _epub(content: bytes, default_title: str) -> tuple[str, list[tuple[str, str]]]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except (zipfile.BadZipFile, OSError, UnicodeError, ValueError, EOFError) as exc:
        raise ValueError("EPUB 不是有效的电子书压缩包。") from exc
    with archive:
        entries = archive.infolist()
        if len(entries) > _MAX_MEMBERS:
            raise ValueError("EPUB 文件数量超过 3000 个。")
        members: dict[str, zipfile.ZipInfo] = {}
        expanded = 0
        for entry in entries:
            if entry.flag_bits & 1:
                raise ValueError("不支持加密或受 DRM 保护的 EPUB。")
            name = _archive_name(entry.orig_filename)
            if not name:
                raise ValueError("EPUB 包含无效的文件路径。")
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValueError("EPUB 不允许包含符号链接。")
            if entry.file_size > _MAX_MEMBER_BYTES:
                raise ValueError("EPUB 中单个文件解压后超过 16 MiB。")
            expanded += entry.file_size
            if expanded > _MAX_ARCHIVE_BYTES:
                raise ValueError("EPUB 解压后总大小超过 64 MiB。")
            if name in members:
                raise ValueError("EPUB 包含重复的文件路径。")
            members[name] = entry
        if any(name.casefold() == "meta-inf/encryption.xml" for name in members):
            raise ValueError("不支持加密或受 DRM 保护的 EPUB。")

        def load(name: str) -> bytes:
            entry = members.get(name)
            if entry is None or entry.is_dir():
                raise ValueError(f"EPUB 缺少所需文件：{name}")
            try:
                with archive.open(entry) as stream:
                    data = stream.read(_MAX_MEMBER_BYTES + 1)
            except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError, EOFError, ValueError, zlib.error) as exc:
                raise ValueError(f"EPUB 文件损坏或压缩方式不受支持：{name}") from exc
            if len(data) > _MAX_MEMBER_BYTES or len(data) != entry.file_size:
                raise ValueError("EPUB 文件解压大小无效或超过限制。")
            return data

        container = _xml(load("META-INF/container.xml"), "目录文件")
        if _local_name(container.tag) != "container":
            raise ValueError("EPUB 的目录文件格式无效。")
        rootfiles = [node for node in container.iter() if _local_name(node.tag) == "rootfile"]
        if not rootfiles:
            raise ValueError("EPUB 未指定 OPF 书籍目录。")
        rootfile = next((node for node in rootfiles if node.get("media-type") == "application/oebps-package+xml"), rootfiles[0])
        package_path = _resolve("", rootfile.get("full-path", ""))
        package = _xml(load(package_path), "OPF 文件")
        if _local_name(package.tag) != "package":
            raise ValueError("EPUB 的 OPF 文件格式无效。")
        metadata = next((node for node in package if _local_name(node.tag) == "metadata"), None)
        title = default_title
        if metadata is not None:
            for node in metadata:
                if _local_name(node.tag) == "title":
                    value = _title("".join(node.itertext()))
                    if value:
                        title = value
                        break
        manifest = next((node for node in package if _local_name(node.tag) == "manifest"), None)
        spine = next((node for node in package if _local_name(node.tag) == "spine"), None)
        if manifest is None or spine is None:
            raise ValueError("EPUB 缺少正文清单或阅读顺序。")
        items: dict[str, tuple[str, str, set[str]]] = {}
        for node in manifest:
            if _local_name(node.tag) != "item":
                continue
            item_id = node.get("id", "")
            if not item_id or item_id in items:
                raise ValueError("EPUB 的正文清单标识无效或重复。")
            items[item_id] = (
                _resolve(package_path, node.get("href", "")),
                node.get("media-type", "").lower(),
                set(node.get("properties", "").lower().split()),
            )
        chapters = []
        character_count = 0
        for node in spine:
            if _local_name(node.tag) != "itemref":
                continue
            item = items.get(node.get("idref", ""))
            if item is None:
                raise ValueError("EPUB 的阅读顺序引用了不存在的正文。")
            path, media_type, properties = item
            if "nav" in properties or media_type.startswith("image/"):
                continue
            if media_type not in {"application/xhtml+xml", "text/html"}:
                raise ValueError(f"EPUB 的正文格式不受支持：{media_type or '未声明格式'}")
            parser = _ChapterHTML()
            try:
                parser.feed(_decode_html(load(path)))
                parser.close()
            except (ValueError, AssertionError, RecursionError) as exc:
                raise ValueError(f"EPUB 正文格式无效：{path}") from exc
            if not parser.has_document:
                raise ValueError(f"EPUB 正文缺少 HTML 文档结构：{path}")
            chapter_title, text = parser.result()
            if not text:
                continue
            character_count += len(text)
            if character_count > MAX_TEXT_CHARACTERS:
                raise ValueError("小说正文超过 64 Mi 字元安全上限，请拆分后导入。")
            chapters.extend(_bounded_chapters(chapter_title or f"第 {len(chapters) + 1} 章", text))
        return title, chapters


def import_novel(filename: str, content: bytes) -> tuple[str, list[tuple[str, str]]]:
    """Return a default book title and ordered, at-most-12000-character chapters."""
    if not isinstance(filename, str) or not isinstance(content, bytes):
        raise ValueError("文件名或文件内容无效。")
    if len(content) > MAX_UPLOAD_BYTES:
        raise ValueError("上传文件超过 32 MiB，请拆分后导入。")
    if not content:
        raise ValueError("上传文件为空。")
    basename = filename.replace("\\", "/").rsplit("/", 1)[-1]
    stem, extension = posixpath.splitext(basename)
    title = _title(stem) or "未命名小说"
    if extension.lower() == ".txt":
        text = _decode_txt(content)
        if len(text) > MAX_TEXT_CHARACTERS:
            raise ValueError("小说正文超过 64 Mi 字元安全上限，请拆分后导入。")
        chapters = _text_chapters(text)
    elif extension.lower() == ".epub":
        title, chapters = _epub(content, title)
    else:
        raise ValueError("仅支持 .txt 和 .epub 格式的小说。")
    if not chapters or not any(text.strip() for _, text in chapters):
        raise ValueError("小说中没有可阅读的正文。")
    return title, chapters
