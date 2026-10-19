<p align="center">
  <img src="screenshots/poster.png" width="100%" alt="Faro：访问服务器与云存储中的文件" />
</p>

<h1 align="center">Faro</h1>

<p align="center"><strong>File &amp; Agent Remote Operations</strong></p>

<p align="center"><strong>一款现代桌面客户端，支持 SFTP、FTP、SSH、S3 兼容存储、WebDAV 及云存储。</strong></p>

<p align="center">
  <a href="https://github.com/jhd3197/faro/releases/latest"><img src="https://img.shields.io/github/v/release/jhd3197/faro?style=flat-square&amp;color=e9bd69&amp;labelColor=181e28" alt="最新版本" /></a>
  <a href="https://github.com/jhd3197/faro/releases"><img src="https://img.shields.io/github/downloads/jhd3197/faro/total?style=flat-square&amp;color=e9bd69&amp;labelColor=181e28" alt="下载量" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-MIT-e9bd69?style=flat-square&amp;labelColor=181e28" alt="MIT 许可证" /></a>
  <a href="https://discord.gg/ZKk6tkCQfG"><img src="https://img.shields.io/badge/Discord-Faro-e9bd69?style=flat-square&amp;labelColor=181e28" alt="加入 Discord" /></a>
</p>

<p align="center"><a href="https://github.com/jhd3197/faro/releases/latest">下载 Faro</a> · <a href="https://www.youtube.com/watch?v=nL9r3c9-5Kc">观看演示</a> · <a href="#screenshots">查看截图</a> · <a href="#transfers">文件传输</a> · <a href="#agent-bridge">Agent Bridge</a> · <a href="#develop">从源码构建</a></p>

<p align="center"><a href="../README.md">English</a> · <a href="README.es.md">Español</a> · 中文版 · <a href="README.pt.md">Português</a></p>

**Faro 是适用于 Windows、macOS 和 Linux 的桌面文件客户端。** 连接服务器或云账户，在双窗格中浏览文件并传输文件夹。你可以在同一工作区打开 SSH 终端，用自己的编辑器修改远程文件，或通过 Agent Bridge 授权本地 AI 智能体访问会话。

<p align="center">
  <a href="#backends"><img src="images/readme/zh-CN/backends.svg" width="260" alt="17 种连接类型：服务器、存储桶、云盘与 CMS" /></a>
  <a href="#quick-start"><img src="images/readme/zh-CN/platforms.svg" width="260" alt="3 个桌面平台：Windows、macOS 和 Linux" /></a>
  <a href="#cli"><img src="images/readme/zh-CN/interfaces.svg" width="260" alt="GUI、CLI 以及 MCP 桥接，支持手动浏览和脚本操作" /></a>
</p>

<a name="quick-start"></a>
<a name="-快速开始"></a>
## 快速开始

从[最新版本](https://github.com/jhd3197/faro/releases/latest)中选择适合你的安装包。

| 平台 | 下载格式 |
|---|---|
| **Windows · x64** | `.exe` 安装程序、`.msi` 或便携版 `.zip` |
| **macOS · Intel + Apple Silicon** | 通用版 `.dmg` |
| **Linux · x64** | `.AppImage`、`.deb` 或 `.rpm` |

打开 **New Connection**，选择连接类型并填写连接信息。也可以从 `~/.ssh/config`、FileZilla 或 PuTTY 导入配置。

<details>
<summary><strong>首次启动：Windows 和 macOS 构建尚未签名</strong></summary>

Faro 的桌面构建尚未经过 Apple 公证，也没有 Windows 代码签名证书。

- **Windows：**在“Windows 已保护你的电脑”提示中，选择**更多信息 → 仍要运行**。
- **macOS：**将 Faro 拖入“应用程序”。如果 macOS 提示应用已损坏，运行一次以下命令：

  ```bash
  xattr -cr /Applications/Faro.app
  ```

- **Linux AppImage：**使用 `chmod +x <文件名>.AppImage` 为下载的文件添加执行权限。

</details>

<!-- FARO:SHOTS:START -->
<a name="screenshots"></a>
<a name="-截图"></a>
## 截图

### 本地文件与远程文件，并排浏览

在连接栏中管理服务器，在窗格之间拖放文件，并将常用文件夹保存为站点快捷方式。

![双窗格文件浏览器：左侧为本地文件夹，右侧为 SFTP 服务器](screenshots/overview.png)

<sub>截图使用虚构数据，包括主机名、路径和传输速度。截图中的应用界面为英文。 [复现截图（英文）](screenshots/CAPTURE.md).</sub>

| 在工作区中打开终端 | 查看磁盘空间占用 |
|---|---|
| ![在工作区中打开终端](screenshots/terminal.png) | ![查看磁盘空间占用](screenshots/disk-usage.png) |
| 在文件浏览器旁使用 SSH shell。 | 通过矩形树图和按大小排序的目录树查看文件夹。 |

<details>
<summary><strong>更多视图：传输、同步、云存储与设置</strong></summary>

| 传输队列 | 目录同步 |
|---|---|
| ![传输队列](screenshots/transfers.png) | ![目录同步](screenshots/sync.png) |

| 对象存储 | 连接栏 |
|---|---|
| ![对象存储](screenshots/object-storage.png) | ![连接栏](screenshots/server-rail.png) |

| Agent Bridge | 命令审批 |
|---|---|
| ![Agent Bridge](screenshots/agent-bridge.png) | ![命令审批](screenshots/agent-bridge-approve.png) |

| 新建连接 | 设置 |
|---|---|
| ![新建连接](screenshots/new-connection.png) | ![设置](screenshots/settings.png) |

![文件操作菜单](screenshots/context-menu.png)

</details>
<!-- FARO:SHOTS:END -->

<a name="features"></a>
<a name="-功能特性"></a>
## 功能

| 文件与连接 | 日常工具 |
|---|---|
| **浏览与传输。** 双窗格、拖放、递归文件夹传输，以及覆盖、跳过或重命名选项。 | **编辑远程文件。** 用本地编辑器打开文件，保存时上传更改。 |
| **同步文件夹。** 预览两个位置之间的增量添加或镜像同步计划，也可设置带排除规则的持续本地到远程同步。 | **比较与搜索。** 比较不同服务器上的目录、核对文件哈希，或按名称和内容搜索。 |
| **保存常用位置。** 为连接分组，将文件夹保存为站点快捷方式，沿用主连接的凭据和权限。 | **键盘操作。** 使用命令面板、面包屑路径、筛选器和可排序列。 |
| **连接不同服务。** 在同一连接列表中使用 SSH 服务器、对象存储、云盘和 CMS API。 | **批量自动化。** 通过 Fleet Skills、CLI 或 MCP 工具，在多台服务器上执行保存的 shell 工作流。 |

<a name="transfers"></a>
## 文件传输

将上传和下载加入队列、暂停任务、重试失败操作，并设置带宽上限。Faro 使用 SFTP 流水线读取，并在支持的数据源上进行并行分段下载。

<p align="center">
  <img src="images/readme/zh-CN/pipeline.svg" width="400" alt="SFTP 下载：每个分段最多 32 个并发读取请求；服务器未提供限制信息时从 16 个开始。这是并发上限，不是速度测试结果。" />
  <img src="images/readme/zh-CN/resume.svg" width="400" alt="断点续传会保留已完成的分段，并重试缺失的数据。是否支持续传取决于数据源。" />
</p>

| 传输场景 | Faro 的处理方式 |
|---|---|
| **大文件下载** | 对支持的数据源进行分段，并在传输过程中调整并发数。 |
| **下载中断** | 保留部分数据及续传元数据。不支持按位置读取的数据源会从头重新下载。 |
| **文件夹上传** | 入队前清点文件和目录，检查远程文件大小，并报告部分失败。 |
| **完整性检查** | 除上传大小检查外，还可在支持的场景下使用校验和验证。 |

卡片描述的是传输引擎的行为，并非实测速度。仓库尚未发布与其他客户端的可复现性能对比。[真实服务器传输测试](../src-tauri/src/transfer/live_tests.rs)在已配置的测试服务器上检查吞吐量与完整性；[流水线源码](../src-tauri/src/transfer/sources.rs)定义了 SFTP 的并发限制。

<a name="backends"></a>
## 连接类型

在同一个文件浏览器中使用 **17 种连接类型**。可用操作取决于具体服务：存储桶没有 shell，HTTP 为只读，CMS 连接仅提供其支持的资源。

| 类别 | 支持的服务 |
|---|---|
| **服务器** | SFTP、FTP 和显式 FTPS |
| **对象存储** | S3 兼容存储、Azure Blob、Google Cloud Storage |
| **Web 存储** | WebDAV，包括 Nextcloud 和 ownCloud；只读 HTTP(S) 目录索引和直链 |
| **云盘** | Dropbox、OneDrive、Google Drive、Box |
| **商店与 CMS** | Shopify 主题；HubSpot Design Manager、文件资源和只读 HubDB 导出；Dynamics 365 / Dataverse Web 资源；WordPress 媒体和 REST 资源 |
| **远程设备** | Windows、macOS 和 Linux 上的 Faro Agent |

S3 预设包括 AWS、Cloudflare R2、Backblaze B2、Wasabi、DigitalOcean Spaces、MinIO、Storj、Hetzner、Scaleway、Oracle OCI、IBM COS 和 Supabase，也支持通用 S3 端点。云盘通过浏览器进行 OAuth 登录，并将刷新令牌保存在操作系统钥匙串中。

<a name="agent-bridge"></a>
<a name="-agent-bridge"></a>
## Agent Bridge

**让本地 AI 智能体使用你已在 Faro 中打开的服务器会话。** 通过 localhost 端点连接 Claude Code 或其他 MCP 客户端。你可以选择允许访问的会话，并在 Faro 中审核命令，无需将服务器凭据交给智能体。

<picture>
  <source media="(max-width: 600px)" srcset="images/readme/zh-CN/bridge-mobile.svg" />
  <img src="images/readme/zh-CN/bridge.svg" width="100%" alt="本地 AI 智能体 → localhost 上的 MCP → Faro 与你的审批策略 → 已认证的服务器会话" />
</picture>

1. 连接服务器，打开 **Bridge**，选择 **Start**，并为会话启用 **Allow agent access**。
2. 复制面板生成的命令。Claude Code 的命令格式如下：

   ```bash
   claude mcp add --transport http faro http://127.0.0.1:<port>/mcp \
     --header "Authorization: Bearer <token>"
   ```

3. 请智能体检查服务器。Faro 提供会话、命令、文件、搜索和工作流工具，审批请求及活动记录会显示在 Bridge 面板中。

桥接服务绑定到 `127.0.0.1`，要求使用每次启动生成的 bearer 令牌，并将访问范围限制为你启用的会话。命令默认需要审批，你也可以配置审批策略。面板记录命令、批准和拒绝操作，并可导出供 HTTP API 智能体使用的 `SKILL.md`。

## Faro Agent

无需配置 SSH，即可浏览另一台 Windows、macOS 或 Linux 设备上的文件并执行原生命令。在受控设备上打开 **Settings → Remote control**，启用后显示配对码。在另一台设备上添加 **Faro Agent** 连接，输入六位配对码。

对于无图形界面的 Linux 或 macOS 设备，可使用智能体安装程序：

```bash
curl -fsSL https://github.com/jhd3197/Faro/releases/latest/download/install-agentd.sh | sh
```

<details>
<summary><strong>守护进程命令与连接安全</strong></summary>

```bash
faro-agentd pair                 # 提供服务并开启配对窗口
faro-agentd run                  # 为已配对的控制端提供服务
faro-agentd install              # 安装为系统服务
faro-agentd install --read-only  # 将服务限制为只读操作
faro-agentd info                 # 显示身份与已配对的控制端
```

智能体使用基于 X25519 和 ChaCha20-Poly1305 的 Noise 握手、配对码验证及对等端密钥固定。受控设备执行自身的访问策略并记录审计日志。局域网发现使用 mDNS；互联网会合服务和中继支持仍在规划中。详见[远程智能体指南（英文）](remote-agent.md)。

</details>

## CLI

在终端中使用同一组已保存的连接配置。从[发布页面](https://github.com/jhd3197/faro/releases/latest)下载 `faro-cli`。

```bash
faro-cli profiles list
faro-cli ls prod:/var/log
faro-cli cp ./report.pdf prod:/var/www/uploads
faro-cli sync ./site prod:/var/www/site --mirror --dry-run
faro-cli diff prod:/etc staging:/etc --hash
faro-cli search prod:/var/log "OutOfMemory" --content --regex
faro-cli agent exec prod 'journalctl -u api -n 100'
```

使用 `连接名:/路径` 引用已保存的连接，使用普通路径引用本地文件。CLI 还支持文件操作、shell 命令、Bridge 任务、Fleet Skills、带身份验证的 HTTP 请求及自身更新。查看[更多示例和构建说明（英文）](development.md#cli)。

<a name="develop"></a>
## 开发

安装 Node 20+、Rust 1.88+ 及[开发指南（英文）](development.md)中列出的平台依赖，然后运行：

```bash
npm install
npm run tauri dev
```

<a name="-架构"></a>
Faro 使用 **Tauri 2、Rust、React 和 TypeScript**。桌面应用和 CLI 共享 Rust 核心及 `RemoteFs` 接口。查看[架构、项目布局和 Windows 构建说明（英文）](development.md)。

<a name="-文档"></a>
## 文档

以下技术指南为英文。

| 指南 | 内容 |
|---|---|
| [开发](development.md) | 架构、构建、CLI 示例及 README 图形素材 |
| [远程智能体](remote-agent.md) | 配对、协议与安全 |
| [深度链接](deep-links.md) | `faro://` 连接链接 |
| [HubSpot 配置](hubspot-private-app.md) | 私有应用配置 |
| [截图](screenshots/CAPTURE.md) | 使用模拟数据拍摄及复现截图 |
| [更新程序密钥保管](updater-key-custody.md) | 签名密钥管理 |

<a name="-路线图"></a>
## 路线图

计划中的工作包括 SMB/CIFS、带冲突解决的双向同步、按需虚拟文件夹、Faro Agent 互联网连接及桌面代码签名。已发布的更改见[版本记录](https://github.com/jhd3197/faro/releases)，讨论和建议见[Issues](https://github.com/jhd3197/faro/issues)。

<a name="-参与贡献"></a>
## 参与贡献

欢迎改进连接后端、传输可靠性、界面、测试和文档。较大的改动请先[提交 Issue](https://github.com/jhd3197/faro/issues)讨论，也可提交附有说明和验证步骤的 pull request。

## 支持 Faro

Faro 免费且开源。你可以通过 [GitHub Sponsors](https://github.com/sponsors/jhd3197) 或 [Buy Me a Coffee](https://buymeacoffee.com/jhd3197) 支持开发，或[为仓库加星](https://github.com/jhd3197/faro)。

<details>
<summary><strong>加密货币捐赠</strong></summary>

| | 资产 | 网络 | 地址 |
|:---:|---|---|---|
| <img src="images/funding/usdt-trc20.png" width="110" alt="捐赠二维码: USDT TRC-20" /> | **USDT** | **TRC-20** · Tron | `TTiCtqLauF1iSW2YGB3b78KmRxRqoLCgeL` |
| <img src="images/funding/usdt-erc20.png" width="110" alt="捐赠二维码: USDT and ETH ERC-20" /> | **USDT / ETH** | **ERC-20** · Ethereum | `0xD13D5355Fa214e8317fea2ff192a065BaeC13527` |
| <img src="images/funding/btc.png" width="110" alt="捐赠二维码: Bitcoin" /> | **BTC** | **Bitcoin** | `bc1qatx67n3qxdvuv3arc9j8aytk34f22g02k9c7vr` |
| <img src="images/funding/sol.png" width="110" alt="捐赠二维码: Solana" /> | **SOL** | **Solana** | `AWXzqtBEgUfteHPQtDegsZ6D5y57M3GGdKPD8rR7h6xu` |

</details>

## 相关项目

- **[ServerKit](https://github.com/jhd3197/ServerKit)：**通过浏览器管理 Web 应用、数据库、Docker 容器及服务器安全。
- **[LocalKit](https://github.com/jhd3197/LocalKit)：**使用 Docker Compose 运行本地 WordPress 站点，并连接到 ServerKit。
- **[DeviceKit](https://github.com/jhd3197/DeviceKit)：**管理 Android 设备、执行自动化任务，并在多台设备上测试应用。

<a name="-社区"></a>
## 社区

加入 [Faro Discord](https://discord.gg/ZKk6tkCQfG)，获取配置帮助、反馈问题或参与讨论。请在 [GitHub Issues](https://github.com/jhd3197/faro/issues) 中报告错误和提交功能请求。

## 许可证

[MIT](../LICENSE)。由 [Juan Denis](https://juandenis.com) 创建。
