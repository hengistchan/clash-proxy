#!/usr/bin/env python3
"""Check four mutable Repcz providers against legacy config; use on a connected Mac.
Never loads or prints GLaDOS credentials. Report hashes are computed from fetched bytes.
"""
import datetime
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
obj = yaml.safe_load((ROOT / 'Production.yaml').read_text(encoding='utf-8'))
legacy = yaml.safe_load((ROOT / 'Production-Legacy-v1.3.yaml').read_text(encoding='utf-8'))
EXPECTED_MIN = {
    'Repcz-Telegram': 30,
    'Repcz-Twitter': 20,
    'Repcz-Google': 20,
    'Repcz-Ads-AWAvenue': 500,
}
ALLOWED_TYPES = {
    'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6',
    'IP-ASN', 'PROCESS-NAME', 'PROCESS-PATH', 'DST-PORT', 'SRC-IP-CIDR',
    'SRC-PORT', 'NETWORK', 'GEOSITE', 'GEOIP',
}
result = {}
for name, source in legacy['rule-providers'].items():
    if obj['rule-providers'].get(name) != source:
        print('FAIL: provider changed:', name, file=sys.stderr)
        sys.exit(1)
    try:
        req = urllib.request.Request(source['url'], headers={'User-Agent': 'HJ-Stash-rule-check/1.4'})
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError('rule source exceeded 2 MB limit')
        payload = raw.decode('utf-8-sig')  # Correct Python codec spelling; handles optional UTF-8 BOM.
        lines = [line.strip() for line in payload.splitlines() if line.strip() and not line.lstrip().startswith('#')]
        if len(lines) < EXPECTED_MIN[name]:
            raise ValueError('empty or unexpectedly short rule list')
        malformed = [line for line in lines if line.split(',', 1)[0] not in ALLOWED_TYPES]
        if malformed:
            raise ValueError('unrecognized rule type ' + malformed[0][:60])
        result[name] = {'count': len(lines), 'sha256': hashlib.sha256(raw).hexdigest(), 'status': 'PASS'}
    except Exception as exc:
        result[name] = {'status': 'FAIL', 'error': type(exc).__name__ + ': ' + str(exc)[:150]}
        print('FAIL downloading/parsing', name, type(exc).__name__, file=sys.stderr)
report = ROOT / 'Tests/live-remote-report.json'
report.write_text(json.dumps({'date': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sources': result}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
if any(value['status'] != 'PASS' for value in result.values()):
    sys.exit(2)
