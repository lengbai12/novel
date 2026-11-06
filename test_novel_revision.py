"""Revision safety: no stale/unknown draft may overwrite published chapters."""
import base64
from pathlib import Path
import tempfile
import unittest

import novel_app as app
from novel_model import DEFAULTS


class RevisionSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = app.DATA, app.SETTINGS_PATH, app.SETTINGS, dict(app.JOBS), set(app.ACTIVE)
        app.DATA = Path(self.tmp.name)
        app.SETTINGS_PATH = app.DATA / 'settings.json'
        app.initialize()
        app.SETTINGS = dict(DEFAULTS)
        app.ACTIVE.clear()
        self.book = app.import_book({'filename':'story.txt','content_base64':base64.b64encode(b'Chapter 1\n\nMara waited.').decode()})['id']
        self.branch = 'revision-branch'
        with app.db() as c:
            c.execute('INSERT INTO branches VALUES(?,?,?,?,?,?,?,?,?)',(self.branch,self.book,'Branch',1,'Goal','Style',800,'Plan','now'))
        app.JOBS['failed'] = {'id':'failed','status':'error','branch_id':self.branch,'draft':'Draft text','draft_chapter':1}

    def tearDown(self):
        app.DATA,app.SETTINGS_PATH,app.SETTINGS,jobs,active=self.old
        app.JOBS.clear();app.JOBS.update(jobs)
        app.ACTIVE.clear();app.ACTIVE.update(active)
        self.tmp.cleanup()

    def test_published_target_cannot_be_revised(self):
        with app.db() as c:
            c.execute('INSERT INTO branch_chapters VALUES(?,?,?,?,?,?)',(self.branch,1,'Title','Published chapter','Memory','[]'))
        with self.assertRaises(app.Conflict):
            app._revision_request('failed',{'feedback':'Change the scene.'})
        with app.db() as c:
            self.assertEqual(c.execute('SELECT text FROM branch_chapters WHERE branch_id=?',(self.branch,)).fetchone()[0],'Published chapter')

    def test_running_draft_cannot_be_revised(self):
        app.JOBS['failed']['status']='running'
        with self.assertRaises(app.Conflict):app._revision_request('failed',{'feedback':'Change it.'})

    def test_legacy_draft_requires_explicit_chapter(self):
        app.JOBS['failed'].pop('draft_chapter')
        with self.assertRaises(app.Conflict):app._revision_request('failed',{'feedback':'Change it.'})

    def test_feedback_cannot_be_empty(self):
        with self.assertRaises(ValueError):app._revision_request('failed',{'feedback':'  '})


if __name__ == '__main__':unittest.main()
