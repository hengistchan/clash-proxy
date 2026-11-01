# 真机验收任务：顺序无关覆写

目标是验证完整 9 个覆写集合遵循：

```text
具体服务 > 广告拦截 > Google / Microsoft / Apple 通用规则
```

并确认交换 `10-Ads` 与 `20-General` 的位置不会改变路由，而不是要求新配置与 v1.3
每一条首匹配结果完全相同。

1. 运行 `python3 Scripts/rebuild.py`、`python3 Tests/validate_parity.py`、
   `python3 -m unittest discover -s Tests -p 'test_tool_fixes.py' -v` 和
   `git diff --check`；任一失败立即停止部署。
2. 运行 `python3 Tests/live_remote_check.py`，保存四个上游源的 SHA-256、条数和
   HTTP 状态。在线检查失败不能由离线夹具替代。
3. 配置私有 GLaDOS 订阅，确认 13 个策略组有节点、X5 未错误进入自动/备援组。
4. 导入当前 Core，安装全部 9 个覆写，更新 Ads、Telegram、Twitter、Google 的
   原始远程源及宽泛覆写中的独立镜像源；通过只读 API 对照 `/rules`、
   `/providers/rules` 和 `/providers/proxies`。
5. 在中性网络下记录完整配置的基准 `/rules/match`。至少覆盖：
   `doubleclick.net`、普通 Google 广告、`gemini.google.com`、
   `ads.youtube.com`、`ad.qq.com`、`events.statsigapi.net`、
   `courier.push.apple.com`、`guzzoni.apple.com`、Telegram/Twitter、
   GitHub、YouTube、`google.com`、`microsoft.com`。
6. 只交换 `10-Ads` 与 `20-General` 的规则数组位置，重新加载后重跑同一组探针。
   两次的代表域名 `outbound`/`proxy` 必须一致；`ruleIndex` 可以变化，
   `evaluatedRules` 和 p95 的差异单独记录，不能用来掩盖路由差异。
7. 分别执行 20 次以上功能采样和性能采样：

   ```bash
   python3 Tests/runtime_probe.py --host http://192.168.1.123:9090 \
     --token-env STASH_TOKEN --repetitions 20 --mode functional \
     --out runtime-order-a.json
   ```

   交换顺序后保存另一份报告。
8. 检查 Apple Watch 天气、APNs、微信、飞书、美团图片、OpenAI/Claude/Gemini、
   GitHub Release、Telegram/X 和 YouTube。任何具体服务被广告或 General 抢占均
   标记 `NO-GO`，回滚 `Production-Legacy-v1.3.yaml`。

禁止把私人订阅 URL、令牌、节点密钥或未脱敏响应写入报告或 Git 仓库。

## 强制门槛

- 四个原始远程 URL 真实可下载；离线代表夹具不算在线通过。
- Ads/General 自包含 provider 均成功加载，交换顺序时没有未定义 provider、
  配置解析失败或候选域名落到错误宽泛规则。
- `/rules/match` 必须包含可识别 `outbound`/`proxy`、有效规则，以及
  `ruleIndex`/`index`/`evaluatedRules`/`rulesEvaluated` 之一；缺字段不算成功。
- `performance` 模式必须取得 used/available memory，且每个域名至少 20 个合法样本。
- 只修改 `--out` 指定报告，不修改已有私人目录权限，不把 token 放进命令行参数。
