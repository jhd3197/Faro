<div align="center">

<img width="100%" alt="Faro — Acceso moderno a archivos en servidores y la nube" src="screenshots/poster.png" />

# Faro

**File & Agent Remote Operations**

El nombre FARO significa «File & Agent Remote Operations»: operaciones remotas con archivos y agentes.

**Un cliente de escritorio moderno para SFTP, FTP, SSH, S3-compatible, WebDAV y almacenamiento en la nube.**

Guarda un servidor una vez y explora sus archivos en una vista de doble panel,
además de abrir un terminal contra la misma sesión — y un **Agent Bridge** que
permite a Claude Code (o cualquier agente MCP) ejecutar comandos en una máquina
a través de tu sesión autenticada, con aprobación por comando y sin compartir
ninguna credencial.

[English](../README.md) | Español | [中文版](README.zh-CN.md) | [Português](README.pt.md)

<br>

![Windows](https://img.shields.io/badge/Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)
[![Discord](https://img.shields.io/discord/1470639209059455008?style=for-the-badge&logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/ZKk6tkCQfG)
[![Ver la demo](https://img.shields.io/badge/Ver_la_Demo-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://www.youtube.com/watch?v=nL9r3c9-5Kc)

[![GitHub Stars](https://img.shields.io/github/stars/jhd3197/faro?style=flat-square&color=f5c542)](https://github.com/jhd3197/faro/stargazers)
[![Downloads](https://img.shields.io/github/downloads/jhd3197/faro/total?style=flat-square)](https://github.com/jhd3197/faro/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](../LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.24-8b7ff6.svg?style=flat-square)](https://github.com/jhd3197/faro/releases)
[![Tauri](https://img.shields.io/badge/tauri-2-24C8D8.svg?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/rust-1.88+-DEA584.svg?style=flat-square&logo=rust&logoColor=black)](https://rust-lang.org)
[![React](https://img.shields.io/badge/react-18-61DAFB.svg?style=flat-square&logo=react&logoColor=black)](https://reactjs.org)

<br>

[Descargar](#-inicio-rápido) · [Capturas](#-capturas-de-pantalla) · [Funcionalidades](#-funcionalidades) · [Agent Bridge](#-agent-bridge) · [Arquitectura](#-arquitectura) · [Hoja de Ruta](#-hoja-de-ruta) · [Documentación](#-documentación) · [Contribuir](#-contribuir) · [Discord](#-comunidad)

</div>

---

## 🚀 Inicio Rápido

> ⏱️ Descarga, conecta, transfiere — en menos de un minuto

Descarga el instalador más reciente desde la página de [**Releases**](https://github.com/jhd3197/faro/releases/latest) — cada push a `main` publica compilaciones nuevas para las tres plataformas de escritorio más el `faro-cli` independiente.

| Plataforma | Instalador | Nota de primer arranque |
|---|---|---|
| **macOS** (Intel + Apple Silicon) | `.dmg` (universal) | Paso único de `xattr` ↓ |
| **Windows** (x64) | `.exe` (NSIS) o `.msi` | SmartScreen → *Más información → Ejecutar de todas formas* |
| **Linux** (x64) | `.AppImage`, `.deb`, `.rpm` | `chmod +x` al AppImage |

Las compilaciones **no están firmadas** (aún no hay certificado de Apple Developer ni Windows EV), así que cada SO protege el primer arranque:

- **macOS** — después de arrastrar **Faro.app** a **/Applications**, ejecuta esto una vez en Terminal y luego abre la app con normalidad:
  ```bash
  xattr -cr /Applications/Faro.app
  ```
  Es necesario porque la compilación no está notarizada por Apple; sin esto, macOS reporta la app como "dañada".
- **Windows** — en el aviso *"Windows protegió su PC"*, haz clic en **Más información → Ejecutar de todas formas**.

> ¿Prefieres compilar desde el código fuente? Consulta [Desarrollar](#desarrollar) más abajo.

<!-- FARO:SHOTS:START -->
## 📸 Capturas de Pantalla

> Capturadas desde una compilación con datos de prueba — cada hostname, IP, nombre de usuario y ruta a continuación es ficticio. Consulta [`docs/screenshots/CAPTURE.md`](screenshots/CAPTURE.md) para ver la lista de capturas y cómo reproducirlas.

|                          Navegador de doble panel                          |                          Explorador de Uso de Disco                          |
| :-----------------------------------------------------------------: | :-------------------------------------------------------------------: |
|        ![Navegador de doble panel](screenshots/overview.png)          |       ![Explorador de Uso de Disco](screenshots/disk-usage.png)         |
| _Local y remoto lado a lado, con transferencias de arrastrar y soltar entre ambos_ | _Treemap estilo WinDirStat sobre cualquier backend, con una vía rápida del lado del servidor_ |

|                             Barra de servidores                             |                        Terminal integrado                        |
| :-----------------------------------------------------------------: | :---------------------------------------------------------------: |
|          ![Barra de servidores](screenshots/server-rail.png)           |          ![Terminal integrado](screenshots/terminal.png)          |
| _Burbujas de conexión estilo Discord, con un modo etiquetado expandible_ | _Una pestaña de shell SSH real contra la misma sesión que estás explorando_ |

|                             Agent Bridge                             |                          Almacenamiento de objetos                          |
| :------------------------------------------------------------------: | :--------------------------------------------------------------: |
|        ![Agent Bridge](screenshots/agent-bridge.png)        |        ![Almacenamiento de objetos](screenshots/object-storage.png)        |
| _Aprueba (o auto-aprueba) cada comando que un agente de IA ejecuta en una sesión activa_ | _Explora buckets S3 como un sistema de archivos junto a tus servidores SFTP_ |

|                             Transferencias                             |                          Sincronización de directorios                          |
| :---------------------------------------------------------------: | :--------------------------------------------------------------: |
|          ![Panel de transferencias](screenshots/transfers.png)          |            ![Sincronización de directorios](screenshots/sync.png)            |
| _Descargas/subidas en cola con progreso y avisos de sobrescritura_ | _Previsualiza un plan de sincronización unidireccional antes de mover nada_ |

<details>
<summary><strong>Ver todas las capturas</strong></summary>

<br>

|                          Acciones de archivo                          |                       Aprobación del Agent Bridge                        |
| :------------------------------------------------------------: | :----------------------------------------------------------------: |
| ![Menú contextual de acciones de archivo](screenshots/context-menu.png) | ![Aviso de aprobación del Agent Bridge](screenshots/agent-bridge-approve.png) |
| _Duplicar, propiedades, "descargar carpeta como .tar.gz/.zip", "abrir terminal aquí"_ | _Cada comando del agente muestra el comando exacto antes de ejecutarse_ |

|                          Nueva conexión                          |                             Configuración                             |
| :--------------------------------------------------------------: | :--------------------------------------------------------------: |
|      ![Nueva conexión](screenshots/new-connection.png)      |          ![Configuración](screenshots/settings.png)          |
| _Un editor de perfiles para los trece backends, con selector de protocolo en una barra lateral_ | _Temas, comportamiento del terminal, transferencias y el editor predeterminado_ |

</details>
<!-- FARO:SHOTS:END -->

## 🎯 Funcionalidades

> **Una lista de conexiones, trece backends.** Explorar, transferir, sincronizar y las herramientas de uso de disco / diff / búsqueda funcionan igual en todos — todo detrás de un único trait `RemoteFs`.

### 📡 Backends y Almacenamiento

| | |
|---|---|
| **SFTP / FTP / FTPS**<br>Los clásicos, bien hechos — una sesión SSH compartida entre el navegador de archivos y el panel del terminal. | **S3-compatible**<br>Preajustes para AWS, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO, Storj, Hetzner, Scaleway, Oracle OCI, IBM COS, Supabase y autoalojados genéricos (Ceph RGW, Garage, SeaweedFS). |
| **Azure Blob y Google Cloud Storage**<br>Almacenamiento de objetos de primera clase junto a tus servidores. | **WebDAV y HTTP(S)**<br>Exploración de Nextcloud / ownCloud, además de autoindex HTTP de solo lectura y fuentes por URL directa. |
| **Nubes personales**<br>Dropbox, OneDrive, Google Drive y Box — OAuth con loopback + PKCE, solo el refresh token en el llavero de tu SO. | **Faro Agent**<br>El propio agente emparejado de Faro como backend — explora, transfiere y ejecuta en una máquina sin servidor SSH. |

### 🔁 Transferencias y Sincronización

| | |
|---|---|
| **Transferencias de arrastrar y soltar**<br>Entre paneles, directorios recursivos, multiselección, políticas de sobrescribir/omitir/renombrar, subida multiparte para objetos > 16 MB. | **Sincronización de directorios**<br>Previsualiza un plan unidireccional (Aditivo o Espejo) y luego ejecútalo — entre cualquier par de backends. |
| **Sincronización continua de carpetas**<br>Vincula una carpeta local a una ruta remota y se mantiene espejada — watcher + reconciliador por sondeo, patrones de exclusión, límite de borrado en espejo. | **Edición in situ**<br>Abre un archivo remoto en tu editor local; subida automática en cada guardado, con un indicador en la barra de estado. |

### 🔎 Explorar, Comparar y Buscar

| | |
|---|---|
| **Explorador de Uso de Disco**<br>Treemap estilo WinDirStat/WizTree + árbol ordenado por tamaño sobre cualquier backend, con vía rápida de shell `du`/`find`. | **Directory Diff**<br>Meld/Beyond-Compare para cualquier par de backends — incluido **remoto ↔ remoto** (staging vs prod, dos buckets). Comparación por tamaño o por `--hash`. |
| **Fleet Search**<br>Busca por nombre o contenido — `rg`/`grep` del lado del servidor en servidores SSH y Agent, listado plano de claves en buckets. | **Paridad con el CLI**<br>Las tres están en `faro-cli` (`diff`, `search`) y expuestas como herramientas MCP (`faro_diff`, `faro_search`). |

### 🤖 IA y Automatización

| | |
|---|---|
| **Agent Bridge**<br>Presta tu sesión autenticada a Claude Code o a cualquier agente MCP — solo localhost, bearer token, aprobación por comando. [Detalles ↓](#-agent-bridge) | **Fleet Skills**<br>Flujos de trabajo de shell de varios pasos, autorables por IA, que se abanican entre servidores — los skills creados por IA llegan como propuestas que requieren una aprobación humana. |
| **Nativo MCP**<br>Herramientas autodescubiertas en Claude Code; un `SKILL.md` listo para pegar para agentes HTTP simples. | **Registro de auditoría en vivo**<br>Cada comando, aprobación y denegación, directamente en el panel Bridge. |

### 🖥️ Máquinas Remotas y Sesiones

| | |
|---|---|
| **Faro Agent**<br>Controla una máquina Windows/macOS/Linux sin servidor SSH — código de emparejamiento de 6 dígitos, cifrado con Noise, con clave fijada. [Detalles ↓](#-faro-agent--controla-otra-máquina) | **Terminales multi-pestaña**<br>Pestañas de shell SSH reales que comparten una sesión por perfil; las pestañas sobreviven a los cambios sin restablecer el canal. |
| **Verificación de known-hosts**<br>Aviso interactivo de huella digital; las claves que no coinciden muestran una UI en tono de peligro para que los intentos de MITM sean evidentes. | **ssh-agent en todas partes**<br>`$SSH_AUTH_SOCK` en unix, pipe de OpenSSH-for-Windows y Pageant en Windows. |

### 🛠️ Productividad

| | |
|---|---|
| **Importadores de perfiles**<br>Trae conexiones desde `~/.ssh/config`, el `sitemanager.xml` de FileZilla y sesiones de PuTTY. | **Teclado ante todo**<br>Paleta de comandos (Ctrl/⌘-K), columnas ordenables, migas de pan, filtro dentro del panel, toasts, barra de título personalizada con menús. |
| **`faro-cli`**<br>Scriptea todos los backends que habla la GUI, usando los mismos perfiles guardados. [Detalles ↓](#cli) | **UI consciente de capacidades**<br>chmod/mkdir se ocultan en backends que no los soportan; las etiquetas de protocolo muestran a qué estás conectado. |

---

## 🤖 Agent Bridge

**Deja que un agente de IA local ejecute comandos en tus servidores — de forma segura.**

Esta es la parte que hace de Faro algo más que un cliente de archivos. Conéctate a un servidor una vez y Faro puede prestar esa **sesión SSH ya autenticada** a un agente de IA local — Claude Code, Cursor, cualquier cosa que hable [MCP](https://modelcontextprotocol.io) — para que el agente opere en la máquina **sin instalar nada en remoto y sin ver jamás tus credenciales.** Faro sigue siendo el guardián.

> **Por qué es diferente:** la mayoría de las configuraciones de "IA sobre SSH" te obligan a entregar tus claves al agente o a montar un daemon del lado del servidor. Faro no hace ninguna de las dos cosas. El agente toma prestada la sesión que *tú* ya abriste, *tú* apruebas cada comando, y nada llega al servidor salvo los comandos que autorizas.

**Conéctalo a Claude Code — MCP nativo, herramientas autodescubiertas:**

1. Conéctate a un servidor, abre el panel **Bridge** (indicador en la barra de estado), pulsa **Start** y activa **Allow agent access**.
2. Copia la línea que genera el panel y ejecútala en tu proyecto:
   ```bash
   claude mcp add --transport http faro http://127.0.0.1:<port>/mcp \
     --header "Authorization: Bearer <token>"
   ```
3. Claude Code ahora tiene dos herramientas — `faro_list_sessions` y `faro_exec`. Pídele *"revisa el uso de disco del servidor"* y lo ejecutará a través de Faro. (¿Prefieres curl u otro agente? El panel también exporta un `SKILL.md` listo para pegar para la API HTTP simple.)

**Las salvaguardas — todas activadas por defecto:**

- 🔒 **Solo localhost** — vinculado a `127.0.0.1` en un puerto aleatorio.
- 🔑 **Bearer token** — por arranque, requerido en cada petición.
- ☑️ **Opt-in por sesión** — ninguna conexión es accesible hasta que la activas.
- 🙋 **Aprueba cada comando** — cada `exec` muestra un aviso en Faro y se bloquea hasta que haces clic en Approve (o expira).
- 📋 **Registro de auditoría en vivo** — cada comando, aprobación y denegación, directamente en el panel.

Superficie: `GET /health`, `GET /sessions`, `POST /exec` y `POST /mcp` (MCP Streamable HTTP). Es un servidor localhost hecho a mano sobre el runtime tokio existente — **cero dependencias nuevas.**

## 🖥️ Faro Agent — controla otra máquina

Accede a un ordenador completo — Windows, macOS o Linux — de la misma manera en
que ya manejas un servidor remoto, pero **sin configurar un servidor SSH** en
él. Emparéjalo una vez con un código de 6 dígitos (estilo RustDesk) y aparece en
Faro como una conexión que puedes explorar, a través de la cual puedes
transferir archivos y en la que puedes ejecutar comandos nativos. Y como el
[Agent Bridge](#-agent-bridge) intermedia las sesiones de Faro hacia una IA
local, esto permite a Claude Code ejecutar **PowerShell en tu máquina Windows o
`sh` en tu Mac, desde cualquier lugar** — a través de un enlace cifrado, fijado
y gobernado por políticas.

**Si ambas máquinas ya tienen Faro, no hay nada que descargar.** En la que
quieras controlar, abre **Settings → Remote control**, actívalo y haz clic en
**Show pairing code** — luego introduce ese código en tu otro Faro. Listo.

Para un **servidor headless**, una línea instala el agente, lo registra como
servicio y abre una ventana de emparejamiento:

```bash
curl -fsSL https://github.com/jhd3197/Faro/releases/latest/download/install-agentd.sh | sh
```

O maneja tú mismo el binario `faro-agentd` — un solo puerto ahora tanto sirve a
los controladores emparejados como acepta nuevos emparejamientos, así que no hay
que reiniciar nada:

```bash
faro-agentd pair          # sirve + abre una ventana de emparejamiento; imprime un código de 6 dígitos
# luego en Faro: New Connection → Faro Agent → elige esta máquina → introduce el código.
#               Listo — queda fijada; no hace falta código la próxima vez.

faro-agentd run           # sirve a los controladores emparejados (sin ventana de emparejamiento)
faro-agentd install       # ejecútalo como servicio para que sobreviva a los reinicios
faro-agentd install --read-only   # …sirviendo solo exploración + lectura + reporte
faro-agentd info          # identidad de esta máquina + quién está emparejado
```

**Cómo está protegido** — el enlace es un handshake de
[Noise](https://noiseprotocol.org/) (X25519 + ChaCha20-Poly1305), cifrado de
extremo a extremo independientemente de cualquier relay. El emparejamiento
mezcla el código como PSK para que un man-in-the-middle activo no pueda
completarlo; después ambas partes **fijan la clave estática de la otra** y un
par no reconocido es rechazado. La máquina controlada mantiene su **propia**
política (exec/write/read-only) y registro de auditoría, así que un controlador
emparejado nunca puede hacer más de lo que su dueño permitió. El descubrimiento
en LAN es mDNS; el alcance a través de internet (rendezvous + relay) es una fase
posterior. Consulta [`docs/remote-agent.md`](remote-agent.md).

## Backends

Cada backend es una implementación de `RemoteFs`, así que el navegador de doble
panel, la cola de transferencias, la sincronización, el explorador de uso de
disco, diff y la búsqueda lo adoptan gratis. Las diferencias de capacidad (sin
shell en un bucket, solo lectura en HTTP) ocultan las funciones que no soportan
en lugar de reinventarlas.

| Backend | Explorar | Transferir | Sincronizar | Shell |
|---|:-:|:-:|:-:|:-:|
| **SFTP** (SSH) | ✓ | ✓ | ✓ | ✓ |
| **FTP** | ✓ | ✓ | ✓ | — |
| **FTPS** (explícito) | ✓ | ✓ | ✓ | — |
| **S3-compatible** (AWS, R2, B2, Wasabi, …) | ✓ | ✓ | ✓ | — |
| **Azure Blob** | ✓ | ✓ | ✓ | — |
| **Google Cloud Storage** | ✓ | ✓ | ✓ | — |
| **WebDAV** (Nextcloud, ownCloud, …) | ✓ | ✓ | ✓ | — |
| **HTTP(S)** (autoindex / URL directa) | ✓ | descarga | ← solo | — |
| **Dropbox** | ✓ | ✓ | ✓ | — |
| **OneDrive** | ✓ | ✓ | ✓ | — |
| **Google Drive** | ✓ | ✓ | ✓ | — |
| **Box** | ✓ | ✓ | ✓ | — |
| **Faro Agent** | ✓ | ✓ | ✓ | exec |

Las **nubes personales** se autorizan una vez a través de tu navegador (OAuth con
loopback + PKCE); Faro solo guarda el refresh token en el llavero de tu SO y
nunca ve tu contraseña. **HTTP(S)** es una fuente de solo lectura — apúntalo a
un autoindex de nginx/Apache para explorar, o a una URL directa para descargar
un artefacto; las subidas, renombrados y borrados son rechazados.

---

## 🏗️ Arquitectura

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

La clave: **todo pasa por un único trait `RemoteFs`.** Añadir un backend nuevo significa escribir una implementación del trait y un builder; el navegador de doble panel, el planificador de sincronización, las herramientas de uso de disco / diff / búsqueda, el CLI y el motor de transferencias lo adoptan automáticamente.

## Desarrollar

```bash
npm install
npm run tauri dev
```

La primera compilación es lenta — está compilando el árbol de crates de Rust. Las compilaciones siguientes tardan ~30 s.

**Requisitos previos**: Node 20+, Rust 1.88+ (`rustc --version` — las dependencias transitivas de Tauri 2 lo requieren).

## CLI

Un binario independiente, `faro-cli` — su propio crate de workspace bajo `src-tauri/faro-cli/` — reutiliza tus perfiles guardados de la GUI. Los binarios precompilados se publican con cada [release](https://github.com/jhd3197/faro/releases/latest), o compílalo tú mismo:

```bash
cd src-tauri
cargo build -p faro-cli --release
# → src-tauri/target/release/faro-cli

# Operaciones de archivos — cualquier backend, usando tus perfiles guardados
faro-cli profiles list
faro-cli ls prod:/var/log
faro-cli cp ./report.pdf prod:/var/www/uploads
faro-cli sync ./site prod:/var/www/site --mirror --dry-run
faro-cli rm prod:/tmp/build --recursive

# Comparar y buscar — remoto↔remoto también funciona
faro-cli diff prod:/etc staging:/etc --hash
faro-cli search prod:/var/log "OutOfMemory" --content --regex
faro-cli exec prod 'systemctl status api'      # shell de perfil SSH

# Maneja el Agent Bridge de la app (pasa por la aprobación + consola de Faro)
faro-cli agent exec prod 'journalctl -u api -n 100'
faro-cli agent exec prod --detach 'apt-get -y upgrade'   # id de trabajo en segundo plano
faro-cli agent write prod /etc/app/patch.conf --from-file ./patch.conf
faro-cli skill run deploy --target all --param branch=main --dry-run

# Descarga una página protegida por autenticación con las credenciales de un perfil HTTP(S) guardado
faro-cli fetch https://staging.example.com/admin

faro-cli self-update --check   # el CLI se publica por separado y puede ir por detrás de la app
```

El CLI refleja la GUI: `ls · cp · mv · rm · mkdir · sync · diff · search ·
exec · profiles`, además de `agent` (maneja el Agent Bridge en ejecución —
`exec`, `script`, `write`, `read`, `job`/`jobs` en segundo plano, `search`,
`download`, `upload`), `skill`, `fetch` y `self-update`. Sintaxis de rutas: las
rutas simples son locales (incluidas las de Windows `C:\…`), `name:/path`
referencia un perfil guardado — así que `diff`/`sync` pueden abarcar dos
remotos. Pregunta por stdin ante claves de host desconocidas y nunca escribe en
disco secretos que la GUI no hubiera guardado ya.

## Estructura

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

## El problema del PATH en Windows

Si instalaste Rust vía Chocolatey (`choco install rust`), hay un `rustc.exe` en `C:\ProgramData\chocolatey\bin` que **ensombrece** la toolchain gestionada por rustup. `rustup update stable` actualiza la copia de rustup pero no toca la de chocolatey, así que `rustc --version` sigue reportando la versión antigua y las compilaciones de Tauri fallan con mensajes como `rustc 1.85.0 is not supported by darling@0.23.0`.

```powershell
# Opción A — desinstala la copia de chocolatey (recomendado)
choco uninstall rust

# Opción B — conserva ambas, pero haz que rustup gane en este shell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
```

---

## 🗺️ Hoja de Ruta

- **v1.0** — modo de sincronización unidireccional
- **v1.1** — binario `faro-cli`
- **v1.2** — editor externo con edición in situ
- **v1.3** — barra de título personalizada con menús File/Edit/View/Help + controles de ventana integrados; pipeline de releases con GitHub Actions + CI
- **v1.3** — mejora de densidad de la UI (temas con nombre, paleta de comandos, columnas de detalle ordenables, migas de pan, filtro dentro del panel, toasts); el **🤖 Agent Bridge** (acceso de comandos para agentes de IA sobre MCP nativo); y **🖥️ Faro Agent** — controla una máquina Windows/macOS/Linux emparejada (explorar, transferir, exec nativo) a través de un enlace cifrado y fijado, sin necesidad de servidor SSH. Ahora con **Remote control dentro de la app** (aloja el agente desde la app Faro — sin descarga aparte), un único puerto de daemon siempre emparejable, configuración de servicio con `faro-agentd install` + instalador headless de una línea, y deep links `faro://` para "Conectar con Faro" en un clic desde un panel de hosting
- **reciente** — **más backends** (preajustes S3 para una docena de proveedores, Google Cloud Storage, WebDAV, HTTP de solo lectura y las nubes OAuth Dropbox / OneDrive / Google Drive / Box); **Explorador de Uso de Disco**, **Directory Diff** (incl. remoto↔remoto) y **Fleet Search** sobre cualquier backend; **Fleet Skills** (automatizaciones de flota autorables por IA); **sincronización continua de carpetas** con patrones de exclusión + protección de borrado en espejo; y un DX más pulido de **`faro-cli` / ejecución remota con Agent Bridge** — trabajos en segundo plano, `agent write`, `agent script`/`--stdin`, `fetch` autenticado y autoactualización por desfase de versión del CLI
- **próximo** — backend SMB/CIFS (NAS / recursos compartidos de Windows); marcadores de posición de "carpeta virtual" bajo demanda (primero en Windows, hoy tras feature flag); sincronización bidireccional + resolución de conflictos; logos de marca/protocolo en la barra y el selector; alcance de Faro Agent a través de internet (rendezvous + NAT hole-punch + relay de reserva); límites de velocidad de transferencia y edición de la cola (prioridad/reintento/pausa)
- **pulido de release** — firma de código (certificado Apple Developer / Windows EV), auto-actualizador de Tauri, landing page

---

## 📖 Documentación

| Documento | Descripción |
|----------|-------------|
| [Remote Agent](remote-agent.md) | Protocolo de Faro Agent, emparejamiento y modelo de seguridad |
| [Deep Links](deep-links.md) | Enlaces `faro://` de "Conectar con Faro" en un clic |
| [Screenshot Capture](screenshots/CAPTURE.md) | La lista de capturas y cómo reproducir las capturas del README |
| [Updater Key Custody](updater-key-custody.md) | Manejo de la clave de firma para el actualizador de Tauri |

---

## 🧱 Stack Tecnológico

| Capa | Tecnología |
|-------|------------|
| Shell de la app | Tauri 2 (Rust) |
| Frontend | React 18, TypeScript, Vite, Zustand, xterm.js, Tailwind CSS |
| Núcleo del backend | Rust — un trait `RemoteFs` sobre 13 backends |
| SSH | russh (SFTP + PTY), integración con ssh-agent / Pageant |
| Almacenamiento de objetos | SDKs de S3, Azure Blob, Google Cloud Storage |
| Nubes personales | OAuth con loopback + PKCE (Dropbox, OneDrive, Google Drive, Box) |
| Enlace del agente | Protocolo Noise (X25519 + ChaCha20-Poly1305), descubrimiento mDNS |
| Superficie de IA | MCP Streamable HTTP + bridge REST en localhost |
| Estado | SQLite empaquetado (`faro.db`) |
| CLI | `faro-cli` (clap) · daemon headless `faro-agentd` |

---

## 🤝 Contribuir

¡Las contribuciones son bienvenidas!

```
fork → rama de feature → commit → push → pull request
```

**Áreas prioritarias:** nuevos backends (una implementación de `RemoteFs` y funciona en todas partes), pulido de UI/UX, documentación, cobertura de tests.

## Iconos

```bash
# Reemplaza src-tauri/icons/source.png con un PNG de 1024×1024, luego:
npm run tauri icon src-tauri/icons/source.png
```

`scripts/process-icon.py` se encarga de recortar un PNG fuente con borde negro a su arte de cuadrado redondeado y escribir `source.png` en el tamaño correcto.

---

## 💛 Apoya a Faro

Faro es gratuito y de código abierto. Si te ahorra tiempo, puedes ayudar a mantenerlo:

- ⭐ [Dale una estrella al repo](https://github.com/jhd3197/faro) — no cuesta nada y ayuda mucho
- 💖 [GitHub Sponsors](https://github.com/sponsors/jhd3197)
- ☕ [Buy Me a Coffee](https://buymeacoffee.com/jhd3197)

### 💎 Cripto

| | Activo | Red | Dirección |
|:---:|---|---|---|
| <img src="images/funding/usdt-trc20.png" width="110" alt="Código QR de la dirección de donación USDT TRC-20" /> | **USDT** | **TRC-20** · Tron | `TTiCtqLauF1iSW2YGB3b78KmRxRqoLCgeL` |
| <img src="images/funding/usdt-erc20.png" width="110" alt="Código QR de la dirección de donación USDT y ETH ERC-20" /> | **USDT / ETH** | **ERC-20** · Ethereum | `0xD13D5355Fa214e8317fea2ff192a065BaeC13527` |
| <img src="images/funding/btc.png" width="110" alt="Código QR de la dirección de donación de Bitcoin" /> | **BTC** | **Bitcoin** | `bc1qatx67n3qxdvuv3arc9j8aytk34f22g02k9c7vr` |
| <img src="images/funding/sol.png" width="110" alt="Código QR de la dirección de donación de Solana" /> | **SOL** | **Solana** | `AWXzqtBEgUfteHPQtDegsZ6D5y57M3GGdKPD8rR7h6xu` |

TRC-20 tiene las comisiones más bajas — normalmente menos de un dólar — así que
es la opción más amigable para una donación pequeña. El gas de ERC-20 puede
costar más que la propia donación.

<sub>Los códigos QR se generan localmente con [`scripts/generate-funding-qr.mjs`](../scripts/generate-funding-qr.mjs), que valida el checksum de cada dirección antes de codificarla.</sub>

---

## 🔭 Proyectos Relacionados

**[ServerKit](https://github.com/jhd3197/ServerKit)** — Un panel de control de servidores ligero y moderno para gestionar aplicaciones web, bases de datos, contenedores Docker y seguridad — sin la complejidad de Kubernetes ni el coste de las plataformas gestionadas.

> Faro es el compañero de escritorio para la transferencia de archivos práctica, shells y trabajo ad-hoc en todas tus máquinas; ServerKit gestiona tus servidores desde el navegador.

**[LocalKit](https://github.com/jhd3197/LocalKit)** — Levanta sitios locales de WordPress en un clic. Cada sitio se ejecuta como su propio proyecto aislado de Docker Compose, y puedes enviar código o enviar/recibir bases de datos directamente a tu servidor ServerKit a través de la extensión `serverkit-localkit`.

**[DeviceKit](https://github.com/jhd3197/DeviceKit)** — Una plataforma unificada de flota de dispositivos Android y automatización de pruebas. Controla una flota de dispositivos desde un solo panel — ejecuta automatizaciones, transmite pantallas en tiempo real, detecta regresiones visuales y depura fallos con análisis impulsado por IA.

---

## 💬 Comunidad

[![Discord](https://img.shields.io/badge/Discord-Join_Us-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/ZKk6tkCQfG)

Únete al Discord para hacer preguntas, compartir comentarios u obtener ayuda con tu configuración.

---

## 📄 Licencia

MIT — consulta [LICENSE](../LICENSE).

---

<div align="center">

**Faro** — Servidores · almacenamiento · sesiones, todo en un solo espacio de trabajo.

[Reportar un Bug](https://github.com/jhd3197/faro/issues) · [Solicitar una Función](https://github.com/jhd3197/faro/issues)

Hecho con ❤️ por [Juan Denis](https://juandenis.com)

</div>
