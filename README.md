# gemini-rt-get

批量导入 Google 账号，自动完成 Antigravity OAuth 登录并提取 refresh token（RT）。

## 一键部署

```bash
git clone https://github.com/yukaijun2001/gemini-rt-get.git
cd gemini-rt-get
./deploy.sh
```

脚本会依次完成：

- 自动安装缺失的 git / curl / Docker（Linux 用官方脚本，macOS 需已装 Docker Desktop）
- 拉取 `main` 最新代码（`git reset --hard origin/main`，本地改动会被覆盖）
- 检测服务器局域网 IP，自动生成 `.env` 并注入端口和 IP
- 构建并启动容器、放行 ufw 端口、等待健康检查通过
- 输出本机与手机访问地址

端口默认 `20000`，可用 `PORT=8080 ./deploy.sh` 修改；应用目录默认脚本所在目录，可用 `APP_DIR=/opt/gemini-rt-get` 指定。
浏览器并发槽位默认 2，可用 `CONCURRENCY=3 ./deploy.sh` 或写在 `.env` 中调整（建议不超过 5）。

## Docker 使用（推荐）

可选：复制模板调整端口/并发（无需填 OAuth 凭证）：

```bash
cp .env.example .env
```

```bash
./scripts/docker-up.sh
```

脚本会自动探测服务器局域网 IP 并打印访问地址（如 `http://192.168.1.10:20000`）。也可以手动指定：

```bash
HOST_IP=192.168.1.10 docker compose up -d --build
```

不指定 IP 时直接 `docker compose up -d --build` 也能用，页面打开后会显示当前实际访问地址。

```bash
docker compose logs -f      # 查看启动日志
docker compose down         # 停止
```

镜像内用 Xvfb 提供虚拟显示，Chrome 仍在有头模式运行（仅最小化），避免无头浏览器被风控。

## 本地使用

```bash
npm install
npm start
```

默认端口 20000，可用 `PORT=xxxx` 覆盖。按行粘贴账号：

```
邮箱----密码----2FA密钥
```

2FA 密钥支持 Base32（空格可有可无）或 `otpauth://totp/...?secret=...` 链接。点「开始提取」后：

- 每个槽位只放一个账号；点「+ 添加槽位」增加，任务按 `CONCURRENCY`（默认 2）并行执行，超出排队。
- 某个槽位失败后可单独「重置」，不影响其他槽位。
- 浏览器以有头模式启动后立即最小化（CDP `windowState: minimized`），每个账号单独 profile。
- 自动填邮箱/密码，选择「身份验证器」，用本地算法生成 TOTP，完成同意页。
- 捕获 `http://localhost:20000/oauth-callback` 的授权码，用 Antigravity client 兑换 RT。
- 结果以卡片展示，可一键复制；失败时保留页面截图（`recordings/<任务ID>.png`）。

账号按提交顺序串行处理，重启服务会清空任务记录，`recordings/` 与 `profiles/` 可随时删除。

## 说明

- 复用 antigravity2api 的 Antigravity `client_id` / `client_secret` 与 `localhost:20000` 回调，不做 projectId / 配额校验。
- 登录入口使用标准 `https://accounts.google.com/o/oauth2/v2/auth`，每次都会生成新的 `dsh` 会话；直连 v3 `accountchooser` 固定链路容易 400。
- 输出仅为 RT，用于后续 `oauth2.googleapis.com/token` 刷新 access token。
