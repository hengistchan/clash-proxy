# 通用配置存储

SQLite 继续负责配置、节点、节点来源、策略组、规则集、分流规则和历史修订的关系。Stash YAML、Shadowrocket .conf 等是交付产物，由各客户端适配器生成。

模型将已确认共有的含义放在 `common`，把方言特有字段放在 `extensions.<client>`。例如：

| 含义 | 通用字段 | 现有 Stash API 字段 |
| --- | --- | --- |
| 策略组的有序成员与来源 | `policies`、`nodeSources` | `proxies`、`use` |
| 远程来源地址、请求头与刷新周期 | `address`、`requestHeaders`、`refreshSeconds` | `url`、`headers`、`interval` |
| 普通 DNS 和节点域名解析器 | `resolvers`、`proxyHostResolvers` | `nameserver`、`proxy-server-nameserver` |
| 兜底、精确域名与规则集匹配 | `fallback`、`host.exact`、`rule-set` | `MATCH`、`DOMAIN`、`RULE-SET` |

例如 Stash 的 `ssid-policy`、Fake IP 设置和脚本区块保存在自己的扩展空间。Shadowrocket 的原生组筛选、默认策略和规则集引用保存在 `extensions.shadowrocket`。只有确认含义一致的字段才进入通用模型。当前管理 API 保留原有字段，组和规则集额外提供 `clientOptions.shadowrocket`，便于在同一资源上编辑两端的专用选项。

数据库 v5 在一个事务中转换当前资源，不创建新配置修订。新历史修订使用版本化模型，旧历史按原格式读取。配置 ID、资源引用、加密密钥、已有成功产物和设备令牌沿用原值。管理 API 继续沿用已有的订阅 URL 和请求头脱敏规则。
