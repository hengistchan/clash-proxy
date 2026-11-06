# Stash 配置管理器

Next.js / React + Node.js + SQLite。用户从最小配置、导入的 YAML 或显式选择的示例开始；产品不依赖某个订阅品牌、策略组名称或广告规则。保存后自动检查，检查通过即更新可下载版本。

## 日常使用

1. 创建配置：留空创建最小 `MATCH,DIRECT` 配置；也可以导入 YAML 或选择示例。
2. 若使用远程订阅，在“代理源”中为每个 provider 分别保存 HTTP/HTTPS 地址与可选认证请求头。本地来源选择“Stash 本地文件”并设置 path。没有 provider 的配置无需填写任何订阅地址。
3. 导入配置后会进入“关联关系”，主页与关联页以可展开的关系树展示路由 → 策略 → 节点/订阅，以及规则集、DNS 和脚本引用。树保留规则和组成员顺序，共享资源可在多个分支出现；循环引用与缺失资源明确标记。大量成员分批展开，点击资源会自动展开其所在路径。每个资源可以查看使用者、被引用对象，直接创建预选关联的策略组或规则。管理节点、策略组、规则集、路由顺序、DNS、Hosts 和扩展顶层区块。策略组可以勾选节点、其他组及 provider，并用上下移动调整出口成员顺序；标识文本编辑收进专家模式。节点、来源、策略参数、DNS 扩展和高级区块使用递归字段表单，未知字段及嵌套类型保留，JSON 源码仅在专家模式显示。
4. 保存自动检查和生成；错误草稿仍保存，下载继续提供最近成功版本。总览显示最新修订、实际可下载版本和待配置来源。
5. 下载 YAML 直接导入 Stash，或下载包含配置、诊断、版本清单的 ZIP。ZIP 不抓取远程资源，不是离线资源包；本地 path 指向的文件需另外准备。
6. 在“下载配置”生成固定设备订阅链接；之后每次成功保存自动更新该链接的内容。可以轮换或撤销，链接不授予管理权限。

## 本地开发

```bash
npm ci
npm run dev -- --hostname 127.0.0.1 --port 3010
```

访问 http://127.0.0.1:3010 。开发不需要 Docker。
默认数据库为 `data/stash-config.sqlite3`，密钥为同路径加 `.key`；两者已被 Git 忽略。已有数据库不会被示例覆盖。新安装默认创建没有任何示例 provider、规则集或策略组的最小配置。

## 数据与凭据

每个 provider 的 URL、认证请求头和来源参数保存在该 provider 的 `config_ciphertext` 中，使用 AES-256-GCM 加密；加密前压缩。普通 API 的创建、更新、列表、导入、恢复和快照响应都会去掉 provider URL 与 headers，只提供 `sourceType`、`sourceConfigured`、`headersConfigured`。

`sourceUrl` 与 `sourceHeaders` 是写入字段。普通编辑省略这些字段即可保留凭据；`clearSource` / `clearHeaders` 明确清除。选择本地来源会清除 URL。清除凭据可能令草稿无效，之前成功生成的配置仍保留原来源，直到新的有效配置替换它。

历史快照、最近成功的 YAML 产物和下载令牌原文也加密保存。下载令牌另外保存 SHA-256 哈希供校验。订阅链接和导出的配置文件都能取得私人来源，应按凭据保管；日志与监控需要隐藏下载令牌路径。管理页面只把管理员令牌保存在当前浏览器会话。

资源名称、规则 payload、策略目标、Hosts 值、顺序和显示名称等关系字段为明文，受 0600 文件权限保护。`display_name` 是规则集的界面名称；Stash `name` 负责引用与 YAML 键。同名规则集重新导入时保留显示名，导入占位来源时保留同名 provider 的既有凭据。新写入记录兼容旧 v1 密文读取。

SQLite `user_version` 当前为 3：v2 增加规则集显示名称，v3 增加目标平台、成功编译配置表和下载链接表。结构增量迁移，不删除用户配置；旧服务遇到较新数据库会拒绝启动。升级前请备份数据库与密钥，回退旧镜像需恢复相应数据库备份。

## 规则检查

规则按 priority 升序导出，禁用规则不参与导出。rule 模式需要唯一的末位 MATCH；direct/global 模式不强制依赖 MATCH。编辑器保护已有的终位 MATCH。策略组成员和 provider 引用、循环、规则格式、CIDR、选项和 DNS 规则集引用会检查。

覆盖分析识别明确的域名后缀包含、域名/IP inline 集合和 IPv4/IPv6 网段包含；有规模上限，不保证识别所有重叠。`/simulate` 按当前顺序解释候选匹配，缺少输入、远程/文件规则集、GeoIP/Geosite、脚本、复杂逻辑和 pre-matching 会留下不确定项。服务不解析 DNS、不抓取订阅、不执行脚本；不会把静态检查说成节点或业务连通性验证。

在“全局与 DNS”选择目标平台。iOS/tvOS 的进程规则会提示无效；macOS 不给出该提示；未指定平台时提示兼容性信息。没有规则名称、品牌或业务域名的专用推断。

## API 文档

完整可阅读文档：`/docs/api`。机器可读 OpenAPI 3.1：`/api/openapi.json`，含资源 CRUD、字段、认证与请求/响应定义。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | `/api/profiles` | 列表 / 创建；`importYaml` 可选，`example` 默认 false |
| GET / PUT / DELETE | `/api/profiles/:id` | 配置元数据、重命名、切换活动配置、删除非活动配置 |
| GET | `/api/profiles/:id/snapshot` | 脱敏资源快照与诊断 |
| GET / PUT | `/api/profiles/:id/settings` | 全局、DNS、目标平台 |
| GET / PUT | `/api/profiles/:id/advanced` | 扩展 YAML 区块 |
| POST | `/api/profiles/:id/import` | 导入完整 YAML |
| GET / POST | `/api/profiles/:id/:resource` | 资源列表 / 新建 |
| GET / PUT / DELETE | `/api/profiles/:id/:resource/:itemId` | 资源读取 / 更新 / 删除 |
| GET | `/api/profiles/:id/validate` | 检查结果，error 阻止更新下载版本，warning/info 保留说明 |
| GET | `/api/profiles/:id/relationships` | 实际资源节点、引用边、缺失引用；不包含连接凭据 |
| POST | `/api/profiles/:id/simulate` | 输入 host/ip/network/protocol/process/port，返回候选和不确定项 |
| GET | `/api/profiles/:id/delivery` | currentRevision、compiledRevision、current、generatedAt、configDownloadUrl、subscriptionUrl、subscriptionPath |
| GET | `/api/profiles/:id/config_download` | 下载最近成功的完整 YAML；不接受 URL/模板参数 |
| GET | `/api/profiles/:id/bundle` | 下载交付 ZIP |
| POST / DELETE | `/api/profiles/:id/download-link` | 生成或轮换 / 撤销固定订阅链接 |
| GET | `/api/config_download/:token/config.yaml` | 设备只读下载，使用独立随机令牌，包含 #SUBSCRIBED |
| PUT | `/api/profiles/:id/rules/order` | 全部规则 ID 顺序，不重不漏 |
| GET | `/api/profiles/:id/revisions?limit=50&before=120` | 历史分页，limit 1–100；返回 items、nextCursor |
| POST | `/api/profiles/:id/revisions/:revision/restore` | 恢复并自动检查 |
| GET / POST | `/api/profiles/:id/rule-providers/:providerId/entries` | inline 条目读取 / 新增 |
| PUT / DELETE | `/api/profiles/:id/rule-providers/:providerId/entries/:entryId` | inline 条目更新、位置调整 / 删除 |

`:resource` 支持 `proxies`、`proxy-providers`、`proxy-groups`、`rule-providers`、`rules`、`hosts`。
旧 `/api?url=...` 和 POST `/api` 返回 410；`/export` 仅保留无参数 GET 下载别名。没有基于 Production/NoAds 或特定 provider 名称的输出过滤。

provider 请求例子（两个来源需各自提交，地址不会作为下载参数）：

```json
{
  "name": "source-a",
  "sourceType": "remote",
  "sourceUrl": "https://subscription.example/a",
  "sourceHeaders": {"Accept": "application/yaml"},
  "config": {"path": "./providers/a.yaml", "interval": 3600}
}
```

YAML 响应包含 `X-Config-Revision`、`X-Config-SHA256`、`X-Rule-Count`，并禁止缓存。没有成功版本时下载返回 409；草稿错误不会覆盖上次成功版本。管理请求支持 `Authorization: Bearer ...` 或 `X-Admin-Token`。未设置 `STASH_ADMIN_TOKEN` 时仅适用于受信任的本机环境；公开部署必须配置管理员认证和 HTTPS。固定设备链接持有者可读取完整私人配置。

## 部署与备份

本机生产运行可执行 `npm run build` 后再执行 `npm start`。启动器会在切换到 standalone
目录前，将数据库、密钥与示例目录解析为绝对路径；默认仍使用仓库根目录的
`data/stash-config.sqlite3` 和同路径加 `.key`，与开发模式共用持久化位置。相对的
`STASH_DB_PATH`、`STASH_KEY_PATH`、`STASH_TEMPLATE_DIR` 也均相对仓库根目录解析。
数据库与密钥必须放在 `.next` 之外，重新构建不会删除它们。

旧版 `npm start` 可能已将数据写入 `.next/standalone/data`。升级前先停止服务，
将该目录中的数据库、`-wal`/`-shm` 文件及匹配的密钥一起备份到 `.next` 之外，
核实备份完整后将旧文件移出 `.next`，再构建新版本。恢复到持久化目录后，显式设置
绝对 `STASH_DB_PATH` 和 `STASH_KEY_PATH` 启动；若使用外部 `STASH_SECRET_KEY`，
必须保留同一密钥。启动器发现旧路径数据时会中止，避免静默创建新库；`npm run build`
的预检查也会拒绝删除已知旧数据库及密钥。直接执行 `next build` 会绕过这个预检查，
请使用 `npm run build`。整个过程不会自动覆盖、迁移或删除旧数据。

```bash
docker compose up -d --build --wait
```

Docker 默认 `127.0.0.1:8080`，非 root、只读根文件系统，SQLite 和密钥存于 named volume `/data`，重启与重建保留。开发调试使用上面的本地 Node 命令即可。

备份时停止服务并同时复制数据库和密钥，避免遗漏 WAL 数据：

```bash
docker compose stop api
docker compose cp api:/data/stash-config.sqlite3 ./stash-config.sqlite3
docker compose cp api:/data/stash-config.sqlite3.key ./stash-config.sqlite3.key
chmod 600 stash-config.sqlite3 stash-config.sqlite3.key
docker compose start api
```

通过 `STASH_SECRET_KEY` 提供外部密钥时不会生成 key 文件，需另外备份同一密钥。丢失密钥无法恢复加密来源、快照和产物。数据库、密钥与私人生成文件不得提交 Git。

| 变量 | 默认值 | 用途 |
|---|---|---|
| SERVICE_BIND / SERVICE_PORT | 127.0.0.1 / 8080 | Docker 主机绑定 |
| STASH_DB_PATH | 本地 data/stash-config.sqlite3 | SQLite 路径 |
| STASH_KEY_PATH | 数据库路径 + .key | AES 密钥文件 |
| STASH_SECRET_KEY | 空 | 32 字节密钥，64 位 hex 或 Base64 |
| STASH_ADMIN_TOKEN | 空 | 管理接口令牌 |
| STASH_PUBLIC_BASE_URL | 请求地址 | 反向代理后的对外服务 origin，用于返回完整下载链接 |
| STASH_TEMPLATE_DIR | 仓库根目录 | 可选示例 Production.yaml 所在目录 |
| STASH_SEED_EXAMPLE | 空 | 仅在首次建库时设为 1 可显式加载示例；默认最小配置 |

## 验证

```bash
npm run check
npm run build
npx playwright install chromium
npm run test:e2e
```

测试涵盖通用配置、多来源凭据隔离、脱敏与重启持久化、无效草稿保留成功产物、设备链接轮换撤销、顺序导出与有限匹配分析。
浏览器回归运行真实生产包，使用独立临时数据库、密钥和测试管理员令牌，退出后清理，不读取本机配置；
验证连接恢复、登录、导入、未保存修改保护、保存中导航、错误草稿修复、交付与历史恢复及配置切换。
CI 会独立构建并执行 Chromium 回归，同时保留示例 YAML parity 和 Python 工具回归。

架构与交互改进的边界、设计依据和验收路径见 [架构与体验审查](docs/architecture-review.md)。
