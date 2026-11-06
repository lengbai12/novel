"""Chapter splitting must not turn narrative sentences into headings."""
import unittest

from novel_text import _text_chapters


class HeadingDetectionTests(unittest.TestCase):
    def test_section_sentences_are_not_headings(self):
        text = (
            "第一章 开始\n\n"
            "正文一。\n\n"
            "第一节 课是生物，正是原来班主任的课。\n\n"
            "后续段落。\n\n"
            "第一节 晚自习意外的安静。没有人出来管纪律。\n\n"
            "第一节 课, 陈冲从他们已学内容开始讲。\n\n"
            "第二章 继续\n\n"
            "正文二。"
        )
        chapters = _text_chapters(text)
        self.assertEqual([title for title, _ in chapters], ["第一章 开始", "第二章 继续"])
        self.assertIn("第一节 课是生物", chapters[0][1])
        self.assertIn("第一节 晚自习", chapters[0][1])

    def test_real_section_headings_still_split(self):
        text = (
            "第一章 开始\n\n"
            "正文一。\n\n"
            "第一节 实验课\n\n"
            "实验内容。\n\n"
            "第二节：报告\n\n"
            "报告内容。"
        )
        chapters = _text_chapters(text)
        self.assertEqual(
            [title for title, _ in chapters],
            ["第一章 开始", "第一节 实验课", "第二节：报告"],
        )

    def test_no_separator_sentence_is_not_a_heading(self):
        chapters = _text_chapters("第一章 开始\n\n第一节课是生物，正是原来班主任的课。")
        self.assertEqual([title for title, _ in chapters], ["第一章 开始"])

    def test_english_chapter_heading_still_works(self):
        chapters = _text_chapters("Chapter 1\n\nProse.\n\nChapter 2\n\nMore prose.")
        self.assertEqual([title for title, _ in chapters], ["Chapter 1", "Chapter 2"])


if __name__ == '__main__':
    unittest.main()
