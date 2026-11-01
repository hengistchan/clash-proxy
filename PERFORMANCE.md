# 性能和匹配语义

Stash 官方推荐 `domain/ipcidr` 索引规则集减少 CPU 和内存开销，但不允许因此漏掉
规则。当前配置保留 v1.3 的 4 个完整 Repcz `classical/text` 源，并把连续本地规则
压缩为 17 个 inline 集合；`Production.yaml` 有 26 条显式首匹配/逻辑规则。

顺序无关语义使用 `AND` + `NOT`，不是简单重排：

- `10-Ads` 每条连接先检查广告源，再排除本地具体域、Telegram、Twitter 和 Apple
  EdgeKey 关键字。
- `20-General` 的三条来源规则还要排除广告镜像和 Social 交集。
- 两个宽泛覆写各自拥有远程 provider 别名，避免单独启用时出现未定义 provider。
  相同上游因此可能被下载多次；这是可靠优先于最小缓存的取舍。

**不要将 150→26 解释成 5.7 倍加速。** 逻辑规则需要嵌套评估，远程镜像也增加下载和
缓存成本。性能结论只能来自同一设备、同一网络、同一缓存状态下的对照采样。

## 静态验收

`python3 Tests/validate_parity.py` 必须报告 `STATIC_SEMANTICS_PASS`。它检查：

- 150 条源规则、17 个索引集合及 4 个原始远程 provider 定义；
- Ads/General 的 `AND NOT` 条件、模块自包含和远程镜像；
- Ads/General 在规则数组顶部/底部的 4 种顺序；
- 18 个代表域名及七类具体服务的全部本地域名；
- `Production-NoAds` 只移除广告语义。

离线测试不访问 Repcz 上游，也不证明 Stash 引擎对逻辑规则的实际实现。实时下载由
`Tests/live_remote_check.py` 单独检查。

## 真机测量口径

- 路由结果需要明确 `outbound`/`proxy`、有效 `rule`，以及规则序号或评估数；
  探针会兼容 Stash 3.7 的 `rulesEvaluated` 并规范化为 `evaluatedRules`。
- p95 使用 nearest-rank：`ceil(0.95*n)`，例如 20 个样本取第 19 个。
- `--mode performance` 需要 `/rules/count`、`/providers/rules`、`/proxies`、
  `/diagnosis/usedMemory`、`/diagnosis/availableMemory` 均有效，且每个目标至少 20
  个成功响应；失败响应不能算成功样本。
- 只有在逻辑匹配功能通过后，才允许比较 Ads/General 两种顺序的 p50/p95、内存和
  evaluatedRules 差异。

避免在配置包中保存私人 token 或订阅；动态网络检查必须在实际网络运行。
