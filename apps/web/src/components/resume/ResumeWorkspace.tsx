import type { ResumeRecord, ResumeStyle, ResumeSummary } from "@tallo/contracts";
import { isEmptyResume } from "@tallo/resume";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  FilePlus2,
  Loader2,
  Trash2,
  Undo2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { AiPanel, type Posting } from "@/components/resume/AiPanel";
import { Editor, SECTIONS } from "@/components/resume/Editor";
import { ImportPanel } from "@/components/resume/ImportPanel";
import { PdfPages, usePreview } from "@/components/resume/PdfPreview";
import { type SaveState, useResumeDoc } from "@/components/resume/useResumeDoc";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { messageOf, requestJson } from "@/lib/client";
import { cn } from "@/lib/utils";

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function SaveStatus({
  state,
  savedAt,
  error,
  onRetry,
}: {
  state: SaveState;
  savedAt: number | null;
  error: string | null;
  onRetry: () => void;
}) {
  if (state === "error") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
        <AlertTriangle className="size-3.5" aria-hidden />
        <span className="hidden sm:inline">{error ?? "Couldn't save."}</span>
        <button
          type="button"
          onClick={onRetry}
          className="font-medium underline underline-offset-2"
        >
          Retry
        </button>
      </span>
    );
  }
  const saving = state !== "saved";
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
      {saving ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <Check className="size-3.5" aria-hidden />
      )}
      {saving
        ? "Saving…"
        : savedAt
          ? `Saved ${new Date(savedAt * 1000).toLocaleTimeString("en-US", { timeStyle: "short" })}`
          : "Not saved yet"}
    </span>
  );
}

function Switcher({
  copies,
  posting,
  onDelete,
}: {
  copies: ResumeSummary[];
  posting: Posting | null;
  onDelete: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const tailored = copies.filter((copy) => copy.jobId !== null);
  const label = posting ? `${posting.company}` : "Base resume";
  return (
    <DropdownMenu onOpenChange={() => setConfirm(false)}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="max-w-[16rem] gap-1.5">
          <span className="truncate">{label}</span>
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80" align="start">
        <DropdownMenuLabel>Resumes</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <a href="/resume">Base resume</a>
        </DropdownMenuItem>
        {tailored.length > 0 && <DropdownMenuSeparator />}
        {tailored.map((copy) => (
          <DropdownMenuItem key={copy.jobId} asChild>
            <a href={`/resume/${copy.jobId}`} className="flex-col items-start gap-0">
              <span className="w-full truncate">{copy.title ?? `Posting ${copy.jobId}`}</span>
              <span className="w-full truncate text-xs text-muted-foreground">
                {copy.company ?? "No longer listed"}
              </span>
            </a>
          </DropdownMenuItem>
        ))}
        {posting && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={(event) => {
                if (confirm) return onDelete();
                event.preventDefault();
                setConfirm(true);
              }}
            >
              <Trash2 aria-hidden />
              {confirm ? "Press again to delete this copy" : "Delete this copy"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The resume workspace: editor on the left, the PDF as it will print on the right (tabs on a phone). The
 * words are saved as you type; the PDF is drawn here in the browser, so what you see is the file you download.
 */
export function ResumeWorkspace({
  initial,
  base,
  posting,
  copies,
  profileText,
  autoTailor,
}: {
  initial: ResumeRecord | null;
  /** The base resume, to start a tailored copy from. */
  base: ResumeRecord | null;
  posting: Posting | null;
  copies: ResumeSummary[];
  profileText: string;
  autoTailor: boolean;
}) {
  const jobId = posting?.id ?? null;
  // A tailored copy that doesn't exist yet starts as a copy of the base resume.
  const seed = initial ?? (posting ? base : null);
  const {
    doc,
    state,
    savedAt,
    error,
    review,
    dismissReview,
    edit,
    replace,
    applyAi,
    undoAi,
    retry,
  } = useResumeDoc({ jobId, initial: seed });
  const [started, setStarted] = useState(seed !== null);
  const [tab, setTab] = useState("edit");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const empty = useMemo(() => isEmptyResume(doc.resume), [doc.resume]);
  const preview = usePreview(doc, !empty);
  const style = doc.style;
  const setStyle = (patch: Partial<ResumeStyle>) =>
    edit((d) => ({ ...d, style: { ...d.style, ...patch } }));

  if (empty && !started) {
    return (
      <ImportPanel
        profileText={profileText}
        onBlank={() => setStarted(true)}
        onImported={(resume) => {
          replace({ ...doc, resume });
          setStarted(true);
        }}
      />
    );
  }

  const rendered = preview.rendered;
  const overBudget = rendered !== null && !rendered.fits;
  const filename = `${slug(doc.resume.name) || "resume"}${posting ? `-${slug(posting.company)}` : ""}.pdf`;

  function download() {
    if (!rendered) return;
    const url = URL.createObjectURL(
      new Blob([rendered.pdf as BlobPart], { type: "application/pdf" }),
    );
    const link = Object.assign(document.createElement("a"), { href: url, download: filename });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function remove() {
    try {
      await requestJson(`/api/resume?job=${jobId}`, { method: "DELETE" });
      location.assign("/resume");
    } catch (e) {
      setDeleteError(messageOf(e));
    }
  }

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col max-sm:h-[calc(100dvh-3.25rem)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b bg-card px-3 sm:px-5">
        <Switcher copies={copies} posting={posting} onDelete={remove} />
        <SaveStatus state={state} savedAt={savedAt} error={error} onRetry={retry} />
        <span className="flex-1" />
        {posting && (
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <a href={`/jobs/${posting.id}`} target="_blank" rel="noopener noreferrer">
              View posting
            </a>
          </Button>
        )}
        <Button type="button" size="sm" onClick={download} disabled={!rendered} className="gap-1.5">
          <Download aria-hidden />
          <span className="max-sm:sr-only">Download PDF</span>
        </Button>
      </div>
      {deleteError && (
        <p className="border-b bg-destructive/5 px-5 py-2 text-xs text-destructive" role="alert">
          {deleteError}
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
        <TabsList className="mx-3 mt-2 mb-2 w-[calc(100%-1.5rem)] lg:hidden">
          <TabsTrigger value="edit">Edit</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>

        <div className="grid min-h-0 flex-1 lg:grid-cols-2">
          <div
            className={cn(
              "min-h-0 overflow-y-auto overscroll-contain lg:border-r",
              tab === "preview" && "max-lg:hidden",
            )}
          >
            <nav
              aria-label="Resume sections"
              className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b bg-background/90 px-3 py-2 backdrop-blur sm:px-5"
            >
              {SECTIONS.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  onClick={() =>
                    document
                      .getElementById(section.id)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                  className="shrink-0 rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {section.label}
                </button>
              ))}
            </nav>

            <div className="mx-auto grid max-w-2xl gap-7 px-3 py-5 sm:px-5">
              {posting && !initial && (
                <p className="rounded-xl border bg-muted/40 px-3.5 py-3 text-sm text-muted-foreground">
                  This is a new copy for{" "}
                  <strong className="text-foreground">{posting.title}</strong> at {posting.company},
                  started from your base resume. It is saved when you change something.
                </p>
              )}
              <AiPanel
                resume={doc.resume}
                posting={posting}
                autoTailor={autoTailor && !initial}
                onApply={(result, kind) => {
                  applyAi(result.resume, result.changes, kind);
                  setTab("edit");
                }}
              />
              {review && (
                <section
                  aria-label="What the assistant changed"
                  className="grid gap-2 rounded-xl border border-emerald-600/25 bg-emerald-50/60 p-3.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold">What changed</h2>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={undoAi}
                        className="gap-1"
                      >
                        <Undo2 aria-hidden />
                        Undo
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={dismissReview}>
                        Keep
                      </Button>
                    </div>
                  </div>
                  {review.changes.length > 0 ? (
                    <ul className="grid list-disc gap-1 pl-4 text-[13px] leading-snug">
                      {review.changes.map((change) => (
                        <li key={change}>{change}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[13px] text-muted-foreground">Updated.</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Read it over: the assistant rewords and reorders, and never adds employers,
                    dates, skills or numbers you didn’t have.
                  </p>
                </section>
              )}
              <Editor
                resume={doc.resume}
                style={style}
                onResume={(change) => edit((d) => ({ ...d, resume: change(d.resume) }))}
                onStyle={setStyle}
              />
            </div>
          </div>

          <div
            className={cn(
              "min-h-0 overflow-y-auto overscroll-contain bg-muted/50",
              tab === "edit" && "max-lg:hidden",
            )}
          >
            <div className="sticky top-0 z-10 flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background/90 px-3 py-2 text-xs backdrop-blur sm:px-5">
              {rendered && (
                <span
                  className={cn(
                    "flex items-center gap-1.5 font-medium",
                    overBudget ? "text-amber-700" : "text-emerald-700",
                  )}
                >
                  {overBudget ? (
                    <AlertTriangle className="size-3.5" aria-hidden />
                  ) : (
                    <Check className="size-3.5" aria-hidden />
                  )}
                  {overBudget
                    ? `${rendered.pages} pages, over your ${style.pages}-page limit`
                    : `${rendered.pages} ${rendered.pages === 1 ? "page" : "pages"}`}
                </span>
              )}
              {overBudget && style.pages === 1 && (
                <button
                  type="button"
                  onClick={() => setStyle({ pages: 2 })}
                  className="underline underline-offset-2"
                >
                  Allow 2 pages
                </button>
              )}
              {overBudget && style.pages === 2 && (
                <span className="text-muted-foreground">Trim something to fit.</span>
              )}
              {rendered && !overBudget && rendered.density.font < 10 && (
                <span className="text-muted-foreground">
                  Set small to fit ({rendered.density.font} pt).
                </span>
              )}
              <span className="flex-1" />
              {preview.busy && (
                <span className="flex items-center gap-1.5 text-muted-foreground" role="status">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  Updating
                </span>
              )}
              {preview.error && (
                <span className="text-destructive" role="alert">
                  Preview failed: {preview.error}
                </span>
              )}
            </div>
            <div className="mx-auto w-full max-w-[52rem] p-3 sm:p-5">
              {empty ? (
                <div className="grid place-items-center gap-2 py-24 text-center text-sm text-muted-foreground">
                  <FilePlus2 className="size-6" aria-hidden />
                  Your resume appears here as you type.
                </div>
              ) : (
                <PdfPages pdf={rendered?.pdf ?? null} />
              )}
            </div>
          </div>
        </div>
      </Tabs>
    </div>
  );
}
