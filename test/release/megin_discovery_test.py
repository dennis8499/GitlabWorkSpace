"""Imported fixture classes must not silently duplicate the hardening suite."""
import json
from pathlib import Path
import subprocess
import sys
import unittest


class MeginDiscoveryTests(unittest.TestCase):
    def test_discovery_contains_every_unique_case_once(self):
        root = Path(__file__).resolve().parents[2]
        script = """import json,unittest
suite=unittest.defaultTestLoader.discover('test/overlays/megin/tests/group-workspace',pattern='test_*.py')
def cases(suite):
    for item in suite:
        if isinstance(item,unittest.TestSuite): yield from cases(item)
        else: yield item.id()
print(json.dumps(list(cases(suite))))
"""
        result = subprocess.run([sys.executable, '-X', 'utf8', '-B', '-c', script], cwd=root,
                                capture_output=True, text=True, encoding='utf-8', check=True)
        ids = json.loads(result.stdout)
        self.assertEqual(56, len(ids))
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(32, sum('.WorkspaceHardeningTests.' in case for case in ids))
        self.assertEqual(8, sum('.GitLabDeliveryTests.' in case for case in ids))
        self.assertEqual(16, sum('.GroupWorkflowTests.' in case for case in ids))


if __name__ == '__main__':
    unittest.main(verbosity=2)
