#!/usr/bin/env python3
"""Offline regression tests for tooling; no external network or private credentials."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'Tests/runtime_probe.py'
CONFIGURE = ROOT / 'Scripts/configure.py'
REMOTE = ROOT / 'Tests/live_remote_check.py'
spec = importlib.util.spec_from_file_location('rc5_runtime_probe', RUNTIME)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class Response(io.BytesIO):
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        self.close()


class RemoteTests(unittest.TestCase):
    def test_utf8_bom_codec_and_four_providers(self):
        raw = b'\xef\xbb\xbf' + b'DOMAIN,example.com\n' * 700
        report = ROOT / 'Tests/live-remote-report.json'
        with mock.patch('urllib.request.urlopen', return_value=Response(raw)):
            # A new response object for each request (mock's return_value is closed on exit).
            with mock.patch('urllib.request.urlopen', side_effect=lambda *_args, **_kw: Response(raw)):
                runpy.run_path(str(REMOTE), run_name='__main__')
        saved = json.loads(report.read_text(encoding='utf-8'))['sources']
        self.assertEqual(set(saved), {
            'Repcz-Telegram', 'Repcz-Twitter', 'Repcz-Google', 'Repcz-Ads-AWAvenue'
        })
        self.assertTrue(all(s['status'] == 'PASS' and s['count'] == 700 for s in saved.values()))
        self.assertTrue(all(s['sha256'] == hashlib.sha256(raw).hexdigest() for s in saved.values()))
        report.unlink(missing_ok=True)


class ConfigureTests(unittest.TestCase):
    URL = 'https://subscription.test.example/secret-token-DO-NOT-LEAK'

    def configure(self, target):
        env = dict(os.environ, GLADOS_URL=self.URL)
        return subprocess.run(
            [sys.executable, str(CONFIGURE), '--profile', 'Core.yaml', '--out', str(target)],
            env=env, capture_output=True, text=True, timeout=20,
        )

    def test_existing_public_directory_must_not_be_chmodded(self):
        with tempfile.TemporaryDirectory() as td:
            shared = Path(td) / 'shared'
            shared.mkdir()
            shared.chmod(0o755)
            target = shared / 'Core.private.yaml'
            result = self.configure(target)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(stat.S_IMODE(shared.stat().st_mode), 0o755)
            self.assertFalse(target.exists())
            self.assertNotIn(self.URL, result.stdout + result.stderr)

    def test_existing_private_directory_preserved_and_private_file(self):
        with tempfile.TemporaryDirectory() as td:
            private = Path(td) / 'private'
            private.mkdir(mode=0o700)
            target = private / 'Core.private.yaml'
            result = self.configure(target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertIn(self.URL, target.read_text())
            self.assertNotIn(self.URL, result.stdout + result.stderr)

    def test_new_directory_created_private(self):
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / 'new-private' / 'Core.private.yaml'
            result = self.configure(target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(stat.S_IMODE(target.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)


class ProbeUnitTests(unittest.TestCase):
    def test_nearest_rank_p95(self):
        self.assertEqual(probe.percentile_nearest_rank(list(range(1, 21)), 0.95), 19)
        self.assertEqual(probe.percentile_nearest_rank(list(range(1, 101)), 0.95), 95)
        self.assertEqual(probe.percentile_nearest_rank([2, 5, 9, 11], 1.0), 11)
        self.assertIsNone(probe.percentile_nearest_rank([], 0.95))

    def test_scalar_and_nested_match(self):
        nested = {'outbound': 'US Fixed', 'rule': {'type': 'DOMAIN', 'payload': 'example.com', 'index': 4}, 'evaluatedRules': 5}
        saved = probe.validate_match_response(nested)
        self.assertEqual(saved['rule']['type'], 'DOMAIN')
        self.assertEqual(saved['rule']['index'], 4)
        self.assertEqual(saved['outbound'], 'US Fixed')
        self.assertEqual(probe.validate_match_response({'outbound': 'DIRECT', 'rule': 'MATCH,DIRECT', 'ruleIndex': 3})['outbound'], 'DIRECT')
        stash_37 = {'proxy': 'DIRECT', 'rule': {'type': 'MATCH', 'index': 2}, 'rulesEvaluated': 3}
        saved_37 = probe.validate_match_response(stash_37)
        self.assertEqual(saved_37['outbound'], 'DIRECT')
        self.assertEqual(saved_37['evaluatedRules'], 3)

    def test_missing_outbound_and_index_do_not_pass(self):
        for record in ({'rule': {'type':'DOMAIN', 'index':4}},
                       {'outbound':'DIRECT', 'rule': {'type': 'DOMAIN'}},
                       {'outbound':'DIRECT', 'evaluatedRules': 3},
                       {'proxy':'DIRECT', 'rule': {'type': 'DOMAIN'}},
                       {}):
            with self.subTest(record=record), self.assertRaises(ValueError):
                probe.validate_match_response(record)


class ProbeIntegrationTests(unittest.TestCase):
    @staticmethod
    def fake_api(request, timeout=12, *, bad_match=False, bad_memory=False):
        path = urllib.parse.urlsplit(request.full_url).path
        values = {
            '/version': {'version': 'latest'},
            '/rules/count': {'count': 1238},
            '/diagnosis/usedMemory': {'usedMemory': 10000},
            '/diagnosis/availableMemory': {'availableMemory': 90000},
            '/dns/count': {'count': 12},
            '/providers/rules': {'providers': {'Repcz-Telegram': {}}},
            '/proxies': {'proxies': {'🇺🇸 美国': {'now': 'Fixed-01'}}},
            '/rules/match': {'outbound': 'US Fixed', 'rule': {'type': 'DOMAIN', 'payload': 'example.com', 'index': 4}, 'evaluatedRules': 6},
        }
        if bad_match:
            values['/rules/match'] = {'rule': {'type': 'DOMAIN', 'payload': 'example.com', 'index': 4}}
        if bad_memory:
            values['/diagnosis/usedMemory'] = {'unexpected': 'no metric'}
        return Response(json.dumps(values[path]).encode('utf-8'))

    def run_probe(self, bad_match=False, bad_memory=False, mode='performance'):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'report.json'
            with mock.patch.object(probe.urllib.request, 'urlopen', side_effect=lambda req, timeout=12: self.fake_api(req, timeout, bad_match=bad_match, bad_memory=bad_memory)):
                result = probe.run('http://127.0.0.1:9090', 'fake-token', str(path), 20, mode)
            report = json.loads(path.read_text(encoding='utf-8'))
        return result, report

    def test_good_responses_pass_and_nested_preserved(self):
        code, report = self.run_probe()
        self.assertEqual(code, 0)
        self.assertEqual(report['status'], 'PASS')
        item = report['match']['chatgpt.com']
        self.assertEqual(item['successful_samples'], 20)
        self.assertIsInstance(item['rtt_p95_ms'], float)
        self.assertEqual(item['result']['rule']['index'], 4)
        self.assertEqual(report['failure_reasons'], [])

    def test_missing_outbound_is_not_success(self):
        code, report = self.run_probe(bad_match=True)
        self.assertNotEqual(code, 0)
        self.assertEqual(report['status'], 'FAIL')
        self.assertEqual(report['match']['chatgpt.com']['successful_samples'], 0)
        self.assertIsNone(report['match']['chatgpt.com']['rtt_p95_ms'])
        self.assertNotIn('fake-token', json.dumps(report))

    def test_memory_required_for_performance_not_functional(self):
        code, report = self.run_probe(bad_memory=True)
        self.assertNotEqual(code, 0)
        self.assertEqual(report['status'], 'FAIL')
        self.assertIn('error', report['metrics']['/diagnosis/usedMemory'])
        code2, report2 = self.run_probe(bad_memory=True, mode='functional')
        self.assertEqual(code2, 0)
        self.assertEqual(report2['status'], 'PASS')


if __name__ == '__main__':
    unittest.main(verbosity=2)
