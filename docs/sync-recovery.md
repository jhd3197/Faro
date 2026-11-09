# Sync recovery

Manual sync, continuous folder sync, `faro-cli sync`, and Agent Bridge sync keep
previous destination versions under `.faro-sync-recovery/<batch>/<relative-path>`.
Mirror moves destination-only files there. Both Additive and Mirror move an
existing destination file there before transferring its replacement.

Recovery folders are excluded from sync on both sides, including nested recovery
folders. They remain ordinary files that you can browse. Faro does not expire
them automatically; they consume space until you restore or remove them.

## Review and resolve

In the Sync dialog, preview the plan and uncheck a copy to keep its destination
version. Changing direction or strategy clears the old preview. If the destination
changes after preview, Faro refuses that operation and asks you to re-plan.

These checks compare size, modification time, and ETag where available. They are
not a content merge or continuous bidirectional conflict detection. On backends
without conditional writes, another program can still change a file between a
check and the write; avoid editing the same destination during sync.

## Restore a version

1. Open the Sync dialog for the same local and remote roots.
2. Select the direction whose destination holds the versions.
3. Select **Recover files**, then **Restore** beside a version.

If the original name is occupied, Faro restores under a unique
`.restored-<id>` suffix, keeping the current file intact. Compare the two files
before deciding which to keep. Pause continuous sync while restoring and resolving
versions, so the source does not immediately replace the restored file again.

The CLI can also list the recovery folder and move a version back with its
ordinary file commands. Use an unused destination name to keep both versions.

## Interrupted sync

If preserving a file fails, Faro stops instead of permanently deleting it or
overwriting without recovery. Backends that cannot rename/move files refuse
replacements and mirror removals. A failed transfer after preservation can leave
the original name absent or partially written; its previous version remains in
the recovery folder. Restore it there, or retry the transfer.

Mirror removals wait for queued copies to finish successfully. Sync is not a
transaction: work completed before a later error is retained.
