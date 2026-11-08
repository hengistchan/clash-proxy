import { openapi } from '@/lib/openapi';
export default function ApiDocumentation() {
  return (
    <main className="api-docs">
      <a href="/">← 返回配置管理</a>
      <h1>配置 API 使用文档</h1>
      <p>
        每份配置独立维护节点、订阅来源、策略组和规则。保存后自动检查并生成成功版本，无需在下载时重复传入订阅地址。
      </p>
      <a className="button secondary" href="/api/openapi.json">
        下载 OpenAPI 3.1 规范
      </a>
      <h2>认证与私人数据</h2>
      <p>
        配置了 STASH_ADMIN_TOKEN 时，管理接口接受 Authorization: Bearer
        &lt;token&gt; 或
        X-Admin-Token。未配置令牌的模式仅适合受信任的本机访问。部署时请配置管理员令牌和独立备份的加密密钥。
      </p>
      <p>
        每个 provider 的 sourceUrl 和 sourceHeaders 都是写入字段，加密保存在该
        provider 的配置记录中；列表和快照返回
        sourceType、sourceConfigured、headersConfigured，不回传私人地址或认证请求头。修改一般参数时省略凭据字段即可保留原值；清除必须明确提交
        clearSource / clearHeaders。
      </p>
      <h2>从创建到下载</h2>
      <p>
        下面使用本机地址举例，将 $ADMIN_TOKEN 替换为环境变量中的管理令牌。返回的
        id 用于后续请求，不要假设配置 ID 固定为 1。
      </p>
      <pre>{`# 1. 创建最小配置；也可提交 importYaml，或显式提交 example: true
curl -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"我的配置"}' http://127.0.0.1:3010/api/profiles

# 2. 为每个来源分别保存地址；不同来源使用不同 sourceUrl
curl -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"source-a","sourceType":"remote","sourceUrl":"https://subscription.example/a","config":{"interval":3600}}' \\
  http://127.0.0.1:3010/api/profiles/PROFILE_ID/proxy-providers

# 3. 配置自己的策略组与路由，然后检查
curl -H "Authorization: Bearer $ADMIN_TOKEN" \\
  http://127.0.0.1:3010/api/profiles/PROFILE_ID/validate

# 4. 下载最近成功版本，不传私人 URL 或模板参数
curl -f -H "Authorization: Bearer $ADMIN_TOKEN" \\
  http://127.0.0.1:3010/api/profiles/PROFILE_ID/config_download -o config.yaml`}</pre>
      <h2>下载什么</h2>
      <p>
        <strong>config_download：</strong>完整 YAML，可直接导入 Stash。响应头
        X-Config-Revision 标明实际版本，X-Config-SHA256 是文件摘要，X-Rule-Count
        是导出的有效规则数量。
      </p>
      <p>
        <strong>bundle：</strong>ZIP 包含
        config.yaml、manifest.json、diagnostics.json、README.txt。它不会抓取或内嵌远程资源；引用的远程订阅仍需要联网，本地
        path 对应的文件需要在 Stash
        中准备。该文件包含私人信息，请按私人配置保管。
      </p>
      <p>
        <strong>download-link：</strong>POST 生成固定设备订阅链接，返回 完整
        subscriptionUrl，可直接粘贴到 Stash；同时返回相对
        subscriptionPath。链接包含独立令牌，只授予下载权限；再次 POST
        轮换令牌，DELETE 撤销。持有者能读取完整配置，请勿公开。
      </p>
      <p>
        反向代理部署可通过 STASH_PUBLIC_BASE_URL 指定对外服务地址，确保链接和
        #SUBSCRIBED 使用正确的外部域名。
      </p>
      <p>
        <strong>Shadowrocket：</strong>在同一个 Profile 下使用
        /shadowrocket/config_download 下载 .conf，使用 /shadowrocket/download-link
        创建、更换或撤销远程配置链接。/delivery 的 shadowrocket 字段包含独立的版本、链接及兼容性检查结果。
        将链接添加到 Shadowrocket 的「配置」页。更新时服务会拉取已保存的远程来源；若转换失败，会继续交付最近成功的版本。
      </p>
      <h2>保存、错误与旧版本</h2>
      <p>
        资源保存成功表示草稿已持久化，不等同于所有检查通过。/delivery 返回
        currentRevision、compiledRevision、current、generatedAt 和完整
        configDownloadUrl；current 为 false
        表示新修改尚未生效，下载仍提供最近成功的版本。没有成功版本时下载返回
        409。修复错误并保存后，成功版本自动更新。版本恢复同样触发检查。
      </p>
      <p>
        400 表示输入错误，401 表示管理员认证失败，404
        表示资源或下载链接不存在，409 表示引用冲突或尚无可用配置。JSON
        错误格式为 {`{"detail":"说明","issues":[]}`}。/api?url= 已退役并返回
        410；/export 仅保留无查询参数的 GET 别名。
      </p>
      <h2>资源关联与字段表单</h2>
      <p>
        导入配置后，关联关系页面按实际标识构建路由、策略组、节点、订阅、规则集、DNS
        和可识别的脚本引用。点击资源能查看上下游，再直接创建预选关联的策略组或规则。/relationships
        返回同一份节点和关系数据，未知脚本内部的动态引用不推断。高级区块以字段表单编辑任意嵌套值；专家模式可编辑
        JSON。
      </p>
      <h2>检查的边界</h2>
      <p>
        规则从上到下匹配，MATCH
        位于末尾。平台设置影响进程规则的兼容性提示。覆盖分析支持有限规模的明确域名和
        IP 网段范围，复杂逻辑与外部数据无法证明无冲突。/simulate
        提供本地候选结果与前序不确定项，不解析
        DNS、不抓取订阅、不执行脚本，也不保证节点或业务可用。
      </p>
      <h2>接口目录</h2>
      <table>
        <thead>
          <tr>
            <th>方法</th>
            <th>路径</th>
            <th>用途</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(openapi.paths).flatMap(([path, methods]) =>
            Object.entries(methods)
              .filter(([method]) =>
                ['get', 'post', 'put', 'delete'].includes(method)
              )
              .map(([method, detail]) => (
                <tr key={method + path}>
                  <td>{method.toUpperCase()}</td>
                  <td>
                    <code>{path}</code>
                  </td>
                  <td>{(detail as { summary: string }).summary}</td>
                </tr>
              ))
          )}
        </tbody>
      </table>
      <p>
        字段、请求体和认证定义见上方 OpenAPI
        文件。每份配置的资源独立；标识用于引用，显示名称只用于界面。高级区块与协议字段按原结构保留，产品不按示例名称过滤用户资源。
      </p>
    </main>
  );
}
