# 导出 Clash (Mihomo) 配置

在工作台打开「下载配置 → Clash (Mihomo)」。可预览、下载 YAML，或点「生成固定订阅链接」并把链接添加到使用 Mihomo 内核的客户端。预览、下载和设备订阅提供同一交付版本，预览会显示版本号。

已生成固定订阅后，可点「复制单文件订阅链接」。它将托管代理源和托管规则集嵌入 YAML，这些内容随整份订阅刷新。单文件地址以 `/mihomo-portable.yaml` 结尾，与普通链接一同更换或撤销。含本地文件或未托管远程来源的配置，请使用普通订阅链接。

默认自动交付最近通过检查的版本。新编辑版未通过时，链接继续提供上一版，页面会显示兼容性问题。启用手动发布后可固定版本、发布当前版或回退到此前发布的版本。更换或撤销 Mihomo 链接只影响 Mihomo 的整份配置订阅；托管代理源链接可分别管理。

管理员 API：`GET /api/profiles/{profileId}/mihomo/config_download` 下载交付版；`POST` / `DELETE /api/profiles/{profileId}/mihomo/download-link` 生成、更换或撤销链接。设备通过 `GET /api/config_download/{token}/mihomo.yaml` 更新。下载无查询参数，成功响应包括 `X-Config-Revision`、`X-Config-SHA256` 和 `X-Rule-Count`。尚无可用版本时返回 `409`。

- 节点、策略组、Hosts、兼容 DNS 设置和规则顺序沿用保存版本。禁用规则不参与导出；`SRC-IP` 转为 `SRC-IP-CIDR`。没有入口配置时使用 `mixed-port: 7890`。
- 代理源和规则集使用 Mihomo 的 `http`、`file` 或 `inline` 类型及 `header` 写法。远程资源由客户端加载，本地文件需放进 Mihomo 工作目录。改写代理源使用 Mihomo 自己的托管链接和缓存，按 Mihomo 当前交付版生效。以前手动下载的 Mihomo 文件如果还在使用 Stash 的代理源链接，可重新下载或改用固定订阅。
- 配置了 DNS 且未指定 `enable` 时启用 Mihomo DNS。`follow-rule` 转为 `respect-rules`，开启时需要单独设置 `proxy-server-nameserver`。
- Stash 的 `http`、`cron`、`script`、`script-providers` 区块不会迁移，预览顶部会列出实际省略的区块。依赖脚本的路由、`relay` 策略组和无法映射的规则选项会阻止导出。

CI 使用固定版本 Mihomo v1.19.33 校验实际导出的测试配置，覆盖 DNS、逻辑规则和来源定义。设置 `MIHOMO_TEST_BIN` 为内核的绝对路径后运行 `npm run check` 可在本地复跑。实际节点、上游和客户端运行行为仍需要设备验收。


导入原生 Mihomo YAML 时，代理源支持 `type: inline` 和 `payload`，并保留组的 `use` 引用。内联 classical 规则集可交付给 Mihomo／兼容的 Shadowrocket；Stash 仍要求将 classical 改成远程或本地来源。内联代理源不会被当成缺少订阅地址的远程来源；Stash 会提示不兼容并保留先前成功产物。

来源的原生 `header` 会统一成工作台的私有 `headers` 字段，加密保存且不在普通管理 API 中回显；Mihomo 导出时转回 `header`。两种拼写同时存在且值不同会拒绝导入或保存。「清除请求头」覆盖两种拼写，旧数据也采用同一规则。[Mihomo 来源字段规范](https://wiki.metacubex.one/config/proxy-providers/)。

手动发布包含托管代理源的候选版时，需要先检查候选来源。检查结果绑定候选产物、有效 10 分钟，不会改变设备正在使用的来源缓存。
