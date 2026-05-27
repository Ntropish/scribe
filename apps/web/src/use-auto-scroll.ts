import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

const BOTTOM_THRESHOLD_PX = 8;

export interface AutoScroll {
  follow: boolean;
  activate: () => void;
  deactivate: () => void;
}

export function useAutoScroll(
  scrollRef: RefObject<HTMLElement | null>,
  trigger: unknown,
): AutoScroll {
  const [follow, setFollow] = useState(true);
  // When the user manually turns follow off via the toggle, scrolling
  // back into the bottom-threshold zone should not silently turn it
  // back on. This sticks until they click activate / Jump to latest.
  const manuallyOffRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distance < BOTTOM_THRESHOLD_PX;
      if (atBottom) {
        if (!manuallyOffRef.current) setFollow(true);
      } else {
        setFollow(false);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef]);

  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [trigger, follow, scrollRef]);

  const activate = useCallback(() => {
    manuallyOffRef.current = false;
    setFollow(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollRef]);

  const deactivate = useCallback(() => {
    manuallyOffRef.current = true;
    setFollow(false);
  }, []);

  return { follow, activate, deactivate };
}
