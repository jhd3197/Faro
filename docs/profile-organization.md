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
