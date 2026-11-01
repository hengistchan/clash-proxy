# HJ Stash v1.4-RC5 VerifiedTools（规则等价 + 验收工具修复）

**结论：静态规则还原一致，真机运行尚未验收。** RC3 优化时默认丢弃了部分 Repcz Telegram/Twitter/Google 成员、把 969 条 Repcz 广告源换为约 661 条 Only.Ads。RC4 **撤销这些有损优化**。

> **RC5 变更范围：仅修复验收脚本与私人输出目录保护。** `Core.yaml`、`Production*.yaml`、9 个覆写、17 个规则快照、原始 v1.3 源文件及 manifest 与 RC4 **逐字节一致**；150 条分流规则、4 个 Repcz 远程 Provider、13 个代理组均未改变。
>
> 当前状态：本地静态验收通过；**线上规则可达性和 iPhone 真机验收仍待本地执行**。

## RC5 验收工具修复

1. `Tests/live_remote_check.py` 修复 UTF-8-SIG 编码名，保存原始响应字节的 SHA-256；断网时仍会失败，不把本地模拟当在线验证。
2. `Scripts/configure.py` 对新创建的专用目录设置 `0700`；已有目录不执行 `chmod`，如果组/其他用户有权限则**拒绝写入**且保留原有模式；私有配置为 `0600`。
3. `Tests/runtime_probe.py` 改用 **nearest-rank p95**：20 个升序样本取第 19 个值。
4. `/rules/match` 必须有有效 `outbound`、命中规则和 `ruleIndex` / `evaluatedRules` / 内嵌序号之一，允许保留白名单化的嵌套规则字段；无效 JSON 不能计入成功样本。
5. 探针默认 `--mode performance`，同时强制检查规则数量、规则源、代理组、使用和可用内存，以及每目标至少 20 次有效请求；`--mode functional` 可只做功能级检查。

本次不修改 Stash 版本相关内容，按现有最新版客户端测试即可。

## 修复原则

- **覆盖完整性优先**：保留 v1.3 的 4 个原始 Repcz `classical/text` 远程提供者，提供者名称、URL、缓存路径、更新周期和首次匹配位置都保持不变。
- **仅优化可证明等价的本地规则**：把原版中连续、相同策略的 DOMAIN/DOMAIN-SUFFIX 或 IP-CIDR 段转换为 17 个 `inline domain/ipcidr` 索引集合。原始 150 条规则能被逐条、原顺序地恢复；`DOMAIN-KEYWORD`、MTProto 及 GeoSite/GeoIP/MATCH 不改变。
- **不做隐式策略调整**：Google、Twitter、Telegram、Apple、AI、国内服务的最终匹配优先级与 v1.3 相同。广告也保留原版位置；这意味着原版中已存在的广告提前放行问题仍在，属于独立待修复的功能缺陷，不能混进性能修复里。
- **高性能不等于追求 0 classical**：17 个本地索引集合 + 4 个原始远程 `classical`，共 26 条热路径显式匹配项。不能将 150→26 理解为实际速度提升 5.7 倍。

## 包内文件

| 文件 | 用途 |
|---|---|
| `Core.yaml` | 13 个策略组、DNS、GLaDOS 代理 provider、3 条最终兜底；**不能单独生产启用** |
| `Overrides/*.stoverride` | 9 个必需的功能覆写；**完整兼容版本需要全部启用** |
| `Production.yaml` | 与 Core+全部 9 个覆写结构一致的单文件参考，不能同时启用这些覆写 |
| `Production-Legacy-v1.3.yaml` | 150 条原规则 + 4 个远程 provider 的原版语义复刻；用于 A/B 回退与审计 |
| `Production-NoAds.yaml` | **显式功能差异**：去掉广告 provider；非完整等价版 |
| `Rules/*.txt` | 17 个索引快照，仅供调试；Stash 使用 inline 定义，不必手动导入 |
| `Sources/` | 用户原始 Markdown 和独立 YAML 解析基线 |
| `Tests/validate_parity.py` | 检验 SHA、150 条还原、4 个 provider 定义、覆写合并、分流抽查 |
| `Tests/live_remote_check.py` | 在本地网络下载并检查所有 4 个远程规则的当前内容 |
| `Tests/runtime_probe.py` | Stash 只读 API 监控，20 次以上成功采样输出 p95 |

## 模块化部署（Mac + iPhone Stash）

**保留当前 iPhone v1.3 以便回滚。** 在解压目录执行：

```bash
python3 -m pip install PyYAML
python3 Scripts/rebuild.py
python3 Tests/validate_parity.py
python3 Tests/live_remote_check.py
python3 -m unittest discover -s Tests -p 'test_tool_fixes.py' -v
python3 Scripts/configure.py --profile Core.yaml
```

`configure.py` 不回显 GLaDOS 私人订阅地址；默认写到 `~/.config/hj-stash/private/Core.private.yaml`，权限 0600。把这一文件 AirDrop / iCloud 导入 Stash；切勿公开。

**覆写管理页面从上到下严格按此顺序启用全部 9 个：**

1. `10-Ads.stoverride`
2. `31-Media-Streaming.stoverride`
3. `20-General.stoverride`
4. `61-GoogleAI.stoverride`
5. `30-Media-YouTube.stoverride`
6. `40-Developer.stoverride`
7. `60-AI.stoverride`
8. `50-Social.stoverride`
9. `99-Safety.stoverride`

Stash 对数组默认使用**后启用覆写的规则前插**，上面的 UI 顺序使最终规则顺序与 v1.3 相同。不要叠加任何 RC2/RC3 覆写。首次打开后更新 4 个远程规则源，确认 13 个策略组正常有节点、X5 节点不在自动/备援组；Apple Watch 天气及 APNs 必须真机复查。

## 验收和限度

`python3 Tests/validate_parity.py` 必须报告 `STATIC_PARITY_PASS`；`Scripts/rebuild.py` 必须 `PASS`。这验证 **150 条显式规则和 4 个远程 provider 的配置完全覆盖**，但 Stash 引擎的实际 `inline` 匹配行为、远程源下载可靠性、节点可用性及设备性能必须进一步测量。

自动化的离线 `first_match` 测试无法填补本机无网络时对实时 Repcz 上游的下载。**由于原版与新版引用完全相同的 provider 定义，并且 provider 相对优先级一致，在源数据相同且 Stash 遵循文档的前提下，属于等价的配置转换；不是网络环境下绝对零故障保证。**

`Production-NoAds` 是用户明确关闭广告时才使用的非等价替代。未来要优化 Repcz classical，可以由本地 Agent 拉取最新 4 个完整源、把所有规则按类型转换为索引集合并运行逐项等价验证后再发布，不允许仅抽取高频子集。

参考：<https://stash.wiki/rules/rule-set>、<https://stash.wiki/configuration/override>、<https://stash.wiki/faq/effective-stash>。

## 真机探针（RC5）

在 Stash 已启用外部控制且 Mac 能访问 iPhone 后，从环境变量传入 API Key（不要写进脚本或命令行参数）：

```bash
export STASH_TOKEN='你自己的本地 API Token'
python3 Tests/runtime_probe.py --host http://192.168.1.123:9090 --token-env STASH_TOKEN --repetitions 20 --mode functional --out runtime-functional.json
python3 Tests/runtime_probe.py --host http://192.168.1.123:9090 --token-env STASH_TOKEN --repetitions 20 --mode performance --out runtime-performance.json
```

探针输出的 RTT 包含 Wi-Fi 和 HTTP 往返耗时，不是独立的规则匹配 CPU 延迟。`performance` 模式对缺失内存/规则数或无效 `/rules/match` 响应返回退出码 `2`；如果真实 Stash 返回的 JSON 结构与当前校验器不同，先在本机排查结构并更新校验器，**不能跳过字段以强行通过**。
