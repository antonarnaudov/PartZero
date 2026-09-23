/**
 * Chat panel (UI only in this spike): transcript, "agent not connected" state, selection chips
 * that travel with the message, and an input (Enter sends, Shift+Enter adds a line).
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { findFeature } from "../doc/provenance";
import type { SelectionChip } from "../ui-store";
import { useApp, useStore } from "./context";
import { Icon } from "./icons";

function useSelectionChips(): SelectionChip[] {
  const { services } = useApp();
  const selection = useStore(services.doc, (s) => s.selection);
  const model = useStore(services.doc, (s) => s.model);
  return useMemo(() => {
    const chips: SelectionChip[] = [];
    const loc = selection.featureId ? findFeature(model?.ir, selection.featureId) : null;
    if (loc) chips.push({ kind: "feature", ref: loc.feature.id, label: loc.feature.name });
    const e = selection.entity;
    if (e?.face) chips.push({ kind: "face", ref: e.face, label: e.face });
    else if (e?.edge) chips.push({ kind: "edge", ref: e.edge, label: e.edge });
    return chips;
  }, [selection, model]);
}

export function ChatPanel(): ReactElement {
  const { services, run, isMac } = useApp();
  const messages = useStore(services.ui, (s) => s.chat);
  const focusTick = useStore(services.ui, (s) => s.chatFocusTick);
  const chips = useSelectionChips();
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // New selection → all chips included again.
  useEffect(() => setExcluded(new Set()), [chips]);
  useEffect(() => {
    if (focusTick > 0) inputRef.current?.focus();
  }, [focusTick]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const activeChips = chips.filter((c) => !excluded.has(`${c.kind}:${c.ref}`));
  const send = (): void => {
    const text = draft.trim();
    if (!text) return;
    run({ id: "chat.send", args: { text, chips: activeChips } });
    setDraft("");
  };

  return (
    <section className="panel chat" aria-label="Chat">
      <header className="panel-header">
        <Icon.Sparkle size={14} />
        <span className="panel-title">Assistant</span>
        <span className="agent-state" data-testid="agent-state" title="packages/agent is not wired into the app yet">
          <span className="dot" /> agent not connected
        </span>
      </header>
      <div className="panel-body chat-list" ref={listRef} aria-live="polite">
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            {m.chips.length > 0 && (
              <div className="msg-chips">
                {m.chips.map((c) => (
                  <span key={`${c.kind}:${c.ref}`} className={`chip chip-${c.kind}`}>
                    {c.kind}: {c.label}
                  </span>
                ))}
              </div>
            )}
            <div className="msg-text">{m.text}</div>
          </div>
        ))}
      </div>
      <div className="chat-compose">
        {activeChips.length > 0 && (
          <div className="compose-chips" aria-label="Context from selection">
            {activeChips.map((c) => (
              <span key={`${c.kind}:${c.ref}`} className={`chip chip-${c.kind}`}>
                <span className="chip-kind">{c.kind}</span> {c.label}
                <button
                  type="button"
                  aria-label={`Remove ${c.label}`}
                  onClick={() => setExcluded(new Set([...excluded, `${c.kind}:${c.ref}`]))}
                >
                  <Icon.Close size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="compose-row">
          <textarea
            ref={inputRef}
            value={draft}
            rows={2}
            placeholder={`Describe a change… (${isMac ? "⌘" : "Ctrl+"}L to focus)`}
            aria-label="Message"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button type="button" className="send-btn" onClick={send} disabled={!draft.trim()} aria-label="Send" title="Send (Enter)">
            <Icon.Send size={14} />
          </button>
        </div>
      </div>
    </section>
  );
}
