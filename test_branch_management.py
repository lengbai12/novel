"""Branch fork descriptions, renaming and safe deletion."""
import base64
from pathlib import Path
import tempfile
import unittest

import novel_app as app


class BranchManagementTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = app.DATA, app.SETTINGS_PATH, app.SETTINGS, dict(app.JOBS), set(app.ACTIVE)
        app.DATA = Path(self.tmp.name)
        app.SETTINGS_PATH = app.DATA / 'settings.json'
        app.initialize()
        app.ACTIVE.clear()
        self.book = app.import_book({'filename': 'story.txt', 'content_base64': base64.b64encode(b'Chapter 1\n\nMara waited by the gate.').decode()})['id']
        self.branch = 'route'
        with app.db() as c:
            c.execute('INSERT INTO branches VALUES(?,?,?,?,?,?,?,?,?)', (self.branch, self.book, 'Original route', 1, 'Goal', 'Style', 800, 'Plan', 'now'))
            for n in (1, 2):
                c.execute('INSERT INTO branch_chapters VALUES(?,?,?,?,?,?)', (self.branch, n, f'Title {n}', f'Prose {n}', f'Memory {n}', '[]'))
                c.execute('INSERT INTO branch_memories VALUES(?,?,?,?,?)', (self.branch, n, n, 0, f'Memory {n}'))
            c.execute('INSERT INTO branch_memories VALUES(?,?,?,?,?)', (self.branch, 1, 2, 1, 'Parent summary'))
            c.execute('INSERT INTO configured_memory_views VALUES(?,?,?,?,?)', ('identity', self.branch, 2, 1, 'Cached view'))

    def tearDown(self):
        app.DATA, app.SETTINGS_PATH, app.SETTINGS, jobs, active = self.old
        app.JOBS.clear(); app.JOBS.update(jobs)
        app.ACTIVE.clear(); app.ACTIVE.update(active)
        self.tmp.cleanup()

    def test_details_show_original_fork_chapter_and_tail(self):
        details = app.branch_details(self.branch)
        self.assertEqual(details['fork_title'], 'Chapter 1')
        self.assertEqual(details['book_title'], 'story')
        self.assertIn('Mara waited by the gate.', details['fork_excerpt'])

    def test_rename_keeps_history_and_shows_in_book_list(self):
        result = app.rename_branch(self.branch, {'title': '  新名字  '})
        self.assertEqual(result['title'], '新名字')
        self.assertEqual(app.require_branch(self.branch)['title'], '新名字')
        self.assertEqual(app.book_info(self.book)['branches'][0]['fork_title'], 'Chapter 1')

    def test_removing_last_chapter_clears_stale_summaries(self):
        result = app.delete_last_chapter(self.branch)
        self.assertEqual(result['removed'], 2)
        branch = app.require_branch(self.branch)
        self.assertEqual([chapter['number'] for chapter in branch['chapters']], [1])
        with app.db() as c:
            memories = c.execute('SELECT start,end,level FROM branch_memories WHERE branch_id=?', (self.branch,)).fetchall()
            views = c.execute('SELECT count(*) FROM configured_memory_views WHERE owner=?', (self.branch,)).fetchone()[0]
        self.assertEqual([tuple(row) for row in memories], [(1, 1, 0)])
        self.assertEqual(views, 0)

    def test_removing_chapter_is_rejected_while_generating(self):
        app.ACTIVE.add('active-job')
        app.JOBS['active-job'] = {'id': 'active-job', 'branch_id': self.branch}
        with self.assertRaises(app.Conflict):
            app.delete_last_chapter(self.branch)
        with self.assertRaises(app.Conflict):
            app.rename_branch(self.branch, {'title': 'blocked'})
        self.assertEqual(len(app.require_branch(self.branch)['chapters']), 2)

    def test_deleting_branch_removes_children_but_not_book(self):
        result = app.delete_branch(self.branch)
        self.assertEqual(result['book_id'], self.book)
        with self.assertRaises(KeyError):
            app.require_branch(self.branch)
        with app.db() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM branch_chapters WHERE branch_id=?', (self.branch,)).fetchone()[0], 0)
            self.assertEqual(c.execute('SELECT count(*) FROM branch_memories WHERE branch_id=?', (self.branch,)).fetchone()[0], 0)
            self.assertEqual(c.execute('SELECT count(*) FROM configured_memory_views WHERE owner=?', (self.branch,)).fetchone()[0], 0)
        self.assertEqual(app.require_book(self.book)['title'], 'story')


if __name__ == '__main__':
    unittest.main()
