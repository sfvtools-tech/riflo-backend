#!/usr/bin/env python3
import importlib.util
import json
import io
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('payload', Path(__file__).with_name('build-runtime-payload.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PayloadTests(unittest.TestCase):
    def setUp(self):
        self.environment = {module.PREFIX + name: 'configured' for name in module.REQUIRED}

    def test_roundtrip_and_explicit_optional_defaults(self):
        value = 'quotes" backslash\\ dollars$ unicode हिन्दी'
        self.environment.update(RIFLO_CONFIG_ANTHROPIC_API_KEY=value,
                                RIFLO_CONFIG_TRIAL_ABUSE_HMAC_KEY='', UNRELATED_SECRET='hidden')
        result = module.payload(self.environment)
        self.assertEqual(result.count('\n'), 1)
        values = json.loads(result)['values']
        self.assertEqual(values['ANTHROPIC_API_KEY'], value)
        self.assertEqual(values['TRIAL_ABUSE_HMAC_KEY'], '')
        self.assertEqual(set(values), module.contract.CONFIG_KEYS)
        self.assertNotIn('UNRELATED_SECRET', values)
        self.assertEqual(module.contract.read_config(io.BytesIO(result.encode())), values)

    def test_optional_removal_reaches_helper(self):
        result = module.payload(self.environment)
        values = module.contract.read_config(io.BytesIO(result.encode()))
        updated = module.contract.environment_text('NODE_ENV=production\nANTHROPIC_INPUT_MICROS_PER_MILLION=123\n', values)
        self.assertIn('NODE_ENV=production', updated)
        self.assertNotIn('ANTHROPIC_INPUT_MICROS_PER_MILLION', updated)

    def test_unknown_setting_fails(self):
        self.environment['RIFLO_CONFIG_NODE_OPTIONS'] = 'unapproved'
        with self.assertRaises(ValueError):
            module.payload(self.environment)

    def test_missing_settings_fail_without_values(self):
        del self.environment['RIFLO_CONFIG_DEEPGRAM_API_KEY']
        with self.assertRaisesRegex(ValueError, '^Missing repository settings: DEEPGRAM_API_KEY$'):
            module.payload(self.environment)

    def test_invalid_values_never_echo_value(self):
        for value in ['sensitive\nvalue', 'sensitive\rvalue', 'sensitive\x00value', 'x' * 16385]:
            self.environment['RIFLO_CONFIG_ANTHROPIC_API_KEY'] = value
            with self.assertRaisesRegex(ValueError, '^Invalid repository setting: ANTHROPIC_API_KEY$'):
                module.payload(self.environment)


if __name__ == '__main__':
    unittest.main()
