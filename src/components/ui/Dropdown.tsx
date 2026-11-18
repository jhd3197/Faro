import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { Menu, type MenuOption } from "./Menu";
import { Popover } from "./Popover";

interface Props<T> {
  value: T;
  options: MenuOption<T>[];
  onChange: (value: T) => void;
  /** Add a search box (long lists: themes, fonts, servers). */
  searchable?: boolean;
  searchPlaceholder?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Menu as wide as the button. Default on. */
  matchWidth?: boolean;
  "aria-label"?: string;
  className?: string;
  /** Rendered before the label inside the button. */
  icon?: ReactNode;
}

// A select built on Menu + Popover: the button shows the choice, the menu
// opens on it, and closing puts focus back on the button.
export function Dropdown<T>({
  value,
  options,
  onChange,
  searchable,
  searchPlaceholder,
  placeholder = "Choose…",
  disabled,
  matchWidth = true,
  className,
  icon,
  ...aria
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const current = options.find((o) => Object.is(o.value, value));

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={aria["aria-label"]}
        data-dropdown=""
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          "flex min-w-[8rem] items-center gap-2 rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-left text-sm outline-none hover:border-text-dim focus-visible:border-accent disabled:opacity-50",
          open && "border-accent",
          className
        )}
      >
        {icon}
        <span className={cn("min-w-0 flex-1 truncate", !current && "text-text-dim")}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown size={13} className="shrink-0 text-text-dim" />
      </button>
      <Popover
        open={open}
        anchorRef={buttonRef}
        matchWidth={matchWidth}
        onClose={(reason) => close(reason === "escape")}
        id={listId}
        maxHeight={288}
        className="flex flex-col"
      >
        <Menu
          options={options}
          value={value}
          searchable={searchable}
          searchPlaceholder={searchPlaceholder}
          aria-label={aria["aria-label"]}
          onClose={() => close()}
          onSelect={(v) => {
            onChange(v);
            close();
          }}
        />
      </Popover>
    </>
  );
}
