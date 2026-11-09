# Stash Config Forge

[![Offline CI](https://github.com/hengistchan/clash-proxy/actions/workflows/offline-ci.yml/badge.svg?branch=main)](https://github.com/hengistchan/clash-proxy/actions/workflows/offline-ci.yml)
[![Security CI](https://github.com/hengistchan/clash-proxy/actions/workflows/security-ci.yml/badge.svg?branch=main)](https://github.com/hengistchan/clash-proxy/actions/workflows/security-ci.yml)

一个用于创建、编辑、检查和版本化代理配置的 Web 管理工具，可交付 Stash YAML、兼容的 Shadowrocket .conf，并导出 Clash (Mihomo) YAML。

技术栈：Next.js / React、Node.js、SQLite、Playwright。应用不依赖特定订阅品牌、
节点名称或规则集名称；你可以从最小配置开始，也可以导入已有 YAML。
导入也支持 Shadowrocket .conf，并在预览中区分通用配置和客户端专用字段。

## 功能

- 管理多个配置，查看当前草稿、最近成功版本和有保留策略的修订历史。
- 导入前选择新建或替换，查看脱敏语义差异及两个客户端的兼容结果；恢复前可查看历史差异。
- 服务端使用 If-Match 版本检查拒绝并发覆盖，保留发生冲突的本页输入。
- 增删改查代理源、直接节点、策略组、规则集、路由规则、Hosts 和高级区块。
- 保留未识别的 YAML 字段和嵌套类型，减少导入后再导出的信息损失。
- 用关系树展示“路由规则 → 策略组 → 节点/代理源”以及规则集、DNS、脚本引用。
- 检查规则顺序、MATCH 终位、策略组成员、循环引用、CIDR、端口、平台兼容性等问题。
- 两端分别检查兼容性与来源状态。默认自动交付最近成功版本，也可为指定客户端固定设备版，手动发布和回退。
- 导出 Stash YAML 和 ZIP，或在「下载配置」切换到 Shadowrocket 查看兼容性并下载 .conf。两个客户端各有可撤销的固定更新链接。也可切换到 [Clash (Mihomo)](docs/mihomo-export.md)，预览并下载当前保存版本的 YAML。
- 提供 REST API 和机器可读 OpenAPI 文档。

可以导入 [双客户端示例](examples/DualClient.yaml) 查看两种输出。示例节点使用文档占位地址。Shadowrocket 的支持范围和设备验收步骤见[双客户端交付说明](docs/shadowrocket-delivery.md)。

## 本地运行

需要 Node.js 20.9 或更高版本。

```bash
npm ci
STASH_ALLOW_INSECURE_LOCAL=1 npm run dev -- --port 3010
```

打开 <http://127.0.0.1:3010>。免认证仅允许显式开启的本机开发模式，启动器强制绑定回环地址。也可以设置 `STASH_ADMIN_TOKEN` 使用认证开发模式。生产启动必须配置管理员令牌，否则拒绝启动和管理访问。

首次启动会创建只包含 `MATCH,DIRECT` 的最小配置。数据和加密密钥默认保存在：

```text
data/stash-config.sqlite3
data/stash-config.sqlite3.key
```

这两个文件已被 Git 忽略。不要提交它们，也不要只备份其中一个。

如果要显式载入示例配置：

```bash
STASH_SEED_EXAMPLE=1 STASH_ALLOW_INSECURE_LOCAL=1 npm run dev -- --port 3010
```

示例模板位于 `examples/Production.yaml`，其中的订阅地址是占位符，不能直接作为
私人生产配置使用。可以通过 `STASH_TEMPLATE_DIR` 指向另一个包含
`Production.yaml` 的目录。

## API

运行服务后访问：

- 可阅读 API 文档：<http://127.0.0.1:3010/docs/api>
- OpenAPI 3.1：<http://127.0.0.1:3010/api/openapi.json>
- 健康检查：<http://127.0.0.1:3010/api/health>

设备配置下载使用按配置分配的只读链接：

```text
GET /api/config_download/{token}/config.yaml
```

下载接口不接受私人订阅 URL 参数。订阅地址绑定到各自的代理源，并经加密后保存在
SQLite 中。代理源和规则集的普通资源 API 均不回传 URL 或认证请求头；写入省略来源字段会保留既有凭据。
远程代理源可在 Stash 导出时按名称或协议改写节点字段，详见[代理源节点改写](docs/proxy-source-rewrites.md)。

## 验证

```bash
npm run check
npm run build
npx playwright install chromium
npm run test:e2e
```

- `npm run check`：TypeScript 类型检查和 Node.js 服务测试。
- `npm run build`：生产构建及持久化数据排除检查。
- `npm run test:e2e`：在临时数据库上启动真实生产服务，执行浏览器端到端回归。

GitHub Actions 会执行类型检查、服务测试、生产构建和 Chromium 回归。Security CI 另执行依赖漏洞审计、认证边界与生产配置检查、完整 Git 历史秘密扫描。

## Docker

```bash
STASH_ADMIN_TOKEN='replace-with-a-strong-token' \
  docker compose up -d --build --wait
```

默认监听 `127.0.0.1:8080`。容器以非 root 用户运行，根文件系统只读，SQLite 和密钥
保存在 named volume `stash-data` 中，容器或主机重启后仍会保留。

所有生产部署必须配置 `STASH_ADMIN_TOKEN`，Compose 禁止空值；公开部署还需配置 HTTPS。反向代理、环境变量、备份和恢复流程见
[SERVICE.md](SERVICE.md)。

## 目录

| 路径 | 说明 |
|---|---|
| `app/` | Next.js 页面与 API 路由 |
| `components/` | 配置工作台界面 |
| `lib/` | SQLite 仓库、加密、导入导出、验证和交付逻辑 |
| `Tests/` | 服务、仓库、启动路径和浏览器回归测试 |
| `examples/` | 可选的示例配置 |
| `docs/architecture-review.md` | 数据边界、交互和部署架构说明 |
| `SERVICE.md` | 本地开发、生产部署、API 和数据备份 |

## 数据安全

- 代理源 URL、请求头、历史快照、成功产物和下载令牌均加密保存。
- 管理页面只把管理员令牌保存在当前浏览器会话。
- 固定下载链接持有者可以读取完整私人配置，应像密码一样保管。
- 数据库和密钥丢失后无法恢复加密内容；迁移或回滚前必须成对备份。

本轮工程审计整改的设计、兼容性变更与验收边界见 [工程审计整改记录](docs/engineering-audit-remediation.md)。
