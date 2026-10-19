import { useState, useRef, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Bot, X, Send, Loader2, Trash2, Sparkles } from "lucide-react";

interface ChatMessage {
  role: "user" | "ai";
  text: string;
  timestamp: Date;
}

export function AiChat() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const sendMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await fetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        credentials: "include",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || `${res.status}: ${res.statusText}`);
      }
      return data as { reply: string };
    },
    onSuccess: (data) => {
      setMessages((prev) => [
        ...prev,
        { role: "ai", text: data.reply, timestamp: new Date() },
      ]);
    },
    onError: (err: any) => {
      setMessages((prev) => [
        ...prev,
        {
          role: "ai",
          text: `❌ ${err?.message || "Greška pri komunikaciji s AI-em."}`,
          timestamp: new Date(),
        },
      ]);
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", "/api/ai-chat");
    },
    onSuccess: () => {
      setMessages([]);
    },
  });

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || sendMutation.isPending) return;
    setMessages((prev) => [
      ...prev,
      { role: "user", text: trimmed, timestamp: new Date() },
    ]);
    setInput("");
    sendMutation.mutate(trimmed);
  }

  // Parse embed blocks from AI response
  function renderAiText(text: string) {
    const parts: React.ReactNode[] = [];
    let remaining = text;
    let idx = 0;

    // Split by ```embed blocks
    const embedRegex = /```embed\s*\n([\s\S]*?)```/g;
    let match;
    let lastIndex = 0;

    while ((match = embedRegex.exec(text)) !== null) {
      // Text before embed
      if (match.index > lastIndex) {
        parts.push(
          <span key={idx++}>{remaining.slice(lastIndex, match.index)}</span>
        );
      }
      // Render embed preview
      try {
        const embedData = JSON.parse(match[1].trim());
        parts.push(
          <div
            key={idx++}
            className="mt-2 rounded-lg border-l-4 p-3 bg-slate-800/50"
            style={{
              borderLeftColor: embedData.color || "#5865F2",
            }}
          >
            {embedData.title && (
              <div className="font-bold text-sm mb-1">{embedData.title}</div>
            )}
            {embedData.description && (
              <div className="text-xs text-slate-300 mb-2 whitespace-pre-wrap">
                {embedData.description}
              </div>
            )}
            {Array.isArray(embedData.fields) &&
              embedData.fields.map((f: any, fi: number) => (
                <div
                  key={fi}
                  className={`text-xs mb-1 ${f.inline ? "inline-block mr-4" : ""}`}
                >
                  <span className="font-semibold text-slate-200">
                    {f.name}
                  </span>
                  <br />
                  <span className="text-slate-400">{f.value}</span>
                </div>
              ))}
            <div className="text-[10px] text-slate-500 mt-1">
              📋 Embed pregled
            </div>
          </div>
        );
      } catch {
        parts.push(
          <code key={idx++} className="text-xs bg-slate-800 rounded px-1">
            {match[1]}
          </code>
        );
      }
      lastIndex = match.index + match[0].length;
    }

    // Remaining text
    if (lastIndex < text.length) {
      parts.push(<span key={idx++}>{text.slice(lastIndex)}</span>);
    }

    return parts.length > 0 ? parts : text;
  }

  return (
    <>
      {/* Floating button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-50 w-14 h-14 rounded-full bg-gradient-to-br from-violet-600 to-indigo-600 text-white shadow-lg shadow-violet-500/25 hover:shadow-violet-500/40 hover:scale-105 transition-all duration-200 flex items-center justify-center group"
          title="FarmBuddy AI Asistent"
        >
          <Sparkles className="w-6 h-6 group-hover:rotate-12 transition-transform" />
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-green-400 rounded-full border-2 border-slate-900 animate-pulse" />
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-5 right-5 z-50 w-[380px] h-[520px] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl shadow-black/50 flex flex-col overflow-hidden animate-in slide-in-from-bottom-4 fade-in duration-200">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-violet-600/20 to-indigo-600/20 border-b border-slate-700">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-indigo-500 flex items-center justify-center">
                <Bot className="w-4 h-4 text-white" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">
                  FarmBuddy AI
                </h3>
                <p className="text-[10px] text-slate-400">
                  Asistent za dashboard
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-slate-400 hover:text-red-400"
                onClick={() => clearMutation.mutate()}
                title="Obriši razgovor"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-slate-400 hover:text-white"
                onClick={() => setOpen(false)}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Messages */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-4 py-3 space-y-3 scrollbar-thin"
          >
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center opacity-60">
                <Sparkles className="w-10 h-10 text-violet-400 mb-3" />
                <p className="text-sm text-slate-300 font-medium">
                  Bok! Ja sam FarmBuddy AI.
                </p>
                <p className="text-xs text-slate-500 mt-1 max-w-[260px]">
                  Pitaj me bilo što o dashboardu, embedovima, serveru ili FS25.
                </p>
                <div className="mt-4 space-y-1.5 w-full max-w-[260px]">
                  {[
                    "Kako napraviti embed?",
                    "Što radi tab Konzola?",
                    "Kako backupirati server?",
                  ].map((q) => (
                    <button
                      key={q}
                      onClick={() => {
                        setInput(q);
                        setTimeout(() => inputRef.current?.focus(), 50);
                      }}
                      className="w-full text-left text-xs px-3 py-2 rounded-lg bg-slate-800/50 border border-slate-700/50 text-slate-400 hover:text-white hover:bg-slate-800 hover:border-violet-500/30 transition-all"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-violet-600 text-white rounded-br-md"
                      : "bg-slate-800 text-slate-200 border border-slate-700 rounded-bl-md"
                  }`}
                >
                  {msg.role === "ai" ? renderAiText(msg.text) : msg.text}
                </div>
              </div>
            ))}

            {sendMutation.isPending && (
              <div className="flex justify-start">
                <div className="bg-slate-800 border border-slate-700 rounded-2xl rounded-bl-md px-4 py-3">
                  <div className="flex items-center gap-2 text-slate-400">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span className="text-xs">Razmišljam...</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="px-3 py-3 border-t border-slate-700 bg-slate-900/80">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend();
              }}
              className="flex items-center gap-2"
            >
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Pitaj nešto..."
                maxLength={2000}
                className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
                disabled={sendMutation.isPending}
              />
              <Button
                type="submit"
                size="icon"
                disabled={!input.trim() || sendMutation.isPending}
                className="h-10 w-10 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-30"
              >
                <Send className="w-4 h-4" />
              </Button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
