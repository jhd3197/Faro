import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useConnections } from "@/stores/connectionsStore";
import { useSettings } from "@/stores/settingsStore";
import { useLayout } from "@/stores/layoutStore";
import { SETTINGS_ENTRY_POINTS, type SettingsEntryPointId } from "@/lib/settingsNav";
import { useDialog } from "@/hooks/useDialog";
import {
  PROTOCOL_DEFAULT_PORT,
  PROTOCOL_LABEL,
  S3_PROVIDER_PRESETS,
  WEBDAV_PROVIDER_PRESETS,
  isObjectProtocol,
  isAgentProtocol,
  type AuthMethod,
  type ConnectionProfile,
  type Protocol,
  type S3Provider,
  type WebdavProvider,
  type DiscoveredAgent,
  type GeneratedKey,
  type SshKeyType,
  type ProxyConfig,
  type ProxyKind,
  type ProxyCommandConfig,
  type ProxyCommandKind,
  type AccessStatus,
} from "@/lib/types";
import {
  ShieldOff,
  Cloud,
  Globe,
  Box,
  Eye,
  EyeOff,
  Wand2,
  Check,
  MonitorSmartphone,
  Radar,
  Loader2,
  Link2,
  KeyRound,
  Copy,
  Sparkles,
  FolderOpen,
  X,
  ChevronRight,
} from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/cn";
import { BrandIcon, protocolIcon } from "@/lib/brandIcons";
import { AccessSignIn, InstallCloudflared } from "./CloudflareSettings";
import type { CfSshHostname } from "@/lib/types";
import { TunnelHealth } from "./CloudflareAccount";
import { BRAND_ICONS } from "@/lib/brandIconData";
import { monogram } from "@/lib/format";
import { IconPicker } from "./IconPicker";
import { generatePassword } from "@/lib/password";
import { ipc, type OAuthApp } from "@/lib/ipc";
import { messageOf } from "@/lib/errors";
import { CopyTextButton } from "@/components/ui/CopyText";
import { toast } from "@/stores/toastStore";

interface Props {
  profile: ConnectionProfile | null;
  /** Seed values for a NEW connection (e.g. from a faro:// deep link). Ignored
   *  when editing an existing profile. Never carries credentials. */
  prefill?: Partial<ConnectionProfile> | null;
  onClose: () => void;
}

function genId(): string {
  return crypto.randomUUID();
}

/// Best-effort hostname from a WebDAV server URL, for the rail label.
function hostFromUrl(u: string): string {
  try {
    return new URL(u.includes("://") ? u : `https://${u}`).hostname;
  } catch {
    return u;
  }
}

/// The port a site URL implies: explicit, else 80 for http and 443 otherwise.
function portFromUrl(u: string): number {
  try {
    const url = new URL(u.includes("://") ? u : `https://${u}`);
    return url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
  } catch {
    return 443;
  }
}

/// Normalize a Shopify store domain for the profile host: strip any
/// scheme/path, and append `.myshopify.com` when only the shop name was typed.
function normalizeShopDomain(s: string): string {
  const t = s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!t) return t;
  return t.endsWith(".myshopify.com") ? t : `${t}.myshopify.com`;
}

/// Normalize a Dynamics 365 environment URL for the profile host: strip any
/// scheme/path, and append `.crm.dynamics.com` when only the org name was
/// typed (regional variants like `.crm4.dynamics.com` are kept as typed).
function normalizeDynamicsUrl(s: string): string {
  const t = s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!t) return t;
  return t.includes(".") ? t : `${t}.crm.dynamics.com`;
}

/// Guess which provider a saved S3 profile belongs to from its endpoint URL.
/// We never need this to be perfect — it just preselects a preset button.
function guessProvider(endpoint?: string): S3Provider {
  if (!endpoint) return "aws";
  const e = endpoint.toLowerCase();
  if (e.includes("r2.cloudflarestorage.com")) return "r2";
  if (e.includes("backblazeb2.com")) return "b2";
  if (e.includes("wasabisys.com")) return "wasabi";
  if (e.includes("digitaloceanspaces.com")) return "spaces";
  if (e.includes("storjshare.io")) return "storj";
  if (e.includes("your-objectstorage.com")) return "hetzner";
  if (e.includes("scw.cloud")) return "scaleway";
  if (e.includes("oraclecloud.com")) return "oci";
  if (e.includes("cloud-object-storage.appdomain.cloud")) return "ibm";
  if (e.includes("supabase.co")) return "supabase";
  // A bare endpoint we don't recognize is some self-hosted / niche S3 server.
  return "generic";
}

/// localStorage key for the editor's "Connect after saving" checkbox.
const CONNECT_AFTER_SAVE_KEY = "faro.editor.connectAfterSave";

/// Protocol picker, grouped for the left rail. New backends slot into a group
/// instead of stretching a flat grid taller — the rail just scrolls.
const PROTOCOL_GROUPS: { label: string; items: Protocol[] }[] = [
  { label: "Servers", items: ["sftp", "ftp", "ftps"] },
  { label: "Object storage", items: ["s3", "azure", "gcs"] },
  { label: "Web", items: ["webdav", "http", "wordpress"] },
  { label: "Cloud drives", items: ["dropbox", "onedrive", "gdrive", "box"] },
  { label: "Commerce", items: ["shopify", "hubspot", "dynamics"] },
  { label: "Machine", items: ["faro-agent"] },
];

// Real vendor marks for the provider preset buttons (Plan 14 Phase 3). A
// provider with no bundled logo (Storj, the "generic"/self-hosted presets)
// falls back to the neutral lucide glyph in the button.
const S3_PROVIDER_ICON: Partial<Record<S3Provider, string>> = {
  aws: "logos:aws-s3",
  r2: "logos:cloudflare",
  b2: "simple-icons:backblaze",
  wasabi: "simple-icons:wasabi",
  spaces: "logos:digital-ocean",
  minio: "simple-icons:minio",
  hetzner: "simple-icons:hetzner",
  scaleway: "simple-icons:scaleway",
  oci: "logos:oracle",
  ibm: "logos:ibm",
  supabase: "logos:supabase-icon",
};

const WEBDAV_PROVIDER_ICON: Partial<Record<WebdavProvider, string>> = {
  nextcloud: "simple-icons:nextcloud",
  owncloud: "simple-icons:owncloud",
  storagebox: "simple-icons:hetzner",
};

export function ProfileEditor({ profile, prefill, onClose }: Props) {
  const saveProfile = useConnections((s) => s.saveProfile);
  const connectProfile = useConnections((s) => s.connect);
  const profiles = useConnections((s) => s.profiles);
  const defaultPort = useSettings((s) => s.defaultPort);

  // Existing rail groups, offered as datalist suggestions for the Group field.
  const knownGroups = Array.from(
    new Set(profiles.map((p) => p.group).filter((g): g is string => !!g))
  );

  // Seed values: the profile being edited, or a deep-link prefill for a new
  // one. `profile` still gates "is this an edit" (title, pairing persistence).
  const seed = profile ?? prefill ?? null;

  // Stable id for the lifetime of the editor, so pairing (which persists to this
  // id) and a later Save target the same profile.
  const [id] = useState(profile?.id ?? genId());
  const [name, setName] = useState(seed?.name ?? "");
  const [protocol, setProtocol] = useState<Protocol>(seed?.protocol ?? "sftp");
  // Faro Agent: the pinned daemon key. Set by pairing; carried through Save.
  const [agentKey, setAgentKey] = useState<string | undefined>(seed?.agentKey);
  const [host, setHost] = useState(seed?.host ?? "");
  const [port, setPort] = useState(seed?.port ?? defaultPort);
  const [portTouched, setPortTouched] = useState<boolean>(!!seed?.port);
  const [username, setUsername] = useState(seed?.username ?? "");
  // A duplicate's prefill carries the source's auth so only what differs needs
  // retyping. A keychain-held key (keyref) is tied to the source's id and can't
  // be copied, so a duplicate of one starts blank.
  const seedAuth =
    profile?.auth ?? (seed?.auth?.kind === "keyref" ? undefined : seed?.auth);
  const [authKind, setAuthKind] = useState<AuthMethod["kind"]>(
    seedAuth?.kind ?? "password"
  );
  const [password, setPassword] = useState(
    seedAuth?.kind === "password" ? seedAuth.password : ""
  );
  const [keyPath, setKeyPath] = useState(
    seedAuth?.kind === "key" ? seedAuth.path : ""
  );
  const [passphrase, setPassphrase] = useState(
    seedAuth?.kind === "key" ? seedAuth.passphrase ?? "" : ""
  );
  const [certPath, setCertPath] = useState(
    seedAuth?.kind === "key" ? seedAuth.certPath ?? "" : ""
  );
  const [defaultLocalPath, setDefaultLocalPath] = useState(seed?.defaultLocalPath ?? "");
  const [defaultRemotePath, setDefaultRemotePath] = useState(
    seed?.defaultRemotePath ?? "."
  );
  const [autoConnect, setAutoConnect] = useState(seed?.autoConnect ?? false);
  // FTP-only: path-name character set ("" = auto).
  const [ftpEncoding, setFtpEncoding] = useState(seed?.ftpEncoding ?? "");
  const [ftpActiveMode, setFtpActiveMode] = useState(seed?.ftpActiveMode ?? false);
  // FTP-only: transfer connections (pool) and connections per download.
  const [ftpMaxConnections, setFtpMaxConnections] = useState(seed?.ftpMaxConnections ?? 2);
  const [ftpSegments, setFtpSegments] = useState(seed?.ftpSegments ?? 1);
  const [proxyKind, setProxyKind] = useState<ProxyKind | "">(seed?.proxy?.kind ?? "");
  const [proxyHost, setProxyHost] = useState(seed?.proxy?.host ?? "");
  const [proxyPort, setProxyPort] = useState(seed?.proxy?.port ?? 1080);
  const [proxyUser, setProxyUser] = useState(seed?.proxy?.username ?? "");
  const [proxyPass, setProxyPass] = useState(seed?.proxy?.password ?? "");
  const [proxyCmd, setProxyCmd] = useState(() => proxyCmdDraft(seed?.proxyCommand, seed?.host));
  const [jumpProfile, setJumpProfile] = useState(seed?.jumpProfile ?? "");
  // "How do you reach this server?" (SFTP). A layout over the same data:
  // `jumpProfile` for a jump host, a Cloudflare `proxyCommand` for Cloudflare.
  const [reach, setReach] = useState<Reach>(() =>
    seed?.jumpProfile ? "jump" : seed?.proxyCommand?.kind === "cloudflare" ? "cloudflare" : "direct"
  );
  // Through Cloudflare, the host is an optional detail: absent = the server.
  const sshHost =
    protocol === "sftp" && reach === "cloudflare" ? host.trim() || proxyCmd.hostname.trim() : host;
  // The SSH host follows the Cloudflare server unless it was set apart.
  const setCfServer = (v: string) => {
    if (!host.trim() || host.trim() === proxyCmd.hostname.trim()) setHost(v);
    setProxyCmd({ ...proxyCmd, hostname: v });
  };
  const [group, setGroup] = useState(seed?.group ?? "");
  // Custom rail bubble glyph: emoji/short string, or a bundled Iconify key
  // (picked via the IconPicker grid; custom keys still possible via search).
  const [icon, setIcon] = useState(seed?.icon ?? "");
  // A value with a colon is treated as an Iconify key; unknown keys warn and
  // the rail falls back to the name monogram.
  const iconUnknown = icon.trim().includes(":") && !BRAND_ICONS[icon.trim()];

  // S3-only state.
  const [bucket, setBucket] = useState(seed?.bucket ?? "");
  const [region, setRegion] = useState(seed?.region ?? "us-east-1");
  const [endpoint, setEndpoint] = useState(seed?.endpoint ?? "");
  const [s3Provider, setS3Provider] = useState<S3Provider>(
    seed?.protocol === "s3" ? guessProvider(seed.endpoint) : "aws"
  );
  // Azure-only state.
  const [azureAccount, setAzureAccount] = useState(seed?.account ?? "");

  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(panelRef, { onClose });

  const onProtocolChange = (p: Protocol) => {
    setProtocol(p);
    if (!portTouched) {
      setPort(PROTOCOL_DEFAULT_PORT[p]);
    }
    if (isObjectProtocol(p)) {
      // Object stores authenticate by key material, not interactive login. S3 /
      // Azure carry it in the password field; GCS uses a service-account JSON,
      // which defaults to a key *file* path (Password mode pastes the JSON).
      setAuthKind(p === "gcs" ? "key" : "password");
    }
    if ((p === "ftp" || p === "ftps") && authKind !== "password") {
      setAuthKind("password");
    }
  };

  const onS3ProviderChange = (p: S3Provider) => {
    setS3Provider(p);
    const preset = S3_PROVIDER_PRESETS[p];
    setRegion(preset.defaultRegion);
    if (p === "aws") {
      setEndpoint("");
    }
  };

  const isFtp = protocol === "ftp" || protocol === "ftps";
  const isS3 = protocol === "s3";
  const isAzure = protocol === "azure";
  const isGcs = protocol === "gcs";
  const isWebdav = protocol === "webdav";
  const isHttp = protocol === "http";
  const isDropbox = protocol === "dropbox";
  const isOnedrive = protocol === "onedrive";
  const isGdrive = protocol === "gdrive";
  const isBox = protocol === "box";
  const isShopify = protocol === "shopify";
  const isHubSpot = protocol === "hubspot";
  const isDynamics = protocol === "dynamics";
  const isWordPress = protocol === "wordpress";
  const isCloudOAuth = isDropbox || isOnedrive || isGdrive || isBox;
  const isObject = isObjectProtocol(protocol);
  const isAgent = isAgentProtocol(protocol);

  // OAuth clouds (Dropbox/OneDrive/…): authorization state. Editing an
  // already-authorized profile (its account label is persisted) starts authorized.
  const [cloudAuthed, setCloudAuthed] = useState<boolean>(
    (seed?.protocol === "dropbox" ||
      seed?.protocol === "onedrive" ||
      seed?.protocol === "gdrive" ||
      seed?.protocol === "box") &&
      !!seed?.account
  );
  const [cloudAccount, setCloudAccount] = useState<string>(seed?.account ?? "");
  // A cloud drive with no app built into this release needs the user's own
  // registered app. Its secret (Google, Box) goes to the keychain on success.
  const [oauthClientId, setOauthClientId] = useState(seed?.oauthClientId ?? "");
  const [oauthSecret, setOauthSecret] = useState("");
  const [oauthSecretSaved, setOauthSecretSaved] = useState(false);
  const [builtinApps, setBuiltinApps] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let cancelled = false;
    ipc
      .oauthBuiltinApps()
      .then((apps) => {
        if (!cancelled) setBuiltinApps(apps);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (isCloudOAuth) {
      ipc
        .apiKeyStatus(`oauth-app-secret:${id}`)
        .then(setOauthSecretSaved)
        .catch(() => {});
    }
  }, [isCloudOAuth, id, cloudAuthed]);

  // Shopify: the Admin credential lives in the OS keychain
  // (`shopify:{profile_id}`) — never in profiles.json. The editor only ever
  // sets it (one-way) and asks whether one already exists.
  const [shopifyMode, setShopifyMode] = useState<"token" | "client">("token");
  const [shopifyToken, setShopifyToken] = useState("");
  const [shopifyClientId, setShopifyClientId] = useState("");
  const [shopifyClientSecret, setShopifyClientSecret] = useState("");
  const [shopifySecretSaved, setShopifySecretSaved] = useState(false);
  useEffect(() => {
    if (protocol === "shopify") {
      ipc
        .apiKeyStatus(`shopify:${id}`)
        .then(setShopifySecretSaved)
        .catch(() => {});
    }
  }, [protocol, id]);

  /// The Shopify credential as stored in the keychain: the bare access token,
  /// or `client_id:client_secret` for a Dev Dashboard app.
  const shopifySecretEntered =
    !!shopifyToken.trim() ||
    !!shopifyClientId.trim() ||
    !!shopifyClientSecret.trim();
  const shopifySecret =
    shopifyMode === "token"
      ? shopifyToken.trim()
      : `${shopifyClientId.trim()}:${shopifyClientSecret.trim()}`;
  const shopifyDomainOk = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(
    normalizeShopDomain(host)
  );
  const shopifySecretOk =
    shopifySecretSaved ||
    (shopifyMode === "token"
      ? !!shopifyToken.trim()
      : !!shopifyClientId.trim() && !!shopifyClientSecret.trim());

  // HubSpot: the private-app access token (`pat-…`) lives in the OS keychain
  // (`hubspot:{profile_id}`) — never in profiles.json. The editor only ever
  // sets it (one-way) and asks whether one already exists.
  const [hubspotToken, setHubspotToken] = useState("");
  const [hubspotSecretSaved, setHubspotSecretSaved] = useState(false);
  useEffect(() => {
    if (protocol === "hubspot") {
      ipc
        .apiKeyStatus(`hubspot:${id}`)
        .then(setHubspotSecretSaved)
        .catch(() => {});
    }
  }, [protocol, id]);

  const hubspotSecretOk = hubspotSecretSaved || !!hubspotToken.trim();
  /// HubSpot private-app tokens start with `pat-`; anything else is almost
  /// certainly the wrong credential pasted in — warn, don't block.
  const hubspotPatWarn =
    !!hubspotToken.trim() && !hubspotToken.trim().startsWith("pat-");

  // Dynamics 365: two auth modes. Client credentials: the app-registration
  // credential lives in the OS keychain (`dynamics:{profile_id}`,
  // `tenant_id:client_id:client_secret`) — never in profiles.json; the editor
  // only ever sets it (one-way) and asks whether one already exists. Delegated
  // ("Sign in with Microsoft"): the OAuth TokenSet lives in the keychain under
  // the `faro-dynamics` service (set by `dynamics_authorize`); the authorized
  // account label is persisted on the profile, like the OAuth clouds. The
  // backend prefers the client-credentials blob when both exist, so saving in
  // delegated mode clears the blob.
  const [dynamicsMode, setDynamicsMode] = useState<"client" | "delegated">(
    seed?.protocol === "dynamics" && !!seed?.account ? "delegated" : "client"
  );
  const [dynamicsTenantId, setDynamicsTenantId] = useState("");
  const [dynamicsClientId, setDynamicsClientId] = useState("");
  const [dynamicsClientSecret, setDynamicsClientSecret] = useState("");
  const [dynamicsSecretSaved, setDynamicsSecretSaved] = useState(false);
  const [dynamicsAuthed, setDynamicsAuthed] = useState<boolean>(
    seed?.protocol === "dynamics" && !!seed?.account
  );
  const [dynamicsAccount, setDynamicsAccount] = useState<string>(
    seed?.protocol === "dynamics" ? (seed?.account ?? "") : ""
  );
  useEffect(() => {
    if (protocol === "dynamics") {
      ipc
        .apiKeyStatus(`dynamics:${id}`)
        .then(setDynamicsSecretSaved)
        .catch(() => {});
    }
  }, [protocol, id]);

  /// The Dynamics credential as stored in the keychain:
  /// `tenant_id:client_id:client_secret` (the Shopify client-mode shape).
  const dynamicsSecretEntered =
    !!dynamicsTenantId.trim() ||
    !!dynamicsClientId.trim() ||
    !!dynamicsClientSecret.trim();
  const dynamicsSecret = `${dynamicsTenantId.trim()}:${dynamicsClientId.trim()}:${dynamicsClientSecret.trim()}`;
  const dynamicsUrlOk = /^[a-z0-9][a-z0-9-]*\.crm\d*\.dynamics\.com$/.test(
    normalizeDynamicsUrl(host)
  );
  const dynamicsCredOk =
    dynamicsMode === "client"
      ? dynamicsSecretSaved ||
        (!!dynamicsTenantId.trim() &&
          !!dynamicsClientId.trim() &&
          !!dynamicsClientSecret.trim())
      : dynamicsAuthed;

  // WordPress: the Application Password lives in the OS keychain
  // (`wordpress:{profile_id}`) — never in profiles.json. The editor only ever
  // sets it (one-way) and asks whether one already exists.
  const [wpPassword, setWpPassword] = useState("");
  const [wpSecretSaved, setWpSecretSaved] = useState(false);
  useEffect(() => {
    if (protocol === "wordpress") {
      ipc
        .apiKeyStatus(`wordpress:${id}`)
        .then(setWpSecretSaved)
        .catch(() => {});
    }
  }, [protocol, id]);
  const wpSiteOk =
    /^(https?:\/\/)?[^\s/.]+(\.[^\s/.]+)+(\/\S*)?$/i.test(endpoint.trim()) ||
    /^(https?:\/\/)?localhost(:\d+)?(\/\S*)?$/i.test(endpoint.trim());
  const wpSecretOk = wpSecretSaved || !!wpPassword.trim();

  /// Build the profile from the current form state. Shared by Save and by the
  /// pairing flow (which must persist the profile before it can pair by id).
  const buildProfile = (): ConnectionProfile => {
    let auth: AuthMethod;
    if (profile?.auth.kind === "keyref") {
      // Grant-managed key: lives in the OS keychain, never edited here.
      auth = profile.auth;
    } else if (authKind === "password") {
      auth = { kind: "password", password };
    } else if (authKind === "key") {
      auth = {
        kind: "key",
        path: keyPath,
        passphrase: passphrase || undefined,
        certPath: certPath.trim() || undefined,
      };
    } else if (authKind === "cloudflarecert") {
      auth = { kind: "cloudflarecert" };
    } else {
      auth = { kind: "agent" };
    }
    return {
      id,
      name:
        name ||
        (isS3
          ? `${bucket}@${s3Provider}`
          : isAzure
            ? `${azureAccount}/${bucket}`
            : isGcs
              ? `${bucket}@gcs`
              : isWebdav || isHttp
                ? `${username ? `${username}@` : ""}${hostFromUrl(endpoint)}`
                : isCloudOAuth
                  ? cloudAccount || PROTOCOL_LABEL[protocol]
                  : isShopify
                    ? normalizeShopDomain(host) || "Shopify"
                    : isHubSpot
                      ? "HubSpot"
                      : isDynamics
                        ? normalizeDynamicsUrl(host) || "Dynamics 365"
                        : isWordPress
                        ? hostFromUrl(endpoint) || "WordPress"
                        : isAgent
                        ? `Agent @ ${host}`
                        : `${username}@${host}`),
      protocol,
      host: isObject
        ? endpoint ||
          (isAzure
            ? "blob.core.windows.net"
            : isGcs
              ? "storage.googleapis.com"
              : "s3.amazonaws.com")
        : isWebdav || isHttp
          ? hostFromUrl(endpoint)
          : isCloudOAuth
            ? `${protocol}.com`
            : isHubSpot
              ? "api.hubapi.com"
              : isShopify
                ? normalizeShopDomain(host)
                : isDynamics
                  ? normalizeDynamicsUrl(host)
                  : isWordPress
                    ? hostFromUrl(endpoint)
                    : sshHost,
      port: isWordPress ? portFromUrl(endpoint) : port,
      username: isAzure
        ? azureAccount
        : isAgent || isGcs || isCloudOAuth || isShopify || isHubSpot || isDynamics
          ? ""
          : username,
      auth:
        isAgent || isCloudOAuth || isShopify || isHubSpot || isDynamics || isWordPress
          ? { kind: "password", password: "" }
          : auth,
      defaultRemotePath: defaultRemotePath || undefined,
      defaultLocalPath: defaultLocalPath.trim() || undefined,
      color: seed?.color,
      autoConnect: autoConnect || undefined,
      bucket: isObject ? bucket : undefined,
      region: isS3 ? region : undefined,
      // WordPress keeps the full site URL (scheme + subdirectory) here.
      endpoint:
        isObject || isWebdav || isHttp
          ? endpoint || undefined
          : isWordPress
            ? endpoint.trim().replace(/\/+$/, "") || undefined
            : undefined,
      account: isAzure
        ? azureAccount
        : isCloudOAuth
          ? cloudAccount || undefined
          : isDynamics && dynamicsMode === "delegated"
            ? dynamicsAccount || undefined
            : undefined,
      agentKey: isAgent ? agentKey : undefined,
      group: group.trim() || undefined,
      icon: icon.trim() || undefined,
      sortOrder: profile?.sortOrder,
      // Bastion hop (grant-imported only): carried through untouched.
      jumpHost: profile?.jumpHost,
      jumpPort: profile?.jumpPort,
      jumpUsername: profile?.jumpUsername,
      ftpEncoding: isFtp ? ftpEncoding || undefined : undefined,
      ftpActiveMode: isFtp && ftpActiveMode ? true : undefined,
      ftpMaxConnections: isFtp && ftpMaxConnections !== 2 ? ftpMaxConnections : undefined,
      ftpSegments: isFtp && ftpSegments !== 1 ? ftpSegments : undefined,
      // A jump host brings its own proxy settings.
      proxy: protocol === "sftp" && (jumpProfile || reach === "cloudflare") ? undefined : buildProxy(),
      proxyCommand: buildProxyCommand(),
      jumpProfile: protocol === "sftp" && jumpProfile ? jumpProfile : undefined,
      oauthClientId: isCloudOAuth ? oauthClientId.trim() || undefined : undefined,
    };
  };

  function buildProxyCommand(): ProxyCommandConfig | undefined {
    // SSH only, and a jump host brings its own way in.
    if (protocol !== "sftp" || jumpProfile) return undefined;
    if (proxyCmd.kind === "command") {
      const command = proxyCmd.command.trim();
      return command ? { kind: "command", command } : undefined;
    }
    if (proxyCmd.kind === "cloudflare") {
      const tokenId = proxyCmd.serviceTokenId.trim();
      const server = proxyCmd.hostname.trim();
      return {
        kind: "cloudflare",
        // Absent = the connection's host, which is the usual case.
        hostname: server && server !== sshHost ? server : undefined,
        serviceTokenId: tokenId || undefined,
        serviceTokenSecret: tokenId && proxyCmd.serviceTokenSecret ? proxyCmd.serviceTokenSecret : undefined,
      };
    }
    return undefined;
  }

  function buildProxy(): ProxyConfig | undefined {
    if (!proxyKind || !proxyHost.trim()) return undefined;
    const user = proxyUser.trim();
    return {
      kind: proxyKind,
      host: proxyHost.trim(),
      port: proxyPort,
      username: user || undefined,
      password: user && proxyPass ? proxyPass : undefined,
    };
  }

  /// Write keychain-held credentials (Shopify/HubSpot/Dynamics/WordPress)
  /// for this profile id. Shared by Save and Test connection, which needs
  /// them in place before it can connect.
  const persistSecrets = async () => {
    // Shopify: persist the credential to the OS keychain first (one-way set —
    // it never lands in profiles.json). Blank fields keep the saved one.
    if (isShopify && shopifySecretEntered) {
      await ipc.setApiKey(`shopify:${id}`, shopifySecret);
    }
    // WordPress: same one-way keychain set for the Application Password.
    // WordPress shows it in groups of four; spaces are part of the display only.
    if (isWordPress && wpPassword.trim()) {
      await ipc.setApiKey(`wordpress:${id}`, wpPassword.replace(/\s+/g, ""));
    }
    // HubSpot: same one-way keychain set for the private-app token.
    if (isHubSpot && hubspotToken.trim()) {
      await ipc.setApiKey(`hubspot:${id}`, hubspotToken.trim());
    }
    // Dynamics: same one-way keychain set for the app-registration credential.
    // In delegated mode the blob is cleared instead — the backend prefers it
    // over the OAuth tokens when both exist.
    if (isDynamics && dynamicsMode === "client" && dynamicsSecretEntered) {
      await ipc.setApiKey(`dynamics:${id}`, dynamicsSecret);
    }
    if (isDynamics && dynamicsMode === "delegated") {
      await ipc.setApiKey(`dynamics:${id}`, "");
    }
  };

  // Test connection: connect with the form as it stands, then disconnect.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: true } | { ok: false; title: string; message: string } | null
  >(null);
  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await persistSecrets();
      await ipc.testConnection(buildProfile());
      setTestResult({ ok: true });
    } catch (e) {
      setTestResult({ ok: false, title: "Couldn't connect", message: messageOf(e) });
    } finally {
      setTesting(false);
    }
  };

  // Connect right after saving — on by default; the choice is remembered.
  const [connectAfterSave, setConnectAfterSave] = useState(() => {
    try {
      return localStorage.getItem(CONNECT_AFTER_SAVE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggleConnectAfterSave = (on: boolean) => {
    setConnectAfterSave(on);
    try {
      localStorage.setItem(CONNECT_AFTER_SAVE_KEY, on ? "1" : "0");
    } catch {
      // per-viewer convenience only
    }
  };
  const sessions = useConnections((s) => s.sessions);

  const save = async () => {
    await persistSecrets();
    await saveProfile(buildProfile());
    onClose();
    // Skip when it's already open; connect errors toast from the store.
    if (connectAfterSave && !sessions.some((s) => s.profileId === id)) {
      void connectProfile(id).catch(() => {});
    }
  };

  /// Pair with the daemon at host:port using a 6-digit code. Nothing is
  /// persisted until the daemon acknowledges, so a failed attempt leaves no
  /// half-configured connection behind. On success the profile is saved right
  /// away (pairing IS the consent step — demanding another Save was a dead
  /// end), the editor closes, and the connection opens.
  const pair = async (code: string): Promise<void> => {
    const res = await ipc.pairAgent(host.trim(), port, code, buildProxy());
    // buildProfile() reads state that React hasn't committed yet — pass the
    // fresh values through explicitly.
    const finalName = name || res.hostname || `Agent @ ${host}`;
    setAgentKey(res.serverKey);
    if (!name) setName(finalName);
    // Android's process directory is not shared storage. Start new/default
    // connections where the companion's storage permission applies.
    const initialPath = res.os === "android" && (!defaultRemotePath.trim() || defaultRemotePath === ".")
      ? "/sdcard"
      : defaultRemotePath;
    await saveProfile({
      ...buildProfile(),
      name: finalName,
      agentKey: res.serverKey,
      defaultRemotePath: initialPath || undefined,
      defaultLocalPath: defaultLocalPath.trim() || undefined,
    });
    toast.success(
      `Paired with ${res.hostname || host}`,
      `${res.os} · ${res.fingerprint}`
    );
    onClose();
    void connectProfile(id);
  };

  const gcsCredOk = authKind === "key" ? !!keyPath : !!password;
  // Cloudflare certificates need the Access route, and a person to sign in:
  // a service token has no email to issue a certificate for.
  const changeReach = (r: Reach) => {
    setReach(r);
    if (r === "cloudflare") {
      setJumpProfile("");
      setProxyKind("");
      setProxyCmd({ ...proxyCmd, kind: "cloudflare", hostname: proxyCmd.hostname || host.trim() });
      // Cloudflare identity is the login to have here; keep a chosen one.
      if (authKind === "password" && !password) setAuthKind("cloudflarecert");
    } else {
      if (r === "direct") setJumpProfile("");
      // The Cloudflare login only exists through Cloudflare.
      if (authKind === "cloudflarecert") setAuthKind("password");
      if (proxyCmd.kind === "cloudflare") setProxyCmd({ ...proxyCmd, kind: "" });
    }
  };
  const cfRoute = protocol === "sftp" && reach === "cloudflare" && proxyCmd.kind === "cloudflare";
  const jumpMissing = protocol === "sftp" && reach === "jump" && !jumpProfile;
  const cfServiceToken = cfRoute && !!proxyCmd.serviceTokenId.trim();
  const cfCertBlocked =
    protocol === "sftp" && authKind === "cloudflarecert" && (!cfRoute || cfServiceToken);
  const canSave = isS3
    ? !!bucket && !!username && !!password
    : isAzure
      ? !!azureAccount && !!bucket && !!password
      : isGcs
        ? !!bucket && gcsCredOk
        : isWebdav
          ? !!endpoint && !!password
          : isHttp
            ? !!endpoint
            : isShopify
              ? shopifyDomainOk && shopifySecretOk
              : isHubSpot
                ? hubspotSecretOk
                : isDynamics
                  ? dynamicsUrlOk && dynamicsCredOk
                  : isWordPress
                    ? wpSiteOk && !!username.trim() && wpSecretOk
                  : isCloudOAuth
                ? cloudAuthed
                : isAgent
                  ? !!host && !!agentKey
                  : !!sshHost && !!username && !cfCertBlocked && !jumpMissing;
  // Name what's still required so a disabled Save isn't a dead end.
  const missing = (
    isS3
      ? [!bucket && "bucket", !username && "access key ID", !password && "secret key"]
      : isAzure
        ? [!azureAccount && "account", !bucket && "container", !password && "access key"]
        : isGcs
          ? [
              !bucket && "bucket",
              !gcsCredOk && (authKind === "key" ? "key file path" : "JSON key"),
            ]
          : isWebdav
            ? [!endpoint && "server URL", !password && "password / token"]
            : isHttp
              ? [!endpoint && "URL"]
              : isShopify
                ? [
                    !shopifyDomainOk && "store domain",
                    !shopifySecretOk && "API credential",
                  ]
                : isHubSpot
                  ? [!hubspotSecretOk && "private-app token"]
                  : isDynamics
                    ? [
                        !dynamicsUrlOk && "environment URL",
                        !dynamicsCredOk &&
                          (dynamicsMode === "client"
                            ? "client credentials"
                            : "Microsoft sign-in"),
                      ]
                    : isWordPress
                      ? [
                          !wpSiteOk && "site address",
                          !username.trim() && "username",
                          !wpSecretOk && "application password",
                        ]
                    : isCloudOAuth
                ? [!cloudAuthed && `${PROTOCOL_LABEL[protocol]} authorization`]
                : isAgent
                  ? [!host && "host", !agentKey && "pairing"]
                  : [
                      !sshHost && (cfRoute ? "server" : "host"),
                      jumpMissing && "jump host",
                      !username && "username",
                      cfCertBlocked &&
                        (cfServiceToken
                          ? "a login other than Cloudflare certificate (service token)"
                          : "Through Cloudflare (above)"),
                    ]
  ).filter(Boolean);

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="anim-modal flex max-h-[88vh] w-[52rem] max-w-[94vw] overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3"
      >
        {/* Left rail — grouped protocol picker. Scrolls as the list grows so the
            dialog stays wide-and-short instead of tall-and-narrow. */}
        <nav className="flex w-52 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-bg-subtle/50 p-2">
          <div
            id={titleId}
            className="px-2 pb-0.5 pt-1 text-[15px] font-semibold tracking-tight"
          >
            {profile ? "Edit connection" : "New connection"}
          </div>
          {PROTOCOL_GROUPS.map((grp) => (
            <div key={grp.label}>
              <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-dim">
                {grp.label}
              </div>
              <div className="flex flex-col gap-0.5">
                {grp.items.map((p) => (
                  <ProtocolButton
                    key={p}
                    active={protocol === p}
                    onClick={() => onProtocolChange(p)}
                    protocol={p}
                    label={PROTOCOL_LABEL[p]}
                    note={builtinApps[p] === false ? "Own app" : undefined}
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Right pane — the form for the selected protocol. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3">
            <span className="text-sm font-semibold">{PROTOCOL_LABEL[protocol]}</span>
            <span className="text-[11px] text-text-dim">{protocolHint(protocol)}</span>
            <div className="flex-1" />
            <button
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text"
            >
              <X size={14} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="flex gap-2">
          <Field label="Name" className="flex-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isS3 ? "my-bucket" : "my-prod-box"}
              className={inputCls}
            />
          </Field>
          <Field group label="Icon (optional)" className="w-40">
            <IconPicker
              value={icon}
              onChange={setIcon}
              fallback={monogram(name || "?")}
            />
          </Field>
          <Field label="Group (optional)" className="w-40">
            <input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="e.g. Production"
              list="profile-editor-groups"
              className={inputCls}
            />
            <datalist id="profile-editor-groups">
              {knownGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
        </div>

        {iconUnknown && (
          <Hint tone="warn">
            Unknown icon key — the bubble falls back to the name monogram.
            Bundled keys look like <code>mdi:rocket-launch</code>.
          </Hint>
        )}

        {isS3 ? (
          <S3Section
            provider={s3Provider}
            onProviderChange={onS3ProviderChange}
            bucket={bucket}
            setBucket={setBucket}
            region={region}
            setRegion={setRegion}
            endpoint={endpoint}
            setEndpoint={setEndpoint}
            accessKey={username}
            setAccessKey={setUsername}
            secretKey={password}
            setSecretKey={setPassword}
          />
        ) : isAzure ? (
          <AzureSection
            account={azureAccount}
            setAccount={setAzureAccount}
            container={bucket}
            setContainer={setBucket}
            accessKey={password}
            setAccessKey={setPassword}
            endpoint={endpoint}
            setEndpoint={setEndpoint}
          />
        ) : isGcs ? (
          <GcsSection
            bucket={bucket}
            setBucket={setBucket}
            keyMode={authKind === "key" ? "file" : "paste"}
            setKeyMode={(m) => setAuthKind(m === "file" ? "key" : "password")}
            keyPath={keyPath}
            setKeyPath={setKeyPath}
            keyJson={password}
            setKeyJson={setPassword}
          />
        ) : isWebdav ? (
          <WebdavSection
            url={endpoint}
            setUrl={setEndpoint}
            username={username}
            setUsername={setUsername}
            password={password}
            setPassword={setPassword}
          />
        ) : isHttp ? (
          <HttpSection
            url={endpoint}
            setUrl={setEndpoint}
            username={username}
            setUsername={setUsername}
            password={password}
            setPassword={setPassword}
          />
        ) : isShopify ? (
          <ShopifySection
            domain={host}
            setDomain={setHost}
            mode={shopifyMode}
            setMode={setShopifyMode}
            token={shopifyToken}
            setToken={setShopifyToken}
            clientId={shopifyClientId}
            setClientId={setShopifyClientId}
            clientSecret={shopifyClientSecret}
            setClientSecret={setShopifyClientSecret}
            secretSaved={shopifySecretSaved}
          />
        ) : isHubSpot ? (
          <HubSpotSection
            token={hubspotToken}
            setToken={setHubspotToken}
            secretSaved={hubspotSecretSaved}
            patWarn={hubspotPatWarn}
          />
        ) : isDynamics ? (
          <DynamicsSection
            url={host}
            setUrl={setHost}
            urlOk={dynamicsUrlOk}
            mode={dynamicsMode}
            setMode={setDynamicsMode}
            tenantId={dynamicsTenantId}
            setTenantId={setDynamicsTenantId}
            clientId={dynamicsClientId}
            setClientId={setDynamicsClientId}
            clientSecret={dynamicsClientSecret}
            setClientSecret={setDynamicsClientSecret}
            secretSaved={dynamicsSecretSaved}
            authorize={(pid) =>
              ipc.dynamicsAuthorize(pid, normalizeDynamicsUrl(host))
            }
            profileId={id}
            authed={dynamicsAuthed}
            account={dynamicsAccount}
            onAuthorized={(label) => {
              setDynamicsAuthed(true);
              setDynamicsAccount(label);
              if (!name) setName(label || normalizeDynamicsUrl(host));
            }}
            onReset={() => {
              setDynamicsAuthed(false);
              setDynamicsAccount("");
            }}
          />
        ) : isWordPress ? (
          <WordPressSection
            site={endpoint}
            setSite={setEndpoint}
            siteOk={wpSiteOk}
            username={username}
            setUsername={setUsername}
            password={wpPassword}
            setPassword={setWpPassword}
            secretSaved={wpSecretSaved}
          />
        ) : isCloudOAuth ? (
          <OAuthConnectSection
            label={PROTOCOL_LABEL[protocol]}
            authorize={
              isDropbox
                ? ipc.dropboxAuthorize
                : isOnedrive
                  ? ipc.onedriveAuthorize
                  : isGdrive
                    ? ipc.gdriveAuthorize
                    : ipc.boxAuthorize
            }
            profileId={id}
            authed={cloudAuthed}
            account={cloudAccount}
            onAuthorized={(label) => {
              setCloudAuthed(true);
              setCloudAccount(label);
              setOauthSecret("");
              if (!name) setName(label || PROTOCOL_LABEL[protocol]);
            }}
            onReset={() => {
              setCloudAuthed(false);
              setCloudAccount("");
            }}
            setup={OAUTH_APP_SETUP[protocol]}
            builtin={builtinApps[protocol]}
            clientId={oauthClientId}
            setClientId={setOauthClientId}
            clientSecret={oauthSecret}
            setClientSecret={setOauthSecret}
            secretSaved={oauthSecretSaved}
          />
        ) : isAgent ? (
          <AgentSection
            profileId={id}
            host={host}
            setHost={setHost}
            port={port}
            setPort={setPort}
            setPortTouched={setPortTouched}
            paired={!!agentKey}
            onPair={pair}
            onUnpair={() => setAgentKey(undefined)}
          />
        ) : (
          <>
            {protocol === "sftp" && (
              <ReachPicker
                value={reach}
                onChange={changeReach}
              />
            )}
            {protocol === "sftp" && reach === "jump" && (
              <JumpHostField
                profileId={id}
                profiles={profiles}
                jumpProfile={jumpProfile}
                setJumpProfile={setJumpProfile}
              />
            )}
            {cfRoute ? (
              <CloudflareServerFields
                server={proxyCmd.hostname}
                setServer={setCfServer}
                host={host}
                setHost={setHost}
                port={port}
                setPort={(p) => {
                  setPort(p);
                  setPortTouched(true);
                }}
                certLogin={authKind === "cloudflarecert"}
                serviceTokenId={proxyCmd.serviceTokenId}
                onRemoveToken={() => setProxyCmd({ ...proxyCmd, serviceTokenId: "", serviceTokenSecret: "" })}
              />
            ) : (
            <div className="flex gap-2">
              <Field label={reach === "jump" && protocol === "sftp" ? "Host (as the jump host sees it)" : "Host"} className="flex-1">
                <input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="example.com"
                  className={inputCls}
                />
              </Field>
              <Field label="Port" className="w-24">
                <input
                  type="number"
                  value={port}
                  onChange={(e) => {
                    setPort(
                      parseInt(e.target.value) || PROTOCOL_DEFAULT_PORT[protocol]
                    );
                    setPortTouched(true);
                  }}
                  className={inputCls}
                />
              </Field>
            </div>
            )}

            <Field label={cfRoute ? "Log in as" : "Username"}>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={isFtp ? "anonymous" : "root"}
                className={inputCls}
              />
            </Field>

            {profile?.jumpHost && (
              <Hint>
                via bastion{" "}
                <span className="font-mono text-text-dim">
                  {profile.jumpUsername ? `${profile.jumpUsername}@` : ""}
                  {profile.jumpHost}:{profile.jumpPort ?? 22}
                </span>
              </Hint>
            )}

            {profile?.auth.kind === "keyref" ? (
              <Hint>
                Managed key (access grant) — stored in your OS keychain.
              </Hint>
            ) : (
              <>
            <Field label="Auth">
              <select
                value={authKind}
                onChange={(e) => setAuthKind(e.target.value as AuthMethod["kind"])}
                className={inputCls}
              >
                <option value="password">Password</option>
                <option value="key" disabled={isFtp}>
                  Private key file{isFtp ? " — SFTP only" : ""}
                </option>
                <option value="agent" disabled={isFtp}>
                  SSH agent{isFtp ? " — SFTP only" : ""}
                </option>
                {/* Only through Cloudflare (or a saved one that lost its route,
                    so the select still shows what it has). */}
                {!isFtp && (cfRoute || authKind === "cloudflarecert") && (
                  <option
                    value="cloudflarecert"
                    disabled={cfServiceToken && authKind !== "cloudflarecert"}
                  >
                    Cloudflare identity (short-lived certificate)
                    {cfServiceToken ? " — not with a service token" : ""}
                  </option>
                )}
              </select>
            </Field>

            {authKind === "cloudflarecert" && (
              <CloudflareCertHint
                hostname={proxyCmd.hostname.trim() || host.trim()}
                username={username.trim()}
                routed={cfRoute}
                serviceToken={cfServiceToken}
              />
            )}

            {authKind === "agent" && (
              <Hint>
                Uses the running SSH agent for authentication.{" "}
                <span className="font-mono text-text-dim">
                  {/* eslint-disable-next-line no-undef */}
                  {navigator.platform.startsWith("Win")
                    ? "\\\\.\\pipe\\openssh-ssh-agent (OpenSSH Authentication Agent service)"
                    : "$SSH_AUTH_SOCK"}
                </span>
                . Run <span className="font-mono">ssh-add</span> first to load
                your keys.
              </Hint>
            )}

            {authKind === "password" && (
              <Field label="Password">
                <PasswordInput value={password} onChange={setPassword} />
              </Field>
            )}

            {authKind === "key" && (
              <KeyAuthSection
                keyPath={keyPath}
                setKeyPath={setKeyPath}
                passphrase={passphrase}
                setPassphrase={setPassphrase}
                certPath={certPath}
                setCertPath={setCertPath}
                username={username}
                host={host}
              />
            )}
              </>
            )}
          </>
        )}

        <Field label={isObject ? "Default key prefix" : "Default remote path"}>
          <input
            value={defaultRemotePath}
            onChange={(e) => setDefaultRemotePath(e.target.value)}
            placeholder={isObject ? "" : isFtp ? "/" : "."}
            className={inputCls}
          />
        </Field>

        <Field label="Default local folder (optional)">
          <div className="flex gap-2">
            <input aria-label="Default local folder" value={defaultLocalPath}
              onChange={(e) => setDefaultLocalPath(e.target.value)} className={inputCls + " min-w-0 flex-1"} />
            <button type="button" className="shrink-0 rounded-md border border-border px-3 text-sm hover:bg-bg-hover"
              onClick={async () => {
                try {
                  const folder = await open({ directory: true, multiple: false, defaultPath: defaultLocalPath || undefined });
                  if (typeof folder === "string") setDefaultLocalPath(folder);
                } catch (e) { toast.error("Couldn't choose folder", String(e)); }
              }}>Browse…</button>
          </div>
        </Field>

        {isFtp && (
          <div className="flex gap-3">
            <Field label="Character set" className="min-w-0 flex-1">
              <select
                value={ftpEncoding}
                onChange={(e) => setFtpEncoding(e.target.value)}
                className={inputCls}
              >
                {FTP_CHARSETS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
                {/* An imported/hand-edited label we don't list: keep it. */}
                {ftpEncoding &&
                  !FTP_CHARSETS.some(([v]) => v === ftpEncoding) && (
                    <option value={ftpEncoding}>{ftpEncoding}</option>
                  )}
              </select>
            </Field>
            <Field label="Transfer mode" className="w-40 shrink-0">
              <select
                value={ftpActiveMode ? "active" : "passive"}
                onChange={(e) => setFtpActiveMode(e.target.value === "active")}
                className={inputCls}
                title="Passive works through home routers and most firewalls. Use active only when the server's passive ports are blocked."
              >
                <option value="passive">Passive</option>
                <option value="active">Active</option>
              </select>
            </Field>
          </div>
        )}
        {isFtp && (
          <div className="flex gap-2">
            <Field label="Transfer connections" className="flex-1">
              <select
                value={ftpMaxConnections}
                onChange={(e) => setFtpMaxConnections(Number(e.target.value))}
                className={inputCls}
                title="Extra logins used for copying, so browsing never waits behind a transfer. Faro uses fewer if the server refuses more."
              >
                {[1, 2, 3, 4, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Connections per file" className="flex-1">
              <select
                value={ftpSegments}
                onChange={(e) => setFtpSegments(Number(e.target.value))}
                className={inputCls}
                title="Split one large download across several logins. Many servers limit logins per user; keep 1 unless yours allows more."
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        <NetworkSection
          profileId={id}
          protocol={protocol}
          profiles={profiles}
          proxyKind={proxyKind}
          setProxyKind={setProxyKind}
          proxyHost={proxyHost}
          setProxyHost={setProxyHost}
          proxyPort={proxyPort}
          setProxyPort={setProxyPort}
          proxyUser={proxyUser}
          setProxyUser={setProxyUser}
          proxyPass={proxyPass}
          setProxyPass={setProxyPass}
          proxyCmd={proxyCmd}
          setProxyCmd={setProxyCmd}
          reach={protocol === "sftp" ? reach : "direct"}
          ftpActiveMode={isFtp && ftpActiveMode}
        />

        <label className="mb-3 flex cursor-pointer items-center gap-2.5 rounded-md border border-border bg-bg-subtle px-2.5 py-2">
          <input
            type="checkbox"
            checked={autoConnect}
            onChange={(e) => setAutoConnect(e.target.checked)}
            className="h-3.5 w-3.5 shrink-0 accent-[rgb(var(--accent))]"
          />
          <span className="min-w-0">
            <span className="block text-xs font-medium text-text">
              Auto-connect on startup
            </span>
            <span className="block text-[11px] text-text-dim">
              Open this server automatically when Faro launches.
            </span>
          </span>
        </label>

        {isFtp && (
          <Hint tone="warn">
            <ShieldOff size={11} className="mr-1 inline-block align-text-bottom" />
            FTP has no integrated terminal and{" "}
            {protocol === "ftp"
              ? "transmits credentials in clear text"
              : "uses TLS for the control channel only"}
            . Prefer SFTP when the server supports it.
          </Hint>
        )}
          </div>

          {testResult && (
            <div
              role={testResult.ok ? "status" : "alert"}
              className={cn(
                "mx-5 mb-0 mt-2 flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs",
                testResult.ok
                  ? "border-success/30 bg-success/10"
                  : "border-danger/30 bg-danger/10"
              )}
            >
              {testResult.ok ? (
                <Check size={13} className="mt-0.5 shrink-0 text-success" />
              ) : (
                <X size={13} className="mt-0.5 shrink-0 text-danger" />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {testResult.ok ? "Connection works" : testResult.title}
                </div>
                {!testResult.ok && (
                  <div className="mt-0.5 max-h-32 select-text overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[11px] text-text-muted">
                    {testResult.message}
                  </div>
                )}
              </div>
              {!testResult.ok && (
                <CopyTextButton
                  text={`${testResult.title}\n${testResult.message}`}
                  label
                />
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            {!canSave ? (
              <span className="mr-auto text-[11px] text-text-dim">
                Needs {missing.join(", ")}
              </span>
            ) : (
              !(isAgent && !agentKey) && (
                <label className="mr-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-text-muted">
                  <input
                    type="checkbox"
                    checked={connectAfterSave}
                    onChange={(e) => toggleConnectAfterSave(e.target.checked)}
                    className="accent-[rgb(var(--accent))]"
                  />
                  Connect after saving
                </label>
              )
            )}
            {!(isAgent && !agentKey) && (
              <button
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3.5 py-1.5 text-sm hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                onClick={testConnection}
                disabled={!canSave || testing}
                title={canSave ? "Try connecting without saving" : `Fill in: ${missing.join(", ")}`}
              >
                {testing && <Loader2 size={13} className="animate-spin" />}
                {testing ? "Testing…" : "Test connection"}
              </button>
            )}
            <button
              className="rounded-md border border-border px-3.5 py-1.5 text-sm hover:bg-bg-hover"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="btn-accent rounded-md px-3.5 py-1.5 text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={save}
              disabled={!canSave}
              title={canSave ? undefined : `Fill in: ${missing.join(", ")}`}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/// "Cloudflare short-lived certificate" auth: who the certificate will be for.
/// cloudflared names the principal after the user part of the signed-in
/// email, and the server has to accept that principal for `username`.
function CloudflareCertHint({
  hostname,
  username,
  routed,
  serviceToken,
}: {
  hostname: string;
  username: string;
  routed: boolean;
  serviceToken: boolean;
}) {
  const [status, setStatus] = useState<AccessStatus | null>(null);
  useEffect(() => {
    if (!routed || serviceToken || !hostname) return;
    let cancelled = false;
    // Typing in the hostname field shouldn't run cloudflared per keystroke.
    const t = setTimeout(() => {
      ipc
        .cfAccessStatus(hostname)
        .then((s) => !cancelled && setStatus(s))
        .catch(() => !cancelled && setStatus(null));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [hostname, routed, serviceToken]);

  if (!routed) {
    return (
      <Hint tone="warn">
        Cloudflare issues these certificates through Access. Choose{" "}
        <span className="font-medium text-text">Through Cloudflare</span> above.
      </Hint>
    );
  }
  if (serviceToken) {
    return (
      <Hint tone="warn">
        A service token has no person to issue a certificate for. Connections
        that faro-cli or the Agent Bridge use unattended should log in with a
        key or password and keep the service token.
      </Hint>
    );
  }
  if (status?.state === "notProtected") {
    return (
      <Hint tone="warn">
        {hostname} has no Access application, so Cloudflare can't issue a
        certificate for it.
      </Hint>
    );
  }
  const principal =
    status?.state === "loggedIn" && status.identity?.includes("@")
      ? status.identity.split("@")[0]
      : null;
  return (
    <Hint>
      Logs in with your Cloudflare identity: no key to choose or store. Each
      connect gets a certificate valid for a few minutes, and removing you from
      the Access policy removes your access.
      {principal ? (
        <span className="mt-1 block" data-testid="cf-cert-principal">
          Certificate for <span className="font-mono text-text">{principal}</span>{" "}
          ({status?.identity}).
          {username && username !== principal && (
            <>
              {" "}
              To log in as <span className="font-mono text-text">{username}</span>, the
              server must accept <span className="font-mono text-text">{principal}</span>{" "}
              for that user (its AuthorizedPrincipalsFile).
            </>
          )}
        </span>
      ) : (
        <span className="mt-1 block">
          Sign in above to see which user the certificate is for.
        </span>
      )}
    </Hint>
  );
}

/// SFTP private-key auth: the key path + passphrase, plus the "no more PuTTYgen"
/// helpers — generate a fresh keypair in place, or copy the public half of an
/// existing key to install on the server. Generating writes the private key (and
/// a `.pub` beside it), points this connection at it, and surfaces the public-key
/// line ready to paste into the server's `~/.ssh/authorized_keys`.
function KeyAuthSection({
  keyPath,
  setKeyPath,
  passphrase,
  setPassphrase,
  certPath,
  setCertPath,
  username,
  host,
}: {
  keyPath: string;
  setKeyPath: (v: string) => void;
  passphrase: string;
  setPassphrase: (v: string) => void;
  certPath: string;
  setCertPath: (v: string) => void;
  username: string;
  host: string;
}) {
  const [showGen, setShowGen] = useState(false);
  // The last generated/derived public key, shown in a copyable box. `justSaved`
  // distinguishes a key we just wrote (show the saved path) from one derived
  // from an existing private key (copy-only).
  const [pubKey, setPubKey] = useState<GeneratedKey | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [derivingBusy, setDerivingBusy] = useState(false);

  // Generator form state.
  const [genType, setGenType] = useState<SshKeyType>("ed25519");
  const [genPass, setGenPass] = useState("");
  const [genPath, setGenPath] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [overwrite, setOverwrite] = useState(false);

  // Public-key comment: mirrors ssh-keygen's `user@host` default.
  const comment = `${username || "faro"}@${host || "faro"}`;

  const toggleGenerator = useCallback(async () => {
    setShowGen((s) => !s);
    if (!genPath) {
      try {
        setGenPath((await ipc.sshKeyDefaults()).suggestedPath);
      } catch {
        // Non-fatal — the user can type a path.
      }
    }
  }, [genPath]);

  const browsePrivateKey = async () => {
    const picked = await open({
      title: "Select a private key file",
      multiple: false,
      directory: false,
    });
    if (typeof picked === "string") setKeyPath(picked);
  };

  const browseCertificate = async () => {
    const picked = await open({
      title: "Select the key's SSH certificate",
      multiple: false,
      directory: false,
    });
    if (typeof picked === "string") setCertPath(picked);
  };

  const browseSaveLocation = async () => {
    const picked = await save({
      title: "Save new private key as",
      defaultPath: genPath || undefined,
    });
    if (picked) setGenPath(picked);
  };

  const copyLine = async (line: string) => {
    try {
      await navigator.clipboard.writeText(line);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
      return true;
    } catch {
      return false;
    }
  };

  const doGenerate = async () => {
    if (!genPath.trim()) return;
    setGenBusy(true);
    try {
      const res = await ipc.generateSshKey({
        keyType: genType,
        bits: genType === "rsa" ? 4096 : undefined,
        passphrase: genPass || undefined,
        path: genPath.trim(),
        comment,
        overwrite,
      });
      // Point the connection at the fresh key and carry its passphrase across.
      setKeyPath(res.path);
      setPassphrase(genPass);
      setPubKey(res);
      setJustSaved(true);
      setShowGen(false);
      setOverwrite(false);
      const copiedOk = await copyLine(res.publicKey);
      toast.success(
        copiedOk ? "Key created & public key copied" : "Key created",
        `Saved to ${res.path}`
      );
    } catch (e) {
      const msg = String(e);
      if (/already exists/i.test(msg) && !overwrite) {
        // Offer the overwrite escape hatch instead of a dead end.
        setOverwrite(true);
        toast.error(
          "A key already exists there",
          "Enable overwrite to replace it, or change the name."
        );
      } else {
        toast.error("Key generation failed", msg);
      }
    } finally {
      setGenBusy(false);
    }
  };

  const derivePublic = async () => {
    if (!keyPath.trim()) return;
    setDerivingBusy(true);
    try {
      const res = await ipc.sshPublicKeyFor(keyPath.trim(), passphrase || undefined);
      setPubKey(res);
      setJustSaved(false);
      const copiedOk = await copyLine(res.publicKey);
      if (copiedOk)
        toast.success("Public key copied", "Add it to the server's authorized_keys.");
    } catch (e) {
      const msg = String(e);
      toast.error(
        "Couldn't read the public key",
        /passphrase|decrypt|password|cipher/i.test(msg)
          ? "If the key is encrypted, enter its passphrase above first."
          : msg
      );
    } finally {
      setDerivingBusy(false);
    }
  };

  return (
    <>
      <Field label="Key path">
        <div className="flex gap-1.5">
          <input
            value={keyPath}
            onChange={(e) => setKeyPath(e.target.value)}
            placeholder="~/.ssh/id_ed25519"
            className={cn(inputCls, "flex-1")}
          />
          <button
            type="button"
            onClick={browsePrivateKey}
            title="Browse for an existing private key"
            aria-label="Browse for an existing private key"
            className="flex shrink-0 items-center rounded-md border border-border bg-bg-subtle px-2.5 text-text-muted hover:bg-bg-hover hover:text-text"
          >
            <FolderOpen size={14} />
          </button>
        </div>
      </Field>

      <Field label="Passphrase (optional)">
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Unlocks an encrypted key"
          autoComplete="off"
          className={inputCls}
        />
      </Field>

      <Field label="Certificate (optional)">
        <div className="flex gap-1.5">
          <input
            value={certPath}
            onChange={(e) => setCertPath(e.target.value)}
            placeholder={keyPath.trim() ? `${keyPath.trim()}-cert.pub` : "~/.ssh/id_ed25519-cert.pub"}
            spellCheck={false}
            className={cn(inputCls, "flex-1")}
          />
          <button
            type="button"
            onClick={browseCertificate}
            title="Browse for the key's SSH certificate"
            aria-label="Browse for the key's SSH certificate"
            className="flex shrink-0 items-center rounded-md border border-border bg-bg-subtle px-2.5 text-text-muted hover:bg-bg-hover hover:text-text"
          >
            <FolderOpen size={14} />
          </button>
        </div>
      </Field>
      <Hint>
        For servers that trust an SSH certificate authority. Empty uses the
        key's <span className="font-mono">-cert.pub</span> when there is one.
        Faro offers the certificate first, then the key on its own.
      </Hint>

      {/* Make a new key, or copy the public half of an existing one. */}
      <div className="mb-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={toggleGenerator}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11.5px] font-medium transition-colors",
            showGen
              ? "border-accent/40 bg-accent-soft text-accent"
              : "border-border bg-bg-subtle text-text-muted hover:bg-bg-hover hover:text-text"
          )}
        >
          <Sparkles size={12} />
          Generate new key…
        </button>
        {keyPath.trim() && (
          <button
            type="button"
            onClick={derivePublic}
            disabled={derivingBusy}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-[11.5px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text disabled:opacity-50"
          >
            {derivingBusy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Copy size={12} />
            )}
            Copy public key
          </button>
        )}
      </div>

      {/* Generator panel */}
      {showGen && (
        <div className="mb-3 rounded-md border border-border bg-bg-subtle p-2.5">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text">
            <KeyRound size={13} className="text-accent" />
            Generate a new SSH key
          </div>

          <Field group label="Type">
            <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-bg-panel p-1">
              {(
                [
                  ["ed25519", "Ed25519", "Modern · recommended"],
                  ["rsa", "RSA 4096", "Maximum compatibility"],
                ] as const
              ).map(([val, label, sub]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setGenType(val)}
                  className={cn(
                    "flex flex-col items-start rounded-sm px-2 py-1.5 text-left transition-colors",
                    genType === val
                      ? "bg-accent-soft text-text ring-1 ring-inset ring-accent/40"
                      : "text-text-muted hover:bg-bg-hover hover:text-text"
                  )}
                >
                  <span className="text-[11px] font-semibold">{label}</span>
                  <span className="text-[10px] text-text-dim">{sub}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Save to">
            <div className="flex gap-1.5">
              <input
                value={genPath}
                onChange={(e) => setGenPath(e.target.value)}
                placeholder="~/.ssh/faro_ed25519"
                spellCheck={false}
                className={cn(inputCls, "flex-1 font-mono text-[11px]")}
              />
              <button
                type="button"
                onClick={browseSaveLocation}
                title="Choose a location"
                aria-label="Choose a save location"
                className="flex shrink-0 items-center rounded-md border border-border bg-bg-panel px-2.5 text-text-muted hover:bg-bg-hover hover:text-text"
              >
                <FolderOpen size={14} />
              </button>
            </div>
          </Field>

          <Field label="Passphrase (optional)">
            <input
              type="password"
              value={genPass}
              onChange={(e) => setGenPass(e.target.value)}
              placeholder="Encrypts the private key at rest"
              autoComplete="new-password"
              className={inputCls}
            />
          </Field>

          {overwrite && (
            <label className="mb-2 flex cursor-pointer items-center gap-2 text-[11px] text-danger">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
                className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
              />
              Overwrite the existing key at this path
            </label>
          )}

          <button
            type="button"
            onClick={doGenerate}
            disabled={genBusy || !genPath.trim()}
            className="btn-accent flex w-full items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {genBusy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {genBusy ? "Generating…" : "Generate key"}
          </button>
          <div className="mt-1.5 text-[11px] leading-relaxed text-text-dim">
            Faro writes the private key here (and a{" "}
            <span className="font-mono">.pub</span> beside it) and points this
            connection at it. Then add the public key to the server.
          </div>
        </div>
      )}

      {/* Public-key result — copyable, with the "put this on the server" nudge. */}
      {pubKey && (
        <div className="mb-3 rounded-md border border-success/30 bg-success/5 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-text">
            <Check size={13} className="shrink-0 text-success" />
            <span>
              {justSaved ? "Key created" : "Public key"} — add it to the server's{" "}
              <span className="font-mono text-text-muted">
                ~/.ssh/authorized_keys
              </span>
            </span>
          </div>
          <textarea
            readOnly
            value={pubKey.publicKey}
            rows={3}
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
            className={cn(
              inputCls,
              "resize-none break-all font-mono text-[11px] leading-snug"
            )}
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span
              className="min-w-0 truncate font-mono text-[10px] text-text-dim"
              title={pubKey.fingerprint}
            >
              {pubKey.fingerprint}
            </span>
            <button
              type="button"
              onClick={() => copyLine(pubKey.publicKey)}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-bg-subtle px-2 py-1 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text"
            >
              {copied ? (
                <Check size={11} className="text-accent" />
              ) : (
                <Copy size={11} />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {justSaved && (
            <div className="mt-1.5 text-[10.5px] text-text-dim">
              Saved to <span className="font-mono">{pubKey.path}</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function SettingsJump({
  entry,
  children,
}: {
  entry: SettingsEntryPointId;
  children: ReactNode;
}) {
  const openSettings = useLayout((s) => s.openSettings);
  return (
    <button
      type="button"
      data-settings-link={entry}
      onClick={() => openSettings(SETTINGS_ENTRY_POINTS[entry])}
      className="font-medium text-accent hover:underline"
    >
      {children}
    </button>
  );
}

/// Faro Agent connection editor: host/port, LAN discovery, and the pairing
/// ceremony. Controls a whole remote machine (no login/auth) — it's paired once
/// with a 6-digit code the daemon prints, then keyed by the pinned daemon key.
function AgentSection({
  profileId,
  host,
  setHost,
  port,
  setPort,
  setPortTouched,
  paired,
  onPair,
  onUnpair,
}: {
  profileId: string;
  host: string;
  setHost: (v: string) => void;
  port: number;
  setPort: (v: number) => void;
  setPortTouched: (v: boolean) => void;
  paired: boolean;
  onPair: (code: string) => Promise<void>;
  onUnpair: () => void;
}) {
  const [code, setCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<DiscoveredAgent[] | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setFound(await ipc.discoverAgents());
    } catch (e) {
      toast.error("Scan failed", String(e));
    } finally {
      setScanning(false);
    }
  }, []);

  // Scan the moment the Faro Agent form opens — finding machines shouldn't
  // require knowing there's a button for it.
  useEffect(() => {
    void scan();
  }, [scan]);

  const doPair = async () => {
    setPairing(true);
    try {
      await onPair(code.trim());
      setCode("");
    } catch (e) {
      toast.error("Pairing failed", String(e));
    } finally {
      setPairing(false);
    }
  };

  const codeValid = /^\d{6}$/.test(code.trim());
  // The machine the host/port fields currently point at, if it was discovered.
  const selectedMachine = found?.find((d) => d.host === host && d.port === port);

  return (
    <>
      <div className="flex gap-2">
        <Field label="Host / IP" className="flex-1">
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.42"
            className={inputCls}
          />
        </Field>
        <Field label="Port" className="w-24">
          <input
            type="number"
            value={port}
            onChange={(e) => {
              setPort(parseInt(e.target.value) || PROTOCOL_DEFAULT_PORT["faro-agent"]);
              setPortTouched(true);
            }}
            className={inputCls}
          />
        </Field>
      </div>

      {/* LAN discovery — runs automatically on open; the button rescans. */}
      <div className="mb-3">
        <button
          type="button"
          onClick={scan}
          disabled={scanning}
          className="flex items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-xs text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-50"
        >
          {scanning ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Radar size={12} />
          )}
          {scanning ? "Scanning…" : found ? "Rescan network" : "Scan local network"}
        </button>
        {found && found.length === 0 && !scanning && (
          <div className="mt-1.5 text-[11px] text-text-dim">
            No devices found. Enable Faro Agent on your phone or TV, or Remote
            control in the desktop Faro app. Keep both devices on the same
            network, or enter the device's IP above.
          </div>
        )}
        {found && found.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-1">
            {found.map((d) => {
              const selected = d.host === host && d.port === port;
              const isThisProfile = d.pairedProfileId === profileId;
              return (
                <button
                  key={d.fingerprint + d.host}
                  type="button"
                  onClick={() => {
                    setHost(d.host);
                    setPort(d.port);
                    setPortTouched(true);
                    // Lead the user to the next step instead of silently
                    // filling a field they may not be looking at.
                    if (!paired) codeRef.current?.focus();
                  }}
                  className={cn(
                    "flex items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
                    selected
                      ? "border-accent bg-accent/10"
                      : "border-border bg-bg-subtle hover:bg-bg-hover"
                  )}
                >
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium text-text">
                        {d.hostname || d.host}
                      </span>
                      {selected && <Check size={11} className="shrink-0 text-accent" />}
                    </span>
                    <span className="block truncate text-[10px] text-text-dim">
                      {d.os} · {d.host}:{d.port} · {d.fingerprint}
                    </span>
                  </span>
                  {d.pairedProfileId ? (
                    <span className="ml-2 shrink-0 rounded-full border border-success/40 bg-success/10 px-1.5 py-0.5 text-[9px] font-medium text-success">
                      {isThisProfile ? "this connection" : "paired"}
                    </span>
                  ) : d.pairable ? (
                    <span className="ml-2 shrink-0 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[9px] font-medium text-accent">
                      ready to pair
                    </span>
                  ) : (
                    <MonitorSmartphone size={13} className="ml-2 shrink-0 text-text-dim" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Pairing */}
      {paired ? (
        <div className="mb-3 flex items-center justify-between rounded-md border border-success/30 bg-success/10 px-2.5 py-2">
          <span className="flex items-center gap-1.5 text-xs text-text">
            <Check size={13} className="text-success" />
            Paired — the daemon's key is pinned.
          </span>
          <button
            type="button"
            onClick={onUnpair}
            className="text-[11px] text-text-dim underline hover:text-text"
          >
            Re-pair
          </button>
        </div>
      ) : (
        <div className="mb-3 rounded-md border border-border bg-bg-subtle p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-text">
            <Link2 size={13} className="text-accent" />
            {selectedMachine
              ? `Pair with ${selectedMachine.hostname || host}`
              : "Pair with this machine"}
          </div>
          <div className="mb-2 text-[11px] leading-relaxed text-text-dim">
            {selectedMachine?.os === "android" ? (
              <>
                On your phone or TV, open Faro Agent, grant storage access,
                enable the agent, and select Show pairing code. Enter that
                6-digit code here.
              </>
            ) : selectedMachine && selectedMachine.pairable === false ? (
              <>
                <span className="font-medium text-text-muted">
                  {selectedMachine.hostname || host}
                </span>{" "}
                isn't accepting pairing right now. On that machine run{" "}
                <span className="font-mono text-text-muted">faro-agentd pair</span> (or
                open its Faro app →{" "}
                <SettingsJump entry="pairingRemoteControl">Settings → Remote control</SettingsJump>
                {" "}→ Show pairing code),
                then type the code here.
              </>
            ) : selectedMachine ? (
              <>
                Type the 6-digit code showing on{" "}
                <span className="font-medium text-text-muted">
                  {selectedMachine.hostname || host}
                </span>
                . No code there? Run{" "}
                <span className="font-mono text-text-muted">faro-agentd pair</span> on
                it, or open its Faro app →{" "}
                <SettingsJump entry="pairingRemoteControl">Settings → Remote control</SettingsJump>
                {" "}→ Show pairing code.
              </>
            ) : (
              <>
                On the machine you want to control, run{" "}
                <span className="font-mono text-text-muted">faro-agentd pair</span> (or
                open its Faro app →{" "}
                <SettingsJump entry="pairingRemoteControl">Settings → Remote control</SettingsJump>
                {" "}→ Show pairing code) and
                type the 6-digit code below. Pairing sets up an end-to-end encrypted
                link and pins the machine's key — you won't need the code again.
              </>
            )}
          </div>
          <div className="flex gap-2">
            <input
              ref={codeRef}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && codeValid && host && !pairing) void doPair();
              }}
              placeholder="000000"
              inputMode="numeric"
              className={cn(inputCls, "flex-1 text-center font-mono tracking-[0.3em]")}
            />
            <button
              type="button"
              onClick={doPair}
              disabled={!codeValid || !host || pairing}
              className="btn-accent flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pairing && <Loader2 size={13} className="animate-spin" />}
              {pairing ? "Pairing…" : "Pair"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function AzureSection({
  account,
  setAccount,
  container,
  setContainer,
  accessKey,
  setAccessKey,
  endpoint,
  setEndpoint,
}: {
  account: string;
  setAccount: (v: string) => void;
  container: string;
  setContainer: (v: string) => void;
  accessKey: string;
  setAccessKey: (v: string) => void;
  endpoint: string;
  setEndpoint: (v: string) => void;
}) {
  return (
    <>
      <Hint>
        Azure Blob Storage. Use the storage account name and an account key
        (Portal → Storage account → Access keys). Custom endpoints target
        Azurite (local emulator) or sovereign clouds.
      </Hint>

      <div className="flex gap-2">
        <Field label="Storage account" className="flex-1">
          <input
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="mystorageacct"
            className={inputCls}
          />
        </Field>
        <Field label="Container" className="flex-1">
          <input
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            placeholder="my-container"
            className={inputCls}
          />
        </Field>
      </div>

      <Field label="Access key">
        <input
          type="password"
          value={accessKey}
          onChange={(e) => setAccessKey(e.target.value)}
          className={inputCls}
        />
      </Field>

      <Field label="Endpoint (optional)">
        <input
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="(leave blank for public Azure)"
          className={inputCls}
        />
      </Field>
    </>
  );
}

/// OAuth cloud connect (Dropbox / OneDrive / …). Like agent pairing: authorizing
/// runs a browser flow and stores tokens in the OS keychain keyed by the profile
/// id, then the editor persists the profile. No password lives in Faro.
/** How to register your own app with each cloud drive, for builds without a
 *  built-in one. Faro listens on this fixed loopback redirect. */
const OAUTH_REDIRECT_URI = "http://localhost:53682/";

interface OAuthAppSetup {
  console: string;
  steps: string[];
  /** The provider rejects the token exchange without the app's secret. */
  needsSecret: boolean;
}

const OAUTH_APP_SETUP: Partial<Record<Protocol, OAuthAppSetup>> = {
  dropbox: {
    console: "https://www.dropbox.com/developers/apps",
    steps: [
      "Create app → Scoped access → Full Dropbox (or App folder).",
      `Settings → OAuth 2 → Redirect URIs: add ${OAUTH_REDIRECT_URI}`,
      "Permissions: tick account_info.read, files.metadata.read, files.content.read and files.content.write, then Submit.",
      "Copy the App key into Client ID below. No secret is needed.",
    ],
    needsSecret: false,
  },
  onedrive: {
    console: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    steps: [
      "New registration. Supported account types: include personal Microsoft accounts if you use OneDrive personal.",
      `Authentication → Add a platform → Mobile and desktop applications → custom redirect URI ${OAUTH_REDIRECT_URI}`,
      "Authentication → Allow public client flows: Yes.",
      "API permissions → Microsoft Graph (delegated): Files.ReadWrite, offline_access, User.Read.",
      "Copy the Application (client) ID into Client ID below. No secret is needed.",
    ],
    needsSecret: false,
  },
  gdrive: {
    console: "https://console.cloud.google.com/apis/credentials",
    steps: [
      "Enable the Google Drive API for your project.",
      "OAuth consent screen: External, and add your own Google account as a test user.",
      "Credentials → Create credentials → OAuth client ID → Desktop app.",
      "Copy the Client ID and Client secret below. Google requires the secret for desktop apps.",
    ],
    needsSecret: true,
  },
  box: {
    console: "https://app.box.com/developers/console",
    steps: [
      "Create Platform App → Custom App → User Authentication (OAuth 2.0).",
      `Configuration → OAuth 2.0 Redirect URI: ${OAUTH_REDIRECT_URI}`,
      "Application Scopes: tick Write all files and folders stored in Box.",
      "Copy the Client ID and Client Secret below. Box requires the secret.",
    ],
    needsSecret: true,
  },
};

function OAuthConnectSection({
  label,
  authorize: runAuthorize,
  profileId,
  authed,
  account,
  onAuthorized,
  onReset,
  setup,
  builtin,
  clientId = "",
  setClientId = () => {},
  clientSecret = "",
  setClientSecret = () => {},
  secretSaved = false,
}: {
  label: string;
  authorize: (profileId: string, app?: OAuthApp) => Promise<{ accountLabel: string }>;
  profileId: string;
  authed: boolean;
  account: string;
  onAuthorized: (label: string) => void;
  onReset: () => void;
  setup?: OAuthAppSetup;
  /** Whether this build ships an app for the provider; undefined while loading. */
  builtin?: boolean;
  clientId?: string;
  setClientId?: (v: string) => void;
  clientSecret?: string;
  setClientSecret?: (v: string) => void;
  secretSaved?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  // No built-in app: the user's own is required. With one, it's an opt-in.
  const [ownApp, setOwnApp] = useState(!!clientId.trim());
  // Sections without a setup guide (Dynamics) keep their own app handling.
  const usingOwnApp = !!setup && (builtin === false || ownApp);
  const appsLoading = !!setup && builtin === undefined;
  const needsClientId = usingOwnApp && !clientId.trim();
  const missingSecret =
    usingOwnApp && !!setup?.needsSecret && !clientSecret.trim() && !secretSaved;

  // Tokens belong to the app that issued them: a different app means
  // authorizing again.
  const changeClientId = (v: string) => {
    setClientId(v);
    if (authed) onReset();
  };

  const authorize = async () => {
    setBusy(true);
    try {
      const res = await runAuthorize(
        profileId,
        usingOwnApp ? { clientId, clientSecret } : undefined
      );
      onAuthorized(res.accountLabel);
      toast.success(
        `Connected to ${label}`,
        res.accountLabel ? `Authorized as ${res.accountLabel}` : undefined
      );
    } catch (e) {
      toast.error(`${label} authorization failed`, String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Hint>
        Connect a {label} account. Authorizing opens your browser once; Faro
        stores the refresh token in your OS keychain and never sees your {label}{" "}
        password.
      </Hint>

      {builtin === false && (
        <Hint tone="warn">
          This build of Faro has no built-in {label} app, so you need to
          register your own (free, about five minutes) and paste its Client ID
          here.
        </Hint>
      )}

      {builtin === true && (
        <label className="mb-3 flex items-center gap-2 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={ownApp}
            onChange={(e) => {
              setOwnApp(e.target.checked);
              if (!e.target.checked) changeClientId("");
            }}
          />
          Use my own {label} app
        </label>
      )}

      {usingOwnApp && setup && (
        <>
          <div className="mb-3 rounded-md border border-border bg-bg-subtle px-2.5 py-2 text-[11.5px] leading-relaxed text-text-muted">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-medium text-text">Register a {label} app</span>
              <button
                type="button"
                onClick={() => ipc.openExternalUrl(setup.console).catch(() => {})}
                className="text-[11px] text-accent underline hover:text-text"
              >
                Open developer console
              </button>
            </div>
            <ol className="list-decimal space-y-0.5 pl-4">
              {setup.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
          <Field label="Client ID">
            <input
              value={clientId}
              onChange={(e) => changeClientId(e.target.value)}
              placeholder={label === "Dropbox" ? "App key" : "Client ID"}
              spellCheck={false}
              autoComplete="off"
              className={inputCls}
            />
          </Field>
          <Field label={setup.needsSecret ? "Client secret" : "Client secret (optional)"}>
            <PasswordInput value={clientSecret} onChange={setClientSecret} generate={false} />
          </Field>
          {secretSaved && (
            <Hint>
              A secret is already in your OS keychain; leave the field blank to
              keep it.
            </Hint>
          )}
        </>
      )}

      {authed ? (
        <div className="mb-3 flex items-center justify-between rounded-md border border-success/30 bg-success/10 px-2.5 py-2">
          <span className="flex items-center gap-1.5 text-xs text-text">
            <Check size={13} className="text-success" />
            Connected{account ? ` as ${account}` : ""}.
          </span>
          <button
            type="button"
            onClick={onReset}
            className="text-[11px] text-text-dim underline hover:text-text"
          >
            Reconnect
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={authorize}
          disabled={busy || appsLoading || needsClientId || missingSecret}
          title={
            needsClientId
              ? "Enter your app's Client ID first"
              : missingSecret
                ? `${label} needs your app's client secret`
                : undefined
          }
          className="btn-accent mb-3 flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Box size={14} />}
          {busy ? "Waiting for authorization…" : `Connect with ${label}`}
        </button>
      )}
    </>
  );
}

function HttpSection({
  url,
  setUrl,
  username,
  setUsername,
  password,
  setPassword,
}: {
  url: string;
  setUrl: (v: string) => void;
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
}) {
  const [auth, setAuth] = useState<boolean>(!!username);
  return (
    <>
      <Hint>
        Read-only browse of any static file server. Point at a directory with an
        autoindex (nginx / Apache) to browse it, or paste a direct file URL to
        pull a single artifact. No uploads, renames, or deletes.
      </Hint>

      <Field label="URL">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://files.example.com/pub/"
          className={inputCls}
        />
      </Field>

      <label className="mb-3 flex cursor-pointer items-center gap-2.5 rounded-md border border-border bg-bg-subtle px-2.5 py-2">
        <input
          type="checkbox"
          checked={auth}
          onChange={(e) => {
            setAuth(e.target.checked);
            if (!e.target.checked) {
              setUsername("");
              setPassword("");
            }
          }}
          className="h-3.5 w-3.5 shrink-0 accent-[rgb(var(--accent))]"
        />
        <span className="text-xs font-medium text-text">
          Server needs HTTP Basic auth
        </span>
      </label>

      {auth && (
        <>
          <Field label="Username">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Password">
            <PasswordInput value={password} onChange={setPassword} />
          </Field>
        </>
      )}
    </>
  );
}

function WebdavSection({
  url,
  setUrl,
  username,
  setUsername,
  password,
  setPassword,
}: {
  url: string;
  setUrl: (v: string) => void;
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
}) {
  const [provider, setProvider] = useState<WebdavProvider>("nextcloud");
  // Bearer mode = no username (the value in `password` is the token).
  const [mode, setMode] = useState<"basic" | "bearer">(
    !username && password ? "bearer" : "basic"
  );
  const preset = WEBDAV_PROVIDER_PRESETS[provider];

  const applyPreset = (p: WebdavProvider) => {
    setProvider(p);
    const tpl = WEBDAV_PROVIDER_PRESETS[p].urlHint;
    // Prefill the URL template, substituting a known username where it appears.
    setUrl(username ? tpl.replace("<user>", username) : tpl);
  };

  return (
    <>
      <Field group label="Provider">
        <div className="grid grid-cols-4 gap-1 rounded-md border border-border bg-bg-subtle p-1">
          {(Object.keys(WEBDAV_PROVIDER_PRESETS) as WebdavProvider[]).map((p) => {
            const data = WEBDAV_PROVIDER_PRESETS[p];
            return (
              <button
                key={p}
                type="button"
                onClick={() => applyPreset(p)}
                className={
                  "flex flex-col items-start rounded-sm px-2 py-1.5 text-left transition-colors " +
                  (provider === p
                    ? "bg-accent-soft text-text ring-1 ring-inset ring-accent/40"
                    : "text-text-muted hover:bg-bg-hover hover:text-text")
                }
              >
                <span className="flex items-center gap-1 text-[11px] font-semibold">
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center",
                      provider === p ? "text-accent" : "text-text-dim"
                    )}
                  >
                    {WEBDAV_PROVIDER_ICON[p] ? (
                      <BrandIcon icon={WEBDAV_PROVIDER_ICON[p]!} size={13} />
                    ) : (
                      <Globe size={11} />
                    )}
                  </span>
                  {data.label}
                </span>
                <span className="text-[10px] text-text-dim">{data.vendor}</span>
              </button>
            );
          })}
        </div>
      </Field>

      <Hint>{preset.description}</Hint>

      <Field label="Server URL">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={preset.urlHint}
          className={inputCls}
        />
      </Field>

      <Field group label="Auth">
        <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-bg-subtle p-1">
          {(["basic", "bearer"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                if (m === "bearer") setUsername("");
              }}
              className={
                "rounded-sm px-2 py-1.5 text-[11px] font-semibold transition-colors " +
                (mode === m
                  ? "bg-accent-soft text-text ring-1 ring-inset ring-accent/40"
                  : "text-text-muted hover:bg-bg-hover hover:text-text")
              }
            >
              {m === "basic" ? "Username + password" : "Bearer token"}
            </button>
          ))}
        </div>
      </Field>

      {mode === "basic" && (
        <Field label="Username">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="alice"
            className={inputCls}
          />
        </Field>
      )}

      <Field label={mode === "basic" ? "Password" : "Bearer token"}>
        <PasswordInput value={password} onChange={setPassword} />
      </Field>
    </>
  );
}

function ShopifySection({
  domain,
  setDomain,
  mode,
  setMode,
  token,
  setToken,
  clientId,
  setClientId,
  clientSecret,
  setClientSecret,
  secretSaved,
}: {
  domain: string;
  setDomain: (v: string) => void;
  mode: "token" | "client";
  setMode: (m: "token" | "client") => void;
  token: string;
  setToken: (v: string) => void;
  clientId: string;
  setClientId: (v: string) => void;
  clientSecret: string;
  setClientSecret: (v: string) => void;
  secretSaved: boolean;
}) {
  return (
    <>
      <Field label="Store domain">
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="my-store.myshopify.com"
          className={inputCls}
        />
      </Field>

      <Hint>
        Browse and edit theme files like an FTP site. Prefer an
        unpublished/duplicate theme — changes deploy instantly.
      </Hint>

      <Field group label="Auth">
        <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-bg-subtle p-1">
          {(["token", "client"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={
                "rounded-sm px-2 py-1.5 text-[11px] font-semibold transition-colors " +
                (mode === m
                  ? "bg-accent-soft text-text ring-1 ring-inset ring-accent/40"
                  : "text-text-muted hover:bg-bg-hover hover:text-text")
              }
            >
              {m === "token" ? "Access token" : "Client ID + Secret"}
            </button>
          ))}
        </div>
      </Field>

      {mode === "token" ? (
        <Field label="Admin API access token">
          <PasswordInput value={token} onChange={setToken} />
        </Field>
      ) : (
        <>
          <Field label="Client ID">
            <PasswordInput value={clientId} onChange={setClientId} />
          </Field>
          <Field label="Client secret">
            <PasswordInput value={clientSecret} onChange={setClientSecret} />
          </Field>
        </>
      )}

      <Hint>
        Stored in your OS keychain — never in the connections file.
        {secretSaved
          ? " A credential is already saved; leave the fields blank to keep it."
          : ""}
      </Hint>
    </>
  );
}

function WordPressSection({
  site,
  setSite,
  siteOk,
  username,
  setUsername,
  password,
  setPassword,
  secretSaved,
}: {
  site: string;
  setSite: (v: string) => void;
  siteOk: boolean;
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  secretSaved: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");

  // Opens WordPress's own "Authorize Application" page with Faro's name
  // filled in. WordPress shows the new password there; the user pastes it.
  const createPassword = async () => {
    setBusy(true);
    try {
      const res = await ipc.wordpressAuthorize(site);
      setSite(res.site);
      setLink(res.authorizeUrl);
    } catch (e) {
      toast.error("Couldn't open WordPress", String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Field label="Site address">
        <input
          value={site}
          onChange={(e) => setSite(e.target.value)}
          placeholder="https://example.com"
          className={inputCls}
          spellCheck={false}
        />
      </Field>

      <Hint>
        Works without FTP or SSH: Faro talks to the site's REST API with an
        Application Password (WordPress 5.6+). You'll see the media library, and
        every plugin API the site offers (Gravity Forms, WooCommerce…) as JSON
        files you can open, edit and save. Needs an administrator account.
      </Hint>

      <button
        type="button"
        onClick={createPassword}
        disabled={!siteOk || busy}
        className="btn-accent mb-3 flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <BrandIcon icon="simple-icons:wordpress" size={14} />
        )}
        Create an application password
      </button>

      {link && (
        <Hint>
          In the browser, log in if asked and click{" "}
          <b>Yes, I approve of this connection</b>. Copy the password WordPress
          shows and paste it below with your WordPress username. Browser didn't
          open?{" "}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(link);
              toast.success("Link copied");
            }}
            className="underline hover:text-text"
          >
            Copy the link
          </button>
          .
        </Hint>
      )}

      <div className="flex gap-2">
        <Field label="Username" className="w-48">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="admin"
            className={inputCls}
            spellCheck={false}
          />
        </Field>
        <Field label="Application password" className="flex-1">
          <PasswordInput value={password} onChange={setPassword} generate={false} />
        </Field>
      </div>

      <Hint>
        Not your login password — you can revoke it any time in wp-admin → Users
        → Profile → Application Passwords. Stored in your OS keychain, never in
        the connections file.
        {secretSaved ? " One is already saved; leave the field blank to keep it." : ""}
        {" "}If the site runs Wordfence, Login Security → Settings → "Disable
        application passwords" must be off.
      </Hint>
    </>
  );
}

function HubSpotSection({
  token,
  setToken,
  secretSaved,
  patWarn,
}: {
  token: string;
  setToken: (v: string) => void;
  secretSaved: boolean;
  patWarn: boolean;
}) {
  return (
    <>
      <Field label="Private app access token">
        <PasswordInput value={token} onChange={setToken} />
      </Field>

      <Hint>
        No URL needed — the token identifies your portal; the API base
        (api.hubapi.com) is fixed. Create a private app in your HubSpot portal
        (Settings → Integrations → Private Apps). Each scope unlocks a root:{" "}
        <code>content</code> for the design roots, <code>files</code> for the
        File Manager, <code>hubdb</code> for HubDB tables — any one is enough
        to connect; roots without their scope stay hidden.
      </Hint>

      <Hint tone="warn">
        Prefer the draft environment — published writes deploy instantly.
      </Hint>

      {patWarn && (
        <Hint tone="warn">
          Private-app tokens start with <code>pat-</code> — double-check that
          you pasted the right credential.
        </Hint>
      )}

      <Hint>
        Stored in your OS keychain — never in the connections file.
        {secretSaved
          ? " A token is already saved; leave the field blank to keep it."
          : ""}
      </Hint>
    </>
  );
}

function DynamicsSection({
  url,
  setUrl,
  urlOk,
  mode,
  setMode,
  tenantId,
  setTenantId,
  clientId,
  setClientId,
  clientSecret,
  setClientSecret,
  secretSaved,
  authorize,
  profileId,
  authed,
  account,
  onAuthorized,
  onReset,
}: {
  url: string;
  setUrl: (v: string) => void;
  urlOk: boolean;
  mode: "client" | "delegated";
  setMode: (m: "client" | "delegated") => void;
  tenantId: string;
  setTenantId: (v: string) => void;
  clientId: string;
  setClientId: (v: string) => void;
  clientSecret: string;
  setClientSecret: (v: string) => void;
  secretSaved: boolean;
  authorize: (profileId: string) => Promise<{ accountLabel: string }>;
  profileId: string;
  authed: boolean;
  account: string;
  onAuthorized: (label: string) => void;
  onReset: () => void;
}) {
  return (
    <>
      <Field label="Environment URL">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="my-org.crm.dynamics.com"
          className={inputCls}
        />
      </Field>

      <Hint tone="warn">
        Edits publish immediately — prefer a dev/sandbox environment.
      </Hint>

      <Field group label="Auth">
        <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-bg-subtle p-1">
          {(["client", "delegated"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={
                "rounded-sm px-2 py-1.5 text-[11px] font-semibold transition-colors " +
                (mode === m
                  ? "bg-accent-soft text-text ring-1 ring-inset ring-accent/40"
                  : "text-text-muted hover:bg-bg-hover hover:text-text")
              }
            >
              {m === "client" ? "Client credentials" : "Sign in with Microsoft"}
            </button>
          ))}
        </div>
      </Field>

      {mode === "client" ? (
        <>
          <Hint>
            Register an app in Microsoft Entra ID and add it as an application
            user on the environment (Power Platform admin center → Environments
            → Settings → Users + permissions → Application users).
          </Hint>

          <Field label="Tenant ID">
            <PasswordInput value={tenantId} onChange={setTenantId} />
          </Field>
          <Field label="Client ID">
            <PasswordInput value={clientId} onChange={setClientId} />
          </Field>
          <Field label="Client secret">
            <PasswordInput value={clientSecret} onChange={setClientSecret} />
          </Field>

          <Hint>
            Stored in your OS keychain — never in the connections file.
            {secretSaved
              ? " A credential is already saved; leave the fields blank to keep it."
              : ""}
          </Hint>
        </>
      ) : urlOk ? (
        <OAuthConnectSection
          label="Microsoft"
          authorize={authorize}
          profileId={profileId}
          authed={authed}
          account={account}
          onAuthorized={onAuthorized}
          onReset={onReset}
        />
      ) : (
        <Hint tone="warn">
          Enter a valid environment URL above before signing in — the delegated
          flow is scoped to that organization.
        </Hint>
      )}
    </>
  );
}

function GcsSection({
  bucket,
  setBucket,
  keyMode,
  setKeyMode,
  keyPath,
  setKeyPath,
  keyJson,
  setKeyJson,
}: {
  bucket: string;
  setBucket: (v: string) => void;
  keyMode: "file" | "paste";
  setKeyMode: (v: "file" | "paste") => void;
  keyPath: string;
  setKeyPath: (v: string) => void;
  keyJson: string;
  setKeyJson: (v: string) => void;
}) {
  return (
    <>
      <Hint>
        Google Cloud Storage. Create a service account with Storage access, then
        use its JSON key (Cloud console → IAM &amp; Admin → Service accounts →
        Keys). Point at the downloaded file, or paste the key directly.
      </Hint>

      <Field label="Bucket">
        <input
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          placeholder="my-gcs-bucket"
          className={inputCls}
        />
      </Field>

      <Field group label="Service account key">
        <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-bg-subtle p-1">
          {(["file", "paste"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setKeyMode(m)}
              className={
                "rounded-sm px-2 py-1.5 text-[11px] font-semibold transition-colors " +
                (keyMode === m
                  ? "bg-accent-soft text-text ring-1 ring-inset ring-accent/40"
                  : "text-text-muted hover:bg-bg-hover hover:text-text")
              }
            >
              {m === "file" ? "Key file path" : "Paste JSON"}
            </button>
          ))}
        </div>
      </Field>

      {keyMode === "file" ? (
        <Field label="Key file path">
          <input
            value={keyPath}
            onChange={(e) => setKeyPath(e.target.value)}
            placeholder="~/keys/service-account.json"
            className={inputCls}
          />
        </Field>
      ) : (
        <Field label="Service account JSON">
          <textarea
            value={keyJson}
            onChange={(e) => setKeyJson(e.target.value)}
            placeholder='{ "type": "service_account", ... }'
            spellCheck={false}
            rows={5}
            className={cn(inputCls, "resize-y font-mono text-[11px] leading-snug")}
          />
        </Field>
      )}
    </>
  );
}

function S3Section({
  provider,
  onProviderChange,
  bucket,
  setBucket,
  region,
  setRegion,
  endpoint,
  setEndpoint,
  accessKey,
  setAccessKey,
  secretKey,
  setSecretKey,
}: {
  provider: S3Provider;
  onProviderChange: (p: S3Provider) => void;
  bucket: string;
  setBucket: (v: string) => void;
  region: string;
  setRegion: (v: string) => void;
  endpoint: string;
  setEndpoint: (v: string) => void;
  accessKey: string;
  setAccessKey: (v: string) => void;
  secretKey: string;
  setSecretKey: (v: string) => void;
}) {
  const preset = S3_PROVIDER_PRESETS[provider];
  return (
    <>
      <Field group label="Provider">
        <div className="grid grid-cols-3 gap-1 rounded-md border border-border bg-bg-subtle p-1">
          {(Object.keys(S3_PROVIDER_PRESETS) as S3Provider[]).map((p) => {
            const data = S3_PROVIDER_PRESETS[p];
            return (
              <button
                key={p}
                type="button"
                onClick={() => onProviderChange(p)}
                className={
                  "flex flex-col items-start rounded-sm px-2 py-1.5 text-left transition-colors " +
                  (provider === p
                    ? "bg-accent-soft text-text ring-1 ring-inset ring-accent/40"
                    : "text-text-muted hover:bg-bg-hover hover:text-text")
                }
              >
                <span className="flex items-center gap-1 text-[11px] font-semibold">
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center",
                      provider === p ? "text-accent" : "text-text-dim"
                    )}
                  >
                    {S3_PROVIDER_ICON[p] ? (
                      <BrandIcon icon={S3_PROVIDER_ICON[p]!} size={13} />
                    ) : (
                      <Cloud size={11} />
                    )}
                  </span>
                  {data.label}
                </span>
                <span className="text-[10px] text-text-dim">{data.vendor}</span>
              </button>
            );
          })}
        </div>
      </Field>

      <Hint>{preset.description}</Hint>

      <Field label="Bucket">
        <input
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          placeholder="my-bucket"
          className={inputCls}
        />
      </Field>

      <div className="flex gap-2">
        <Field label="Region" className="w-32">
          <input
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label={provider === "aws" ? "Endpoint (optional)" : "Endpoint"} className="flex-1">
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={preset.endpointHint}
            className={inputCls}
          />
        </Field>
      </div>

      <Field label="Access key ID">
        <input
          value={accessKey}
          onChange={(e) => setAccessKey(e.target.value)}
          placeholder="AKIA…"
          className={inputCls}
        />
      </Field>
      <Field label="Secret access key">
        <input
          type="password"
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          className={inputCls}
        />
      </Field>
    </>
  );
}

function protocolHint(p: Protocol): string {
  switch (p) {
    case "sftp":
      return "SSH · :22";
    case "ftp":
      return "Plain · :21";
    case "ftps":
      return "TLS · :21";
    case "s3":
      return "Object · :443";
    case "azure":
      return "Blob · :443";
    case "gcs":
      return "Object · :443";
    case "webdav":
      return "HTTP · :443";
    case "http":
      return "Read-only · :443";
    case "dropbox":
      return "OAuth · Cloud";
    case "onedrive":
      return "OAuth · Cloud";
    case "gdrive":
      return "OAuth · Cloud";
    case "box":
      return "OAuth · Cloud";
    case "shopify":
      return "Theme files · :443";
    case "hubspot":
      return "Design files · :443";
    case "dynamics":
      return "Web resources · :443";
    case "wordpress":
      return "REST API · :443";
    case "faro-agent":
      return "Machine · :8722";
  }
}

function ProtocolButton({
  active,
  onClick,
  protocol,
  label,
  note,
}: {
  active: boolean;
  onClick: () => void;
  protocol: Protocol;
  label: string;
  /** Small trailing tag, e.g. "Own app" for a cloud drive with no built-in app. */
  note?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={
        "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors " +
        (active
          ? "bg-accent-soft font-medium text-accent"
          : "text-text-muted hover:bg-bg-hover hover:text-text")
      }
    >
      {/* Real brand/protocol logo. Colour marks (S3/Azure/Dropbox…) keep their
          own palette; monochrome glyphs (SSH/FTP/HTTP/lighthouse) follow the
          button's text colour via currentColor. Fixed 16px slot keeps labels
          aligned regardless of each mark's aspect ratio. */}
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center",
          active ? "text-accent" : "text-text-dim"
        )}
      >
        <BrandIcon icon={protocolIcon(protocol)} size={15} />
      </span>
      <span className="truncate">{label}</span>
      {note && (
        <span
          title="This build has no built-in app for this provider: bring your own app's Client ID"
          className="ml-auto shrink-0 rounded border border-border px-1 text-[9.5px] font-normal text-text-dim"
        >
          {note}
        </span>
      )}
    </button>
  );
}

const PROXY_DEFAULT_PORT: Record<ProxyKind, number> = { socks5: 1080, http: 3128 };

/** Editor state for a proxy command; `kind` "" = none. */
interface ProxyCmdDraft {
  kind: ProxyCommandKind | "";
  command: string;
  hostname: string;
  serviceTokenId: string;
  serviceTokenSecret: string;
}

function proxyCmdDraft(c?: ProxyCommandConfig, host?: string): ProxyCmdDraft {
  return {
    kind: c?.kind ?? "",
    command: c?.command ?? "",
    // The editor's Cloudflare "Server": the Access hostname, else the host.
    hostname: c?.hostname || (c?.kind === "cloudflare" ? host ?? "" : ""),
    serviceTokenId: c?.serviceTokenId ?? "",
    serviceTokenSecret: c?.serviceTokenSecret ?? "",
  };
}

type Reach = "direct" | "cloudflare" | "jump";

const REACH_OPTIONS: { id: Reach; label: string; hint: string }[] = [
  { id: "direct", label: "Direct", hint: "Its SSH port is open to you" },
  { id: "cloudflare", label: "Through Cloudflare", hint: "Port closed, Access in front" },
  { id: "jump", label: "Through a jump host", hint: "Via another SSH server" },
];

/// "How do you reach this server?" at the top of an SFTP form.
function ReachPicker({ value, onChange }: { value: Reach; onChange: (r: Reach) => void }) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-[11px] font-medium text-text-muted">How do you reach this server?</div>
      <div role="radiogroup" aria-label="How do you reach this server?" className="grid grid-cols-3 gap-1.5">
        {REACH_OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            onClick={() => onChange(o.id)}
            className={cn(
              "rounded-md border px-2.5 py-1.5 text-left",
              value === o.id ? "border-accent bg-accent-soft" : "border-border bg-bg-subtle hover:bg-bg-hover"
            )}
          >
            <span className="block text-[12px] font-medium text-text">{o.label}</span>
            <span className="block truncate text-[10.5px] text-text-dim">{o.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/// The jump host to go through (another saved SSH connection).
function JumpHostField({
  profileId,
  profiles,
  jumpProfile,
  setJumpProfile,
}: {
  profileId: string;
  profiles: ConnectionProfile[];
  jumpProfile: string;
  setJumpProfile: (v: string) => void;
}) {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  // A profile that already jumps through this one would make a loop.
  const jumpsThrough = (p: ConnectionProfile | undefined) => {
    for (let i = 0; p && i < 10; i++) {
      if (p.id === profileId) return true;
      p = p.jumpProfile ? byId.get(p.jumpProfile) : undefined;
    }
    return false;
  };
  const candidates = profiles.filter(
    (p) => p.protocol === "sftp" && p.id !== profileId && !jumpsThrough(p)
  );
  const missing = !!jumpProfile && !byId.has(jumpProfile);
  return (
    <>
      <Field label="Jump host">
        <select value={jumpProfile} onChange={(e) => setJumpProfile(e.target.value)} className={inputCls}>
          <option value="">Choose a saved SSH connection…</option>
          {missing && <option value={jumpProfile}>(deleted connection)</option>}
          {candidates.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.username ? `${p.username}@` : ""}
              {p.host})
            </option>
          ))}
        </select>
      </Field>
      {candidates.length === 0 && !jumpProfile ? (
        <Hint tone="warn">Save the jump host as an SSH connection first, then pick it here.</Hint>
      ) : (
        <Hint>
          Faro signs in to the jump host with its own login, then opens this server through it. A
          proxy, if needed, goes on the jump host's connection.
        </Hint>
      )}
    </>
  );
}

/// "Through Cloudflare": the server's Access hostname, the sign-in status,
/// and the SSH host and port as optional details.
function CloudflareServerFields({
  server,
  setServer,
  host,
  setHost,
  port,
  setPort,
  certLogin,
  serviceTokenId,
  onRemoveToken,
}: {
  server: string;
  setServer: (v: string) => void;
  host: string;
  setHost: (v: string) => void;
  port: number;
  setPort: (v: number) => void;
  certLogin: boolean;
  serviceTokenId: string;
  onRemoveToken: () => void;
}) {
  const hostnames = useCloudflareHostnames();
  const listId = useId();
  const custom = (!!host.trim() && host.trim() !== server.trim()) || port !== 22;
  const [details, setDetails] = useState(custom);
  const known = hostnames.find((h) => h.hostname === server.trim());
  return (
    <>
      <Field label="Server">
        <input
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="ssh.example.com"
          list={listId}
          autoComplete="off"
          spellCheck={false}
          className={inputCls}
        />
        <datalist id={listId}>
          {hostnames.map((h) => (
            <option key={h.hostname} value={h.hostname}>
              {h.label}
            </option>
          ))}
        </datalist>
      </Field>
      <InstallCloudflared />
      {server.trim() && (
        <div className="mb-3 rounded-md border border-border px-2.5 py-2" data-testid="editor-access-signin">
          <AccessSignIn
            hostname={server.trim()}
            compact
            extra={(signedIn) => (
              <>
                {known?.tunnelStatus && (
                  <span data-testid="cf-tunnel-status">
                    {" · "}
                    <TunnelHealth status={known.tunnelStatus} />
                  </span>
                )}
                {certLogin && signedIn && <span> · certificate login ready</span>}
              </>
            )}
          />
        </div>
      )}
      {serviceTokenId.trim() && (
        <Hint tone="warn">
          This connection still carries its own service token (
          <span className="font-mono">{serviceTokenId}</span>). Faro now keeps one service token
          for the whole Cloudflare account, in{" "}
          <SettingsJump entry="profileCloudflareAccount">Settings › Cloudflare</SettingsJump>
          , for faro-cli and the Agent Bridge.{" "}
          <button type="button" onClick={onRemoveToken} className="font-medium text-accent hover:underline">
            Remove it from this connection
          </button>
        </Hint>
      )}
      <button
        type="button"
        onClick={() => setDetails((d) => !d)}
        aria-expanded={details}
        className="mb-2 flex items-center gap-1 text-[11px] text-text-muted hover:text-text"
      >
        <ChevronRight size={11} className={cn("transition-transform", details && "rotate-90")} />
        SSH host and port{custom ? `: ${host.trim() || server.trim()}:${port}` : " (optional)"}
      </button>
      {details && (
        <div className="flex gap-2">
          <Field label="SSH host, if not the server" className="flex-1">
            <input
              value={host === server ? "" : host}
              onChange={(e) => setHost(e.target.value || server)}
              placeholder={server.trim() || "same as the server"}
              className={inputCls}
            />
          </Field>
          <Field label="Port" className="w-24">
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(parseInt(e.target.value) || 22)}
              className={inputCls}
            />
          </Field>
        </div>
      )}
    </>
  );
}

/// SSH hostnames from the connected Cloudflare account, for the Server
/// dropdown; empty without an account.
function useCloudflareHostnames(): CfSshHostname[] {
  const [list, setList] = useState<CfSshHostname[]>([]);
  useEffect(() => {
    let cancelled = false;
    ipc
      .cfAccountHostnames()
      .then((l) => !cancelled && setList(l))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return list;
}

/// Collapsible "Proxy" block for a direct connection: a SOCKS5 / HTTP
/// CONNECT proxy for any connection, or (SFTP) a ProxyCommand. Cloudflare and
/// jump hosts are chosen in "How do you reach this server?" instead.
function NetworkSection({
  protocol,
  proxyKind,
  setProxyKind,
  proxyHost,
  setProxyHost,
  proxyPort,
  setProxyPort,
  proxyUser,
  setProxyUser,
  proxyPass,
  setProxyPass,
  proxyCmd,
  setProxyCmd,
  reach,
  ftpActiveMode,
}: {
  profileId: string;
  protocol: Protocol;
  profiles: ConnectionProfile[];
  proxyKind: ProxyKind | "";
  setProxyKind: (v: ProxyKind | "") => void;
  proxyHost: string;
  setProxyHost: (v: string) => void;
  proxyPort: number;
  setProxyPort: (v: number) => void;
  proxyUser: string;
  setProxyUser: (v: string) => void;
  proxyPass: string;
  setProxyPass: (v: string) => void;
  proxyCmd: ProxyCmdDraft;
  setProxyCmd: (v: ProxyCmdDraft) => void;
  reach: Reach;
  ftpActiveMode: boolean;
}) {
  const isSsh = protocol === "sftp";
  const cmdKind = isSsh && proxyCmd.kind === "command" ? "command" : "";
  const [open, setOpen] = useState(!!proxyKind || !!cmdKind);
  if (reach !== "direct") return null;
  const summary = [
    proxyKind && proxyHost.trim() ? `${proxyKind === "socks5" ? "SOCKS5" : "HTTP"} proxy` : "",
    cmdKind && proxyCmd.command.trim() ? "Proxy command" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const changeKind = (kind: ProxyKind | "") => {
    // Follow the new kind's usual port unless the user typed their own.
    if (kind && (!proxyKind || proxyPort === PROXY_DEFAULT_PORT[proxyKind])) {
      setProxyPort(PROXY_DEFAULT_PORT[kind]);
    }
    setProxyKind(kind);
  };
  // One select for both: a TCP proxy, or (SSH) a command that carries SSH.
  const changeRoute = (v: string) => {
    if (v === "command") {
      setProxyKind("");
      setProxyCmd({ ...proxyCmd, kind: v });
    } else {
      setProxyCmd({ ...proxyCmd, kind: "" });
      changeKind(v as ProxyKind | "");
    }
  };
  const setCmd = (patch: Partial<ProxyCmdDraft>) => setProxyCmd({ ...proxyCmd, ...patch });

  return (
    <div className="mb-3 rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-xs font-medium text-text hover:bg-bg-hover"
      >
        <ChevronRight
          size={12}
          className={cn("shrink-0 text-text-dim transition-transform", open && "rotate-90")}
        />
        Proxy
        <span className="ml-auto truncate font-normal text-text-dim">
          {summary || "None"}
        </span>
      </button>
      {open && (
        <div className="border-t border-border px-2.5 pt-3">
          <div className="flex gap-3">
            <Field label="Proxy" className={cn("shrink-0", isSsh ? "w-40" : "w-32")}>
              <select
                value={cmdKind || proxyKind}
                onChange={(e) => changeRoute(e.target.value)}
                className={inputCls}
              >
                <option value="">None</option>
                <option value="socks5">SOCKS5</option>
                <option value="http">HTTP</option>
                {isSsh && <option value="command">Command</option>}
              </select>
            </Field>
            {proxyKind && (
              <>
                <Field label="Proxy host" className="min-w-0 flex-1">
                  <input
                    value={proxyHost}
                    onChange={(e) => setProxyHost(e.target.value)}
                    placeholder="proxy.example.com"
                    className={inputCls}
                  />
                </Field>
                <Field label="Port" className="w-24 shrink-0">
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={proxyPort}
                    onChange={(e) => setProxyPort(Number(e.target.value) || 0)}
                    className={inputCls}
                  />
                </Field>
              </>
            )}
          </div>
          {proxyKind && (
            <div className="flex gap-3">
              <Field label="Proxy username (optional)" className="min-w-0 flex-1">
                <input
                  value={proxyUser}
                  onChange={(e) => setProxyUser(e.target.value)}
                  autoComplete="off"
                  className={inputCls}
                />
              </Field>
              <Field label="Proxy password" className="min-w-0 flex-1">
                <PasswordInput value={proxyPass} onChange={setProxyPass} generate={false} />
              </Field>
            </div>
          )}
          {cmdKind === "command" && (
            <>
              <Field label="Command">
                <input
                  value={proxyCmd.command}
                  onChange={(e) => setCmd({ command: e.target.value })}
                  placeholder="aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p"
                  autoComplete="off"
                  spellCheck={false}
                  className={cn(inputCls, "font-mono text-[11.5px]")}
                />
              </Field>
              <Hint>
                Faro runs this command and speaks SSH over its input and output,
                like OpenSSH's <code>ProxyCommand</code>. <code>%h</code>,{" "}
                <code>%p</code> and <code>%r</code> become the host, port and
                user. It runs without a shell; wrap pipes in{" "}
                <code>sh -c '…'</code>.
              </Hint>
            </>
          )}
          {proxyKind && ftpActiveMode && (
            <Hint tone="warn">
              Active mode can't work through a proxy. Switch the transfer mode to passive.
            </Hint>
          )}
        </div>
      )}
    </div>
  );
}

function Hint({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "warn";
}) {
  return (
    <div
      className={
        "mb-3 rounded-md border px-2.5 py-2 text-[11.5px] leading-relaxed " +
        (tone === "warn"
          ? "border-danger/30 bg-danger-soft/60 text-text-muted"
          : "border-border bg-bg-subtle text-text-muted")
      }
    >
      {children}
    </div>
  );
}

/** FTP path-name charsets offered in the editor: [WHATWG label, display].
 *  "" is auto — UTF-8, falling back to Windows-1252 if the server sends
 *  names that aren't valid UTF-8. */
const FTP_CHARSETS: [string, string][] = [
  ["", "Auto (UTF-8, falls back to Western)"],
  ["utf-8", "UTF-8"],
  ["windows-1252", "Western European (Windows-1252 / Latin-1)"],
  ["iso-8859-15", "Western European (ISO-8859-15)"],
  ["windows-1250", "Central European (Windows-1250)"],
  ["iso-8859-2", "Central European (ISO-8859-2)"],
  ["windows-1251", "Cyrillic (Windows-1251)"],
  ["koi8-r", "Cyrillic (KOI8-R)"],
  ["windows-1253", "Greek (Windows-1253)"],
  ["windows-1254", "Turkish (Windows-1254)"],
  ["windows-1255", "Hebrew (Windows-1255)"],
  ["windows-1256", "Arabic (Windows-1256)"],
  ["windows-1257", "Baltic (Windows-1257)"],
  ["windows-1258", "Vietnamese (Windows-1258)"],
  ["windows-874", "Thai (Windows-874)"],
  ["shift_jis", "Japanese (Shift_JIS)"],
  ["euc-jp", "Japanese (EUC-JP)"],
  ["gbk", "Chinese Simplified (GBK)"],
  ["gb18030", "Chinese Simplified (GB18030)"],
  ["big5", "Chinese Traditional (Big5)"],
  ["euc-kr", "Korean (EUC-KR)"],
];

const inputCls =
  "w-full rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-sm outline-none focus:border-accent";

function Field({
  label,
  className,
  group,
  children,
}: {
  label: string;
  className?: string;
  /** Wraps buttons, not one input: render a <div>, since a <label> turns any
   *  click on its caption or padding into a click on its first button. */
  group?: boolean;
  children: React.ReactNode;
}) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className={`mb-3 block ${className ?? ""}`}>
      <div className="mb-1 text-xs text-text-muted">{label}</div>
      {children}
    </Tag>
  );
}

/**
 * Password input with a reveal toggle and a "Generate strong password" action
 * that fills the field and copies the value to the clipboard — for the common
 * case of creating a brand-new server account while adding the connection.
 */
function PasswordInput({
  value,
  onChange,
  generate: canGenerate = true,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Offer "Generate strong password" — off for credentials a service
   *  issues (e.g. a WordPress application password). */
  generate?: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);

  async function generate() {
    const pw = generatePassword();
    onChange(pw);
    setReveal(true); // so the user can see/verify what was generated
    try {
      await navigator.clipboard.writeText(pw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (focus/permissions); the field is still set.
    }
  }

  return (
    <div>
      <div className="relative">
        <input
          type={reveal ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputCls, "pr-9")}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          title={reveal ? "Hide password" : "Show password"}
          aria-label={reveal ? "Hide password" : "Show password"}
          className="absolute inset-y-0 right-0 flex items-center px-2.5 text-text-dim hover:text-text"
        >
          {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      </div>
      {canGenerate && (
        <button
          type="button"
          onClick={generate}
          className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-border bg-bg-subtle px-2 py-1 text-[11.5px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
        >
          {copied ? (
            <Check size={11} className="text-accent" />
          ) : (
            <Wand2 size={11} />
          )}
          {copied ? "Generated & copied" : "Generate strong password"}
        </button>
      )}
    </div>
  );
}
