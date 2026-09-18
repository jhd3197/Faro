<div align="center">

<img width="100%" alt="Faro — 面向服务器与云存储的现代文件访问工具" src="screenshots/poster.png" />

# Faro

**File & Agent Remote Operations**

FARO 是“File & Agent Remote Operations”的缩写，意为“文件与智能体远程操作”。

**一款现代化的桌面客户端，支持 SFTP、FTP、SSH、S3 兼容存储、WebDAV 及云存储。**

只需保存一次服务器，即可在双窗格视图中浏览其文件，并基于同一会话打开终端——
此外还有一个 **Agent Bridge**，让 Claude Code（或任何 MCP 代理）通过你已认证的
会话在机器上执行命令，逐条命令审批，零凭据共享。

[English](../README.md) | [Español](README.es.md) | 中文版 | [Português](README.pt.md)

<br>

![Windows](https://img.shields.io/badge/Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)
[![Discord](https://img.shields.io/discord/1470639209059455008?style=for-the-badge&logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/ZKk6tkCQfG)
[![观看演示](https://img.shields.io/badge/%E8%A7%82%E7%9C%8B%E6%BC%94%E7%A4%BA-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://www.youtube.com/watch?v=nL9r3c9-5Kc)

[![GitHub Stars](https://img.shields.io/github/stars/jhd3197/faro?style=flat-square&color=f5c542)](https://github.com/jhd3197/faro/stargazers)
[![Downloads](https://img.shields.io/github/downloads/jhd3197/faro/total?style=flat-square)](https://github.com/jhd3197/faro/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](../LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.24-8b7ff6.svg?style=flat-square)](https://github.com/jhd3197/faro/releases)
[![Tauri](https://img.shields.io/badge/tauri-2-24C8D8.svg?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/rust-1.88+-DEA584.svg?style=flat-square&logo=rust&logoColor=black)](https://rust-lang.org)
[![React](https://img.shields.io/badge/react-18-61DAFB.svg?style=flat-square&logo=react&logoColor=black)](https://reactjs.org)

<br>

[下载](#-快速开始) · [截图](#-截图) · [功能](#-功能特性) · [Agent Bridge](#-agent-bridge) · [架构](#-架构) · [路线图](#-路线图) · [文档](#-文档) · [参与贡献](#-参与贡献) · [Discord](#-社区)

</div>

---

## 🚀 快速开始

> ⏱️ 下载、连接、传输——不到一分钟

从 [**Releases**](https://github.com/jhd3197/faro/releases/latest) 页面获取最新安装包——每次推送到 `main` 都会为三个桌面平台以及独立的 `faro-cli` 发布全新构建。

| 平台 | 安装包 | 首次启动说明 |
|---|---|---|
| **macOS**（Intel + Apple Silicon） | `.dmg`（通用） | 一次性 `xattr` 步骤 ↓ |
| **Windows**（x64） | `.exe`（NSIS）或 `.msi` | SmartScreen → *更多信息 → 仍要运行* |
| **Linux**（x64） | `.AppImage`、`.deb`、`.rpm` | 对 AppImage 执行 `chmod +x` |

构建**未签名**（尚无 Apple Developer / Windows EV 证书），因此每个操作系统都会拦截首次启动：

- **macOS** —— 将 **Faro.app** 拖入 **/Applications** 后，在终端中运行一次以下命令，然后正常打开应用：
  ```bash
  xattr -cr /Applications/Faro.app
  ```
  之所以需要这一步，是因为构建未经 Apple 公证；否则 macOS 会报告应用"已损坏"。
- **Windows** —— 在 *"Windows 已保护你的电脑"* 提示中，点击 **更多信息 → 仍要运行**。

> 想从源码构建？参见下文 [开发](#开发)。

<!-- FARO:SHOTS:START -->
## 📸 截图

> 截图来自使用模拟数据的构建——下方所有主机名、IP、用户名和路径均为虚构。截图清单及复现方法请参见 [`docs/screenshots/CAPTURE.md`](screenshots/CAPTURE.md)。

|                          双窗格浏览器                          |                          磁盘使用情况分析器                          |
| :-----------------------------------------------------------------: | :-------------------------------------------------------------------: |
|        ![双窗格浏览器](screenshots/overview.png)          |       ![磁盘使用情况分析器](screenshots/disk-usage.png)         |
| _本地与远程并排显示，之间可拖放传输_ | _适用于任意后端的 WinDirStat 风格矩形树图，带服务器端快速通道_ |

|                             服务器边栏                             |                        集成终端                        |
| :-----------------------------------------------------------------: | :---------------------------------------------------------------: |
|          ![服务器边栏](screenshots/server-rail.png)           |          ![集成终端](screenshots/terminal.png)          |
| _Discord 风格的连接气泡，支持可展开的标签模式_ | _基于你正在浏览的同一会话打开的真实 SSH shell 标签页_ |

|                             Agent Bridge                             |                          对象存储                          |
| :------------------------------------------------------------------: | :--------------------------------------------------------------: |
|        ![Agent Bridge](screenshots/agent-bridge.png)        |        ![对象存储](screenshots/object-storage.png)        |
| _审批（或自动审批）AI 代理在实时会话中执行的每条命令_ | _像浏览文件系统一样浏览 S3 存储桶，与 SFTP 服务器并存_ |

|                             传输                             |                          目录同步                          |
| :---------------------------------------------------------------: | :--------------------------------------------------------------: |
|          ![传输面板](screenshots/transfers.png)          |            ![目录同步](screenshots/sync.png)            |
| _带进度和覆盖提示的排队下载/上传_ | _在任何文件移动之前预览单向同步计划_ |

<details>
<summary><strong>查看全部截图</strong></summary>

<br>

|                          文件操作                          |                       Agent Bridge 审批                        |
| :------------------------------------------------------------: | :----------------------------------------------------------------: |
| ![文件操作上下文菜单](screenshots/context-menu.png) | ![Agent Bridge 审批提示](screenshots/agent-bridge-approve.png) |
| _复制、属性、"将文件夹下载为 .tar.gz/.zip"、"在此处打开终端"_ | _每条代理命令在执行前都会原样弹出提示_ |

|                          新建连接                          |                             设置                             |
| :--------------------------------------------------------------: | :--------------------------------------------------------------: |
|      ![新建连接](screenshots/new-connection.png)      |          ![设置](screenshots/settings.png)          |
| _一个配置文件编辑器覆盖全部十三种后端，协议选择器位于边栏_ | _主题、终端行为、传输设置以及默认编辑器_ |

</details>
<!-- FARO:SHOTS:END -->

## 🎯 功能特性

> **一个连接列表，十三种后端。** 浏览、传输、同步，以及磁盘占用 / 差异对比 / 搜索工具在每种后端上的表现完全一致——全部基于单一的 `RemoteFs` trait。

### 📡 后端与存储

| | |
|---|---|
| **SFTP / FTP / FTPS**<br>经典协议，做到位——文件浏览器与终端窗格共享同一条 SSH 会话。 | **S3 兼容存储**<br>预置 AWS、Cloudflare R2、Backblaze B2、Wasabi、DigitalOcean Spaces、MinIO、Storj、Hetzner、Scaleway、Oracle OCI、IBM COS、Supabase 以及通用自托管方案（Ceph RGW、Garage、SeaweedFS）。 |
| **Azure Blob 与 Google Cloud Storage**<br>与你的服务器并列的一流对象存储。 | **WebDAV 与 HTTP(S)**<br>浏览 Nextcloud / ownCloud，另有只读 HTTP autoindex 和直接 URL 源。 |
| **云盘**<br>Dropbox、OneDrive、Google Drive 和 Box——loopback + PKCE OAuth，仅将刷新令牌存入操作系统钥匙串。 | **Faro Agent**<br>Faro 自有的配对代理作为后端——在没有 SSH 服务器的机器上浏览、传输和执行。 |

### 🔁 传输与同步

| | |
|---|---|
| **拖放传输**<br>窗格之间传输，支持递归目录、多选、覆盖/跳过/重命名策略，以及大于 16 MB 对象的分段上传。 | **目录同步**<br>预览单向计划（增量或镜像），然后执行——适用于任意两种后端。 |
| **持续文件夹同步**<br>将本地文件夹绑定到远程路径即可保持镜像——监视器 + 轮询协调器，支持排除模式和镜像删除上限。 | **就地编辑**<br>用本地编辑器打开远程文件；每次保存自动上传，状态栏上有实时指示。 |

### 🔎 浏览、对比与搜索

| | |
|---|---|
| **磁盘使用情况分析器**<br>适用于任意后端的 WinDirStat/WizTree 风格矩形树图 + 按大小排序的目录树，带 shell `du`/`find` 快速通道。 | **目录差异对比**<br>面向任意两种后端的 Meld/Beyond-Compare——包括**远程 ↔ 远程**（预发 vs 生产、两个存储桶）。按大小或 `--hash` 对比。 |
| **Fleet Search**<br>按名称或内容查找——在 SSH 和 Agent 服务器上服务端执行 `rg`/`grep`，在存储桶上平铺列出键。 | **CLI 对齐**<br>三者均已加入 `faro-cli`（`diff`、`search`），并作为 MCP 工具（`faro_diff`、`faro_search`）暴露。 |

### 🤖 AI 与自动化

| | |
|---|---|
| **Agent Bridge**<br>将你已认证的会话借给 Claude Code 或任何 MCP 代理——仅限 localhost，bearer 令牌，逐条命令审批。[详情 ↓](#-agent-bridge) | **Fleet Skills**<br>可由 AI 编写、跨服务器扇出执行的多步骤 shell 工作流——AI 编写的技能会以提案形式落地，需要人工批准一次。 |
| **原生 MCP**<br>在 Claude Code 中自动发现工具；为纯 HTTP 代理提供可直接粘贴的 `SKILL.md`。 | **实时审计日志**<br>每条命令、批准和拒绝，都直接显示在 Bridge 面板中。 |

### 🖥️ 远程机器与会话

| | |
|---|---|
| **Faro Agent**<br>控制一台没有 SSH 服务器的 Windows/macOS/Linux 机器——6 位配对码，Noise 加密，密钥固定。[详情 ↓](#-faro-agent--控制另一台机器) | **多标签终端**<br>每个配置文件共享一条会话的真实 SSH shell 标签页；切换标签不会重新建立通道。 |
| **known-hosts 验证**<br>交互式指纹提示；密钥不匹配时会以危险色调的 UI 呈现，让中间人攻击一目了然。 | **随处可用的 ssh-agent**<br>Unix 上的 `$SSH_AUTH_SOCK`、OpenSSH-for-Windows 管道，以及 Windows 上的 Pageant。 |

### 🛠️ 生产力

| | |
|---|---|
| **配置文件导入器**<br>从 `~/.ssh/config`、FileZilla 的 `sitemanager.xml` 和 PuTTY 会话导入连接。 | **键盘优先**<br>命令面板（Ctrl/⌘-K）、可排序列、面包屑导航、窗格内过滤、toast 通知、带菜单的自定义标题栏。 |
| **`faro-cli`**<br>用同一批已保存的配置文件，以脚本方式操作 GUI 支持的每一种后端。[详情 ↓](#cli) | **感知能力的 UI**<br>在不支持的 backend 上隐藏 chmod/mkdir；协议标签清晰显示当前连接类型。 |

---

## 🤖 Agent Bridge

**让本地 AI 代理在你的服务器上执行命令——安全地。**

这正是让 Faro 不止于文件客户端的部分。连接一次服务器，Faro 就能把这条**已认证的 SSH 会话**借给本地 AI 代理——Claude Code、Cursor，或任何支持 [MCP](https://modelcontextprotocol.io) 的工具——让代理在机器上操作，**无需在远程安装任何东西，也永远看不到你的凭据。** Faro 始终是守门人。

> **有何不同：** 大多数"AI over SSH"方案要么要你把密钥交给代理，要么要在服务器端部署守护进程。Faro 两者都不需要。代理借用的是*你*已经打开的会话，*你*审批每条命令，到达服务器的只有你确认过的命令。

**接入 Claude Code——原生 MCP，工具自动发现：**

1. 连接一台服务器，打开 **Bridge** 面板（状态栏指示），点击 **Start**，并开启 **Allow agent access**。
2. 复制面板生成的一行命令，在你的项目中运行：
   ```bash
   claude mcp add --transport http faro http://127.0.0.1:<port>/mcp \
     --header "Authorization: Bearer <token>"
   ```
3. Claude Code 现在拥有两个工具——`faro_list_sessions` 和 `faro_exec`。让它*"检查服务器磁盘占用"*，它就会通过 Faro 执行。（更喜欢 curl 或其他代理？面板也可以导出针对纯 HTTP API 的可直接粘贴的 `SKILL.md`。）

**护栏——全部默认开启：**

- 🔒 **仅限 localhost** —— 绑定到 `127.0.0.1` 的随机端口。
- 🔑 **Bearer 令牌** —— 每次启动生成，每个请求都必须携带。
- ☑️ **按会话选择性开启** —— 在你开启之前，任何连接都不可达。
- 🙋 **逐条审批命令** —— 每次 `exec` 都会在 Faro 中弹出提示，并阻塞直到你点击 Approve（或超时）。
- 📋 **实时审计日志** —— 每条命令、批准和拒绝，都直接显示在面板中。

接口面：`GET /health`、`GET /sessions`、`POST /exec` 和 `POST /mcp`（MCP Streamable HTTP）。这是在现有 tokio 运行时上手写的 localhost 服务器——**零新增依赖。**

## 🖥️ Faro Agent —— 控制另一台机器

触达整台计算机——Windows、macOS 或 Linux——方式与你驾驭远程服务器完全相同，
但**无需在上面配置 SSH 服务器**。用 6 位配对码（RustDesk 风格）配对一次，它
就会作为一条连接出现在 Faro 中，你可以浏览文件、传输文件并执行原生命令。而
由于 [Agent Bridge](#-agent-bridge) 会把 Faro 的会话桥接给本地 AI，这让 Claude
Code 可以**从任何地方在你的 Windows 机器上运行 PowerShell、在你的 Mac 上运行
`sh`**——通过一条加密、固定、受策略约束的链路。

**如果两台机器都已安装 Faro，就无需下载任何东西。** 在你想控制的那台机器上，
打开 **Settings → Remote control**，开启开关并点击 **Show pairing code**——然后
在另一台 Faro 上输入该配对码。完成。

对于**无头服务器**，一行命令即可安装代理、将其注册为服务并打开配对窗口：

```bash
curl -fsSL https://github.com/jhd3197/Faro/releases/latest/download/install-agentd.sh | sh
```

也可以自己驱动 `faro-agentd` 二进制——现在同一个端口既服务已配对的控制器，
也接受新的配对，因此无需任何重启：

```bash
faro-agentd pair          # 服务 + 打开配对窗口；打印一个 6 位配对码
# 然后在 Faro 中：New Connection → Faro Agent → 选择这台机器 → 输入配对码。
#               完成——密钥已固定；下次无需再输入配对码。

faro-agentd run           # 服务已配对的控制器（无配对窗口）
faro-agentd install       # 以服务方式运行，重启后依然存活
faro-agentd install --read-only   # ……仅提供浏览 + 读取 + 报告
faro-agentd info          # 本机身份 + 已配对对象
```

**安全保障** —— 链路采用 [Noise](https://noiseprotocol.org/) 握手
（X25519 + ChaCha20-Poly1305），端到端加密，不依赖任何中继。配对时将配对码
混入 PSK，使主动中间人无法完成握手；此后双方**互相固定对方的静态密钥**，
无法识别的对端会被拒绝。被控机器保留自己的**独立**策略（exec/write/read-only）
和审计日志，因此已配对的控制器永远无法做超出所有者允许范围的事。局域网发现
使用 mDNS；互联网可达（rendezvous + 中继）属于后续阶段。详见
[`docs/remote-agent.md`](remote-agent.md)。

## 后端

每种后端都是一个 `RemoteFs` 实现，因此双窗格浏览器、传输队列、同步、磁盘
占用分析器、差异对比和搜索都能免费获得支持。能力差异（存储桶没有 shell、
HTTP 只读）会隐藏不支持的功能入口，而不是重新造轮子。

| 后端 | 浏览 | 传输 | 同步 | Shell |
|---|:-:|:-:|:-:|:-:|
| **SFTP**（SSH） | ✓ | ✓ | ✓ | ✓ |
| **FTP** | ✓ | ✓ | ✓ | — |
| **FTPS**（显式） | ✓ | ✓ | ✓ | — |
| **S3 兼容**（AWS、R2、B2、Wasabi……） | ✓ | ✓ | ✓ | — |
| **Azure Blob** | ✓ | ✓ | ✓ | — |
| **Google Cloud Storage** | ✓ | ✓ | ✓ | — |
| **WebDAV**（Nextcloud、ownCloud……） | ✓ | ✓ | ✓ | — |
| **HTTP(S)**（autoindex / 直接 URL） | ✓ | 仅下载 | ← 仅限 | — |
| **Dropbox** | ✓ | ✓ | ✓ | — |
| **OneDrive** | ✓ | ✓ | ✓ | — |
| **Google Drive** | ✓ | ✓ | ✓ | — |
| **Box** | ✓ | ✓ | ✓ | — |
| **Faro Agent** | ✓ | ✓ | ✓ | exec |

**云盘**通过浏览器一次性授权（loopback + PKCE OAuth）；Faro 只将刷新令牌存入
操作系统钥匙串，永远看不到你的密码。**HTTP(S)** 是只读源——指向 nginx/Apache
的 autoindex 即可浏览，或指向直接 URL 拉取单个产物；上传、重命名和删除都会被
拒绝。

---

## 🏗️ 架构

```
┌──────────────────────────────────────────────────────────────┐
│  React + TypeScript + Tauri webview                          │
│  Dual-pane browser · xterm.js terminal · sync / diff /       │
│  disk-usage / search / skills panels · Agent Bridge          │
└──────────────────────────┬───────────────────────────────────┘
                           │  Tauri commands + events
┌──────────────────────────┴───────────────────────────────────┐
│  Rust core (faro_lib)                                        │
│   RemoteFs → Local·Sftp·Ftp·Object(S3/Azure/GCS)·WebDav·     │
│              Http·Dropbox·OneDrive·GDrive·Box·Agent           │
│   SessionManager pools one session per profile               │
│   TransferManager → concurrent file + directory transfers    │
│   scan.rs (bounded walk + fast paths) → diskscan · diff ·    │
│              search · sync::plan   ·   faro.db (SQLite)       │
│   foldersync.rs → continuous watched sync pairs              │
│   bridge.rs → localhost MCP/HTTP + approvals + Skills        │
│   oauth.rs · importers/ · known_hosts + HostKeyVerifier      │
└───────────────┬───────────────────────────┬──────────────────┘
                │  same Rust core            │  Noise protocol
┌───────────────┴──────────────┐  ┌──────────┴──────────────────┐
│  faro-cli  (clap)            │  │  faro-agentd (controlled     │
│  ls·cp·mv·rm·sync·diff·      │  │  machine): handshake · pin · │
│  search·exec·agent·skill     │  │  policy · native exec + fs   │
└──────────────────────────────┘  └─────────────────────────────┘
```

关键所在：**一切皆通过单一的 `RemoteFs` trait。** 新增一种后端意味着编写一个 trait 实现和一个构建器；双窗格浏览器、同步规划器、磁盘占用 / 差异对比 / 搜索工具、CLI 和传输引擎都会自动获得支持。

## 开发

```bash
npm install
npm run tauri dev
```

首次构建很慢——需要编译整棵 Rust crate 树。后续构建约 30 秒。

**前置要求**：Node 20+、Rust 1.88+（`rustc --version`——Tauri 2 的传递依赖有此要求）。

## CLI

独立二进制 `faro-cli`——位于 `src-tauri/faro-cli/` 下的独立 workspace crate——复用你在 GUI 中保存的配置文件。预编译二进制随每个 [release](https://github.com/jhd3197/faro/releases/latest) 一起发布，也可以自行构建：

```bash
cd src-tauri
cargo build -p faro-cli --release
# → src-tauri/target/release/faro-cli

# 文件操作——任意后端，使用已保存的配置文件
faro-cli profiles list
faro-cli ls prod:/var/log
faro-cli cp ./report.pdf prod:/var/www/uploads
faro-cli sync ./site prod:/var/www/site --mirror --dry-run
faro-cli rm prod:/tmp/build --recursive

# 对比与搜索——远程↔远程同样可行
faro-cli diff prod:/etc staging:/etc --hash
faro-cli search prod:/var/log "OutOfMemory" --content --regex
faro-cli exec prod 'systemctl status api'      # SSH 配置文件 shell

# 驱动应用的 Agent Bridge（经由 Faro 的审批 + 控制台）
faro-cli agent exec prod 'journalctl -u api -n 100'
faro-cli agent exec prod --detach 'apt-get -y upgrade'   # 后台任务 id
faro-cli agent write prod /etc/app/patch.conf --from-file ./patch.conf
faro-cli skill run deploy --target all --param branch=main --dry-run

# 用已保存的 HTTP(S) 配置文件凭据拉取需要鉴权的页面
faro-cli fetch https://staging.example.com/admin

faro-cli self-update --check   # CLI 单独发布，版本可能落后于应用
```

CLI 与 GUI 对齐：`ls · cp · mv · rm · mkdir · sync · diff · search ·
exec · profiles`，另有 `agent`（驱动正在运行的 Agent Bridge——`exec`、
`script`、`write`、`read`、后台 `job`/`jobs`、`search`、`download`、
`upload`）、`skill`、`fetch` 和 `self-update`。路径语法：裸路径为本地路径
（包括 Windows 的 `C:\…`），`name:/path` 引用已保存的配置文件——因此
`diff`/`sync` 可以跨越两个远程。遇到未知主机密钥时会在 stdin 上提示，且绝不
将 GUI 尚未保存的密钥写入磁盘。

## 目录结构

```
src/                       React frontend
  components/              DualPaneBrowser, FileBrowser, Terminal,
                           SyncDialog/SyncSettings, DiskUsage/DiskTreemap,
                           DirectoryDiff, FleetSearch, SkillsPanel, AgentBridge,
                           ProfileEditor, ImportDialog, HostKeyModal, …
  stores/                  Zustand stores (bridge, sync, connections, …)
  lib/ipc.ts               Typed wrappers around Tauri commands
  lib/types.ts             Shared types (mirror Rust serde structs)
  mock/                    VITE_MOCK demo data + invoke/listen fakes (screenshots)

src-tauri/src/
  commands.rs              Tauri command surface
  bridge.rs                Agent Bridge — localhost MCP/HTTP server, per-command
                           approval, audit log, Fleet Skills store + runner
  remotefs/                RemoteFs trait + Local/Sftp/Ftp/Object/WebDav/Http/
                           Dropbox/OneDrive/GDrive/Box/Agent impls
  session/                 One session type per backend, SessionManager,
                           HostKeyVerifier trait
  oauth.rs                 Loopback + PKCE OAuth (Dropbox/OneDrive/Drive/Box)
  scan.rs                  Bounded-concurrency RemoteFs walk + strategy select
  db.rs                    faro.db (bundled SQLite) — scan/sync state index
  diskscan.rs / diff.rs / search.rs   scan-engine consumers
  foldersync.rs            Continuous watched sync pairs (watcher + reconciler)
  sync.rs                  Two-tree one-shot sync planner
  transfer.rs              Per-backend streaming transfers + progress
  terminal.rs              PTY over russh, emits events
  agent.rs / agent_host.rs Faro Agent client + in-app "Remote control" host
  cli_updater.rs           faro-cli version-drift check + self-update
  editor.rs · deeplink.rs · importers/ · known_hosts.rs · virtualfs/

src-tauri/faro-cli/        Standalone CLI crate — path-depends on faro_lib
  src/main.rs              clap + indicatif: ls·cp·mv·rm·mkdir·sync·diff·search·
                           exec·agent·skill·fetch·self-update

src-tauri/faro-agent-proto/  Faro Agent wire protocol (Noise channel, msg set,
                             identity/pairing) — Tauri-free, shared by both ends
src-tauri/faro-agentd/       Headless daemon run on a controlled machine:
  src/{server,ops,config,discovery}.rs  handshake·pin·policy·native exec+fs·mDNS
```

## Windows PATH 注意事项

如果你通过 Chocolatey 安装了 Rust（`choco install rust`），`C:\ProgramData\chocolatey\bin` 下的 `rustc.exe` 会**遮蔽** rustup 管理的工具链。`rustup update stable` 只更新 rustup 的副本，不会动 chocolatey 那份，因此 `rustc --version` 会一直报告旧版本，Tauri 构建会失败并报出类似 `rustc 1.85.0 is not supported by darling@0.23.0` 的错误。

```powershell
# 方案 A —— 卸载 chocolatey 的那份（推荐）
choco uninstall rust

# 方案 B —— 两者都保留，但让 rustup 在当前 shell 中优先
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
```

---

## 🗺️ 路线图

- **v1.0** —— 单向同步模式
- **v1.1** —— `faro-cli` 二进制
- **v1.2** —— 就地编辑的外部编辑器
- **v1.3** —— 带 File/Edit/View/Help 菜单的自定义标题栏 + 集成窗口控件；GitHub Actions 发布流水线 + CI
- **v1.3** —— UI 密度优化（命名主题、命令面板、可排序的详情列、面包屑导航、窗格内过滤、toast 通知）；**🤖 Agent Bridge**（AI 代理通过原生 MCP 执行命令）；以及 **🖥️ Faro Agent**——通过加密、固定的链路控制一台已配对的 Windows/macOS/Linux 机器（浏览、传输、原生执行），无需 SSH 服务器。现在还带来**应用内 Remote control**（直接从 Faro 应用托管代理——无需单独下载）、单一常驻可配对守护端口、`faro-agentd install` 服务安装 + 一行式无头安装脚本，以及用于从托管面板一键"Connect with Faro"的 `faro://` 深链
- **近期** —— **更多后端**（十余家厂商的 S3 预置、Google Cloud Storage、WebDAV、只读 HTTP，以及 Dropbox / OneDrive / Google Drive / Box OAuth 云盘）；适用于任意后端的**磁盘使用情况分析器**、**目录差异对比**（含远程↔远程）和 **Fleet Search**；**Fleet Skills**（可由 AI 编写的集群自动化）；带排除模式 + 镜像删除保护的**持续文件夹同步**；以及更顺手的 **`faro-cli` / Agent Bridge 远程执行体验**——后台任务、`agent write`、`agent script`/`--stdin`、鉴权 `fetch`，以及 CLI 版本漂移自更新
- **下一步** —— SMB/CIFS 后端（NAS / Windows 共享）；按需"虚拟文件夹"占位符（Windows 优先，目前以特性开关形式存在）；双向同步 + 冲突解决；边栏和选择器上的品牌/协议图标；Faro Agent 互联网可达（rendezvous + NAT 打洞 + 中继兜底）；传输限速和队列编辑（优先级/重试/暂停）
- **发布打磨** —— 代码签名（Apple Developer / Windows EV 证书）、Tauri 自动更新器、落地页

---

## 📖 文档

| 文档 | 说明 |
|----------|-------------|
| [Remote Agent](remote-agent.md) | Faro Agent 协议、配对流程与安全模型 |
| [Deep Links](deep-links.md) | `faro://` 一键"Connect with Faro"链接 |
| [Screenshot Capture](screenshots/CAPTURE.md) | 截图清单及 README 截图的复现方法 |
| [Updater Key Custody](updater-key-custody.md) | Tauri 更新器的签名密钥管理 |

---

## 🧱 技术栈

| 层级 | 技术 |
|-------|------------|
| 应用外壳 | Tauri 2（Rust） |
| 前端 | React 18、TypeScript、Vite、Zustand、xterm.js、Tailwind CSS |
| 后端核心 | Rust —— 单一 `RemoteFs` trait 覆盖 13 种后端 |
| SSH | russh（SFTP + PTY），ssh-agent / Pageant 集成 |
| 对象存储 | S3、Azure Blob、Google Cloud Storage SDK |
| 云盘 | Loopback + PKCE OAuth（Dropbox、OneDrive、Google Drive、Box） |
| 代理链路 | Noise 协议（X25519 + ChaCha20-Poly1305），mDNS 发现 |
| AI 接口 | MCP Streamable HTTP + localhost REST 桥接 |
| 状态 | 内置 SQLite（`faro.db`） |
| CLI | `faro-cli`（clap）· `faro-agentd` 无头守护进程 |

---

## 🤝 参与贡献

欢迎贡献！

```
fork → 特性分支 → commit → push → pull request
```

**优先方向：** 新后端（写一个 `RemoteFs` 实现即可处处可用）、UI/UX 打磨、文档、测试覆盖率。

## 图标

```bash
# 将 src-tauri/icons/source.png 替换为 1024×1024 的 PNG，然后：
npm run tauri icon src-tauri/icons/source.png
```

`scripts/process-icon.py` 负责将带黑色边框的源 PNG 裁剪为圆角方形图标，并按正确尺寸写出 `source.png`。

---

## 💛 支持 Faro

Faro 是自由开源软件。如果它为你节省了时间，你可以帮助它走得更远：

- ⭐ [给仓库点星](https://github.com/jhd3197/faro) —— 零成本，帮助巨大
- 💖 [GitHub Sponsors](https://github.com/sponsors/jhd3197)
- ☕ [Buy Me a Coffee](https://buymeacoffee.com/jhd3197)

### 💎 加密货币

| | 资产 | 网络 | 地址 |
|:---:|---|---|---|
| <img src="images/funding/usdt-trc20.png" width="110" alt="USDT TRC-20 捐赠地址二维码" /> | **USDT** | **TRC-20** · Tron | `TTiCtqLauF1iSW2YGB3b78KmRxRqoLCgeL` |
| <img src="images/funding/usdt-erc20.png" width="110" alt="USDT 与 ETH ERC-20 捐赠地址二维码" /> | **USDT / ETH** | **ERC-20** · Ethereum | `0xD13D5355Fa214e8317fea2ff192a065BaeC13527` |
| <img src="images/funding/btc.png" width="110" alt="比特币捐赠地址二维码" /> | **BTC** | **Bitcoin** | `bc1qatx67n3qxdvuv3arc9j8aytk34f22g02k9c7vr` |
| <img src="images/funding/sol.png" width="110" alt="Solana 捐赠地址二维码" /> | **SOL** | **Solana** | `AWXzqtBEgUfteHPQtDegsZ6D5y57M3GGdKPD8rR7h6xu` |

TRC-20 手续费最低——通常不到一美元——是小额捐赠最友好的选择。ERC-20 的
gas 费可能比捐赠金额本身还高。

<sub>二维码由 [`scripts/generate-funding-qr.mjs`](../scripts/generate-funding-qr.mjs) 在本地生成，编码前会对每个地址进行校验和验证。</sub>

---

## 🔭 相关项目

**[ServerKit](https://github.com/jhd3197/ServerKit)** —— 轻量现代的服务器控制面板，用于管理 Web 应用、数据库、Docker 容器和安全——没有 Kubernetes 的复杂性，也没有托管平台的高成本。

> Faro 是桌面端搭档，适合在所有机器上进行手动的文件传输、shell 操作和临时工作；ServerKit 则从浏览器管理你的服务器。

**[LocalKit](https://github.com/jhd3197/LocalKit)** —— 一键启动本地 WordPress 站点。每个站点都作为独立的 Docker Compose 项目运行，并且可以通过 `serverkit-localkit` 扩展将代码推送、或将数据库推送/拉取到你的 ServerKit 服务器。

**[DeviceKit](https://github.com/jhd3197/DeviceKit)** —— 统一的 Android 设备集群与测试自动化平台。从一个仪表盘控制整个设备集群——运行自动化、实时投屏、捕捉视觉回归，并借助 AI 分析调试失败。

---

## 💬 社区

[![Discord](https://img.shields.io/badge/Discord-Join_Us-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/ZKk6tkCQfG)

加入 Discord 提问、分享反馈或获取配置方面的帮助。

---

## 📄 许可证

MIT —— 详见 [LICENSE](../LICENSE)。

---

<div align="center">

**Faro** —— 服务器 · 存储 · 会话，尽在一个工作区。

[报告问题](https://github.com/jhd3197/faro/issues) · [功能建议](https://github.com/jhd3197/faro/issues)

由 [Juan Denis](https://juandenis.com) 用 ❤️ 打造

</div>
