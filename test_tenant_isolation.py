"""Visitor storage must be isolated by signed tenant cookie."""
import base64
from pathlib import Path
import tempfile
import unittest

import novel_app as app


class TenantIsolationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = app.DATA, app.SETTINGS_PATH, app.SETTINGS, dict(app.JOBS), set(app.ACTIVE)
        app.DATA = Path(self.tmp.name)
        app.SETTINGS_PATH = app.DATA / "settings.json"
        app.initialize()
        self.a = "a" * 32
        self.b = "b" * 32
        app.ensure_tenant(self.a)
        app.ensure_tenant(self.b)

    def tearDown(self):
        app.MODEL_CONTEXT.tenant = app.OWNER_TENANT
        app.DATA, app.SETTINGS_PATH, app.SETTINGS, jobs, active = self.old
        app.JOBS.clear(); app.JOBS.update(jobs)
        app.ACTIVE.clear(); app.ACTIVE.update(active)
        self.tmp.cleanup()

    def test_imported_books_do_not_leak_between_visitors(self):
        content = "第一章 开端\n\n正文。\n\n第二章 继续\n\n正文。".encode()
        values = {"filename": "隔离测试.txt", "content_base64": base64.b64encode(content).decode()}
        app.MODEL_CONTEXT.tenant = self.a
        book = app.import_book(values)
        with app.db() as c:
            self.assertEqual(c.execute("SELECT count(*) FROM books").fetchone()[0], 1)
            self.assertEqual(c.execute("SELECT count(*) FROM chapters").fetchone()[0], 2)
        app.MODEL_CONTEXT.tenant = self.b
        with app.db() as c:
            self.assertEqual(c.execute("SELECT count(*) FROM books").fetchone()[0], 0)
        with self.assertRaises(KeyError):
            app.book_info(book["id"])
        app.MODEL_CONTEXT.tenant = self.a
        self.assertEqual(app.book_info(book["id"])["chapter_count"], 2)

    def test_branches_do_not_leak_between_visitors(self):
        content = "第一章 开端\n\n正文。".encode()
        values = {"filename": "支线隔离.txt", "content_base64": base64.b64encode(content).decode()}
        app.MODEL_CONTEXT.tenant = self.a
        book = app.import_book(values)
        branch_id = "branch-isolation"
        with app.db() as c:
            c.execute("INSERT INTO branches VALUES(?,?,?,?,?,?,?,?,?)",
                      (branch_id, book["id"], "隔离支线", 1, "改写", "延续", 1200, "大纲", "2026-01-01 00:00:00"))
        self.assertEqual(app.branch_details(branch_id)["id"], branch_id)
        app.MODEL_CONTEXT.tenant = self.b
        with self.assertRaises(KeyError):
            app.branch_details(branch_id)
        with app.db() as c:
            self.assertEqual(c.execute("SELECT count(*) FROM branches").fetchone()[0], 0)

    def test_cookie_signature_rejects_tampering(self):
        signature = app.sign_tenant(self.a)
        self.assertNotEqual(signature, app.sign_tenant(self.b))
        self.assertNotEqual(signature, "0" * len(signature))


if __name__ == "__main__":
    unittest.main()
