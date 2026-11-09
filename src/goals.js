// Explicit chapter clauses inside a premise. Text is copied verbatim, never paraphrased.
// A clause runs from its heading to the next heading (or the end of the premise), so
// trailing shared rules stay attached to the clause that precedes them.

const HEADING = /(?<![\p{L}\p{N}_])Chapter\s+(?<english>[0-9]+)\s*(?:goals?\s*)?[:：]|第(?<chinese>[零〇一二两三四五六七八九十百千0-9]+)章\s*(?:目标\s*)?[:：]/giu;
const DIGITS = new Map([...'零一二三四五六七八九'].map((char, value) => [char, value]));
DIGITS.set('〇', 0).set('两', 2);
const UNITS = new Map([['十', 10], ['百', 100], ['千', 1000]]);

function digitValue(char) {
  const value = DIGITS.get(char);
  if (value === undefined) throw new Error(`无法识别的章节数字：${char}`);
  return value;
}

function chapterNumber(text) {
  if (/^[0-9]+$/.test(text)) return Number(text);
  if (![...text].some(char => UNITS.has(char))) {
    return Number([...text].map(digitValue).join(''));
  }
  let total = 0;
  let digit = 0;
  for (const char of text) {
    if (UNITS.has(char)) {
      total += (digit || 1) * UNITS.get(char);
      digit = 0;
    } else {
      digit = digitValue(char);
    }
  }
  return total + digit;
}

// Returns the concatenation of every clause whose heading names chapter `number`,
// or '' when the premise has none. Callers fall back to the whole premise.
export function chapterGoal(premise, number) {
  const headings = [...premise.matchAll(HEADING)];
  let goal = '';
  headings.forEach((heading, index) => {
    const end = index + 1 < headings.length ? headings[index + 1].index : premise.length;
    if (chapterNumber(heading.groups.english ?? heading.groups.chinese) === number) {
      goal += premise.slice(heading.index, end);
    }
  });
  return goal;
}
