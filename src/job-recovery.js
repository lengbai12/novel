// sessionStorage 按标签页隔离，刷新后保留，关闭标签页后清除。
// 只保存恢复所需字段，不保存 Key、API URL、请求对象或思考内容。
const KEY = 'qilu.job-recovery';
const FIELDS = ['id', 'status', 'stage', 'progress', 'total', 'book_id', 'branch_id',
  'draft', 'draft_chapter', 'published', 'error'];
const STATUSES = ['queued', 'running', 'done', 'error', 'cancelled'];

export function saveJob(job, storage) {
  try {
    storage ??= globalThis.sessionStorage;
    const snapshot = Object.fromEntries(FIELDS.filter(key => job[key] !== undefined).map(key => [key, job[key]]));
    snapshot.result = {book_id: job.result?.book_id, branch_id: job.result?.branch_id};
    storage.setItem(KEY, JSON.stringify(snapshot));
    return '';
  } catch {
    return '草稿恢复记录保存失败（存储不可用或空间不足），刷新前请复制正文。';
  }
}

export function loadJob(storage) {
  try {
    storage ??= globalThis.sessionStorage;
    const saved = JSON.parse(storage.getItem(KEY) || 'null');
    if (!saved || typeof saved.id !== 'string' || !saved.id || !STATUSES.includes(saved.status)) return null;
    const job = Object.fromEntries(FIELDS.filter(key => saved[key] !== undefined).map(key => [key, saved[key]]));
    if (job.draft !== undefined && typeof job.draft !== 'string') return null;
    job.result = {book_id: saved.result?.book_id, branch_id: saved.result?.branch_id};
    if (['queued', 'running'].includes(job.status)) {
      job.status = 'error';
      job.stage = '页面刷新后任务已中断';
      job.error = job.published
        ? '任务已中断；正文此前已保存，请查看支线，不要重复生成。'
        : '页面刷新后原任务无法继续；已找回最后完整草稿（如有），不会自动调用模型。';
    }
    job.preview = job.draft || '';
    job.recovered = true;
    return job;
  } catch {
    return null;
  }
}

export function clearJob(storage) {
  try { (storage ?? globalThis.sessionStorage).removeItem(KEY); } catch { /* 不阻止关闭面板。 */ }
}
