# Profile organization

Connection editors include server notes for purpose, maintenance details and
runbook links. Notes travel with connection exports and backups. Keep credentials
in their credential fields instead of notes.

Group moves, group renames, ungrouping and drag ordering are saved atomically.
The rail's Undo organization button restores up to 20 actions from this app
session. It changes group membership and ordering only. It refuses a stale undo
when another change has modified those same fields. Deleting connections is not
part of this undo history.

For SSH connections, choose a Group gateway in the editor. It is saved immediately
for the group, independently of saving the connection. A group such as
`Production/Europe/Web` inherits its closest configured parent gateway. Explicit
connection gateways, proxies and command routes take precedence. A gateway does
not inherit itself. Normal gateway cycle detection still applies.

Group gateways are stored in `profile-groups.json` and included in full backups.
Connection exports materialize inherited gateways and include their dependencies,
so the exported connections work without a separate group configuration file.

## Site folders and synchronized browsing

Each site shortcut remembers its own last local and remote folders. The server
view has a separate pair. Navigation updates these folders automatically, and
they survive layout changes, reconnects, and application restarts. A profile's
default local folder seeds a new pair; it does not replace a site's remembered
folder each time you return to it. Site home still opens the shortcut's saved
remote home.

Synchronized browsing is enabled independently for each pair. Turning it on uses
the two open folders as roots; the re-base button replaces those roots with the
current folders. The roots and enabled state are saved, not reset on reconnect.
Switching sites or connections cancels pending mirrored navigation. Missing or
unreadable counterparts leave the other pane in place. An unavailable remembered
local folder falls back to the local filesystem root and disables that pair's
synchronized browsing until you choose its folders again.

This only synchronizes navigation. It never uploads, downloads, overwrites, or
deletes files. Folder Sync and the Sync directory dialog remain separate,
explicit file-transfer features. Removing a shortcut removes its remembered
navigation and pairing settings, not any files.
