import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Alert, AutoComplete, Button, Checkbox, Collapse, ConfigProvider, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Progress, Select, Space, Tabs, Tag, Tree, Upload} from 'antd';
import 'antd/dist/reset.css';
import './style.css';

const PROVIDERS = {
  auto: {label: '自动识别（按 URL）'},
  llama: {label: '本地 llama.cpp / Qwen', api_url: 'http://127.0.0.1:8000/v1', model: 'qwen3.5-9b'},
  deepseek: {label: 'DeepSeek 官方 API', api_url: 'https://api.deepseek.com', model: 'deepseek-flash'},
  siliconflow: {label: 'SiliconFlow', api_url: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3.5-9B'},
  openai: {label: '自定义 OpenAI 兼容'}
};
const MODEL_SUGGESTIONS = {
  deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
  llama: ['qwen3.5-9b'],
  siliconflow: ['Qwen/Qwen3.5-9B'],
  openai: []
};
const VISITOR_PROVIDERS = {
  deepseek: PROVIDERS.deepseek,
  llama: {label: '本地 llama.cpp（仅本机可用）', api_url: 'http://127.0.0.1:8000/v1', model: 'qwen3.5-9b'},
  siliconflow: PROVIDERS.siliconflow,
  openai: PROVIDERS.openai
};
const LOCAL_UI = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(window.location.hostname);
const VISITOR_DEFAULT = {provider: 'deepseek', api_url: 'https://api.deepseek.com', model: 'deepseek-flash', reasoning_effort: 'medium', api_key: ''};
const loadVisitorModel = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('qilu.model') || 'null');
    return saved && typeof saved === 'object' ? {...VISITOR_DEFAULT, ...saved} : {...VISITOR_DEFAULT};
  } catch { return {...VISITOR_DEFAULT}; }
};

const store = {
  get(key) { try { return localStorage.getItem('qilu.' + key); } catch { return null; } },
  set(key, value) { try { value == null ? localStorage.removeItem('qilu.' + key) : localStorage.setItem('qilu.' + key, String(value)); } catch {} }
};
const describe = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
const displayProse = value => String(value || '').replace(/\n[ \t\n]*\n/g, '\n\n').trim();
const chapterProse = (value, title) => {
  const body = displayProse(value);
  const lines = body.split('\n');
  return title && lines[0]?.trim() === String(title).trim() ? lines.slice(1).join('\n').trim() : body;
};
const encoded = encodeURIComponent;
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  let data;
  try { data = await response.json(); } catch { throw new Error(`服务响应无效（HTTP ${response.status}）`); }
  if (!response.ok) throw new Error(`${data.error || '请求失败'}（HTTP ${response.status}）`);
  return data;
}

function App() {
  const [books, setBooks] = useState([]);
  const [book, setBook] = useState(null);
  const [chapter, setChapter] = useState(null);
  const [number, setNumber] = useState(1);
  const [branch, setBranch] = useState(null);
  const [status, setStatus] = useState({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [importTitle, setImportTitle] = useState('');
  const [tab, setTab] = useState(store.get('tab') === 'branches' ? 'branches' : 'create');
  const [readerMode, setReaderMode] = useState('original');
  const [mobilePane, setMobilePane] = useState('reader');
  const [tocOpen, setTocOpen] = useState(false);
  const [jobId, setJobId] = useState(store.get('job'));
  const [job, setJob] = useState(null);
  const [outputOpen, setOutputOpen] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copyState, setCopyState] = useState('');
  const [revisionFeedback, setRevisionFeedback] = useState('');
  const [revisionChapter, setRevisionChapter] = useState(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const [form] = Form.useForm();
  const [settingsForm] = Form.useForm();
  const settingsProvider = Form.useWatch('provider', settingsForm) || 'auto';
  const createFork = Form.useWatch('fork_chapter', form);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [visitorModel, setVisitorModel] = useState(loadVisitorModel);
  const [visitorReady, setVisitorReady] = useState(false);
  const [visitorChecking, setVisitorChecking] = useState(false);
  const [visitorError, setVisitorError] = useState('');
  const [hasStoredKey, setHasStoredKey] = useState(() => !!loadVisitorModel().api_key);
  const current = useRef({book: null, number: 1, branch: null, bookRequest: 0, chapterRequest: 0, branchRequest: 0, jobId: store.get('job'), submitting: false});
  const outputRef = useRef(null);
  const drawerOutputRef = useRef(null);
  const guard = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(e => setError(e.message || String(e)));
  const atCapacity = status.capacity_available === undefined ? !!status.busy : status.capacity_available === false;
  const locked = !visitorReady || atCapacity || submitting || !!jobId || loading;
  const visitorLabel = visitorChecking ? '检测中…' : (!visitorModel.api_key && visitorModel.provider !== 'llama') ? '未配置模型' : visitorReady ? '我的模型就绪' : '模型未就绪';
  const visitorClass = visitorReady ? 'ready' : visitorChecking ? 'pending' : 'warn';
  const revisionAvailable = ['error', 'cancelled'].includes(job?.status) && typeof job?.draft === 'string' && !!job.draft.trim();
  const legacyDraft = job?.draft_chapter == null;
  const revisionTarget = legacyDraft ? revisionChapter : job?.draft_chapter;
  const revisionMetadataReady = !!job?.id && !!(job?.branch_id || job?.result?.branch_id) && Number.isInteger(revisionTarget) && revisionTarget >= 1 && revisionTarget <= 100000;
  const outputText = job?.preview || job?.draft || '';
  const draftText = typeof job?.draft === 'string' ? job.draft : '';
  const showDraft = !!draftText.trim() && !!job?.preview && draftText !== job.preview;

  async function refreshStatus() {
    try { setStatus(await api('/api/status')); } catch { setStatus({model_ready: false, disconnected: true}); }
  }
  async function openSettings() {
    const saved = loadVisitorModel();
    setSettingsOpen(true); setSettingsError(''); setSettingsLoaded(true); setSettingsLoading(false);
    settingsForm.resetFields();
    settingsForm.setFieldsValue({provider: saved.provider, api_url: saved.api_url, model: saved.model, reasoning_effort: saved.reasoning_effort, api_key: ''});
    setHasStoredKey(!!saved.api_key);
  }
  function closeSettings() {
    if (settingsSaving) return;
    settingsForm.resetFields(); setSettingsError(''); setSettingsOpen(false);
  }
  async function saveSettings() {
    if (settingsLoading || settingsSaving || !settingsLoaded) return;
    let values;
    try { values = await settingsForm.validateFields(); } catch { return; }
    const isLocal = values.provider === 'llama';
    const key = (values.api_key || '').trim() || (isLocal ? '' : (visitorModel.api_key || ''));
    if (!key && !isLocal) { setSettingsError('请填写你自己的 API Key。'); return; }
    const config = {provider: values.provider, api_url: values.api_url.trim(), model: values.model.trim(), reasoning_effort: values.reasoning_effort, api_key: key};
    setSettingsSaving(true); setSettingsError(''); setVisitorChecking(true);
    try {
      const result = await api('/api/model/check', config);
      if (!result.ready) {
        setVisitorReady(false); setVisitorError(result.error || '模型未就绪');
        setSettingsError(result.error || '模型未就绪，请检查地址、模型 ID 和 Key。');
        return;
      }
      localStorage.setItem('qilu.model', JSON.stringify(config));
      setVisitorModel(config); setHasStoredKey(true); setVisitorReady(true); setVisitorError('');
      setSettingsOpen(false);
    } catch (e) {
      setSettingsError(e.message || '模型检测失败，请检查 API 地址、模型 ID 和 Key。');
    } finally { setSettingsSaving(false); setVisitorChecking(false); }
  }
  function clearVisitorKey() {
    localStorage.removeItem('qilu.model');
    setVisitorModel({...VISITOR_DEFAULT});
    setVisitorReady(false); setVisitorError(''); setHasStoredKey(false);
    settingsForm.setFieldValue('api_key', '');
  }
  useEffect(() => {
    if (!visitorModel.api_key && visitorModel.provider !== 'llama') {
      setVisitorReady(false); setVisitorChecking(false); setVisitorError('');
      return;
    }
    let alive = true;
    setVisitorChecking(true);
    api('/api/model/check', visitorModel)
      .then(result => {
        if (!alive) return;
        setVisitorReady(!!result.ready);
        setVisitorError(result.ready ? '' : (result.error || '模型未就绪'));
      })
      .catch(error => {
        if (!alive) return;
        setVisitorReady(false); setVisitorError(error.message || '模型检测失败');
      })
      .finally(() => { if (alive) setVisitorChecking(false); });
    return () => { alive = false; };
  }, [visitorModel]);
  async function refreshBooks() {
    const data = await api('/api/books');
    setBooks(data.books);
    return data.books;
  }
  async function openChapter(n, id = current.current.book?.id) {
    if (!id) return;
    const request = ++current.current.chapterRequest;
    current.current.number = n;
    setNumber(n); setChapter(null);
    store.set('chapter', n);
    const data = await api(`/api/books/${encoded(id)}/chapters/${n}`);
    if (request !== current.current.chapterRequest || String(current.current.book?.id) !== String(id)) return;
    setChapter(data);
  }
  async function openBranch(id, reveal = true) {
    const bookId = current.current.book?.id;
    const request = ++current.current.branchRequest;
    setBranch(null); current.current.branch = null;
    const data = await api(`/api/branches/${encoded(id)}`);
    if (request !== current.current.branchRequest || String(current.current.book?.id) !== String(bookId)) return;
    if (String(data.book_id) !== String(bookId)) throw new Error('支线不属于当前小说');
    current.current.branch = data; setBranch(data); store.set('branch', data.id);
    if (reveal) { setReaderMode('branch'); setTab('branches'); store.set('tab', 'branches'); setMobilePane('reader'); }
  }
  async function refreshBookState() {
    if (!current.current.book?.id) return null;
    const updated = await api(`/api/books/${encoded(current.current.book.id)}`);
    current.current.book = updated; setBook(updated);
    return updated;
  }
  async function renameSelectedBranch() {
    const title = renameTitle.trim();
    if (!branch || !title) return;
    await api(`/api/branches/${encoded(branch.id)}/rename`, {title});
    setRenameOpen(false);
    await refreshBookState();
    await openBranch(branch.id, false);
    await refreshBooks();
  }
  async function truncateSelectedBranch() {
    if (!branch) return;
    await api(`/api/branches/${encoded(branch.id)}/truncate`, {});
    await refreshBookState();
    await openBranch(branch.id, false);
    await refreshBooks();
  }
  async function deleteSelectedBranch() {
    if (!branch) return;
    const removed = branch.id;
    await api(`/api/branches/${encoded(branch.id)}/delete`, {});
    const updated = await refreshBookState();
    const next = updated?.branches.find(item => item.id !== removed);
    if (next) await openBranch(next.id, false);
    else {
      current.current.branch = null; setBranch(null); store.set('branch', null);
      setReaderMode('original');
    }
    await refreshBooks();
  }
  async function openBook(id, restore = false) {
    const request = ++current.current.bookRequest;
    ++current.current.chapterRequest; ++current.current.branchRequest;
    current.current.book = null; current.current.branch = null;
    setBook(null); setBranch(null); setChapter(null); setLoading(true); setReaderMode('original');
    try {
      const data = await api(`/api/books/${encoded(id)}`);
      if (request !== current.current.bookRequest) return;
      current.current.book = data; setBook(data); store.set('book', id);
      const n = restore ? Math.max(1, Math.min(data.chapter_count, Number(store.get('chapter')) || 1)) : 1;
      form.setFieldValue('fork_chapter', n);
      const savedBranch = restore ? store.get('branch') : null;
      if (!restore) store.set('branch', null);
      await openChapter(n, id);
      if (request !== current.current.bookRequest) return;
      if (savedBranch && data.branches.some(b => String(b.id) === savedBranch)) await openBranch(savedBranch, false);
    } finally { if (request === current.current.bookRequest) setLoading(false); }
  }
  async function refreshAfterJob(completed) {
    await refreshBooks();
    const selected = current.current.book;
    if (!selected || (completed.result?.book_id && String(completed.result.book_id) !== String(selected.id))) return;
    const request = current.current.bookRequest;
    const updated = await api(`/api/books/${encoded(selected.id)}`);
    if (request !== current.current.bookRequest || current.current.book?.id !== selected.id) return;
    current.current.book = updated; setBook(updated);
    await openChapter(current.current.number, selected.id);
    if (request !== current.current.bookRequest) return;
    const branchId = completed.result?.branch_id || current.current.branch?.id;
    if (branchId && updated.branches.some(b => String(b.id) === String(branchId))) await openBranch(branchId, !!completed.result?.branch_id);
  }
  async function beginJob(path, body) {
    if (current.current.submitting || current.current.jobId || !visitorReady || atCapacity) throw new Error('你的模型未就绪、并发容量已满或本窗口已有任务');
    if (!visitorModel.api_key && visitorModel.provider !== 'llama') throw new Error('请先在“我的模型”中填写 API Key');
    current.current.submitting = true; setSubmitting(true); setError('');
    try {
      const data = await api(path, {...(body || {}), model: visitorModel});
      current.current.jobId = String(data.job_id); store.set('job', data.job_id);
      setJob(null); setJobId(String(data.job_id));
    } finally { current.current.submitting = false; setSubmitting(false); }
  }
  async function reviseDraft() {
    if (!revisionAvailable || !revisionMetadataReady || !revisionFeedback.trim() || locked) throw new Error('请填写编辑反馈和有效的草稿章号，并等待模型可用');
    await beginJob(`/api/jobs/${encoded(job.id)}/revise`, {feedback: revisionFeedback.trim(), ...(legacyDraft ? {chapter: revisionChapter} : {})});
    setRevisionFeedback(''); setRevisionChapter(null);
  }
  useEffect(() => { setRevisionFeedback(''); setRevisionChapter(null); }, [job?.id]);
  useEffect(() => {
    if (!autoScroll || job?.status !== 'running') return;
    for (const element of [outputRef.current, drawerOutputRef.current]) {
      if (element) element.scrollTop = element.scrollHeight;
    }
  }, [outputText, draftText, autoScroll, outputOpen, job?.status]);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const selector = '.ant-btn:not([disabled]), .ant-tree-node-content-wrapper, .branch-chapter, .branch-overview-item, .ant-tabs-tab, .fork-excerpt summary';
    let active = null;
    let frame = 0;
    let point = {x: 0, y: 0};
    const timers = new WeakMap();
    const reset = element => {
      if (!element) return;
      clearTimeout(timers.get(element));
      element.classList.remove('jelly-active');
      element.classList.add('jelly-return');
      element.style.translate = '0px 0px';
      element.style.scale = '1';
      timers.set(element, setTimeout(() => {
        element.classList.remove('jelly-return');
        element.style.removeProperty('translate');
        element.style.removeProperty('scale');
      }, 380));
    };
    const apply = () => {
      frame = 0;
      if (!active) return;
      const rect = active.getBoundingClientRect();
      const dx = point.x - (rect.left + rect.width / 2);
      const dy = point.y - (rect.top + rect.height / 2);
      const limit = Math.min(4, Math.max(2, Math.min(rect.width, rect.height) * 0.025));
      const tx = Math.max(-limit, Math.min(limit, dx * 0.035));
      const ty = Math.max(-limit, Math.min(limit, dy * 0.035));
      active.style.translate = `${tx.toFixed(2)}px ${ty.toFixed(2)}px`;
      active.style.scale = '1.012';
    };
    const onMove = event => {
      if (event.pointerType && event.pointerType !== 'mouse') { clear(); return; }
      const element = event.target instanceof Element ? event.target.closest(selector) : null;
      if (element !== active) {
        reset(active);
        active = element;
        if (active) {
          active.classList.add('jelly-target', 'jelly-active');
          active.classList.remove('jelly-return');
        }
      }
      if (!active) return;
      point = {x: event.clientX, y: event.clientY};
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const clear = () => { reset(active); active = null; };
    const onBlur = () => clear();
    document.addEventListener('pointermove', onMove, {passive: true});
    document.addEventListener('pointerleave', clear, {passive: true});
    window.addEventListener('scroll', clear, {capture: true, passive: true});
    window.addEventListener('blur', onBlur);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', clear);
      window.removeEventListener('scroll', clear, {capture: true});
      window.removeEventListener('blur', onBlur);
      reset(active);
      active = null;
    };
  }, []);
  useEffect(() => {
    if (!copyState) return;
    const timer = setTimeout(() => setCopyState(''), 1600);
    return () => clearTimeout(timer);
  }, [copyState]);
  async function copyOutput(text) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); setCopyState('已复制'); }
    catch { setError('复制失败，请手动选中文本复制'); }
  }
  useEffect(() => {
    let alive = true;
    void refreshStatus();
    guard(async () => {
      const list = await refreshBooks();
      if (!alive) return;
      const saved = store.get('book');
      if (list.length) await openBook(list.some(b => String(b.id) === saved) ? saved : list[0].id, true);
    })();
    const timer = setInterval(refreshStatus, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!jobId) return;
    let alive = true, timer;
    async function poll() {
      try {
        const data = await api(`/api/jobs/${encoded(jobId)}`);
        if (!alive) return;
        setJob(data);
        if (['done', 'error', 'cancelled'].includes(data.status)) {
          current.current.jobId = null; store.set('job', null); setJobId(null);
          if (data.status === 'error') setError(describe(data.error) || '任务失败');
          await refreshStatus(); await refreshAfterJob(data); return;
        }
      } catch (e) {
        if (!alive) return;
        if (/HTTP 404|不存在|not found/i.test(e.message)) {
          current.current.jobId = null; store.set('job', null); setJobId(null); setError('无法恢复任务：' + e.message); return;
        }
        setJob(previous => ({...previous, stage: e.message + '；自动重试中'}));
      }
      if (alive) timer = setTimeout(poll, 1000);
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [jobId]);

  async function importBook() {
    if (!file) throw new Error('请选择 TXT / EPUB 文件');
    if (!/\.(txt|epub)$/i.test(file.name)) throw new Error('仅支持 TXT / EPUB');
    if (file.size > 32 * 1024 * 1024) throw new Error('文件不能超过 32 MiB');
    setImporting(true);
    try {
      const content = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取文件'));
        reader.readAsDataURL(file);
      });
      const data = await api('/api/books', {filename: file.name, title: importTitle.trim() || undefined, content_base64: content});
      await refreshBooks(); await openBook(data.id || data.book_id);
      setImportOpen(false); setFile(null); setImportTitle('');
    } finally { setImporting(false); }
  }
  const forkHere = () => { form.setFieldValue('fork_chapter', number); setTab('create'); store.set('tab', 'create'); setMobilePane('if'); };
  const toc = <div className="toc-content"><div className="pane-heading">章节 <span>{book?.chapter_count || 0} · 已理解 {book?.read_chapters || 0}</span></div><Tree blockNode selectedKeys={[String(number)]} treeData={(book?.chapters || []).map(c => ({key: String(c.number), title: <span>{c.read && <span className="read-mark">✓</span>}{c.title}</span>}))} onSelect={keys => { if (keys.length) { setReaderMode('original'); setTocOpen(false); setMobilePane('reader'); guard(openChapter)(Number(keys[0])); } }}/></div>;
  const branchOptions = (book?.branches || []).map(b => ({value: b.id, label: `${b.title}${b.chapter_count ? ` · ${b.chapter_count}章` : ''}${b.created_at ? ` · ${b.created_at.slice(5, 16)}` : ''}`}));
  const createForkTitle = book?.chapters?.find(c => c.number === createFork)?.title;
  const ifPane = <section className="if-content" aria-label="IF 工作区"><Tabs activeKey={tab} onChange={value => { setTab(value); store.set('tab', value); }} items={[
    {key: 'create', label: '创建 IF', children: <Form form={form} layout="vertical" initialValues={{chapter_words: 1200, fork_chapter: 1}} onFinish={guard(values => beginJob(`/api/books/${encoded(book.id)}/branches`, {...values, title: values.title.trim(), premise: values.premise.trim(), style: values.style?.trim() || ''}))}>
      <Form.Item label="支线名称" name="title" rules={[{required: true, whitespace: true, message: '填写支线名称'}]}><Input aria-label="支线名称" maxLength={200}/></Form.Item>
      <Form.Item label="分叉章节（仅沿用分歧前事实）" name="fork_chapter" rules={[{required: true}]}><Select aria-label="分叉章节" options={[{value: 0, label: '故事开始前（不采用原作剧情）'}, ...(book?.chapters || []).map(c => ({value: c.number, label: c.title + ' 之后'}))]}/></Form.Item>
      <div className="fork-hint">{createFork ? <>分歧点：<strong>{createForkTitle || `阅读段 ${createFork}`} 之后</strong>。该章结束前的事实保留，之后原作全部作废。</> : '分歧点：故事开始前。原作剧情不采用。'}</div>
      <Form.Item label="IF 设定 / 转折点" name="premise" rules={[{required: true, whitespace: true, message: '填写 IF 设定'}]}><Input.TextArea aria-label="IF 设定" maxLength={6000} rows={6}/></Form.Item>
      <Form.Item label="写作风格（可选）" name="style"><Input.TextArea aria-label="写作风格" maxLength={2000} rows={3}/></Form.Item>
      <Form.Item label="每章字数" name="chapter_words" rules={[{required: true}, {type: 'number', min: 400, max: 4000}]}><InputNumber aria-label="每章字数" min={400} max={4000} step={100}/></Form.Item>
      <Button type="primary" htmlType="submit" block disabled={!book || locked} loading={submitting}>创建支线并写首章</Button>
    </Form>},
    {key: 'branches', label: `支线 ${book?.branches?.length || 0}`, children: <><Select aria-label="选择支线" placeholder="选择支线" value={branch?.id} options={branchOptions} onChange={guard(id => openBranch(id, false))} className="full-width" popupMatchSelectWidth={340}/>{branch ? <><div className="fork-card"><div className="fork-kicker">开篇位置</div><div className="fork-title">{branch.fork_chapter ? `${branch.fork_title || `阅读段 ${branch.fork_chapter}`} 之后` : '故事开始前'}</div><div className="fork-book">《{branch.book_title || book?.title}》</div><p>{branch.fork_chapter ? '只保留该章结束前的事实；这一章之后的原作全部作废。' : '不采用原作剧情，从故事开始前改写。'}</p>{branch.fork_excerpt && <details className="fork-excerpt"><summary>查看分歧点原文尾段</summary><pre>{branch.fork_excerpt}</pre></details>}</div><div className="branch-meta"><span>{branch.chapters.length} 章</span><span>{branch.chapter_words} 字/章</span><span>{branch.fork_chapter ? '从原作分叉' : '故事开始前'}</span></div><Space direction="vertical" className="branch-actions"><Button type="primary" disabled={locked} onClick={guard(() => beginJob(`/api/branches/${encoded(branch.id)}/continue`, {}))}>续写一章</Button><Button disabled={locked} onClick={guard(() => beginJob(`/api/branches/${encoded(branch.id)}/regenerate`, {}))}>{branch.chapters.length ? '重新生成末章（保留原版）' : '重新生成首章'}</Button><Button onClick={() => { setReaderMode('branch'); setMobilePane('reader'); }}>阅读支线</Button><Button href={`/api/branches/${encoded(branch.id)}/export`} download>导出 TXT</Button></Space><div className="branch-section"><div className="branch-section-head">已写章节 <span>{branch.chapters.length}</span></div>{branch.chapters.length ? <div className="branch-chapter-list">{branch.chapters.map(c => <button type="button" key={c.number} className="branch-chapter" onClick={() => { setReaderMode('branch'); setMobilePane('reader'); }}><span className="branch-chapter-num">{c.number}</span><span className="branch-chapter-title">{c.title}</span><span className="branch-chapter-count">{c.text.length} 字</span></button>)}</div> : <div className="branch-empty">还没有正文。点“续写一章”开始。</div>}</div><div className="branch-admin"><Button size="small" disabled={submitting} onClick={() => { setRenameTitle(branch.title); setRenameOpen(true); }}>重命名</Button><Popconfirm title="删除最后一章？" description={`将删除第 ${branch.chapters.length} 章正文，其他章保留；之后可重新续写。`} okText="删除" cancelText="取消" okButtonProps={{danger: true}} disabled={submitting || !branch.chapters.length} onConfirm={guard(truncateSelectedBranch)}><Button size="small" disabled={submitting || !branch.chapters.length}>删除末章</Button></Popconfirm><Popconfirm title="删除整条支线？" description="正文和支线记忆会一并删除，无法恢复；原书不受影响。" okText="删除" cancelText="取消" okButtonProps={{danger: true}} disabled={submitting} onConfirm={guard(deleteSelectedBranch)}><Button size="small" danger type="text" disabled={submitting}>删除支线</Button></Popconfirm></div><p className="branch-note">不进行自动评分，质量只由你的阅读感受决定。重新生成会新建支线并保留原版；“删除末章”只移除最后一条正文，便于重写。</p><Collapse className="details" items={[{key: 'premise', label: '设定 / 风格', children: <pre>{branch.premise}{branch.style ? '\n\n' + branch.style : ''}</pre>}, {key: 'outline', label: '支线大纲', children: <pre>{describe(branch.outline)}</pre>}]}/><Collapse className="details" items={[{key: 'all', label: `全部支线（${book?.branches?.length || 0}）`, children: <div className="branch-overview-list">{(book?.branches || []).map(item => <button type="button" key={item.id} className={`branch-overview-item ${item.id === branch.id ? 'active' : ''}`} onClick={guard(() => openBranch(item.id, false))}><span className="branch-overview-title">{item.title}</span><span className="branch-overview-meta">{item.created_at ? `${item.created_at.slice(5, 16)} · ` : ''}{item.fork_chapter ? `从「${item.fork_title || `阅读段 ${item.fork_chapter}`}」之后` : '故事开始前'} · {item.chapter_count} 章</span></button>)}</div>}]}/></> : <div className="branch-empty-state">选择一条支线查看开篇位置和管理操作，或到“创建 IF”新建。</div>}</>}
  ]}/></section>;
  return <ConfigProvider componentSize="middle" wave={{disabled: true}} theme={{token: {borderRadius: 8, borderRadiusLG: 14, colorPrimary: '#2f6b5f', colorInfo: '#2f6b5f', colorText: '#252a2e', colorTextSecondary: '#70777b', colorBorder: '#e0dacd', colorBgContainer: '#fffdf8', colorBgLayout: '#f1eee7', colorLink: '#2f6b5f', fontSize: 13.5, controlHeight: 32}, components: {Button: {primaryShadow: '0 2px 8px rgba(47, 107, 95, .22)', defaultShadow: 'none', fontWeight: 500}, Select: {optionSelectedBg: '#e7f0ec'}, Collapse: {headerPadding: '8px 12px', contentPadding: '8px 12px'}}}}>
    <div className="workbench">
      <header className="toolbar"><div className="brand-block"><span className="brand">小说工作台</span><span className="brand-sub">长文本理解 · 无矛盾改写 · IF 续写</span></div><Select aria-label="选择小说" className="book-select" placeholder="选择小说" value={book?.id} loading={loading} options={books.map(b => ({value: b.id, label: b.title}))} onChange={guard(id => openBook(id))}/><Button onClick={() => setImportOpen(true)}>导入</Button><Button onClick={openSettings}>我的模型</Button><Button className="help-button" href="/help" target="_blank" rel="noopener noreferrer" aria-label="打开使用帮助">帮助</Button><Tag bordered={false} className={`model-status ${visitorClass}`} color={visitorReady ? 'success' : 'warning'} title={`${VISITOR_PROVIDERS[visitorModel.provider]?.label || visitorModel.provider} · ${visitorModel.model} · 思考：${visitorModel.reasoning_effort} · 任务 ${status.active_jobs ?? (status.busy ? 1 : 0)}/${status.max_concurrency ?? 1}`}>{status.disconnected ? '服务离线' : visitorLabel} · {status.active_jobs ?? (status.busy ? 1 : 0)}/{status.max_concurrency ?? 1}</Tag></header>
      {error && <Alert type="error" message={error} closable onClose={() => setError('')} showIcon/>}
      {(job || jobId) && <section className="job-panel" aria-label="后台任务"><div className="job-row"><span role="status" className={`job-status ${job?.status || 'queued'}`}>{({done: '任务完成', error: '任务失败', cancelled: '已取消', running: '运行中', queued: '排队中'})[job?.status] || '提交成功'} · {job?.stage || ''}</span><Space size={6} wrap><span className="job-meta">{outputText.length} 字{job?.reasoning_chars ? ` · 思考 ${job.reasoning_chars} 字` : ''}</span>{jobId ? <Button danger onClick={guard(async () => { await api(`/api/jobs/${encoded(jobId)}/cancel`, {}); setJob(j => ({...j, stage: '已请求取消'})); })}>取消任务</Button> : <Button type="text" onClick={() => setJob(null)}>关闭</Button>}</Space></div><Progress aria-label="任务进度" percent={job?.total ? Math.min(100, Math.round(100 * (job.progress || 0) / job.total)) : 0} status={job?.status === 'error' ? 'exception' : job?.status === 'done' ? 'success' : 'active'} size="small" format={() => job?.total ? `${job.progress || 0}/${job.total}` : ''}/>
        <div className="job-output-wrap"><div className="job-output-bar"><span>模型输出{job?.status === 'running' ? ' · 实时' : ''}</span><Space size={10} wrap><Checkbox checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)}>自动滚动</Checkbox><Button type="link" size="small" disabled={!outputText} onClick={() => copyOutput(outputText)}>{copyState || '复制'}</Button><Button type="link" size="small" disabled={!outputText} onClick={() => setOutputOpen(true)}>放大查看</Button></Space></div><pre className="job-output" ref={outputRef}>{outputText || '等待模型输出…'}</pre></div>
        {showDraft && <div className="job-output-wrap"><div className="job-output-bar"><span>{job?.published ? '本次正文（已保存）' : '最后完整草稿（未保存）'}</span><Space size={10}><Button type="link" size="small" onClick={() => copyOutput(draftText)}>{copyState || '复制'}</Button><Button type="link" size="small" onClick={() => setOutputOpen(true)}>放大查看</Button></Space></div><pre className="job-output job-draft">{draftText}</pre></div>}
        {revisionAvailable && <div className="draft-revision">
          <Input.TextArea aria-label="草稿修订反馈" placeholder="填写编辑反馈；仅修订此任务的未发布草稿，不覆盖已保存章节" maxLength={8000} showCount autoSize={{minRows: 2, maxRows: 4}} value={revisionFeedback} onChange={event => setRevisionFeedback(event.target.value)} disabled={submitting}/>
          <div className="draft-revision-actions">
            {legacyDraft ? <label className="draft-chapter-label">草稿 IF 章号 <InputNumber aria-label="草稿 IF 章号" min={1} max={100000} precision={0} value={revisionChapter} onChange={setRevisionChapter} disabled={submitting} placeholder="请明确填写"/></label> : <span>草稿 IF 第 {job.draft_chapter} 章 · 未发布</span>}
            <Button type="primary" loading={submitting} disabled={locked || !revisionMetadataReady || !revisionFeedback.trim()} onClick={guard(reviseDraft)}>按反馈修订</Button>
          </div>
          {!(job?.id && (job?.branch_id || job?.result?.branch_id)) && <span className="draft-revision-note">任务缺少来源或 IF 支线信息，无法修订。</span>}
        </div>}
      </section>}
      <div className="mobile-navigation"><Button onClick={() => setTocOpen(true)} disabled={!book}>章节</Button><Tabs activeKey={mobilePane} onChange={setMobilePane} items={[{key: 'reader', label: '阅读'}, {key: 'if', label: 'IF / 支线'}]}/><Button className="help-mobile" href="/help" target="_blank" rel="noopener noreferrer" aria-label="打开使用帮助">帮助</Button></div>
      <main className="workspace"><aside className="toc-pane">{toc}</aside><section className={`reader-pane ${mobilePane !== 'reader' ? 'mobile-hidden' : ''}`} aria-label="正文阅读"><div className="reader-toolbar"><Tabs activeKey={readerMode} onChange={setReaderMode} items={[{key: 'original', label: '原作'}, {key: 'branch', label: 'IF 正文', disabled: !branch}]}/>{readerMode === 'original' && <Space><Button aria-label="上一章" disabled={!chapter || number <= 1} onClick={guard(() => openChapter(number - 1))}>上一章</Button><Button aria-label="下一章" disabled={!chapter || number >= book?.chapter_count} onClick={guard(() => openChapter(number + 1))}>下一章</Button></Space>}</div><article className="prose-scroll" key={`${book?.id}-${readerMode}-${number}-${branch?.id}`}>
        {readerMode === 'original' ? chapter ? <><h1>{chapter.title}</h1><div className="prose">{chapterProse(chapter.text, chapter.title)}</div><Collapse className="details" items={[{key: 'memory', label: '累计记忆', children: <pre>{describe(chapter.memory) || '尚未理解本章'}</pre>}]}/></> : <div className="empty-text">{loading || book ? '加载章节…' : '导入 TXT / EPUB 或选择小说'}</div> : <Collapse ghost defaultActiveKey={(branch?.chapters || []).map((_, i) => String(i))} items={(branch?.chapters || []).map((c, i) => ({key: String(i), label: c.title, children: <div className="prose">{chapterProse(c.text, c.title)}</div>}))}/>}
      </article>{readerMode === 'original' && <footer className="reader-actions"><Button disabled={!chapter || locked} onClick={guard(() => beginJob(`/api/books/${encoded(book.id)}/read`, {through: number}))}>理解至本章</Button><Button disabled={!book || locked} onClick={guard(() => beginJob(`/api/books/${encoded(book.id)}/read`, {through: book.chapter_count}))}>理解全书</Button><Button disabled={!chapter} onClick={forkHere}>从本章后分叉</Button></footer>}</section><aside className={`if-pane ${mobilePane !== 'if' ? 'mobile-hidden' : ''}`}>{ifPane}</aside></main>
      <Drawer title="章节" placement="left" width={300} open={tocOpen} onClose={() => setTocOpen(false)}>{toc}</Drawer>
      <Drawer title="模型输出" placement="right" width="min(980px, 94vw)" open={outputOpen} onClose={() => setOutputOpen(false)} extra={<Space size={8}><Checkbox checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)}>自动滚动</Checkbox><Button disabled={!outputText} onClick={() => copyOutput(outputText)}>{copyState || '复制'}</Button></Space>}>
        <div className="job-output-bar"><span>{job?.stage || '模型输出'} · {outputText.length} 字{job?.reasoning_chars ? ` · 思考 ${job.reasoning_chars} 字` : ''}</span><span>{job?.model || ''}</span></div>
        <pre className="job-output job-output-full" ref={drawerOutputRef}>{outputText || '等待模型输出…'}</pre>
        {showDraft && <><div className="job-output-bar">最后完整草稿（未保存）</div><pre className="job-output job-output-full job-draft">{draftText}</pre></>}
      </Drawer>
      <Modal title="我的模型" open={settingsOpen} onCancel={closeSettings} onOk={saveSettings} confirmLoading={settingsSaving} okText="保存并测试" cancelText="取消" cancelButtonProps={{disabled: settingsSaving}} okButtonProps={{disabled: settingsSaving || settingsLoading}}>
        {settingsError && <Alert type="error" message={settingsError} showIcon/>}
        <Alert className="settings-hint" type="info" showIcon message="模型由你提供：API Key 只保存在本浏览器，提交任务时发送到服务端内存，不写入数据库。请勿在公用电脑保存。"/>
        <Form form={settingsForm} layout="vertical" disabled={settingsLoading || settingsSaving} autoComplete="off" onValuesChange={changed => { setSettingsError(''); const preset = VISITOR_PROVIDERS[changed.provider]; if (preset?.api_url) settingsForm.setFieldsValue({api_url: preset.api_url, model: preset.model}); }}>
          <Form.Item label="接口类型" name="provider" rules={[{required: true}]}><Select aria-label="接口类型" options={Object.entries(VISITOR_PROVIDERS).filter(([value]) => LOCAL_UI || value !== 'llama').map(([value, preset]) => ({value, label: preset.label}))}/></Form.Item>
          {settingsProvider === 'deepseek' && <Alert className="settings-hint" type="info" showIcon message="DeepSeek：模型 deepseek-flash / deepseek-v4-pro；使用你自己的 DeepSeek API Key。"/>
            || settingsProvider === 'llama' && <Alert className="settings-hint" type="warning" showIcon message="本地 llama.cpp 仅限在本机通过 http://127.0.0.1:8080 访问时使用；公网域名会拒绝本地/内网地址。通常不需要 API Key。"/>
            || settingsProvider === 'siliconflow' && <Alert className="settings-hint" type="info" showIcon message="SiliconFlow：使用你自己的 SiliconFlow API Key，模型 ID 以服务端为准。"/>
            || <Alert className="settings-hint" type="info" showIcon message="自定义 OpenAI 兼容接口：必须是公网 HTTPS 地址，使用你自己的 Key。"/>}
          <Form.Item label="API URL（OpenAI 兼容基础地址）" name="api_url" rules={[{required: true, whitespace: true, message: '填写 API URL'}, {type: 'url', message: '填写完整的 https:// URL'}, {validator: (_, value) => !value || /^https?:\/\//.test(value) ? Promise.resolve() : Promise.reject(new Error('填写 http:// 或 https:// 地址'))}]}><Input aria-label="API URL" placeholder="https://api.deepseek.com"/></Form.Item>
          <Form.Item label="模型 ID" name="model" rules={[{required: true, whitespace: true, message: '填写模型 ID'}]}><AutoComplete aria-label="模型 ID" placeholder={settingsProvider === 'deepseek' ? 'deepseek-flash 或 deepseek-v4-pro' : '填写模型 ID'} options={(MODEL_SUGGESTIONS[settingsProvider] || []).map(value => ({value}))}/></Form.Item>
          <Form.Item label={settingsProvider === 'deepseek' ? '思考强度（映射到官方 none/low/high/max）' : '思考强度'} name="reasoning_effort" rules={[{required: true}]}><Select aria-label="思考强度" options={settingsProvider === 'deepseek' ? [{value: 'none', label: '关闭'}, {value: 'low', label: '低'}, {value: 'medium', label: '中（官方归为 high）'}, {value: 'high', label: '高（官方 max）'}] : [{value: 'none', label: '关闭'}, {value: 'low', label: '低 · 2048 tokens'}, {value: 'medium', label: '中 · 4096 tokens'}, {value: 'high', label: '高 · 8192 tokens'}]}/></Form.Item>
          <Form.Item label={`API 密钥（${settingsProvider === 'llama' ? '本地模型通常不需要' : hasStoredKey ? '已保存；留空保留' : '未配置'}）`} name="api_key"><Input.Password aria-label="API 密钥" autoComplete="new-password" visibilityToggle={false} placeholder={settingsProvider === 'llama' ? '本地服务无鉴权时留空' : hasStoredKey ? '已保存 Key；留空保留' : '粘贴你自己的 API Key'}/></Form.Item>
          <Space wrap><Button danger type="text" size="small" disabled={settingsSaving || !hasStoredKey} onClick={clearVisitorKey}>清除已保存 Key</Button>{visitorChecking ? <Tag>检测中…</Tag> : visitorReady ? <Tag color="success">已连接</Tag> : null}</Space>
          {visitorError && <Alert className="settings-hint" type="warning" showIcon message={visitorError}/>}
        </Form>
      </Modal>
      <Modal title="重命名支线" open={renameOpen} onCancel={() => setRenameOpen(false)} onOk={guard(renameSelectedBranch)} okText="保存" cancelText="取消" okButtonProps={{disabled: submitting || !renameTitle.trim()}}>
        <Input aria-label="支线名称" value={renameTitle} onChange={event => setRenameTitle(event.target.value)} maxLength={200} onPressEnter={() => renameTitle.trim() && guard(renameSelectedBranch)()}/>
      </Modal>
      <Modal title="导入 TXT / EPUB" open={importOpen} onCancel={() => !importing && setImportOpen(false)} onOk={guard(importBook)} confirmLoading={importing} okText="导入" cancelText="取消" cancelButtonProps={{disabled: importing}}><Form layout="vertical"><Form.Item label="小说文件（最大 32 MiB）"><Upload accept=".txt,.epub" maxCount={1} beforeUpload={selected => { setFile(selected); return false; }} onRemove={() => setFile(null)} fileList={file ? [{uid: 'selected', name: file.name, status: 'done'}] : []}><Button aria-label="选择小说文件" disabled={importing}>选择文件</Button></Upload></Form.Item><Form.Item label="书名（可选）"><Input aria-label="导入书名" value={importTitle} onChange={e => setImportTitle(e.target.value)} maxLength={200}/></Form.Item></Form></Modal>
    </div>
  </ConfigProvider>;
}

createRoot(document.getElementById('root')).render(<App/>);
