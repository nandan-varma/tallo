import { useChat } from "@ai-sdk/react";
import type { SavedSearch } from "@tallo/contracts";
import type { JobAgentMessage } from "@tallo/search-ai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "@/components/assistant/ChatPanel";
import { JobList, type ListView } from "@/components/assistant/JobList";
import { JobPage } from "@/components/assistant/JobPage";
import { Orb } from "@/components/assistant/Orb";
import { useSearches } from "@/components/assistant/searches";
import { collectHits, currentResults, currentSearch, notesById } from "@/lib/assistant";
import { cn } from "@/lib/utils";

const transport = new DefaultChatTransport({ api: "/api/chat" });
const STORAGE_KEY = "tallo.chat.v1";

/** The conversation survives navigating to Resume and back. It lives in this tab only; the server keeps nothing. */
function restore(): JobAgentMessage[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? (value as JobAgentMessage[]) : [];
  } catch {
    return [];
  }
}

/**
 * Three columns: chat, results, posting. A data attribute on the container picks which are open and CSS
 * transitions the change, so desktop and mobile are one tree. Opening a posting tucks the chat into a bubble
 * and slides the list left, so you can click another job while you read; the bubble or Esc brings the chat back.
 * Everything beside the chat derives from the conversation: the message stream is the one source of truth.
 */
const pane = {
  chat: "min-w-0 shrink-0 basis-(--chat-w) overflow-hidden border-r bg-card transition-[flex-basis] duration-300 ease-out lg:group-data-[detail=true]/layout:basis-0 lg:group-data-[detail=true]/layout:border-r-0 max-lg:min-h-0 max-lg:flex-1 max-lg:basis-auto max-lg:border-r-0 max-lg:group-data-[tab=results]/layout:hidden",
  list: "min-w-0 flex-[1_1_0px] overflow-hidden bg-background transition-[flex] duration-300 ease-out lg:group-data-[detail=true]/layout:flex-[0_0_400px] lg:group-data-[detail=true]/layout:border-r max-lg:min-h-0 max-lg:group-data-[tab=chat]/layout:hidden",
  posting:
    "min-w-0 flex-[0_0_0px] overflow-hidden bg-background transition-[flex,opacity,translate] duration-300 ease-out lg:group-data-[detail=true]/layout:flex-[1_1_0px] max-lg:fixed max-lg:inset-x-0 max-lg:top-14 max-lg:bottom-0 max-lg:z-30 max-lg:flex-none max-lg:translate-y-6 max-lg:opacity-0 max-sm:top-[3.25rem] max-lg:group-data-[detail=true]/layout:translate-y-0 max-lg:group-data-[detail=true]/layout:opacity-100",
} as const;

function Workspace({ hasResume, initialJob }: { hasResume: boolean; initialJob: string | null }) {
  const { messages, sendMessage, status, error, stop, regenerate, setMessages } =
    useChat<JobAgentMessage>({
      transport,
      messages: useMemo(restore, []),
    });
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [openId, setOpenId] = useState<string | null>(initialJob);
  // Kept after the posting closes, so its column can finish sliding shut with the content still in it.
  const [shownId, setShownId] = useState<string | null>(initialJob);
  const [tab, setTab] = useState<"chat" | "results">("chat");
  const [view, setView] = useState<ListView>("results");

  const working = status === "submitted" || status === "streaming";
  const hits = useMemo(() => collectHits(messages), [messages]);
  const reviewed = useMemo(() => currentResults(messages), [messages]);
  const chatSpec = useMemo(() => currentSearch(messages), [messages]);
  // A saved search the person opened stands in for the chat's search until they ask for something new.
  const [pinned, setPinned] = useState<SavedSearch | null>(null);
  const spec = pinned?.spec ?? chatSpec;
  const searches = useSearches();
  const notes = useMemo(() => notesById(messages), [messages]);

  useEffect(() => {
    if (status !== "ready" && status !== "error") return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // Storage full or blocked: the chat still works for this visit.
    }
  }, [messages, status]);

  // The open posting is in the address (`/?job=123`), so it can be shared, reloaded and linked from the resume.
  useEffect(() => {
    const url = new URL(location.href);
    if (openId) url.searchParams.set("job", openId);
    else url.searchParams.delete("job");
    if (url.href !== location.href) history.replaceState(history.state, "", url);
  }, [openId]);

  const open = useCallback((id: string) => {
    setOpenId(id);
    setShownId(id);
  }, []);
  const close = useCallback(() => setOpenId(null), []);
  const backToChat = useCallback(() => {
    setOpenId(null);
    setTab("chat");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const send = useCallback(
    (text: string) => {
      setPinned(null);
      setView("results");
      setOpenId(null);
      setTab("chat");
      void sendMessage({ text });
    },
    [sendMessage],
  );

  const runSaved = useCallback(
    (search: SavedSearch) => {
      setPinned(search);
      setView("results");
      setOpenId(null);
      setTab("results");
      searches.markSeen(search.id);
    },
    [searches.markSeen],
  );

  const reset = useCallback(() => {
    void stop();
    setMessages([]);
    setPinned(null);
    setOpenId(null);
    setShownId(null);
    setView("results");
    setTab("chat");
    sessionStorage.removeItem(STORAGE_KEY);
    inputRef.current?.focus();
  }, [stop, setMessages]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && openId) close();
      const typing = (event.target as HTMLElement | null)?.closest(
        "input, textarea, [contenteditable]",
      );
      if (event.key === "/" && !typing && !openId) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [openId, close]);

  const detail = openId !== null;
  return (
    <div
      data-detail={detail}
      data-tab={tab}
      className="group/layout relative flex h-[calc(100dvh-3.5rem)] overflow-hidden [--chat-w:clamp(360px,34vw,480px)] max-sm:h-[calc(100dvh-3.25rem)] max-lg:flex-col"
    >
      <div
        role="tablist"
        aria-label="View"
        className="flex shrink-0 border-b bg-card p-1.5 text-[13px] lg:hidden"
      >
        {(["chat", "results"] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={cn(
              "flex-1 rounded-lg py-1.5 font-medium transition-colors",
              tab === name ? "bg-muted text-foreground" : "text-muted-foreground",
            )}
          >
            {name === "chat" ? "Chat" : "Results"}
          </button>
        ))}
      </div>

      <section aria-label="Chat" inert={detail} className={pane.chat}>
        <div className="h-full w-(--chat-w) max-lg:w-full">
          <ChatPanel
            messages={messages}
            hits={hits}
            status={status}
            error={error}
            hasResume={hasResume}
            spec={spec}
            saved={searches.searches}
            onRunSaved={runSaved}
            onSaveSearch={searches.save}
            onRemoveSearch={searches.remove}
            inputRef={inputRef}
            onSend={send}
            onStop={() => void stop()}
            onRetry={() => void regenerate()}
            onReset={reset}
            onShowResults={() => setTab("results")}
          />
        </div>
      </section>

      <section aria-label="Results" className={pane.list}>
        <JobList
          spec={spec}
          reviewed={pinned ? null : reviewed}
          discovery={pinned !== null}
          title={pinned?.name}
          notes={notes}
          view={view}
          onView={setView}
          openId={openId}
          working={working}
          started={messages.length > 0}
          onOpen={open}
        />
      </section>

      <section aria-label="Posting" inert={!detail} className={pane.posting}>
        <div className="h-full w-[calc(100vw-400px)] max-lg:w-full">
          {shownId && (
            <JobPage key={shownId} id={shownId} note={notes.get(shownId)} onClose={close} />
          )}
        </div>
      </section>

      {detail && (
        <button
          type="button"
          onClick={backToChat}
          aria-label="Open the assistant"
          className="fade-in zoom-in-50 fixed right-5 bottom-5 z-40 animate-in rounded-full shadow-lg ring-1 ring-black/5 transition-transform duration-300 hover:scale-105 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none active:scale-95 lg:right-auto lg:left-5"
        >
          <Orb className="size-14" busy={working} />
        </button>
      )}
    </div>
  );
}

export function Assistant({
  hasResume,
  initialJob = null,
}: {
  hasResume: boolean;
  /** A posting to open on arrival, from `?job=`. */
  initialJob?: string | null;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 60_000 } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <Workspace hasResume={hasResume} initialJob={initialJob} />
    </QueryClientProvider>
  );
}
