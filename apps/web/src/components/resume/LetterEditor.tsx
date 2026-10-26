import type { Resume, ResumeStyle } from "@tallo/contracts";
import { Check, Copy, Download, Loader2, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Posting } from "@/components/resume/AiPanel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { messageOf, requestJson } from "@/lib/client";
import { tidy } from "@/lib/resume/edit";
import { slug } from "@/lib/resume/layout";
import { wordCount } from "@/lib/resume/letter-text";
import { renderLetter } from "@/lib/resume/render";

const MAX_LETTER = 6000;

/**
 * The cover letter for one posting's copy. The assistant writes it from the resume alone; the person reads it,
 * edits it, then copies it or downloads it as a PDF. Text saves with the copy, like the resume does.
 */
export function LetterEditor({
  letter,
  posting,
  resume,
  style,
  onChange,
}: {
  letter: string;
  posting: Posting;
  resume: Resume;
  style: ResumeStyle;
  onChange: (letter: string) => void;
}) {
  // What the assistant last wrote. A letter that differs from it has been edited by the person.
  const [written, setWritten] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLetter = letter.trim().length > 0;
  const edited = hasLetter && letter !== written;

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function write() {
    // Writing over the person's own words takes a second press.
    if (edited && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setWorking(true);
    setError(null);
    try {
      const result = await requestJson<{ letter: string }>("/api/resume/cover-letter", {
        method: "POST",
        body: { jobId: posting.id, resume: tidy(resume) },
      });
      setWritten(result.letter);
      onChange(result.letter);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setWorking(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(letter);
      setCopied(true);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function download() {
    try {
      const bytes = await renderLetter(resume, style, letter);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      const filename = `${slug(resume.name) || "resume"}-${slug(posting.company)}-cover-letter.pdf`;
      const link = Object.assign(document.createElement("a"), { href: url, download: filename });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  const label = working
    ? "Writing… about 10 seconds"
    : confirming
      ? "Replace my edits?"
      : hasLetter
        ? "Write again"
        : "Write with the assistant";

  return (
    <section aria-label="Cover letter" className="grid gap-3 rounded-xl border bg-muted/40 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={write} disabled={working} className="gap-1.5">
          {working ? <Loader2 className="animate-spin" aria-hidden /> : <Wand2 aria-hidden />}
          {label}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Written from your resume only. Read it over before you send it.
      </p>

      <Textarea
        aria-label="Cover letter text"
        value={letter}
        onChange={(event) => {
          setConfirming(false);
          onChange(event.target.value);
        }}
        maxLength={MAX_LETTER}
        placeholder="Your letter appears here, or write your own."
        className="min-h-96 bg-card text-sm leading-relaxed"
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {wordCount(letter)} words · {letter.length.toLocaleString("en-US")} of{" "}
          {MAX_LETTER.toLocaleString("en-US")} characters
        </span>
        <span className="flex-1" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copy}
          disabled={!hasLetter}
          className="gap-1.5"
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={download}
          disabled={!hasLetter}
          className="gap-1.5"
        >
          <Download aria-hidden />
          Download PDF
        </Button>
      </div>

      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
