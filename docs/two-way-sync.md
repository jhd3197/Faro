# Two-way folder sync

Enable **Two-way sync with conflict review** when creating a Folder Sync pair.
Faro records separate local and remote file states after successful syncs. It
does not compare clocks on different machines to choose a winner.

- A change on one side is copied to the other.
- Changes on both sides, including deletion versus editing, require a choice.
- On the first run, files already present on both sides require an initial
  local or remote choice, even when their metadata looks identical.
- Additive mode restores a file deleted on one side. Mirror mode propagates
  deletions, retaining the previous file in recovery.
- An entirely emptied side requires explicit deletion choices. The configured
  deletion cap still applies. Missing or unreadable roots stop sync.

Conflicts appear on the pair in Folder Sync settings. **Use local** or **Use
remote** schedules that exact reviewed version for the next reconcile. A missing
side is labeled **deletion**. Choices become stale if either side changes; Faro
requests a new choice. Replaced and deleted files use the same staged publication
and recovery storage as one-way sync.

The baseline and choices persist in `faro.db`, separately from user preferences.
They are tied to the endpoint and roots. Removing the pair clears its history.
Changing its endpoint starts a fresh comparison. Failed or incomplete transfers
do not advance their baseline; some successfully copied files may need review
after a partially failed batch.

Change detection uses each backend's size, modification time and available ETag.
It is not a text merge or a content-hash scan: edits that preserve all these
signals can be missed. Sources are checked again before applying changes. Keep
independent backups for data requiring content-level verification.
