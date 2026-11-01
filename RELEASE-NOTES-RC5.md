# RC5 VerifiedTools · 2026-11-01

**仅修复验收工具，路由配置零变更。** 无需在 Stash 重新导入 Core 或覆写（若 RC4 已部署）；只需要替换本地工程脚本。

修复：`utf8-sig` 拼写；禁止对已有目录 `chmod`；最近秩法 p95；响应缺出站/规则/序号必须失败；内存等关键指标缺失不能通过性能验收。

新增 `Tests/test_tool_fixes.py`：10 项无网络回归测试，含失败用例、防误提交和脱敏验证。

验收：`Scripts/rebuild.py` PASS（34 个生成物）；`Tests/validate_parity.py` STATIC_PARITY_PASS（450 项）；10/10 工具测试 PASS；37 个原 RC4 配置/规则/源数据文件逐字节一致。

仍待真实设备/在线验证：四个 Repcz 上游源实际获取；真实 Stash `/rules/match` 返回 JSON 结构；Apple Watch 天气、APNs、业务服务、性能 A/B。即使本地检查通过也不表示生产 GO。

## 本地验收命令

```bash
python3 -m pip install PyYAML
python3 Scripts/rebuild.py
python3 Tests/validate_parity.py
python3 -m unittest discover -s Tests -p 'test_tool_fixes.py' -v
python3 Tests/live_remote_check.py
```

真实设备测试时从环境变量提供 `STASH_TOKEN`，运行 `Tests/runtime_probe.py --host http://192.168.1.123:9090 --mode performance --repetitions 20 --out runtime-rc5.json`，其中 IP 改为自己的 iPhone 地址。
