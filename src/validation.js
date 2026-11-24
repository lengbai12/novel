// Creation-time bounds. Keep the checks here so the browser form, the engine and
// future callers share one rule and fail before any model request is started.

export function validateBranchInput({forkChapter, chapterCount, chapterWords}) {
  if (!Number.isInteger(chapterCount) || chapterCount < 1) {
    throw new Error('小说还没有可用的章节，不能创建支线。');
  }
  if (!Number.isInteger(forkChapter) || forkChapter < 1 || forkChapter > chapterCount) {
    throw new Error(`分叉章节必须在第 1 章到第 ${chapterCount} 章之间。`);
  }
  if (!Number.isInteger(chapterWords) || chapterWords < 1) {
    throw new Error('每章字数必须是正整数。');
  }
}
