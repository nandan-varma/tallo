import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useAbout } from "@/components/assistant/queries";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { messageOf, requestJson } from "@/lib/client";

const MAX = 30_000;

/**
 * What the assistant knows beyond the resume: roles, pay, places, deal-breakers. It lives here, where it is
 * used, and saves with one button; the resume itself has its own page and is read automatically.
 */
export function AboutSheet({ hasResume }: { hasResume: boolean }) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const about = useAbout(open);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (about.data !== undefined) {
      const current = about.data?.profile ?? "";
      setText(current);
      setSaved(current);
    }
  }, [about.data]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await requestJson("/api/profile", { method: "PUT", body: { profile: text } });
      setSaved(text);
      void client.invalidateQueries({ queryKey: ["about"] });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  }

  const dirty = text !== saved;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="About you"
          title="About you"
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <UserRound className="size-4" />
        </button>
      </SheetTrigger>
      <SheetContent className="gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b p-4 pr-12">
          <SheetTitle>About you</SheetTitle>
          <SheetDescription>
            {hasResume ? (
              <>
                I already read your{" "}
                <a href="/resume" className="underline underline-offset-2">
                  resume
                </a>
                . Add what it leaves out.
              </>
            ) : (
              <>
                <a href="/resume" className="underline underline-offset-2">
                  Add your resume
                </a>{" "}
                and I’ll rank matches against it. Then add what it leaves out.
              </>
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-4">
          <label htmlFor="about-notes" className="text-xs font-medium text-muted-foreground">
            Target roles, pay, places, deal-breakers
          </label>
          <Textarea
            id="about-notes"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={MAX}
            disabled={about.isPending}
            placeholder={
              "Staff or senior backend roles.\nRemote, or Boston hybrid.\nAt least $200k. No crypto."
            }
            className="min-h-48 text-sm leading-relaxed"
          />
          {(about.isError || error) && (
            <p className="text-xs text-destructive" role="alert">
              {error ?? "Couldn't load your notes."}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button type="button" onClick={save} disabled={!dirty || saving || about.isPending}>
              {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
              {saving ? "Saving…" : "Save"}
            </Button>
            {!dirty && saved && <span className="text-xs text-muted-foreground">Saved</span>}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
