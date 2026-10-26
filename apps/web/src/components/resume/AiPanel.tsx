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
}

const IDEAS = [
  "Tighten the summary",
  "Start every bullet with a strong verb",
  "Make the bullets shorter",
  "Remove the oldest role",
];

/**
 * Two ways to have the assistant change the resume: tailor it to the posting this copy is for, or say what to
 * change. Either returns a whole resume plus a list of what changed; the workspace puts it in place and offers
 * undo, so nothing here needs a confirmation step.
 */
export function AiPanel({
  resume,
  posting,
  autoTailor,
  onApply,
}: {
  resume: Resume;
  posting: Posting | null;
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
  const edit = (text: string) => run("edit", { instruction: text, resume: tidy(resume) });

  // Runs once, on arrival: the button on a posting asks for a tailored copy straight away.
  useEffect(() => {
    if (autoTailor && posting && !started.current) {
      started.current = true;
      void tailor();
    }
  }, []);

  const busy = working !== null;
  return (
    <section
      aria-label="Assistant"
      className="grid gap-3 rounded-xl border bg-gradient-to-b from-muted/60 to-card p-3.5"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold tracking-tight">Assistant</h2>
      </div>

      {posting ? (
        <Button type="button" onClick={tailor} disabled={busy} className="h-9 justify-start gap-2">
          {working === "tailor" ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Wand2 aria-hidden />
          )}
          <span className="truncate">
            {working === "tailor"
              ? "Tailoring…"
              : `Tailor to ${posting.title} at ${posting.company}`}
          </span>
        </Button>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          To tailor this resume to a posting, open the posting and choose “Tailor resume”. Each
          posting gets its own copy.
        </p>
      )}

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (instruction.trim().length >= 3) void edit(instruction.trim());
        }}
      >
        <Input
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="Ask for a change…"
          aria-label="What should change?"
          maxLength={1000}
          disabled={busy}
        />
        <Button type="submit" variant="secondary" disabled={busy || instruction.trim().length < 3}>
          {working === "edit" ? <Loader2 className="animate-spin" aria-hidden /> : "Apply"}
        </Button>
      </form>

      <div className="flex flex-wrap gap-1.5">
        {IDEAS.map((idea) => (
          <button
            key={idea}
            type="button"
            disabled={busy}
            onClick={() => void edit(idea)}
            className="rounded-full border bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {idea}
          </button>
        ))}
      </div>

      {busy && (
        <p className="text-xs text-muted-foreground" role="status">
          This takes about 10 to 20 seconds. You can keep reading the preview.
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
