#!/usr/bin/env python3
"""Read-only Stash HTTP API validation and network RTT sampling.

Strict: a successful HTTP response is NOT a successful route match unless the
response includes meaningful outbound/proxy, matched-rule, and match-index data.
RTT is an end-to-end HTTP request RTT, not pure Stash routing engine CPU time.
"""
import argparse
import datetime
import json
import math
import os
from pathlib import Path
import statistics
import sys
import time
import urllib.parse
import urllib.request

HOSTS = [
    'courier.push.apple.com', 'guzzoni.apple.com', 'api.feishu.cn',
    'm.servicewechat.com', 'image.dpfile.com', 'chatgpt.com',
    'events.statsigapi.net', 'claude.ai', 'gemini.google.com', 'grok.com',
    'github.com', 'web.telegram.org', 'x.com', 'youtube.com',
    'apple.com', 'microsoft.com', 'example.org',
]
METRIC_PATHS = [
    '/version', '/rules/count', '/diagnosis/usedMemory',
    '/diagnosis/availableMemory', '/dns/count', '/providers/rules', '/proxies',
]
ROUTING_MANDATORY = {'/rules/count', '/providers/rules', '/proxies'}
PERFORMANCE_MANDATORY = ROUTING_MANDATORY | {'/diagnosis/usedMemory', '/diagnosis/availableMemory'}
RULE_KEYS = ('type', 'ruleType', 'payload', 'content', 'index', 'ruleIndex', 'name', 'value', 'rule')
SUMMARY_KEYS = ('outbound', 'policy', 'rule', 'ruleType', 'ruleIndex', 'evaluatedRules', 'stage')


def percentile_nearest_rank(values, percentile):
    """One-based nearest rank: p95([1..20]) is the 19th observation."""
    if not values:
        return None
    if not 0 < percentile <= 1:
        raise ValueError('percentile must be within (0,1]')
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * percentile) - 1)]


def _safe_str(value):
    return isinstance(value, str) and 0 < len(value.strip()) <= 4096


def _safe_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_match_response(value):
    """Return only safe fields or raise ValueError; fail closed on unknown schemas.

    Stash docs describe rule, outbound and evaluation count but do not publish
    a complete stable JSON schema. Unknown shapes must not silently pass.
    """
    if not isinstance(value, dict):
        raise ValueError('match payload must be an object')

    outbound = value.get('outbound')
    if outbound is None:
        # Stash 3.7 /rules/match has used `proxy` in controller responses.
        outbound = value.get('proxy')
    if isinstance(outbound, dict):
        # Some controller serializers may return a structured outbound.
        if not _safe_str(outbound.get('name')):
            raise ValueError('missing outbound.name')
        clean_outbound = {'name': outbound['name']}
    elif _safe_str(outbound):
        clean_outbound = outbound
    else:
        raise ValueError('missing valid outbound')

    rule = value.get('rule')
    if isinstance(rule, str):
        if not _safe_str(rule):
            raise ValueError('empty matched rule')
        clean_rule = rule
    elif isinstance(rule, dict):
        clean_rule = {}
        for key in RULE_KEYS:
            field = rule.get(key)
            if _safe_str(field) or (_safe_number(field) and len(str(field)) <= 32):
                clean_rule[key] = field
        if not clean_rule:
            raise ValueError('matched rule object has no recognized fields')
    elif _safe_str(value.get('ruleType')):
        clean_rule = {'type': value['ruleType']}
    else:
        raise ValueError('missing matched rule')

    rule_index = value.get('ruleIndex', value.get('index'))
    evaluated = value.get('evaluatedRules', value.get('rulesEvaluated'))
    nested_index = rule.get('index', rule.get('ruleIndex')) if isinstance(rule, dict) else None
    if not (_safe_number(rule_index) and rule_index >= 0 or
            _safe_number(evaluated) and evaluated >= 1 or
            _safe_number(nested_index) and nested_index >= 0):
        raise ValueError('missing valid ruleIndex or evaluatedRules')
    clean = {'outbound': clean_outbound, 'rule': clean_rule}
    for key in ('policy', 'ruleType', 'stage'):
        if _safe_str(value.get(key)):
            clean[key] = value[key]
    if _safe_number(rule_index):
        clean['ruleIndex'] = rule_index
    if _safe_number(evaluated):
        clean['evaluatedRules'] = evaluated
    return clean


def _usable_count(value):
    if _safe_number(value):
        return value >= 0
    if isinstance(value, dict):
        return any(_safe_number(value.get(k)) and value[k] >= 0 for k in ('count', 'total', 'value', 'rulesCount', 'totalRules'))
    return False


def _usable_memory(value):
    if _safe_number(value):
        return value >= 0
    if isinstance(value, str):
        # Response may be formatted like "140 MB".
        return bool(value.strip()) and any(ch.isdigit() for ch in value)
    if isinstance(value, dict):
        for k in ('value', 'bytes', 'size', 'memory', 'usedMemory', 'availableMemory', 'used', 'available'):
            if k in value and _usable_memory(value[k]):
                return True
    return False


def _validate_metric(path, value):
    if path == '/rules/count':
        if not _usable_count(value):
            raise ValueError('invalid rules/count schema')
    elif path in ('/diagnosis/usedMemory', '/diagnosis/availableMemory'):
        if not _usable_memory(value):
            raise ValueError('invalid memory metric schema')
    elif path == '/proxies':
        if not isinstance(value, dict) or not isinstance(value.get('proxies'), dict) or not value['proxies']:
            raise ValueError('missing nonempty proxies map')
    elif path == '/providers/rules':
        if not isinstance(value, (dict, list)):
            raise ValueError('unexpected providers/rules schema')
        if isinstance(value, dict) and 'providers' in value and not isinstance(value['providers'], (dict, list)):
            raise ValueError('invalid providers property')


def _sanitized_metric(path, value):
    if path == '/proxies':
        names = list(value['proxies'].keys())
        return {'group_count': len(names), 'names': names[:150], 'note': 'Proxy server credentials and addresses omitted'}
    if path == '/providers/rules':
        provider = value.get('providers', value) if isinstance(value, dict) else value
        return {'names': list(provider)[:100]}
    # Never save entire diagnostic payloads. Only numeric/text metrics and a few keys.
    if _safe_number(value) or isinstance(value, (str, bool, type(None))):
        return {'value': value if not isinstance(value, str) else value[:160]}
    if isinstance(value, dict):
        safe = {}
        for key in ('count', 'total', 'value', 'rulesCount', 'totalRules', 'bytes', 'size', 'memory', 'usedMemory', 'availableMemory', 'used', 'available'):
            field = value.get(key)
            if _safe_number(field) or (isinstance(field, str) and len(field) <= 160):
                safe[key] = field
        return {'value': safe}
    return {'type': type(value).__name__}


def run(host, token, output, repetitions, mode):
    base = host.rstrip('/')
    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json'}

    def get(path, query=None):
        url = base + path + (('?' + urllib.parse.urlencode(query)) if query else '')
        req = urllib.request.Request(url, headers=headers, method='GET')
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=12) as response:
                body = response.read(4_000_001)
            if len(body) > 4_000_000:
                raise ValueError('API response exceeds 4 MB')
            return {'value': json.loads(body.decode('utf-8')), 'rtt_ms': round((time.perf_counter() - started) * 1000, 3)}
        except Exception as exc:
            # Exclude request URL and headers from report to avoid revealing tokens.
            return {'error': type(exc).__name__, 'rtt_ms': round((time.perf_counter() - started) * 1000, 3)}

    report = {
        'taken_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'host': 'REDACTED', 'api_readonly': True, 'mode': mode,
        'percentile_definition': 'nearest-rank: ceil(p*n), 1-based',
        'notes': 'HTTP RTT includes network and API processing, not isolated match CPU time.',
        'metrics': {}, 'match': {}, 'failure_reasons': [],
    }
    critical = PERFORMANCE_MANDATORY if mode == 'performance' else ROUTING_MANDATORY
    for path in METRIC_PATHS:
        response = get(path)
        if 'error' in response:
            report['metrics'][path] = {'error': response['error']}
            if path in critical:
                report['failure_reasons'].append(path + ': ' + response['error'])
            continue
        try:
            _validate_metric(path, response['value'])
            report['metrics'][path] = _sanitized_metric(path, response['value'])
        except ValueError as exc:
            report['metrics'][path] = {'error': str(exc)}
            if path in critical:
                report['failure_reasons'].append(path + ': ' + str(exc))

    for domain in HOSTS:
        successes = []
        errors = []
        example = None
        for _ in range(repetitions):
            response = get('/rules/match', {'target': domain, 'resolve': 'false', 'network': 'tcp', 'port': 443})
            if 'error' in response:
                errors.append(response['error'])
                continue
            try:
                clean = validate_match_response(response['value'])
            except ValueError as exc:
                errors.append('InvalidResponse: ' + str(exc))
                continue
            successes.append(response['rtt_ms'])
            example = clean
        entry = {
            'http_rtt_ms': successes, 'successful_samples': len(successes),
            'failed_samples': len(errors),
            'rtt_p50_ms': round(statistics.median(successes), 3) if successes else None,
            'rtt_p95_ms': round(percentile_nearest_rank(successes, 0.95), 3) if len(successes) >= 20 else None,
            'result': example, 'errors': errors,
        }
        report['match'][domain] = entry
        required = 20 if mode == 'performance' else 1
        if len(successes) < required:
            report['failure_reasons'].append(f'{domain}: {len(successes)}/{required} valid samples')
        if errors and mode == 'performance':
            report['failure_reasons'].append(f'{domain}: {len(errors)} invalid/failed samples (performance requires all successful)')

    report['status'] = 'FAIL' if report['failure_reasons'] else 'PASS'
    out_path = Path(output).expanduser()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('Saved sanitized Stash probe:', str(out_path), 'domains', len(HOSTS), 'mode', mode, 'status', report['status'])
    if report['failure_reasons']:
        print('FAIL: ' + '; '.join(report['failure_reasons'][:8]), file=sys.stderr)
        return 2
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True, help='http://iphone-ip:9090')
    parser.add_argument('--token-env', default='STASH_TOKEN')
    parser.add_argument('--out', default='runtime-result.json')
    parser.add_argument('--repetitions', type=int, default=20)
    parser.add_argument('--mode', choices=('functional', 'performance'), default='performance', help='performance requires memory metrics and >=20 samples')
    args = parser.parse_args(argv)
    token = os.getenv(args.token_env)
    if not token:
        parser.error('Missing token in environment variable ' + args.token_env)
    parts = urllib.parse.urlsplit(args.host)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password or parts.path not in ('', '/') or parts.query or parts.fragment:
        parser.error('Invalid host; use only http(s)://hostname:port (no credentials/path/query)')
    if not 1 <= args.repetitions <= 200:
        parser.error('1..200 repetitions allowed')
    if args.mode == 'performance' and args.repetitions < 20:
        parser.error('Performance mode requires >=20 repetitions')
    return run(args.host, token, args.out, args.repetitions, args.mode)


if __name__ == '__main__':
    sys.exit(main())
