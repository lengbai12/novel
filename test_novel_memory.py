"""Memory summarization must split and retry instead of aborting on a token cap."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import novel_app as app
from novel_model import DEFAULTS, ModelError


class MemoryRetryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = app.DATA, app.SETTINGS_PATH, app.SETTINGS, dict(app.JOBS), set(app.ACTIVE)
        app.DATA = Path(self.tmp.name)
        app.SETTINGS_PATH = app.DATA / 'settings.json'
        app.initialize()
        app.SETTINGS = dict(DEFAULTS)
        app.ACTIVE.clear()

    def tearDown(self):
        app.DATA, app.SETTINGS_PATH, app.SETTINGS, jobs, active = self.old
        app.JOBS.clear(); app.JOBS.update(jobs)
        app.ACTIVE.clear(); app.ACTIVE.update(active)
        self.tmp.cleanup()

    def test_budget_error_splits_and_keeps_thinking(self):
        calls = []
        def fake_generate(job, system, prompt, max_tokens=1600, temperature=.5, schema=None, *, thinking=True):
            calls.append((len(prompt), thinking))
            self.assertTrue(thinking)
            if len(prompt) > 4000:
                raise ModelError("模型达到思考与回答的总 token 上限，未将截断内容保存为成功结果。")
            return json.dumps({'summary': '事实摘要' * 20}, ensure_ascii=False)
        text = '章节正文。' * 1200
        with patch.object(app, 'token_count', side_effect=lambda value: len(value)), \
             patch.object(app, 'generate', side_effect=fake_generate):
            result = app.summarize({'id': 'test'}, text, '只为本书制作记忆。')
        self.assertTrue(result)
        self.assertGreaterEqual(len(calls), 3)
        self.assertGreater(calls[0][0], 4000)

    def test_transient_api_error_is_retried(self):
        state = {'calls': 0}
        def fake_generate(job, system, prompt, max_tokens=1600, temperature=.5, schema=None, *, thinking=True):
            state['calls'] += 1
            if state['calls'] == 1:
                raise ModelError("模型 API 返回 429")
            return json.dumps({'summary': 'ok'}, ensure_ascii=False)
        with patch.object(app, 'token_count', side_effect=lambda value: len(value)), \
             patch.object(app, 'generate', side_effect=fake_generate), \
             patch.object(app.time, 'sleep', return_value=None):
            result = app.summarize({'id': 'test'}, '正文。' * 300, '摘要。')
        self.assertEqual(result, 'ok')
        self.assertEqual(state['calls'], 2)


if __name__ == '__main__':
    unittest.main()
