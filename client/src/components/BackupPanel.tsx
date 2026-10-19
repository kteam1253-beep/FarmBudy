import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Download, Upload, Trash2, Loader2, HardDrive, Plus, RotateCcw, AlertTriangle, Clock, Database, Shield, Check, Bomb, Square, X, FolderOutput } from "lucide-react";

interface Backup {
  id: string;
  name: string;
  guildId: string;
  channelCount: number;
  messageCount: number;
  sizeMB: string;
  auto: boolean;
  createdAt: string;
}

interface Guild {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number;
}

interface BackupChannel {
  name: string;
  type: number;
  category: string | null;
  messageCount: number;
}

interface GuildChannel {
  id: string;
  name: string;
  type: number;
  category: string | null;
}

export function BackupPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showRestoreDialog, setShowRestoreDialog] = useState<Backup | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<Backup | null>(null);
  const [showForceRestore, setShowForceRestore] = useState<Backup | null>(null);
  const [showForceRestorePicker, setShowForceRestorePicker] = useState(false);
  const [forceRestoreConfirmText, setForceRestoreConfirmText] = useState("");
  const [forceRestoreTargetGuildId, setForceRestoreTargetGuildId] = useState<string>("");
  const [showExtractPicker, setShowExtractPicker] = useState(false);
  const [showExtractDialog, setShowExtractDialog] = useState<(Backup & { guildName?: string }) | null>(null);
  const [extractSelectedChannels, setExtractSelectedChannels] = useState<Set<string>>(new Set());
  const [extractTargetChannelId, setExtractTargetChannelId] = useState<string>("");
  const [backupName, setBackupName] = useState("");
  const [restoreMode, setRestoreMode] = useState<string>("messages");
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());
  const [targetGuildId, setTargetGuildId] = useState<string>("");
  const [targetChannelId, setTargetChannelId] = useState<string>("");

  // Get guilds to find guild ID
  const { data: guilds = [] } = useQuery<Guild[]>({
    queryKey: ["/api/bot/guilds"],
    queryFn: async () => {
      const r = await fetch("/api/bot/guilds", { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const guildId = guilds[0]?.id || "";
  const guildName = guilds[0]?.name || "Server";

  // List all backups from all servers (for force restore cross-server picker)
  const { data: allBackups = [] } = useQuery<(Backup & { guildName: string })[]>({
    queryKey: ["/api/backups-all"],
    queryFn: async () => {
      const r = await fetch("/api/backups-all", { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: showForceRestorePicker || showExtractPicker,
  });

  // List backups
  const { data: backups = [], isLoading } = useQuery<Backup[]>({
    queryKey: ["/api/backups", guildId],
    queryFn: async () => {
      if (!guildId) return [];
      const r = await fetch(`/api/backups/${guildId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: !!guildId,
    refetchInterval: 60000,
  });

  // Create backup mutation
  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", `/api/backups/${guildId}`, { name });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/backups", guildId] });
      toast({ title: "Backup kreiran!", description: `${data.channelCount} kanala, ${data.messageCount} poruka, ${data.sizeMB} MB` });
      setShowCreateDialog(false);
      setBackupName("");
    },
    onError: (e: any) => toast({ title: "Greška", description: e.message, variant: "destructive" }),
  });

  // Restore mutation
  const restoreMutation = useMutation({
    mutationFn: async ({ backupId, mode, channelNames, destGuildId, destChannelId }: { backupId: string; mode: string; channelNames?: string[]; destGuildId?: string; destChannelId?: string }) => {
      const res = await apiRequest("POST", `/api/backups/${guildId}/restore/${backupId}`, {
        mode,
        channelNames: channelNames || null,
        targetGuildId: destGuildId || null,
        targetChannelId: destChannelId || null,
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Restore završen!",
        description: `Role: ${data.rolesCreated}, Kategorije: ${data.categoriesCreated}, Kanali: ${data.channelsCreated}, Poruke: ${data.messagesPosted}`,
      });
      setShowRestoreDialog(null);
    },
    onError: (e: any) => toast({ title: "Greška", description: e.message, variant: "destructive" }),
  });

  // Fetch channels from backup when restore dialog opens
  const { data: backupChannels = [], isLoading: backupChannelsLoading } = useQuery<BackupChannel[]>({
    queryKey: ["/api/backups/channels", showRestoreDialog?.id],
    queryFn: async () => {
      if (!showRestoreDialog?.id) return [];
      const r = await fetch(`/api/backups/${showRestoreDialog.id}/channels`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: !!showRestoreDialog?.id,
  });

  // Fetch channels from backup when extract dialog opens
  const { data: extractChannels = [], isLoading: extractChannelsLoading } = useQuery<BackupChannel[]>({
    queryKey: ["/api/backups/channels", showExtractDialog?.id],
    queryFn: async () => {
      if (!showExtractDialog?.id) return [];
      const r = await fetch(`/api/backups/${showExtractDialog.id}/channels`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: !!showExtractDialog?.id,
  });

  // Fetch text channels for extract target
  const { data: extractGuildChannels = [] } = useQuery<GuildChannel[]>({
    queryKey: ["/api/bot/guilds/channels", guildId, "extract"],
    queryFn: async () => {
      if (!guildId) return [];
      const r = await fetch(`/api/bot/guilds/${guildId}/channels`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: !!guildId && !!showExtractDialog,
  });

  // Extract mutation — uses restore API with messages mode
  const extractMutation = useMutation({
    mutationFn: async ({ backupId, channelNames, destChannelId }: { backupId: string; channelNames: string[]; destChannelId?: string }) => {
      const sourceGuildId = showExtractDialog?.guildId || guildId;
      const res = await apiRequest("POST", `/api/backups/${sourceGuildId}/restore/${backupId}`, {
        mode: 'messages',
        channelNames,
        targetGuildId: guildId,
        targetChannelId: destChannelId || null,
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Kanali izvađeni!",
        description: `Poruke: ${data.messagesPosted}, Kanali: ${data.channelsCreated}`,
      });
      setShowExtractDialog(null);
      setExtractSelectedChannels(new Set());
      setExtractTargetChannelId("");
    },
    onError: (e: any) => toast({ title: "Greška", description: e.message, variant: "destructive" }),
  });

  // Reset extract state when dialog opens
  useEffect(() => {
    if (showExtractDialog) {
      setExtractSelectedChannels(new Set());
      setExtractTargetChannelId("");
    }
  }, [showExtractDialog?.id]);

  // Fetch text channels for the target guild
  const effectiveTargetGuild = targetGuildId || guildId;
  const { data: targetGuildChannels = [] } = useQuery<GuildChannel[]>({
    queryKey: ["/api/bot/guilds/channels", effectiveTargetGuild],
    queryFn: async () => {
      if (!effectiveTargetGuild) return [];
      const r = await fetch(`/api/bot/guilds/${effectiveTargetGuild}/channels`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: !!effectiveTargetGuild && !!showRestoreDialog,
  });

  // Reset restore state when dialog opens/closes
  useEffect(() => {
    if (showRestoreDialog) {
      setSelectedChannels(new Set());
      setTargetGuildId("");
      setTargetChannelId("");
      setRestoreMode("messages");
    }
  }, [showRestoreDialog?.id]);

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/backups/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/backups", guildId] });
      toast({ title: "Obrisano", description: "Backup je uspješno obrisan." });
      setShowDeleteConfirm(null);
    },
    onError: (e: any) => toast({ title: "Greška", description: e.message, variant: "destructive" }),
  });

  // Force restore state
  const [forceRestoreActive, setForceRestoreActive] = useState(false);
  const [forceRestoreProgress, setForceRestoreProgress] = useState<{
    phase: string; current: number; total: number; messagesPosted: number; totalMessages: number;
    done?: boolean; cancelled?: boolean; error?: string; result?: any;
  } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Resolved target guild for force restore (defaults to current guild)
  const frTargetGuild = forceRestoreTargetGuildId || guildId;

  // Start polling force restore progress
  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/backups/${frTargetGuild}/forcerestore/progress`, { credentials: "include" });
        if (!r.ok) return;
        const data = await r.json();
        if (!data.active) return;
        setForceRestoreProgress(data);

        if (data.done || data.cancelled || data.error) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          // Auto-cleanup after showing result
          setTimeout(async () => {
            await fetch(`/api/backups/${frTargetGuild}/forcerestore/clear`, { method: 'POST', credentials: 'include' });
          }, 2000);

          if (data.done && data.result) {
            queryClient.invalidateQueries({ queryKey: ["/api/backups", guildId] });
            toast({
              title: "Force Restore završen!",
              description: `Kreirano: ${data.result.rolesCreated} rola, ${data.result.categoriesCreated} kategorija, ${data.result.channelsCreated} kanala, ${data.result.messagesPosted} poruka`,
            });
          } else if (data.cancelled) {
            toast({ title: "Restore otkazan", description: "Force restore je zaustavljen.", variant: "destructive" });
          } else if (data.error) {
            toast({ title: "Greška", description: data.error, variant: "destructive" });
          }

          setTimeout(() => {
            setForceRestoreActive(false);
            setForceRestoreProgress(null);
            setShowForceRestore(null);
            setForceRestoreConfirmText("");
            setForceRestoreTargetGuildId("");
          }, 3000);
        }
      } catch {}
    }, 1500);
  }, [frTargetGuild, guildId, queryClient, toast]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Force restore — start
  const forceRestoreMutation = useMutation({
    mutationFn: async (backupId: string) => {
      const res = await apiRequest("POST", `/api/backups/${frTargetGuild}/forcerestore/${backupId}`, {});
      return res.json();
    },
    onSuccess: () => {
      setForceRestoreActive(true);
      setForceRestoreProgress({ phase: 'Pokrećem...', current: 0, total: 0, messagesPosted: 0, totalMessages: 0 });
      startPolling();
    },
    onError: (e: any) => {
      toast({ title: "Greška", description: e.message, variant: "destructive" });
      setForceRestoreConfirmText("");
    },
  });

  // Force restore — cancel
  const cancelForceRestore = useCallback(async () => {
    try {
      await fetch(`/api/backups/${frTargetGuild}/forcerestore/cancel`, { method: 'POST', credentials: 'include' });
    } catch {}
  }, [frTargetGuild]);

  const totalSize = backups.reduce((sum, b) => sum + parseFloat(b.sizeMB || "0"), 0);
  const autoCount = backups.filter((b) => b.auto).length;
  const manualCount = backups.filter((b) => !b.auto).length;

  return (
    <Card className="p-6 mb-6 card-hover">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <HardDrive className="w-5 h-5 text-primary" />
          <h3 className="font-bold text-lg">Backup & Restore</h3>
          <Badge variant="outline" className="text-xs">{guildName}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-2 border-blue-500/30 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300"
            onClick={() => { setShowExtractPicker(true); setShowExtractDialog(null); }}
          >
            <FolderOutput className="h-4 w-4" /> Izvadi kanale
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
            onClick={() => { setShowForceRestorePicker(true); setShowForceRestore(null); setForceRestoreConfirmText(""); }}
          >
            <Bomb className="h-4 w-4" /> Force Restore
          </Button>
          <Button onClick={() => { setBackupName(`backup_${new Date().toISOString().slice(0, 10)}`); setShowCreateDialog(true); }} className="gap-2" size="sm">
            <Plus className="h-4 w-4" /> Novi Backup
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border/30">
          <Database className="w-4 h-4 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground">Ukupno</p>
            <p className="text-lg font-bold">{backups.length}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border/30">
          <Clock className="w-4 h-4 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground">Auto</p>
            <p className="text-lg font-bold">{autoCount}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border/30">
          <Shield className="w-4 h-4 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground">Ručni</p>
            <p className="text-lg font-bold">{manualCount}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/40 border border-border/30">
          <HardDrive className="w-4 h-4 text-muted-foreground" />
          <div>
            <p className="text-xs text-muted-foreground">Veličina</p>
            <p className="text-lg font-bold">{totalSize.toFixed(1)} MB</p>
          </div>
        </div>
      </div>

      {/* Backup list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : backups.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          Nema backupa. Klikni "Novi Backup" za kreiranje.
        </div>
      ) : (
        <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
          {backups.map((backup) => (
            <div key={backup.id} className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-muted/20 hover:bg-muted/40 transition-colors">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-sm truncate">{backup.name}</p>
                  {backup.auto && <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-blue-500/10 text-blue-400 border-blue-500/30">Auto</Badge>}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {backup.channelCount} kanala · {backup.messageCount} poruka · {backup.sizeMB} MB · {new Date(backup.createdAt).toLocaleDateString("hr-HR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 ml-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs gap-1"
                  onClick={() => { setShowRestoreDialog(backup); setRestoreMode("messages"); }}
                >
                  <RotateCcw className="h-3 w-3" /> Restore
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs gap-1 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  onClick={() => { setShowForceRestore(backup); setForceRestoreConfirmText(""); }}
                >
                  <Bomb className="h-3 w-3" /> Full
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                  onClick={() => setShowDeleteConfirm(backup)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Backup Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="bg-gray-900 border-gray-700 max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <Download className="h-5 w-5" /> Novi Backup
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm text-gray-400 mb-1 block">Naziv backupa</label>
              <Input
                value={backupName}
                onChange={(e) => setBackupName(e.target.value)}
                placeholder="backup_2026-03-26"
                className="bg-gray-800 border-gray-600 text-white"
              />
            </div>
            <p className="text-xs text-gray-400">
              Backup će spremiti sve kanale, poruke, role i kategorije servera <strong>{guildName}</strong> u MongoDB.
              Ovo može potrajati ovisno o broju poruka.
            </p>
            <Button
              onClick={() => createMutation.mutate(backupName)}
              disabled={!backupName.trim() || createMutation.isPending}
              className="w-full"
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Backup u tijeku... (može potrajati)
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" /> Pokreni Backup
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Restore Dialog — Multi-step */}
      <Dialog open={!!showRestoreDialog} onOpenChange={(open) => !open && setShowRestoreDialog(null)}>
        <DialogContent className="bg-gray-900 border-gray-700 max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <Upload className="h-5 w-5" /> Restore Backup
            </DialogTitle>
          </DialogHeader>
          {showRestoreDialog && (
            <div className="space-y-4">
              {/* Backup info */}
              <div className="p-3 rounded-lg bg-gray-800 border border-gray-700">
                <p className="font-medium text-sm text-white">{showRestoreDialog.name}</p>
                <p className="text-xs text-gray-400 mt-1">
                  {showRestoreDialog.channelCount} kanala · {showRestoreDialog.messageCount} poruka · {showRestoreDialog.sizeMB} MB
                </p>
              </div>

              {/* Step 1: Select channels from backup */}
              <div>
                <label className="text-sm text-gray-400 mb-2 block font-medium">1. Odaberi kanale za restore</label>
                {backupChannelsLoading ? (
                  <div className="flex items-center gap-2 py-3 text-gray-400 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" /> Učitavam kanale...
                  </div>
                ) : (
                  <div className="space-y-1 max-h-[200px] overflow-y-auto border border-gray-700 rounded-lg p-2">
                    {/* Select all / none */}
                    <div className="flex items-center gap-2 mb-1 pb-1 border-b border-gray-700">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] text-gray-400"
                        onClick={() => setSelectedChannels(new Set(backupChannels.map(c => c.name)))}
                      >
                        Odaberi sve
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] text-gray-400"
                        onClick={() => setSelectedChannels(new Set())}
                      >
                        Poništi
                      </Button>
                      <span className="text-[11px] text-gray-500 ml-auto">{selectedChannels.size}/{backupChannels.length}</span>
                    </div>
                    {backupChannels.map((ch) => (
                      <label
                        key={ch.name}
                        className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-800 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedChannels.has(ch.name)}
                          onChange={(e) => {
                            const next = new Set(selectedChannels);
                            if (e.target.checked) next.add(ch.name);
                            else next.delete(ch.name);
                            setSelectedChannels(next);
                          }}
                          className="rounded border-gray-600"
                        />
                        <span className="text-sm text-gray-200">#{ch.name}</span>
                        <span className="text-[11px] text-gray-500 ml-auto">
                          {ch.messageCount} poruka{ch.category ? ` · ${ch.category}` : ''}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Step 2: Restore mode */}
              <div>
                <label className="text-sm text-gray-400 mb-1 block font-medium">2. Način restorea</label>
                <Select value={restoreMode} onValueChange={setRestoreMode}>
                  <SelectTrigger className="bg-gray-800 border-gray-600 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-gray-800 border-gray-600">
                    <SelectItem value="messages">📝 Samo poruke — ubacuje poruke u postojeće kanale</SelectItem>
                    <SelectItem value="full">🔧 Full Restore — kreira role, kategorije, kanale i poruke</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Step 3: Target server */}
              <div>
                <label className="text-sm text-gray-400 mb-1 block font-medium">3. Ciljni server</label>
                <Select value={targetGuildId || guildId} onValueChange={(v) => { setTargetGuildId(v === guildId ? "" : v); setTargetChannelId(""); }}>
                  <SelectTrigger className="bg-gray-800 border-gray-600 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-gray-800 border-gray-600">
                    {guilds.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Step 4: Target channel (optional — only if 1 channel selected) */}
              <div>
                <label className="text-sm text-gray-400 mb-1 block font-medium">
                  4. Ciljni kanal {selectedChannels.size > 1 && <span className="text-gray-500 font-normal">(po imenu — više kanala odabrano)</span>}
                </label>
                <Select
                  value={targetChannelId || "__auto__"}
                  onValueChange={(v) => setTargetChannelId(v === "__auto__" ? "" : v)}
                  disabled={selectedChannels.size > 1}
                >
                  <SelectTrigger className="bg-gray-800 border-gray-600 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-gray-800 border-gray-600 max-h-[250px]">
                    <SelectItem value="__auto__">🔄 Automatski po imenu iz backupa</SelectItem>
                    {targetGuildChannels.map((ch) => (
                      <SelectItem key={ch.id} value={ch.id}>
                        #{ch.name} {ch.category ? `(${ch.category})` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Warning */}
              <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-yellow-400 mt-0.5 shrink-0" />
                <div className="text-xs text-yellow-300">
                  {restoreMode === "full" ? (
                    <><strong>Full restore</strong> će kreirati nove role, kategorije i kanale koji ne postoje na ciljnom serveru.</>
                  ) : (
                    <><strong>Restore poruka</strong> ubacuje poruke u kanale s istim imenom (ili u odabrani kanal). Poruke se šalju putem webhookova.</>
                  )}
                </div>
              </div>

              {/* Execute */}
              <Button
                onClick={() => restoreMutation.mutate({
                  backupId: showRestoreDialog.id,
                  mode: restoreMode,
                  channelNames: selectedChannels.size > 0 ? Array.from(selectedChannels) : undefined,
                  destGuildId: targetGuildId || undefined,
                  destChannelId: targetChannelId || undefined,
                })}
                disabled={restoreMutation.isPending || selectedChannels.size === 0}
                className="w-full"
                variant={restoreMode === "full" ? "destructive" : "default"}
              >
                {restoreMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Restore u tijeku... (može potrajati)
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4 mr-2" />
                    Pokreni Restore ({selectedChannels.size} kanala)
                  </>
                )}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Force Restore Dialog — picker or confirm */}
      <Dialog open={showForceRestorePicker || !!showForceRestore} onOpenChange={(open) => {
        if (!open && !forceRestoreActive) {
          setShowForceRestorePicker(false);
          setShowForceRestore(null);
          setForceRestoreConfirmText("");
          setForceRestoreTargetGuildId("");
        }
      }}>
        <DialogContent className="bg-gray-900 border-gray-700 max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <Bomb className="h-5 w-5 text-red-400" /> Force Restore
            </DialogTitle>
          </DialogHeader>

          {/* Step 1: Pick backup from all servers */}
          {showForceRestorePicker && !showForceRestore && !forceRestoreActive && (
            <div className="space-y-3">
              <p className="text-sm text-gray-400">Odaberi backup s bilo kojeg servera za force restore na <strong className="text-white">{guildName}</strong>:</p>
              <div className="space-y-1.5 max-h-[350px] overflow-y-auto pr-1">
                {allBackups.length === 0 ? (
                  <div className="flex items-center justify-center py-6 text-gray-500 text-sm">
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Učitavam backupe...
                  </div>
                ) : allBackups.map((b) => (
                  <button
                    key={b.id}
                    className="w-full text-left p-3 rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 transition-colors"
                    onClick={() => { setShowForceRestore(b); setShowForceRestorePicker(false); setForceRestoreConfirmText(""); }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-white">{b.name}</span>
                      {b.auto && <Badge variant="outline" className="text-[10px] px-1 py-0 bg-blue-500/10 text-blue-400 border-blue-500/30">Auto</Badge>}
                      {b.guildId !== guildId && <Badge variant="outline" className="text-[10px] px-1 py-0 bg-orange-500/10 text-orange-400 border-orange-500/30">{b.guildName}</Badge>}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {b.channelCount} kanala · {b.messageCount} poruka · {b.sizeMB} MB · {new Date(b.createdAt).toLocaleDateString("hr-HR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </button>
                ))}
              </div>
              <Button variant="outline" className="w-full" onClick={() => setShowForceRestorePicker(false)}>
                Odustani
              </Button>
            </div>
          )}

          {/* Step 2: Confirm selected backup */}
          {showForceRestore && !forceRestoreActive && (
            <div className="space-y-4">
              {/* Target guild selector */}
              <div>
                <label className="text-sm text-gray-400 mb-1 block font-medium">Ciljni server (na koji će se restore primijeniti)</label>
                <Select
                  value={forceRestoreTargetGuildId || guildId}
                  onValueChange={(v) => setForceRestoreTargetGuildId(v)}
                >
                  <SelectTrigger className="bg-gray-800 border-gray-600 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-gray-800 border-gray-600">
                    {guilds.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Warning */}
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-5 w-5 text-red-400 mt-0.5 shrink-0" />
                  <div className="text-sm text-red-300">
                    <p className="font-bold mb-1">Ovo je nepovratna akcija!</p>
                    <p className="text-xs text-red-300/80 mb-2">Server <strong>{guilds.find(g => g.id === frTargetGuild)?.name || guildName}</strong> će biti potpuno resetiran i zamjenjen sadržajem iz backupa.</p>
                    <p className="text-xs font-medium mb-1">Što će se dogoditi:</p>
                    <ul className="list-disc list-inside space-y-0.5 text-xs text-red-300/80">
                      <li>Brisanje <strong>svih</strong> kanala i custom rola sa servera</li>
                      <li>Kreiranje rola, kategorija i kanala iz backupa</li>
                      <li>Vraćanje svih poruka, slika i embedova</li>
                    </ul>
                  </div>
                </div>
              </div>

              {/* Backup info */}
              <div className="p-3 rounded-lg bg-gray-800 border border-gray-700">
                <p className="font-medium text-sm text-white">{showForceRestore.name}</p>
                <p className="text-xs text-gray-400 mt-1">
                  {showForceRestore.channelCount} kanala · {showForceRestore.messageCount} poruka · {showForceRestore.sizeMB} MB · {new Date(showForceRestore.createdAt).toLocaleDateString("hr-HR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                </p>
                <p className="text-xs text-orange-400 mt-1">📌 Izvor: {(showForceRestore as any).guildName || guildName} → Cilj: {guilds.find(g => g.id === frTargetGuild)?.name || guildName}</p>
              </div>

              {/* Type confirmation */}
              <div>
                <label className="text-sm text-gray-400 mb-1 block">
                  Upiši <strong className="text-red-400">RESTORE</strong> za potvrdu
                </label>
                <Input
                  value={forceRestoreConfirmText}
                  onChange={(e) => setForceRestoreConfirmText(e.target.value)}
                  placeholder="RESTORE"
                  className="bg-gray-800 border-gray-600 text-white"
                />
              </div>

              {/* Buttons */}
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => { setShowForceRestore(null); setForceRestoreConfirmText(""); setShowForceRestorePicker(false); setForceRestoreTargetGuildId(""); }}>
                  Odustani
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  disabled={forceRestoreConfirmText !== "RESTORE" || forceRestoreMutation.isPending}
                  onClick={() => forceRestoreMutation.mutate(showForceRestore.id)}
                >
                  {forceRestoreMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Pokrećem...
                    </>
                  ) : (
                    <>
                      <Bomb className="h-4 w-4 mr-1" /> Force Restore
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* Progress view — shown while force restore is active */}
          {forceRestoreActive && forceRestoreProgress && (
            <div className="space-y-4">
              {/* Status */}
              <div className="p-4 rounded-lg bg-gray-800 border border-gray-700">
                <div className="flex items-center gap-2 mb-3">
                  {forceRestoreProgress.done ? (
                    <Check className="h-5 w-5 text-green-400" />
                  ) : forceRestoreProgress.cancelled ? (
                    <X className="h-5 w-5 text-red-400" />
                  ) : forceRestoreProgress.error ? (
                    <AlertTriangle className="h-5 w-5 text-red-400" />
                  ) : (
                    <Loader2 className="h-5 w-5 text-blue-400 animate-spin" />
                  )}
                  <span className="font-medium text-white">{forceRestoreProgress.phase}</span>
                </div>

                {/* Progress bar */}
                {forceRestoreProgress.totalMessages > 0 && (
                  <div className="space-y-2">
                    <div className="w-full bg-gray-700 rounded-full h-2.5">
                      <div
                        className="bg-blue-500 h-2.5 rounded-full transition-all duration-500"
                        style={{ width: `${Math.min(100, (forceRestoreProgress.messagesPosted / forceRestoreProgress.totalMessages) * 100)}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-gray-400">
                      <span>{forceRestoreProgress.messagesPosted} / {forceRestoreProgress.totalMessages} poruka</span>
                      <span>{Math.round((forceRestoreProgress.messagesPosted / forceRestoreProgress.totalMessages) * 100)}%</span>
                    </div>
                  </div>
                )}

                {/* Channel progress */}
                {forceRestoreProgress.total > 0 && (
                  <div className="mt-2 text-xs text-gray-400">
                    Kanali: {forceRestoreProgress.current} / {forceRestoreProgress.total}
                  </div>
                )}
              </div>

              {/* Cancel button */}
              {!forceRestoreProgress.done && !forceRestoreProgress.cancelled && !forceRestoreProgress.error && (
                <Button
                  variant="destructive"
                  className="w-full gap-2"
                  onClick={cancelForceRestore}
                >
                  <Square className="h-4 w-4" /> Zaustavi Restore
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Extract Channel — Picker + Dialog */}
      <Dialog open={showExtractPicker || !!showExtractDialog} onOpenChange={(open) => {
        if (!open) { setShowExtractPicker(false); setShowExtractDialog(null); setExtractSelectedChannels(new Set()); setExtractTargetChannelId(""); }
      }}>
        <DialogContent className="bg-gray-900 border-gray-700 max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <FolderOutput className="h-5 w-5 text-blue-400" /> Izvadi kanale iz backupa
            </DialogTitle>
          </DialogHeader>

          {/* Step 1: Pick backup */}
          {showExtractPicker && !showExtractDialog && (
            <div className="space-y-3">
              <p className="text-sm text-gray-400">Odaberi backup iz kojeg želiš izvaditi kanale:</p>
              <div className="space-y-1.5 max-h-[350px] overflow-y-auto pr-1">
                {allBackups.length === 0 ? (
                  <div className="flex items-center justify-center py-6 text-gray-500 text-sm">
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Učitavam backupe...
                  </div>
                ) : allBackups.map((b) => (
                  <button
                    key={b.id}
                    className="w-full text-left p-3 rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 transition-colors"
                    onClick={() => { setShowExtractDialog(b); setShowExtractPicker(false); }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-white">{b.name}</span>
                      {b.auto && <Badge variant="outline" className="text-[10px] px-1 py-0 bg-blue-500/10 text-blue-400 border-blue-500/30">Auto</Badge>}
                      {b.guildId !== guildId && <Badge variant="outline" className="text-[10px] px-1 py-0 bg-orange-500/10 text-orange-400 border-orange-500/30">{b.guildName}</Badge>}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {b.channelCount} kanala · {b.messageCount} poruka · {b.sizeMB} MB · {new Date(b.createdAt).toLocaleDateString("hr-HR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </button>
                ))}
              </div>
              <Button variant="outline" className="w-full" onClick={() => setShowExtractPicker(false)}>
                Odustani
              </Button>
            </div>
          )}

          {/* Step 2: Select channels + target */}
          {showExtractDialog && (
            <div className="space-y-4">
              {/* Backup info */}
              <div className="p-3 rounded-lg bg-gray-800 border border-gray-700">
                <p className="font-medium text-sm text-white">{showExtractDialog.name}</p>
                <p className="text-xs text-gray-400 mt-1">
                  {showExtractDialog.channelCount} kanala · {showExtractDialog.messageCount} poruka · {showExtractDialog.sizeMB} MB
                  {showExtractDialog.guildId !== guildId && showExtractDialog.guildName && (
                    <span className="text-orange-400"> · {showExtractDialog.guildName}</span>
                  )}
                </p>
              </div>

              {/* Channel selection */}
              <div>
                <label className="text-sm text-gray-400 mb-2 block font-medium">1. Odaberi kanale za vađenje</label>
                {extractChannelsLoading ? (
                  <div className="flex items-center gap-2 py-3 text-gray-400 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" /> Učitavam kanale...
                  </div>
                ) : (
                  <div className="space-y-1 max-h-[200px] overflow-y-auto border border-gray-700 rounded-lg p-2">
                    <div className="flex items-center gap-2 mb-1 pb-1 border-b border-gray-700">
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-gray-400"
                        onClick={() => setExtractSelectedChannels(new Set(extractChannels.map(c => c.name)))}>
                        Odaberi sve
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-gray-400"
                        onClick={() => setExtractSelectedChannels(new Set())}>
                        Poništi
                      </Button>
                      <span className="text-[11px] text-gray-500 ml-auto">{extractSelectedChannels.size}/{extractChannels.length}</span>
                    </div>
                    {extractChannels.map((ch) => (
                      <label key={ch.name} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-800 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={extractSelectedChannels.has(ch.name)}
                          onChange={(e) => {
                            const next = new Set(extractSelectedChannels);
                            if (e.target.checked) next.add(ch.name); else next.delete(ch.name);
                            setExtractSelectedChannels(next);
                          }}
                          className="rounded border-gray-600"
                        />
                        <span className="text-sm text-gray-200">#{ch.name}</span>
                        <span className="text-[11px] text-gray-500 ml-auto">
                          {ch.messageCount} poruka{ch.category ? ` · ${ch.category}` : ''}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Target channel */}
              <div>
                <label className="text-sm text-gray-400 mb-1 block font-medium">
                  2. Ciljni kanal na <strong className="text-white">{guildName}</strong>
                  {extractSelectedChannels.size > 1 && <span className="text-gray-500 font-normal"> (po imenu — više kanala odabrano)</span>}
                </label>
                <Select
                  value={extractTargetChannelId || "__auto__"}
                  onValueChange={(v) => setExtractTargetChannelId(v === "__auto__" ? "" : v)}
                  disabled={extractSelectedChannels.size > 1}
                >
                  <SelectTrigger className="bg-gray-800 border-gray-600 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-gray-800 border-gray-600 max-h-[250px]">
                    <SelectItem value="__auto__">🔄 Automatski — po imenu kanala iz backupa</SelectItem>
                    {extractGuildChannels.map((ch) => (
                      <SelectItem key={ch.id} value={ch.id}>
                        #{ch.name} {ch.category ? `(${ch.category})` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500 mt-1">Ako kanal ne postoji, poruke će biti preskočene. Koristi "Full Restore" za kreiranje novih kanala.</p>
              </div>

              {/* Info */}
              <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30 flex items-start gap-2">
                <Database className="h-4 w-4 text-blue-400 mt-0.5 shrink-0" />
                <p className="text-xs text-blue-300">
                  Poruke, slike, embedi i attachmenti odabranih kanala bit će ubačeni u postojeće kanale na serveru. Ovo <strong>neće obrisati</strong> ništa postojeće.
                </p>
              </div>

              {/* Buttons */}
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => { setShowExtractDialog(null); setShowExtractPicker(true); }}>
                  ← Natrag
                </Button>
                <Button
                  className="flex-1"
                  disabled={extractSelectedChannels.size === 0 || extractMutation.isPending}
                  onClick={() => extractMutation.mutate({
                    backupId: showExtractDialog.id,
                    channelNames: Array.from(extractSelectedChannels),
                    destChannelId: extractTargetChannelId || undefined,
                  })}
                >
                  {extractMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Izvlačim... (može potrajati)
                    </>
                  ) : (
                    <>
                      <FolderOutput className="h-4 w-4 mr-2" />
                      Izvadi {extractSelectedChannels.size} {extractSelectedChannels.size === 1 ? 'kanal' : 'kanala'}
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <Dialog open={!!showDeleteConfirm} onOpenChange={(open) => !open && setShowDeleteConfirm(null)}>
        <DialogContent className="bg-gray-900 border-gray-700 max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" /> Obriši Backup
            </DialogTitle>
          </DialogHeader>
          {showDeleteConfirm && (
            <div className="space-y-4">
              <p className="text-sm text-gray-300">
                Jesi li siguran da želiš trajno obrisati backup <strong>"{showDeleteConfirm.name}"</strong>?
              </p>
              <p className="text-xs text-gray-400">
                {showDeleteConfirm.channelCount} kanala · {showDeleteConfirm.messageCount} poruka · {showDeleteConfirm.sizeMB} MB
              </p>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setShowDeleteConfirm(null)}>
                  Odustani
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate(showDeleteConfirm.id)}
                >
                  {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1" />}
                  Obriši
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
