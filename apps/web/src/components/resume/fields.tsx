import { ArrowDown, ArrowUp, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={cn("grid gap-1.5", className)}>
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  className,
  ...props
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
} & Omit<React.ComponentProps<"input">, "onChange" | "value">) {
  return (
    <Field label={label} className={className}>
      {(id) => (
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} {...props} />
      )}
    </Field>
  );
}

export function AreaField({
  label,
  value,
  onChange,
  className,
  ...props
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
} & Omit<React.ComponentProps<"textarea">, "onChange" | "value">) {
  return (
    <Field label={label} className={className}>
      {(id) => (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-9 text-sm leading-relaxed"
          {...props}
        />
      )}
    </Field>
  );
}

/**
 * A named block of the editor, folded away with its header. A native disclosure: keyboard and screen-reader
 * behavior come with the element. `summary` is the one-line state of the block when it is closed ("3 roles").
 */
export function Section({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group/section rounded-xl border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-3 select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open/section:rotate-90"
          aria-hidden
        />
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {summary && <span className="truncate text-xs text-muted-foreground">{summary}</span>}
      </summary>
      <div className="grid gap-3 border-t px-3.5 py-3.5">{children}</div>
    </details>
  );
}

export function AddButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      className="w-fit gap-1.5 border-dashed"
    >
      <Plus aria-hidden />
      {children}
    </Button>
  );
}

/**
 * One entry (a job, a school, a project): a header that folds the body away and moves or removes the entry,
 * then the body. Removing needs a second press, so a stray tap never loses a whole role.
 */
export function EntryCard({
  title,
  subtitle,
  index,
  count,
  defaultOpen,
  onMove,
  onRemove,
  children,
}: {
  title: string;
  subtitle?: string;
  index: number;
  count: number;
  defaultOpen: boolean;
  onMove: (to: number) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [confirm, setConfirm] = useState(false);
  const bodyId = useId();

  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(timer);
  }, [confirm]);

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-muted/60"
        >
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{title || "Untitled"}</span>
            {subtitle && (
              <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
            )}
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={index === 0}
          onClick={() => onMove(index - 1)}
          aria-label={`Move ${title || "entry"} up`}
        >
          <ArrowUp />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={index === count - 1}
          onClick={() => onMove(index + 1)}
          aria-label={`Move ${title || "entry"} down`}
        >
          <ArrowDown />
        </Button>
        {confirm ? (
          <Button type="button" variant="destructive" size="sm" onClick={onRemove}>
            Remove?
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setConfirm(true)}
            aria-label={`Remove ${title || "entry"}`}
          >
            <Trash2 />
          </Button>
        )}
      </div>
      {open && (
        <div id={bodyId} className="grid gap-3 border-t px-3.5 py-3.5">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * A list of one-line statements, one text box each. Enter adds a statement below, Backspace in an empty one
 * removes it, so a person can write a whole role without leaving the keyboard.
 */
export function BulletList({
  label,
  items,
  onChange,
  placeholder,
  addLabel = "Add bullet",
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  addLabel?: string;
}) {
  const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const focus = useRef<number | null>(null);

  useEffect(() => {
    if (focus.current !== null) refs.current[focus.current]?.focus();
    focus.current = null;
  });

  const set = (index: number, value: string) =>
    onChange(items.map((item, i) => (i === index ? value : item)));
  const insertAfter = (index: number) => {
    focus.current = index + 1;
    onChange([...items.slice(0, index + 1), "", ...items.slice(index + 1)]);
  };

  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {items.map((item, index) => (
        <div
          // Bullets have no identity beyond their place in the list.
          key={index}
          className="group flex items-start gap-1.5"
        >
          <span className="mt-2 text-muted-foreground" aria-hidden>
            •
          </span>
          <Textarea
            ref={(node) => {
              refs.current[index] = node;
            }}
            value={item}
            rows={1}
            placeholder={placeholder}
            aria-label={`${label} ${index + 1}`}
            className="min-h-8 flex-1 py-1.5 text-sm leading-snug"
            onChange={(e) => set(index, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                insertAfter(index);
              } else if (e.key === "Backspace" && item === "" && items.length > 1) {
                e.preventDefault();
                focus.current = Math.max(0, index - 1);
                onChange(items.filter((_, i) => i !== index));
              }
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="mt-0.5 text-muted-foreground"
            onClick={() => onChange(items.filter((_, i) => i !== index))}
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit gap-1.5 text-muted-foreground"
        onClick={() => insertAfter(items.length - 1)}
      >
        <Plus aria-hidden />
        {addLabel}
      </Button>
    </div>
  );
}
