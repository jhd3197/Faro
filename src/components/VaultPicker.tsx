import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { KeyRound, Loader2, Search } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { UnlockForm } from "./PasswordManagerSettings";
import { cn } from "@/lib/cn";
import { ipc } from "@/lib/ipc";
import { messageOf } from "@/lib/errors";
import { useTypeToSearch } from "@/hooks/useTypeToSearch";
import { PM_NAMES, usePasswordManagers } from "@/stores/passwordManagersStore";
import type { PasswordManagerId, PmField, PmItem } from "@/lib/types";

export interface VaultPick {
  reference: string;
  item: PmItem;
  field: PmField;
}

const KIND_LABEL: Record<PmField["kind"], string> = {
  password: "Password",
  username: "Username",
  otp: "One-time code",
  text: "Text",
  note: "Note",
};

// Choose a 1Password or Bitwarden field for a profile's credential reference
// (Plan 33). Lists items, then the chosen item's fields (names only, never
// values) with the password field preselected.
export function VaultPicker({
  provider,
  onClose,
  onPick,
}: {
  provider: PasswordManagerId;
  onClose: () => void;
  onPick: (pick: VaultPick) => void;
}) {
  const name = PM_NAMES[provider];
  const status = usePasswordManagers((s) => s.status.find((p) => p.id === provider));
  const refresh = usePasswordManagers((s) => s.refresh);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PmItem[] | null>(null);
  const [itemsError, setItemsError] = useState("");
  const [selected, setSelected] = useState<PmItem | null>(null);
  const [fields, setFields] = useState<PmField[] | null>(null);
  const [fieldsError, setFieldsError] = useState("");
  const [field, setField] = useState<PmField | null>(null);
  const [reload, setReload] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const locked = provider === "bitwarden" && status?.state === "locked";
  // After an inline unlock the password field is gone: keep focus (and Esc)
  // inside the picker by moving to the search box.
  const wasLocked = useRef(locked);
  useEffect(() => {
    if (wasLocked.current && !locked) searchRef.current?.focus();
    wasLocked.current = locked;
  }, [locked]);

  // Items: refetched as the search changes (debounced) or after an unlock.
  useEffect(() => {
    if (locked) return;
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const list = await ipc.passwordManagerItems(provider, query.trim());
        if (stale) return;
        setItems(list);
        setItemsError("");
      } catch (e) {
        if (stale) return;
        setItems([]);
        setItemsError(messageOf(e));
      }
    }, query ? 150 : 0);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [provider, query, locked, reload]);

  // Fields for the chosen item, with the password-kind one preselected.
  useEffect(() => {
    setFields(null);
    setField(null);
    setFieldsError("");
    if (!selected) return;
    let stale = false;
    ipc
      .passwordManagerFields(provider, selected.id)
      .then((list) => {
        if (stale) return;
        setFields(list);
        setField(list.find((f) => f.kind === "password") ?? list[0] ?? null);
      })
      .catch((e) => {
        if (!stale) setFieldsError(messageOf(e));
      });
    return () => {
      stale = true;
    };
  }, [provider, selected]);

  useTypeToSearch(searchRef, (c) => setQuery((q) => q + c), !locked);

  const moveSelection = (delta: number) => {
    if (!items || items.length === 0) return;
    const i = selected ? items.findIndex((it) => it.id === selected.id) : -1;
    const next = items[Math.max(0, Math.min(items.length - 1, i + delta))];
    if (next && next.id !== selected?.id) setSelected(next);
  };

  const confirm = () => {
    if (!selected || !field) return false;
    onPick({ reference: field.reference, item: selected, field });
  };

  return createPortal(
    <Dialog
      title={`Choose from ${name}`}
      icon={<KeyRound size={15} />}
      size="lg"
      data-testid="vault-picker"
      onClose={onClose}
      onConfirm={confirm}
      confirmLabel="Use this field"
      confirmDisabled={!selected || !field}
      footerLeft={field ? <span className="truncate font-mono" data-vault-reference>{field.reference}</span> : undefined}
    >
      {locked ? (
        <div className="py-2">
          <p className="mb-2 text-sm text-text">Bitwarden is locked.</p>
          <UnlockForm autoFocus onUnlocked={() => setReload((n) => n + 1)} />
        </div>
      ) : (
        <>
          <div className="relative mb-3">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim" />
            <input
              ref={searchRef}
              aria-label={`Search ${name}`}
              placeholder={`Search ${name}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  moveSelection(e.key === "ArrowDown" ? 1 : -1);
                }
              }}
              className="w-full rounded-md border border-border bg-bg-subtle py-1.5 pl-8 pr-2.5 text-sm text-text outline-none focus:border-accent"
            />
          </div>
          <div className="grid h-72 grid-cols-2 gap-3">
            <div role="listbox" aria-label="Items" className="min-h-0 overflow-y-auto rounded-md border border-border">
              {items === null ? (
                <div className="flex items-center gap-2 p-3 text-xs text-text-muted">
                  <Loader2 size={13} className="animate-spin" /> Loading…
                </div>
              ) : itemsError ? (
                <p role="alert" className="p-3 text-xs text-danger">{itemsError}</p>
              ) : items.length === 0 ? (
                <p className="p-3 text-xs text-text-muted">{query ? `Nothing matches “${query}”.` : "No items."}</p>
              ) : (
                items.map((it) => {
                  const on = selected?.id === it.id;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      role="option"
                      aria-selected={on}
                      data-vault-item={it.title}
                      onClick={() => setSelected(it)}
                      className={cn(
                        "flex w-full flex-col items-start border-b border-border/60 px-3 py-2 text-left last:border-b-0",
                        on ? "bg-accent-soft" : "hover:bg-bg-hover"
                      )}
                    >
                      <span className={cn("w-full truncate text-sm", on ? "text-accent" : "text-text")}>{it.title}</span>
                      <span className="w-full truncate text-[11px] text-text-dim">
                        {[it.subtitle, it.vault, it.category].filter(Boolean).join(" · ")}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            <div role="radiogroup" aria-label="Fields" className="min-h-0 overflow-y-auto rounded-md border border-border">
              {!selected ? (
                <p className="p-3 text-xs text-text-muted">Choose an item to see its fields.</p>
              ) : fieldsError ? (
                <p role="alert" className="p-3 text-xs text-danger">{fieldsError}</p>
              ) : fields === null ? (
                <div className="flex items-center gap-2 p-3 text-xs text-text-muted">
                  <Loader2 size={13} className="animate-spin" /> Loading…
                </div>
              ) : fields.length === 0 ? (
                <p className="p-3 text-xs text-text-muted">This item has no fields Faro can use.</p>
              ) : (
                fields.map((f) => {
                  const on = field?.reference === f.reference;
                  return (
                    <button
                      key={f.reference}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      data-vault-field={f.label}
                      onClick={() => setField(f)}
                      onDoubleClick={() => {
                        setField(f);
                        onPick({ reference: f.reference, item: selected, field: f });
                        onClose();
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left last:border-b-0",
                        on ? "bg-accent-soft" : "hover:bg-bg-hover"
                      )}
                    >
                      <span className={cn("min-w-0 flex-1 truncate text-sm", on ? "text-accent" : "text-text")}>{f.label}</span>
                      <span className="shrink-0 text-[11px] text-text-dim">{KIND_LABEL[f.kind]}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </Dialog>,
    document.body
  );
}
