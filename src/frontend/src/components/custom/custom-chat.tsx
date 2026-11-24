import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { SendHorizontal, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

import type { ChatCreated, ChatReply } from "@/api/custom-client";
import { ChatProse } from "@/components/custom/chat-prose";
import { refusal } from "@/components/custom/refusal";
import { CustomTable } from "@/components/custom/custom-table";
import { Badge, Button, Textarea, Spinner } from "@gears-frontx/ui-kit";
import {
  takeAssistantDraft,
  useAssistantDraft,
  type AssistantDraft,
} from "@/lib/custom/assistant-draft";
import { useSendChat } from "@/queries/custom";
import { TEXT_BODY, TEXT_HEADING, TEXT_LABEL } from "@/lib/type-scale";

export interface CustomChatProps {
  onCreated: (created: ChatCreated) => void;
}

interface Exchange {
  id: number;
  question: string;
  reply?: ChatReply;
  error?: string;
}

function toolUsed(reply: ChatReply): string {
  return reply.created || reply.updated ? "create" : "answer";
}

interface Written {
  noun: "metric" | "widget" | "dashboard";
  id: string;
  name: string;
}

function written(set: ChatCreated | undefined): Written[] {
  if (!set) return [];

  return [
    ...(set.metric ? [{ noun: "metric" as const, ...set.metric }] : []),
    ...set.widgets.map((widget) => ({ noun: "widget" as const, ...widget })),
    ...(set.dashboard
      ? [{ noun: "dashboard" as const, ...set.dashboard }]
      : []),
  ];
}

export function CustomChat({ onCreated }: CustomChatProps) {
  const [message, setMessage] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const sendChat = useSendChat();
  const threadEnd = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const asked = useAssistantDraft();
  const [placedDraft, setPlacedDraft] = useState<AssistantDraft | null>(null);

  if (asked !== null && asked !== placedDraft) {
    setPlacedDraft(asked);
    setMessage(asked.text);
  }

  useEffect(() => {
    if (asked === null) return;

    takeAssistantDraft(asked);
    const field = input.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }, [asked]);

  useEffect(() => {
    // WORKAROUND: jsdom does not implement scrollIntoView.
    threadEnd.current?.scrollIntoView?.({ block: "end" });
  }, [exchanges]);

  async function handleSend() {
    const question = message.trim();
    if (!question || sendChat.isPending) return;

    const id = Date.now() + Math.random();
    const history = exchanges.flatMap((exchange) =>
      exchange.reply
        ? [
            { role: "user" as const, content: exchange.question },
            { role: "assistant" as const, content: exchange.reply.reply },
          ]
        : []
    );
    setMessage("");
    setExchanges((prev) => [...prev, { id, question }]);

    try {
      const reply = await sendChat.mutateAsync({ message: question, history });
      setExchanges((prev) =>
        prev.map((exchange) =>
          exchange.id === id ? { ...exchange, reply } : exchange
        )
      );
      if (reply.created) onCreated(reply.created);
    } catch (error) {
      setMessage(question);
      const said = refusal(error, "The chat request failed.");
      setExchanges((prev) =>
        prev.map((exchange) =>
          exchange.id === id ? { ...exchange, error: said } : exchange
        )
      );
    }
  }

  return (
    <aside className="flex h-full min-h-0 flex-col border-s bg-sidebar">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Sparkles className="size-4 text-muted-foreground" aria-hidden />
        <h2 className={TEXT_HEADING}>Assistant</h2>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {exchanges.length === 0 ? (
          <p className={cn(TEXT_LABEL, "leading-relaxed")}>
            Ask a question about the data, or describe a dashboard to build.
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {exchanges.map((exchange) => (
              <li key={exchange.id} className="flex flex-col gap-2">
                <p
                  className={cn(
                    TEXT_BODY,
                    "ms-auto max-w-[85%] rounded-2xl rounded-ee-sm bg-primary px-3 py-2 whitespace-pre-line text-primary-foreground"
                  )}
                >
                  {exchange.question}
                </p>

                {exchange.reply ? (
                  <ChatAnswer reply={exchange.reply} />
                ) : exchange.error ? (
                  <p
                    role="alert"
                    className={cn(
                      TEXT_BODY,
                      "me-auto max-w-[85%] rounded-2xl rounded-es-sm bg-destructive/10 px-3 py-2 text-destructive"
                    )}
                  >
                    {exchange.error}
                  </p>
                ) : (
                  <span
                    className={cn(
                      TEXT_LABEL,
                      "me-auto flex items-center gap-2 px-1"
                    )}
                  >
                    <Spinner compact /> Thinking…
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div ref={threadEnd} />
      </div>

      <div className="flex items-center gap-2 border-t p-3">
        <Textarea
          ref={input}
          data-testid="chat-input"
          value={message}
          rows={2}
          className="max-h-40 flex-1 resize-none"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
          placeholder="Message"
        />
        <Button
          data-testid="chat-send"
          type="button"
          variant="ghost"
          aria-label="Send"
          className="shrink-0"
          onClick={() => void handleSend()}
          disabled={sendChat.isPending || message.trim() === ""}
          icon={<SendHorizontal className="size-5 fill-current stroke-1" />}
        />
      </div>
    </aside>
  );
}

function ChatAnswer({ reply }: { reply: ChatReply }) {
  const tool = toolUsed(reply);
  const built = written(reply.created);
  const replaced = written(reply.updated);

  return (
    <div className="me-auto flex w-full flex-col gap-2 rounded-2xl rounded-es-sm bg-background px-3 py-2 shadow-xs">
      <Badge variant="secondary" className="w-fit font-mono">
        {tool}
      </Badge>

      <p className={cn(TEXT_BODY, "leading-relaxed whitespace-pre-line")}>
        <ChatProse text={reply.reply} />
      </p>

      {reply.result && reply.result.rows.length > 0 ? (
        <div className="max-h-64 overflow-auto rounded-md border">
          <CustomTable result={reply.result} />
        </div>
      ) : null}

      {built.length ? <WrittenLine verb="Built" items={built} /> : null}

      {replaced.length ? (
        <WrittenLine verb="Replaced" items={replaced} />
      ) : null}
    </div>
  );
}

function WrittenLine({ verb, items }: { verb: string; items: Written[] }) {
  return (
    <p className={TEXT_LABEL}>
      {verb}{" "}
      {items.map((item, index) => (
        <span key={`${item.noun}-${item.id}`}>
          {index > 0 ? " · " : null}
          {item.noun}{" "}
          <WrittenLink item={item} />
        </span>
      ))}
    </p>
  );
}

const LINK_CLASS = "underline decoration-dotted underline-offset-4";

function WrittenLink({ item }: { item: Written }) {
  switch (item.noun) {
    case "metric":
      return (
        <Link
          to="/dashboards/metrics/$name"
          params={{ name: item.id }}
          className={LINK_CLASS}
        >
          {item.name}
        </Link>
      );
    case "widget":
      return (
        <Link
          to="/dashboards/widgets/$name"
          params={{ name: item.id }}
          className={LINK_CLASS}
        >
          {item.name}
        </Link>
      );
    case "dashboard":
      return (
        <Link
          to="/dashboards/$name"
          params={{ name: item.id }}
          className={LINK_CLASS}
        >
          {item.name}
        </Link>
      );
  }
}
