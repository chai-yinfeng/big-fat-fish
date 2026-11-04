import unittest
from pathlib import Path
import numpy as np

from providers import energy_trim, normalize_providers, pcm16_array, pcm16_bytes, resample_linear


class ProviderHelpersTest(unittest.TestCase):
    def test_resample_changes_length_and_preserves_signal(self):
        source = (np.sin(np.linspace(0, 2 * np.pi * 440, 4800, dtype=np.float32)) * 0.2).astype(np.float32)
        output = resample_linear(source, 48000, 16000)
        self.assertEqual(output.size, 1600)
        self.assertAlmostEqual(float(np.max(np.abs(output))), 0.2, places=1)

    def test_pcm16_roundtrip(self):
        samples = np.array([0.0, 0.5, -0.5, 1.0, -1.0], dtype=np.float32)
        restored = pcm16_array(pcm16_bytes(samples))
        self.assertEqual(restored.size, samples.size)
        self.assertAlmostEqual(float(restored[1]), 0.5, places=2)

    def test_energy_trim_removes_leading_and_trailing_silence(self):
        silence = np.zeros(16000, dtype=np.float32)
        tone = (np.sin(np.linspace(0, 2 * np.pi * 200, 16000)) * 0.3).astype(np.float32)
        trimmed = energy_trim(np.concatenate([silence, tone, silence]))
        self.assertLess(trimmed.size, 48000)
        self.assertGreater(trimmed.size, 12000)

    def test_energy_trim_returns_empty_for_silence(self):
        self.assertEqual(energy_trim(np.zeros(16000, dtype=np.float32)).size, 0)

    def test_normalize_providers_preserves_order_and_drops_duplicates(self):
        self.assertEqual(normalize_providers(["sensevoice", "qwen3", "sensevoice"]), ["sensevoice", "qwen3"])
        self.assertEqual(normalize_providers([], "auto"), [])
        self.assertEqual(normalize_providers(None, "local"), ["sensevoice"])
        self.assertEqual(normalize_providers(None, "cloud"), ["qwen3"])


if __name__ == "__main__":
    unittest.main()
