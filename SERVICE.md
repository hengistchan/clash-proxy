# Stash Config Forge

一个无账户、无数据库的完整 Stash 配置生成服务。用户提交私人 GLaDOS YAML 地址，
API 将地址写入 `Production.yaml` 或 `Production-NoAds.yaml` 的占位位置，并把完整
YAML 直接返回给客户端。

## API

```http
GET /api?url=https://your-subscription.example/path&template=production
```

如果订阅地址自身包含 `&` 等查询参数，调用 GET 时必须先对整个地址做 URL 编码。
例如使用 `curl --get --data-urlencode "url=https://..."`，不要手工截断参数。

也支持更适合网页和脚本的安全形式：

```http
POST /api
Content-Type: application/json

{"url":"https://your-subscription.example/path","template":"production"}
```

模板值：

- `production`：完整配置，包含广告拦截。
- `no_ads`：完整配置，不包含广告拦截。

响应为 `application/yaml` 附件，包含：

- `Cache-Control: no-store`
- `Content-Disposition: attachment`
- `X-Config-SHA256`

健康检查：`GET /api/health`。

## 隐私设计

- 服务不抓取订阅 URL，只把它写入配置模板，避免 SSRF。
- 不连接数据库，不把 URL 或生成结果写入磁盘。
- Docker 启动参数使用 `--no-access-log`，避免查询参数进入应用访问日志。
- 网页默认使用 POST；`GET /api?url=...` 保留给直接调用，但私人 URL 可能进入浏览器
  历史记录、反向代理日志或监控系统。
- 公网部署必须启用 HTTPS。反向代理应关闭或脱敏包含 `url` 查询参数的日志。

## 本地运行

```bash
python3 -m venv .venv-service
. .venv-service/bin/activate
python3 -m pip install -r requirements-service.txt
uvicorn service.app:create_app --factory --host 127.0.0.1 --port 8080 --no-access-log
```

打开 <http://127.0.0.1:8080/> 使用网页生成配置；OpenAPI 描述位于
<http://127.0.0.1:8080/api/openapi.json>。

## 持久化容器部署

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8080/api/health
```

`restart: unless-stopped` 使容器在主机重启或异常退出后自动恢复。服务本身是无状态的，
模板打包进镜像；不存在需要备份的私人数据库或订阅文件。更新配置模板时重新构建并
启动：

```bash
git pull --ff-only origin main
docker compose up -d --build
```

默认映射端口为 `8080`，可通过 `.env` 或 shell 设置：

```bash
SERVICE_PORT=8090 docker compose up -d --build
```

## 测试

```bash
python3 -m pip install -r requirements-dev.txt
python3 -m unittest Tests/test_config_service.py -v
```

## 公网反向代理示例

在 Caddy、Nginx 或 Cloudflare Tunnel 后终止 TLS，只暴露容器端口。至少执行：

- 强制 HTTPS。
- 限制请求体大小和请求速率。
- 关闭或脱敏带 `url` 查询参数的访问日志。
- 不允许公网访问 Docker API，不把 `.env` 或私人配置挂载进镜像。
