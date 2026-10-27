# DSH ChatGPT OAuth 插件

[English](README.md)

独立社区插件 `dsh-llm-oauth`，本机定制版本 **0.2.0-local.2**，适配 DeepSeek Harness Desktop **0.2.1-rc.3**。此版本通过 ChatGPT 登录流程连接 `openai` 路由，登录后读取账户可用模型。这是上游插件的本地衍生版本，不代表新的上游正式发布。

## 运行文件与依赖

本目录包含预构建的 `lib/index.js` 和 `lib/client.js`，公开运行源码无需重新编译 TypeScript 或执行 `prepare`。三个直接运行依赖固定为 `@earendil-works/pi-ai` **1.3.0**、`jose` **6.1.3**、`proper-lockfile` **4.1.2**；还需安装它们的传递依赖。本目录不携带依赖目录。

使用符合 `package.json` 要求的 Node.js（`^22.19.0 || >=24.0.0`）和 pnpm，在本目录恢复生产依赖，并跳过生命周期脚本：

```sh
pnpm install --prod --ignore-scripts
```

`@deepseek-ai/*` 和 React 等 peer 依赖由 DSH profile 提供。本插件需要宿主，不能当作独立应用运行。移动或注册本目录时应确保运行依赖仍可用。

## 注册到 DSH

将以下占位路径替换为本源码目录的绝对路径，使用目标桌面安装对应的 DSH CLI：

```powershell
dsh plugin --profile desktop add "C:\path\to\oauth-source"
```

注册后重启 DSH，在设置的 OAuth / ChatGPT 订阅页面按需开启 `openai`，并在系统浏览器完成登录。公开 bundle 默认 `providers: {}`，安装不会自动开启路由。已有的 `openai` API Key 路由与本插件的订阅路由存在冲突，同一路由只能由一个提供方注册。

此定制版本仅面向新版 ChatGPT 路由。旧的独立 CLI 登录入口 `bin/login.mjs` 已停用，只提示前往 DSH 设置登录；上游旧说明中的其他订阅或 legacy 设备码流程不适用于本版本。

凭据在本机生成，默认位于 `<DSH_HOME>/openai-chatgpt-local/credentials.json`，也可由配置指定其他路径。凭据不属于源码分发内容；不要上传凭据、profile 设置或登录回调数据。

## 公开源码

`SHA256SUMS.txt` 校验公开分发文件。公开目录仅保留预构建运行代码、清单、bundle patch、最小文档和 MIT 许可证；不包含测试、开发依赖、source map、截图、本机记录或凭据。恢复运行依赖需要访问包注册表，本目录不属于离线安装包。

MIT，见 [LICENSE](LICENSE)。上游源码：[ziyou979/dsh-llm-oauth](https://github.com/ziyou979/dsh-llm-oauth)，基础提交 `da363b000e325f244bd666a82394e5d59ad18ec7`。本地定制版本继续保留 `0.2.0-local.2`。
