import type { Resume, ResumeEdit } from "@tallo/contracts";
import { Loader2, Sparkles, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { messageOf, requestJson } from "@/lib/client";
import { tidy } from "@/lib/resume/edit";

export interface Posting {
  id: number;
  title: string;
  company: string;
  /** Where to apply; null when the posting has no address. */
  applyUrl: string | null;
}

/**
 * The assistant for one resume. A copy for a posting can be tailored to it; any resume can be changed by an
 * instruction. Either returns a whole resume and a list of what changed; the workspace puts it in place and
 * offers undo, so there is no confirmation step here.
 */
export function AiPanel({
  resume,
  posting,
  fresh,
  autoTailor,
  onApply,
}: {
  resume: Resume;
  posting: Posting | null;
  /** True while this copy has not been saved yet: it is the base resume, waiting to be tailored. */
  fresh: boolean;
  /** Tailor once on arrival (the "Tailor resume" button on a posting does this). */
  autoTailor: boolean;
  onApply: (edit: ResumeEdit, kind: "tailor" | "edit") => void;
}) {
  const [working, setWorking] = useState<"tailor" | "edit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const started = useRef(false);

  async function run(kind: "tailor" | "edit", body: object) {
    setWorking(kind);
    setError(null);
    try {
      const edit = await requestJson<ResumeEdit>(`/api/resume/${kind}`, { method: "POST", body });
      onApply(edit, kind);
      if (kind === "edit") setInstruction("");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setWorking(null);
    }
  }

  const tailor = () => posting && run("tailor", { jobId: posting.id, resume: tidy(resume) });

  // Runs once, on arrival: the button on a posting asks for a tailored copy straight away.
  useEffect(() => {
    if (autoTailor && posting && !started.current) {
      started.current = true;
      void tailor();
    }
  }, []);

  const busy = working !== null;
  return (
    <section aria-label="Assistant" className="grid gap-3 rounded-xl border bg-muted/40 p-3.5">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold tracking-tight">
            {posting ? "Tailored for this role" : "Assistant"}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {posting
              ? `${posting.title} at ${posting.company}${fresh ? ", started from your base resume" : ""}`
              : "Ask for any change. Each posting gets its own tailored copy."}
          </p>
        </div>
        {posting && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={tailor}
            disabled={busy}
            className="shrink-0 gap-1.5"
          >
            {working === "tailor" ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Wand2 aria-hidden />
            )}
            {working === "tailor" ? "Tailoring…" : fresh ? "Tailor" : "Tailor again"}
          </Button>
        )}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const text = instruction.trim();
          if (text.length >= 3) void run("edit", { instruction: text, resume: tidy(resume) });
        }}
      >
        <Input
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="Ask for a change, like “shorten the summary”"
          aria-label="What should change?"
          maxLength={1000}
          disabled={busy}
          className="bg-card"
        />
        <Button type="submit" variant="secondary" disabled={busy || instruction.trim().length < 3}>
          {working === "edit" ? <Loader2 className="animate-spin" aria-hidden /> : "Apply"}
        </Button>
      </form>

      {busy && (
        <p className="text-xs text-muted-foreground" role="status">
          This takes about 10 to 20 seconds.
        </p>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
