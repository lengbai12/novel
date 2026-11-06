"""Provider-specific payloads without network calls or secrets."""
import unittest

from novel_model import (DEFAULTS, api_key, completion_payload, provider, provider_context,
                         public_settings, request, validate)


def settings(**values):
    return {**DEFAULTS, **values}


class CompletionBudgetTests(unittest.TestCase):
    def test_thinking_does_not_consume_reserved_final_answer(self):
        for url in ("http://127.0.0.1:8000/v1", "https://api.siliconflow.cn/v1",
                    "https://api.deepseek.com/v1", "https://example.invalid/v1"):
            current = settings(api_url=url, reasoning_effort="low")
            payload = completion_payload(current, [{"role": "user", "content": "Write the scene."}], 2200, .6, None)
            self.assertGreaterEqual(payload["max_tokens"] - 2048, 2200)

    def test_disabled_thinking_reserves_only_final_answer(self):
        payload = completion_payload(settings(reasoning_effort="none"), [], 2200, .6, None)
        self.assertEqual(payload["max_tokens"], 2200)


class ProviderTests(unittest.TestCase):
    def test_explicit_preset_overrides_host_detection(self):
        current = settings(provider="deepseek", api_url="http://127.0.0.1:9000/v1")
        self.assertEqual(provider(current), "deepseek")
        self.assertEqual(provider_context(current), 1048576)

    def test_auto_detects_deepseek_host(self):
        self.assertEqual(provider(settings(api_url="https://api.deepseek.com/v1")), "deepseek")

    def test_invalid_provider_is_rejected(self):
        with self.assertRaises(ValueError):
            validate({"provider": "unknown"}, DEFAULTS)

    def test_deepseek_maps_effort_and_json_mode(self):
        current = settings(provider="deepseek", api_url="https://api.deepseek.com/v1",
                           model="deepseek-flash", reasoning_effort="high")
        schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}}
        payload = completion_payload(current, [{"role": "system", "content": "Return JSON."},
                                               {"role": "user", "content": "Check."}], 2200, .6, schema)
        self.assertEqual(payload["thinking"], {"type": "enabled"})
        self.assertEqual(payload["reasoning_effort"], "max")
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertIn("JSON Schema", payload["messages"][0]["content"])
        self.assertNotIn("temperature", payload)
        self.assertNotIn("presence_penalty", payload)
        self.assertEqual(payload["max_tokens"], 2200 + 8192)

    def test_deepseek_can_disable_thinking_for_final_prose(self):
        current = settings(provider="deepseek", api_url="https://api.deepseek.com/v1",
                           model="deepseek-flash", reasoning_effort="none")
        payload = completion_payload(current, [{"role": "user", "content": "Write."}], 2200, .6, None)
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertNotIn("reasoning_effort", payload)
        self.assertNotIn("response_format", payload)
        self.assertEqual(payload["temperature"], .6)

    def test_generic_omits_unsupported_disabled_reasoning(self):
        current = settings(provider="openai", api_url="https://gateway.invalid/v1",
                           reasoning_effort="none")
        payload = completion_payload(current, [{"role": "user", "content": "Write."}], 1200, .5, None)
        self.assertNotIn("reasoning_effort", payload)
        self.assertNotIn("thinking", payload)

    def test_key_is_not_sent_to_another_vendor(self):
        current = settings(provider="deepseek", api_url="https://api.deepseek.com/v1",
                           api_key="sk-saved-for-siliconflow", api_key_provider="siliconflow")
        self.assertEqual(api_key(current), "")
        self.assertIsNone(request(current, "/models").headers.get("Authorization"))
        self.assertFalse(public_settings(current)["has_api_key"])

    def test_key_is_sent_to_its_own_vendor(self):
        current = settings(provider="deepseek", api_url="https://api.deepseek.com/v1",
                           api_key="sk-deepseek", api_key_provider="deepseek")
        self.assertEqual(request(current, "/models").headers.get("Authorization"), "Bearer sk-deepseek")
        self.assertTrue(public_settings(current)["has_api_key"])

    def test_saving_a_key_records_its_interface(self):
        current = settings(provider="deepseek", api_url="https://api.deepseek.com/v1")
        saved = validate({"api_key": "sk-deepseek"}, current)
        self.assertEqual(saved["api_key_provider"], "deepseek")
        cleared = validate({"clear_api_key": True}, saved)
        self.assertEqual((cleared["api_key"], cleared["api_key_provider"]), ("", ""))


if __name__ == "__main__":
    unittest.main()
