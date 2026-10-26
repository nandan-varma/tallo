import type { Resume } from "@tallo/contracts";
import { FileText, Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { messageOf, requestJson } from "@/lib/client";
import { extractPdfText } from "@/lib/resume/pdf-text";
import { cn } from "@/lib/utils";

const MAX_PDF_BYTES = 10 * 1024 * 1024;

/**
 * First run: bring in a resume you already have, or start from nothing. A PDF is read in the browser and
 * only its text is sent, so the file itself never leaves the device. The assistant structures the text; the
 * person checks it in the editor next.
 */
export function ImportPanel({
  onImported,
  onBlank,
}: {
  onImported: (resume: Resume) => void;
  onBlank: () => void;
}) {
  const [text, setText] = useState("");
  const [step, setStep] = useState<"reading" | "structuring" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const busy = step !== null;

  async function structure(source: string) {
    setStep("structuring");
    setError(null);
    try {
      const { resume } = await requestJson<{ resume: Resume }>("/api/resume/import", {
        method: "POST",
        body: { text: source },
      });
      onImported(resume);
    } catch (e) {
      setError(messageOf(e));
      setStep(null);
    }
  }

  async function takeFile(file: File | undefined) {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("That isn't a PDF. Paste the text instead, or choose a PDF.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setError("That PDF is larger than 10 MB.");
      return;
    }
    setStep("reading");
    setError(null);
    try {
      const extracted = await extractPdfText(file);
      if (extracted.length < 20) {
        setError("No text found in that PDF (it may be a scan). Paste the text instead.");
        setStep(null);
        return;
      }
      await structure(extracted);
    } catch {
      setError("Couldn't read that PDF. Paste the text instead.");
      setStep(null);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-xl gap-6 px-4 py-10 sm:py-14">
      <header className="grid gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Build your resume</h1>
        <p className="text-sm text-muted-foreground">
          Start from a resume you have, and edit it here. You get a clean one-page PDF, and a copy
          tailored to each posting.
        </p>
      </header>

      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void takeFile(event.dataTransfer.files[0]);
        }}
        className={cn(
          "flex flex-col items-center gap-2 rounded-xl border border-dashed bg-card px-6 py-9 text-center transition-colors hover:bg-muted/50 disabled:opacity-60",
          over && "border-foreground bg-muted",
        )}
      >
        {busy ? (
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
        ) : (
          <Upload className="size-6 text-muted-foreground" aria-hidden />
        )}
        <span className="text-sm font-medium">
          {step === "reading"
            ? "Reading your PDF…"
            : step === "structuring"
              ? "Organizing your resume…"
              : "Choose a PDF or drop it here"}
        </span>
        <span className="text-xs text-muted-foreground">
          Read on this device. Only the text is sent.
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          void takeFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      <div className="grid gap-2">
        <label htmlFor="resume-paste" className="text-xs font-medium text-muted-foreground">
          Or paste the text
        </label>
        <Textarea
          id="resume-paste"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Paste your resume here…"
          className="max-h-64 min-h-28 text-sm"
          disabled={busy}
          maxLength={60_000}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={busy || text.trim().length < 20}
            onClick={() => structure(text)}
          >
            <FileText aria-hidden />
            Build from this text
          </Button>
        </div>
      </div>

      {error && (
        <p
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}

      <p className="text-center text-sm text-muted-foreground">
        Starting fresh?{" "}
        <button
          type="button"
          onClick={onBlank}
          disabled={busy}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Begin with a blank resume
        </button>
      </p>
    </div>
  );
}
