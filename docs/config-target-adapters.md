# 配置客户端适配器

编辑器和资源仓库只处理同一份配置快照。保存时由编译调度器遍历已注册客户端；每个适配器独立验证、生成及保留最后一次成功的产物。历史清理由编译适配器提供需要保留的修订。设备下载由交付适配器处理认证后的文件或固定令牌；共享的 HTTP 处理负责管理认证、错误格式和缓存策略。

新增 Clash 等客户端：

1. 在 `lib/config-targets.ts` 注册客户端名称、管理 API 路径及文件标签。下载页会自动读取列表。
2. 新建客户端自己的规则映射、产物存储和兼容性诊断；在 `lib/compilation.ts` 注册编译和修订保留方法。无需修改 Stash 或 Shadowrocket 的转换逻辑。
3. 在 `lib/config-delivery-adapters.ts` 注册状态、文件和链接方法。路由通过 `configTargetHandlers(id)` 接入；新增客户端应使用独立的下载路径和令牌范围。

`GET /api/profiles/:id/delivery` 的 `targets` 按客户端 ID 返回状态。旧的 Stash 顶层字段、`shadowrocket` 字段和已有下载地址继续可用。转换器的版本与产物的安全可用版本分开管理；扩展转换范围时仍可保留经过验证的旧产物。
