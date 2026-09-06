// The browser-side WebSocket client (GUI spec §3.7).
//
// Connects on load, reconnects with exponential backoff, and exposes a
// subscribe/send API plus a reactive connection state.

import { createSignal } from "solid-js";
import type { ClientCommand, ServerEvent } from "./types";

export type ConnectionState = "connecting" | "open" | "closed";

type Listener = (event: ServerEvent) => void;

/** The WebSocket client. One instance per page. */
export class Client {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private closedByUser = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Reactive connection state (GUI spec §3.7). */
  readonly connectionState: () => ConnectionState;
  private readonly setConnectionState: (value: ConnectionState) => void;

  constructor() {
    const [get, set] = createSignal<ConnectionState>("connecting");
    this.connectionState = get;
    this.setConnectionState = set;
    this.connect();
  }

  /** Open the WebSocket to the agent-server (same origin, /ws). */
  private connect(): void {
    this.setConnectionState("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setConnectionState("open");
    };

    ws.onmessage = (msg) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(msg.data as string);
      } catch {
        return; // ignore malformed frames
      }
      for (const listener of this.listeners) listener(event);
    };

    ws.onclose = () => {
      this.setConnectionState("closed");
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  /** Reconnect with exponential backoff (GUI spec §3.7, §5). */
  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    const delay = Math.min(1000 * 2 ** this.attempt, 15000);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Subscribe to server events. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send a command to the server (GUI spec §6.1). */
  send(command: ClientCommand): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(command));
    }
  }

  /** Stop reconnecting and close (page unload). */
  dispose(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
