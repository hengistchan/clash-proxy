# Stash Config Forge

基于 Next.js / Node.js、React、SQLite 的 Stash 完整配置管理器。SQLite 是配置主数据，
每个 Profile 可从网页管理并导出成一份可独立导入 Stash 的 YAML。

## Stash 配置涵盖范围

| 配置部分 | 管理能力 | 导出位置 |
|---|---|---|
| Profile / 全局运行选项 | 创建、重命名、切换活动 Profile；`mode`、`log-level`、`ipv6` | 顶层设置 |
| DNS | 上游 DNS、fallback、Fake-IP、策略和其他 DNS 键 | `dns` |
| 代理节点 | 各种协议节点和全部协议专属字段 | `proxies` |
| 代理源 | HTTP / file 等来源、过滤、更新、缓存参数；订阅 URL 请求时注入 | `proxy-providers` |
| 策略组 | select、url-test、fallback、load-balance、relay，成员和组专属字段 | `proxy-groups` |
| 规则集 | inline、remote、local，behavior、来源字段和条目级增删改查 | `rule-providers` |
| 路由规则 | 全部 Stash rule types、目标策略、选项、启停和优先级 | `rules` |
| Hosts | 主机名 / 通配符到地址的映射 | `hosts` |
| 高级顶层配置 | 所有未单独建模的顶层 YAML key，以 JSON 值保留和编辑 | 原 key |

代理节点、代理源、策略组、规则集、路由规则、Hosts 均有完整列表、新增、读取、修改、删除
接口。高级区块和 DNS 支持整块读取与替换；规则集的 inline 条目另有独立 CRUD。未知顶层字段
可以通过 YAML 导入和高级区块编辑保存并重新导出，不会因为 UI 尚未有专用表单就被丢弃。

规则按 `priority` 从小到大匹配。新增规则默认插在 `MATCH` 之前；修改、拖动或整体排序后
会连续重排。唯一的 `MATCH` 必须是最后一条，禁止禁用、移动或删除。引用保护会阻止删除
仍被策略组、规则、DNS 或高级区块使用的资源，并阻止策略组循环引用。

## 快速启动

需要 Node.js 22 或更高版本。

```bash
npm ci
npm run dev
```

打开 <http://localhost:3000>。开发模式数据库默认放在仓库的 `data/stash-config.sqlite3`，
加密密钥在同目录的 `stash-config.sqlite3.key`。两者均被 Git 忽略。

第一次访问时，服务会将 `Production.yaml` 导入为初始 Profile。已存在的数据库不会被模板
覆盖。导入已有完整 Stash YAML、新建 Profile、管理规则或导出配置都可以在网页完成。

## API

### 获取完整配置

Stash 可直接用下列 GET URL 拉取当前活动 Profile。订阅 URL 应进行 URL 编码；`template`
可省略，默认使用 `production`。

```http
GET /api?url=https%3A%2F%2Fsubscription.example%2Fconfig.yaml&template=production
```

```http
POST /api
Content-Type: application/json

{"url":"https://subscription.example/config.yaml","template":"no_ads"}
```

两个端点都返回 `application/yaml` 附件，并设置 `Cache-Control: no-store`、
`Referrer-Policy: no-referrer`、`X-Config-SHA256` 和 `X-Rule-Count`。`production` 保留
广告 Provider；`no_ads` 在导出时去除 `Repcz-Ads-AWAvenue` Provider 及对应规则。

网页始终用 POST 生成配置，避免订阅 URL 进入浏览器地址栏和历史记录。服务不下载或探测
订阅 URL，只将 HTTPS 地址写入本次响应里的代理源配置，避免 SSRF；URL 不会写入 SQLite、
revision 或应用日志。

### 管理 API

管理路由都位于 `/api/profiles` 下，`:id` 表示 Profile ID，`:resource` 为下列集合名。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET / POST | `/api/profiles` | 列出 Profile / 新建 Profile，可选择导入完整 YAML |
| GET / PUT / DELETE | `/api/profiles/:id` | 读取、重命名或删除 Profile；可设为活动配置 |
| GET | `/api/profiles/:id/snapshot` | 读取完整快照和结构校验结果 |
| GET / PUT | `/api/profiles/:id/settings` | 读取或保存全局运行设置与 DNS |
| GET / PUT | `/api/profiles/:id/advanced` | 读取或整体替换高级顶层配置区块 |
| GET | `/api/profiles/:id/validate` | 校验策略引用、循环、规则格式和终位 MATCH |
| POST | `/api/profiles/:id/import` | 导入并替换当前 Profile 的完整 Stash YAML |
| GET / POST | `/api/profiles/:id/export` | 生成指定 Profile 的 YAML；网页使用 POST |
| GET | `/api/profiles/:id/revisions` | 查看加密保存的历史版本 |
| POST | `/api/profiles/:id/revisions/:revision/restore` | 恢复某个历史版本 |
| GET / POST | `/api/profiles/:id/:resource` | 列表 / 新建资源 |
| GET / PUT / DELETE | `/api/profiles/:id/:resource/:itemId` | 读取、修改或删除资源 |
| GET / POST | `/api/profiles/:id/rule-providers/:providerId/entries` | 列出 / 新增 inline 规则集条目 |
| PUT / DELETE | `/api/profiles/:id/rule-providers/:providerId/entries/:entryId` | 修改 / 删除 inline 条目 |
| PUT | `/api/profiles/:id/rules/order` | 以 ID 列表提交完整规则顺序 |

`:resource` 支持 `proxies`、`proxy-providers`、`proxy-groups`、`rule-providers`、
`rules`、`hosts`。新增 / 修改请求体接受 JSON；协议专属、组专属、Provider 专属字段放在
`config` 对象中。`GET /api/meta` 提供规则类型和策略组类型；`GET /api/health` 是容器健康检查。

### 排序示例

```http
PUT /api/profiles/1/rules/order
Content-Type: application/json

{"ids":[12,3,8,4]}
```

`ids` 必须不重不漏地包含该 Profile 全部规则 ID，且 `MATCH` 位于末位。排序后 priority
从 1 连续编号。逐条修改规则时也可以提交 `priority`。

## 管理接口保护

`STASH_ADMIN_TOKEN` 为空时管理接口不要求令牌，适用于仅绑定本机的开发或部署。配置强随机
令牌后，所有 `/api/profiles/*` 管理请求（包括读取）都需要以下任一 Header：

```http
X-Admin-Token: replace-with-a-long-random-value
```

```http
Authorization: Bearer replace-with-a-long-random-value
```

网页只把令牌保存在当前浏览器标签页的 `sessionStorage`。公开 `/api` 导出端点不要求管理
令牌，Stash 更新配置时无法附加自定义管理 Header。公网访问必须设置令牌并在 HTTPS 反向
代理之后提供服务；反向代理日志应隐藏 `/api?url=` 的查询参数。

## Docker 持久化

默认只在本机 `127.0.0.1:8080` 开放。容器使用 Node 22、非 root 用户、只读根文件系统、
丢弃所有 Linux capabilities；SQLite 和密钥只写入 named volume `/data`。容器或主机重启后
会自动恢复，配置随卷保留。

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8080/api/health
```

如果要让其他设备访问局域网，可在 `.env` 中设置：

```dotenv
SERVICE_BIND=0.0.0.0
SERVICE_PORT=8080
STASH_ADMIN_TOKEN=replace-with-a-long-random-value
```

公网部署还应由 HTTPS 反向代理终止 TLS，并设置访问限速和请求体限制。对 Stash 的订阅
拉取链路保留公开 `/api` 路径。

### 持久化文件与备份

默认 SQLite 文件为 `/data/stash-config.sqlite3`。没有指定 `STASH_SECRET_KEY` 时，服务会在
同一 volume 创建权限为 `0600` 的 `stash-config.sqlite3.key`，用于加密配置 JSON、高级区块和
revision。更换容器镜像时不要删除 named volume。

备份前停止服务以确保 WAL 完成 checkpoint，然后同时复制数据库与密钥：

```bash
docker compose stop api
docker compose cp api:/data/stash-config.sqlite3 ./stash-config.sqlite3
docker compose cp api:/data/stash-config.sqlite3.key ./stash-config.sqlite3.key
chmod 600 stash-config.sqlite3 stash-config.sqlite3.key
docker compose start api
```

若通过 `STASH_SECRET_KEY` 提供密钥，备份时需将该部署密钥存入独立的安全密码库，不会生成
上述 key 文件。恢复时必须使用同一密钥；丢失密钥后加密区块和历史 revision 无法解密。
SQLite 主文件和密钥都属于私人配置，勿提交到 Git。

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `SERVICE_BIND` | `127.0.0.1` | Docker 主机绑定地址 |
| `SERVICE_PORT` | `8080` | Docker 主机端口 |
| `STASH_DB_PATH` | 本地 `data/stash-config.sqlite3`；容器 `/data/stash-config.sqlite3` | SQLite 文件路径 |
| `STASH_KEY_PATH` | `${STASH_DB_PATH}.key` | AES 密钥文件路径 |
| `STASH_SECRET_KEY` | 空 | 可选 32 字节密钥，64 位 hex 或 Base64 |
| `STASH_ADMIN_TOKEN` | 空 | 可选管理 API 令牌 |

## 本地验证

```bash
npm ci
npm run check
npm run build
```

仓库 CI 另外运行 Stash YAML parity 和 Python 工具回归。Docker 更新后可执行：

```bash
docker compose build
docker compose up -d --wait
curl -fsS http://127.0.0.1:8080/api/health
```
