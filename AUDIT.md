# RC5 审计：RC4 匹配覆盖 + 验收工具修复

- **结论**：`STATIC_PARITY_PASS`，真实设备及网络仍待测试。
- **核心问题**：RC3 默认没有全部 Repcz Telegram/Twitter/Google 规则，还把原来 `Repcz-Ads-AWAvenue` 969 条的 `classical/text` 来源换成另一个约 661 条的源，造成实际转发与拦截范围改变。RC4 全部恢复默认加载。
- **保留**：150 条原始显式规则的顺序；13 个策略组及过滤；GLaDOS 订阅 provider、DNS 和 4 个远程 Repcz provider 名称、路径、URL、间隔、behavior/format。
- **索引优化**：17 个连续同策略的 domain / ipcidr inline 集合，保留 1 条 DOMAIN-KEYWORD、MTProto 与 Geo 规则；26 个显式规则匹配项。
- **覆盖证明**：`Tests/validate_parity.py` 用用户上传的原始 v1.3 Markdown SHA-256 及规范化基线重建 150 条顺序；对所有索引集合逐项还原并验证策略、no-resolve 与完整顺序；四个远程规则的配置和匹配位置与原版一致。
- **上游风险**：四个 URL 指向动态分支，用户必须在手机网络检查实际可访问且版本一致。未进行 Stash 引擎真实 `/rules/match` 大规模对比。
- **仍存在但不属于此次性能优化**：原 v1.3 的 Apple 通配、广泛 DIRECT 及广告遮蔽规则可能令部分广告无法 REJECT；这次不静默修改。若优化广告匹配优先级，另做可量化的功能变更与真机测试。
- **安全**：私人订阅从不写入公开配置；`Scripts/configure.py` 默认写入用户目录、权限 0600；不能单独启用只有兜底的 Core。

参考 Stash：<https://stash.wiki/rules/rule-set> / <https://stash.wiki/configuration/override> / <https://stash.wiki/faq/effective-stash>

## RC5 工具复审（基于原 RC4 ZIP）

| 问题 | 修复 | 独立测试 |
|---|---|---|
| `utf8-sig` 非法 codec | 改成 `utf-8-sig`；对原始 bytes 计算 SHA-256 | 模拟 4 个含 BOM 的规则源均 PASS |
| 对现有目录无条件 chmod | 新目录仅创建为 `0700`，现有宽权限目录拒绝且不更改模式 | `0755` 模拟目录保持不变；`0700` 目录成功生成 `0600` 文件 |
| p95 20 样本偏差 | 最近秩法、固定样本测试 | `1..20 => 19`、`1..100 => 95` |
| API 错误/缺字段也算成功 | 强制 JSON 结构；失败不计样本；保存有限的嵌套规则字段 | 缺 outbound 结果返回 `FAIL`、零有效样本 |
| 内存及规则指标失败不阻断 | 默认性能模式硬性检查关键指标 | 无内存指标时 performance 失败，functional 可继续 |

**独立校验**：按 RC4 ZIP 比较 37 个配置/数据文件，改动数为 **0**；`rebuild.py` `PASS`；`validate_parity.py` `STATIC_PARITY_PASS`（450 项检查）。

**尚未验收**：在你的网络重新执行四个远程规则真实下载及哈希记录；用真正 Stash API JSON 验证字段层级；Apple Watch、APNs 和业务功能验收。离线模拟 API 和本地单元测试不能替代线上测试。没有因为性能或修复脚本而减少原版任何规则。
