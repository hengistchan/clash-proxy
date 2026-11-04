# 性能和匹配一致性

Stash 官方推荐 `domain/ipcidr` 索引规则集减少 CPU 和内存开销，但不意味着可以省略规则。RC4 将 v1.3 的连续 150 条显式路由转换为 26 条匹配语句和 17 个索引集合；RC6 在 Apple AI 扩展后为 31 条匹配语句和 18 个索引集合。四个历史完整 `classical/text` 远程规则源继续保留，以免遗漏成员。

**严格验收**：只有 `Tests/validate_parity.py` 与真实 Stash `/rules/match` 语义回归同时通过，才允许比较性能。真机使用 `Tests/runtime_probe.py`（每目标≥20成功采样）测量 HTTP API RTT、`/diagnosis/usedMemory` 与 `/rules/count`；这些指标不能单独代表内核 CPU 匹配耗时。单变量测试 DNS、网络和节点，不强制拦截 UDP/443，不启用全局 MitM 或广告 pre-matching。

单个远程 `classical` 列表可能顺序匹配较慢；如果将来要优化，必须 **完整下载 > 逐条转换 > 原先组别与规则顺序保持 > 新旧远程列表 100% 语义比较 > 引擎验收**。不要默认用高频域名白名单替代原规则集。

## RC5 测量口径与失败条件

- p95 采用最近秩法 `nearest-rank`：`ceil(0.95 * n)` 是从 1 开始的位序；例如 1..20 的 p95 为 19，不是 20。
- 路由结果需要存在明确 `outbound`、有效 `rule`，且可取得 `ruleIndex`、`evaluatedRules` 或内嵌序号；解析失败/不完整响应**不计入成功样本**。
- `--mode performance` 默认需要 `/rules/count`、`/providers/rules`、`/proxies`、`/diagnosis/usedMemory`、`/diagnosis/availableMemory` 成功且结构有效；每个目标不少于 20 个有效样本，发生 API 错误或无效响应返回非零状态。
- `--mode functional` 允许跳过内存接口的强制要求，但仍必须验证路由及关键策略数据。只有在功能级 API 已验收后再比较性能。
- 避免在配置包中保存 private token / 机场订阅；动态网络检查必须在实际网络运行。
