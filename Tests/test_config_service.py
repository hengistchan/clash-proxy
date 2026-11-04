#!/usr/bin/env python3
"""Offline tests for the full-configuration web service."""
import hashlib
from pathlib import Path
import unittest

from fastapi.testclient import TestClient

from service.app import Settings, create_app

ROOT = Path(__file__).resolve().parents[1]
SECRET_URL = 'https://subscription.test.example/api?token=private-value'


class ConfigServiceTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app(Settings(template_dir=ROOT))
        self.client = TestClient(self.app)

    def test_get_api_returns_complete_yaml(self):
        response = self.client.get('/api', params={'url': SECRET_URL})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.headers['content-type'].startswith('application/yaml'))
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertEqual(response.headers['referrer-policy'], 'no-referrer')
        self.assertEqual(response.headers['x-config-sha256'], hashlib.sha256(response.content).hexdigest())
        self.assertIn('attachment; filename="hj-stash-production.yaml"', response.headers['content-disposition'])
        text = response.text
        self.assertIn(SECRET_URL, text)
        self.assertNotIn('example.invalid', text)
        self.assertIn('MATCH,🌐 通用代理', text)

    def test_post_api_supports_no_ads_template(self):
        response = self.client.post('/api', json={'url': SECRET_URL, 'template': 'no_ads'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('filename="hj-stash-no-ads.yaml"', response.headers['content-disposition'])
        self.assertNotIn('Repcz-Ads-AWAvenue', response.text)

    def test_invalid_urls_do_not_echo_secret_input(self):
        cases = [
            'http://secret-subscription.example/path',
            'https://user:password@secret-subscription.example/path',
            'https://example.invalid/placeholder',
            'https://secret-subscription.example/path with spaces',
        ]
        for value in cases:
            with self.subTest(value=value):
                response = self.client.post('/api', json={'url': value})
                self.assertEqual(response.status_code, 400)
                self.assertNotIn(value, response.text)

    def test_unknown_template_is_rejected(self):
        response = self.client.get('/api', params={'url': SECRET_URL, 'template': 'unknown'})
        self.assertEqual(response.status_code, 400)
        self.assertNotIn(SECRET_URL, response.text)

    def test_frontend_security_headers_and_health(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn('Stash Config Forge', response.text)
        self.assertIn("frame-ancestors 'none'", response.headers['content-security-policy'])
        self.assertEqual(response.headers['x-frame-options'], 'DENY')
        health = self.client.get('/api/health')
        self.assertEqual(health.json(), {'status': 'ok', 'service': 'stash-config-forge'})
        self.assertEqual(self.client.get('/api/openapi.json').status_code, 200)
        self.assertEqual(self.client.get('/api/docs').status_code, 404)

    def test_template_alias_is_supported(self):
        response = self.client.get('/api', params={'url': SECRET_URL, 'template': 'Production.yaml'})
        self.assertEqual(response.status_code, 200)
        self.assertIn('hj-stash-production.yaml', response.headers['content-disposition'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
