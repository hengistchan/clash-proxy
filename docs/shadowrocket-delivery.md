# Stash 与 Shadowrocket 双客户端交付

在同一个配置中编辑节点、策略组和规则。保存后，服务分别检查两种输出。到「下载配置」切换客户端即可下载文件或生成各自的更新链接。更换或撤销一端的链接不影响另一端。

Shadowrocket 支持范围：

| 资源 | 首版可转换 |
| --- | --- |
| 节点 | 基础 Shadowsocks（常用 AEAD 加密，可带 simple-obfs 的 HTTP/TLS 模式）、HTTP（无 TLS）、SOCKS5（无 TLS）。Shadowrocket .conf 的 Shadowsocks UoT 参数仍待验证。 |
| 策略组 | 手动选择、自动测速、故障转移，以及一致性哈希负载均衡。支持引用其他组或通过 `use` 引用远程 YAML 节点列表。来源与策略组正则均按原节点名筛选，保留成员顺序。测速地址和超时一致时合并为组级设置。按需测速和实际哈希结果可能不同，下载页会提示；暂不自动纳入全部来源。 |
| 路由 | 域名、后缀、关键词、IPv4/IPv6 CIDR、GeoIP、ASN、单端口和 TCP/UDP，以及 DIRECT / REJECT 和自定义策略。保留规则顺序，把 MATCH 转为 FINAL。明确目标是 iOS/tvOS 时，Stash 本来就不生效的进程规则会带提示省略；跨平台配置继续拦截。 |
| 规则集 | 展开引用的内联或远程规则集，保留其位置、顺序与策略。远程支持 YAML `payload:` 或文本列表，按 `domain`、`ipcidr`、`classical` 解析。展开后最多 50,000 条规则。 |
| 网络 | 规则模式、IPv6 开关、基础 DNS、独立节点域名 DNS 与单个域名到 IP 的 Hosts 映射。Fake IP 地址池及过滤规则仍需单独处理。两端使用各自的 DNS 解析和 GeoIP 数据。 |

下载 .conf、首次创建链接和设备更新时，服务读取配置中已保存且被引用的远程来源，按需发送来源配置中的认证请求头。每个配置在 60 秒内复用上次刷新结果；保存新修订后，下次下载可立即刷新。远程文件限 2 MiB，单次刷新最多 24 个来源、12 秒网络预算。服务只请求公网 HTTP(S)，校验每次跳转的地址，不向不同域名转发认证头。来源 URL 和请求头不会写入 .conf。

默认使用系统 DNS。若 Stash 等代理软件向服务返回 Fake IP，可以给服务设置 `STASH_UPSTREAM_DOH_URL=https://1.1.1.1/dns-query`，或填入自己信任的、使用公网 IP 及 [DoH JSON 接口](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)的 HTTPS 解析器。仅来源域名会交给该解析器；私网地址仍会被拦截。

可将以下公开规则示例导入为新配置，验证远程展开，不需要填写节点或私人订阅：

```yaml
rule-providers:
  github:
    behavior: classical
    format: yaml
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/GitHub/GitHub.yaml
rules:
  - RULE-SET,github,REJECT
  - MATCH,DIRECT
```

远程来源不可用、返回不完整或不支持的内容，或配置使用本地文件、MRS、未支持的节点参数及复杂 DNS 等设置时，Shadowrocket 会保留最近一次成功的完整 .conf。没有成功版本时无法创建链接，下载返回 409。Stash 的 YAML 和 ZIP 仍按 Stash 检查结果独立交付；Stash 客户端继续按原方式刷新自己的来源。

升级时数据库会添加 Shadowrocket 专用表；原 Stash 文件、令牌和链接继续使用。现有配置在保存或访问下载状态时生成 Shadowrocket 兼容性检查结果。服务不会测试节点连通性。

设备验收：

1. 用你自己的兼容配置生成 .conf 或固定链接。在 Shadowrocket 的「配置」页导入文件或添加远程配置，选中后将全局路由设为「配置」。
2. 在设备上检查指定域名的直连、拒绝和代理策略，再检查一个应走兜底的域名。涉及 DNS、Hosts、IPv6 或 GeoIP 时，一起检查这些路径。
3. 在工作台保存一条容易观察的兼容规则，在 Shadowrocket 中更新原有远程配置，并确认新规则生效。

[Stash 规则集](https://stash.wiki/en/rules/rule-set) · [Shadowrocket 客户端说明及更新记录](https://apps.apple.com/us/app/shadowrocket/id932747118)

实现参考：[ios_rule_script 的 Clash GitHub.yaml](https://github.com/blackmatrix7/ios_rule_script/blob/master/rule/Clash/GitHub/GitHub.yaml)和[同一规则集的 Shadowrocket .list](https://github.com/blackmatrix7/ios_rule_script/blob/master/rule/Shadowrocket/GitHub/GitHub.list)展示了同一规则内容如何按客户端发布；[subconverter 的规则转换器](https://github.com/tindy2013/subconverter/blob/master/src/generator/config/ruleconvert.cpp)展示了按规则类型解析、添加策略及把 MATCH 映射到 FINAL 的方式。

[subconverter-ng 的 Shadowrocket 导出器](https://github.com/Jungley8/subconverter-ng/blob/main/internal/generator/surge.go)同样先展开节点和规则，再为目标客户端输出。它可以跳过不支持的条目并把空组改为 DIRECT；本项目会报告差异，可能改变规则去向时保留旧产物。GEOSITE 应先用核对过版本和条目类型的规则集替换；不能用 GeoIP 或宽泛的域名后缀近似。
