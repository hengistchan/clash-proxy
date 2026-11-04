#!/usr/bin/env python3
"""Prove the v1.3 baseline plus the explicit Apple AI extension remain ordered and complete.
This is a STATIC SEMANTIC CONTRACT, not proof of on-device timing or HTTP reachability.
"""
from pathlib import Path
import json, hashlib, re, ipaddress, random, sys, csv
import yaml
ROOT=Path(__file__).resolve().parents[1]
base=yaml.safe_load((ROOT/'Sources/v13-normalized-for-audit.yaml').read_text(encoding='utf8'))
prod=yaml.safe_load((ROOT/'Production.yaml').read_text(encoding='utf8'))
core=yaml.safe_load((ROOT/'Core.yaml').read_text(encoding='utf8'))
legacy=yaml.safe_load((ROOT/'Production-Legacy-v1.3.yaml').read_text(encoding='utf8'))
manifest=json.loads((ROOT/'source-manifest.json').read_text(encoding='utf8'))
checks=0;errors=[]
def check(x,msg):
    global checks
    checks+=1
    if not x: errors.append(msg)
check(base==legacy,'Legacy copy diverges from independent baseline')
check(len(base['rules'])==150,'Baseline must have 150 explicit entries')
src=ROOT/'Sources/v1.3-original-user-markdown.md'
check(hashlib.sha256(src.read_bytes()).hexdigest()==manifest['origin_sha256'],'Original Markdown SHA256 mismatch')
kind=r'DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|IP-CIDR|IP-CIDR6|RULE-SET|PROTOCOL|GEOSITE|GEOIP|MATCH'
extracted=[]
for line in src.read_text(encoding='utf8').splitlines():
    if re.match(r'^-\s+(?:'+kind+r'),',line):
        extracted.append(re.sub(r'\\$', '',line.strip()[2:].strip()).replace('\\.','.').strip())
check(extracted==base['rules'],'Original Markdown 150-record sequence differs from normalized source')
check(base['proxy-groups']==prod['proxy-groups']==core['proxy-groups'],'All original 13 groups intact')
check(base['dns']==prod['dns']==core['dns'],'DNS baseline intact')
check(base['proxy-providers']==prod['proxy-providers'],'Proxy provider config intact (no private URL)')
check(set(base['rule-providers'])=={'Repcz-Telegram','Repcz-Twitter','Repcz-Google','Repcz-Ads-AWAvenue'},'Original 4 remote provider names unchanged')
for k,v in base['rule-providers'].items():
    check(k in prod['rule-providers'] and prod['rule-providers'][k]==v,'Remote provider exact config parity '+k)
    check(v['behavior']=='classical' and v['format']=='text','Remote provider original mode parity '+k)
    check(v['url'].startswith('https://raw.githubusercontent.com/Repcz/Tool/X/Stash/Rules/'),'Remote provider original GitHub origin '+k)
for key,orig in manifest['inline_origin'].items():
    check(key in prod['rule-providers'],'Missing indexed provider '+key)
    if key not in prod['rule-providers']: continue
    q=prod['rule-providers'][key]
    check(q['type']=='inline' and q['behavior'] in ('domain','ipcidr'),'Optimized type must be indexed '+key)
    expected=[('+'+'.'+r.split(',')[1] if r.startswith('DOMAIN-SUFFIX,') else r.split(',')[1]) for r in orig]
    check(q['payload']==expected,'Indexed content differs from source '+key)
    if q['behavior']=='ipcidr':
        for cidr in q['payload']:
            try:ipaddress.ip_network(cidr,strict=False)
            except ValueError:check(False,'Invalid CIDR '+cidr)
    check(len(q['payload'])==len(set(q['payload'])),'Indexed provider has duplicates '+key)
    check((ROOT/'Rules'/f'{key}.txt').read_text(encoding='utf8')=='\n'.join(expected)+'\n','Source snapshots diverged '+key)
extension=manifest['apple_ai_extension']
extension_provider=extension['provider']
extension_policy=extension['policy']
check(extension_provider in prod['rule-providers'],'Missing Apple AI extension provider')
extension_data=prod['rule-providers'].get(extension_provider,{})
extension_expected=[('+'+'.'+r.split(',')[1] if r.startswith('DOMAIN-SUFFIX,') else r.split(',')[1]) for r in extension['domains']]
check(extension_data.get('type')=='inline' and extension_data.get('behavior')=='domain','Apple AI extension must be an inline domain set')
check(extension_data.get('payload')==extension_expected,'Apple AI extension payload differs from manifest')
check((ROOT/'Rules'/f'{extension_provider}.txt').read_text(encoding='utf8')=='\n'.join(extension_expected)+'\n','Apple AI source snapshot diverged')
for rule in extension['domains']+extension['process_rules']:
    fields=rule.split(',')
    check(len(fields)==3 and fields[0] in ('DOMAIN','DOMAIN-SUFFIX','PROCESS-NAME') and fields[2]==extension_policy,'Invalid Apple AI extension rule: '+rule)
indexed_origins={**manifest['inline_origin'],extension_provider:extension['domains']}
expanded=[]
for rule in prod['rules']:
    a=rule.split(',')
    if a[0]=='RULE-SET' and a[1] in indexed_origins:
        z=indexed_origins[a[1]]
        for r in z:
            c=r.split(',')
            check(c[2]==a[2],'Rule set target differs from original rule '+r)
            if c[0].startswith('IP-'):check(len(a)>3 and a[-1]=='no-resolve','Lost no-resolve on IP set '+a[1])
        expanded+=z
    else:expanded.append(rule)
expected_expanded=base['rules'][:]
anchor=expected_expanded.index(extension['source_anchor_rule'])
expected_expanded[anchor+1:anchor+1]=extension['domains']+extension['process_rules']
check(expanded==expected_expanded,'FAIL: expanded sequence does not equal v1.3 plus Apple AI extension')
check(len(expanded)==157,'Expanded rule count expected 157')
check(len(prod['rules'])==31,'Optimized explicit rule count expected 31')
check(len(prod['rule-providers'])==22,'Expected 18 indexed + 4 original remote rule sets')
check(len(set(prod['rules']))==len(prod['rules']),'Duplicate optimized rule')
extension_rule=f'RULE-SET,{extension_provider},{extension_policy}'
check(extension_rule in prod['rules'],'Missing Apple AI extension rule')
if extension_rule in prod['rules']:
    extension_index=prod['rules'].index(extension_rule)
    check(prod['rules'][extension_index-1]==f"RULE-SET,{extension['after_provider']},{extension_policy}",'Apple AI extension is not after the original Apple AI domains')
    check(prod['rules'][extension_index+1:extension_index+5]==extension['process_rules'],'Apple AI process rules are missing or out of order')
    check(prod['rules'][extension_index+5]=='RULE-SET,hj-99-safety-domain-6,DIRECT','Apple AI extension must precede domestic DIRECT rules')
    check('RULE-SET,hj-99-safety-domain-3,🔔 Apple 推送' in prod['rules'][:extension_index],'APNs rules must precede Apple AI')
    check('RULE-SET,hj-99-safety-ipcidr-4,🔔 Apple 推送,no-resolve' in prod['rules'][:extension_index],'APNs IP rules must precede Apple AI')
check(prod['rules'][-3:]==['GEOSITE,CN,DIRECT','GEOIP,CN,DIRECT,no-resolve','MATCH,🌐 通用代理'],'Original fallback order retained')
check(core['rules']==base['rules'][-3:],'Core must contain only v1.3 fallback; modules required')
# Compose Stash-style override arrays in actual UI order, and compare with precompiled standalone.
merged=core['rules'][:];rp=core['rule-providers'].copy()
for filename in manifest['override_order_top_to_bottom']:
    mod=yaml.safe_load((ROOT/'Overrides'/filename).read_text(encoding='utf8'))
    check(mod.get('name'),'Override display name missing: '+filename)
    check(mod.get('desc'),'Override description missing: '+filename)
    check(mod.get('author')=='HJ','Override author changed: '+filename)
    check(mod.get('category')=='HJ Stash','Override category changed: '+filename)
    merged=mod['rules']+merged
    for k,v in mod['rule-providers'].items():
        check(k not in rp,'Duplicate provider defined in overrides '+k)
        rp[k]=v
check(merged==prod['rules'] and rp==prod['rule-providers'],'Modular merge != standalone production')
check(manifest['override_order_top_to_bottom'][-1]=='99-Safety.stoverride','Safety module must be last in UI')
# Domain suffix test probes allow detection of omitted root/subdomains and exact-domain pollution.
# The static model handles first matching explicit/inline rules; unexpanded remote rules remain unknown,
# and are compared by exact name+URL+behavior+relative position rather than pretending to simulate them.
def dom_match(val,domain):
    val=val.lower().rstrip('.');domain=domain.lower().rstrip('.')
    if val.startswith('+.'):
        s=val[2:];return domain==s or domain.endswith('.'+s)
    return val==domain
def find_policy(obj,target):
    ip=None
    try:ip=ipaddress.ip_address(target)
    except ValueError:pass
    for r in obj['rules']:
        a=r.split(',');t=a[0]
        if t in ('DOMAIN','DOMAIN-SUFFIX','DOMAIN-KEYWORD') and ip is None:
            s=a[1].lower();host=target.lower()
            if (t=='DOMAIN' and host==s) or (t=='DOMAIN-SUFFIX' and (host==s or host.endswith('.'+s))) or (t=='DOMAIN-KEYWORD' and s in host):return a[2]
        if t in ('IP-CIDR','IP-CIDR6') and ip is not None:
            if ip in ipaddress.ip_network(a[1],strict=False):return a[2]
        if t=='RULE-SET':
            provider=obj['rule-providers'][a[1]]
            if provider.get('type')=='inline':
                if provider['behavior']=='domain' and ip is None and any(dom_match(x,target) for x in provider['payload']):return a[2]
                if provider['behavior']=='ipcidr' and ip is not None and any(ip in ipaddress.ip_network(x,strict=False) for x in provider['payload']):return a[2]
            # Deliberately do NOT treat unknown remote rules as empty. Return an unknown marker
            # so parity tests only use targets provably not blocked by earlier remote sets.
            else:return 'REMOTE_UNKNOWN:'+a[1]
        if t=='MATCH':return a[1]
    return 'NO_MATCH'
apple_ai_rules=manifest['inline_origin']['hj-99-safety-domain-5']+extension['domains']
check(len(apple_ai_rules)==9,'Expected six baseline plus three extension Apple AI domains')
for rule in apple_ai_rules:
    target=rule.split(',')[1]
    check(find_policy(prod,target)==extension_policy,'Apple AI domain did not match expected policy: '+target)
excluded_apple_targets={
    'gateway.icloud.com','probe.icloud.com','metrics.icloud.com','mask-api.icloud.com',
    'mask-api.fe.apple-dns.net','mask-h2.icloud.com','mask.icloud.com',
    'gspe1-ssl.ls.apple.com','ls.apple.com','apps.mzstatic.com',
    'seed.siri.apple.com','apple-carry-relay.cloudflare.com','wps.apple.com'
}
extension_targets={rule.split(',')[1] for rule in extension['domains']}
check(extension_targets=={
    'apple-relay.mask.apple-dns.net','api-siri-prod.apple.com','apple-relay.akamaized.net'
},'Unexpected Apple AI extension domain')
check(not (extension_targets & excluded_apple_targets),'Apple AI extension includes a reviewed exclusion')
# Compare local prefix where no remote rules can possibly shadow the target.
tests=0
for r in base['rules'][:82]:
    a=r.split(',');t=a[0]
    if t in ('DOMAIN','DOMAIN-SUFFIX'):
        host=a[1]
        for sample in ([host,'verify.'+host] if t=='DOMAIN-SUFFIX' else [host]):
            b=find_policy(base,sample);p=find_policy(prod,sample)
            check(b==p,'First-match policy mismatch '+sample+': '+str(b)+' vs '+str(p));tests+=1
    if t in ('IP-CIDR','IP-CIDR6'):
        n=ipaddress.ip_network(a[1],strict=False)
        for sample in [str(n.network_address),str(n.broadcast_address)]:
            b=find_policy(base,sample);p=find_policy(prod,sample)
            check(b==p,'IP policy mismatch '+sample);tests+=1
report={'status':'STATIC_PARITY_PASS' if not errors else 'STATIC_PARITY_FAIL','checks':checks,'failures':errors,'source_rule_count':len(base['rules']),'apple_ai_extension_rule_count':len(extension['domains'])+len(extension['process_rules']),'expanded_rule_count':len(expanded),'hot_path_entries':len(prod['rules']),'indexed_sets':len(manifest['inline_origin'])+1,'original_remote_provider_count':4,'prefix_test_cases':tests,'remote_coverage':'ORIGINAL 4 PROVIDER DEFINITIONS RETAINED; live remote download not tested','device_runtime':'NOT TESTED'}
(ROOT/'Tests/validation-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps(report,ensure_ascii=False,indent=2))
sys.exit(bool(errors))
