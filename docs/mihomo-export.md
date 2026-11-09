# 导出 Clash (Mihomo) 配置

在工作台打开「下载配置 → Clash (Mihomo)」，检查 YAML 预览，再点「下载 Mihomo YAML」。下载的是预览中的同一份文件，预览显示文件对应的 Profile 版本。可将文件导入使用 Mihomo 内核的客户端。

管理员 API：`GET /api/profiles/{profileId}/mihomo/config_download`。支持现有管理员认证，无查询参数。成功响应包括 `X-Config-Revision`、`X-Config-SHA256`、`X-Rule-Count`；配置无法转换时返回 `409` 和诊断。导出读取当前保存版本，不回退到旧文件，也不会创建完整配置订阅或变更现有发布版本。

- 节点、策略组、Hosts、兼容 DNS 设置和规则顺序沿用保存版本。禁用规则不参与导出；`SRC-IP` 转为 `SRC-IP-CIDR`。没有入口配置时使用 `mixed-port: 7890`。
- 代理源和规则集使用 Mihomo 的 `http`、`file` 或 `inline` 类型及 `header` 写法。远程资源由客户端加载，本地文件需放进 Mihomo 工作目录。改写代理源复用工作台的独立链接，前提是 Stash 正在交付相同的上游和改写规则，且该链接已启用；来源更新或链接轮换后可能需要重新导出。
- 配置了 DNS 且未指定 `enable` 时启用 Mihomo DNS。`follow-rule` 转为 `respect-rules`，开启时需要单独设置 `proxy-server-nameserver`。
- Stash 的 `http`、`cron`、`script`、`script-providers` 区块不会迁移，预览顶部会列出实际省略的区块。依赖脚本的路由、`relay` 策略组和无法映射的规则选项会阻止导出。

服务执行静态检查；不同版本的客户端、节点协议、远程规则集和本地文件仍需在实际环境中验证。可以使用 `mihomo -t -d <工作目录> -f <配置文件>` 检查，首版用 Mihomo v1.19.33 验证。
