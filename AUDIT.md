# 顺序无关覆写审计：AND NOT

- **结论**：离线静态语义模拟为 `STATIC_SEMANTICS_PASS`；iPhone 上的真实 Stash 引擎、
  远程源下载和业务功能仍待最终验收。
- **语义优先级**：`具体服务 > 广告拦截 > Google / Microsoft / Apple 通用规则`。
  `10-Ads` 排除七类具体服务；`20-General` 同时排除具体服务、广告和 Social 远程交集。
- **顺序无关**：Ads/General 都使用 Stash 官方逻辑规则
  `AND,((RULE-SET,...),(NOT,((RULE-SET,...))))`。测试会组合 4 种物理顺序，并比较
  18 个代表域名及全部本地具体域名的最终策略。
- **模块自包含**：Ads/General 不引用另一个覆写才定义的 provider。每个宽泛覆写
  自带 inline 排除集合，并分别定义 Telegram、Twitter、Ads 的必要远程镜像。
  这增加 5 个 provider 及缓存路径，是有意用冗余换取独立加载能力。
- **来源保留**：150 条 v1.3 显式规则、4 个原始 Repcz provider 定义、13 个策略组、
  DNS、GLaDOS provider 和 `Production-Legacy-v1.3` 均保留。Legacy 仍是旧首匹配
  基线，不能声称新方案与它逐条等价。
- **本地索引**：17 个连续 domain/ipcidr 集合仍与 manifest 快照逐项一致；完整
  `Production.yaml` 为 26 条显式逻辑/首匹配项和 28 个 provider。
- **有意差异**：属于具体服务域名族的广告跟随具体服务。例如 `ad.qq.com` 直连，
  `ads.youtube.com` 走 YouTube 的通用代理；普通广告域名仍被拦截。
- **NoAds**：仅删除广告规则及其私有依赖，保留其余 25 条规则和 23 个 provider；
  它不再展示任何 `Repcz-Ads-AWAvenue` / `hj-20-ads-filter` 引用。
- **测试边界**：远程 Repcz 列表会变化，离线测试只用代表夹具模拟交集，不视为在线
  下载或 Stash 引擎验证。本次本地在线检查中 4 个源均可下载；以当前上游快照构造
  1,151 个目标、覆盖 1,079 条远程规则时，4 种顺序的模拟差异为 0。Stash 3.7.0 的
  `proxy` / `rulesEvaluated` 返回结构已确认，但新逻辑规则尚未加载到设备。

参考 Stash：<https://stash.wiki/rules/rule-types>、
<https://stash.wiki/rules/rule-set>、<https://stash.wiki/configuration/override>。

## 历史说明

RC5 的验收工具修复（UTF-8-SIG、私有目录权限、nearest-rank p95、严格 `/rules/match`
校验）仍保留；运行探针现在兼容 Stash 3.7 的 `proxy` / `rulesEvaluated` 字段，并在
输出中规范化为 `outbound` / `evaluatedRules`。
