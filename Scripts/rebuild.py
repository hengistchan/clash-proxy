#!/usr/bin/env python3
"""Deterministic generation from original v1.3 rule order; check fails on any drift."""
import argparse, copy, json, re, sys
from pathlib import Path
import yaml
ROOT=Path(__file__).resolve().parents[1]
manifest=json.loads((ROOT/'source-manifest.json').read_text(encoding='utf8'))
base=yaml.safe_load((ROOT/'Sources/v13-normalized-for-audit.yaml').read_text(encoding='utf8'))
assert len(base['rules'])==150
source_original_providers=base['rule-providers']
owner={'Repcz-Telegram':'50-Social.stoverride','Repcz-Twitter':'50-Social.stoverride','Repcz-Google':'20-General.stoverride','Repcz-Ads-AWAvenue':'10-Ads.stoverride'}
def render(obj,comment=''):
    return comment+yaml.safe_dump(obj,allow_unicode=True,sort_keys=False,width=150)
def optimize_slice(name,rules):
    out=[]; indexed={}; origins={}; idx=0;i=0;snapshots={}
    while i<len(rules):
        r=rules[i];a=r.split(',');t=a[0]
        kind='domain' if t in ('DOMAIN','DOMAIN-SUFFIX') else 'ipcidr' if t in ('IP-CIDR','IP-CIDR6') and a[-1]=='no-resolve' else None
        if kind:
            j=i+1
            while j<len(rules):
                z=rules[j].split(',')
                if z[2]!=a[2]:break
                if kind=='domain' and z[0] not in ('DOMAIN','DOMAIN-SUFFIX'):break
                if kind=='ipcidr' and (z[0] not in ('IP-CIDR','IP-CIDR6') or z[-1]!='no-resolve'):break
                j+=1
            segment=rules[i:j]
            if len(segment)>=2:
                idx+=1
                prefix=re.sub(r'[^a-z0-9]+','-',name.split('.')[0].lower()).strip('-')
                key=f'hj-{prefix}-{kind}-{idx}'
                payload=[('+'+'.'+z.split(',')[1] if z.startswith('DOMAIN-SUFFIX,') else z.split(',')[1]) for z in segment]
                indexed[key]={'type':'inline','behavior':kind,'payload':payload}
                out.append('RULE-SET,'+key+','+a[2]+(',no-resolve' if kind=='ipcidr' else ''))
                origins[key]=segment
                snapshots[key]='\n'.join(payload)+'\n'
                i=j;continue
        out.append(r);i+=1
    return out,indexed,origins,snapshots
expected={};core=copy.deepcopy(base)
core['rules']=base['rules'][147:];core['rule-providers']={}
expected['Core.yaml']=render(core,'# RC4 modular core; requires ALL default Overrides.\n')
expected['Production-Legacy-v1.3.yaml']=render(base,'# Original v1.3 normalized semantic structure; reference/rollback.\n')
compiled=copy.deepcopy(core); mods={}; origins={}
for item in manifest['segments']:
    name=item['name'];start,end=item['range']
    data,inline,orig,snaps=optimize_slice(name,base['rules'][start:end])
    origins.update(orig)
    for k,v in snaps.items():expected[f'Rules/{k}.txt']=v
    other={k:copy.deepcopy(v) for k,v in source_original_providers.items() if owner[k]==name}
    mod={'name':next(x[1] for x in [
    ('99-Safety.stoverride','关键安全 / LAN / APNs / AppleAI / 国内服务'),
    ('50-Social.stoverride','Telegram / X 完整规则'),
    ('60-AI.stoverride','OpenAI / Claude 精准分流'),
    ('40-Developer.stoverride','GitHub 开发者服务'),
    ('30-Media-YouTube.stoverride','YouTube 媒体分流'),
    ('61-GoogleAI.stoverride','Google AI 精准分流'),
    ('20-General.stoverride','Google / Microsoft / Apple 常规服务'),
    ('31-Media-Streaming.stoverride','流媒体和下载'),
    ('10-Ads.stoverride','AWAvenue 原版完整广告策略')] if x[0]==name),
    'desc':'RC4 parity-first; source: v1.3; do not reorder.','author':'HJ','rule-providers':{**inline,**other},'rules':data}
    mods[name]=mod
    expected[f'Overrides/{name}']=render(mod)
for name in manifest['override_order_top_to_bottom']:
    mod=mods[name];compiled['rules']=mod['rules']+compiled['rules']
    for k,v in mod['rule-providers'].items():
        if k in compiled['rule-providers']:raise AssertionError('provider conflict '+k)
        compiled['rule-providers'][k]=v
expected['Production.yaml']=render(compiled,'# RC4 parity-first full standalone output; no Overrides with this profile.\n')
noads=copy.deepcopy(compiled)
noads['rules']=[r for r in noads['rules'] if 'Repcz-Ads-AWAvenue' not in r]
del noads['rule-providers']['Repcz-Ads-AWAvenue']
expected['Production-NoAds.yaml']=render(noads,'# RC4 NO-ADS alternative: intentionally changes ad route behavior.\n')
for name in ['Core','Production','Production-NoAds','Production-Legacy-v1.3']:
    expected[name+'.txt']=expected[name+'.yaml']
manifest_origins=manifest['inline_origin']
if origins!=manifest_origins:raise AssertionError('inline origins drift from source manifest; fail closed')
args=argparse.ArgumentParser()
args.add_argument('--write',action='store_true')
a=args.parse_args()
errors=[]
for name,contents in expected.items():
    path=ROOT/name
    if a.write:
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(contents,encoding='utf8')
    elif not path.exists() or path.read_text(encoding='utf8')!=contents:
        errors.append(name)
if errors:
    print('DRIFT: '+', '.join(errors),file=sys.stderr);sys.exit(1)
print(('WROTE' if a.write else 'PASS')+f': {len(expected)} deterministic artifacts; {len(compiled["rules"])} effective match entries; full v1.3 provider coverage retained')
