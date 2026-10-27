use super::ProfilePreview;
use crate::profiles::{ProxyCommandConfig, ProxyCommandKind, ProxyConfig, ProxyKind};
use anyhow::{Context, Result};
use std::path::PathBuf;

/// Resolve the default location of the user's OpenSSH client config.
pub fn default_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("config"))
}

/// Parse an OpenSSH client config file into one ProfilePreview per Host
/// block. Wildcard / pattern hosts (those containing `*` or `?`) are
/// skipped — they're configuration scaffolding, not actual targets.
///
/// We support a small but sufficient subset of OpenSSH directives:
/// Host, Hostname, User, Port, IdentityFile, CertificateFile, ProxyJump, and
/// ProxyCommand:
/// the common forms (`nc -X`, `ncat --proxy`, `connect -S/-H`, `ssh -W`)
/// become a Faro proxy or jump host, `cloudflared access ssh` becomes
/// Cloudflare Access, and any other command is kept as the SSH transport.
/// Everything else is ignored. Include/Match etc. are
/// deliberately out of scope — most desktop users have flat config files
/// and that's the case we want to cover.
pub fn parse_file(path: &PathBuf) -> Result<Vec<ProfilePreview>> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("Couldn't read {}", path.display()))?;
    Ok(parse(&text, path.display().to_string()))
}

pub fn parse(text: &str, source_label: String) -> Vec<ProfilePreview> {
    let mut blocks: Vec<HostBlock> = Vec::new();
    let mut current: Option<HostBlock> = None;

    for raw_line in text.lines() {
        let line = strip_comment(raw_line).trim();
        if line.is_empty() {
            continue;
        }
        let (key, value) = match split_kv(line) {
            Some(kv) => kv,
            None => continue,
        };
        let key_lc = key.to_ascii_lowercase();

        if key_lc == "host" {
            // Flush the previous block, start a new one for the first
            // non-wildcard alias on this line.
            blocks.extend(current.take());
            let alias = value.split_whitespace().find(|a| !is_pattern(a));
            current = alias.map(|a| HostBlock::new(a.to_string()));
        } else if let Some(block) = current.as_mut() {
            // OpenSSH keeps the first value it sees for each directive.
            match key_lc.as_str() {
                "hostname" => {
                    block.hostname.get_or_insert_with(|| value.to_string());
                }
                "user" => {
                    block.user.get_or_insert_with(|| value.to_string());
                }
                "port" => {
                    if block.port.is_none() {
                        block.port = value.parse().ok();
                    }
                }
                "identityfile" => {
                    block.identity.get_or_insert_with(|| expand_tilde(value));
                }
                "certificatefile" => {
                    block.certificate.get_or_insert_with(|| expand_tilde(value));
                }
                "proxyjump" if block.via.is_none() => {
                    block.via = parse_proxy_jump(value);
                }
                "proxycommand" if block.via.is_none() => {
                    block.via = parse_proxy_command(value);
                }
                _ => {}
            }
        }
    }
    blocks.extend(current);

    let mut out: Vec<ProfilePreview> = Vec::new();
    // Bastions named by `user@host:port` rather than a Host alias become
    // previews of their own, one per distinct spec.
    let mut extra: Vec<(String, ProfilePreview)> = Vec::new();
    let mut pending: Vec<(usize, Hop)> = Vec::new();
    for block in blocks {
        let via = block.via.clone();
        let Some(preview) = block.into_preview(&source_label) else {
            continue;
        };
        match via {
            Some(Via::Proxy(proxy)) => {
                let mut preview = preview;
                preview.proxy = Some(proxy);
                out.push(preview);
            }
            Some(Via::Command(cmd)) => {
                let mut preview = preview;
                preview.proxy_command = Some(cmd);
                out.push(preview);
            }
            Some(Via::Jump(hop)) => {
                pending.push((out.len(), hop));
                out.push(preview);
            }
            None => out.push(preview),
        }
    }
    for (i, hop) in pending {
        let (id, name) = match out.iter().find(|p| p.name == hop.host) {
            Some(alias) => (alias.preview_id.clone(), alias.name.clone()),
            None => {
                let spec = hop.spec();
                if let Some((_, p)) = extra.iter().find(|(s, _)| *s == spec) {
                    (p.preview_id.clone(), p.name.clone())
                } else {
                    let mut p = ProfilePreview::new(hop.host.clone());
                    p.host = hop.host.clone();
                    p.port = hop.port.unwrap_or(22);
                    p.username = hop.user.clone().unwrap_or_default();
                    p.note = Some(format!("jump host, from {source_label}"));
                    let ids = (p.preview_id.clone(), p.name.clone());
                    extra.push((spec, p));
                    ids
                }
            }
        };
        let target = &mut out[i];
        target.note = Some(format!("{} · via {name}", target.note.as_deref().unwrap_or("")));
        target.jump_preview_id = Some(id);
        target.jump_name = Some(name);
    }
    out.extend(extra.into_iter().map(|(_, p)| p));
    out
}

#[derive(Debug, Clone, PartialEq)]
struct Hop {
    user: Option<String>,
    host: String,
    port: Option<u16>,
}

impl Hop {
    fn spec(&self) -> String {
        format!(
            "{}@{}:{}",
            self.user.as_deref().unwrap_or(""),
            self.host,
            self.port.unwrap_or(22)
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Via {
    Jump(Hop),
    Proxy(ProxyConfig),
    Command(ProxyCommandConfig),
}

/// `ProxyJump [user@]host[:port][,...]`. Faro chains through profiles, so the
/// hop nearest the target is the one recorded; when it's a Host alias, that
/// block's own ProxyJump carries the rest of the chain.
fn parse_proxy_jump(value: &str) -> Option<Via> {
    if value.eq_ignore_ascii_case("none") {
        return None;
    }
    let last = value.split(',').map(str::trim).filter(|h| !h.is_empty()).last()?;
    parse_hop(last.strip_prefix("ssh://").unwrap_or(last)).map(Via::Jump)
}

fn parse_hop(spec: &str) -> Option<Hop> {
    let (user, rest) = match spec.rsplit_once('@') {
        Some((u, r)) => (Some(u.to_string()), r),
        None => (None, spec),
    };
    let (host, port) = split_host_port(rest)?;
    Some(Hop { user, host, port })
}

/// `host`, `host:port`, `[v6]` or `[v6]:port`.
fn split_host_port(s: &str) -> Option<(String, Option<u16>)> {
    if let Some(rest) = s.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = after.strip_prefix(':').and_then(|p| p.parse().ok());
        return Some((host.to_string(), port));
    }
    match s.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => Some((h.to_string(), p.parse().ok())),
        _ if s.is_empty() => None,
        _ => Some((s.to_string(), None)),
    }
}

/// A ProxyCommand as a Faro proxy, jump host or proxy command. `none`
/// means direct.
fn parse_proxy_command(value: &str) -> Option<Via> {
    if value.trim().eq_ignore_ascii_case("none") {
        return None;
    }
    translate_proxy_command(value)
        .or_else(|| cloudflare_access(value))
        .or_else(|| {
            Some(Via::Command(ProxyCommandConfig {
                kind: ProxyCommandKind::Command,
                command: value.trim().to_string(),
                hostname: None,
                service_token_id: None,
                service_token_secret: None,
            }))
        })
}

/// `cloudflared access ssh --hostname %h|<name>` with nothing else.
fn cloudflare_access(value: &str) -> Option<Via> {
    let args = crate::proxy_command::split(value).ok()?;
    let mut args = args.iter().map(String::as_str);
    let prog = args.next()?.rsplit(['/', '\\']).next()?;
    let prog = prog.strip_suffix(".exe").unwrap_or(prog);
    if !prog.eq_ignore_ascii_case("cloudflared") || args.next()? != "access" || args.next()? != "ssh" {
        return None;
    }
    let rest: Vec<&str> = args.collect();
    let hostname = match rest.as_slice() {
        [flag, h] if matches!(*flag, "--hostname" | "--tunnel-host" | "-T") => *h,
        [one] => one.strip_prefix("--hostname=")?,
        _ => return None,
    };
    Some(Via::Command(ProxyCommandConfig {
        kind: ProxyCommandKind::Cloudflare,
        command: String::new(),
        // `%h` is the profile's own host, which is the default.
        hostname: (hostname != "%h").then(|| hostname.to_string()),
        service_token_id: None,
        service_token_secret: None,
    }))
}

/// The ProxyCommand forms that map onto a Faro proxy or jump host:
/// `nc -X 5|connect -x host:port %h %p`, `ncat --proxy host:port
/// --proxy-type socks5|http %h %p`, `connect -S|-H host:port %h %p`, and
/// `ssh -W %h:%p [user@]bastion`.
fn translate_proxy_command(value: &str) -> Option<Via> {
    let args: Vec<&str> = value.split_whitespace().collect();
    let prog = args.first()?.rsplit(['/', '\\']).next()?.trim_end_matches(".exe");
    let flag = |name: &str| args.iter().position(|a| *a == name).and_then(|i| args.get(i + 1)).copied();
    let proxy = |kind: ProxyKind, addr: &str, default_port: u16| {
        let (host, port) = split_host_port(addr)?;
        Some(Via::Proxy(ProxyConfig {
            kind,
            host,
            port: port.unwrap_or(default_port),
            username: None,
            password: None,
        }))
    };
    match prog {
        "nc" | "ncat" | "netcat" if flag("--proxy").is_some() => {
            let kind = match flag("--proxy-type") {
                Some("socks5") => ProxyKind::Socks5,
                Some("http") | None => ProxyKind::Http,
                _ => return None,
            };
            let default = if kind == ProxyKind::Socks5 { 1080 } else { 3128 };
            proxy(kind, flag("--proxy")?, default)
        }
        "nc" | "ncat" | "netcat" => match flag("-X") {
            Some("5") => proxy(ProxyKind::Socks5, flag("-x")?, 1080),
            Some("connect") => proxy(ProxyKind::Http, flag("-x")?, 3128),
            // nc's default protocol with -x alone is SOCKS5.
            None if flag("-x").is_some() => proxy(ProxyKind::Socks5, flag("-x")?, 1080),
            _ => None,
        },
        "connect" | "connect-proxy" => match (flag("-S"), flag("-H")) {
            (Some(addr), _) => proxy(ProxyKind::Socks5, addr, 1080),
            (_, Some(addr)) => proxy(ProxyKind::Http, addr, 3128),
            _ => None,
        },
        "ssh" if args.iter().any(|a| *a == "-W") => {
            // The bastion is the one positional argument that isn't -W's value.
            let mut skip = false;
            let mut user = None;
            let mut port = None;
            let mut target = None;
            for (i, a) in args.iter().enumerate().skip(1) {
                if skip {
                    skip = false;
                    continue;
                }
                match *a {
                    "-W" => skip = true,
                    "-l" => user = args.get(i + 1).map(|s| s.to_string()),
                    "-p" => port = args.get(i + 1).and_then(|s| s.parse().ok()),
                    _ => {}
                }
                if a.starts_with('-') {
                    // Options that take a value.
                    skip = skip || matches!(*a, "-l" | "-p" | "-i" | "-o" | "-F" | "-J");
                    continue;
                }
                target = Some(*a);
            }
            let mut hop = parse_hop(target?)?;
            hop.user = hop.user.or(user);
            hop.port = hop.port.or(port);
            Some(Via::Jump(hop))
        }
        _ => None,
    }
}

fn split_kv(line: &str) -> Option<(&str, &str)> {
    let bytes = line.as_bytes();
    let key_end = bytes
        .iter()
        .position(|&b| b == b' ' || b == b'\t' || b == b'=')?;
    let key = &line[..key_end];
    let rest = line[key_end..].trim_start_matches(|c: char| c.is_whitespace() || c == '=');
    // `IdentityFile "~/.ssh/my key"`: the quotes aren't part of the value.
    let rest = rest
        .trim_end()
        .strip_prefix('"')
        .and_then(|r| r.strip_suffix('"'))
        .unwrap_or(rest);
    Some((key, rest))
}

fn strip_comment(line: &str) -> &str {
    match line.find('#') {
        Some(i) => &line[..i],
        None => line,
    }
}

fn is_pattern(host: &str) -> bool {
    host.contains('*') || host.contains('?') || host.contains('!')
}

fn expand_tilde(value: &str) -> String {
    crate::keys::expand_tilde(value).to_string_lossy().into_owned()
}

struct HostBlock {
    alias: String,
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity: Option<String>,
    certificate: Option<String>,
    via: Option<Via>,
}

impl HostBlock {
    fn new(alias: String) -> Self {
        Self {
            alias,
            hostname: None,
            user: None,
            port: None,
            identity: None,
            certificate: None,
            via: None,
        }
    }

    fn into_preview(self, source_label: &str) -> Option<ProfilePreview> {
        // A Host block with no Hostname falls back to using the alias as the
        // target — that's how OpenSSH itself treats `ssh prod` where `prod`
        // is both the alias and the resolvable name.
        let host = self.hostname.unwrap_or_else(|| self.alias.clone());
        if host.is_empty() {
            return None;
        }
        let mut p = ProfilePreview::new(self.alias);
        p.protocol = "sftp".into();
        p.host = host;
        p.port = self.port.unwrap_or(22);
        p.username = self.user.unwrap_or_default();
        p.identity_file = self.identity;
        // A certificate is only used with a key.
        p.certificate_file = self.certificate.filter(|_| p.identity_file.is_some());
        p.note = Some(format!("from {source_label}"));
        Some(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn by_name<'a>(ps: &'a [ProfilePreview], name: &str) -> &'a ProfilePreview {
        ps.iter().find(|p| p.name == name).unwrap_or_else(|| panic!("no {name}"))
    }

    #[test]
    fn quoted_identity_file_drops_the_quotes() {
        let cfg = "Host web
  HostName web.example
  IdentityFile \"/keys/my key\"
";
        let ps = parse(cfg, "test".into());
        assert_eq!(by_name(&ps, "web").identity_file.as_deref(), Some("/keys/my key"));
    }

    #[test]
    fn certificate_file_rides_with_the_key() {
        let cfg = "Host ca
  HostName ca.example
  IdentityFile /keys/id_ed25519
  CertificateFile /keys/id_ed25519-cert.pub

Host nokey
  CertificateFile /keys/stray-cert.pub
";
        let ps = parse(cfg, "test".into());
        assert_eq!(by_name(&ps, "ca").certificate_file.as_deref(), Some("/keys/id_ed25519-cert.pub"));
        assert!(by_name(&ps, "nokey").certificate_file.is_none());
        let profile = by_name(&ps, "ca").clone().into_profile();
        assert!(matches!(
            profile.auth,
            crate::profiles::AuthMethod::Key { cert_path: Some(ref c), .. } if c == "/keys/id_ed25519-cert.pub"
        ));
    }

    #[test]
    fn proxy_jump_links_aliases_and_synthesizes_hops() {
        let cfg = "\
Host bastion
  HostName bastion.example.com
  User ops

Host app
  HostName 10.0.0.5
  ProxyJump bastion

Host db
  HostName 10.0.0.6
  ProxyJump admin@gw.example.com:2222

Host cache
  HostName 10.0.0.7
  ProxyJump other,admin@gw.example.com:2222
";
        let ps = parse(cfg, "test".into());
        let bastion = by_name(&ps, "bastion");
        let app = by_name(&ps, "app");
        assert_eq!(app.jump_preview_id.as_deref(), Some(bastion.preview_id.as_str()));
        assert_eq!(app.jump_name.as_deref(), Some("bastion"));
        assert!(bastion.jump_preview_id.is_none());

        // An unaliased hop becomes one shared preview.
        let gw = by_name(&ps, "gw.example.com");
        assert_eq!((gw.username.as_str(), gw.port), ("admin", 2222));
        assert_eq!(by_name(&ps, "db").jump_preview_id.as_deref(), Some(gw.preview_id.as_str()));
        assert_eq!(by_name(&ps, "cache").jump_preview_id.as_deref(), Some(gw.preview_id.as_str()));
        assert_eq!(ps.len(), 5);
    }

    #[test]
    fn proxy_command_forms() {
        let socks = |host: &str, port| {
            Some(Via::Proxy(ProxyConfig {
                kind: ProxyKind::Socks5,
                host: host.into(),
                port,
                username: None,
                password: None,
            }))
        };
        let http = |host: &str, port| {
            Some(Via::Proxy(ProxyConfig {
                kind: ProxyKind::Http,
                host: host.into(),
                port,
                username: None,
                password: None,
            }))
        };
        assert_eq!(parse_proxy_command("nc -X 5 -x proxy:1081 %h %p"), socks("proxy", 1081));
        assert_eq!(parse_proxy_command("/usr/bin/nc -X connect -x proxy:8080 %h %p"), http("proxy", 8080));
        assert_eq!(parse_proxy_command("nc -x proxy %h %p"), socks("proxy", 1080));
        assert_eq!(
            parse_proxy_command("ncat --proxy proxy:1080 --proxy-type socks5 %h %p"),
            socks("proxy", 1080)
        );
        assert_eq!(parse_proxy_command("connect -H proxy:3128 %h %p"), http("proxy", 3128));
        assert_eq!(parse_proxy_command("connect.exe -S proxy %h %p"), socks("proxy", 1080));
        assert_eq!(
            parse_proxy_command("ssh -q -W %h:%p -p 2200 ops@bastion"),
            Some(Via::Jump(Hop { user: Some("ops".into()), host: "bastion".into(), port: Some(2200) }))
        );
        assert_eq!(parse_proxy_command("none"), None);
        assert_eq!(parse_proxy_command("NONE "), None);
    }

    fn cloudflare(hostname: Option<&str>) -> Option<Via> {
        Some(Via::Command(ProxyCommandConfig {
            kind: ProxyCommandKind::Cloudflare,
            command: String::new(),
            hostname: hostname.map(Into::into),
            service_token_id: None,
            service_token_secret: None,
        }))
    }

    fn command(line: &str) -> Option<Via> {
        Some(Via::Command(ProxyCommandConfig {
            kind: ProxyCommandKind::Command,
            command: line.into(),
            hostname: None,
            service_token_id: None,
            service_token_secret: None,
        }))
    }

    #[test]
    fn cloudflared_becomes_cloudflare_access() {
        assert_eq!(parse_proxy_command("cloudflared access ssh --hostname %h"), cloudflare(None));
        assert_eq!(
            parse_proxy_command("/usr/local/bin/cloudflared access ssh --hostname ssh.example.com"),
            cloudflare(Some("ssh.example.com"))
        );
        assert_eq!(
            parse_proxy_command(r#""C:\Program Files (x86)\cloudflared\cloudflared.exe" access ssh --hostname=%h"#),
            cloudflare(None)
        );
        assert_eq!(parse_proxy_command("cloudflared access ssh -T %h"), cloudflare(None));
        // Extra flags (service tokens, logging...) are kept verbatim, not lost.
        let line = "cloudflared access ssh --hostname %h --id abc --secret def";
        assert_eq!(parse_proxy_command(line), command(line));
    }

    #[test]
    fn other_proxy_commands_are_kept_verbatim() {
        for line in [
            "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p",
            "gcloud compute start-iap-tunnel %h %p --listen-on-stdin --zone us-central1-a",
            "sh -c 'nc %h %p'",
            "nc %h %p",
        ] {
            assert_eq!(parse_proxy_command(line), command(line), "{line}");
        }
    }

    #[test]
    fn imported_cloudflare_host_becomes_a_working_profile() {
        let cfg = concat!(
            "Host prod\n",
            "  HostName ssh.example.com\n",
            "  User deploy\n",
            "  ProxyCommand cloudflared access ssh --hostname %h\n",
            "Host ssm\n",
            "  HostName i-0abc\n",
            "  ProxyCommand aws ssm start-session --target %h\n",
            "Host plain\n",
            "  HostName 10.0.0.1\n",
            "  ProxyCommand none\n",
        );
        let profiles = super::super::into_profiles(parse(cfg, "t".into()), &[]);
        let find = |n: &str| profiles.iter().find(|p| p.name == n).unwrap();
        let prod = find("prod");
        assert_eq!((prod.host.as_str(), prod.port, prod.username.as_str()), ("ssh.example.com", 22, "deploy"));
        let pc = prod.proxy_command.as_ref().unwrap();
        assert_eq!((pc.kind, pc.hostname.as_deref()), (ProxyCommandKind::Cloudflare, None));
        assert!(prod.proxy.is_none() && prod.jump_profile.is_none());
        let ssm = find("ssm").proxy_command.as_ref().unwrap();
        assert_eq!((ssm.kind, ssm.command.as_str()), (ProxyCommandKind::Command, "aws ssm start-session --target %h"));
        assert!(find("plain").proxy_command.is_none());
    }

    #[test]
    fn proxy_command_sets_preview_proxy() {
        let ps = parse("Host corp\n  HostName 10.1.1.1\n  ProxyCommand nc -X 5 -x 127.0.0.1:1080 %h %p\n", "t".into());
        let proxy = ps[0].proxy.as_ref().unwrap();
        assert_eq!((proxy.kind, proxy.host.as_str(), proxy.port), (ProxyKind::Socks5, "127.0.0.1", 1080));
        assert_eq!(ps.len(), 1);
    }

    #[test]
    fn unreadable_file_says_why() {
        let path = std::env::temp_dir().join("faro-no-such-dir").join("config");
        let e = parse_file(&path).unwrap_err();
        let msg = format!("{e:#}");
        assert!(msg.starts_with(&format!("Couldn't read {}: ", path.display())), "{msg}");
        assert!(msg.len() > format!("Couldn't read {}: ", path.display()).len(), "{msg}");
    }
}
