# Sync recovery

Manual sync, continuous folder sync, `faro-cli sync`, and Agent Bridge sync keep
previous destination versions under `.faro-sync-recovery/<batch>/<relative-path>`.
Mirror moves destination-only files there. Both Additive and Mirror transfer
replacements to `.faro-sync-staging/<batch>/<relative-path>` first. Faro checks
staged size against the preview, rechecks the destination, moves the old version
into recovery, then publishes the staged file. The old file stays available
throughout the transfer. Transfer success is reported only after publication.

Recovery and staging folders are excluded from sync on both sides, including nested folders. They remain ordinary files that you can browse. Faro does not expire
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

If transfer or verification fails, the original file remains in place. If
preserving it fails, Faro stops without overwriting it. If publication fails
and the destination is still absent, Faro attempts to restore the previous file
automatically. If a destination file appeared or cannot be inspected, Faro
leaves it untouched and reports the recovery path instead of risking an overwrite.

Local publication uses a no-replace hard link followed by removal of the staging
name; filesystems that cannot support this fail safely. SFTP publication uses
its rename operation. Other backends use a checked rename and may retain a race
with external writers. This is not an atomic swap of the old and new file:
there is a short gap between preserving the old version and publishing the new.

The staged byte count is always checked, including empty files. Optional transfer
checksum verification continues to apply where supported. Size checks alone
are not proof of identical content.

Pause and resume remain available while staging. The queue’s Pause and Cancel actions are refused during
the short publication/rollback phase. Failed or canceled replacements require a
fresh sync preview rather than the ordinary transfer Retry action. Replacement
jobs are not resumed automatically after restarting Faro; re-plan sync instead.
A process crash during publication can leave the previous version in recovery
and the replacement in staging. Those files are not automatically expired.

Mirror removals wait for queued copies to finish successfully. Sync is not a
transaction: work completed before a later error is retained.


Interrupted replacement publications are journaled in the local application data
folder. Before planning another sync, Faro checks abandoned journals for that
same endpoint and root. If the original name is empty, the old version matches
the journal, and the new file is still staged at its expected size, Faro restores
the old version. It leaves staged bytes for inspection. Existing destinations are
never replaced by replay. Ambiguous cases stop with an inspection message. OS
file locks prevent replay or cleanup while a publisher is active.

The recovery panel can preview permanent cleanup of saved versions or staged
files older than 7, 30, 90 or 365 days. Nothing expires automatically. The app
shows the exact candidates and requires a separate delete confirmation. It
rechecks each file against the preview and refuses batches with unfinished
publications. Empty storage directories may remain after cleanup.
