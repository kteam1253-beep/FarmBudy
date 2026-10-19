import { motion } from "framer-motion";
import { Activity, Clock, Server } from "lucide-react";

interface StatusCardProps {
  label: string;
  value: string | number;
  subtext?: string | null;
  type: "status" | "uptime" | "ping";
  isLoading?: boolean;
}

export function StatusCard({ label, value, subtext, type, isLoading }: StatusCardProps) {
  const getIcon = () => {
    switch (type) {
      case "status": return <Activity className="w-5 h-5" />;
      case "uptime": return <Clock className="w-5 h-5" />;
      case "ping": return <Server className="w-5 h-5" />;
    }
  };

  const getColorClass = () => {
    switch (type) {
      case "status": 
        return value === "online" 
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" 
          : "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400";
      case "uptime": return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
      case "ping": return "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400";
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-card rounded-2xl p-6 shadow-sm border border-border/50 hover:shadow-md transition-all duration-300"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{label}</h3>
        <div className={`p-2 rounded-lg ${getColorClass()}`}>
          {getIcon()}
        </div>
      </div>
      
      {isLoading ? (
        <div className="h-8 w-24 bg-muted animate-pulse rounded-md" />
      ) : (
        <div className="space-y-1">
          <div className="text-2xl font-bold font-display capitalize flex items-center gap-2">
            {type === "status" && (
              <span className="status-indicator">
                <span className={`status-ping ${value === 'online' ? 'bg-emerald-400' : 'bg-rose-400'}`}></span>
                <span className={`status-dot ${value === 'online' ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
              </span>
            )}
            {value}
          </div>
          {subtext && (
            <p className="text-sm text-muted-foreground font-medium">{subtext}</p>
          )}
        </div>
      )}
    </motion.div>
  );
}
