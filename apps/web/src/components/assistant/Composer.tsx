import { ArrowUp, Square } from "lucide-react";
import { type KeyboardEvent, type RefObject, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The message box. Enter sends, Shift+Enter adds a line, and while the assistant works the send button
 * becomes Stop. It grows with its content (field-sizing) up to a few lines, then scrolls.
 */
export function Composer({
  busy,
  onSend,
  onStop,
  inputRef,
  placeholder,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
}) {
  const [text, setText] = useState("");
  const canSend = text.trim().length > 0 && !busy;

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <form
      className="border-t bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex items-end gap-2 rounded-2xl border bg-background py-1.5 pr-1.5 pl-3.5 transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          maxLength={2000}
          placeholder={placeholder}
          aria-label="Message the assistant"
          className="field-sizing-content max-h-40 min-h-7 flex-1 resize-none bg-transparent py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground"
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-transform active:scale-95"
          >
            <Square className="size-3 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send"
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-all active:scale-95",
              !canSend && "scale-90 opacity-25",
            )}
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
      <p className="mt-1.5 hidden px-2 text-[11px] text-muted-foreground sm:block">
        Enter to send · Shift+Enter for a new line
      </p>
    </form>
  );
}
