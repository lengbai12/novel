import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBranchInput} from '../src/validation.js';

test('accepts a chapter inside the book and a positive word count', () => {
  assert.doesNotThrow(() => validateBranchInput({forkChapter: 1, chapterCount: 12, chapterWords: 1200}));
  assert.doesNotThrow(() => validateBranchInput({forkChapter: 12, chapterCount: 12, chapterWords: 1}));
});

test('rejects chapter 0, negative chapters and chapters past the end', () => {
  for (const forkChapter of [0, -1, 13]) {
    assert.throws(
      () => validateBranchInput({forkChapter, chapterCount: 12, chapterWords: 1200}),
      /第 1 章到第 12 章/,
    );
  }
});

test('rejects a book without chapters', () => {
  assert.throws(
    () => validateBranchInput({forkChapter: 1, chapterCount: 0, chapterWords: 1200}),
    /没有可用的章节/,
  );
});

test('rejects a zero, negative or fractional word count', () => {
  for (const chapterWords of [0, -100, 12.5]) {
    assert.throws(
      () => validateBranchInput({forkChapter: 1, chapterCount: 12, chapterWords}),
      /正整数/,
    );
  }
});
