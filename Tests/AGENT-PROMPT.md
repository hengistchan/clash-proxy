# RC5 真机验收任务（提交给本地 Agent）

审计原则：**任何历史转发匹配不能因为性能优化而丢失**。

1. 运行 `python3 Scripts/rebuild.py`、`python3 Tests/validate_parity.py`、`python3 -m unittest discover -s Tests -p 'test_tool_fixes.py' -v`，失败立即停止部署。
2. 运行 `python3 Tests/live_remote_check.py`，保存当前四个上游源的 sha256、条数、HTTP 是否成功。与旧版 v1.3 在同一时刻更新同一远程规则源，禁止一版用旧缓存另一版用新缓存后比较。
3. 配置私有 GLaDOS 订阅；检查 13 个策略组及节点名称过滤结果。任何自动或 fallback 组为空、X5 误入则停止。
4. 先在受控状态安装 RC4 Core 和 9 个覆写，逐个记录启用顺序，导出或通过 Stash HTTP API 检查最终规则、规则集与策略组；对照 `Production.yaml`。
5. 对原版 150 条显式规则及四个远程列表每条构造正向/反向样本。在 `/rules/match` 分别比较 v1.3、RC4 的返回策略、命中规则、评估条数；**任何原匹配目标改为 MATCH 或不同组为 FAIL**。也检查域名根域、子域、IP 地址及 IPv6，不要只测一组样本。注意特殊规则如 IP-ASN 需真实目标样本。
6. 在同一台设备的同一网络条件下，分别对旧版和新版做 20 次成功采样 p50/p95、内存快照、DNS 冷热缓存及节点连通性基准；`python3 Tests/runtime_probe.py --host http://192.168.1.123:9090 --token-env STASH_TOKEN --repetitions 20 --mode performance --out runtime-rc5.json`。
7. 检查 Apple Watch 天气、APNs 锁屏推送、微信小程序、飞书、美团图片、OpenAI/Claude/Gemini 登录、GitHub Release、Telegram/X 图片及视频。初始保持 iOS Stash「包含所有网络」关闭，不改变 VPN/网络开关混淆单变量测试。
8. 汇总完整配置等价结果、所有远程条目的匹配差异、性能 p50/p95/内存、业务通过情况。若存在差异，标记为 `NO-GO`，回滚原 v1.3，不得以性能收益抵消路由错误。

切勿将私人订阅 URL、令牌、节点密钥写入测试报告或 Git 仓库。


## RC5 强制门槛

- 真正下载四个远程列表，检查输出 count/hash；模拟单测不视为在线通过。
- `/rules/match` 中缺 `outbound`、有效规则或序号/评估数时，判定失败。对目前未知的 Stash JSON 返回形式，应采集**脱敏示例**后调整适配，不得将响应不完整算成功。
- `performance` 模式必须成功取到 used/available memory，且每个域名有 ≥20 个合法响应；输出 p95 使用最近秩法。
- 已有的用户自定义 `--out` 目录不得被修改权限；安全权限不足时脚本拒绝写入。不要在共有目录里写私人订阅。
- 不必另外测试旧版本 Stash 的兼容性；以当前设备最新版为准。
