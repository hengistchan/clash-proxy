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
override_metadata={
    '99-Safety.stoverride':{
        'name':'关键安全 / LAN / APNs / AppleAI / 国内服务',
        'desc':'放行局域网与国内常用服务，并为 APNs 与 Apple 智能提供专用分流。',
    },
    '50-Social.stoverride':{
        'name':'Telegram / X 完整规则',
        'desc':'将 Telegram、X/Twitter 和 MTProto 流量转发至「🇹🇼 台灣・故障備援」。',
    },
    '60-AI.stoverride':{
        'name':'OpenAI / Claude 精准分流',
        'desc':'将 OpenAI、ChatGPT、Claude 及相关 API 流量转发至「🤖 AI 服務」。',
    },
    '40-Developer.stoverride':{
        'name':'GitHub 开发者服务',
        'desc':'将 GitHub 下载、静态资源和相关服务转发至「⚡ 自動選優」。',
    },
    '30-Media-YouTube.stoverride':{
        'name':'YouTube 媒体分流',
        'desc':'将 YouTube 及视频 CDN 流量转发至「🌐 通用代理」。',
    },
    '61-GoogleAI.stoverride':{
        'name':'Google AI 精准分流',
        'desc':'将 Gemini、AI Studio、NotebookLM 和 Google AI API 流量转发至「🤖 AI 服務」。',
    },
    '20-General.stoverride':{
        'name':'Google / Microsoft / Apple 常规服务',
        'desc':'Google 服务走通用代理；Microsoft、Apple 与常用 iCloud、App Store 服务保持直连。',
    },
    '31-Media-Streaming.stoverride':{
        'name':'流媒体和下载',
        'desc':'流媒体与 Lark 走通用代理；Hugging Face 和 Steam 下载走自动优选。',
    },
    '10-Ads.stoverride':{
        'name':'AWAvenue 原版完整广告策略',
        'desc':'使用 AWAvenue 原版广告规则，将命中流量转发至「🛡️ 廣告攔截」。',
    },
}
def render(obj,comment=''):
    return comment+yaml.safe_dump(obj,allow_unicode=True,sort_keys=False,width=150)
def domain_payload(rules):
    return [('+'+'.'+r.split(',')[1] if r.startswith('DOMAIN-SUFFIX,') else r.split(',')[1]) for r in rules]
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
                payload=domain_payload(segment)
                indexed[key]={'type':'inline','behavior':kind,'payload':payload}
                out.append('RULE-SET,'+key+','+a[2]+(',no-resolve' if kind=='ipcidr' else ''))
                origins[key]=segment
                snapshots[key]='\n'.join(payload)+'\n'
                i=j;continue
        out.append(r);i+=1
    return out,indexed,origins,snapshots
expected={};core=copy.deepcopy(base)
core['rules']=base['rules'][147:];core['rule-providers']={}
expected['Core.yaml']=render(core,'# RC6 modular core; requires ALL default Overrides.\n')
expected['Production-Legacy-v1.3.yaml']=render(base,'# Original v1.3 normalized semantic structure; reference/rollback.\n')
compiled=copy.deepcopy(core); mods={}; origins={}
for item in manifest['segments']:
    name=item['name'];start,end=item['range']
    data,inline,orig,snaps=optimize_slice(name,base['rules'][start:end])
    origins.update(orig)
    for k,v in snaps.items():expected[f'Rules/{k}.txt']=v
    other={k:copy.deepcopy(v) for k,v in source_original_providers.items() if owner[k]==name}
    metadata=override_metadata[name]
    mod={'name':metadata['name'],'desc':metadata['desc'],'author':'HJ','category':'HJ Stash','rule-providers':{**inline,**other},'rules':data}
    mods[name]=mod
extension=manifest['apple_ai_extension']
safety=mods['99-Safety.stoverride']
policy=extension['policy']
provider=extension['provider']
anchor=f"RULE-SET,{provider},{policy}"
if anchor not in safety['rules']:raise AssertionError('Apple AI anchor rule missing')
if provider not in safety['rule-providers']:raise AssertionError('Apple AI provider missing')
provider_data=safety['rule-providers'][provider]
if provider_data.get('type')!='inline' or provider_data.get('behavior')!='domain':
    raise AssertionError('Apple AI provider must be an inline domain set')
for rule in extension['domains']:
    fields=rule.split(',')
    if len(fields)!=3 or fields[0] not in ('DOMAIN','DOMAIN-SUFFIX') or fields[2]!=policy:
        raise AssertionError('Invalid Apple AI domain rule: '+rule)
for rule in extension['process_rules']:
    fields=rule.split(',')
    if len(fields)!=3 or fields[0]!='PROCESS-NAME' or fields[2]!=policy:
        raise AssertionError('Invalid Apple AI process rule: '+rule)
extension_payload=domain_payload(extension['domains'])
if set(provider_data['payload']) & set(extension_payload):
    raise AssertionError('Apple AI extension duplicates an existing provider payload')
provider_data['payload']+=extension_payload
anchor_index=safety['rules'].index(anchor)
safety['rules'][anchor_index+1:anchor_index+1]=extension['process_rules']
expected[f'Rules/{provider}.txt']='\n'.join(provider_data['payload'])+'\n'
for name,mod in mods.items():
    expected[f'Overrides/{name}']=render(mod)
for name in manifest['override_order_top_to_bottom']:
    mod=mods[name];compiled['rules']=mod['rules']+compiled['rules']
    for k,v in mod['rule-providers'].items():
        if k in compiled['rule-providers']:raise AssertionError('provider conflict '+k)
        compiled['rule-providers'][k]=v
expected['Production.yaml']=render(compiled,'# RC6 full standalone output with Apple AI extension; no Overrides with this profile.\n')
noads=copy.deepcopy(compiled)
noads['rules']=[r for r in noads['rules'] if 'Repcz-Ads-AWAvenue' not in r]
del noads['rule-providers']['Repcz-Ads-AWAvenue']
expected['Production-NoAds.yaml']=render(noads,'# RC6 NO-ADS alternative: intentionally changes ad route behavior.\n')
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
print(('WROTE' if a.write else 'PASS')+f': {len(expected)} deterministic artifacts; {len(compiled["rules"])} effective match entries; v1.3 baseline plus Apple AI extension retained')
