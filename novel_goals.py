"""Extract explicit chapter clauses without rewriting or rescoping a premise.

The original premise remains authoritative. A clause runs from its heading to
its next heading (or EOF), so trailing shared constraints stay in that clause.
In particular, ``other`` means other numbered text, not text that is not due.
"""
import re


_HEADING = re.compile(
    r"(?<!\w)Chapter\s+(?P<english>[0-9]+)\s*(?:goals?\s*)?[:：]"
    r"|第(?P<chinese>[零〇一二两三四五六七八九十百千0-9]+)章\s*(?:目标\s*)?[:：]",
    re.IGNORECASE,
)
_DIGITS = {char: value for value, char in enumerate("零一二三四五六七八九")}
_DIGITS.update({"〇": 0, "两": 2})
_UNITS = {"十": 10, "百": 100, "千": 1000}


def _chapter_number(text):
    if text.isascii() and text.isdigit():
        return int(text)
    total = digit = 0
    if not any(char in _UNITS for char in text):
        return int("".join(str(_DIGITS[char]) for char in text))
    for char in text:
        if char in _UNITS:
            total += (digit or 1) * _UNITS[char]
            digit = 0
        else:
            digit = _DIGITS[char]
    return total + digit


def chapter_goals(premise, number):
    """Return exact explicit chapter spans, with no model or semantic inference.

    ``common`` is the text before the first heading, or the entire premise if
    there are no headings. ``current`` concatenates clauses bearing ``number``;
    ``other`` contains the other clauses as ``{number, text}`` records.
    ``segments`` contains all such records in original order, so
    ``common + ''.join(s['text'] for s in segments)`` is exactly the premise.
    No stripping, paraphrasing, or inferred division of trailing rules occurs.
    Callers must retain the full premise, rather than replace it with current.
    """
    headings = list(_HEADING.finditer(premise))
    segments = []
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(premise)
        segments.append({
            "number": _chapter_number(heading.group("english") or heading.group("chinese")),
            "text": premise[heading.start():end],
        })
    return {
        "common": premise[:headings[0].start()] if headings else premise,
        "current": "".join(segment["text"] for segment in segments if segment["number"] == number),
        "other": [segment for segment in segments if segment["number"] != number],
        "segments": segments,
    }
