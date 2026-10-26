import type { ProfileRecord } from "@tallo/contracts";
import { Check, Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const RESUME_MAX = 60_000;
const PROFILE_MAX = 30_000;

async function failure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // Not JSON: fall through to the generic message.
  }
  return response.status === 503
    ? "The assistant isn't set up on the server yet."
    : "Something went wrong. Try again.";
}

function Section({
  step,
  title,
  hint,
  children,
}: {
  step: number;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
          {step}
        </span>
        <div>
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <p className="text-[13px] text-muted-foreground">{hint}</p>
        </div>
      </div>
      <div className="pl-9">{children}</div>
    </section>
  );
}

/**
 * Your resume in, a profile the assistant reads out. The model writes the first draft; you edit it. The
 * resume and the profile are saved together, and are the only things the app keeps about you.
 */
export function ProfileEditor({ initial }: { initial: ProfileRecord | null }) {
  const [resume, setResume] = useState(initial?.resume ?? "");
  const [profile, setProfile] = useState(initial?.profile ?? "");
  const [saved, setSaved] = useState({
    resume: initial?.resume ?? "",
    profile: initial?.profile ?? "",
  });
  const [savedAt, setSavedAt] = useState(initial?.updatedAt ?? null);
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = resume !== saved.resume || profile !== saved.profile;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function build() {
    // Replacing text the person has already edited needs a second, deliberate click.
    if (profile.trim() && profile !== saved.profile && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    setConfirmReplace(false);
    setBuilding(true);
    setError(null);
    try {
      const response = await fetch("/api/profile/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resume }),
      });
      if (!response.ok) throw new Error(await failure(response));
      setProfile(((await response.json()) as { profile: string }).profile);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBuilding(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resume, profile }),
      });
      if (!response.ok) throw new Error(await failure(response));
      const record = (await response.json()) as ProfileRecord;
      setSaved({ resume: record.resume, profile: record.profile });
      setSavedAt(record.updatedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const canBuild = resume.trim().length >= 20 && !building;
  return (
    <div className="mx-auto grid w-full max-w-2xl gap-9 px-4 py-9 sm:px-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Your profile</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          The assistant reads this before every search to rank matches against your experience. Your
          chats are never stored.
        </p>
      </header>

      <Section
        step={1}
        title="Paste your resume"
        hint="Plain text or markdown. Keep the dates and numbers."
      >
        <Textarea
          value={resume}
          onChange={(event) => {
            setResume(event.target.value);
            setConfirmReplace(false);
          }}
          maxLength={RESUME_MAX}
          placeholder="Paste your resume here…"
          className="max-h-[28rem] min-h-44 text-sm leading-relaxed"
          aria-label="Resume"
        />
        <div className="mt-3 flex items-center gap-3">
          <Button type="button" onClick={build} disabled={!canBuild} className="gap-1.5">
            {building ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
            {building
              ? "Reading your resume…"
              : confirmReplace
                ? "Replace my edits"
                : "Build my profile"}
          </Button>
          {confirmReplace && (
            <span className="text-[13px] text-muted-foreground">
              This replaces the profile you edited below.
            </span>
          )}
        </div>
      </Section>

      <Section
        step={2}
        title="Check and edit"
        hint="Fix anything wrong, add what the resume leaves out: target roles, pay, location, deal-breakers."
      >
        <Textarea
          value={profile}
          onChange={(event) => setProfile(event.target.value)}
          maxLength={PROFILE_MAX}
          placeholder="Your profile appears here after you build it. You can also write it yourself."
          className="max-h-[36rem] min-h-64 font-mono text-[13px] leading-relaxed"
          aria-label="Profile"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="button" onClick={save} disabled={!dirty || saving} className="gap-1.5">
            {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
            {saving ? "Saving…" : "Save"}
          </Button>
          <span
            className={cn("text-[13px]", dirty ? "text-amber-700" : "text-muted-foreground")}
            role="status"
          >
            {dirty
              ? "Unsaved changes"
              : savedAt
                ? `Saved ${new Date(savedAt * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`
                : "Nothing saved yet"}
          </span>
        </div>
      </Section>

      {error && (
        <p
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}
