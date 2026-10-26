import { useChat } from "@ai-sdk/react";
import type { JobAgentMessage } from "@tallo/search-ai";
import { DefaultChatTransport } from "ai";
import { MessageSquare } from "lucide-react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "@/components/assistant/ChatPanel";
import { useChatWidth, useIsDesktop, useSavedJobs } from "@/components/assistant/hooks";
import { Listing } from "@/components/assistant/Listing";
import { Orb } from "@/components/assistant/Orb";
import { Results, type ResultsView } from "@/components/assistant/Results";
import { collectHits, latestRanking, latestSearch } from "@/lib/assistant";
import { cn } from "@/lib/utils";

const transport = new DefaultChatTransport({ api: "/api/chat" });
const STORAGE_KEY = "tallo.chat.v1";
const SPRING = { type: "spring", stiffness: 420, damping: 40, mass: 0.9 } as const;

/** The conversation survives navigating to Profile and back. It lives in this tab only; the server keeps nothing. */
function restore(): JobAgentMessage[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? (value as JobAgentMessage[]) : [];
  } catch {
    return [];
  }
}

/**
 * Chat on the left, results on the right. Opening a result tucks the chat into a bubble and gives the
 * listing the room; the bubble brings the chat back. Everything on the right is derived from the
 * conversation, so there is one source of truth: the message stream.
 */
export function Assistant({ hasProfile }: { hasProfile: boolean }) {
  const { messages, sendMessage, status, error, stop, regenerate, setMessages } =
    useChat<JobAgentMessage>({
      transport,
      messages: useMemo(restore, []),
    });
  const desktop = useIsDesktop();
  const chatWidth = useChatWidth();
  const { saved, isSaved, toggle } = useSavedJobs();

  const [listingId, setListingId] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"chat" | "results">("chat");
  const [view, setView] = useState<ResultsView>("matches");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const busy = status === "submitted" || status === "streaming";
  const hits = useMemo(() => collectHits(messages), [messages]);
  const ranking = useMemo(() => latestRanking(messages, hits), [messages, hits]);
  const candidates = useMemo(() => latestSearch(messages), [messages]);
  const listingMatch = ranking.matches.find((m) => m.id === listingId);

  useEffect(() => {
    if (status !== "ready" && status !== "error") return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // Storage full or blocked: the chat still works for this visit.
    }
  }, [messages, status]);

  const send = useCallback(
    (text: string) => {
      setView("matches");
      setListingId(null);
      setMobileTab("chat");
      void sendMessage({ text });
    },
    [sendMessage],
  );

  const reset = useCallback(() => {
    void stop();
    setMessages([]);
    setListingId(null);
    setView("matches");
    setMobileTab("chat");
    sessionStorage.removeItem(STORAGE_KEY);
    inputRef.current?.focus();
  }, [stop, setMessages]);

  const openListing = useCallback((id: string) => setListingId(id), []);
  const closeListing = useCallback(() => {
    setListingId(null);
    setMobileTab(desktop ? "chat" : "results");
  }, [desktop]);
  const backToChat = useCallback(() => {
    setListingId(null);
    setMobileTab("chat");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && listingId) closeListing();
      const typing = (event.target as HTMLElement | null)?.closest(
        "input, textarea, [contenteditable]",
      );
      if (event.key === "/" && !typing && !listingId) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [listingId, closeListing]);

  const chatOpen = desktop ? listingId === null : mobileTab === "chat" && listingId === null;
  const toggleSave = useCallback(toggle, [toggle]);

  const chat = (
    <ChatPanel
      messages={messages}
      hits={hits}
      status={status}
      error={error}
      hasProfile={hasProfile}
      showOrb={chatOpen}
      inputRef={inputRef}
      onSend={send}
      onStop={() => void stop()}
      onRetry={() => void regenerate()}
      onReset={reset}
      onShowMatches={desktop ? undefined : () => setMobileTab("results")}
    />
  );

  const results = (
    <Results
      ranking={ranking}
      candidates={candidates}
      busy={busy}
      started={messages.length > 0}
      saved={saved}
      view={view}
      onView={setView}
      activeId={listingId}
      onOpen={openListing}
    />
  );

  const listing = listingId && (
    <Listing
      key={listingId}
      id={listingId}
      match={listingMatch}
      saved={isSaved(Number(listingId))}
      onToggleSave={toggleSave}
      onBack={closeListing}
    />
  );

  return (
    <MotionConfig reducedMotion="user" transition={SPRING}>
      <LayoutGroup>
        <div className="relative flex h-[calc(100dvh-3.5rem)] overflow-hidden max-sm:h-[calc(100dvh-3.25rem)]">
          {desktop ? (
            <>
              <motion.aside
                initial={false}
                animate={{ width: chatOpen ? chatWidth : 0, opacity: chatOpen ? 1 : 0 }}
                className="relative shrink-0 overflow-hidden border-r bg-card"
                aria-label="Chat"
                inert={!chatOpen}
              >
                <div style={{ width: chatWidth }} className="absolute inset-y-0 left-0">
                  {chat}
                </div>
              </motion.aside>
              <section className="relative min-w-0 flex-1 bg-background" aria-label="Results">
                <AnimatePresence mode="popLayout" initial={false}>
                  {listingId ? (
                    <motion.div
                      key={`listing-${listingId}`}
                      className="absolute inset-0"
                      initial={{ opacity: 0, x: 40 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 40 }}
                    >
                      {listing}
                    </motion.div>
                  ) : (
                    <motion.div
                      key="results"
                      className="absolute inset-0"
                      initial={{ opacity: 0, x: -24 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -24 }}
                    >
                      {results}
                    </motion.div>
                  )}
                </AnimatePresence>
              </section>
            </>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col bg-card">
              <div
                role="tablist"
                aria-label="View"
                className="flex shrink-0 border-b p-1.5 text-[13px]"
              >
                {(["chat", "results"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={mobileTab === tab}
                    onClick={() => setMobileTab(tab)}
                    className={cn(
                      "relative flex-1 rounded-lg py-1.5 font-medium transition-colors",
                      mobileTab === tab ? "bg-muted text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {tab === "chat" ? "Chat" : "Matches"}
                    {tab === "results" && ranking.matches.length > 0 && (
                      <span className="ml-1.5 rounded-full bg-foreground px-1.5 py-px text-[10px] text-background tabular-nums">
                        {ranking.matches.length}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="relative min-h-0 flex-1">
                <div className="absolute inset-0">{mobileTab === "chat" ? chat : results}</div>
              </div>
              <AnimatePresence>
                {listingId && (
                  <motion.div
                    key="mobile-listing"
                    className="fixed inset-x-0 top-[3.25rem] bottom-0 z-30 bg-background"
                    initial={{ opacity: 0, y: 32 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 32 }}
                  >
                    {listing}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* The chat, tucked away: the orb from the chat header lands here. */}
          {listingId && (
            <motion.button
              layoutId="orb"
              type="button"
              onClick={backToChat}
              aria-label="Open the assistant"
              className="fixed bottom-5 left-5 z-40 rounded-full shadow-lg ring-1 ring-black/5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none max-lg:right-5 max-lg:left-auto"
              whileHover={{ scale: 1.06 }}
              whileTap={{ scale: 0.94 }}
            >
              <Orb className="size-14" busy={busy} />
              <MessageSquare className="sr-only" />
            </motion.button>
          )}
        </div>
      </LayoutGroup>
    </MotionConfig>
  );
}
