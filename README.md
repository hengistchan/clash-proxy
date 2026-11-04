# HJ Stash v1.4-RC6 AppleAI（RC5 + Apple Intelligence 定向分流）

[![Offline CI](https://github.com/hengistchan/clash-proxy/actions/workflows/offline-ci.yml/badge.svg?branch=main)](https://github.com/hengistchan/clash-proxy/actions/workflows/offline-ci.yml)
[![Online Rule Check](https://github.com/hengistchan/clash-proxy/actions/workflows/online-rules.yml/badge.svg?branch=main)](https://github.com/hengistchan/clash-proxy/actions/workflows/online-rules.yml)

**结论：v1.3 的 150 条基础规则静态还原一致；Apple Intelligence 扩展已通过离线顺序测试，真机运行尚未验收。** RC3 优化时默认丢弃了部分 Repcz Telegram/Twitter/Google 成员、把 969 条 Repcz 广告源换为约 661 条 Only.Ads。RC4 **撤销这些有损优化**。

> **RC6 变更范围：Apple Intelligence / Siri 定向补充。** 保留原版 150 条规则、Legacy 回滚基线和 4 个 Repcz 远程 Provider；在现有 6 条 Apple 智能域名之后新增 3 条 relay/Siri 域名和 4 条 macOS `PROCESS-NAME` 规则，完整展开序列为 157 条。APNs 仍在 Apple AI 之前，国内及普通 Apple/icloud DIRECT 规则仍在之后；没有加入通用 Apple `IP-CIDR`。
>
> **后续展示元数据更新：** 9 个覆写已补充中文 `desc`，并统一使用 `category: 'HJ Stash'`；路由规则和启用顺序未改变。
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
- **基线可逆**：原版中连续、相同策略的 DOMAIN/DOMAIN-SUFFIX 或 IP-CIDR 段被转换为 17 个 `inline domain/ipcidr` 索引集合；另为 Apple AI 扩展增加第 18 个索引集合。原始 150 条规则仍能逐条、原顺序地恢复，`DOMAIN-KEYWORD`、MTProto 及 GeoSite/GeoIP/MATCH 不变。
- **变更范围明确**：除本版新增的 Apple Intelligence 域名和进程规则外，Google、Twitter、Telegram、AI、国内服务及原版广告位置不变。广告提前放行等原版功能问题仍单独处理，不能混入等价性修复。
- **高性能不等于追求 0 classical**：18 个本地索引集合 + 4 个原始远程 `classical`，共 31 条热路径显式匹配项；完整语义序列为 157 条。

## 包内文件

| 文件 | 用途 |
|---|---|
| `Core.yaml` | 13 个策略组、DNS、GLaDOS 代理 provider、3 条最终兜底；**不能单独生产启用** |
| `Overrides/*.stoverride` | 9 个必需的功能覆写；**完整兼容版本需要全部启用** |
| `Production.yaml` | 与 Core+全部 9 个覆写结构一致的单文件参考，不能同时启用这些覆写 |
| `Production-Legacy-v1.3.yaml` | 150 条原规则 + 4 个远程 provider 的原版语义复刻；用于 A/B 回退与审计 |
| `Production-NoAds.yaml` | **显式功能差异**：去掉广告 provider；非完整等价版 |
| `Rules/*.txt` | 18 个索引快照；当前完整配置使用 inline 定义，也可通过 `main` 的 Raw 地址作为远程规则集引用 |
| `Sources/` | 用户原始 Markdown 和独立 YAML 解析基线 |
| `Tests/validate_parity.py` | 检验 SHA、150 条基线还原、7 条 Apple AI 扩展、4 个远程 provider 定义、覆写合并与分流 |
| `Tests/live_remote_check.py` | 在本地网络下载并检查所有 4 个远程规则的当前内容 |
| `Tests/runtime_probe.py` | Stash 只读 API 监控，20 次以上成功采样输出 p95 |

## 从 GitHub main 分支获取

公开仓库：<https://github.com/hengistchan/clash-proxy>

### 网页生成完整配置

仓库内置一个无状态的前端与 API 服务，可直接生成包含私人 GLaDOS 地址的完整配置：

```text
GET /api?url=https://your-subscription.example/path&template=production
```

本地启动和 Docker 持久化部署方法见 [SERVICE.md](SERVICE.md)。该服务不持久化订阅
地址，Docker 默认启用自动重启，适合长期部署在 Mac mini、NAS 或服务器上。网页默认
使用 POST，避免敏感 URL 进入浏览器地址栏；公网部署必须位于 HTTPS 反向代理之后。

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
`~/.config/hj-stash/private/Core.private.yaml`。将该本地文件导入 Stash，再按下一节
的顺序启用 9 个覆写。不要把生成的文件、真实订阅地址或 API Token 提交回仓库。

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
当前 `Production.yaml` 默认使用 18 个 inline 规则集合；模块化部署时这些集合定义在
覆写中，`Core.yaml` 本身只保留兜底规则。把本地集合改为远程 `main` 引用会引入网络下载和
上游变更风险，必须重新执行静态验收及真机匹配测试。
4 个 `Repcz-*` Provider 仍直接引用其原始上游 URL，不受本仓库 `main` 控制。

GitHub 网页的 `/blob/` 链接返回 HTML，Contents API 默认返回 JSON，都不能直接填入
`rule-providers.url`。Stash 应使用上述 `raw.githubusercontent.com` 地址；如确实要
使用 Contents API，需配置 `Accept: application/vnd.github.raw+json` 请求头。

### 使用 main 中的覆写

在安装了 Stash 的 iPhone/iPad 上点击以下链接即可打开覆写安装页面。请按编号依次
安装，并最终按相同顺序启用：

全部覆写会在覆写管理页面归入 `HJ Stash` 分类，并使用各自的 `desc` 说明功能。
`category` 和 `desc` 只影响展示，不改变规则内容或启用顺序。

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
| 9 | `99-Safety.stoverride` | [安装关键安全 / LAN / APNs / AppleAI / 国内服务](https://link.stash.ws/install-override/raw.githubusercontent.com/hengistchan/clash-proxy/main/Overrides/99-Safety.stoverride) |

这些链接会跳转到 `stash://`；桌面浏览器或 `curl` 提示不支持此协议属于预期行为，
应在安装了 Stash 的 iPhone/iPad 上打开。安装后仍须严格遵守下一节的启用顺序。
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

Stash 对数组默认使用**后启用覆写的规则前插**，上面的 UI 顺序保留 v1.3 基础顺序；Apple AI 扩展位于 `99-Safety.stoverride` 中现有 Apple 智能规则之后、国内 DIRECT 规则之前。不要叠加任何 RC2/RC3 覆写。首次打开后更新 4 个远程规则源，确认 13 个策略组正常有节点、X5 节点不在自动/备援组；Apple Watch 天气、APNs 与 Apple Intelligence 必须真机复查。

## 验收和限度

`python3 Tests/validate_parity.py` 必须报告 `STATIC_PARITY_PASS`；`Scripts/rebuild.py` 必须 `PASS`。这验证 **150 条 v1.3 基线、7 条 Apple AI 扩展和 4 个远程 provider 的配置顺序与内容**，但 Stash 引擎的实际 `inline` / `PROCESS-NAME` 匹配行为、远程源下载可靠性、节点可用性及设备性能必须进一步测量。

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
