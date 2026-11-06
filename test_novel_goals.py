"""Deterministic chapter-goal extraction preserves the authoritative premise."""
import unittest

from novel_goals import chapter_goals


class ChapterGoalsTests(unittest.TestCase):
    def assert_lossless(self, premise, result):
        self.assertEqual(
            result["common"] + "".join(segment["text"] for segment in result["segments"]),
            premise,
        )

    def test_english_current_and_other_are_exact_spans(self):
        common = "Keep the original voice.\n\n"
        first = "Chapter 1: Secure the door. Show the obstacle. "
        second = "Chapter 2: Reach the garden and track the key. Invent events freely."
        premise = common + first + second
        result = chapter_goals(premise, 1)
        self.assertEqual(result["common"], common)
        self.assertEqual(result["current"], first)
        self.assertEqual(result["other"], [{"number": 2, "text": second}])
        self.assert_lossless(premise, result)

    def test_chinese_inline_headings_keep_trailing_constraints(self):
        first = "第一章：阿Q找小D共同保管并约定作证。"
        second = "第二章：二人向酒店掌柜当面交付线索。可以创造劫物。保留阿Q自欺和怕吃亏。"
        premise = first + second
        result = chapter_goals(premise, 2)
        self.assertEqual(result["current"], second)
        self.assertEqual(result["other"], [{"number": 1, "text": first}])
        # The first-stage view retains the whole second span without claiming
        # that its shared constraints are future-only or optional.
        first_stage = chapter_goals(premise, 1)
        self.assertEqual(first_stage["other"][0]["text"], second)
        self.assert_lossless(premise, result)

    def test_chinese_goal_headings_preserve_numbered_rules(self):
        first = "第一章目标：实际留下并保管记录。\n\n"
        second = (
            "第二章目标: 让办案人实际接触记录。\n\n"
            "硬约束（first=第一章，continuation=第二章，both=两章）：\n"
            "C1 [first] 首章实际完成记录。\n"
            "C2 [both] 阿Q仍不识字。\n"
            "C3 [continuation] 记录改变处置。"
        )
        premise = first + second
        result = chapter_goals(premise, 2)
        self.assertEqual(result["current"], second)
        self.assertEqual(len(result["segments"]), 2)
        self.assert_lossless(premise, result)

    def test_unnumbered_premise_is_unchanged_common_text(self):
        premise = "  Keep the voice.\n先留下凭据，再交付掌柜。\n"
        result = chapter_goals(premise, 1)
        self.assertEqual(result, {
            "common": premise, "current": "", "other": [], "segments": [],
        })
        self.assert_lossless(premise, result)

    def test_reused_goals_extract_current_stage_without_future_leak(self):
        premise = "Chapter 1: Discover the clue. Chapter 2: Hand it over."
        first = chapter_goals(premise, 1)
        second = chapter_goals(premise, 2)
        self.assertEqual(first["current"], "Chapter 1: Discover the clue. ")
        self.assertEqual(second["current"], "Chapter 2: Hand it over.")
        self.assertNotIn("Hand it over", first["current"])
        self.assertNotIn("Discover the clue", second["current"])
        self.assertEqual(chapter_goals(premise, 1), first)
        self.assertEqual(chapter_goals(premise, 3)["current"], "")
        self.assert_lossless(premise, first)
        self.assert_lossless(premise, second)

    def test_collects_repeated_numbered_clauses_in_order(self):
        premise = "Chapter 1: Find it. Chapter 2: Deliver it. Chapter 1: Keep a witness."
        result = chapter_goals(premise, 1)
        self.assertEqual(result["current"], "Chapter 1: Find it. Chapter 1: Keep a witness.")
        self.assertEqual(result["other"], [{"number": 2, "text": "Chapter 2: Deliver it. "}])
        self.assert_lossless(premise, result)

    def test_multiple_digit_and_chinese_numbers(self):
        premise = "chapter 12: Twelve. 第十三章目标：十三。第20章：二十。"
        for number, text in ((12, "chapter 12: Twelve. "), (13, "第十三章目标：十三。"), (20, "第20章：二十。")):
            with self.subTest(number=number):
                result = chapter_goals(premise, number)
                self.assertEqual(result["current"], text)
                self.assert_lossless(premise, result)


if __name__ == "__main__":
    unittest.main()
