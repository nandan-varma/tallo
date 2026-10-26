import type { SearchResult } from "@tallo/search-ai";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { AskResults } from "@/components/AskResults";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  AskError,
  buildAskBody,
  formatElapsed,
  MAX_PROFILE_CHARS,
  MAX_QUERY_CHARS,
  PROFILE_STORAGE_KEY,
  readStoredProfile,
  runAsk,
} from "@/lib/ask";

type Status = "idle" | "running" | "done" | "error" | "cancelled";

/**
 * The one client island on the Ask page. The profile lives in this browser's localStorage and
 * leaves it only inside a search request. Everything else (query, result, trace) is in memory.
 */
export function AskPanel() {
  const [query, setQuery] = useState("");
  const [profile, setProfile] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [roundTrip, setRoundTrip] = useState<number | undefined>();
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      setProfile(readStoredProfile(localStorage.getItem(PROFILE_STORAGE_KEY)));
    } catch {
      // Storage can be blocked (private modes); the profile then lives only in this page.
    }
    return () => controllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);

  function changeProfile(value: string) {
    setProfile(value);
    try {
      if (value) localStorage.setItem(PROFILE_STORAGE_KEY, value);
      else localStorage.removeItem(PROFILE_STORAGE_KEY);
    } catch {
      // Quota or blocked storage: the text stays in the page, it just will not persist.
    }
  }

  async function search(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = buildAskBody(query, profile);
    if (!body.query || status === "running") return;

    const controller = new AbortController();
    controllerRef.current = controller;
    const begin = Date.now();
    setStatus("running");
    setStartedAt(begin);
    setNow(begin);
    setResult(null);
    setMessage(null);
    try {
      const next = await runAsk(body, { signal: controller.signal });
      setResult(next);
      setStatus("done");
    } catch (error) {
      const cancelled = error instanceof AskError && error.kind === "cancelled";
      setStatus(cancelled ? "cancelled" : "error");
      setMessage(error instanceof Error ? error.message : "The search failed.");
    } finally {
      controllerRef.current = null;
      setRoundTrip((Date.now() - begin) / 1000);
    }
  }

  const running = status === "running";
  const elapsed = running ? formatElapsed((now - startedAt) / 1000) : null;

  return (
    <div className="grid gap-6">
      <form onSubmit={search} aria-label="AI job search" className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="ask-query">Question</Label>
          <div className="flex gap-2">
            <Input
              id="ask-query"
              name="query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              maxLength={MAX_QUERY_CHARS}
              placeholder="Describe the roles you want"
              autoComplete="off"
              className="font-medium sm:text-base"
              required
            />
            {running ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => controllerRef.current?.abort()}
              >
                Cancel
              </Button>
            ) : (
              <Button type="submit" disabled={!query.trim()}>
                Search
              </Button>
            )}
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="ask-profile">Profile (markdown)</Label>
          <Textarea
            id="ask-profile"
            name="profile"
            value={profile}
            onChange={(event) => changeProfile(event.target.value)}
            maxLength={MAX_PROFILE_CHARS}
            rows={8}
            placeholder="Skills, years by area, titles, preferences, deal-breakers"
            aria-describedby="ask-profile-note"
          />
          <p id="ask-profile-note" className="text-xs text-muted-foreground">
            Saved in this browser only. It is sent with each search and never stored on the server.
          </p>
        </div>
      </form>

      {running && (
        <div role="status" aria-live="polite" className="grid gap-2 text-sm text-muted-foreground">
          <p>
            Searching… <span className="tabular-nums">{elapsed}</span> elapsed. Deep reads can take
            a few minutes.
          </p>
          <Skeleton className="h-1 w-full" />
        </div>
      )}

      {status === "error" && message && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 px-3 py-2 text-sm text-destructive"
        >
          {message}
        </p>
      )}

      {status === "cancelled" && (
        <p role="status" className="text-sm text-muted-foreground">
          Search cancelled.
        </p>
      )}

      {result && <AskResults result={result} elapsedSeconds={roundTrip} />}
    </div>
  );
}
