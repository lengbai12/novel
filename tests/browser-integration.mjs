// 独立无头 Chrome + 真实 IndexedDB；仅生成合成数据，不访问外部模型。
// 运行：node tests/browser-integration.mjs（需本机 Chrome）。不自动加入 npm test。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdtemp} from 'node:fs/promises';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join, resolve} from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'opencode', 'novel-integration-'));
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    let body;
    if (pathname.startsWith('/baseline/src/')) {
      body = execFileSync('git', ['show', `50e38a1:${pathname.slice('/baseline/'.length)}`], {cwd: root});
    } else {
      const relative = pathname === '/' ? 'static/index.html'
        : ['app.js', 'app.css'].includes(pathname.slice(1)) ? `static${pathname}` : pathname.slice(1);
      const path = resolve(root, relative);
      if (!path.startsWith(root)) throw new Error('invalid path');
      body = await readFile(path);
    }
    response.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript'
      : pathname.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
{stdio: ['ignore', 'ignore', 'pipe']});
let ws;
try {
  const browserUrl = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Chrome 启动超时')), 15000);
    chrome.once('error', reject);
    chrome.stderr.on('data', chunk => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  ws = new WebSocket(browserUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, {once: true}));
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', ({data}) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
    }
    for (const listener of listeners) listener(message);
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, {resolve, reject});
    ws.send(JSON.stringify({id, method, params, sessionId}));
  });
  const {targetId} = await call('Target.createTarget', {url: 'about:blank'});
  const {sessionId} = await call('Target.attachToTarget', {targetId, flatten: true});
  const page = (method, params) => call(method, params, sessionId);
  const exceptions = [];
  listeners.add(message => {
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
  });
  await page('Runtime.enable'); await page('Page.enable');
  const navigate = async (method, params) => {
    const loaded = new Promise(resolve => {
      const listener = message => {
        if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') {
          listeners.delete(listener); resolve();
        }
      };
      listeners.add(listener);
    });
    await page(method, params); await loaded;
  };
  const evaluate = async expression => {
    const result = await page('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await navigate('Page.navigate', {url: `${origin}/`});
  const fixture = await readFile(join(root, 'tests/fixtures/browser-scenarios.js'), 'utf8');
  const results = await evaluate(`(async () => {${fixture}\nreturn await scenarios();})()`);
  for (const result of results) console.log(`PASS ${result}`);
  // 场景将真实引擎生成后、归档失败的草稿留在 sessionStorage，再刷新 UI。
  await navigate('Page.reload');
  await evaluate(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observer.disconnect(); reject(Error('恢复面板超时')); }, 10000);
    const observer = new MutationObserver(check);
    function check() { if (document.querySelector('.job-output')?.textContent.includes('合成修订正文')) {
      clearTimeout(timer); observer.disconnect(); resolve();
    }}
    observer.observe(document, {subtree:true, childList:true}); check();
  })`);
  const restored = await evaluate(`({text:document.querySelector('[aria-label="后台任务"]').textContent,
    snapshot:JSON.parse(sessionStorage.getItem('qilu.job-recovery'))})`);
  assert.match(restored.text, /已恢复本标签页最近任务/);
  assert.match(restored.text, /合成修订正文/);
  assert.equal(restored.snapshot.published, undefined);
  const revision = await evaluate(`(async () => {
    const engine = await import('/src/engine.js');
    const store = await import('/src/store.js');
    const before = JSON.parse(await store.exportData());
    if (before.branch_chapters.length !== 0) throw Error('刷新前失败任务意外发布');
    const calls=[];
    const original=window.fetch;
    window.fetch=async (url, options) => {
      if (!String(url).startsWith('https://synthetic.invalid/')) throw Error('意外联网请求');
      const payload=JSON.parse(options.body);
      const summary=payload.messages[0].content.includes('"summary"');
      calls.push(summary ? 'summary' : 'prose');
      const text=summary ? JSON.stringify({summary:'旅人仍在廊下等待，雨伞由守门人保管。'})
        : '刷新后修订正文\\n\\n'+'旅人在廊下等待，守门人仍握着蓝色雨伞，两人继续交谈。'.repeat(12);
      return new Response('data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}]})+'\\n\\ndata: [DONE]\\n\\n');
    };
    try {
      const id=engine.recoverJobId();
      const model={provider:'openai',api_url:'https://synthetic.invalid/v1',model:'mock',reasoning_effort:'none'};
      const task=await engine.startRevise(id,{feedback:'保持蓝色雨伞归属，补充对话。',model});
      const job=await new Promise((resolve,reject)=>{
        const end=Date.now()+10000;
        const check=()=>{const j=engine.getJob(task.job_id);if(['error','done','cancelled'].includes(j.status))resolve(j);
          else if(Date.now()>end)reject(Error('刷新后修订超时'));else setTimeout(check,10)};check();
      });
      const data=JSON.parse(await store.exportData());
      return {status:job.status,published:job.published,chapters:data.branch_chapters.length,
        memories:data.branch_memories.length,text:data.branch_chapters[0]?.text,calls};
    } finally {window.fetch=original;}
  })()`);
  assert.equal(revision.status, 'done');
  assert.equal(revision.published, true);
  assert.equal(revision.chapters, 1);
  assert.equal(revision.memories, 1);
  assert.match(revision.text, /^刷新后修订正文/);
  assert.deepEqual(revision.calls, ['prose', 'summary']);
  console.log('PASS 真正刷新页面后经公开修订 API 完成正文/记忆发布一次');
  // 关闭旧面板也会清除最新任务快照；此时所有任务均已结束。
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent==='关闭').click()`);
  await evaluate(`new Promise(resolve => setTimeout(resolve, 50))`);
  assert.equal(await evaluate(`sessionStorage.getItem('qilu.job-recovery')`), null);
  // 通过实际 React 设置表单验证换地址留空 Key 时不会发送请求。
  await page('Page.addScriptToEvaluateOnNewDocument', {source: `
    window.__modelRequests=[];
    window.fetch=async (url,options={})=>{
      window.__modelRequests.push({url:String(url),authorization:options.headers?.Authorization});
      return new Response(JSON.stringify({data:[{id:'mock'}]}),{headers:{'Content-Type':'application/json'}});
    };
    localStorage.setItem('qilu.model',JSON.stringify({provider:'openai',api_url:'https://old.synthetic.invalid/v1',
      model:'mock',reasoning_effort:'none',api_key:'synthetic-not-a-real-key'}));
  `});
  await navigate('Page.reload');
  const credentialResult = await evaluate(`(async()=>{
    async function waitFor(fn){const end=Date.now()+5000;while(!fn()){
      if(Date.now()>end)throw Error('设置表单等待超时');await new Promise(r=>setTimeout(r,10));}}
    await waitFor(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='我的模型'));
    Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='我的模型').click();
    await waitFor(()=>document.querySelector('input[aria-label="API URL"]'));
    const input=document.querySelector('input[aria-label="API URL"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'https://new.synthetic.invalid/v1');
    input.dispatchEvent(new Event('input',{bubbles:true}));
    const before=window.__modelRequests.length;
    Array.from(document.querySelectorAll('.ant-modal button')).find(b=>b.textContent==='保存并测试').click();
    await waitFor(()=>document.body.textContent.includes('API 地址已更改'));
    return {requests:window.__modelRequests.slice(before),
      saved:JSON.parse(localStorage.getItem('qilu.model')).api_url,
      keyInput:document.querySelector('input[aria-label="API 密钥"]').value};
  })()`);
  assert.deepEqual(credentialResult.requests, []);
  assert.equal(credentialResult.saved, 'https://old.synthetic.invalid/v1');
  assert.equal(credentialResult.keyInput, '');
  console.log('PASS 实际设置表单换源留空 Key 显示阻止提示，未发送请求、未覆盖原配置');
  assert.deepEqual(exceptions, []);
  console.log('PASS 真实失败任务草稿经页面刷新恢复、关闭清除，无 JS 异常');
} finally {
  ws?.close(); chrome.kill(); server.close();
  console.log(`隔离浏览器数据：${profile}`);
}
