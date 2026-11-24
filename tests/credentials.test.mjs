import test from 'node:test';
import assert from 'node:assert/strict';
import {apiOrigin, resolveApiKey, sameApiOrigin} from '../src/credentials.js';

test('origin ignores path, trailing slash and host case', () => {
  assert.equal(apiOrigin('https://API.DeepSeek.com/v1/'), 'https://api.deepseek.com');
  assert.equal(sameApiOrigin('https://api.deepseek.com', 'https://api.deepseek.com/v1'), true);
});

test('a different scheme, host or port is a different origin', () => {
  assert.equal(sameApiOrigin('https://api.deepseek.com', 'http://api.deepseek.com'), false);
  assert.equal(sameApiOrigin('https://api.deepseek.com', 'https://api.siliconflow.cn/v1'), false);
  assert.equal(sameApiOrigin('http://127.0.0.1:8000/v1', 'http://127.0.0.1:8001/v1'), false);
});

test('malformed URLs never share an origin', () => {
  assert.equal(apiOrigin('not a url'), '');
  assert.equal(sameApiOrigin('not a url', 'also not a url'), false);
});

test('a stored key is reused only for the same origin', () => {
  assert.equal(resolveApiKey({
    storedKey: 'sk-deepseek',
    storedUrl: 'https://api.deepseek.com',
    nextUrl: 'https://api.deepseek.com/v1',
  }), 'sk-deepseek');
  assert.equal(resolveApiKey({
    storedKey: 'sk-deepseek',
    storedUrl: 'https://api.deepseek.com',
    nextUrl: 'https://api.siliconflow.cn/v1',
  }), '');
});

test('a typed key always wins and is trimmed', () => {
  assert.equal(resolveApiKey({
    storedKey: 'sk-old',
    typedKey: '  sk-new  ',
    storedUrl: 'https://api.deepseek.com',
    nextUrl: 'https://api.siliconflow.cn/v1',
  }), 'sk-new');
});

test('missing or blank keys stay blank', () => {
  assert.equal(resolveApiKey({storedUrl: 'https://api.deepseek.com', nextUrl: 'https://api.deepseek.com'}), '');
  assert.equal(resolveApiKey({storedKey: '   ', storedUrl: 'https://a.example', nextUrl: 'https://a.example'}), '');
});
