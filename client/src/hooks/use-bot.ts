import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/routes";

// Using the API contract defined in shared/routes
export function useBotStatus() {
  return useQuery({
    queryKey: [api.bot.status.path],
    queryFn: async () => {
      const res = await fetch(api.bot.status.path);
      if (!res.ok) throw new Error("Failed to fetch bot status");
      return api.bot.status.responses[200].parse(await res.json());
    },
    // Poll status every 5 seconds to keep dashboard fresh
    refetchInterval: 5000,
  });
}

export function useBotLogs() {
  return useQuery({
    queryKey: [api.bot.logs.path],
    queryFn: async () => {
      const res = await fetch(api.bot.logs.path);
      if (!res.ok) throw new Error("Failed to fetch bot logs");
      return api.bot.logs.responses[200].parse(await res.json());
    },
    // Poll logs every 3 seconds
    refetchInterval: 3000,
  });
}
