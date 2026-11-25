// 由 browser-integration.mjs 在隔离浏览器中执行；这里使用真实 store/engine/model。
async function scenarios() {
  const results = [];
  const ok = (condition, message) => { if (!condition) throw Error(message); };
  const engine = await import('/src/engine.js');
  const baseline = await import('/baseline/src/engine.js');
  const store = await import('/src/store.js');
  const model = {provider:'openai', api_url:'https://synthetic.invalid/v1', model:'mock', reasoning_effort:'none'};
  const source = '第一章 雨后\n\n旅人把蓝色雨伞交给守门人，推开院门，走进院子。';
  const prose = '合成修订正文\n\n' + '旅人走到石阶旁，向守门人询问屋主何时归来。守门人指着门边的时钟，让他在廊下等待。'.repeat(7);
  const branch = {id:'existing', book_id:'synthetic', title:'已有路线', fork_chapter:1,
    premise:'旅人与守门人交谈', style:'简洁叙述', chapter_words:400, outline:'交谈', created_at:'2026-01-01'};
  async function reset() {
    sessionStorage.clear();
    const data = Object.fromEntries(Object.keys(store.STORES).map(name => [name, []]));
    data.books = [{id:'synthetic', title:'合成验证小说', filename:'synthetic.txt', digest:'synthetic', created_at:'2026-01-01'}];
    data.chapters = [{book_id:'synthetic', number:1, title:'第一章 雨后', text:source}];
    data.memories = [{book_id:'synthetic', start:1, end:1, level:0, text:'旅人进入院子。'}];
    data.branches = [branch];
    await store.importData(JSON.stringify(data));
  }
  const options = {title:'新路线', fork_chapter:1, premise:'旅人与守门人交谈', style:'简洁', chapter_words:400, model};
  let mode = 'success', calls = [], blocked;
  const nativeFetch = window.fetch;
  const sse = (text, finish = 'stop', done = true) => new Response(
    `data: ${JSON.stringify({choices:[{delta:{content:text}, finish_reason:finish}]})}\n\n` + (done ? 'data: [DONE]\n\n' : ''));
  window.fetch = async (url, options) => {
    if (!String(url).startsWith('https://synthetic.invalid/')) return nativeFetch(url, options);
    const body = JSON.parse(options.body);
    const schema = body.response_format?.json_schema?.schema;
    const system = body.messages[0]?.content || '';
    const kind = schema?.properties?.steps || /"steps"/.test(system) ? 'outline'
      : schema?.properties?.summary || /"summary"/.test(system) ? 'summary' : 'prose';
    calls.push({kind, body});
    if (kind === 'outline') return sse(JSON.stringify({steps:['走向石阶', '询问屋主', '等待回应', '廊下等待']}));
    if (kind === 'summary') {
      if (mode === 'archive-failure') return new Response('synthetic summary error', {status:503});
      return sse(JSON.stringify({summary:'旅人与守门人交谈后在廊下等待。'}));
    }
    if (mode === 'hold') return new Response(new ReadableStream({start(controller) {
      blocked = controller;
      options.signal.addEventListener('abort', () => controller.error(options.signal.reason), {once:true});
    }}));
    if (mode === 'length') return sse('合成半成品', 'length');
    if (mode === 'eof') return sse('合成半成品', null, false);
    if (mode === 'http-failure') return new Response('synthetic prose error', {status:500});
    return sse(prose);
  };
  async function until(fn, label) {
    const end = performance.now() + 15000;
    for (;;) {
      const result = await fn();
      if (result) return result;
      if (performance.now() > end) throw Error(`超时：${label}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  const terminal = (api, id) => until(() => {
    const job = api.getJob(id);
    return ['done','error','cancelled'].includes(job.status) && !api.status().busy ? job : null;
  }, '任务结束');
  const snapshot = async () => JSON.parse(await store.exportData());
  try {
    await reset(); mode='hold'; calls=[]; blocked=null;
    const old = await baseline.startBranch('synthetic', options);
    await until(() => blocked, '旧版首章写作');
    const oldId = baseline.getJob(old.job_id).result.branch_id;
    await baseline.renameBranch(oldId, {title:'旧版生成中仍能改名'});
    ok((await baseline.getBranch(oldId)).title === '旧版生成中仍能改名', '未复现旧锁遗漏');
    baseline.cancelJob(old.job_id); await terminal(baseline, old.job_id);
    results.push('旧版复现：首章生成期间确实能够改名');

    await reset(); mode='success'; calls=[];
    const zero = await baseline.startBranch('synthetic', {...options, fork_chapter:0});
    const zeroJob = await terminal(baseline, zero.job_id);
    ok(zeroJob.status==='error' && calls.length>0, '未复现第 0 章先调用模型后失败');
    results.push('旧版复现：第 0 章接受提交并调用模型，最终失败');

    await reset(); calls=[];
    for (const patch of [{fork_chapter:0}, {fork_chapter:2}, {chapter_words:0}, {chapter_words:1.5}]) {
      let rejected=false;
      try { await engine.startBranch('synthetic', {...options, ...patch}); } catch { rejected=true; }
      ok(rejected, `非法输入被接受：${JSON.stringify(patch)}`);
    }
    ok(calls.length===0 && !engine.status().busy, '非法输入触发模型调用');
    results.push('新版非法章号/字数在模型调用前拒绝');

    await reset(); mode='hold'; calls=[]; blocked=null;
    const active = await engine.startBranch('synthetic', options);
    await until(() => blocked, '新版首章写作');
    const id = engine.getJob(active.job_id).result.branch_id;
    for (const action of [() => engine.renameBranch(id, {title:'不应成功'}),
      () => engine.deleteBranch(id), () => engine.truncateBranch(id)]) {
      let rejected=false;
      try { await action(); } catch { rejected=true; }
      ok(rejected, '生成中管理操作未被拒绝');
    }
    engine.cancelJob(active.job_id);
    const cancelled = await terminal(engine, active.job_id);
    ok(cancelled.status==='cancelled', '取消未标记 cancelled');
    ok((await engine.getBranch(id)).chapters.length===0, '取消后写入章节');
    await engine.renameBranch(id, {title:'结束后可以改名'});
    results.push('新版首章生成中管理操作拒绝；取消状态正确、无章节写入、结束后解锁');

    for (const failure of ['length','eof','http-failure']) {
      await reset(); mode=failure; calls=[];
      const before = await snapshot();
      const task = await engine.startContinue('existing', {model});
      const job = await terminal(engine, task.job_id);
      const after = await snapshot();
      ok(job.status==='error' && !job.published && !job.draft, `${failure} 状态或草稿错误`);
      ok(JSON.stringify(before.branch_chapters)===JSON.stringify(after.branch_chapters)
        && JSON.stringify(before.branch_memories)===JSON.stringify(after.branch_memories), `${failure} 发布半成品`);
      results.push(`${failure}：真实引擎标记 error，IndexedDB 无半成品/记忆写入`);
    }

    await reset(); mode='success'; calls=[];
    const success = await engine.startBranch('synthetic', options);
    const successJob = await terminal(engine, success.job_id);
    ok(successJob.status==='done' && successJob.published===true, '正常生成未完成');
    const publishedId=successJob.result.branch_id;
    ok((await engine.getBranch(publishedId)).chapters[0].text===prose, '正常正文未保存');
    ok((await snapshot()).branch_memories.length===1, '正文/记忆未共同保存');
    const preserved = (await engine.getBranch(publishedId)).chapters[0].text;
    mode='length';
    const continuation = await engine.startContinue(publishedId, {model});
    ok((await terminal(engine, continuation.job_id)).status==='error', '续写截断未报错');
    ok((await engine.getBranch(publishedId)).chapters.length===1
      && (await engine.getBranch(publishedId)).chapters[0].text===preserved, '失败续写破坏已保存章节');
    results.push('正常首章正文/记忆成功发布；随后失败续写保留已有章节');

    await reset(); mode='archive-failure'; calls=[];
    const archive = await engine.startContinue('existing', {model});
    const archiveJob = await terminal(engine, archive.job_id);
    ok(archiveJob.status==='error' && archiveJob.draft===prose && !archiveJob.published, '归档失败未保留完整草稿');
    ok((await engine.getBranch('existing')).chapters.length===0, '归档失败仍写入正文');
    // 与刷新相同的恢复路径：从内存移除任务，重新加载原快照，再通过公开 API 修订。
    const recovery = sessionStorage.getItem('qilu.job-recovery');
    engine.dismissJob(archive.job_id);
    sessionStorage.setItem('qilu.job-recovery', recovery);
    ok(engine.getJob(archive.job_id).recovered===true, '未走快照恢复路径');
    mode='success';
    const revision=await engine.startRevise(archive.job_id, {feedback:'请保留雨伞归属，完善对话。', model});
    const revised=await terminal(engine, revision.job_id);
    ok(revised.status==='done' && revised.published, '恢复草稿修订发布失败');
    ok((await engine.getBranch('existing')).chapters.length===1, '修订未发布或重复发布');
    results.push('归档失败保留完整草稿且不发布；经快照恢复、反馈修订后成功发布一次');

    await reset(); mode='archive-failure'; calls=[];
    const final = await engine.startContinue('existing', {model});
    await terminal(engine, final.job_id);
    localStorage.setItem('qilu.book', 'synthetic');
    return results;
  } finally { window.fetch=nativeFetch; }
}
