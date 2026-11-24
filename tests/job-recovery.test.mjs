import test from 'node:test';
import assert from 'node:assert/strict';
import {saveJob, loadJob, clearJob} from '../src/job-recovery.js';
import {recoverJobId, getJob, dismissJob, startRevise} from '../src/engine.js';

function storage() {
  const data = new Map();
  return {setItem: (key, value) => data.set(key, value), getItem: key => data.get(key) ?? null,
    removeItem: key => data.delete(key), data};
}

test('刷新恢复完整草稿并将运行任务标为中断', () => {
  const s = storage();
  assert.equal(saveJob({id: 'j', status: 'running', draft: '完整正文', draft_chapter: 1,
    result: {book_id: 'book', branch_id: 'branch'}}, s), '');
  const job = loadJob(s);
  assert.equal(job.status, 'error');
  assert.equal(job.draft, '完整正文');
  assert.equal(job.preview, '完整正文');
  assert.equal(job.result.branch_id, 'branch');
  assert.equal(job.recovered, true);
  assert.match(job.error, /不会自动调用模型/);
});

test('错误和取消状态及原因保留', () => {
  for (const status of ['error', 'cancelled']) {
    const s = storage();
    saveJob({id: 'j', status, error: '原始原因', draft: '草稿'}, s);
    assert.equal(loadJob(s).status, status);
    assert.equal(loadJob(s).error, '原始原因');
  }
});

test('不保存密钥、接口地址、请求控制器、预览或模型配置', () => {
  const s = storage();
  saveJob({id: 'j', status: 'running', api_key: 'SECRET', api_url: 'PRIVATE_URL',
    model: {api_key: 'SECRET'}, preview: 'PARTIAL', controller: {},
    result: {branch_id: 'b', api_key: 'SECRET'}}, s);
  const raw = [...s.data.values()][0];
  assert.equal(/SECRET|PRIVATE_URL|PARTIAL|controller/.test(raw), false);
});

test('归档中断但正文已保存时保留 published 标志', () => {
  const s = storage();
  saveJob({id: 'j', status: 'running', published: true, draft: '正文'}, s);
  assert.equal(loadJob(s).published, true);
  assert.match(loadJob(s).error, /不要重复生成/);
});

test('关闭面板清除记录；损坏记录安全忽略', () => {
  const s = storage();
  saveJob({id: 'j', status: 'done'}, s);
  clearJob(s);
  assert.equal(loadJob(s), null);
  s.setItem('qilu.job-recovery', '{');
  assert.equal(loadJob(s), null);
});

test('空间不足不抛异常，并给出复制草稿提示', () => {
  const s = {setItem() { throw new Error('QuotaExceededError'); }};
  assert.match(saveJob({id: 'j', status: 'running'}, s), /刷新前请复制正文/);
});

test('浏览器禁止读取 sessionStorage 时安全降级', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, get() { throw new Error('SecurityError'); }});
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete globalThis.sessionStorage;
  });
  assert.match(saveJob({id: 'j', status: 'running'}), /保存失败/);
  assert.equal(loadJob(), null);
  assert.doesNotThrow(() => clearJob());
});

test('恢复的已保存正文不能再次作为未保存草稿修订', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const s = storage();
  Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: s});
  t.after(() => {
    dismissJob('published-recovery-test');
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete globalThis.sessionStorage;
  });
  saveJob({id: 'published-recovery-test', status: 'running', published: true, draft: '已保存正文'}, s);
  await assert.rejects(startRevise('published-recovery-test', {feedback: '修改', model: {
    provider: 'openai', api_url: 'https://example.test/v1', model: 'test', reasoning_effort: 'none',
  }}), /正文已经保存/);
});

test('引擎可找回刷新前的任务，关闭后不再恢复', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const s = storage();
  Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: s});
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete globalThis.sessionStorage;
  });
  saveJob({id: 'recovery-test', status: 'running', draft: '可修订草稿', draft_chapter: 1,
    result: {branch_id: 'branch'}}, s);
  assert.equal(recoverJobId(), 'recovery-test');
  assert.equal(getJob('recovery-test').draft, '可修订草稿');
  assert.equal(getJob('recovery-test').status, 'error');
  dismissJob('recovery-test');
  assert.equal(recoverJobId(), null);
  assert.throws(() => getJob('recovery-test'), /任务不存在/);
});
