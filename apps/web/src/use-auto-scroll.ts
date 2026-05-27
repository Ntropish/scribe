import { useCallback, useEffect, useState, type RefObject } from "react";

const BOTTOM_THRESHOLD_PX = 8;

export interface AutoScroll {
  follow: boolean;
  activate: () => void;
}

export function useAutoScroll(
  scrollRef: RefObject<HTMLElement | null>,
  trigger: unknown,
): AutoScroll {
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setFollow(distance < BOTTOM_THRESHOLD_PX);
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
    setFollow(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollRef]);

  return { follow, activate };
}
