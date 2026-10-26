import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Keeps a scroller pinned to the bottom while content grows, unless the person scrolled up to read.
 * `dep` is whatever changes when content changes.
 */
export function useStickToBottom<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const stuck = useRef(true);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const toBottom = useCallback(() => {
    stuck.current = true;
    const el = ref.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);
  return { ref, onScroll, toBottom };
}
