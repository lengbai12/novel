import test from 'node:test';
import assert from 'node:assert/strict';
import {checkModel, normalizeConfig} from '../src/model.js';

function mockFetch(t, calls) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({url, options});
    return new Response(JSON.stringify({data: [{id: 'test-model'}]}), {
      status: 200,
      headers: {'Content-Type': 'application/json'},
    });
  };
}

test('checkModel sends Authorization only when a key exists', async t => {
  const calls = [];
  mockFetch(t, calls);
  const base = {
    provider: 'openai',
    api_url: 'https://api.example.test/v1/',
    model: 'test-model',
    reasoning_effort: 'none',
  };

  const withKey = await checkModel({...base, api_key: 'sk-test'});
  assert.equal(withKey.ready, true);
  assert.equal(calls[0].url, 'https://api.example.test/v1/models');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test');

  const withoutKey = await checkModel({...base, api_key: '   '});
  assert.equal(withoutKey.ready, true);
  assert.equal(Object.hasOwn(calls[1].options.headers, 'Authorization'), false);
});

test('normalizeConfig trims the key and strips trailing slashes', () => {
  const config = normalizeConfig({
    provider: 'openai',
    api_url: 'https://api.example.test/v1///',
    model: '  test-model  ',
    reasoning_effort: 'none',
    api_key: '  sk-test  ',
  });
  assert.equal(config.api_url, 'https://api.example.test/v1');
  assert.equal(config.model, 'test-model');
  assert.equal(config.api_key, 'sk-test');
});

test('normalizeConfig rejects an unknown reasoning effort', () => {
  assert.throws(() => normalizeConfig({
    provider: 'openai',
    api_url: 'https://api.example.test/v1',
    model: 'test-model',
    reasoning_effort: 'max',
  }), /思考强度/);
});
