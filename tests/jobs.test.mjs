import test from 'node:test';
import assert from 'node:assert/strict';
import {jobOwnsBranch} from '../src/jobs.js';

test('普通续写按 branch_id 锁定支线', () => {
  assert.equal(jobOwnsBranch({branch_id: 'a', result: {}}, 'a'), true);
  assert.equal(jobOwnsBranch({branch_id: 'a', result: {}}, 'b'), false);
});

test('首章任务尚未绑定 branch_id 时按 result 锁定支线', () => {
  assert.equal(jobOwnsBranch({branch_id: null, result: {book_id: 'book', branch_id: 'a'}}, 'a'), true);
  assert.equal(jobOwnsBranch({branch_id: null, result: {branch_id: 'a'}}, 'b'), false);
});

test('未创建支线的任务不误锁其他支线', () => {
  assert.equal(jobOwnsBranch({branch_id: null, result: {}}, 'a'), false);
  assert.equal(jobOwnsBranch({branch_id: null}, 'a'), false);
});

test('缺失或空的目标 ID 不算支线匹配', () => {
  for (const branchId of [undefined, null, '']) {
    assert.equal(jobOwnsBranch({branch_id: branchId, result: {branch_id: branchId}}, branchId), false);
  }
});
