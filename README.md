# HJ Stash v1.4（顺序无关覆写 / AND NOT）

[![Offline CI](https://github.com/hengistchan/clash-proxy/actions/workflows/offline-ci.yml/badge.svg?branch=main)](https://github.com/hengistchan/clash-proxy/actions/workflows/offline-ci.yml)
[![Online Rule Check](https://github.com/hengistchan/clash-proxy/actions/workflows/online-rules.yml/badge.svg?branch=main)](https://github.com/hengistchan/clash-proxy/actions/workflows/online-rules.yml)

**结论：完整启用 9 个覆写后，路由不再依赖它们的启用顺序；真机运行仍待最终验收。**
本次 4 个 Repcz 上游源在线下载均通过，Stash 3.7.0 只读 `/rules/match` 字段也已核对。
用当前上游快照构造 1,151 个目标，覆盖 1,079 条远程规则时，4 种顺序的静态模拟差异为 0。

当前语义优先级是：

```text
具体服务 > 广告拦截 > Google / Microsoft / Apple 通用规则
```

具体服务包括 Safety、Social、AI、Developer、YouTube、Google AI 和 Streaming。
`10-Ads` 与 `20-General` 使用 Stash 逻辑规则 `AND` + `NOT`：广告排除所有具体服务，
通用规则再排除具体服务和广告。因此即使广告、通用或其他覆写被重新排序，最终命中结果
也应保持一致。

> 有意行为：属于具体服务域名族的广告子域会跟随具体服务。例如 `ad.qq.com` 按
> Safety 规则直连，`ads.youtube.com` 按 YouTube 规则走通用代理；普通广告域名
> （如 `doubleclick.net`）仍进入「🛡️ 廣告攔截」。

## 顺序无关的实现

- **Ads**：`AND,((RULE-SET,广告源),(NOT,((RULE-SET,具体服务排除集))),...)`。只要广告域名属于任何具体服务，广告规则就不命中。
- **General**：同时排除具体服务、广告源和 Social 的两组远程规则。这样 General 位于 Ads 上方时，广告仍由后方 Ads 规则处理；位于下方时，General 也不会抢占广告。
- **独立可加载**：Ads 和 General 各自携带所需的排除集合与远程 provider 别名，不依赖另一个覆写先定义某个名称。代价是两个宽泛覆写会各自缓存一部分相同上游规则，网络更新和磁盘占用略高。
- **远程 Social 交集**：Telegram/Twitter 上游会变化，不能只写死当前域名。Ads 和 General 各自用唯一缓存路径引用同一官方 URL，并在 `NOT` 中排除完整规则集。
- **保留回退**：`Production-Legacy-v1.3.yaml` 仍保留原始 150 条首匹配顺序，可用于 A/B 和回滚；新语义不等同于旧版。

`Tests/validate_parity.py` 现在会检查 150 条源规则覆盖、17 个索引集合、模块自包含、
4 种规则排列和 18 个代表域名。远程 provider 使用离线代表夹具，不伪装成实时检查。

## 包内文件

| 文件 | 用途 |
|---|---|
| `Core.yaml` | 13 个策略组、DNS、GLaDOS 代理 provider、3 条最终兜底；**不能单独生产启用** |
| `Overrides/*.stoverride` | 9 个必需的功能覆写；**完整兼容版本需要全部启用** |
| `Production.yaml` | Core + 全部 9 个顺序无关覆写的单文件合并结果；不要再同时启用这些覆写 |
| `Production-Legacy-v1.3.yaml` | 150 条原规则 + 4 个远程 provider 的原版语义复刻；用于 A/B 回退与审计 |
| `Production-NoAds.yaml` | **显式功能差异**：去掉广告 provider；非完整等价版 |
| `RELEASE-NOTES-ORDER-INDEPENDENT.md` | 本次 `AND NOT` 行为变化、代价和验收摘要 |
| `Rules/*.txt` | 17 个索引快照；当前完整配置使用 inline 定义，也可通过 `main` 的 Raw 地址作为远程规则集引用 |
| `Sources/` | 用户原始 Markdown 和独立 YAML 解析基线 |
| `Tests/validate_parity.py` | 检验源数据覆盖、模块自包含、provider 镜像、`AND NOT` 语义和顺序无关性 |
| `Tests/live_remote_check.py` | 在本地网络下载并检查所有 4 个远程规则的当前内容 |
| `Tests/runtime_probe.py` | Stash 只读 API 监控，20 次以上成功采样输出 p95 |

## 从 GitHub main 分支获取

公开仓库：<https://github.com/hengistchan/clash-proxy>

`main` 代表最新模板。当前 `Core.yaml` 和 `Production*.yaml` 中的 GLaDOS 地址仍是
`example.invalid` 占位符，**不能直接作为可联网的完整配置导入**。完整配置应拉取
`main` 后在本地生成私人版本；只有 `Rules/*.txt` 和 `Overrides/*.stoverride`
可以直接通过 Raw 地址供 Stash 获取。完整配置包含 `PROTOCOL,MTPROTO` 规则，
需要 Stash iOS/tvOS 3.7+。

### 获取整份配置模板

```bash
git clone --branch main https://github.com/hengistchan/clash-proxy.git
cd clash-proxy
python3 -m pip install PyYAML
python3 Scripts/rebuild.py
python3 Tests/validate_parity.py
python3 Scripts/configure.py --profile Core.yaml
```

`configure.py` 会从环境变量 `GLADOS_URL` 或隐藏提示中读取私人订阅地址，并生成
`~/.config/hj-stash/private/Core.private.yaml`。将该本地文件导入 Stash，再启用全部
9 个覆写；编号顺序只用于整理，不再决定完整集合的路由优先级。不要把生成的文件、
真实订阅地址或 API Token 提交回仓库。

如果只需要查看配置，可以使用网页地址：

```text
https://github.com/hengistchan/clash-proxy/blob/main/Production.yaml
```

如果只需下载原始模板文件，使用 Raw 地址：

```text
https://raw.githubusercontent.com/hengistchan/clash-proxy/main/Production.yaml
```

下载后仍需替换 GLaDOS 占位符。GitHub Contents API 默认返回 JSON，不是 Stash
可直接加载的 YAML：

```text
https://api.github.com/repos/hengistchan/clash-proxy/contents/Production.yaml?ref=main
```

### 使用 main 中的远程规则集

`Rules/*.txt` 可以作为 Stash `rule-providers` 的 `url`。`*-domain-*.txt` 对应
`behavior: domain`，`*-ipcidr-*.txt` 对应 `behavior: ipcidr`。例如，将现有
`hj-60-ai-domain-1` inline Provider 替换为：

```yaml
rule-providers:
  hj-60-ai-domain-1:
    behavior: domain
    format: text
    url: https://raw.githubusercontent.com/hengistchan/clash-proxy/main/Rules/hj-60-ai-domain-1.txt
    path: ./rules/hj-60-ai-domain-1.txt
    interval: 86400

rules:
  - RULE-SET,hj-60-ai-domain-1,🤖 AI 服務
```

IP 集合使用 `behavior: ipcidr`，并保留原规则中的 `no-resolve`：

```yaml
rules:
  - RULE-SET,hj-50-social-ipcidr-2,🇹🇼 台灣・故障備援,no-resolve
```

这里是**替换**同名 inline 定义，而不是在 `rule-providers` 中重复添加同名项。
当前 `Production.yaml` 和 `Core.yaml` 默认使用 inline 规则；把 17 个本地集合改为
远程 `main` 引用会引入网络下载和上游变更风险，必须重新执行静态验收及真机匹配测试。
4 个 `Repcz-*` Provider 仍直接引用其原始上游 URL，不受本仓库 `main` 控制。

GitHub 网页的 `/blob/` 链接返回 HTML，Contents API 默认返回 JSON，都不能直接填入
`rule-providers.url`。Stash 应使用上述 `raw.githubusercontent.com` 地址；如确实要
使用 Contents API，需配置 `Accept: application/vnd.github.raw+json` 请求头。

### 使用 main 中的覆写

在安装了 Stash 的 iPhone/iPad 上点击以下链接即可打开覆写安装页面。建议按编号
安装和整理：

全部覆写会在覆写管理页面归入 `HJ Stash` 分类，并使用各自的 `desc` 说明功能。
`category` 和 `desc` 只影响展示，不改变规则内容或路由优先级。

| 顺序 | 覆写 | 快速安装 |
|---:|---|---|
| 1 | `10-Ads.stoverride` | [安装 AWAvenue 广告策略](https://link.stash.ws/install-override/raw.githubusercontent.com/hengistchan/clash-proxy/main/Overrides/10-Ads.stoverride) |
| 2 | `31-Media-Streaming.stoverride` | [安装流媒体和下载](https://link.stash.ws/install-override/raw.githubusercontent.com/hengistchan/clash-proxy/main/Overrides/31-Media-Streaming.stoverride) |
| 3 | `20-General.stoverride` | [安装 Google / Microsoft / Apple 常规服务](https://link.stash.ws/install-override/raw.githubusercontent.com/hengistchan/clash-proxy/main/Overrides/20-General.stoverride) |
| 4 | `61-GoogleAI.stoverride` | [安装 Google AI 精准分流](https://link.stash.ws/install-override/raw.githubusercontent.com/hengistchan/clash-proxy/main/Overrides/61-GoogleAI.stoverride) |
| 5 | `30-Media-YouTube.stoverride` | [安装 YouTube 媒体分流](https://link.stash.ws/install-override/raw.githubusercontent.com/hengistchan/clash-proxy/main/Overrides/30-Media-YouTube.stoverride) |
| 6 | `40-Developer.stoverride` | [安装 GitHub 开发者服务](https://link.stash.ws/install-override/raw.githubusercontent.com/hengistchan/clash-proxy/main/Overrides/40-Developer.stoverride) |
| 7 | `60-AI.stoverride` | [安装 OpenAI / Claude 精准分流](https://link.stash.ws/install-override/raw.githubusercontent.com/hengistchan/clash-proxy/main/Overrides/60-AI.stoverride) |
| 8 | `50-Social.stoverride` | [安装 Telegram / X 完整规则](https://link.stash.ws/install-override/raw.githubusercontent.com/hengistchan/clash-proxy/main/Overrides/50-Social.stoverride) |
| 9 | `99-Safety.stoverride` | [安装关键安全 / LAN / APNs / 国内服务](https://link.stash.ws/install-override/raw.githubusercontent.com/hengistchan/clash-proxy/main/Overrides/99-Safety.stoverride) |

这些链接会跳转到 `stash://`；桌面浏览器或 `curl` 提示不支持此协议属于预期行为，
应在安装了 Stash 的 iPhone/iPad 上打开。完整集合的启用顺序不改变路由结果。
使用 `main` 时，每次手动更新覆写都会获得最新版本；该分支可移动，不适合作为
不可复现的生产快照。

### main、标签和提交版本的选择

- `main`：适合持续获取最新模板或规则；文件和规则可能随时变化。
- 标签或完整提交 SHA：适合需要可复现、可回滚的部署。把 URL 中的 `main` 换成标签
  或提交 SHA 即可，例如
  `https://raw.githubusercontent.com/hengistchan/clash-proxy/<COMMIT_SHA>/Rules/hj-60-ai-domain-1.txt`。
- 更新已有本地工程时，先执行 `git pull --ff-only origin main`，再运行
  `Scripts/rebuild.py` 和 `Tests/validate_parity.py`。`configure.py` 不会覆盖已有私人配置；
  请保留旧文件以便回滚，并通过 `--out` 创建新的带日期配置。

## CI 和维护流程

仓库使用两个相互独立的 GitHub Actions 工作流：

- `Offline CI`：在 Pull Request、`main` push 或手动触发时运行。它在 Python 3.9
  和 3.12 上执行 `Scripts/rebuild.py`、`Tests/validate_parity.py` 和
  `test_tool_fixes.py`，并检查生成文件是否已经提交。该工作流不访问实时规则源。
- `Online Rule Check`：每天北京时间 09:17 检查 4 个 Repcz 上游源，保存 30 天内的
  sanitized 报告；也可在 Actions 页面手动触发。它不会阻塞离线 CI。

更新仓库时，从最新 `main` 创建独立分支，通过 Pull Request 提交修改。PR 合并前至少
要求 `Offline CI` 的 Python 3.9 和 3.12 两个检查通过；`Online Rule Check` 的偶发
网络失败只用于判断上游可达性，不应被解释为规则配置不一致。

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

**启用全部 9 个覆写。建议的整理顺序如下，但完整集合的路由结果与顺序无关：**

1. `10-Ads.stoverride`
2. `31-Media-Streaming.stoverride`
3. `20-General.stoverride`
4. `61-GoogleAI.stoverride`
5. `30-Media-YouTube.stoverride`
6. `40-Developer.stoverride`
7. `60-AI.stoverride`
8. `50-Social.stoverride`
9. `99-Safety.stoverride`

Stash 仍会按 UI 位置实际拼接规则数组，但 Ads/General 的 `AND NOT` 已把语义固定为
「具体服务 > 广告 > 通用」。离线校验会同时模拟 Ads/General 在数组顶部和底部的相反
顺序。不要只启用 Ads 或 General：宽泛规则会排除具体服务集合，若具体服务覆写缺失，
这些域名可能直接落到 `GEOSITE` / `MATCH` 兜底。也不要叠加任何 RC2/RC3 覆写。
首次打开后更新远程规则源，确认 13 个策略组正常有节点、X5 节点不在自动/备援组；
Apple Watch 天气及 APNs 必须真机复查。

## 验收和限度

`python3 Tests/validate_parity.py` 必须报告 `STATIC_SEMANTICS_PASS`；
`Scripts/rebuild.py` 必须 `PASS`。离线检查验证源数据覆盖、模块自包含、4 种排列下
的相同路由结果，以及 17 个索引集合和全部 provider 镜像；它不验证 Stash 引擎对
嵌套逻辑规则的实际执行、远程源下载可靠性、节点可用性或设备性能。

远程 Repcz 内容会变化，所以离线测试只用代表规则模拟交集。线上可达性由
`Tests/live_remote_check.py` 单独检查；最终仍须在实际 Stash 上验证逻辑规则是否按官方
语法展开。`Production-Legacy-v1.3.yaml` 保留旧首匹配行为，便于回滚，但不能把新版本
称为与 v1.3 逐条等价。

`Production-NoAds` 是用户明确关闭广告时才使用的非等价替代。它会同时移除公开广告源、
私有 Ads provider 镜像和 General 中的广告排除条件，但保留具体服务与 General 的顺序
无关逻辑。

参考：<https://stash.wiki/rules/rule-set>、<https://stash.wiki/configuration/override>、<https://stash.wiki/faq/effective-stash>。

## 真机探针

在 Stash 已启用外部控制且 Mac 能访问 iPhone 后，从环境变量传入 API Key（不要写进脚本或命令行参数）：

```bash
export STASH_TOKEN='你自己的本地 API Token'
python3 Tests/runtime_probe.py --host http://192.168.1.123:9090 --token-env STASH_TOKEN --repetitions 20 --mode functional --out runtime-functional.json
python3 Tests/runtime_probe.py --host http://192.168.1.123:9090 --token-env STASH_TOKEN --repetitions 20 --mode performance --out runtime-performance.json
```

探针输出的 RTT 包含 Wi-Fi 和 HTTP 往返耗时，不是独立的规则匹配 CPU 延迟。
`/rules/match` 的 `proxy` / `rulesEvaluated` 会规范化为 `outbound` /
`evaluatedRules`；仍必须有有效规则和序号/评估数，否则不计成功。`performance`
模式对缺失内存/规则数或无效响应返回退出码 `2`，**不能跳过字段以强行通过**。
