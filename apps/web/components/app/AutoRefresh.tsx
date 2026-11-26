"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-render the page from the server every `minutes` while it is open and visible. */
export function AutoRefresh({ minutes }: { minutes: number }) {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    const tick = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= minutes * 60_000) {
        last = Date.now();
        router.refresh();
      }
    };
    const timer = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [minutes, router]);
  return null;
}
