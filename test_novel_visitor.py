"""Visitor keys must be job-scoped, never fall back to the owner key or persist."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import novel_app as app
from novel_model import DEFAULTS


class VisitorCredentialTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = app.DATA, app.SETTINGS_PATH, app.SETTINGS, dict(app.JOBS), set(app.ACTIVE)
        app.DATA = Path(self.tmp.name)
        app.SETTINGS_PATH = app.DATA / 'settings.json'
        app.initialize()
        app.SETTINGS = {**DEFAULTS, 'provider': 'deepseek', 'api_url': 'https://api.deepseek.com',
                        'model': 'deepseek-flash', 'api_key': 'owner-secret', 'api_key_provider': 'deepseek'}

    def tearDown(self):
        app.DATA, app.SETTINGS_PATH, app.SETTINGS, jobs, active = self.old
        app.JOBS.clear(); app.JOBS.update(jobs)
        app.ACTIVE.clear(); app.ACTIVE.update(active)
        self.tmp.cleanup()

    def raw(self, **values):
        return {'model': {'provider': 'deepseek', 'api_url': 'https://api.deepseek.com',
                          'model': 'deepseek-flash', 'reasoning_effort': 'medium',
                          'api_key': 'sk-visitor', **values}}

    def public_dns(self):
        return patch.object(app.socket, 'getaddrinfo',
                            return_value=[(2, 1, 6, '', ('93.184.216.34', 443))])

    def test_local_llama_is_only_allowed_for_local_request(self):
        local = {'provider': 'llama', 'api_url': 'http://127.0.0.1:8000/v1', 'model': 'qwen3.5-9b', 'reasoning_effort': 'medium', 'api_key': ''}
        settings = app.visitor_settings({'model': local}, allow_local=True)
        self.assertEqual(settings['provider'], 'llama')
        self.assertEqual(settings['api_key'], '')
        with self.assertRaises(ValueError):
            app.visitor_settings({'model': local}, allow_local=False)

    def test_visitor_key_is_used(self):
        with self.public_dns():
            settings = app.visitor_settings(self.raw())
        self.assertEqual(settings['api_key'], 'sk-visitor')
        self.assertEqual(settings['api_key_provider'], 'deepseek')

    def test_blank_visitor_key_does_not_use_owner_key(self):
        with self.public_dns(), self.assertRaises(ValueError):
            app.visitor_settings(self.raw(api_key=''))

    def test_http_and_private_targets_are_rejected(self):
        with self.public_dns(), self.assertRaises(ValueError):
            app.visitor_settings(self.raw(api_url='http://api.deepseek.com'))
        with patch.object(app.socket, 'getaddrinfo',
                          return_value=[(2, 1, 6, '', ('192.168.1.10', 443))]), \
                self.assertRaises(ValueError):
            app.visitor_settings(self.raw())

    def test_health_check_uses_visitor_settings(self):
        with self.public_dns(), patch.object(app, 'api_json',
                                             return_value={'data': [{'id': 'deepseek-flash'}]}):
            result = app.check_visitor_model(self.raw()['model'])
        self.assertTrue(result['ready'])
        self.assertEqual(result['model'], 'deepseek-flash')

    def test_submitted_job_state_has_no_key(self):
        with self.public_dns():
            visitor = app.visitor_settings(self.raw())
        with patch.object(app.POOL, 'submit', return_value=None):
            result = app.submit(lambda job: {'ok': True}, 'book-id', model_settings=visitor)
        job = app.JOBS[result['job_id']]
        self.assertNotIn('api_key', job)
        self.assertNotIn('sk-visitor', json.dumps(job))
        with app.db() as c:
            saved = json.loads(c.execute('SELECT state FROM jobs WHERE id=?', (result['job_id'],)).fetchone()[0])
        self.assertNotIn('sk-visitor', json.dumps(saved))


if __name__ == '__main__':
    unittest.main()
