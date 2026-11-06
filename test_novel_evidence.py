"""Behavioral regressions for branch evidence; no model calls or private config."""
import base64
from pathlib import Path
import tempfile
import unittest

import novel_app as app
from novel_model import DEFAULTS, identity


class EvidenceBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original = (app.DATA, app.SETTINGS_PATH, app.SETTINGS, dict(app.JOBS))
        app.DATA = Path(self.temp.name)
        app.SETTINGS_PATH = app.DATA / "model-settings.json"
        app.SETTINGS = {**DEFAULTS, "api_url": "https://example.invalid/v1"}
        app.initialize()
        app.SETTINGS = {**DEFAULTS, "api_url": "https://example.invalid/v1"}

    def tearDown(self):
        app.DATA, app.SETTINGS_PATH, app.SETTINGS, jobs = self.original
        app.JOBS.clear()
        app.JOBS.update(jobs)
        self.temp.cleanup()

    def book(self, source):
        return app.import_book({"filename": "story.txt", "content_base64": base64.b64encode(source.encode()).decode()})["id"]

    def test_exact_fork_survives_lossy_global_memory(self):
        source = "Chapter 1\n\n" + ("The clerk counted the bags.\n" * 350)
        source += "The iron key remained on the high glass table. The bottle was empty.\n"
        source += "Chapter 2\n\nA FUTURE SECRET MUST NOT ENTER THE BRANCH.\n"
        owner = self.book(source)
        with app.db() as c:
            c.execute("INSERT INTO memories VALUES(?,?,?,?,?)", (owner, 1, 1, 0, "The key was in her pocket. The bottle was full."))
            c.execute("INSERT INTO configured_memory_views VALUES(?,?,?,?,?)", (identity(app.SETTINGS), owner, 1, 0, "The key was in her pocket."))
        evidence = app.evidence_context({}, owner, 1, "key bottle FUTURE SECRET")
        self.assertIn("The iron key remained on the high glass table. The bottle was empty.", evidence)
        self.assertNotIn("A FUTURE SECRET MUST NOT ENTER THE BRANCH", evidence)
        self.assertEqual([row["number"] for row in app.retrieve(owner, 1, "FUTURE SECRET key")], [1])

    def test_full_read_memory_cannot_leak_after_earlier_fork(self):
        owner = self.book("Chapter 1\n\nMara waits.\nChapter 2\n\nMara opens the box.\nChapter 3\n\nThe secret murderer is revealed.\n")
        with app.db() as c:
            for n, text in enumerate(["Mara waits.", "Mara opens the box.", "The secret murderer is revealed."], 1):
                c.execute("INSERT INTO memories VALUES(?,?,?,?,?)", (owner, n, n, 0, text))
            c.execute("INSERT INTO configured_memory_views VALUES(?,?,?,?,?)", (identity(app.SETTINGS), owner, 3, 0, "The secret murderer is revealed."))
        roots = app.memory_roots(owner, 2)
        self.assertEqual([(r["start"], r["end"]) for r in roots], [(1, 1), (2, 2)])
        memory = app.global_memory({}, owner, 2)
        self.assertIn("Mara waits.", memory)
        self.assertIn("Mara opens the box.", memory)
        self.assertNotIn("murderer", memory)

    def test_fork_scene_is_last_not_retrieval_relevance_order(self):
        owner = self.book("Chapter 1\n\nThe porter handed the key to Mara.\nChapter 2\n\nMara locked the shop and left.\n")
        with app.db() as c:
            c.execute("INSERT INTO configured_memory_views VALUES(?,?,?,?,?)", (identity(app.SETTINGS), owner, 2, 0, "The porter owns the key."))
        evidence = app.evidence_context({}, owner, 2, "porter key")
        self.assertLess(evidence.index("The porter handed the key to Mara."), evidence.index("Mara locked the shop and left."))
        self.assertTrue(evidence.rstrip().endswith("Mara locked the shop and left."))

    def test_earlier_passages_keep_object_state_without_distant_prose(self):
        remote = "The orchard workers sang about the harvest. " * 50
        state = "  Mara put the iron key on the glass table.  "
        reaction = "She stepped back and folded her arms."
        source = ("Chapter 1\n\n" + remote + "\n\n" + state + "\n\n" + reaction
                  + "\n\nThe clock struck noon.\n\n" + remote
                  + "\nChapter 2\n\n" + "The rain fell along the empty lane. " * 6 + "Mara stood beside the locked door.\n"
                  + "Chapter 3\n\nThe FUTURE key was destroyed.\n")
        owner = self.book(source)
        with app.db() as c:
            for n in (1, 2):
                c.execute("INSERT INTO memories VALUES(?,?,?,?,?)", (owner, n, n, 0, "Mara carried the key in her pocket."))
        evidence = app.evidence_context({}, owner, 2, "Mara key glass table")
        self.assertIn(state + "\n\n" + reaction, evidence)
        self.assertNotIn("orchard workers", evidence)
        self.assertNotIn("carried the key in her pocket", evidence)
        self.assertNotIn("FUTURE", evidence)
        self.assertTrue(evidence.rstrip().endswith("Mara stood beside the locked door."))

    def test_unselected_distant_memory_remains_background(self):
        owner = self.book("Chapter 1\n\n" + "The sailors raised the sail and watched the waves. " * 5
                          + "\nChapter 2\n\n" + "The room was silent except for the ticking clock. " * 5 + "Mara left the key on the desk.\n"
                          + "Chapter 3\n\n" + "A cold wind blew across the deserted square. " * 5 + "Mara waited outside.\n")
        with app.db() as c:
            for n, memory in enumerate(("A distant voyage remains unfinished.", "The key is in a pocket.", "Mara has gone home."), 1):
                c.execute("INSERT INTO memories VALUES(?,?,?,?,?)", (owner, n, n, 0, memory))
        evidence = app.evidence_context({}, owner, 3, "key desk")
        self.assertIn("A distant voyage remains unfinished.", evidence)
        self.assertNotIn("The key is in a pocket.", evidence)
        self.assertNotIn("Mara has gone home.", evidence)
        self.assertIn("Mara left the key on the desk.", evidence)

    def test_passages_are_exact_chronological_and_byte_bounded(self):
        first = "  林青把钥匙放在桌上。  "
        second = "她关上了门。"
        last = "林青看见钥匙仍在桌上，瓶子已经空了。"
        text = first + "\r\n\r\n" + second + "\r\n\r\n无关的街景。\r\n\r\n" + last
        passages = app.source_passages(text, "林青 钥匙 瓶子", max_bytes=180)
        self.assertTrue(passages)
        self.assertTrue(all(passage in text for passage in passages))
        self.assertEqual([text.index(p) for p in passages], sorted(text.index(p) for p in passages))
        self.assertIn(first + "\r\n\r\n" + second, "\n".join(passages))
        self.assertIn(last, "\n".join(passages))
        self.assertLessEqual(sum(len(p.encode("utf-8")) for p in passages), 180)
        self.assertEqual(app.source_passages("The key stayed here. " * 300, "key", max_bytes=50), [])

    def test_editorial_and_contents_are_not_earlier_scene_evidence(self):
        editorial = "Introduction\n\nMara and the key symbolize the author's argument."
        self.assertEqual(app.source_passages(editorial, "Mara key"), [])
        contents = "Chapter I. Mara and the key\nChapter II. The key vanishes\nChapter III. Mara returns"
        self.assertEqual(app.source_passages(contents, "Mara key"), [])
        self.assertEqual(app.source_passages("The sailors raised the sail.", "Mara key"), [])
        # A narrative sentence beginning with a label-like word is not a preface.
        self.assertIn("Introduction was the name Mara gave the key.",
                      app.source_passages("Introduction was the name Mara gave the key.", "Mara key"))


if __name__ == "__main__":
    unittest.main()
