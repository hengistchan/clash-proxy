# 配置工作台迭代清单

- [x] 托管代理源：同配置往返导入、历史恢复、独立撤销和旧链接兼容。
- [x] 导入：共用候选模型，预览只读，显示两端兼容结果及交付影响。
- [x] 交付：共享双客户端状态，显示实际下载版本和来源状态。
- [x] 发布：客户端独立手动发布、回退与自动模式，保护已有订阅。
- [x] 工作台：合并导入入口、手机导航分组、拆分编辑和交付会话。
- [x] 模型：通用语义进入编译边界，保留现有管理 API。
- [x] 验收：运行服务检查、隔离生产构建和浏览器端到端回归；更新部署与 API 文档。

验证结果：类型检查、118 项服务测试、隔离生产构建、33 项 Chrome 端到端测试，以及只读生产容器冒烟均通过。使用独立测试数据库；未执行真机导入。

## 2026-11-21 整体优化

- [x] 统一来源 `header`／`headers` 的导入、加密、脱敏、普通编辑保留和显式清除，兼容旧数据。
- [x] 候选托管来源独立检查，绑定产物指纹、设置有效期，并在手动发布时检查；不改变设备来源缓存。
- [x] 识别 Mihomo 字段，补齐内联代理源、内联 classical 规则集和源 IP 别名的导入／导出。
- [x] 公共校验与交付快照复用；规则分页、索引和 Set 查询；拆分工作台会话与编辑草稿构造。
- [x] 路由解释使用可选的近期远程规则快照，支持 classical／逻辑／RE2，并限制总匹配预算。
- [x] Shadowrocket 增加 Trojan 和 AEAD VMess 的 TCP／TLS／基础 WebSocket 子集，保留不支持项的拦截。
- [x] 提供含 WAL 的在线备份、完整性与配对密钥验证、恢复到新目录的工具。
- [x] 提供管理员可见的进程统计与未知异常关联编号，避免记录原始异常、URL 或凭据。
- [x] v9 新表及升级回归：保留配置资源、已有产物和设备订阅。

验证：138 项服务测试、生产构建、39 项 Chromium 回归、固定 Mihomo v1.19.33 样例校验、依赖审计（0 漏洞）及 diff 空白检查通过。内存基准的 10,001 条规则导入／公共校验／三端编译合计约 162ms，不包含数据库写入或网络请求。测试均使用隔离数据。

本机 Docker 守护进程未运行，本次未完成容器验收；未执行真机导入、发布部署或操作现有生产数据库。

## 2026-11-25 多端差异化与实网运维增强

- [x] 按目标客户端覆盖（`clientOptions.mihomo` / `clientOptions.stash`）：支持 DNS（含 `nameserver-policy` 局部合并与 `null` 删键）及顶层区块覆盖；Mihomo 导出自动剥离 `tiles` 并优雅忽略 `ssid-policy`（发 warning 不再阻断编译）；节点改写支持按 `targets`（Stash / Mihomo）分别生效。
- [x] 网络语义诊断与节点筛选覆盖：`dns.direct-overseas-resolver`、`dns.fake-ip-ipv6`、`mihomo.dns-private-system`、未引用资源提示、允许 `classical` 规则集使用 `no-resolve`；代理源预览输出各策略组正则实际命中与未入自动池节点。
- [x] `Subscription-Userinfo` 流量与到期头加密缓存、交付页展示及 `/api/proxy-source/[capability]/proxies.yaml` 透传；`dialer-proxy` 校验、删除保护、重命名传播与关系图边。
- [x] SQLite v10 迁移：新增 Stash 覆写（`.stoverride`）与磁贴 JS 脚本一等托管、独立只读令牌（自动展开 `{{BASE_URL}}`）、一键内置磁贴模板及工作台界面。
- [x] 新增 `Scripts/check-devices.mjs`（`npm run devices:check`）多端运行态只读比对脚本及 Tailscale Serve 双入口文档。
