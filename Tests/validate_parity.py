#!/usr/bin/env python3
"""Validate source coverage, module independence, and first-match semantics.

This is an offline static contract. It uses representative fixtures for mutable
remote providers; it does not prove HTTP reachability or Stash runtime behavior.
"""
from pathlib import Path
import copy
import hashlib
import ipaddress
import json
import re
import sys
import yaml

ROOT = Path(__file__).resolve().parents[1]
base = yaml.safe_load((ROOT / 'Sources/v13-normalized-for-audit.yaml').read_text(encoding='utf8'))
prod = yaml.safe_load((ROOT / 'Production.yaml').read_text(encoding='utf8'))
prod_noads = yaml.safe_load((ROOT / 'Production-NoAds.yaml').read_text(encoding='utf8'))
core = yaml.safe_load((ROOT / 'Core.yaml').read_text(encoding='utf8'))
legacy = yaml.safe_load((ROOT / 'Production-Legacy-v1.3.yaml').read_text(encoding='utf8'))
manifest = json.loads((ROOT / 'source-manifest.json').read_text(encoding='utf8'))
modules = {
    name: yaml.safe_load((ROOT / 'Overrides' / name).read_text(encoding='utf8'))
    for name in manifest['override_order_top_to_bottom']
}

checks = 0
errors = []


def check(condition, message):
    global checks
    checks += 1
    if not condition:
        errors.append(message)


def rule_refs(rule):
    return set(re.findall(r'RULE-SET,([^,()]+)', rule))


def split_top_level(text):
    parts = []
    depth = 0
    start = 0
    for index, char in enumerate(text):
        if char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
            if depth < 0:
                raise ValueError('unbalanced rule expression: ' + text)
        elif char == ',' and depth == 0:
            parts.append(text[start:index].strip())
            start = index + 1
    if depth != 0:
        raise ValueError('unbalanced rule expression: ' + text)
    parts.append(text[start:].strip())
    return parts


def unwrap_group(text):
    text = text.strip()
    if not (text.startswith('(') and text.endswith(')')):
        raise ValueError('expected parenthesized rule group: ' + text)
    return text[1:-1].strip()


def domain_match(pattern, target):
    pattern = pattern.lower().rstrip('.')
    target = target.lower().rstrip('.')
    if pattern.startswith('+.'):
        suffix = pattern[2:]
        return target == suffix or target.endswith('.' + suffix)
    return pattern == target


def domain_rule_match(rule, target):
    parts = rule.split(',')
    kind = parts[0].upper()
    value = parts[1].lower().rstrip('.')
    host = target.lower().rstrip('.')
    if kind == 'DOMAIN':
        return host == value
    if kind == 'DOMAIN-SUFFIX':
        return host == value or host.endswith('.' + value)
    if kind == 'DOMAIN-KEYWORD':
        return value in host
    return False


def ip_rule_match(rule, target):
    parts = rule.split(',')
    if parts[0] not in ('IP-CIDR', 'IP-CIDR6'):
        return False
    try:
        return ipaddress.ip_address(target) in ipaddress.ip_network(parts[1], strict=False)
    except ValueError:
        return False


def provider_rule_match(rule, target, obj, remote_fixtures):
    try:
        ipaddress.ip_address(target)
        is_ip = True
    except ValueError:
        is_ip = False
    if is_ip:
        return ip_rule_match(rule, target)
    return domain_rule_match(rule, target)


def atom_match(parts, target, obj, remote_fixtures):
    kind = parts[0].upper()
    try:
        ipaddress.ip_address(target)
        is_ip = True
    except ValueError:
        is_ip = False
    if kind == 'MATCH':
        return True
    if kind == 'DOMAIN' and not is_ip:
        return target.lower().rstrip('.') == parts[1].lower().rstrip('.')
    if kind == 'DOMAIN-SUFFIX' and not is_ip:
        value = parts[1].lower().rstrip('.')
        host = target.lower().rstrip('.')
        return host == value or host.endswith('.' + value)
    if kind == 'DOMAIN-KEYWORD' and not is_ip:
        return parts[1].lower() in target.lower()
    if kind in ('IP-CIDR', 'IP-CIDR6') and is_ip:
        return ip_rule_match(','.join(parts), target)
    if kind != 'RULE-SET':
        return False

    provider_name = parts[1]
    if provider_name not in obj['rule-providers']:
        raise KeyError('undefined rule provider: ' + provider_name)
    provider = obj['rule-providers'][provider_name]
    if provider.get('type') == 'inline':
        if is_ip and provider.get('behavior') == 'ipcidr':
            address = ipaddress.ip_address(target)
            return any(address in ipaddress.ip_network(item, strict=False) for item in provider['payload'])
        if not is_ip and provider.get('behavior') == 'domain':
            return any(domain_match(item, target) for item in provider['payload'])
        return False

    source = remote_sources_by_url.get(provider.get('url'))
    if source is None:
        raise KeyError('remote provider has no offline fixture: ' + provider_name)
    return any(provider_rule_match(rule, target, obj, remote_fixtures) for rule in remote_fixtures[source])


def evaluate_expression(parts, target, obj, remote_fixtures):
    operator = parts[0].upper()
    if operator not in ('AND', 'OR', 'NOT'):
        return atom_match(parts, target, obj, remote_fixtures)
    group = unwrap_group(parts[1])
    conditions = split_top_level(group) if group else []
    values = []
    for condition in conditions:
        inner = unwrap_group(condition)
        values.append(evaluate_expression(split_top_level(inner), target, obj, remote_fixtures))
    if operator == 'AND':
        return all(values)
    if operator == 'OR':
        return any(values)
    if len(values) != 1:
        raise ValueError('NOT must contain exactly one condition')
    return not values[0]


def policy_index(parts):
    if parts[0].upper() == 'MATCH':
        return 1
    if len(parts) > 3 and parts[-1] == 'no-resolve':
        return len(parts) - 2
    return 2


def find_policy(obj, target, remote_fixtures):
    for rule in obj['rules']:
        parts = split_top_level(rule)
        if evaluate_expression(parts, target, obj, remote_fixtures):
            return parts[policy_index(parts)]
    return 'NO_MATCH'


def compose(order):
    rules = list(core['rules'])
    providers = copy.deepcopy(core['rule-providers'])
    for filename in order:
        module = modules[filename]
        rules = list(module['rules']) + rules
        for provider_name, provider in module['rule-providers'].items():
            if provider_name in providers:
                raise AssertionError('duplicate provider while composing: ' + provider_name)
            providers[provider_name] = copy.deepcopy(provider)
    return {'rules': rules, 'rule-providers': providers}


remote_fixtures = {
    'Repcz-Ads-AWAvenue': [
        'DOMAIN-SUFFIX,doubleclick.net',
        'DOMAIN-SUFFIX,ad.qq.com',
        'DOMAIN-SUFFIX,ads.youtube.com',
        'DOMAIN-SUFFIX,static.ads-twitter.com',
        'DOMAIN-SUFFIX,ads-api.twitter.com',
        'DOMAIN,api.mixpanel.com',
        'DOMAIN-SUFFIX,adservice.google.com',
        'DOMAIN-SUFFIX,crashlyticsreports-pa.googleapis.com',
        'DOMAIN-SUFFIX,outlookads.live.com',
        'DOMAIN-SUFFIX,statsigapi.net',
    ],
    'Repcz-Telegram': [
        'DOMAIN,api.mixpanel.com',
        'DOMAIN-KEYWORD,telegram',
        'DOMAIN-SUFFIX,telegram.org',
        'DOMAIN-SUFFIX,t.me',
    ],
    'Repcz-Twitter': [
        'DOMAIN-SUFFIX,ads-twitter.com',
        'DOMAIN-SUFFIX,twitter.com',
        'DOMAIN-SUFFIX,twimg.com',
        'DOMAIN-SUFFIX,x.com',
    ],
    'Repcz-Google': [
        'DOMAIN-KEYWORD,google',
        'DOMAIN-SUFFIX,google.com',
        'DOMAIN-SUFFIX,googleapis.com',
        'DOMAIN-SUFFIX,gstatic.com',
        'DOMAIN-SUFFIX,youtube.com',
        'DOMAIN-SUFFIX,ytimg.com',
        'DOMAIN-SUFFIX,app-measurement.net',
    ],
}
remote_sources_by_url = {
    provider['url']: name for name, provider in base['rule-providers'].items()
}

# Source provenance and the untouched rollback profile.
check(base == legacy, 'Legacy copy diverges from the v1.3 baseline')
check(len(base['rules']) == 150, 'Baseline must have 150 explicit entries')
source = ROOT / 'Sources/v1.3-original-user-markdown.md'
check(
    hashlib.sha256(source.read_bytes()).hexdigest() == manifest['origin_sha256'],
    'Original Markdown SHA256 mismatch',
)
rule_kinds = r'DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|IP-CIDR|IP-CIDR6|RULE-SET|PROTOCOL|GEOSITE|GEOIP|MATCH'
extracted = []
for line in source.read_text(encoding='utf8').splitlines():
    if re.match(r'^-\s+(?:' + rule_kinds + r'),', line):
        extracted.append(re.sub(r'\\$', '', line.strip()[2:].strip()).replace('\\.', '.').strip())
check(extracted == base['rules'], 'Original Markdown 150-record sequence differs from normalized source')
check(base['proxy-groups'] == prod['proxy-groups'] == core['proxy-groups'], 'All original 13 groups intact')
check(base['dns'] == prod['dns'] == core['dns'], 'DNS baseline intact')
check(base['proxy-providers'] == prod['proxy-providers'], 'Proxy provider config intact (no private URL)')
check(
    set(base['rule-providers']) == {'Repcz-Telegram', 'Repcz-Twitter', 'Repcz-Google', 'Repcz-Ads-AWAvenue'},
    'Original 4 remote provider names unchanged',
)
for provider_name, provider in base['rule-providers'].items():
    check(
        prod['rule-providers'].get(provider_name) == provider,
        'Original remote provider config changed: ' + provider_name,
    )
    check(provider['behavior'] == 'classical' and provider['format'] == 'text', 'Remote provider mode changed: ' + provider_name)
    check(
        provider['url'].startswith('https://raw.githubusercontent.com/Repcz/Tool/X/Stash/Rules/'),
        'Remote provider origin changed: ' + provider_name,
    )

# Indexed local providers must still exactly represent their source slices.
for provider_name, original_rules in manifest['inline_origin'].items():
    check(provider_name in prod['rule-providers'], 'Missing indexed provider ' + provider_name)
    if provider_name not in prod['rule-providers']:
        continue
    provider = prod['rule-providers'][provider_name]
    expected_payload = [
        ('+.' + rule.split(',')[1] if rule.startswith('DOMAIN-SUFFIX,') else rule.split(',')[1])
        for rule in original_rules
    ]
    check(
        provider.get('type') == 'inline' and provider.get('behavior') in ('domain', 'ipcidr'),
        'Optimized provider type changed: ' + provider_name,
    )
    check(provider.get('payload') == expected_payload, 'Indexed content differs from source: ' + provider_name)
    check(len(provider['payload']) == len(set(provider['payload'])), 'Indexed provider has duplicates: ' + provider_name)
    if provider.get('behavior') == 'ipcidr':
        for cidr in provider['payload']:
            try:
                ipaddress.ip_network(cidr, strict=False)
            except ValueError:
                check(False, 'Invalid CIDR in ' + provider_name + ': ' + cidr)
    snapshot = ROOT / 'Rules' / (provider_name + '.txt')
    check(
        snapshot.read_text(encoding='utf8') == '\n'.join(expected_payload) + '\n',
        'Source snapshot diverged: ' + provider_name,
    )

# Module metadata, self-containment, and deterministic merge behavior.
check(len(manifest['override_order_top_to_bottom']) == 9, 'Exactly 9 override modules are required')
check(manifest['override_order_top_to_bottom'][-1] == '99-Safety.stoverride', 'Safety module should remain last for readability')
seen_providers = set()
for filename in manifest['override_order_top_to_bottom']:
    module = modules[filename]
    check(bool(module.get('name')), 'Override display name missing: ' + filename)
    check(bool(module.get('desc')), 'Override description missing: ' + filename)
    check(module.get('author') == 'HJ', 'Override author changed: ' + filename)
    check(module.get('category') == 'HJ Stash', 'Override category changed: ' + filename)
    provider_names = set(module['rule-providers'])
    references = set()
    for rule in module['rules']:
        references.update(rule_refs(rule))
    check(references <= provider_names, 'Override is not self-contained: ' + filename)
    overlap = seen_providers & provider_names
    check(not overlap, 'Provider defined in more than one override: ' + ','.join(sorted(overlap)))
    seen_providers.update(provider_names)

merged = compose(manifest['override_order_top_to_bottom'])
check(merged['rules'] == prod['rules'], 'Modular merge rules differ from standalone production')
check(merged['rule-providers'] == prod['rule-providers'], 'Modular merge providers differ from standalone production')
check(core['rules'] == base['rules'][-3:], 'Core must contain only the v1.3 fallback')
check(core['rule-providers'] == {}, 'Core should not require remote providers')
check(len(prod['rules']) == 26, 'Expected 26 explicit logical/first-match entries')
check(len(set(prod['rules'])) == len(prod['rules']), 'Duplicate optimized rule')
check(
    prod['rules'][-3:] == ['GEOSITE,CN,DIRECT', 'GEOIP,CN,DIRECT,no-resolve', 'MATCH,🌐 通用代理'],
    'Original fallback order changed',
)
for rule in prod['rules']:
    missing = rule_refs(rule) - set(prod['rule-providers'])
    check(not missing, 'Production references undefined provider(s): ' + ','.join(sorted(missing)))

# The broad rules bundle local exclusions and aliases of every mutable provider
# whose rules have higher priority. This is what makes installation order moot.
mirror_paths = {
    'hj-20-ads-filter': './rules/hj-20-ads-filter.list',
    'hj-10-telegram-exclusion': './rules/hj-10-telegram-exclusion.list',
    'hj-10-twitter-exclusion': './rules/hj-10-twitter-exclusion.list',
    'hj-20-telegram-exclusion': './rules/hj-20-telegram-exclusion.list',
    'hj-20-twitter-exclusion': './rules/hj-20-twitter-exclusion.list',
}
extra_exclusion_providers = {'hj-10-ads-exclusions', 'hj-20-general-exclusions'}
expected_provider_names = (
    set(manifest['inline_origin'])
    | set(base['rule-providers'])
    | extra_exclusion_providers
    | set(mirror_paths)
)
check(set(prod['rule-providers']) == expected_provider_names, 'Unexpected provider set in production')
check(len(prod['rule-providers']) == 28, 'Expected 28 providers after independent mirrors')
paths = [provider['path'] for provider in prod['rule-providers'].values() if 'path' in provider]
check(len(paths) == len(set(paths)), 'Provider cache paths must be unique')
source_by_url = {provider['url']: provider for provider in base['rule-providers'].values()}
for alias, path in mirror_paths.items():
    provider = prod['rule-providers'].get(alias, {})
    expected = copy.deepcopy(source_by_url.get(provider.get('url')))
    if expected is None:
        check(False, 'Unknown URL for mirrored provider ' + alias)
        continue
    expected['path'] = path
    check(provider == expected, 'Mirrored provider drift: ' + alias)


def expected_specific_payload():
    payload = []
    seen = set()
    for item in manifest['segments']:
        if item['name'] in ('10-Ads.stoverride', '20-General.stoverride'):
            continue
        start, end = item['range']
        for rule in base['rules'][start:end]:
            parts = rule.split(',')
            if parts[0] == 'DOMAIN':
                value = parts[1]
            elif parts[0] in ('DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'):
                value = '+.' + parts[1]
            else:
                continue
            if value not in seen:
                seen.add(value)
                payload.append(value)
    return payload


expected_exclusions = expected_specific_payload()
for provider_name in extra_exclusion_providers:
    provider = prod['rule-providers'].get(provider_name, {})
    check(provider.get('type') == 'inline' and provider.get('behavior') == 'domain', provider_name + ' must be inline/domain')
    check(provider.get('payload') == expected_exclusions, provider_name + ' does not cover every specific local rule')
check('+.apple.com.edgekey.net' in expected_exclusions, 'Apple EdgeKey keyword exclusion missing')
check(
    not any('Repcz-Telegram' == name or 'Repcz-Twitter' == name for name in expected_exclusions),
    'Remote provider names must not be treated as local domains',
)

ads_module = modules['10-Ads.stoverride']
general_module = modules['20-General.stoverride']
check(len(ads_module['rules']) == 1, 'Ads override must remain one logical rule')
ads_rule = ads_module['rules'][0]
for token in (
    'AND,((RULE-SET,Repcz-Ads-AWAvenue)',
    '(NOT,((RULE-SET,hj-10-ads-exclusions)))',
    '(NOT,((RULE-SET,hj-10-telegram-exclusion)))',
    '(NOT,((RULE-SET,hj-10-twitter-exclusion)))',
    '(NOT,((DOMAIN-KEYWORD,apple.com.edgekey.net)))',
):
    check(token in ads_rule, 'Ads AND NOT expression missing: ' + token)

check(len(general_module['rules']) == 3, 'General override must preserve its three source rules')
expected_general = [
    ('hj-20-general-domain-1', '🌐 通用代理'),
    ('Repcz-Google', '🌐 通用代理'),
    ('hj-20-general-domain-2', 'DIRECT'),
]
for rule, (primary, target) in zip(general_module['rules'], expected_general):
    for token in (
        'AND,((RULE-SET,' + primary + ')',
        '(NOT,((RULE-SET,hj-20-general-exclusions)))',
        '(NOT,((RULE-SET,hj-20-ads-filter)))',
        '(NOT,((RULE-SET,hj-20-telegram-exclusion)))',
        '(NOT,((RULE-SET,hj-20-twitter-exclusion)))',
        '(NOT,((DOMAIN-KEYWORD,apple.com.edgekey.net)))',
        '),' + target,
    ):
        check(token in rule, 'General AND NOT expression missing: ' + token)

# NoAds is intentionally a behavior variant, but it must retain the three
# General rules while removing both the public and private ad dependencies.
ad_removed_providers = {
    'Repcz-Ads-AWAvenue',
    'hj-10-ads-exclusions',
    'hj-20-ads-filter',
    'hj-10-telegram-exclusion',
    'hj-10-twitter-exclusion',
}
check(len(prod_noads['rules']) == 25, 'NoAds should remove exactly the Ads rule')
check(not (set(prod_noads['rule-providers']) & ad_removed_providers), 'NoAds still contains an ad provider')
check(len(prod_noads['rule-providers']) == 23, 'NoAds expected 23 providers')
check(
    not any('Repcz-Ads-AWAvenue' in rule or 'hj-20-ads-filter' in rule for rule in prod_noads['rules']),
    'NoAds rules still reference advertising providers',
)
check(
    any('RULE-SET,hj-20-general-domain-2' in rule and rule.endswith(',DIRECT') for rule in prod_noads['rules']),
    'NoAds lost General DIRECT rules',
)
check(
    any('RULE-SET,hj-20-general-domain-1' in rule and rule.endswith(',🌐 通用代理') for rule in prod_noads['rules']),
    'NoAds lost General proxy rules',
)
for name in ('Core', 'Production', 'Production-NoAds', 'Production-Legacy-v1.3'):
    check(
        (ROOT / (name + '.txt')).read_text(encoding='utf8')
        == (ROOT / (name + '.yaml')).read_text(encoding='utf8'),
        name + '.txt must mirror .yaml',
    )

# Compose two physically opposite rule orders. Both must route every probe the
# same way, independently of where Ads and General appear in the override list.
order = list(manifest['override_order_top_to_bottom'])
swapped_order = list(order)
ads_index = swapped_order.index('10-Ads.stoverride')
general_index = swapped_order.index('20-General.stoverride')
swapped_order[ads_index], swapped_order[general_index] = swapped_order[general_index], swapped_order[ads_index]
specific_order = [name for name in order if name not in ('10-Ads.stoverride', '20-General.stoverride')]
order_variants = [
    order,
    swapped_order,
    specific_order + ['10-Ads.stoverride', '20-General.stoverride'],
    specific_order + ['20-General.stoverride', '10-Ads.stoverride'],
]
composed_variants = [compose(item) for item in order_variants]

fixture_expectations = {
    'doubleclick.net': '🛡️ 廣告攔截',
    'ad.qq.com': 'DIRECT',
    'ads.youtube.com': '🌐 通用代理',
    'static.ads-twitter.com': '🇹🇼 台灣・故障備援',
    'ads-api.twitter.com': '🇹🇼 台灣・故障備援',
    'api.mixpanel.com': '🇹🇼 台灣・故障備援',
    'adservice.google.com': '🛡️ 廣告攔截',
    'crashlyticsreports-pa.googleapis.com': '🛡️ 廣告攔截',
    'outlookads.live.com': '🛡️ 廣告攔截',
    'events.statsigapi.net': '🤖 AI 服務',
    'gemini.google.com': '🤖 AI 服務',
    'courier.push.apple.com': '🔔 Apple 推送',
    'guzzoni.apple.com': '🍎 Apple 智慧',
    'web.telegram.org': '🇹🇼 台灣・故障備援',
    'github.com': '⚡ 自動選優',
    'youtube.com': '🌐 通用代理',
    'google.com': '🌐 通用代理',
    'microsoft.com': 'DIRECT',
}
order_cases = 0
for profile in composed_variants:
    for domain, expected in fixture_expectations.items():
        actual = find_policy(profile, domain, remote_fixtures)
        check(actual == expected, 'Order-dependent policy for ' + domain + ': expected ' + expected + ', got ' + actual)
        order_cases += 1

# Force both broad remote sources to match every host. Every explicit local
# specific domain must still be protected by the bundled NOT conditions.
shadow_fixtures = copy.deepcopy(remote_fixtures)
shadow_fixtures['Repcz-Ads-AWAvenue'] = ['DOMAIN-KEYWORD,.']
shadow_fixtures['Repcz-Google'] = ['DOMAIN-KEYWORD,.']
worst_case_cases = 0
for profile in (composed_variants[2], composed_variants[3]):
    for item in manifest['segments']:
        if item['name'] in ('10-Ads.stoverride', '20-General.stoverride'):
            continue
        start, end = item['range']
        for rule in base['rules'][start:end]:
            parts = rule.split(',')
            if parts[0] not in ('DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'):
                continue
            sample = parts[1]
            actual = find_policy(profile, sample, shadow_fixtures)
            check(
                actual == parts[2],
                'Worst-case specific shadowing: ' + sample + ' expected ' + parts[2] + ', got ' + actual,
            )
            worst_case_cases += 1

# NoAds must keep General behavior and simply stop advertising interception.
for domain, expected in {
    'adservice.google.com': '🌐 通用代理',
    'doubleclick.net': '🌐 通用代理',
    'microsoft.com': 'DIRECT',
}.items():
    actual = find_policy(prod_noads, domain, remote_fixtures)
    check(actual == expected, 'NoAds policy mismatch for ' + domain + ': ' + actual)

report = {
    'status': 'STATIC_SEMANTICS_PASS' if not errors else 'STATIC_SEMANTICS_FAIL',
    'checks': checks,
    'failures': errors,
    'source_rule_count': len(base['rules']),
    'hot_path_entries': len(prod['rules']),
    'indexed_sets': len(manifest['inline_origin']),
    'provider_count': len(prod['rule-providers']),
    'order_variants': len(order_variants),
    'order_independence_cases': order_cases,
    'worst_case_exclusion_cases': worst_case_cases,
    'priority': 'specific > advertising > general',
    'remote_coverage': 'Four Repcz definitions retained; mutable provider behavior simulated with representative offline fixtures',
    'device_runtime': 'NOT TESTED',
}
(ROOT / 'Tests/validation-report.json').write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + '\n',
    encoding='utf8',
)
print(json.dumps(report, ensure_ascii=False, indent=2))
sys.exit(bool(errors))
