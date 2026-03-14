"use client";

import { useEffect, useRef } from "react";
import rrwebPlayer from "rrweb-player";
import "rrweb-player/dist/style.css";

interface ReplayViewerProps {
  events: Array<{ type: string; payload: unknown }>;
}

export function ReplayViewer({ events }: ReplayViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<rrwebPlayer | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Cleanup previous
    if (playerRef.current) {
      el.innerHTML = "";
      playerRef.current = null;
    }

    const rrwebEvents = events
      .filter((e) => e.type === "rrweb")
      .map((e) => e.payload);

    if (rrwebEvents.length === 0) return;

    playerRef.current = new rrwebPlayer({
      target: el,
      props: {
        events: rrwebEvents as any[],
        showController: true,
        autoPlay: false,
        speed: 1,
      },
    });

    return () => {
      el.innerHTML = "";
      playerRef.current = null;
    };
  }, [events]);

  if (events.filter((e) => e.type === "rrweb").length === 0) {
    return (
      <div className="h-[500px] flex items-center justify-center border rounded bg-gray-50 text-gray-400">
        No rrweb events found in this session.
      </div>
    );
  }

  return <div ref={containerRef} className="w-full min-h-[500px] border rounded bg-slate-50" />;
}
