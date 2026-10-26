import { useChat } from "@ai-sdk/react";
import type { JobAgentMessage } from "@tallo/search-ai";
import { DefaultChatTransport } from "ai";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "@/components/assistant/ChatPanel";
import {
  useChatWidth,
  useElementWidth,
  useIsDesktop,
  useSavedJobs,
} from "@/components/assistant/hooks";
import { JobList, type ListView } from "@/components/assistant/JobList";
import { Listing } from "@/components/assistant/Listing";
import { Orb } from "@/components/assistant/Orb";
import { collectHits, currentSearch, notesById } from "@/lib/assistant";
import { cn } from "@/lib/utils";

const transport = new DefaultChatTransport({ api: "/api/chat" });
const STORAGE_KEY = "tallo.chat.v1";
const SPRING = { type: "spring", stiffness: 420, damping: 40, mass: 0.9 } as const;
/** Width of the list while a posting is open beside it. */
const LIST_WIDTH = 400;

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
 * A column that animates its width. With `fixed`, the content keeps that width while the column opens or
 * closes, so it is revealed and clipped instead of being squeezed. Closed columns are inert.
 */
function Pane({
  width,
  fixed,
  label,
  className,
  children,
}: {
  width: number;
  fixed?: number;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <motion.section
      initial={false}
      animate={{ width }}
      aria-label={label}
      inert={width === 0}
      className={cn("relative shrink-0 overflow-hidden", className)}
    >
      <div className="absolute inset-y-0 left-0" style={{ width: fixed ?? "100%" }}>
        {children}
      </div>
    </motion.section>
  );
}

/**
 * Chat beside the list. The assistant builds the search; the list is the database's answer to it. Opening a job
 * tucks the chat into a bubble and slides the list left, so you keep browsing while you read; the bubble brings
 * the chat back. Everything beside the chat derives from the conversation, so the message stream is the one
 * source of truth.
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
  const rootRef = useRef<HTMLDivElement>(null);
  const rootWidth = useElementWidth(rootRef);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [listingId, setListingId] = useState<string | null>(null);
  // Kept after the posting closes, so its column can finish sliding shut with the content still in it.
  const [lastListingId, setLastListingId] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"chat" | "results">("chat");
  const [view, setView] = useState<ListView>("results");

  const busy = status === "submitted" || status === "streaming";
  const hits = useMemo(() => collectHits(messages), [messages]);
  const spec = useMemo(() => currentSearch(messages), [messages]);
  const notes = useMemo(() => notesById(messages), [messages]);

  useEffect(() => {
    if (status !== "ready" && status !== "error") return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // Storage full or blocked: the chat still works for this visit.
    }
  }, [messages, status]);

  const openListing = useCallback((id: string) => {
    setListingId(id);
    setLastListingId(id);
  }, []);
  const closeListing = useCallback(() => setListingId(null), []);
  const backToChat = useCallback(() => {
    setListingId(null);
    setMobileTab("chat");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const send = useCallback(
    (text: string) => {
      setView("results");
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
    setLastListingId(null);
    setView("results");
    setMobileTab("chat");
    sessionStorage.removeItem(STORAGE_KEY);
    inputRef.current?.focus();
  }, [stop, setMessages]);

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

  const detail = desktop && listingId !== null;
  const chatVisible = desktop ? !detail : mobileTab === "chat" && listingId === null;

  const chat = (
    <ChatPanel
      messages={messages}
      hits={hits}
      status={status}
      error={error}
      hasProfile={hasProfile}
      showOrb={chatVisible}
      inputRef={inputRef}
      onSend={send}
      onStop={() => void stop()}
      onRetry={() => void regenerate()}
      onReset={reset}
      onShowResults={desktop ? undefined : () => setMobileTab("results")}
    />
  );

  const list = (
    <JobList
      spec={spec}
      notes={notes}
      saved={saved}
      view={view}
      onView={setView}
      activeId={listingId}
      busy={busy}
      started={messages.length > 0}
      onOpen={openListing}
    />
  );

  const listing = lastListingId && (
    <Listing
      key={lastListingId}
      id={lastListingId}
      note={notes.get(lastListingId)}
      saved={isSaved(Number(lastListingId))}
      onToggleSave={toggle}
      onBack={desktop ? backToChat : closeListing}
    />
  );

  const detailFixed = Math.max(0, rootWidth - LIST_WIDTH);

  return (
    <MotionConfig reducedMotion="user" transition={SPRING}>
      <LayoutGroup>
        <div
          ref={rootRef}
          className="relative flex h-[calc(100dvh-3.5rem)] overflow-hidden max-sm:h-[calc(100dvh-3.25rem)]"
        >
          {desktop ? (
            <>
              <Pane
                width={detail ? 0 : chatWidth}
                fixed={chatWidth}
                label="Chat"
                className="border-r bg-card"
              >
                {chat}
              </Pane>
              <Pane
                width={detail ? LIST_WIDTH : Math.max(0, rootWidth - chatWidth)}
                label="Results"
                className={cn("bg-background", detail && "border-r")}
              >
                {list}
              </Pane>
              <Pane
                width={detail ? detailFixed : 0}
                fixed={detailFixed}
                label="Posting"
                className="bg-background"
              >
                {listing}
              </Pane>
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
                      "flex-1 rounded-lg py-1.5 font-medium transition-colors",
                      mobileTab === tab ? "bg-muted text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {tab === "chat" ? "Chat" : "Results"}
                  </button>
                ))}
              </div>
              <div className="relative min-h-0 flex-1">
                <div className="absolute inset-0">{mobileTab === "chat" ? chat : list}</div>
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

          {/* The chat, tucked away while a posting is open: the orb from the chat header lands here. */}
          {listingId && (
            <motion.button
              layoutId="orb"
              type="button"
              onClick={backToChat}
              aria-label="Open the assistant"
              className="fixed right-5 bottom-5 z-40 rounded-full shadow-lg ring-1 ring-black/5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none lg:right-auto lg:left-5"
              whileHover={{ scale: 1.06 }}
              whileTap={{ scale: 0.94 }}
            >
              <Orb className="size-14" busy={busy} />
            </motion.button>
          )}
        </div>
      </LayoutGroup>
    </MotionConfig>
  );
}
