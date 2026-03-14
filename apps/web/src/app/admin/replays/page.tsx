"use client";

import { trpc } from "@/trpc/client";
import { ReplayViewer } from "@/components/telemetry/ReplayViewer";
import { useState } from "react";

export default function ReplaysPage() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");

  const { data: sessionsData, isLoading: sessionsLoading } =
    trpc.telemetry.listSessions.useQuery({ limit: 20 });

  const { data: replayData, isLoading: replayLoading } =
    trpc.telemetry.getSessionReplay.useQuery(
      { sessionId: selectedSessionId ?? "" },
      { enabled: !!selectedSessionId }
    );

  const { data: timelineData } = trpc.telemetry.getSessionTimeline.useQuery(
    { sessionId: selectedSessionId ?? "" },
    { enabled: !!selectedSessionId }
  );

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Session Replays</h1>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {/* Sidebar: Session List */}
        <div className="md:col-span-1 space-y-4">
          <div className="border rounded p-4">
            <h2 className="font-semibold mb-3">Search Session</h2>
            <input
              type="text"
              placeholder="Paste Session ID..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              className="w-full border rounded p-2 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && inputValue.trim()) {
                  setSelectedSessionId(inputValue.trim());
                }
              }}
            />
          </div>

          <div className="border rounded p-4">
            <h2 className="font-semibold mb-3">Recent Sessions</h2>
            {sessionsLoading ? (
              <p className="text-sm text-gray-400">Loading sessions...</p>
            ) : sessionsData?.sessions.length === 0 ? (
              <p className="text-sm text-gray-400">No sessions recorded yet.</p>
            ) : (
              <ul className="space-y-2 max-h-[400px] overflow-auto">
                {sessionsData?.sessions.map((s) => (
                  <li key={s.id}>
                    <button
                      onClick={() => setSelectedSessionId(s.id)}
                      className={`w-full text-left p-2 rounded text-xs transition-colors ${
                        selectedSessionId === s.id
                          ? "bg-blue-100 border-blue-300 border"
                          : "bg-gray-50 hover:bg-gray-100 border border-transparent"
                      }`}
                    >
                      <p className="font-mono truncate">{s.id}</p>
                      <p className="text-gray-400 mt-1">
                        {new Date(s.createdAt).toLocaleString()} · {s._count.events} events
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Main content: Replay + Timeline */}
        <div className="md:col-span-3 space-y-6">
          {replayLoading ? (
            <div className="h-[500px] flex items-center justify-center border rounded bg-gray-50">
              <p className="text-gray-400">Loading replay...</p>
            </div>
          ) : replayData?.events && replayData.events.length > 0 ? (
            <ReplayViewer events={replayData.events} />
          ) : (
            <div className="h-[500px] flex items-center justify-center border rounded bg-gray-50 text-gray-400">
              {selectedSessionId
                ? "No events found for this session."
                : "Select a session from the sidebar to view its replay."}
            </div>
          )}

          {/* Enriched Timeline */}
          {timelineData && timelineData.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold mb-3">Enriched Timeline</h2>
              <ul className="space-y-2">
                {timelineData.map((t) => (
                  <li key={t.id} className="text-sm border-l-2 border-green-500 pl-4 py-1">
                    <span className="font-mono text-xs text-gray-400">
                      {new Date(t.timestamp).toLocaleTimeString()}
                    </span>{" "}
                    – <span className="font-semibold">{t.type}</span>
                    <p className="text-gray-600 mt-0.5">{t.content}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Raw Events */}
          {replayData?.events && replayData.events.length > 0 && (
            <details className="border rounded p-4">
              <summary className="font-semibold cursor-pointer">
                Raw Events ({replayData.events.length})
              </summary>
              <ul className="space-y-2 mt-4 max-h-[600px] overflow-auto">
                {replayData.events.slice(0, 100).map((e, i) => (
                  <li key={i} className="text-sm border-l-2 border-blue-500 pl-4 py-1">
                    <span className="font-mono text-xs text-gray-400">
                      #{e.sequence}
                    </span>{" "}
                    – <span className="font-semibold">{e.type}</span>
                  </li>
                ))}
                {replayData.events.length > 100 && (
                  <li className="text-sm text-gray-400 pl-4">
                    ... and {replayData.events.length - 100} more events
                  </li>
                )}
              </ul>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
