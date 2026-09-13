<div align="center">

<img width="100%" alt="Faro — Acesso moderno a arquivos em servidores e na nuvem" src="screenshots/poster.png" />

# Faro

**File & Agent Remote Operations**

O nome FARO significa “File & Agent Remote Operations”: operações remotas com arquivos e agentes.

**Um cliente de desktop moderno para SFTP, FTP, SSH, S3-compatível, WebDAV e armazenamento em nuvem.**

Salve um servidor uma vez e navegue pelos arquivos dele em uma visão de painel
duplo, além de abrir um terminal na mesma sessão — e um **Agent Bridge** que
permite ao Claude Code (ou a qualquer agente MCP) executar comandos em uma
máquina através da sua sessão autenticada, com aprovação por comando e zero
credenciais compartilhadas.

[English](../README.md) | [Español](README.es.md) | [中文版](README.zh-CN.md) | Português

<br>

![Windows](https://img.shields.io/badge/Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)
[![Discord](https://img.shields.io/discord/1470639209059455008?style=for-the-badge&logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/ZKk6tkCQfG)
[![Ver a demo](https://img.shields.io/badge/Ver_a_Demo-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://www.youtube.com/watch?v=nL9r3c9-5Kc)

[![GitHub Stars](https://img.shields.io/github/stars/jhd3197/faro?style=flat-square&color=f5c542)](https://github.com/jhd3197/faro/stargazers)
[![Downloads](https://img.shields.io/github/downloads/jhd3197/faro/total?style=flat-square)](https://github.com/jhd3197/faro/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](../LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.24-8b7ff6.svg?style=flat-square)](https://github.com/jhd3197/faro/releases)
[![Tauri](https://img.shields.io/badge/tauri-2-24C8D8.svg?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/rust-1.88+-DEA584.svg?style=flat-square&logo=rust&logoColor=black)](https://rust-lang.org)
[![React](https://img.shields.io/badge/react-18-61DAFB.svg?style=flat-square&logo=react&logoColor=black)](https://reactjs.org)

<br>

[Baixar](#-início-rápido) · [Capturas de Tela](#-capturas-de-tela) · [Funcionalidades](#-funcionalidades) · [Agent Bridge](#-agent-bridge) · [Arquitetura](#-arquitetura) · [Roadmap](#-roadmap) · [Documentação](#-documentação) · [Contribuindo](#-contribuindo) · [Discord](#-comunidade)

</div>

---

## 🚀 Início Rápido

> ⏱️ Baixar, conectar, transferir — em menos de um minuto

Baixe o instalador mais recente na página de [**Releases**](https://github.com/jhd3197/faro/releases/latest) — cada push para a `main` publica builds novos para as três plataformas de desktop, além do `faro-cli` standalone.

| Plataforma | Instalador | Nota de primeiro arranque |
|---|---|---|
| **macOS** (Intel + Apple Silicon) | `.dmg` (universal) | Passo único de `xattr` ↓ |
| **Windows** (x64) | `.exe` (NSIS) ou `.msi` | SmartScreen → *Mais informações → Executar mesmo assim* |
| **Linux** (x64) | `.AppImage`, `.deb`, `.rpm` | `chmod +x` no AppImage |

Os builds **não são assinados** (ainda sem certificado Apple Developer / Windows EV), então cada SO protege a primeira execução:

- **macOS** — depois de arrastar o **Faro.app** para **/Applications**, execute isto uma vez no Terminal e depois abra o app normalmente:
  ```bash
  xattr -cr /Applications/Faro.app
  ```
  É necessário porque o build não é notarizado pela Apple; sem isso, o macOS reporta o app como "danificado".
- **Windows** — no aviso *"O Windows protegeu o seu PC"*, clique em **Mais informações → Executar mesmo assim**.

> Prefere compilar a partir do código-fonte? Veja [Desenvolver](#desenvolver) abaixo.

<!-- FARO:SHOTS:START -->
## 📸 Capturas de Tela

> Capturadas de um build com dados fictícios — todo hostname, IP, nome de usuário e caminho abaixo é fictício. Veja [`docs/screenshots/CAPTURE.md`](screenshots/CAPTURE.md) para a lista de capturas e como reproduzi-las.

|                          Navegador de painel duplo                          |                          Explorador de Uso de Disco                          |
| :-----------------------------------------------------------------: | :-------------------------------------------------------------------: |
|        ![Navegador de painel duplo](screenshots/overview.png)          |       ![Explorador de Uso de Disco](screenshots/disk-usage.png)         |
| _Local e remoto lado a lado, com transferências de arrastar e soltar entre eles_ | _Treemap estilo WinDirStat sobre qualquer backend, com um caminho rápido no servidor_ |

|                             Barra de servidores                             |                        Terminal integrado                        |
| :-----------------------------------------------------------------: | :---------------------------------------------------------------: |
|          ![Barra de servidores](screenshots/server-rail.png)           |          ![Terminal integrado](screenshots/terminal.png)          |
| _Bolhas de conexão estilo Discord, com um modo rotulado expansível_ | _Uma aba de shell SSH real na mesma sessão que você está navegando_ |

|                             Agent Bridge                             |                          Armazenamento de objetos                          |
| :------------------------------------------------------------------: | :--------------------------------------------------------------: |
|        ![Agent Bridge](screenshots/agent-bridge.png)        |        ![Armazenamento de objetos](screenshots/object-storage.png)        |
| _Aprove (ou auto-aprove) cada comando que um agente de IA executa em uma sessão ativa_ | _Navegue por buckets S3 como um sistema de arquivos, ao lado dos seus servidores SFTP_ |

|                             Transferências                             |                          Sincronização de diretórios                          |
| :---------------------------------------------------------------: | :--------------------------------------------------------------: |
|          ![Painel de transferências](screenshots/transfers.png)          |            ![Sincronização de diretórios](screenshots/sync.png)            |
| _Downloads/uploads em fila com progresso e avisos de sobrescrita_ | _Pré-visualize um plano de sincronização unidirecional antes de mover qualquer coisa_ |

<details>
<summary><strong>Ver todas as capturas de tela</strong></summary>

<br>

|                          Ações de arquivo                          |                       Aprovação do Agent Bridge                        |
| :------------------------------------------------------------: | :----------------------------------------------------------------: |
| ![Menu de contexto de ações de arquivo](screenshots/context-menu.png) | ![Aviso de aprovação do Agent Bridge](screenshots/agent-bridge-approve.png) |
| _Duplicar, propriedades, "baixar pasta como .tar.gz/.zip", "abrir terminal aqui"_ | _Todo comando do agente mostra o comando exato antes de executar_ |

|                          Nova conexão                          |                             Configurações                             |
| :--------------------------------------------------------------: | :--------------------------------------------------------------: |
|      ![Nova conexão](screenshots/new-connection.png)      |          ![Configurações](screenshots/settings.png)          |
| _Um editor de perfis para os treze backends, com seletor de protocolo em uma barra lateral_ | _Temas, comportamento do terminal, transferências e o editor padrão_ |

</details>
<!-- FARO:SHOTS:END -->

## 🎯 Funcionalidades

> **Uma lista de conexões, treze backends.** Navegar, transferir, sincronizar e as ferramentas de uso de disco / diff / busca funcionam da mesma forma em todos — tudo atrás de uma única trait `RemoteFs`.

### 📡 Backends e Armazenamento

| | |
|---|---|
| **SFTP / FTP / FTPS**<br>Os clássicos, bem feitos — uma sessão SSH compartilhada entre o navegador de arquivos e o painel do terminal. | **S3-compatível**<br>Predefinições para AWS, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO, Storj, Hetzner, Scaleway, Oracle OCI, IBM COS, Supabase e auto-hospedados genéricos (Ceph RGW, Garage, SeaweedFS). |
| **Azure Blob e Google Cloud Storage**<br>Armazenamento de objetos de primeira classe ao lado dos seus servidores. | **WebDAV e HTTP(S)**<br>Navegação em Nextcloud / ownCloud, além de autoindex HTTP somente leitura e fontes por URL direta. |
| **Nuvens pessoais**<br>Dropbox, OneDrive, Google Drive e Box — OAuth com loopback + PKCE, apenas o refresh token no chaveiro do seu SO. | **Faro Agent**<br>O próprio agente pareado do Faro como backend — navegue, transfira e execute em uma máquina sem servidor SSH. |

### 🔁 Transferências e Sincronização

| | |
|---|---|
| **Transferências de arrastar e soltar**<br>Entre painéis, diretórios recursivos, multisseleção, políticas de sobrescrever/pular/renomear, upload multipart para objetos > 16 MB. | **Sincronização de diretórios**<br>Pré-visualize um plano unidirecional (Aditivo ou Espelho) e depois execute-o — entre quaisquer dois backends. |
| **Sincronização contínua de pastas**<br>Vincule uma pasta local a um caminho remoto e ela permanece espelhada — watcher + reconciliador por polling, padrões de exclusão, limite de exclusão no espelho. | **Edição in loco**<br>Abra um arquivo remoto no seu editor local; upload automático a cada salvamento, com um indicador ao vivo na barra de status. |

### 🔎 Explorar, Comparar e Buscar

| | |
|---|---|
| **Explorador de Uso de Disco**<br>Treemap estilo WinDirStat/WizTree + árvore ordenada por tamanho sobre qualquer backend, com caminho rápido de shell `du`/`find`. | **Directory Diff**<br>Meld/Beyond-Compare para quaisquer dois backends — incluindo **remoto ↔ remoto** (staging vs prod, dois buckets). Compare por tamanho ou por `--hash`. |
| **Fleet Search**<br>Busque por nome ou conteúdo — `rg`/`grep` no lado do servidor em servidores SSH e Agent, listagem plana de chaves em buckets. | **Paridade com o CLI**<br>As três estão no `faro-cli` (`diff`, `search`) e expostas como ferramentas MCP (`faro_diff`, `faro_search`). |

### 🤖 IA e Automação

| | |
|---|---|
| **Agent Bridge**<br>Empreste sua sessão autenticada ao Claude Code ou a qualquer agente MCP — somente localhost, bearer token, aprovação por comando. [Detalhes ↓](#-agent-bridge) | **Fleet Skills**<br>Fluxos de trabalho de shell de várias etapas, criáveis por IA, que se espalham por vários servidores — skills criadas por IA chegam como propostas que precisam de uma aprovação humana. |
| **MCP nativo**<br>Ferramentas autodescobertas no Claude Code; um `SKILL.md` pronto para colar para agentes HTTP simples. | **Log de auditoria ao vivo**<br>Cada comando, aprovação e negação, direto no painel Bridge. |

### 🖥️ Máquinas Remotas e Sessões

| | |
|---|---|
| **Faro Agent**<br>Controle uma máquina Windows/macOS/Linux sem servidor SSH — código de pareamento de 6 dígitos, criptografado com Noise, com chave fixada. [Detalhes ↓](#-faro-agent--controle-outra-máquina) | **Terminais multi-abas**<br>Abas de shell SSH reais compartilhando uma sessão por perfil; as abas sobrevivem a trocas sem restabelecer o canal. |
| **Verificação de known-hosts**<br>Aviso interativo de impressão digital; chaves divergentes recebem uma UI em tom de perigo para que tentativas de MITM sejam óbvias. | **ssh-agent em todo lugar**<br>`$SSH_AUTH_SOCK` no unix, pipe do OpenSSH-for-Windows e Pageant no Windows. |

### 🛠️ Produtividade

| | |
|---|---|
| **Importadores de perfis**<br>Traga conexões de `~/.ssh/config`, do `sitemanager.xml` do FileZilla e de sessões do PuTTY. | **Teclado em primeiro lugar**<br>Paleta de comandos (Ctrl/⌘-K), colunas ordenáveis, breadcrumbs, filtro no painel, toasts, barra de título personalizada com menus. |
| **`faro-cli`**<br>Automatize todos os backends que a GUI fala, usando os mesmos perfis salvos. [Detalhes ↓](#cli) | **UI ciente de capacidades**<br>chmod/mkdir ficam ocultos em backends que não os suportam; as etiquetas de protocolo mostram a que você está conectado. |

---

## 🤖 Agent Bridge

**Deixe um agente de IA local executar comandos nos seus servidores — com segurança.**

Esta é a parte que faz do Faro mais do que um cliente de arquivos. Conecte-se a um servidor uma vez e o Faro pode emprestar essa **sessão SSH já autenticada** a um agente de IA local — Claude Code, Cursor, qualquer coisa que fale [MCP](https://modelcontextprotocol.io) — para que o agente opere na máquina **sem instalar nada no remoto e sem jamais ver suas credenciais.** O Faro continua sendo o guardião.

> **Por que é diferente:** a maioria das configurações de "IA sobre SSH" faz você entregar suas chaves ao agente ou levantar um daemon no servidor. O Faro não faz nenhuma das duas coisas. O agente toma emprestada a sessão que *você* já abriu, *você* aprova cada comando, e nada chega ao servidor além dos comandos que você autorizou.

**Conecte-o ao Claude Code — MCP nativo, ferramentas autodescobertas:**

1. Conecte-se a um servidor, abra o painel **Bridge** (indicador na barra de status), clique em **Start** e ative **Allow agent access**.
2. Copie a linha de comando que o painel gera e execute-a no seu projeto:
   ```bash
   claude mcp add --transport http faro http://127.0.0.1:<port>/mcp \
     --header "Authorization: Bearer <token>"
   ```
3. O Claude Code agora tem duas ferramentas — `faro_list_sessions` e `faro_exec`. Peça *"verifique o uso de disco no servidor"* e ele executa através do Faro. (Prefere curl ou outro agente? O painel também exporta um `SKILL.md` pronto para colar para a API HTTP simples.)

**As salvaguardas — todas ativadas por padrão:**

- 🔒 **Somente localhost** — vinculado a `127.0.0.1` em uma porta aleatória.
- 🔑 **Bearer token** — por execução, exigido em cada requisição.
- ☑️ **Opt-in por sessão** — nenhuma conexão fica acessível até você ativá-la.
- 🙋 **Aprove cada comando** — cada `exec` abre um aviso no Faro e bloqueia até você clicar em Approve (ou expirar).
- 📋 **Log de auditoria ao vivo** — cada comando, aprovação e negação, direto no painel.

Superfície: `GET /health`, `GET /sessions`, `POST /exec` e `POST /mcp` (MCP Streamable HTTP). É um servidor localhost feito à mão sobre o runtime tokio existente — **zero novas dependências.**

## 🖥️ Faro Agent — controle outra máquina

Alcance um computador inteiro — Windows, macOS ou Linux — da mesma forma que você
já opera um servidor remoto, mas **sem configurar um servidor SSH** nele. Pareie
uma vez com um código de 6 dígitos (estilo RustDesk) e ele aparece no Faro como
uma conexão que você pode navegar, pela qual pode transferir arquivos e na qual
pode executar comandos nativos. E como o [Agent Bridge](#-agent-bridge) intermedeia
as sessões do Faro para uma IA local, isso permite ao Claude Code executar
**PowerShell na sua máquina Windows ou `sh` no seu Mac, de qualquer lugar** —
através de um link criptografado, fixado e governado por políticas.

**Se ambas as máquinas já têm o Faro, não há nada para baixar.** Na que você
quiser controlar, abra **Settings → Remote control**, ative e clique em
**Show pairing code** — depois digite esse código no seu outro Faro. Pronto.

Para um **servidor headless**, uma linha instala o agente, o registra como
serviço e abre uma janela de pareamento:

```bash
curl -fsSL https://github.com/jhd3197/Faro/releases/latest/download/install-agentd.sh | sh
```

Ou opere você mesmo o binário `faro-agentd` — uma única porta agora tanto serve
os controladores pareados quanto aceita novos pareamentos, então nada precisa
ser reiniciado:

```bash
faro-agentd pair          # serve + abre uma janela de pareamento; imprime um código de 6 dígitos
# depois no Faro: New Connection → Faro Agent → escolha esta máquina → digite o código.
#               Pronto — fica fixada; sem código da próxima vez.

faro-agentd run           # serve os controladores pareados (sem janela de pareamento)
faro-agentd install       # execute como serviço para sobreviver a reinicializações
faro-agentd install --read-only   # …servindo apenas navegação + leitura + relatório
faro-agentd info          # identidade desta máquina + quem está pareado
```

**Como é protegido** — o link é um handshake [Noise](https://noiseprotocol.org/)
(X25519 + ChaCha20-Poly1305), criptografado de ponta a ponta independentemente de
qualquer relay. O pareamento mistura o código como PSK para que um
man-in-the-middle ativo não consiga completá-lo; depois, ambos os lados
**fixam a chave estática um do outro** e um par não reconhecido é recusado. A
máquina controlada mantém sua **própria** política (exec/write/read-only) e log
de auditoria, então um controlador pareado nunca pode fazer mais do que o dono
permitiu. A descoberta em LAN é mDNS; o alcance pela internet (rendezvous +
relay) é uma fase posterior. Veja [`docs/remote-agent.md`](remote-agent.md).

## Backends

Cada backend é uma implementação de `RemoteFs`, então o navegador de painel
duplo, a fila de transferências, a sincronização, o explorador de uso de disco,
o diff e a busca o adotam de graça. Diferenças de capacidade (sem shell em um
bucket, somente leitura em HTTP) ocultam as funções que não suportam em vez de
reinventá-las.

| Backend | Navegar | Transferir | Sincronizar | Shell |
|---|:-:|:-:|:-:|:-:|
| **SFTP** (SSH) | ✓ | ✓ | ✓ | ✓ |
| **FTP** | ✓ | ✓ | ✓ | — |
| **FTPS** (explícito) | ✓ | ✓ | ✓ | — |
| **S3-compatível** (AWS, R2, B2, Wasabi, …) | ✓ | ✓ | ✓ | — |
| **Azure Blob** | ✓ | ✓ | ✓ | — |
| **Google Cloud Storage** | ✓ | ✓ | ✓ | — |
| **WebDAV** (Nextcloud, ownCloud, …) | ✓ | ✓ | ✓ | — |
| **HTTP(S)** (autoindex / URL direta) | ✓ | download | ← apenas | — |
| **Dropbox** | ✓ | ✓ | ✓ | — |
| **OneDrive** | ✓ | ✓ | ✓ | — |
| **Google Drive** | ✓ | ✓ | ✓ | — |
| **Box** | ✓ | ✓ | ✓ | — |
| **Faro Agent** | ✓ | ✓ | ✓ | exec |

As **nuvens pessoais** autorizam uma vez pelo seu navegador (OAuth com loopback +
PKCE); o Faro armazena apenas o refresh token no chaveiro do seu SO e nunca vê
sua senha. **HTTP(S)** é uma fonte somente leitura — aponte-o para um autoindex
nginx/Apache para navegar, ou para uma URL direta para baixar um artefato;
uploads, renomeações e exclusões são recusados.

---

## 🏗️ Arquitetura

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

O ponto-chave: **tudo passa por uma única trait `RemoteFs`.** Adicionar um novo backend significa escrever uma implementação da trait e um builder; o navegador de painel duplo, o planejador de sincronização, as ferramentas de uso de disco / diff / busca, o CLI e o motor de transferências o adotam automaticamente.

## Desenvolver

```bash
npm install
npm run tauri dev
```

O primeiro build é lento — está compilando a árvore de crates Rust. Builds subsequentes levam ~30 s.

**Pré-requisitos**: Node 20+, Rust 1.88+ (`rustc --version` — as dependências transitivas do Tauri 2 o exigem).

## CLI

Um binário standalone, `faro-cli` — seu próprio crate de workspace em `src-tauri/faro-cli/` — reutiliza seus perfis salvos da GUI. Binários pré-compilados acompanham cada [release](https://github.com/jhd3197/faro/releases/latest), ou compile você mesmo:

```bash
cd src-tauri
cargo build -p faro-cli --release
# → src-tauri/target/release/faro-cli

# Operações de arquivos — qualquer backend, usando seus perfis salvos
faro-cli profiles list
faro-cli ls prod:/var/log
faro-cli cp ./report.pdf prod:/var/www/uploads
faro-cli sync ./site prod:/var/www/site --mirror --dry-run
faro-cli rm prod:/tmp/build --recursive

# Comparar e buscar — remoto↔remoto também funciona
faro-cli diff prod:/etc staging:/etc --hash
faro-cli search prod:/var/log "OutOfMemory" --content --regex
faro-cli exec prod 'systemctl status api'      # shell de perfil SSH

# Opere o Agent Bridge do app (passa pela aprovação + console do Faro)
faro-cli agent exec prod 'journalctl -u api -n 100'
faro-cli agent exec prod --detach 'apt-get -y upgrade'   # id de job em segundo plano
faro-cli agent write prod /etc/app/patch.conf --from-file ./patch.conf
faro-cli skill run deploy --target all --param branch=main --dry-run

# Baixe uma página protegida por autenticação com as credenciais de um perfil HTTP(S) salvo
faro-cli fetch https://staging.example.com/admin

faro-cli self-update --check   # o CLI é publicado separadamente e pode ficar atrás do app
```

O CLI espelha a GUI: `ls · cp · mv · rm · mkdir · sync · diff · search ·
exec · profiles`, além de `agent` (opera o Agent Bridge em execução — `exec`,
`script`, `write`, `read`, `job`/`jobs` em segundo plano, `search`, `download`,
`upload`), `skill`, `fetch` e `self-update`. Sintaxe de caminhos: caminhos
simples são locais (incluindo `C:\…` do Windows), `name:/path` referencia um
perfil salvo — então `diff`/`sync` podem abranger dois remotos. Ele pergunta no
stdin sobre chaves de host desconhecidas e nunca grava em disco segredos que a
GUI ainda não tivesse salvo.

## Estrutura

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

## A pegadinha do PATH no Windows

Se você instalou o Rust via Chocolatey (`choco install rust`), há um `rustc.exe` em `C:\ProgramData\chocolatey\bin` que **sombreia** a toolchain gerenciada pelo rustup. `rustup update stable` atualiza a cópia do rustup mas não toca na do chocolatey, então `rustc --version` continua reportando a versão antiga e os builds do Tauri falham com mensagens como `rustc 1.85.0 is not supported by darling@0.23.0`.

```powershell
# Opção A — desinstale a cópia do chocolatey (recomendado)
choco uninstall rust

# Opção B — mantenha ambas, mas faça o rustup vencer neste shell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
```

---

## 🗺️ Roadmap

- **v1.0** — modo de sincronização unidirecional
- **v1.1** — binário `faro-cli`
- **v1.2** — editor externo com edição in loco
- **v1.3** — barra de título personalizada com menus File/Edit/View/Help + controles de janela integrados; pipeline de releases com GitHub Actions + CI
- **v1.3** — passada de densidade da UI (temas nomeados, paleta de comandos, colunas de detalhe ordenáveis, breadcrumbs, filtro no painel, toasts); o **🤖 Agent Bridge** (acesso de comandos para agentes de IA via MCP nativo); e o **🖥️ Faro Agent** — controle uma máquina Windows/macOS/Linux pareada (navegar, transferir, exec nativo) por um link criptografado e fixado, sem necessidade de servidor SSH. Agora com **Remote control dentro do app** (hospede o agente a partir do app Faro — sem download separado), uma única porta de daemon sempre pareável, configuração de serviço com `faro-agentd install` + instalador headless de uma linha, e deep links `faro://` para "Conectar com o Faro" em um clique a partir de um painel de hospedagem
- **recente** — **mais backends** (predefinições S3 para uma dúzia de fornecedores, Google Cloud Storage, WebDAV, HTTP somente leitura e as nuvens OAuth Dropbox / OneDrive / Google Drive / Box); **Explorador de Uso de Disco**, **Directory Diff** (incl. remoto↔remoto) e **Fleet Search** sobre qualquer backend; **Fleet Skills** (automações de frota criáveis por IA); **sincronização contínua de pastas** com padrões de exclusão + proteção contra exclusão no espelho; e um DX mais refinado de **`faro-cli` / execução remota com Agent Bridge** — jobs em segundo plano, `agent write`, `agent script`/`--stdin`, `fetch` autenticado e auto-atualização por divergência de versão do CLI
- **próximo** — backend SMB/CIFS (NAS / compartilhamentos Windows); placeholders de "pasta virtual" sob demanda (Windows primeiro, hoje atrás de feature flag); sincronização bidirecional + resolução de conflitos; logotipos de marca/protocolo na barra e no seletor; alcance do Faro Agent pela internet (rendezvous + NAT hole-punch + relay de fallback); limites de velocidade de transferência e edição da fila (prioridade/retentativa/pausa)
- **polimento de release** — assinatura de código (certificado Apple Developer / Windows EV), auto-atualizador do Tauri, landing page

---

## 📖 Documentação

| Documento | Descrição |
|----------|-------------|
| [Remote Agent](remote-agent.md) | Protocolo do Faro Agent, pareamento e modelo de segurança |
| [Deep Links](deep-links.md) | Links `faro://` de "Conectar com o Faro" em um clique |
| [Screenshot Capture](screenshots/CAPTURE.md) | A lista de capturas e como reproduzir as capturas do README |
| [Updater Key Custody](updater-key-custody.md) | Manuseio da chave de assinatura para o atualizador do Tauri |

---

## 🧱 Stack Técnica

| Camada | Tecnologia |
|-------|------------|
| Shell do app | Tauri 2 (Rust) |
| Frontend | React 18, TypeScript, Vite, Zustand, xterm.js, Tailwind CSS |
| Núcleo do backend | Rust — uma trait `RemoteFs` sobre 13 backends |
| SSH | russh (SFTP + PTY), integração com ssh-agent / Pageant |
| Armazenamento de objetos | SDKs de S3, Azure Blob, Google Cloud Storage |
| Nuvens pessoais | OAuth com loopback + PKCE (Dropbox, OneDrive, Google Drive, Box) |
| Link do agente | Protocolo Noise (X25519 + ChaCha20-Poly1305), descoberta mDNS |
| Superfície de IA | MCP Streamable HTTP + bridge REST em localhost |
| Estado | SQLite embutido (`faro.db`) |
| CLI | `faro-cli` (clap) · daemon headless `faro-agentd` |

---

## 🤝 Contribuindo

Contribuições são bem-vindas!

```
fork → branch de feature → commit → push → pull request
```

**Áreas prioritárias:** novos backends (uma implementação de `RemoteFs` e funciona em todo lugar), polimento de UI/UX, documentação, cobertura de testes.

## Ícones

```bash
# Substitua src-tauri/icons/source.png por um PNG de 1024×1024, depois:
npm run tauri icon src-tauri/icons/source.png
```

O `scripts/process-icon.py` cuida de recortar um PNG de origem com borda preta para sua arte de quadrado arredondado e gravar o `source.png` no tamanho correto.

---

## 💛 Apoie o Faro

O Faro é gratuito e de código aberto. Se ele economiza seu tempo, você pode ajudar a mantê-lo:

- ⭐ [Dê uma estrela no repositório](https://github.com/jhd3197/faro) — não custa nada e ajuda muito
- 💖 [GitHub Sponsors](https://github.com/sponsors/jhd3197)
- ☕ [Buy Me a Coffee](https://buymeacoffee.com/jhd3197)

### 💎 Cripto

| | Ativo | Rede | Endereço |
|:---:|---|---|---|
| <img src="images/funding/usdt-trc20.png" width="110" alt="Código QR do endereço de doação USDT TRC-20" /> | **USDT** | **TRC-20** · Tron | `TTiCtqLauF1iSW2YGB3b78KmRxRqoLCgeL` |
| <img src="images/funding/usdt-erc20.png" width="110" alt="Código QR do endereço de doação USDT e ETH ERC-20" /> | **USDT / ETH** | **ERC-20** · Ethereum | `0xD13D5355Fa214e8317fea2ff192a065BaeC13527` |
| <img src="images/funding/btc.png" width="110" alt="Código QR do endereço de doação de Bitcoin" /> | **BTC** | **Bitcoin** | `bc1qatx67n3qxdvuv3arc9j8aytk34f22g02k9c7vr` |
| <img src="images/funding/sol.png" width="110" alt="Código QR do endereço de doação de Solana" /> | **SOL** | **Solana** | `AWXzqtBEgUfteHPQtDegsZ6D5y57M3GGdKPD8rR7h6xu` |

TRC-20 tem as taxas mais baixas — geralmente menos de um dólar — então é a opção
mais amigável para uma doação pequena. O gas de ERC-20 pode custar mais do que a
própria doação.

<sub>Os códigos QR são gerados localmente pelo [`scripts/generate-funding-qr.mjs`](../scripts/generate-funding-qr.mjs), que valida o checksum de cada endereço antes de codificá-lo.</sub>

---

## 🔭 Projetos Relacionados

**[ServerKit](https://github.com/jhd3197/ServerKit)** — Um painel de controle de servidores leve e moderno para gerenciar aplicações web, bancos de dados, contêineres Docker e segurança — sem a complexidade do Kubernetes nem o custo das plataformas gerenciadas.

> O Faro é o companheiro de desktop para transferência de arquivos prática, shells e trabalho ad-hoc em todas as suas máquinas; o ServerKit gerencia seus servidores pelo navegador.

**[LocalKit](https://github.com/jhd3197/LocalKit)** — Levante sites WordPress locais em um clique. Cada site roda como seu próprio projeto isolado de Docker Compose, e você pode enviar código ou enviar/puxar bancos de dados diretamente para o seu servidor ServerKit através da extensão `serverkit-localkit`.

**[DeviceKit](https://github.com/jhd3197/DeviceKit)** — Uma plataforma unificada de frota de dispositivos Android e automação de testes. Controle uma frota de dispositivos a partir de um único painel — execute automações, transmita telas em tempo real, capture regressões visuais e depure falhas com análise impulsionada por IA.

---

## 💬 Comunidade

[![Discord](https://img.shields.io/badge/Discord-Join_Us-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/ZKk6tkCQfG)

Entre no Discord para fazer perguntas, compartilhar feedback ou obter ajuda com a sua configuração.

---

## 📄 Licença

MIT — veja [LICENSE](../LICENSE).

---

<div align="center">

**Faro** — Servidores · armazenamento · sessões, tudo em um único espaço de trabalho.

[Reportar Bug](https://github.com/jhd3197/faro/issues) · [Solicitar Funcionalidade](https://github.com/jhd3197/faro/issues)

Feito com ❤️ por [Juan Denis](https://juandenis.com)

</div>
