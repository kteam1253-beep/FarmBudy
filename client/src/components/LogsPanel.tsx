import { BotLog } from "@shared/schema";
import { format } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, Terminal, Info, RefreshCw } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

interface LogsPanelProps {
  logs: BotLog[];
  isLoading: boolean;
}

export function LogsPanel({ logs, isLoading }: LogsPanelProps) {
  const getLogIcon = (type: string) => {
    switch (type) {
      case 'error': return <AlertCircle className="w-4 h-4 text-rose-500" />;
      case 'command': return <Terminal className="w-4 h-4 text-primary" />;
      default: return <Info className="w-4 h-4 text-blue-500" />;
    }
  };

  const getLogStyle = (type: string) => {
    switch (type) {
      case 'error': return 'bg-rose-50/50 border-rose-100 text-rose-900 dark:bg-rose-900/10 dark:border-rose-900/30 dark:text-rose-200';
      case 'command': return 'bg-primary/5 border-primary/10 text-primary-foreground-dark dark:bg-primary/10 dark:border-primary/20 dark:text-primary-foreground';
      default: return 'bg-card border-border/40 text-foreground';
    }
  };

  return (
    <div className="glass-panel rounded-3xl overflow-hidden h-full flex flex-col">
      <div className="p-6 border-b border-border/50 flex items-center justify-between bg-card/50">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Terminal className="w-5 h-5 text-primary" />
          </div>
          <h2 className="text-lg font-bold font-display">System Logs</h2>
        </div>
        <div className="text-xs font-mono text-muted-foreground flex items-center gap-2">
          {isLoading && <RefreshCw className="w-3 h-3 animate-spin" />}
          LIVE FEED
        </div>
      </div>

      <ScrollArea className="flex-1 p-4 h-[400px]">
        <div className="space-y-3">
          <AnimatePresence initial={false}>
            {isLoading && logs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <RefreshCw className="w-8 h-8 animate-spin mb-4 opacity-20" />
                <p>Connecting to log stream...</p>
              </div>
            ) : logs.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                No logs recorded yet.
              </div>
            ) : (
              logs.map((log) => (
                <motion.div
                  key={log.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  className={`p-3 rounded-xl border text-sm font-mono flex items-start gap-3 transition-colors ${getLogStyle(log.type)}`}
                >
                  <div className="mt-0.5 shrink-0">
                    {getLogIcon(log.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-4 mb-1">
                      <span className="font-semibold uppercase text-[10px] tracking-wider opacity-70 px-1.5 py-0.5 rounded-md bg-black/5 dark:bg-white/10">
                        {log.type}
                      </span>
                      <span className="text-[10px] opacity-50 whitespace-nowrap">
                        {log.createdAt ? format(new Date(log.createdAt), 'HH:mm:ss') : '-'}
                      </span>
                    </div>
                    <p className="break-words leading-relaxed opacity-90">{log.message}</p>
                  </div>
                </motion.div>
              ))
            )}
          </AnimatePresence>
        </div>
      </ScrollArea>
    </div>
  );
}
