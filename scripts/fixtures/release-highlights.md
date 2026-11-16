Faro could already tell you what was eating a server's disk, but to find out what the machine was actually doing you still had to open a terminal and start typing `top`, `systemctl` and `docker ps` from memory. This release adds a Server view for SSH connections: live CPU, memory and network charts, systemd services you can restart, listening ports, a read-only firewall view, and a Docker tab with containers, live logs, stats, images, volumes, networks and a one-click shell into any container. All of it is agentless, so it runs plain commands over the SSH session the connection already holds and installs nothing on the server. That decided most of the design: one long-lived channel per server for the metrics loop (sshd caps channels per connection, and SFTP and every terminal pane share that cap), lists that poll only when they can do it without sudo (every sudo call lands in the server's auth log), and the connection's own password handed to sudo only after the user agrees, once per session. Verifying it against a real host turned up a nasty one: stopping a log stream that ran under sudo used `kill -TERM -<pgid>`, which the system `kill` binary reads as "every process", so it is fixed here along with an older timeout kill that had the same flaw. The branch also brings in three changes already on `dev`: a first-run walkthrough with visible release notes, a draggable divider between the file panes, and per-site memory of the folders you were browsing.

### Highlights

- A Server view for any SSH connection, opened from the status bar, the command palette or the connection's menu, with live CPU, memory and network charts, per-core load, uptime and a filesystems table that hands any mount to Disk Usage.
- Services, Ports and Firewall tabs: failed systemd units sort to the top, and restart, start and stop always confirm with the exact command first. Logs follow the journal live, ports show what is reachable from outside, and the firewall view reads ufw, firewalld, nftables or iptables without changing anything.
- A Docker tab that groups Compose projects and shows each container's status, ports, CPU and memory. Start, stop and restart are one click; kill and remove confirm first. A details panel shows ports, mounts and networks, with environment values hidden until you ask.
- Live container logs with colour, pause and copy, and a Shell button that opens a terminal tab already inside the container, using bash when it has one and sh when it doesn't.
- Images, volumes and networks name the containers that use them. Removing a volume warns that its data goes with it, Docker's own refusal is shown when something is still in use, and prune runs one resource type at a time after showing what it would reclaim.
- Servers where Docker or root is only reachable through sudo keep working: Faro asks once before using the connection's password, and where a live log can't type that password it shows the latest lines with a Refresh button instead.
- A welcome walkthrough on first launch, release notes you can read from the update bar or Settings › About, a draggable and keyboard-resizable divider between the local and remote panes, and site shortcuts that remember their own local and remote folders across reconnects and restarts.

<details>
<summary>Technical changes</summary>

**Safety**

- Remote process-group kills are now spelled `kill -s SIG -- -<pgid>` through one helper, `session::signal_group_cmd`. The old form `kill -TERM -<pgid>` is only safe where `kill` is a shell builtin; the procps binary, which `sudo kill` runs and which fish uses for lack of a builtin, reads the leading `-1` as pid `-1` and signals every process the caller may signal. `kill -s SIG -- -PGID` is the only form that hits the group, and only the group, in procps, dash, bash, zsh, fish and busybox.

</details>
