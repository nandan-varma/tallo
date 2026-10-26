import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/** The assistant's mark: shown in the chat header, and as the floating bubble when the chat is tucked away. */
export function Orb({ className, busy = false }: { className?: string; busy?: boolean }) {
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-sm",
        className,
      )}
    >
      <Sparkles className="size-[45%]" aria-hidden />
      {busy && (
        <span className="absolute -top-0.5 -right-0.5 flex size-3">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex size-3 rounded-full border-2 border-background bg-emerald-500" />
        </span>
      )}
    </span>
  );
}
