# 导出 Clash (Mihomo) 配置

在工作台打开「下载配置 → Clash (Mihomo)」。可预览、下载 YAML，或点「生成固定订阅链接」并把链接添加到使用 Mihomo 内核的客户端。预览、下载和设备订阅提供同一交付版本，预览会显示版本号。

默认自动交付最近通过检查的版本。新编辑版未通过时，链接继续提供上一版，页面会显示兼容性问题。启用手动发布后可固定版本、发布当前版或回退到此前发布的版本。更换或撤销 Mihomo 链接只影响 Mihomo 的整份配置订阅；托管代理源链接可分别管理。

管理员 API：`GET /api/profiles/{profileId}/mihomo/config_download` 下载交付版；`POST` / `DELETE /api/profiles/{profileId}/mihomo/download-link` 生成、更换或撤销链接。设备通过 `GET /api/config_download/{token}/mihomo.yaml` 更新。下载无查询参数，成功响应包括 `X-Config-Revision`、`X-Config-SHA256` 和 `X-Rule-Count`。尚无可用版本时返回 `409`。

- 节点、策略组、Hosts、兼容 DNS 设置和规则顺序沿用保存版本。禁用规则不参与导出；`SRC-IP` 转为 `SRC-IP-CIDR`。没有入口配置时使用 `mixed-port: 7890`。
- 代理源和规则集使用 Mihomo 的 `http`、`file` 或 `inline` 类型及 `header` 写法。远程资源由客户端加载，本地文件需放进 Mihomo 工作目录。改写代理源使用 Mihomo 自己的托管链接和缓存，按 Mihomo 当前交付版生效。以前手动下载的 Mihomo 文件如果还在使用 Stash 的代理源链接，可重新下载或改用固定订阅。
- 配置了 DNS 且未指定 `enable` 时启用 Mihomo DNS。`follow-rule` 转为 `respect-rules`，开启时需要单独设置 `proxy-server-nameserver`。
- Stash 的 `http`、`cron`、`script`、`script-providers` 区块不会迁移，预览顶部会列出实际省略的区块。依赖脚本的路由、`relay` 策略组和无法映射的规则选项会阻止导出。

服务执行静态检查；不同版本的客户端、节点协议、远程规则集和本地文件仍需在实际环境中验证。可以使用 `mihomo -t -d <工作目录> -f <配置文件>` 检查，首版用 Mihomo v1.19.33 验证。
