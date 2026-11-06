"""Regenerating a last chapter must not lose or leak existing history."""
import base64
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import novel_app as app


class RegenerationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = app.DATA, app.SETTINGS_PATH, app.SETTINGS, dict(app.JOBS), set(app.ACTIVE)
        app.DATA = Path(self.tmp.name)
        app.SETTINGS_PATH = app.DATA / 'settings.json'
        app.initialize()
        app.ACTIVE.clear()
        self.book = app.import_book({'filename': 'story.txt', 'content_base64': base64.b64encode(b'Chapter 1\n\nMara waited.').decode()})['id']
        self.branch = 'original'
        with app.db() as c:
            c.execute('INSERT INTO branches VALUES(?,?,?,?,?,?,?,?,?)', (self.branch, self.book, 'Route', 1, 'Goal', 'Style', 800, 'Plan', 'now'))
            for n in (1, 2):
                c.execute('INSERT INTO branch_chapters VALUES(?,?,?,?,?,?)', (self.branch, n, f'Title {n}', f'Original prose {n}', f'Memory {n}', '[]'))
                c.execute('INSERT INTO branch_memories VALUES(?,?,?,?,?)', (self.branch, n, n, 0, f'Memory {n}'))
            c.execute('INSERT INTO branch_memories VALUES(?,?,?,?,?)', (self.branch, 1, 2, 1, 'Includes discarded ending'))
        self.job = {'id': 'regen', 'status': 'running', 'book_id': self.book, 'branch_id': self.branch}

    def tearDown(self):
        app.DATA, app.SETTINGS_PATH, app.SETTINGS, jobs, active = self.old
        app.JOBS.clear(); app.JOBS.update(jobs)
        app.ACTIVE.clear(); app.ACTIVE.update(active)
        self.tmp.cleanup()

    def test_replacement_preserves_original_and_excludes_old_last_chapter(self):
        before = app.require_branch(self.branch)
        def inspect(job, branch_id):
            replacement = app.require_branch(branch_id)
            self.assertNotEqual(branch_id, self.branch)
            self.assertEqual(replacement['chapters'], before['chapters'][:1])
            with app.db() as c:
                memories = c.execute('SELECT start,end,text FROM branch_memories WHERE branch_id=?', (branch_id,)).fetchall()
            self.assertEqual([tuple(row) for row in memories], [(1, 1, 'Memory 1')])
            return {'book_id': self.book, 'branch_id': branch_id}
        with patch.object(app, 'continue_job', side_effect=inspect):
            result = app.regenerate_job(self.job, self.branch)
        self.assertEqual(app.require_branch(self.branch), before)
        self.assertEqual(self.job['result'], result)

    def test_generation_failure_keeps_original_and_retryable_prefix(self):
        before = app.require_branch(self.branch)
        with patch.object(app, 'continue_job', side_effect=app.ModelError('Provider unavailable')):
            with self.assertRaises(app.ModelError):
                app.regenerate_job(self.job, self.branch)
        self.assertEqual(app.require_branch(self.branch), before)
        self.assertEqual(len(app.require_branch(self.job['result']['branch_id'])['chapters']), 1)


if __name__ == '__main__':
    unittest.main()
