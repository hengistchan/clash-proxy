# 顺序无关覆写 · 2026-11-01

`10-Ads` 和 `20-General` 改为 `AND` + `NOT` 逻辑规则。完整启用 9 个覆写后，路由固定为：

```text
具体服务 > 广告拦截 > Google / Microsoft / Apple 通用规则
```

因此交换 Ads、General 或其他覆写的位置，不应改变代表域名的最终策略。为了避免
跨覆写引用未定义 provider，Ads 和 General 各自携带排除集合和必要远程镜像；这会
增加少量重复缓存下载。

关键行为变化：

- `events.statsigapi.net`、`gemini.google.com`、APNs 和 Apple 智能不会再被 Ads 或
  General 抢先匹配。
- `ads.youtube.com` 跟随 YouTube；`ad.qq.com` 跟随 Safety 直连。
- 普通广告域名仍由 Ads 拦截；General 上方的顺序也会让位于后方 Ads。
- `Production-Legacy-v1.3.yaml` 保留旧首匹配行为，供回滚和 A/B；新配置不是逐条等价版。

离线验收：

```text
rebuild.py: PASS, 34 artifacts
validate_parity.py: STATIC_SEMANTICS_PASS, 527 checks
test_tool_fixes.py: 10/10 PASS
order variants: 4
order-independence cases: 72
worst-case specific exclusion cases: 206
```

本次本地在线检查中，4 个 Repcz 源均可下载（Telegram 51、Twitter 34、Google 25、
Ads 969 条）。用当前上游快照构造 1,151 个目标，在 4 种规则顺序下模拟 1,079 条
远程规则，顺序差异为 0。Stash 3.7.0 的 `/rules/match` 原始
`proxy` / `rulesEvaluated` 字段也已确认。新 `AND NOT` 配置尚未加载到设备，因此真实
逻辑规则执行和业务功能仍需最终验证。
