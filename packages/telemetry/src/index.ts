/**
 * @shared/telemetry - Decipher-style session replay SDK
 *
 * Usage (Vanilla JS / any framework):
 *   import { Telemetry } from "@shared/telemetry";
 *   Telemetry.init({ endpoint: "/api/rest" });
 *
 * Usage (React):
 *   import { TelemetryProvider } from "@shared/telemetry/react";
 *   <TelemetryProvider endpoint="/api/rest"> ... </TelemetryProvider>
 */

import * as rrweb from "rrweb";

export interface TelemetryConfig {
  /** The tRPC base URL, e.g. "/api/rest" or "https://your-api.com/api/rest" */
  endpoint: string;
  /** Mask all user inputs for privacy. Default: true */
  maskAllInputs?: boolean;
  /** CSS selector for elements to block from recording. Default: "[data-telemetry-block]" */
  blockSelector?: string;
  /** Max events per batch. Default: 50 */
  batchSize?: number;
  /** Flush interval in ms. Default: 5000 */
  flushIntervalMs?: number;
  /** Sample rate 0-1 for sessions to record. Default: 1.0 */
  sampleRate?: number;
}

interface TelemetryEvent {
  type: string;
  timestamp: Date;
  payload: Record<string, unknown>;
  sequence: number;
}

let _stopFn: (() => void) | null = null;
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _sessionId: string | null = null;
let _buffer: TelemetryEvent[] = [];
let _sequence = 0;
let _isFlushing = false;
let _config: Required<TelemetryConfig> | null = null;

function generateSessionId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function flush(): Promise<void> {
  if (_isFlushing || _buffer.length === 0 || !_config || !_sessionId) return;
  _isFlushing = true;

  const batch = _buffer.splice(0, _buffer.length);
  try {
    await fetch(`${_config.endpoint}/telemetry.ingestEvents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        "0": {
          json: {
            sessionId: _sessionId,
            events: batch.map((e) => ({
              ...e,
              timestamp: e.timestamp.toISOString(),
            })),
          },
        },
      }),
      keepalive: true,
    });
  } catch {
    // Retry: put events back
    _buffer.unshift(...batch);
  } finally {
    _isFlushing = false;
  }
}

export const Telemetry = {
  /**
   * Initialize session recording. Call once at app startup.
   *
   * @example
   * Telemetry.init({ endpoint: "/api/rest" });
   */
  init(config: TelemetryConfig): void {
    if (_stopFn) {
      console.warn("[Telemetry] Already initialized. Call Telemetry.stop() first.");
      return;
    }

    // Sample rate check
    const sampleRate = config.sampleRate ?? 1.0;
    if (Math.random() > sampleRate) {
      return; // This session is not sampled
    }

    _config = {
      endpoint: config.endpoint,
      maskAllInputs: config.maskAllInputs ?? true,
      blockSelector: config.blockSelector ?? "[data-telemetry-block]",
      batchSize: config.batchSize ?? 50,
      flushIntervalMs: config.flushIntervalMs ?? 5000,
      sampleRate,
    };

    _sessionId = generateSessionId();
    _buffer = [];
    _sequence = 0;

    const stop = rrweb.record({
      emit(event) {
        _buffer.push({
          type: "rrweb",
          timestamp: new Date(event.timestamp),
          payload: event as unknown as Record<string, unknown>,
          sequence: _sequence++,
        });
        if (_config && _buffer.length >= _config.batchSize) {
          void flush();
        }
      },
      maskAllInputs: _config.maskAllInputs,
      blockSelector: _config.blockSelector,
    });

    _stopFn = stop ?? null;

    _flushTimer = setInterval(() => void flush(), _config.flushIntervalMs);
  },

  /** Stop recording and flush remaining events */
  stop(): void {
    _stopFn?.();
    _stopFn = null;
    if (_flushTimer) {
      clearInterval(_flushTimer);
      _flushTimer = null;
    }
    void flush();
  },

  /** Set user identity for the current session */
  setUser(user: { id?: string; email?: string; username?: string; [key: string]: unknown }): void {
    // Store user info — will be sent with next flush
    if (_sessionId && _config) {
      _buffer.push({
        type: "user.identify",
        timestamp: new Date(),
        payload: user as Record<string, unknown>,
        sequence: _sequence++,
      });
    }
  },

  /** Get the current session ID */
  getSessionId(): string | null {
    return _sessionId;
  },
};

export default Telemetry;
