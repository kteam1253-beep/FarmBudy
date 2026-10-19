import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useBotStatus, useBotLogs } from "@/hooks/use-bot";
import { useTheme } from "@/hooks/use-theme";
import { StatusCard } from "@/components/StatusCard";
import { LogsPanel } from "@/components/LogsPanel";
import { ChannelManager } from "@/components/ChannelManager";
import { RequestPanel } from "@/components/RequestPanel";
import { BackupPanel } from "@/components/BackupPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Leaf, Sprout, Rocket, Tractor, Warehouse, Factory, Dog, CloudSun, RefreshCw, Loader2, Send, Settings, Home, Thermometer, Sun, Moon, Users, Clock, Wifi, X, Filter, UserCog, Search, RotateCcw, MessageSquare, MessageSquarePlus, DollarSign, Shield, Save, ShieldOff, Crown, Gamepad2, LogOut, Lock, Unlock, Wrench, Timer, Mail, MapPin, Eye, Map as MapIcon, ArrowRightLeft, Terminal, Power, Square, RotateCw, ScrollText, Globe, Hash, Server as ServerIcon, ChevronRight, Zap, ExternalLink, Download, Trash2, ChevronLeft, Database, FileJson, LayoutGrid } from "lucide-react";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Field, Vehicle, Silo, Production, Animal, Weather, Farm } from "@shared/schema";

interface DiscordChannel {
  id: string;
  name: string;
}

interface PlayerData {
  id: number;
  uniqueUserId: string;
  name: string;
  farmId: string | null;
  playTime: number;
  isOnline: boolean;
  lastPlayed: string | null;
}

interface FillLevel {
  fillType?: string;
  level?: number;
}

interface ProductionIO {
  fillType?: string;
  amount?: number;
}

interface WeatherDay {
  weatherType?: string;
  minTemp?: number;
  maxTemp?: number;
}

function parseFillLevels(data: unknown): FillLevel[] {
  if (!data || !Array.isArray(data)) return [];
  return data as FillLevel[];
}

function parseProductionIO(data: unknown): ProductionIO[] {
  if (!data || !Array.isArray(data)) return [];
  return data as ProductionIO[];
}

function parseWeatherDays(data: unknown): WeatherDay[] {
  if (!data || !Array.isArray(data)) return [];
  return data as WeatherDay[];
}

interface WebPushStatus {
  enabled: boolean;
  configured: boolean;
  tokenSet: boolean;
  timeoutMs: number;
}

interface PlayerLink {
  id: number;
  discordUserId: string;
  uniqueUserId: string;
  playerName: string | null;
  defaultFarmId: string | null;
}

// Farm colors palette - assigned by farmId
const FARM_COLORS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  '0': { bg: 'bg-slate-500/15', border: 'border-slate-500/40', text: 'text-slate-400', dot: 'bg-slate-500' },
  '1': { bg: 'bg-blue-500/15', border: 'border-blue-500/40', text: 'text-blue-400', dot: 'bg-blue-500' },
  '2': { bg: 'bg-amber-500/15', border: 'border-amber-500/40', text: 'text-amber-400', dot: 'bg-amber-500' },
  '3': { bg: 'bg-rose-500/15', border: 'border-rose-500/40', text: 'text-rose-400', dot: 'bg-rose-500' },
  '4': { bg: 'bg-purple-500/15', border: 'border-purple-500/40', text: 'text-purple-400', dot: 'bg-purple-500' },
  '5': { bg: 'bg-cyan-500/15', border: 'border-cyan-500/40', text: 'text-cyan-400', dot: 'bg-cyan-500' },
  '6': { bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', text: 'text-emerald-400', dot: 'bg-emerald-500' },
  '7': { bg: 'bg-orange-500/15', border: 'border-orange-500/40', text: 'text-orange-400', dot: 'bg-orange-500' },
  '8': { bg: 'bg-pink-500/15', border: 'border-pink-500/40', text: 'text-pink-400', dot: 'bg-pink-500' },
};
const DEFAULT_FARM_COLOR = { bg: 'bg-muted/50', border: 'border-border/50', text: 'text-muted-foreground', dot: 'bg-muted-foreground' };

function getFarmColor(farmId: string | null) {
  if (!farmId) return DEFAULT_FARM_COLOR;
  return FARM_COLORS[farmId] || DEFAULT_FARM_COLOR;
}

function getVehicleCategory(name: string, vehType: string | null): string {
  const n = String(name || '').toLowerCase();
  const t = String(vehType || '').toLowerCase();
  if (t.includes('telehandler') || n.includes('telehandler') || n.includes('handler')) return 'Telehandler';
  if (t.includes('forklift') || n.includes('forklift')) return 'Viličar';
  if (t.includes('tractor') || n.includes('tractor')) return 'Traktor';
  if (t.includes('truck') || t.includes('lorry') || n.includes('truck') || n.includes('scania') || n.includes('iveco') || n.includes('daf ') || n.includes('volvo')) return 'Kamion';
  if (t.includes('harvester') || t.includes('combine') || n.includes('harvester') || n.includes('combine') || n.includes('lexion')) return 'Kombajn';
  if (t.includes('loader') || n.includes('wheel loader') || n.includes('front loader') || n.includes('skid steer')) return 'Utovarivač';
  if (t.includes('car') || t.includes('pickup') || t.includes('suv') || n.includes('pickup') || n.includes('gator')) return 'Auto';
  if (t.includes('trailer') || n.includes('trailer')) return 'Prikolica';
  if (t.includes('seeder') || t.includes('planter') || n.includes('seeder') || n.includes('planter')) return 'Sijačica';
  if (t.includes('sprayer') || n.includes('sprayer')) return 'Prskalica';
  if (t.includes('mower') || n.includes('mower')) return 'Kosilica';
  if (t.includes('baler') || n.includes('baler')) return 'Baler';
  if (t.includes('plow') || t.includes('cultivator') || t.includes('subsoiler') || n.includes('plow') || n.includes('cultivator')) return 'Plug/Kultivator';
  return 'Ostalo';
}

function roundTemp(v: unknown): string {
  const n = Number(v);
  if (isNaN(n)) return '--';
  return n.toFixed(1);
}

function formatPlayTime(hours: number): string {
  if (!hours || hours < 0) return '0m';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'nikad';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'N/A';
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'upravo';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

/* ======================================================
 *  MONGODB PANEL – browse collections, view documents, export
 * ====================================================== */
function MongoDbPanel() {
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const limit = 20;

  const dbStats = useQuery<any>({
    queryKey: ["/api/db/stats"],
    queryFn: () => fetch("/api/db/stats").then(r => r.json()),
  });

  const collections = useQuery<{ name: string; count: number }[]>({
    queryKey: ["/api/db/collections"],
    queryFn: () => fetch("/api/db/collections").then(r => r.json()),
  });

  const documents = useQuery<{ documents: any[]; total: number }>({
    queryKey: ["/api/db/collections", selectedCollection, page],
    queryFn: () => fetch(`/api/db/collections/${selectedCollection}?page=${page}&limit=${limit}`).then(r => r.json()),
    enabled: !!selectedCollection,
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ col, id }: { col: string; id: string }) => {
      const res = await fetch(`/api/db/collections/${col}/${id}`, { method: "DELETE" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/db/collections"] });
      if (selectedCollection) queryClient.invalidateQueries({ queryKey: ["/api/db/collections", selectedCollection, page] });
      toast({ title: "Dokument obrisan" });
    },
  });

  const handleExport = (name: string) => {
    window.open(`/api/db/collections/${encodeURIComponent(name)}/export`, "_blank");
  };

  const totalPages = documents.data ? Math.ceil(documents.data.total / limit) : 0;

  return (
    <div className="space-y-4">
      {/* DB Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">Baza</p>
          <p className="font-bold text-lg">{dbStats.data?.db || "—"}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">Kolekcije</p>
          <p className="font-bold text-lg">{dbStats.data?.collections ?? "—"}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">Dokumenti</p>
          <p className="font-bold text-lg">{dbStats.data?.objects?.toLocaleString() ?? "—"}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">Veličina</p>
          <p className="font-bold text-lg">{dbStats.data?.dataSize ? `${(dbStats.data.dataSize / 1024 / 1024).toFixed(2)} MB` : "—"}</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Collections list */}
        <Card className="lg:col-span-1">
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Database className="w-4 h-4" /> Kolekcije
            </CardTitle>
          </CardHeader>
          <CardContent className="p-2 pt-0">
            <div className="space-y-1 max-h-[60vh] overflow-y-auto">
              {collections.isLoading && <p className="text-sm text-muted-foreground p-2">Učitavanje...</p>}
              {collections.data?.map(col => (
                <div
                  key={col.name}
                  className={`flex items-center justify-between p-2 rounded cursor-pointer text-sm hover:bg-muted transition-colors ${selectedCollection === col.name ? "bg-muted font-medium" : ""}`}
                  onClick={() => { setSelectedCollection(col.name); setPage(1); setExpandedDoc(null); }}
                >
                  <span className="truncate">{col.name}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge variant="secondary" className="text-xs">{col.count}</Badge>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); handleExport(col.name); }}>
                      <Download className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Documents view */}
        <Card className="lg:col-span-3">
          <CardHeader className="p-3 pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileJson className="w-4 h-4" />
                {selectedCollection ? `${selectedCollection} (${documents.data?.total ?? 0})` : "Odaberi kolekciju"}
              </CardTitle>
              {selectedCollection && (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => handleExport(selectedCollection)}>
                    <Download className="w-3.5 h-3.5 mr-1" /> Export JSON
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-2 pt-0">
            {!selectedCollection ? (
              <p className="text-sm text-muted-foreground p-4 text-center">Klikni na kolekciju za pregled dokumenata.</p>
            ) : documents.isLoading ? (
              <div className="flex items-center justify-center p-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : (
              <>
                <div className="space-y-2 max-h-[55vh] overflow-y-auto">
                  {documents.data?.documents.map((doc) => {
                    const id = doc._id?.$oid || doc._id?.toString?.() || String(doc._id);
                    const isExpanded = expandedDoc === id;
                    return (
                      <div key={id} className="border rounded p-2 text-xs font-mono">
                        <div className="flex items-center justify-between mb-1">
                          <button className="text-left text-primary hover:underline truncate flex-1" onClick={() => setExpandedDoc(isExpanded ? null : id)}>
                            {isExpanded ? "▼" : "▶"} {id}
                          </button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-destructive hover:text-destructive"
                            onClick={() => { if (confirm("Obrisati ovaj dokument?")) deleteMutation.mutate({ col: selectedCollection, id }); }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                        {isExpanded ? (
                          <pre className="bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all mt-1">{JSON.stringify(doc, null, 2)}</pre>
                        ) : (
                          <p className="text-muted-foreground truncate">{JSON.stringify(doc).slice(0, 120)}...</p>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-2 mt-3">
                    <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <span className="text-sm">{page} / {totalPages}</span>
                    <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ======================================================
 *  BOT SERVER PANEL – shows all Discord guilds + detail
 * ====================================================== */
function BotServerPanel() {
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const botInfo = useQuery<{
    status: string; uptime: number; lastPing: number | null;
    username: string | null; avatar: string | null;
    guildCount: number; totalMembers: number;
  }>({
    queryKey: ['/api/bot/info'],
    queryFn: async () => { const r = await fetch('/api/bot/info'); if (!r.ok) throw new Error('Failed'); return r.json(); },
    refetchInterval: 30000,
  });

  const guildsQuery = useQuery<Array<{
    id: string; name: string; icon: string | null; memberCount: number;
    boostTier: number; boostCount: number; ownerId: string;
    createdAt: string | null; roles: number; channels: number;
    isMain: boolean; isTest: boolean;
  }>>({
    queryKey: ['/api/bot/guilds'],
    queryFn: async () => { const r = await fetch('/api/bot/guilds'); if (!r.ok) throw new Error('Failed'); return r.json(); },
    refetchInterval: 30000,
  });

  const detailQuery = useQuery<{
    id: string; name: string; icon: string | null; banner: string | null;
    memberCount: number; boostTier: number; boostCount: number;
    ownerId: string; createdAt: string | null; description: string | null;
    vanityURLCode: string | null; isMain: boolean; isTest: boolean;
    roles: Array<{ id: string; name: string; color: string; members: number; hoist: boolean; position: number }>;
    channels: { text: number; voice: number; categories: number; total: number };
  }>({
    queryKey: ['/api/bot/guilds', selectedGuildId],
    queryFn: async () => { const r = await fetch(`/api/bot/guilds/${selectedGuildId}`); if (!r.ok) throw new Error('Failed'); return r.json(); },
    enabled: !!selectedGuildId,
  });

  const boostLabel = (tier: number) => tier === 3 ? 'Tier 3' : tier === 2 ? 'Tier 2' : tier === 1 ? 'Tier 1' : 'Nema';
  const boostColor = (tier: number) => tier >= 3 ? 'text-fuchsia-400' : tier >= 2 ? 'text-pink-400' : tier >= 1 ? 'text-purple-400' : 'text-muted-foreground';

  // Detail view
  if (selectedGuildId && detailQuery.data) {
    const g = detailQuery.data;
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setSelectedGuildId(null)}>
          <ChevronRight className="w-4 h-4 mr-1 rotate-180" /> Natrag na popis
        </Button>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              {g.icon ? (
                <img src={g.icon} alt="" className="w-12 h-12 rounded-full" />
              ) : (
                <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center text-lg font-bold">{g.name.charAt(0)}</div>
              )}
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  {g.name}
                  {g.isMain && <Badge className="bg-green-600/20 text-green-400 border-green-600/40 text-[10px]">Glavni</Badge>}
                  {g.isTest && <Badge className="bg-yellow-600/20 text-yellow-400 border-yellow-600/40 text-[10px]">Test</Badge>}
                </CardTitle>
                {g.description && <p className="text-xs text-muted-foreground mt-1">{g.description}</p>}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Stats row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-muted/30 rounded-lg p-3 text-center">
                <Users className="w-4 h-4 mx-auto mb-1 text-blue-400" />
                <div className="text-lg font-bold">{g.memberCount}</div>
                <div className="text-[10px] text-muted-foreground">Članova</div>
              </div>
              <div className="bg-muted/30 rounded-lg p-3 text-center">
                <Zap className={`w-4 h-4 mx-auto mb-1 ${boostColor(g.boostTier)}`} />
                <div className="text-lg font-bold">{g.boostCount}</div>
                <div className="text-[10px] text-muted-foreground">Boost ({boostLabel(g.boostTier)})</div>
              </div>
              <div className="bg-muted/30 rounded-lg p-3 text-center">
                <Shield className="w-4 h-4 mx-auto mb-1 text-amber-400" />
                <div className="text-lg font-bold">{g.roles.length}</div>
                <div className="text-[10px] text-muted-foreground">Uloga</div>
              </div>
              <div className="bg-muted/30 rounded-lg p-3 text-center">
                <Hash className="w-4 h-4 mx-auto mb-1 text-emerald-400" />
                <div className="text-lg font-bold">{g.channels.total}</div>
                <div className="text-[10px] text-muted-foreground">Kanala</div>
              </div>
            </div>

            {/* Channel breakdown */}
            <div className="text-xs text-muted-foreground flex gap-4">
              <span>💬 Text: {g.channels.text}</span>
              <span>🔊 Voice: {g.channels.voice}</span>
              <span>📁 Kategorije: {g.channels.categories}</span>
            </div>

            {g.createdAt && (
              <div className="text-xs text-muted-foreground">
                Kreiran: {new Date(g.createdAt).toLocaleDateString('hr-HR')}
                {g.vanityURLCode && <span className="ml-3">Vanity: discord.gg/{g.vanityURLCode}</span>}
              </div>
            )}

            {/* Roles table */}
            <div>
              <h4 className="text-sm font-medium mb-2 flex items-center gap-1">
                <Shield className="w-4 h-4" /> Uloge ({g.roles.length})
              </h4>
              <div className="max-h-[400px] overflow-y-auto border rounded-lg">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-background border-b">
                    <tr>
                      <th className="text-left p-2">Boja</th>
                      <th className="text-left p-2">Naziv</th>
                      <th className="text-right p-2">Članova</th>
                      <th className="text-right p-2">Pozicija</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.roles.filter(r => r.name !== '@everyone').map(r => (
                      <tr key={r.id} className="border-b border-border/30 hover:bg-muted/20">
                        <td className="p-2">
                          <div className="w-4 h-4 rounded-full border" style={{ backgroundColor: r.color === '#000000' ? 'transparent' : r.color, borderColor: r.color === '#000000' ? 'hsl(var(--border))' : r.color }} />
                        </td>
                        <td className="p-2 font-medium" style={{ color: r.color === '#000000' ? undefined : r.color }}>{r.name}</td>
                        <td className="p-2 text-right text-muted-foreground">{r.members}</td>
                        <td className="p-2 text-right text-muted-foreground">{r.position}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Loading state for detail
  if (selectedGuildId && detailQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
        <span className="ml-2 text-muted-foreground">Učitavanje detalja...</span>
      </div>
    );
  }

  // Main guild list view
  return (
    <div className="space-y-4">
      {/* Bot info card */}
      {botInfo.data && (
        <Card className="border-primary/30">
          <CardContent className="py-4">
            <div className="flex items-center gap-4">
              {botInfo.data.avatar ? (
                <img src={botInfo.data.avatar} alt="" className="w-10 h-10 rounded-full" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                  <ServerIcon className="w-5 h-5 text-primary" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{botInfo.data.username || 'FarmBuddy Bot'}</span>
                  <Badge variant={botInfo.data.status === 'online' ? 'default' : 'secondary'} className={`text-[10px] ${botInfo.data.status === 'online' ? 'bg-green-600/20 text-green-400' : ''}`}>
                    {botInfo.data.status === 'online' ? '🟢 Online' : '🔴 Offline'}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground flex gap-3 mt-1">
                  <span><Globe className="w-3 h-3 inline mr-1" />{botInfo.data.guildCount} servera</span>
                  <span><Users className="w-3 h-3 inline mr-1" />{botInfo.data.totalMembers} članova</span>
                  {botInfo.data.uptime > 0 && (
                    <span><Clock className="w-3 h-3 inline mr-1" />Uptime: {Math.floor(botInfo.data.uptime / 3600)}h {Math.floor((botInfo.data.uptime % 3600) / 60)}m</span>
                  )}
                </div>
              </div>
              <Button variant="outline" size="sm" className="text-xs" onClick={() => guildsQuery.refetch()}>
                {guildsQuery.isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Guild cards grid */}
      {guildsQuery.isLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <span className="ml-2 text-muted-foreground">Učitavanje servera...</span>
        </div>
      )}

      {guildsQuery.data && guildsQuery.data.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Globe className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>Bot nije na nijednom serveru.</p>
          </CardContent>
        </Card>
      )}

      {guildsQuery.data && guildsQuery.data.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {guildsQuery.data.map(g => (
            <Card
              key={g.id}
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => setSelectedGuildId(g.id)}
            >
              <CardContent className="py-4">
                <div className="flex items-center gap-3">
                  {g.icon ? (
                    <img src={g.icon} alt="" className="w-10 h-10 rounded-full" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-bold">{g.name.charAt(0)}</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate flex items-center gap-1.5">
                      {g.name}
                      {g.isMain && <Badge className="bg-green-600/20 text-green-400 border-green-600/40 text-[10px] px-1">Glavni</Badge>}
                      {g.isTest && <Badge className="bg-yellow-600/20 text-yellow-400 border-yellow-600/40 text-[10px] px-1">Test</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground flex gap-3 mt-1">
                      <span><Users className="w-3 h-3 inline mr-0.5" />{g.memberCount}</span>
                      {g.boostTier > 0 && <span className={boostColor(g.boostTier)}><Zap className="w-3 h-3 inline mr-0.5" />{boostLabel(g.boostTier)}</span>}
                      <span><Shield className="w-3 h-3 inline mr-0.5" />{g.roles}</span>
                      <span><Hash className="w-3 h-3 inline mr-0.5" />{g.channels}</span>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

const POSLOVI_STATUS_LABELS: Record<string, { label: string; emoji: string; color: string }> = {
  'OTVORENO': { label: 'Otvoreno', emoji: '🟢', color: 'bg-green-500/20 text-green-400' },
  'PRIHVAĆENO': { label: 'Prihvaćeno', emoji: '🟡', color: 'bg-yellow-500/20 text-yellow-400' },
  'DOVRŠENO': { label: 'Dovršeno', emoji: '✅', color: 'bg-blue-500/20 text-blue-400' },
  'OTKAZANO': { label: 'Otkazano', emoji: '❌', color: 'bg-red-500/20 text-red-400' },
  'ISTEKAO': { label: 'Istekao', emoji: '⏰', color: 'bg-gray-500/20 text-gray-400' },
};

function PosloviPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const contractsQuery = useQuery<any[]>({
    queryKey: ['/api/custom-contracts'],
    queryFn: () => fetch('/api/custom-contracts').then(r => r.json()),
    refetchInterval: 30000,
  });

  const farmsQuery = useQuery<any[]>({
    queryKey: ['/api/farms'],
    queryFn: () => fetch('/api/farms').then(r => r.json()),
    refetchInterval: 60000,
  });

  const actionMutation = useMutation({
    mutationFn: async ({ gameId, action, farmId }: { gameId: number; action: string; farmId: number }) => {
      const r = await fetch(`/api/custom-contracts/${gameId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ farmId }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/custom-contracts'] });
      toast({ title: '✅ Naredba poslana', description: data.message || 'Promjena će se primjeniti na sljedećem syncu.' });
    },
    onError: (e: any) => toast({ title: '❌ Greška', description: e.message, variant: 'destructive' }),
  });

  const contracts = contractsQuery.data || [];
  const farms = farmsQuery.data || [];
  const farmName = (fid: string | null) => {
    if (!fid) return 'N/A';
    const f = farms.find((fm: any) => String(fm.farmId) === String(fid));
    return f?.name || `Farma ${fid}`;
  };

  const filtered = statusFilter === 'all' ? contracts : contracts.filter((c: any) => c.status === statusFilter);

  const open = contracts.filter((c: any) => c.status === 'OTVORENO').length;
  const accepted = contracts.filter((c: any) => c.status === 'PRIHVAĆENO').length;
  const completed = contracts.filter((c: any) => c.status === 'DOVRŠENO').length;

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <div className="text-2xl font-bold text-green-400">{open}</div>
            <div className="text-xs text-muted-foreground">🟢 Otvoreno</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <div className="text-2xl font-bold text-yellow-400">{accepted}</div>
            <div className="text-xs text-muted-foreground">🟡 Prihvaćeno</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <div className="text-2xl font-bold text-blue-400">{completed}</div>
            <div className="text-xs text-muted-foreground">✅ Dovršeno</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <div className="text-2xl font-bold">{contracts.length}</div>
            <div className="text-xs text-muted-foreground">📋 Ukupno</div>
          </CardContent>
        </Card>
      </div>

      {/* Filter + Refresh */}
      <div className="flex items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Filtriraj po statusu" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Svi statusi</SelectItem>
            <SelectItem value="OTVORENO">🟢 Otvoreno</SelectItem>
            <SelectItem value="PRIHVAĆENO">🟡 Prihvaćeno</SelectItem>
            <SelectItem value="DOVRŠENO">✅ Dovršeno</SelectItem>
            <SelectItem value="OTKAZANO">❌ Otkazano</SelectItem>
            <SelectItem value="ISTEKAO">⏰ Istekao</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => contractsQuery.refetch()}>
          <RefreshCw className={`w-4 h-4 mr-1 ${contractsQuery.isFetching ? 'animate-spin' : ''}`} /> Osvježi
        </Button>
      </div>

      {/* Contracts table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">📋 Poslovi na Ugovor</CardTitle>
        </CardHeader>
        <CardContent>
          {contractsQuery.isLoading ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">Nema poslova na ugovor.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50">
                    <th className="text-left py-2 px-2">#</th>
                    <th className="text-left py-2 px-2">Status</th>
                    <th className="text-left py-2 px-2">Posao</th>
                    <th className="text-left py-2 px-2">Polje</th>
                    <th className="text-right py-2 px-2">Nagrada</th>
                    <th className="text-left py-2 px-2">Kreator</th>
                    <th className="text-left py-2 px-2">Izvođač</th>
                    <th className="text-left py-2 px-2">Rok</th>
                    <th className="text-center py-2 px-2">Akcije</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c: any) => {
                    const st = POSLOVI_STATUS_LABELS[c.status] || { label: c.status, emoji: '❓', color: 'bg-gray-500/20' };
                    return (
                      <tr key={c.gameId} className="border-b border-border/30 hover:bg-muted/30">
                        <td className="py-2 px-2 font-mono">{c.gameId}</td>
                        <td className="py-2 px-2">
                          <Badge className={st.color}>{st.emoji} {st.label}</Badge>
                        </td>
                        <td className="py-2 px-2">{c.workType}</td>
                        <td className="py-2 px-2">{c.fieldId || '-'}</td>
                        <td className="py-2 px-2 text-right font-mono">{c.reward?.toLocaleString() || 0}€</td>
                        <td className="py-2 px-2">{farmName(c.creatorFarmId)}</td>
                        <td className="py-2 px-2">{c.contractorFarmId ? farmName(c.contractorFarmId) : '-'}</td>
                        <td className="py-2 px-2 text-xs">{c.duePeriod ? `P${c.duePeriod} D${c.dueDay}` : '-'}</td>
                        <td className="py-2 px-2 text-center">
                          <div className="flex gap-1 justify-center">
                            {c.status === 'OTVORENO' && (
                              <Button size="sm" variant="outline" className="text-green-400 h-7 text-xs"
                                onClick={() => actionMutation.mutate({ gameId: c.gameId, action: 'accept', farmId: parseInt(c.creatorFarmId) || 1 })}
                                disabled={actionMutation.isPending}>
                                Prihvati
                              </Button>
                            )}
                            {c.status === 'PRIHVAĆENO' && (
                              <Button size="sm" variant="outline" className="text-blue-400 h-7 text-xs"
                                onClick={() => actionMutation.mutate({ gameId: c.gameId, action: 'complete', farmId: parseInt(c.contractorFarmId || c.creatorFarmId) || 1 })}
                                disabled={actionMutation.isPending}>
                                Dovrši
                              </Button>
                            )}
                            {(c.status === 'OTVORENO' || c.status === 'PRIHVAĆENO') && (
                              <Button size="sm" variant="outline" className="text-red-400 h-7 text-xs"
                                onClick={() => actionMutation.mutate({ gameId: c.gameId, action: 'cancel', farmId: parseInt(c.creatorFarmId) || 1 })}
                                disabled={actionMutation.isPending}>
                                Otkaži
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CoopMarketPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [adminTab, setAdminTab] = useState<'overview' | 'contracts' | 'deliveries' | 'prices'>('overview');
  const [showCreateContract, setShowCreateContract] = useState(false);
  const [newContract, setNewContract] = useState({ fillType: 'WHEAT', requiredAmount: '50000', bonusPercent: '25', expiresInHours: '24' });
  const [deliveryFilter, setDeliveryFilter] = useState({ farmId: '', fillType: '' });
  const [editingContract, setEditingContract] = useState<any>(null);
  const [editingPrice, setEditingPrice] = useState<any>(null);

  const marketQuery = useQuery<any[]>({
    queryKey: ['/api/coop/market'],
    queryFn: () => fetch('/api/coop/market').then(r => r.json()),
    refetchInterval: 60000,
  });
  const contractsQuery = useQuery<any[]>({
    queryKey: ['/api/coop/contracts'],
    queryFn: () => fetch('/api/coop/contracts').then(r => r.json()),
    refetchInterval: 60000,
  });
  const allContractsQuery = useQuery<any[]>({
    queryKey: ['/api/coop/contracts/all'],
    queryFn: () => fetch('/api/coop/contracts/all?limit=50').then(r => r.json()),
    refetchInterval: 60000,
  });
  const deliveriesQuery = useQuery<any[]>({
    queryKey: ['/api/coop/deliveries', deliveryFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('limit', '100');
      if (deliveryFilter.farmId) params.set('farmId', deliveryFilter.farmId);
      if (deliveryFilter.fillType) params.set('fillType', deliveryFilter.fillType);
      const hasFilter = deliveryFilter.farmId || deliveryFilter.fillType;
      const url = hasFilter ? `/api/coop/deliveries/filter?${params}` : `/api/coop/deliveries?limit=100`;
      return fetch(url).then(r => r.json());
    },
    refetchInterval: 30000,
  });
  const leaderboardQuery = useQuery<any[]>({
    queryKey: ['/api/coop/leaderboard'],
    queryFn: () => fetch('/api/coop/leaderboard').then(r => r.json()),
    refetchInterval: 60000,
  });

  const createContractMutation = useMutation({
    mutationFn: async (data: any) => {
      const r = await fetch('/api/coop/contracts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/coop/contracts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coop/contracts/all'] });
      toast({ title: '✅ Ugovor kreiran' });
      setShowCreateContract(false);
    },
    onError: (e: any) => toast({ title: '❌ Greška', description: e.message, variant: 'destructive' }),
  });

  const updateContractMutation = useMutation({
    mutationFn: async ({ id, ...updates }: any) => {
      const r = await fetch(`/api/coop/contracts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/coop/contracts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coop/contracts/all'] });
      toast({ title: '✅ Ugovor ažuriran' });
      setEditingContract(null);
    },
  });

  const deleteContractMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/coop/contracts/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/coop/contracts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coop/contracts/all'] });
      toast({ title: '✅ Ugovor obrisan' });
    },
  });

  const deleteDeliveryMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/coop/deliveries/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/coop/deliveries'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coop/leaderboard'] });
      toast({ title: '✅ Isporuka obrisana (refund)' });
    },
  });

  const updatePriceMutation = useMutation({
    mutationFn: async ({ fillType, ...updates }: any) => {
      const r = await fetch(`/api/coop/market/${fillType}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/coop/market'] });
      toast({ title: '✅ Cijena ažurirana' });
      setEditingPrice(null);
    },
  });

  const fillEmoji: Record<string, string> = {
    WHEAT: '🌾', BARLEY: '🌾', OAT: '🌾', CANOLA: '🌻', CORN: '🌽',
    SOYBEAN: '🫘', SUNFLOWER: '🌻', SUGARBEET: '🥬', POTATO: '🥔',
    COTTON: '🧶', GRASS_WINDROW: '🌿', STRAW: '🟡', SILAGE: '🟢',
    CHAFF: '🟤', WOOD: '🪵', WOODCHIPS: '🪵',
    MILK: '🥛',
    WOOL: '🐑', EGG: '🥚', HONEY: '🍯', GRAPE: '🍇',
    OLIVE: '🫒', RICE: '🍚', SORGHUM: '🌾', POPLAR: '🌳',
  };

  const fillName: Record<string, string> = {
    WHEAT: 'Pšenica', BARLEY: 'Ječam', OAT: 'Zob', CANOLA: 'Uljana repica', CORN: 'Kukuruz',
    SOYBEAN: 'Soja', SUNFLOWER: 'Suncokret', SUGARBEET: 'Šeć. repa', POTATO: 'Krumpir',
    COTTON: 'Pamuk', GRASS_WINDROW: 'Trava', STRAW: 'Slama', SILAGE: 'Silaža',
    CHAFF: 'Pljeva', WOOD: 'Drvo', WOODCHIPS: 'Sječka', MILK: 'Mlijeko',
    WOOL: 'Vuna', EGG: 'Jaja', HONEY: 'Med', GRAPE: 'Grožđe',
    OLIVE: 'Masline', RICE: 'Riža', SORGHUM: 'Sirak', POPLAR: 'Topola',
  };
  const allFillTypes = Object.keys(fillName);

  const market = marketQuery.data || [];
  const contracts = contractsQuery.data || [];
  const allContracts = allContractsQuery.data || [];
  const deliveries = deliveriesQuery.data || [];
  const leaderboard = leaderboardQuery.data || [];

  const demandLabel = (dl: number) => {
    if (dl >= 1.3) return { text: 'VISOKA', color: 'text-green-500', icon: '🔥' };
    if (dl <= 0.7) return { text: 'NISKA', color: 'text-red-400', icon: '📉' };
    return { text: 'Normalna', color: 'text-muted-foreground', icon: '☑️' };
  };

  const statusBadge = (status: string) => {
    if (status === 'active') return <Badge className="bg-green-600 text-white text-[10px]">Aktivan</Badge>;
    if (status === 'completed') return <Badge className="bg-blue-600 text-white text-[10px]">Ispunjen</Badge>;
    if (status === 'expired') return <Badge variant="outline" className="text-orange-400 text-[10px]">Istekao</Badge>;
    return <Badge variant="outline" className="text-[10px]">{status}</Badge>;
  };

  const totalDelivered = deliveries.reduce((s: number, d: any) => s + (d.totalEarned || 0), 0);
  const totalLiters = deliveries.reduce((s: number, d: any) => s + (d.amount || 0), 0);

  return (
    <div className="space-y-4">
      {/* Admin Sub-Tabs */}
      <div className="flex gap-1 bg-muted/50 rounded-lg p-1">
        {[
          { key: 'overview', label: '📊 Pregled', icon: null },
          { key: 'contracts', label: '📦 Ugovori', icon: null },
          { key: 'deliveries', label: '🚚 Isporuke', icon: null },
          { key: 'prices', label: '💰 Cijene', icon: null },
        ].map(t => (
          <button
            key={t.key}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${adminTab === t.key ? 'bg-primary text-primary-foreground shadow-sm' : 'hover:bg-muted'}`}
            onClick={() => setAdminTab(t.key as any)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══ OVERVIEW TAB ═══ */}
      {adminTab === 'overview' && (
        <>
          {/* Quick Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card>
              <CardContent className="p-3 text-center">
                <div className="text-2xl font-bold text-green-500">{contracts.length}</div>
                <div className="text-xs text-muted-foreground">Aktivni ugovori</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 text-center">
                <div className="text-2xl font-bold">{market.length}</div>
                <div className="text-xs text-muted-foreground">Materijala na tržnici</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 text-center">
                <div className="text-2xl font-bold text-blue-500">${totalDelivered.toLocaleString('hr-HR')}</div>
                <div className="text-xs text-muted-foreground">Ukupno isplaćeno</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3 text-center">
                <div className="text-2xl font-bold">{totalLiters.toLocaleString('hr-HR')}L</div>
                <div className="text-xs text-muted-foreground">Ukupno isporučeno</div>
              </CardContent>
            </Card>
          </div>

          {/* Active Contracts Overview */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between">
                <span className="flex items-center gap-2"><FileJson className="w-4 h-4 text-orange-500" /> Aktivni ugovori</span>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAdminTab('contracts')}>Upravljaj →</Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {contracts.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nema aktivnih ugovora.</p>
              ) : (
                <div className="space-y-2">
                  {contracts.map((c: any, i: number) => {
                    const pct = c.requiredAmount > 0 ? Math.min(100, Math.round((c.deliveredAmount || 0) / c.requiredAmount * 100)) : 0;
                    const expiresH = c.expiresAt ? Math.max(0, Math.ceil((new Date(c.expiresAt).getTime() - Date.now()) / 3600000)) : 0;
                    return (
                      <div key={c._id || i} className="border rounded-lg p-3 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-sm">{fillEmoji[c.fillType] || '📦'} {c.requiredAmount?.toLocaleString('hr-HR')}L {fillName[c.fillType] || c.fillType}</span>
                          <div className="flex items-center gap-2 text-xs">
                            <Badge variant="outline" className="text-green-500">+{c.bonusPercent}%</Badge>
                            <span className="text-muted-foreground">⏳ {expiresH}h</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Progress value={pct} className="flex-1 h-2" />
                          <span className="text-xs font-mono w-24 text-right">{(c.deliveredAmount || 0).toLocaleString('hr-HR')}/{c.requiredAmount?.toLocaleString('hr-HR')}L</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Leaderboard */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><Crown className="w-4 h-4 text-yellow-500" /> Ljestvica farmi</CardTitle>
            </CardHeader>
            <CardContent>
              {leaderboard.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nema podataka.</p>
              ) : (
                <div className="space-y-1">
                  {leaderboard.map((entry: any, i: number) => (
                    <div key={entry._id || i} className="flex items-center justify-between p-2 rounded bg-muted/30">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold w-6 text-center">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`}</span>
                        <span className="font-medium text-sm">Farma {entry._id}</span>
                      </div>
                      <div className="text-right text-sm">
                        <div className="font-mono text-green-500">${(entry.totalEarned || 0).toLocaleString('hr-HR')}</div>
                        <div className="text-xs text-muted-foreground">{(entry.totalAmount || 0).toLocaleString('hr-HR')}L • {entry.deliveryCount || entry.count || 0} isporuka</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* ═══ CONTRACTS TAB ═══ */}
      {adminTab === 'contracts' && (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between">
                <span className="flex items-center gap-2"><FileJson className="w-4 h-4 text-orange-500" /> Upravljanje ugovorima</span>
                <Button size="sm" className="h-7 text-xs" onClick={() => setShowCreateContract(true)}><MessageSquarePlus className="w-3 h-3 mr-1" /> Novi ugovor</Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {allContracts.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nema ugovora u bazi.</p>
              ) : (
                <div className="space-y-2 max-h-[600px] overflow-y-auto">
                  {allContracts.map((c: any) => {
                    const pct = c.requiredAmount > 0 ? Math.min(100, Math.round((c.deliveredAmount || 0) / c.requiredAmount * 100)) : 0;
                    const expiresH = c.expiresAt ? Math.max(0, Math.ceil((new Date(c.expiresAt).getTime() - Date.now()) / 3600000)) : 0;
                    const isActive = c.status === 'active';
                    return (
                      <div key={c._id} className={`border rounded-lg p-3 space-y-2 ${!isActive ? 'opacity-60' : ''}`}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {statusBadge(c.status)}
                            <span className="font-medium text-sm">{fillEmoji[c.fillType] || '📦'} {fillName[c.fillType] || c.fillType}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            {isActive && (
                              <Button variant="ghost" size="sm" className="h-6 w-6 p-0" title="Uredi" onClick={() => setEditingContract(c)}>
                                <Settings className="w-3 h-3" />
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive" title="Obriši"
                              onClick={() => { if (confirm('Obrisati ugovor?')) deleteContractMutation.mutate(String(c._id)); }}>
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        </div>
                        <div className="grid grid-cols-4 gap-2 text-xs">
                          <div><span className="text-muted-foreground">Potrebno:</span> <span className="font-mono">{c.requiredAmount?.toLocaleString('hr-HR')}L</span></div>
                          <div><span className="text-muted-foreground">Isporučeno:</span> <span className="font-mono">{(c.deliveredAmount || 0).toLocaleString('hr-HR')}L</span></div>
                          <div><span className="text-muted-foreground">Bonus:</span> <span className="font-mono text-green-500">+{c.bonusPercent}%</span></div>
                          <div><span className="text-muted-foreground">{isActive ? `Preostalo: ${expiresH}h` : c.status === 'completed' ? 'Ispunjen ✅' : 'Istekao ⏰'}</span></div>
                        </div>
                        {isActive && (
                          <div className="flex items-center gap-2">
                            <Progress value={pct} className="flex-1 h-1.5" />
                            <span className="text-[10px] font-mono">{pct}%</span>
                          </div>
                        )}
                        {c.createdAt && <div className="text-[10px] text-muted-foreground">Kreiran: {new Date(c.createdAt).toLocaleString('hr-HR')}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Create Contract Dialog */}
          <Dialog open={showCreateContract} onOpenChange={setShowCreateContract}>
            <DialogContent>
              <DialogHeader><DialogTitle className="text-sm">📦 Novi Ugovor</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-muted-foreground">Materijal</label>
                  <Select value={newContract.fillType} onValueChange={v => setNewContract(p => ({ ...p, fillType: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {allFillTypes.map(ft => (
                        <SelectItem key={ft} value={ft}>{fillEmoji[ft] || '📦'} {fillName[ft]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Potrebna količina (L)</label>
                  <Input type="number" value={newContract.requiredAmount} onChange={e => setNewContract(p => ({ ...p, requiredAmount: e.target.value }))} />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Bonus postotak (%)</label>
                  <Input type="number" value={newContract.bonusPercent} onChange={e => setNewContract(p => ({ ...p, bonusPercent: e.target.value }))} />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Trajanje (sati)</label>
                  <Input type="number" value={newContract.expiresInHours} onChange={e => setNewContract(p => ({ ...p, expiresInHours: e.target.value }))} />
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="outline" size="sm" onClick={() => setShowCreateContract(false)}>Odustani</Button>
                  <Button size="sm" disabled={createContractMutation.isPending} onClick={() => {
                    createContractMutation.mutate({
                      fillType: newContract.fillType,
                      requiredAmount: Number(newContract.requiredAmount),
                      bonusPercent: Number(newContract.bonusPercent),
                      expiresInHours: Number(newContract.expiresInHours),
                    });
                  }}>
                    {createContractMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
                    Kreiraj
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* Edit Contract Dialog */}
          <Dialog open={!!editingContract} onOpenChange={o => { if (!o) setEditingContract(null); }}>
            <DialogContent>
              <DialogHeader><DialogTitle className="text-sm">⚙️ Uredi Ugovor</DialogTitle></DialogHeader>
              {editingContract && (
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-muted-foreground">Materijal</label>
                    <Select value={editingContract.fillType} onValueChange={v => setEditingContract((p: any) => ({ ...p, fillType: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {allFillTypes.map(ft => (
                          <SelectItem key={ft} value={ft}>{fillEmoji[ft] || '📦'} {fillName[ft]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Potrebna količina (L)</label>
                    <Input type="number" value={editingContract.requiredAmount} onChange={e => setEditingContract((p: any) => ({ ...p, requiredAmount: Number(e.target.value) }))} />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Bonus postotak (%)</label>
                    <Input type="number" value={editingContract.bonusPercent} onChange={e => setEditingContract((p: any) => ({ ...p, bonusPercent: Number(e.target.value) }))} />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Status</label>
                    <Select value={editingContract.status} onValueChange={v => setEditingContract((p: any) => ({ ...p, status: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Aktivan</SelectItem>
                        <SelectItem value="completed">Ispunjen</SelectItem>
                        <SelectItem value="expired">Istekao</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" size="sm" onClick={() => setEditingContract(null)}>Odustani</Button>
                    <Button size="sm" disabled={updateContractMutation.isPending} onClick={() => {
                      updateContractMutation.mutate({
                        id: String(editingContract._id),
                        fillType: editingContract.fillType,
                        requiredAmount: editingContract.requiredAmount,
                        bonusPercent: editingContract.bonusPercent,
                        status: editingContract.status,
                      });
                    }}>
                      {updateContractMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
                      Spremi
                    </Button>
                  </div>
                </div>
              )}
            </DialogContent>
          </Dialog>
        </>
      )}

      {/* ═══ DELIVERIES TAB ═══ */}
      {adminTab === 'deliveries' && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2"><Warehouse className="w-4 h-4 text-blue-500" /> Log isporuka</span>
              <span className="text-xs text-muted-foreground font-normal">{deliveries.length} zapisa</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Filters */}
            <div className="flex gap-2 items-center mb-3 flex-wrap">
              <div className="flex items-center gap-1">
                <Filter className="w-3 h-3 text-muted-foreground" />
                <Input
                  className="h-7 text-xs w-24"
                  placeholder="Farm ID"
                  value={deliveryFilter.farmId}
                  onChange={e => setDeliveryFilter(p => ({ ...p, farmId: e.target.value }))}
                />
              </div>
              <Select value={deliveryFilter.fillType || '__all__'} onValueChange={v => setDeliveryFilter(p => ({ ...p, fillType: v === '__all__' ? '' : v }))}>
                <SelectTrigger className="h-7 text-xs w-36"><SelectValue placeholder="Svi materijali" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Svi materijali</SelectItem>
                  {allFillTypes.map(ft => (
                    <SelectItem key={ft} value={ft}>{fillEmoji[ft] || '📦'} {fillName[ft]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(deliveryFilter.farmId || deliveryFilter.fillType) && (
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setDeliveryFilter({ farmId: '', fillType: '' })}>
                  <X className="w-3 h-3 mr-1" /> Reset
                </Button>
              )}
            </div>

            {deliveries.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nema isporuka{deliveryFilter.farmId || deliveryFilter.fillType ? ' za odabrani filter' : ''}.</p>
            ) : (
              <div className="space-y-1 max-h-[600px] overflow-y-auto">
                {deliveries.map((d: any) => (
                  <div key={d._id} className="flex items-center justify-between p-2 rounded text-xs bg-muted/30 border-b last:border-b-0 group hover:bg-muted/50">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="text-base">{fillEmoji[d.fillType] || '📦'}</span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium">Farma {d.farmId}</span>
                          <span className="text-muted-foreground">•</span>
                          <span>{d.amount?.toLocaleString('hr-HR')}L {fillName[d.fillType] || d.fillType}</span>
                          {d.contractId && <Badge variant="outline" className="text-[9px] px-1">📦 ugovor</Badge>}
                        </div>
                        <div className="text-muted-foreground text-[10px]">
                          {d.createdAt ? new Date(d.createdAt).toLocaleString('hr-HR') : '—'}
                          {d.pricePerUnit ? ` • $${(d.pricePerUnit * 1000).toFixed(0)}/t` : ''}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-green-500 text-sm">${(d.totalEarned || 0).toLocaleString('hr-HR')}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Refund — obriši isporuku"
                        onClick={() => { if (confirm(`Obrisati isporuku? Farma ${d.farmId}, ${d.amount}L ${d.fillType}, $${d.totalEarned}`)) deleteDeliveryMutation.mutate(String(d._id)); }}
                      >
                        <RotateCcw className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ═══ PRICES TAB ═══ */}
      {adminTab === 'prices' && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><DollarSign className="w-4 h-4 text-green-500" /> Upravljanje cijenama</CardTitle>
          </CardHeader>
          <CardContent>
            {market.length === 0 ? (
              <p className="text-muted-foreground text-sm">Tržnica nije inicijalizirana.</p>
            ) : (
              <div className="space-y-1 max-h-[600px] overflow-y-auto">
                {market.map((item: any) => {
                  const d = demandLabel(item.demandLevel || 1);
                  return (
                    <div key={item.fillType} className="flex items-center justify-between p-2 rounded-md bg-muted/50 border group hover:bg-muted/70">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{fillEmoji[item.fillType] || '📦'} {fillName[item.fillType] || item.fillType}</span>
                        <span className={`text-xs ${d.color}`}>{d.icon}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right text-xs">
                          <div className="font-mono">${((item.currentPrice || 0) * 1000).toFixed(0)}/t</div>
                          <div className="text-muted-foreground">Baza: ${((item.basePrice || 0) * 1000).toFixed(0)}/t • Supply: {(item.supplyLevel || 0).toLocaleString('hr-HR')}L</div>
                        </div>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100" title="Uredi cijenu"
                          onClick={() => setEditingPrice({ ...item })}>
                          <Settings className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Edit Price Dialog */}
      <Dialog open={!!editingPrice} onOpenChange={o => { if (!o) setEditingPrice(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle className="text-sm">💰 Uredi cijenu — {editingPrice && (fillName[editingPrice.fillType] || editingPrice.fillType)}</DialogTitle></DialogHeader>
          {editingPrice && (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground">Bazna cijena ($/L)</label>
                <Input type="number" step="0.001" value={editingPrice.basePrice} onChange={e => setEditingPrice((p: any) => ({ ...p, basePrice: Number(e.target.value) }))} />
                <span className="text-[10px] text-muted-foreground">${((editingPrice.basePrice || 0) * 1000).toFixed(0)}/t</span>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Trenutna cijena ($/L)</label>
                <Input type="number" step="0.001" value={editingPrice.currentPrice} onChange={e => setEditingPrice((p: any) => ({ ...p, currentPrice: Number(e.target.value) }))} />
                <span className="text-[10px] text-muted-foreground">${((editingPrice.currentPrice || 0) * 1000).toFixed(0)}/t</span>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Razina potražnje (1.0 = normalna, 1.5 = visoka, 0.5 = niska)</label>
                <Input type="number" step="0.1" value={editingPrice.demandLevel} onChange={e => setEditingPrice((p: any) => ({ ...p, demandLevel: Number(e.target.value) }))} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Supply razina (ukupno isporučenih L — pritisak na cijenu)</label>
                <Input type="number" value={editingPrice.supplyLevel} onChange={e => setEditingPrice((p: any) => ({ ...p, supplyLevel: Number(e.target.value) }))} />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => setEditingPrice(null)}>Odustani</Button>
                <Button size="sm" disabled={updatePriceMutation.isPending} onClick={() => {
                  updatePriceMutation.mutate({
                    fillType: editingPrice.fillType,
                    basePrice: editingPrice.basePrice,
                    currentPrice: editingPrice.currentPrice,
                    demandLevel: editingPrice.demandLevel,
                    supplyLevel: editingPrice.supplyLevel,
                  });
                }}>
                  {updatePriceMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
                  Spremi
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ServerConsolePanel() {
  const { toast } = useToast();
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [tailLines, setTailLines] = useState(100);

  const logQuery = useQuery<{ lines: string[]; total: number; error?: string }>({
    queryKey: ['/api/server/log', tailLines],
    queryFn: async () => {
      const res = await fetch(`/api/server/log?tail=${tailLines}`);
      if (!res.ok) throw new Error('Failed to fetch log');
      return res.json();
    },
    refetchInterval: autoRefresh ? 5000 : false,
  });

  const gportalQuery = useQuery<{ available: boolean; [key: string]: any }>({
    queryKey: ['/api/server/gportal-status'],
    queryFn: async () => {
      const res = await fetch('/api/server/gportal-status');
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    refetchInterval: autoRefresh ? 10000 : false,
  });

  const gportalAction = useMutation({
    mutationFn: async (action: string) => {
      const res = await apiRequest('POST', `/api/server/gportal/${action}`);
      return res.json();
    },
    onSuccess: (_data, action) => {
      toast({ title: 'Uspješno', description: `Server ${action === 'restart' ? 'se restarta' : action === 'start' ? 'se pokreće' : 'je zaustavljen'}.` });
    },
    onError: (error: any) => {
      toast({ title: 'Greška', description: error.message, variant: 'destructive' });
    }
  });

  const saveGameMutation = useMutation({
    mutationFn: () => apiRequest('POST', '/api/game/command', { command: 'saveGame' }),
    onSuccess: () => {
      toast({ title: 'Save Game', description: 'Komanda za spremanje igre poslana.' });
    },
    onError: (error: any) => {
      toast({ title: 'Greška', description: error.message, variant: 'destructive' });
    }
  });

  const gportalAvailable = gportalQuery.data?.available === true;
  const serverStatus = gportalQuery.data?.status || gportalQuery.data?.state;

  useEffect(() => {
    if (logQuery.data && autoRefresh) {
      const el = document.getElementById('server-log-output');
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [logQuery.data, autoRefresh]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Terminal className="w-5 h-5 text-primary" />
          Server Konzola
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Server Controls */}
        <div className="flex flex-wrap gap-3 items-center">
          <Button
            size="sm"
            variant="outline"
            onClick={() => saveGameMutation.mutate()}
            disabled={saveGameMutation.isPending}
          >
            {saveGameMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Save className="w-3 h-3 mr-1" />}
            Save Game
          </Button>

          {gportalAvailable && (
            <>
              <div className="h-6 w-px bg-border" />
              <Badge variant={serverStatus === 'started' || serverStatus === 'running' ? 'default' : 'secondary'} className="text-xs">
                {serverStatus === 'started' || serverStatus === 'running' ? '🟢 Online' : serverStatus === 'stopped' ? '🔴 Stopped' : `⚪ ${serverStatus || 'Unknown'}`}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (confirm('Restartati server?')) gportalAction.mutate('restart');
                }}
                disabled={gportalAction.isPending}
              >
                {gportalAction.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RotateCw className="w-3 h-3 mr-1" />}
                Restart
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  if (confirm('Sigurno zaustaviti server? Igrači će biti izbačeni!')) gportalAction.mutate('stop');
                }}
                disabled={gportalAction.isPending}
              >
                {gportalAction.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Square className="w-3 h-3 mr-1" />}
                Stop
              </Button>
              {(serverStatus === 'stopped') && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (confirm('Pokrenuti server?')) gportalAction.mutate('start');
                  }}
                  disabled={gportalAction.isPending}
                >
                  {gportalAction.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Power className="w-3 h-3 mr-1" />}
                  Start
                </Button>
              )}
            </>
          )}

          {!gportalAvailable && gportalQuery.isFetched && (
            <span className="text-xs text-muted-foreground">
              GPortal API nije konfiguriran (za restart/stop dodajte GPORTAL_TOKEN + gportalServerId)
            </span>
          )}
        </div>

        {/* Log Controls */}
        <div className="flex gap-2 items-center border-t pt-3">
          <ScrollText className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">Server Log</span>
          <div className="ml-auto flex gap-2 items-center">
            <Select value={String(tailLines)} onValueChange={v => setTailLines(Number(v))}>
              <SelectTrigger className="w-24 h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="50">50 linija</SelectItem>
                <SelectItem value="100">100 linija</SelectItem>
                <SelectItem value="200">200 linija</SelectItem>
                <SelectItem value="500">500 linija</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant={autoRefresh ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => setAutoRefresh(!autoRefresh)}
            >
              {autoRefresh ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
              {autoRefresh ? 'Auto ON' : 'Auto OFF'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => logQuery.refetch()}
              disabled={logQuery.isFetching}
            >
              {logQuery.isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            </Button>
          </div>
        </div>

        {/* Log Output */}
        <div
          id="server-log-output"
          className="bg-black text-green-400 font-mono text-[11px] leading-relaxed p-3 rounded-lg overflow-auto max-h-[500px] min-h-[200px] border border-border/30"
        >
          {logQuery.isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Učitavanje loga...
            </div>
          )}
          {logQuery.data?.error && (
            <div className="text-yellow-400">⚠ {logQuery.data.error}</div>
          )}
          {logQuery.data?.lines?.map((line, i) => (
            <div key={i} className={`whitespace-pre-wrap break-all ${
              line.includes('Error') || line.includes('ERROR') ? 'text-red-400' :
              line.includes('Warning') || line.includes('WARN') ? 'text-yellow-400' :
              line.includes('LUA call stack') ? 'text-orange-400' :
              ''
            }`}>
              {line}
            </div>
          ))}
          {logQuery.data && !logQuery.data.error && (
            <div className="text-muted-foreground mt-2 text-[10px]">
              — Prikazano {logQuery.data.lines?.length || 0} / {logQuery.data.total} linija —
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { theme, toggle: toggleTheme } = useTheme();
  const [selectedChannel, setSelectedChannel] = useState<string>("");
  const [selectedFarmFilter, setSelectedFarmFilter] = useState<string>("all");
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerData | null>(null);
  const [discordIdInput, setDiscordIdInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [chatMessage, setChatMessage] = useState("");
  const [chatFromUser, setChatFromUser] = useState("Admin");
  const [moneyFarmId, setMoneyFarmId] = useState("");
  const [moneyAmount, setMoneyAmount] = useState("");
  const [banPlayerName, setBanPlayerName] = useState("");
  const [banPlayerUid, setBanPlayerUid] = useState("");
  const [fmFarmId, setFmFarmId] = useState("");
  const [pmPlayerUid, setPmPlayerUid] = useState("");
  const [pmMessage, setPmMessage] = useState("");
  const [vehTransferId, setVehTransferId] = useState("");
  const [vehTransferFarm, setVehTransferFarm] = useState("");
  const [vehTransferSourceFarm, setVehTransferSourceFarm] = useState("");
  const [vehRepairId, setVehRepairId] = useState("");
  const [vehRepairFarm, setVehRepairFarm] = useState("");
  const [vehRepairCategory, setVehRepairCategory] = useState("");
  const [timeScaleValue, setTimeScaleValue] = useState("");
  const [coopFarmId, setCoopFarmId] = useState("");
  const [coopFillType, setCoopFillType] = useState("");
  const [coopAmount, setCoopAmount] = useState("");
  const [newFarmColor, setNewFarmColor] = useState("1");
  const [newFarmId, setNewFarmId] = useState("");
  const [showOverview, setShowOverview] = useState(false);
  const [fieldStateFieldId, setFieldStateFieldId] = useState("");
  const [fieldStateGroundType, setFieldStateGroundType] = useState("NONE");
  const [fieldStateFruitType, setFieldStateFruitType] = useState("NONE");
  const [fieldStateGrowth, setFieldStateGrowth] = useState("");
  const [fieldStatePlow, setFieldStatePlow] = useState("");
  const [fieldStateSpray, setFieldStateSpray] = useState("");
  const [fieldStateLime, setFieldStateLime] = useState("");
  const [fieldStateWeed, setFieldStateWeed] = useState("");
  const [fieldStateStone, setFieldStateStone] = useState("");
  const [fieldStateRoller, setFieldStateRoller] = useState("");
  const [fieldStateStubble, setFieldStateStubble] = useState("");
  const { data: statusData, isLoading: statusLoading } = useBotStatus();
  const { data: logsData, isLoading: logsLoading } = useBotLogs();

  const { data: fields = [] } = useQuery<Field[]>({ queryKey: ['/api/fields'] });
  const { data: players = [] } = useQuery<PlayerData[]>({ queryKey: ['/api/players'], refetchInterval: 10000 });
  const { data: vehicles = [] } = useQuery<Vehicle[]>({ queryKey: ['/api/vehicles'] });
  const { data: silos = [] } = useQuery<Silo[]>({ queryKey: ['/api/silos'] });
  const { data: productions = [] } = useQuery<Production[]>({ queryKey: ['/api/productions'] });
  const { data: animals = [] } = useQuery<Animal[]>({ queryKey: ['/api/animals'] });
  const { data: weather } = useQuery<Weather | null>({ queryKey: ['/api/weather'] });
  const { data: farms = [] } = useQuery<Farm[]>({ queryKey: ['/api/farms'] });
  const { data: channels = [] } = useQuery<DiscordChannel[]>({ queryKey: ['/api/discord/channels'] });
  const { data: webPushStatus } = useQuery<WebPushStatus>({ queryKey: ['/api/web/push-status'] });
  const { data: playerLinks = [] } = useQuery<PlayerLink[]>({ queryKey: ['/api/player-links'] });
  const { data: farmPlayersData } = useQuery<{ farms: any[]; modSettings: Record<string, any> }>({ queryKey: ['/api/game/farm-players'], refetchInterval: 30000 });

  // Ratar role members from Discord
  const { data: ratarMembers = [] } = useQuery<{ id: string; username: string; displayName: string; avatar: string | null; joinedAt: string | null }[]>({
    queryKey: ['/api/discord/ratar-members'],
    staleTime: 60 * 1000,
  });

  // Removed/archived players
  const { data: removedPlayers = [] } = useQuery<any[]>({ queryKey: ['/api/removed-players'] });

  // Resolve Discord usernames from IDs
  const discordUserIds = playerLinks.map(l => l.discordUserId).filter(Boolean);
  const { data: discordNames = {} } = useQuery<Record<string, string>>({
    queryKey: ['/api/discord/resolve-users', discordUserIds],
    queryFn: async () => {
      if (discordUserIds.length === 0) return {};
      const res = await apiRequest('POST', '/api/discord/resolve-users', { userIds: discordUserIds });
      return res.json();
    },
    enabled: discordUserIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });
  const [copiedDiscordId, setCopiedDiscordId] = useState<string | null>(null);
  const { data: serversData } = useQuery<{ servers: { id: string; name: string; host: string }[]; activeId: string | null }>({ queryKey: ['/api/servers'] });
  const switchServerMutation = useMutation({
    mutationFn: (id: string) => apiRequest('POST', '/api/servers/active', { id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/servers'] });
      toast({ title: 'Server promijenjen', description: 'Aktivni server je promijenjen.' });
    },
  });
  const { data: trackingData } = useQuery<{ tracks: any[]; updatedAt: string | null; mapImageUrl: string | null }>({ queryKey: ['/api/game/tracks'], refetchInterval: 30000 });

  // Unique farm IDs for filter
  const farmIds = Array.from(new Set(farms.filter(f => !String(f.farmId).startsWith('U:')).map(f => f.farmId))).sort();

  const linkPlayerMutation = useMutation({
    mutationFn: async (data: { discordUserId: string; uniqueUserId: string; playerName: string; defaultFarmId?: string }) => {
      const res = await apiRequest('POST', '/api/player-links', data);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/player-links'] });
      queryClient.invalidateQueries({ queryKey: ['/api/removed-players'] });
      setSelectedPlayer(null);
      setDiscordIdInput('');
      if (data?.warning) {
        toast({ title: '⚠️ Upozorenje', description: data.warning, variant: 'destructive', duration: 10000 });
      } else {
        toast({ title: 'Povezano!', description: 'Igrač je povezan s Discord računom.' });
      }
    },
    onError: (error: any) => {
      toast({ title: 'Greška', description: error.message, variant: 'destructive' });
    }
  });

  const unlinkPlayerMutation = useMutation({
    mutationFn: (discordUserId: string) =>
      apiRequest('DELETE', `/api/player-links/${discordUserId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/player-links'] });
      toast({ title: 'Uklonjeno', description: 'Veza s Discordom je uklonjena.' });
    }
  });

  const resetHoursMutation = useMutation({
    mutationFn: () => apiRequest('POST', '/api/players/reset-hours'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/players'] });
      toast({ title: 'Resetirano', description: 'Svi sati igrača su resetirani na 0.' });
    }
  });

  const setPlayerFarmMutation = useMutation({
    mutationFn: (data: { uid: string; farmId: string | null }) =>
      apiRequest('PATCH', `/api/players/${data.uid}/farm`, { farmId: data.farmId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/players'] });
      toast({ title: 'Ažurirano', description: 'Farma igrača je promijenjena.' });
    },
    onError: (error: any) => {
      toast({ title: 'Greška', description: error.message, variant: 'destructive' });
    }
  });

  const gameCommandMutation = useMutation({
    mutationFn: (payload: { command: string; params?: Record<string, string> }) =>
      apiRequest('POST', '/api/game/command', payload),
    onSuccess: (data: any) => {
      toast({ title: 'Komanda poslana!', description: `Komanda ${data.command} poslana u igru.` });
      setChatMessage('');
      setMoneyAmount('');
      setPmMessage('');
      setVehTransferId('');
      setVehRepairId('');
      setTimeScaleValue('');
    },
    onError: (error: any) => {
      toast({ title: 'Greška', description: error.message || 'Komanda nije poslana', variant: 'destructive' });
    }
  });

  const syncMutation = useMutation({
    mutationFn: () => apiRequest('POST', '/api/sync'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fields'] });
      queryClient.invalidateQueries({ queryKey: ['/api/vehicles'] });
      queryClient.invalidateQueries({ queryKey: ['/api/silos'] });
      queryClient.invalidateQueries({ queryKey: ['/api/productions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/animals'] });
      queryClient.invalidateQueries({ queryKey: ['/api/weather'] });
      queryClient.invalidateQueries({ queryKey: ['/api/farms'] });
    }
  });

  const sendToDiscordMutation = useMutation({
    mutationFn: (dataType: string) => apiRequest('POST', '/api/discord/send', { channelId: selectedChannel, dataType }),
    onSuccess: (data: any) => {
      toast({
        title: "Uspjesno poslano!",
        description: `Podaci poslani u Discord kanal.`,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/bot/logs'] });
    },
    onError: (error: any) => {
      toast({
        title: "Greska",
        description: error.message || "Nije moguce poslati poruku",
        variant: "destructive"
      });
    }
  });

  const sendToWebMutation = useMutation({
    mutationFn: (dataType: string) => apiRequest('POST', '/api/web/send', { dataType }),
    onSuccess: () => {
      toast({
        title: 'Uspješno poslano!',
        description: 'Podaci poslani na web endpoint.',
      });
    },
    onError: (error: any) => {
      toast({
        title: 'Greška',
        description: error.message || 'Nije moguće poslati na web endpoint',
        variant: 'destructive'
      });
    }
  });

  const handleSendToDiscord = (dataType: string) => {
    if (!selectedChannel) {
      toast({
        title: "Odaberi kanal",
        description: "Molim odaberi Discord kanal prije slanja.",
        variant: "destructive"
      });
      return;
    }
    sendToDiscordMutation.mutate(dataType);
  };

  const handleSendToWeb = (dataType: string) => {
    sendToWebMutation.mutate(dataType);
  };

  const formatUptime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m ${seconds % 60}s`;
  };

  const getStatusColor = (status: string) => {
    const lower = status?.toLowerCase() || '';
    if (lower.includes('ready') || lower.includes('harvest')) return 'bg-green-500';
    if (lower.includes('growing')) return 'bg-yellow-500';
    if (lower.includes('planted') || lower.includes('seeded')) return 'bg-blue-500';
    return 'bg-gray-500';
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-primary/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-primary/5 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2" />
      </div>

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
        <header className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <img src="/logo.png" alt="FarmBudy" className="w-12 h-12 rounded-xl shadow-lg" />
              <h1 className="text-4xl md:text-5xl font-display font-bold text-foreground tracking-tight">
                Farm<span className="text-primary">Budy</span>
              </h1>
            </div>
            <p className="text-lg text-muted-foreground max-w-xl">
              Slavonska Ravnica — FS25 Server Dashboard
            </p>
          </div>
          
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Pretraži..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 w-40 md:w-56 h-9"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2">
                  <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              className="rounded-full btn-glow"
              title={theme === 'dark' ? 'Svijetla tema' : 'Tamna tema'}
            >
              {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </Button>
            <Button 
              variant="default" 
              size="sm" 
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="btn-glow"
              data-testid="button-sync"
            >
              {syncMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-2" />
              )}
              Sync
            </Button>
            <Link href="/deploy">
              <Button variant="outline" size="sm" className="btn-glow" data-testid="button-go-to-deploy">
                <Rocket className="w-4 h-4 mr-2" />
                Deploy
              </Button>
            </Link>

            <div className={`flex items-center gap-2 px-4 py-2 backdrop-blur-sm rounded-full border text-sm font-medium ${statusData?.status === 'online' ? 'border-primary/30 text-primary bg-primary/10' : 'border-destructive/30 text-destructive bg-destructive/10'}`}>
              <div className={`w-2 h-2 rounded-full ${statusData?.status === 'online' ? 'bg-primary animate-pulse' : 'bg-destructive'}`} />
              <span>{statusData?.status === 'online' ? 'Online' : 'Offline'}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full text-muted-foreground hover:text-destructive"
              title="Odjavi se"
              onClick={async () => {
                await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
                window.location.reload();
              }}
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </header>

        <Tabs defaultValue="map" className="w-full">
          <TabsList className="sticky top-0 z-50 grid w-full grid-cols-10 mb-6 bg-background/95 backdrop-blur-md border border-primary/20 shadow-lg shadow-primary/10 rounded-lg p-1.5">
            <TabsTrigger value="map" data-testid="tab-map" className="tab-glow rounded-md hover:bg-primary/10 hover:text-primary data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-md">
              <MapIcon className="w-4 h-4 mr-2" />
              Karta
            </TabsTrigger>
            <TabsTrigger value="logs" data-testid="tab-logs" className="tab-glow rounded-md hover:bg-primary/10 hover:text-primary data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-md">
              Logovi
            </TabsTrigger>
            <TabsTrigger value="market" data-testid="tab-market" className="tab-glow rounded-md hover:bg-primary/10 hover:text-primary data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-md">
              <DollarSign className="w-4 h-4 mr-2" />
              Tržnica
            </TabsTrigger>
            <TabsTrigger value="poslovi" data-testid="tab-poslovi" className="tab-glow rounded-md hover:bg-primary/10 hover:text-primary data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-md">
              📋 Poslovi
            </TabsTrigger>
            <TabsTrigger value="admin" data-testid="tab-admin" className="tab-glow rounded-md hover:bg-primary/10 hover:text-primary data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-md">
              <Settings className="w-4 h-4 mr-2" />
              Admin
            </TabsTrigger>
            <TabsTrigger value="backup" data-testid="tab-backup" className="tab-glow rounded-md hover:bg-primary/10 hover:text-primary data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-md">
              <Database className="w-4 h-4 mr-2" />
              Backup
            </TabsTrigger>
            <TabsTrigger value="console" data-testid="tab-console" className="tab-glow rounded-md hover:bg-primary/10 hover:text-primary data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-md">
              <Terminal className="w-4 h-4 mr-2" />
              Konzola
            </TabsTrigger>
            <TabsTrigger value="server" data-testid="tab-server" className="tab-glow rounded-md hover:bg-primary/10 hover:text-primary data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-md">
              <Globe className="w-4 h-4 mr-2" />
              Server
            </TabsTrigger>
            <TabsTrigger value="database" data-testid="tab-database" className="tab-glow rounded-md hover:bg-primary/10 hover:text-primary data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-md">
              <Warehouse className="w-4 h-4 mr-2" />
              Baza
            </TabsTrigger>
            <TabsTrigger value="channels" data-testid="tab-channels" className="tab-glow rounded-md hover:bg-primary/10 hover:text-primary data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-md">
              <LayoutGrid className="w-4 h-4 mr-2" />
              Kanali
            </TabsTrigger>
            <TabsTrigger value="requests" data-testid="tab-requests" className="tab-glow rounded-md hover:bg-primary/10 hover:text-primary data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-md">
              <MessageSquarePlus className="w-4 h-4 mr-2" />
              Zahtjevi
            </TabsTrigger>
          </TabsList>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
          <StatusCard 
            type="status"
            label="Bot Status"
            value={statusData?.status || 'offline'}
            isLoading={statusLoading}
            subtext={statusData?.status === 'online' ? 'Online' : 'Offline'}
          />
          <Card className="p-4 card-hover">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Sprout className="w-4 h-4 text-primary" />
              <span className="text-xs">Polja</span>
            </div>
            <p className="text-2xl font-bold">{fields.length}</p>
          </Card>
          <Card className="p-4 card-hover">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Tractor className="w-4 h-4 text-primary" />
              <span className="text-xs">Vozila</span>
            </div>
            <p className="text-2xl font-bold">{vehicles.length}</p>
          </Card>
          <Card className="p-4 card-hover">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Warehouse className="w-4 h-4 text-primary" />
              <span className="text-xs">Silosi</span>
            </div>
            <p className="text-2xl font-bold">{silos.length}</p>
          </Card>
          <Card className="p-4 card-hover">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Dog className="w-4 h-4 text-primary" />
              <span className="text-xs">Životinje</span>
            </div>
            <p className="text-2xl font-bold">{animals.reduce((acc, a) => acc + (a.numAnimals || 0), 0)}</p>
          </Card>
        </div>

        {/* Collapsible overview toggle */}
        <button
          onClick={() => setShowOverview(!showOverview)}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors mb-4 text-sm text-muted-foreground"
        >
          <ChevronRight className={`w-4 h-4 transition-transform ${showOverview ? 'rotate-90' : ''}`} />
          <Users className="w-4 h-4" />
          <span>Igrači ({players.filter(p => p.isOnline).length} online / {players.length} ukupno) & Server Preview</span>
        </button>

        {showOverview && <>
        {/* Online Players Bar */}
        {players.length > 0 && (() => {
          // Build lookup: uniqueUserId → farmId from farmPlayersData
          const playerFarmLookup = new Map<string, string>();
          (farmPlayersData?.farms || []).forEach((farm: any) => {
            (farm.players || []).forEach((fp: any) => {
              if (fp.uniqueUserId) playerFarmLookup.set(String(fp.uniqueUserId), String(farm.farmId));
            });
          });
          return (
          <Card className="mb-8 p-4 card-hover">
            <div className="flex items-center gap-2 mb-3">
              <Users className="w-4 h-4 text-primary" />
              <span className="font-semibold text-sm">Igrači ({players.filter(p => p.isOnline).length} online / {players.length} ukupno)</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {[...players]
                .sort((a, b) => (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0))
                .map(p => {
                  const resolvedFarmId = p.farmId || playerFarmLookup.get(p.uniqueUserId) || null;
                  const fc = getFarmColor(resolvedFarmId);
                  const link = playerLinks.find(l => l.uniqueUserId === p.uniqueUserId);
                  return (
                    <div
                      key={p.id}
                      className={`flex items-center gap-3 p-3 rounded-lg border-l-4 border cursor-pointer transition-all duration-200 hover:scale-[1.02] hover:brightness-125 hover:shadow-lg ${fc.bg} ${fc.border}`}
                      onClick={() => { setSelectedPlayer(p); setDiscordIdInput(link?.discordUserId || ''); }}
                    >
                      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${p.isOnline ? 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]' : fc.dot + '/40'}`} />
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${fc.text}`}>{p.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {resolvedFarmId ? (farms.find(f => String(f.farmId) === String(resolvedFarmId))?.name || `Farma ${resolvedFarmId}`) : 'Bez farme'} · {formatPlayTime(p.playTime)}
                          {!p.isOnline && p.lastPlayed && ` · ${timeAgo(p.lastPlayed)}`}
                        </p>
                        {link && (
                          <p className="text-xs opacity-60 relative group/discord">
                            🔗 <span
                              className="cursor-pointer hover:underline hover:opacity-100 transition-opacity"
                              title={`ID: ${link.discordUserId} — klikni za kopiranje`}
                              onClick={(e) => {
                                e.stopPropagation();
                                navigator.clipboard.writeText(link.discordUserId);
                                setCopiedDiscordId(link.discordUserId);
                                setTimeout(() => setCopiedDiscordId(null), 2000);
                              }}
                            >
                              {discordNames[link.discordUserId] || link.discordUserId}
                            </span>
                            {copiedDiscordId === link.discordUserId && (
                              <span className="ml-2 text-green-400 text-[10px] animate-pulse">✓ Kopirano!</span>
                            )}
                          </p>
                        )}
                      </div>
                      {p.isOnline && <Wifi className="w-3.5 h-3.5 text-green-500 shrink-0" />}
                    </div>
                  );
                })}
            </div>
          </Card>
          );
        })()}

        {/* Server Preview Card */}
        <div className="relative group/preview mb-8">
        <Card className="p-5 card-hover border-primary/20 bg-gradient-to-br from-primary/5 via-background to-primary/5 cursor-default">
          <div className="flex items-center gap-2 mb-4">
            <Eye className="w-5 h-5 text-primary" />
            <h3 className="font-bold text-lg">Server Preview</h3>
            <span className="text-xs text-muted-foreground ml-auto opacity-0 group-hover/preview:opacity-100 transition-opacity">⬇ Detalji</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* Weather Mini */}
            <div className="rounded-lg bg-muted/40 p-3 border border-border/30">
              <div className="flex items-center gap-2 mb-1">
                <CloudSun className="w-4 h-4 text-primary" />
                <span className="text-xs text-muted-foreground">Vrijeme</span>
              </div>
              {weather ? (
                <>
                  <p className="text-xl font-bold">{roundTemp((weather.current as any)?.temperature)}°C</p>
                  <p className="text-xs text-muted-foreground">
                    {String((weather.current as any)?.weatherType || '').toLowerCase() === 'snow' ? '❄️ Snijeg' :
                     String((weather.current as any)?.weatherType || '').toLowerCase() === 'rain' ? '🌧️ Kiša' :
                     String((weather.current as any)?.weatherType || '').toLowerCase() === 'clear' ? '☀️ Vedro' :
                     String((weather.current as any)?.weatherType || '').toLowerCase() === 'cloudy' ? '☁️ Oblačno' :
                     String((weather.current as any)?.weatherType || '').toLowerCase() === 'storm' ? '⛈️ Oluja' :
                     String((weather.current as any)?.weatherType || '').toLowerCase() === 'fog' ? '🌫️ Magla' :
                     (weather.current as any)?.weatherType || 'N/A'}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">N/A</p>
              )}
            </div>
            {/* Players Mini */}
            <div className="rounded-lg bg-muted/40 p-3 border border-border/30">
              <div className="flex items-center gap-2 mb-1">
                <Users className="w-4 h-4 text-primary" />
                <span className="text-xs text-muted-foreground">Igrači</span>
              </div>
              <p className="text-xl font-bold">{players.filter(p => p.isOnline).length}<span className="text-sm font-normal text-muted-foreground">/{players.length}</span></p>
              <p className="text-xs text-muted-foreground">online / ukupno</p>
            </div>
            {/* Farms Mini */}
            <div className="rounded-lg bg-muted/40 p-3 border border-border/30">
              <div className="flex items-center gap-2 mb-1">
                <Home className="w-4 h-4 text-primary" />
                <span className="text-xs text-muted-foreground">Farme</span>
              </div>
              <div className="flex gap-1 flex-wrap">
                {farms.filter(f => !String(f.farmId).startsWith('U:')).map(farm => {
                  const fc = getFarmColor(farm.farmId);
                  return (
                    <span key={farm.id} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${fc.bg} ${fc.border} ${fc.text} border`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${fc.dot}`} />
                      F{farm.farmId}
                    </span>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-1">{farms.filter(f => !String(f.farmId).startsWith('U:')).reduce((a, f) => a + (f.balance || 0), 0).toLocaleString()}€ ukupno</p>
            </div>
            {/* Time Settings Mini */}
            <div className="rounded-lg bg-muted/40 p-3 border border-border/30">
              <div className="flex items-center gap-2 mb-1">
                <Timer className="w-4 h-4 text-primary" />
                <span className="text-xs text-muted-foreground">Postavke vremena</span>
              </div>
              {farmPlayersData?.modSettings ? (
                <div className="space-y-1 text-xs">
                  <p>Brzina: <span className="font-medium text-foreground">{farmPlayersData.modSettings.timeScale ?? 'N/A'}x</span></p>
                  <p>Offset: <span className="font-medium text-foreground">{farmPlayersData.modSettings.serverOffset != null ? `UTC${(Number(farmPlayersData.modSettings.serverOffset) - 12) >= 0 ? '+' : ''}${Number(farmPlayersData.modSettings.serverOffset) - 12}` : 'N/A'}</span></p>
                  <p>Sync: <span className={`font-medium ${farmPlayersData.modSettings.timeSyncEnable ? 'text-green-400' : 'text-red-400'}`}>{farmPlayersData.modSettings.timeSyncEnable ? 'ON' : 'OFF'}</span></p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">N/A</p>
              )}
            </div>
          </div>
          {/* Weather Forecast Row */}
          {weather && parseWeatherDays(weather.daily).length > 0 && (
            <div className="mt-3 flex gap-2 overflow-x-auto">
              {parseWeatherDays(weather.daily).slice(0, 5).map((day, i) => (
                <div key={i} className="flex-1 min-w-0 bg-muted/30 rounded p-2 text-center border border-border/20">
                  <p className="text-[10px] text-muted-foreground">Dan {i + 1}</p>
                  <p className="text-xs font-medium">
                    {String(day.weatherType || '').toLowerCase() === 'snow' ? '❄️' :
                     String(day.weatherType || '').toLowerCase() === 'rain' ? '🌧️' :
                     String(day.weatherType || '').toLowerCase() === 'clear' ? '☀️' :
                     String(day.weatherType || '').toLowerCase() === 'cloudy' ? '☁️' :
                     String(day.weatherType || '').toLowerCase() === 'storm' ? '⛈️' :
                     String(day.weatherType || '').toLowerCase() === 'fog' ? '🌫️' : '🌤️'}
                  </p>
                  <p className="text-[10px]">{roundTemp(day.minTemp)}°–{roundTemp(day.maxTemp)}°</p>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Hover Expanded Details Panel */}
        <div className="absolute left-0 right-0 top-full z-50 pt-1 opacity-0 invisible group-hover/preview:opacity-100 group-hover/preview:visible transition-all duration-300 ease-out">
          <Card className="p-5 border-primary/30 bg-background/98 backdrop-blur-xl shadow-2xl shadow-primary/10">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {/* Column 1: Farm Balances */}
              <div>
                <h4 className="text-sm font-bold text-primary mb-3 flex items-center gap-2"><DollarSign className="w-4 h-4" /> Stanje farmi</h4>
                <div className="space-y-2">
                  {farms.filter(f => !String(f.farmId).startsWith('U:')).map(farm => {
                    const fc = getFarmColor(farm.farmId);
                    return (
                      <div key={farm.id} className={`flex items-center justify-between p-2 rounded-lg border-l-3 ${fc.bg} ${fc.border} border`}>
                        <div className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${fc.dot}`} />
                          <span className={`text-sm font-medium ${fc.text}`}>{farm.name || `Farma ${farm.farmId}`}</span>
                        </div>
                        <span className="text-sm font-bold text-foreground">{(farm.balance || 0).toLocaleString()}€</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Column 2: Online Players */}
              <div>
                <h4 className="text-sm font-bold text-primary mb-3 flex items-center gap-2"><Users className="w-4 h-4" /> Online igrači</h4>
                {players.filter(p => p.isOnline).length > 0 ? (
                  <div className="space-y-2">
                    {players.filter(p => p.isOnline).map(p => {
                      const pFarm = p.farmId || null;
                      const fc = getFarmColor(pFarm);
                      return (
                        <div key={p.id} className={`flex items-center gap-2 p-2 rounded-lg border ${fc.bg} ${fc.border}`}>
                          <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]" />
                          <span className={`text-sm font-medium ${fc.text}`}>{p.name}</span>
                          <span className="text-xs text-muted-foreground ml-auto">{formatPlayTime(p.playTime)}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Nitko nije online</p>
                )}
                {players.filter(p => !p.isOnline).length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs text-muted-foreground mb-1">Offline ({players.filter(p => !p.isOnline).length})</p>
                    <div className="flex flex-wrap gap-1">
                      {players.filter(p => !p.isOnline).slice(0, 8).map(p => (
                        <span key={p.id} className="text-xs px-2 py-0.5 rounded bg-muted/50 text-muted-foreground">{p.name}</span>
                      ))}
                      {players.filter(p => !p.isOnline).length > 8 && <span className="text-xs text-muted-foreground">+{players.filter(p => !p.isOnline).length - 8}</span>}
                    </div>
                  </div>
                )}
              </div>

              {/* Column 3: Server Stats */}
              <div>
                <h4 className="text-sm font-bold text-primary mb-3 flex items-center gap-2"><Tractor className="w-4 h-4" /> Statistika servera</h4>
                <div className="space-y-2">
                  <div className="flex justify-between p-2 rounded-lg bg-muted/30 border border-border/20">
                    <span className="text-sm text-muted-foreground flex items-center gap-2"><Sprout className="w-3.5 h-3.5" /> Polja</span>
                    <span className="text-sm font-bold">{fields.length}</span>
                  </div>
                  <div className="flex justify-between p-2 rounded-lg bg-muted/30 border border-border/20">
                    <span className="text-sm text-muted-foreground flex items-center gap-2"><Tractor className="w-3.5 h-3.5" /> Vozila</span>
                    <span className="text-sm font-bold">{vehicles.length}</span>
                  </div>
                  <div className="flex justify-between p-2 rounded-lg bg-muted/30 border border-border/20">
                    <span className="text-sm text-muted-foreground flex items-center gap-2"><Warehouse className="w-3.5 h-3.5" /> Silosi</span>
                    <span className="text-sm font-bold">{silos.length}</span>
                  </div>
                  <div className="flex justify-between p-2 rounded-lg bg-muted/30 border border-border/20">
                    <span className="text-sm text-muted-foreground flex items-center gap-2"><Factory className="w-3.5 h-3.5" /> Proizvodnje</span>
                    <span className="text-sm font-bold">{productions.length}</span>
                  </div>
                  <div className="flex justify-between p-2 rounded-lg bg-muted/30 border border-border/20">
                    <span className="text-sm text-muted-foreground flex items-center gap-2"><Dog className="w-3.5 h-3.5" /> Životinje</span>
                    <span className="text-sm font-bold">{animals.reduce((acc, a) => acc + (a.numAnimals || 0), 0)}</span>
                  </div>
                  {silos.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-border/20">
                      <p className="text-xs text-muted-foreground mb-1">Top silosi po popunjenosti:</p>
                      {[...silos].sort((a, b) => (b.percent || 0) - (a.percent || 0)).slice(0, 3).map(s => (
                        <div key={s.id} className="flex items-center gap-2 text-xs mt-1">
                          <span className="truncate flex-1 text-foreground">{s.name}</span>
                          <Progress value={s.percent || 0} className="h-1.5 w-16" />
                          <span className="text-muted-foreground w-8 text-right">{Math.round(s.percent || 0)}%</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </Card>
        </div>
        </div>
        </>}

          {/* Farm filter bar */}
          {farmIds.length > 1 && (
            <div className="flex items-center gap-2 mb-4">
              <Filter className="w-4 h-4 text-muted-foreground" />
              <Select value={selectedFarmFilter} onValueChange={setSelectedFarmFilter}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="Sve farme" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Sve farme</SelectItem>
                  {farmIds.map(fid => {
                    const farm = farms.find(f => f.farmId === fid);
                    return (
                      <SelectItem key={fid} value={fid}>
                        {farm?.name || `Farma ${fid}`}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {selectedFarmFilter !== 'all' && (
                <Button variant="ghost" size="sm" onClick={() => setSelectedFarmFilter('all')}>
                  <X className="w-4 h-4" />
                </Button>
              )}
            </div>
          )}

          {/* Map Tab */}
          <TabsContent value="map">
            <Card className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <MapIcon className="w-5 h-5 text-primary" />
                <h3 className="font-bold text-lg">Karta servera</h3>
                {trackingData?.updatedAt && (
                  <span className="text-xs text-muted-foreground ml-auto">Ažurirano: {timeAgo(trackingData.updatedAt)}</span>
                )}
              </div>
              {(() => {
                // Use server bounds
                const bounds = trackingData as any;
                const serverMinX = Number(bounds?.worldMinX ?? -1750);
                const serverMaxX = Number(bounds?.worldMaxX ?? 1750);
                const serverMinZ = Number(bounds?.worldMinZ ?? -1750);
                const serverMaxZ = Number(bounds?.worldMaxZ ?? 1750);
                const serverBoundsValid = serverMinX < serverMaxX && serverMinZ < serverMaxZ;

                // Collect all known data coordinates (fields, vehicles)
                const allAbsCoords: number[] = [];
                for (const f of fields) {
                  if (f.posX != null && f.posZ != null && !(f.posX === 0 && f.posZ === 0)) {
                    allAbsCoords.push(Math.abs(f.posX), Math.abs(f.posZ));
                  }
                }
                for (const v of vehicles) {
                  if (v.position) {
                    const parts = String(v.position).split(' ').map(Number);
                    if (parts.length >= 3 && !parts.some(isNaN) && !(parts[0] === 0 && parts[2] === 0)) {
                      allAbsCoords.push(Math.abs(parts[0]), Math.abs(parts[2]));
                    }
                  }
                }

                // Auto-detect FS25 terrain half-size from data coordinates
                // FS25 terrains use power-of-2 sizes: 1024→±512, 2048→±1024, 4096→±2048, 8192→±4096
                const stdHalfSizes = [512, 1024, 2048, 4096, 8192];
                const maxAbsCoord = allAbsCoords.length > 0 ? Math.max(...allAbsCoords) : 0;
                const detectedHalfSize = stdHalfSizes.find(h => h > maxAbsCoord * 1.02) || 2048;

                // If server-provided bounds look like unconfigured defaults (±1750) and we have data,
                // override with auto-detected terrain size for correct image placement
                const isDefaultBounds = Math.abs(serverMinX + 1750) < 1 && Math.abs(serverMaxX - 1750) < 1;
                const useAutoDetect = isDefaultBounds && allAbsCoords.length > 0;

                // Map image bounds — the extent the map image actually covers
                let imgMinX: number, imgMaxX: number, imgMinZ: number, imgMaxZ: number;
                if (useAutoDetect) {
                  imgMinX = -detectedHalfSize;
                  imgMaxX = detectedHalfSize;
                  imgMinZ = -detectedHalfSize;
                  imgMaxZ = detectedHalfSize;
                } else {
                  imgMinX = Number(bounds?.mapImageMinX ?? (serverBoundsValid ? serverMinX : -1750));
                  imgMaxX = Number(bounds?.mapImageMaxX ?? (serverBoundsValid ? serverMaxX : 1750));
                  imgMinZ = Number(bounds?.mapImageMinZ ?? (serverBoundsValid ? serverMinZ : -1750));
                  imgMaxZ = Number(bounds?.mapImageMaxZ ?? (serverBoundsValid ? serverMaxZ : 1750));
                }

                // Viewport = image bounds (which now match terrain), extended for any outlier data
                let dataMinX = imgMinX;
                let dataMaxX = imgMaxX;
                let dataMinZ = imgMinZ;
                let dataMaxZ = imgMaxZ;

                // Extend bounds to include all field positions
                for (const f of fields) {
                  if (f.posX != null && f.posZ != null && !(f.posX === 0 && f.posZ === 0)) {
                    dataMinX = Math.min(dataMinX, f.posX);
                    dataMaxX = Math.max(dataMaxX, f.posX);
                    dataMinZ = Math.min(dataMinZ, f.posZ);
                    dataMaxZ = Math.max(dataMaxZ, f.posZ);
                  }
                }
                // Extend bounds to include all vehicle positions
                for (const v of vehicles) {
                  if (v.position) {
                    const parts = String(v.position).split(' ').map(Number);
                    if (parts.length >= 3 && !parts.some(isNaN)) {
                      dataMinX = Math.min(dataMinX, parts[0]);
                      dataMaxX = Math.max(dataMaxX, parts[0]);
                      dataMinZ = Math.min(dataMinZ, parts[2]);
                      dataMaxZ = Math.max(dataMaxZ, parts[2]);
                    }
                  }
                }

                // Add small padding around bounds
                const padAmount = Math.max((dataMaxX - dataMinX), (dataMaxZ - dataMinZ)) * 0.03;
                const minX = dataMinX - padAmount;
                const maxX = dataMaxX + padAmount;
                const minZ = dataMinZ - padAmount;
                const maxZ = dataMaxZ + padAmount;

                const rangeX = Math.max(1, maxX - minX);
                const rangeZ = Math.max(1, maxZ - minZ);
                const PAD = 30;
                const MAP_SIZE = 900;
                const INNER = MAP_SIZE - PAD * 2;
                const toSvgX = (wx: number) => PAD + ((wx - minX) / rangeX) * INNER;
                const toSvgY = (wz: number) => PAD + ((wz - minZ) / rangeZ) * INNER;

                // Image position in SVG space (may be smaller/different than full INNER if image bounds differ from world bounds)
                const imgX = toSvgX(imgMinX);
                const imgY = toSvgY(imgMinZ);
                const imgW = ((imgMaxX - imgMinX) / rangeX) * INNER;
                const imgH = ((imgMaxZ - imgMinZ) / rangeZ) * INNER;

                const vehWithPos = vehicles.filter(v => {
                  if (!v.position) return false;
                  const parts = String(v.position).split(' ').map(Number);
                  return parts.length >= 3 && !parts.some(isNaN);
                });

                const fieldsWithPos = fields.filter(f => f.posX != null && f.posZ != null && !(f.posX === 0 && f.posZ === 0));
                const tracks = trackingData?.tracks || [];
                const hasData = vehWithPos.length > 0 || fieldsWithPos.length > 0 || (tracks as any[]).length > 0;

                // Grid lines — only axis labels on edge, fewer lines
                const gridStep = Math.pow(10, Math.floor(Math.log10(Math.max(rangeX, rangeZ) / 4)));
                const gridStepNice = gridStep >= rangeX / 3 ? gridStep / 2 : gridStep;

                // Vehicle category SVG icons
                const vehIcon = (cat: string) => {
                  switch (cat) {
                    case 'Traktor': return '🚜';
                    case 'Kombajn': return '🌾';
                    case 'Kamion': return '🚛';
                    case 'Auto': return '🚗';
                    case 'Utovarivač': return '🏗️';
                    default: return '⚙️';
                  }
                };

                return (
                  <div className="relative w-full" style={{ paddingBottom: '100%' }}>
                    <svg
                      viewBox={`0 0 ${MAP_SIZE} ${MAP_SIZE}`}
                      className="absolute inset-0 w-full h-full rounded-lg overflow-hidden"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      {/* Background */}
                      <rect x="0" y="0" width={MAP_SIZE} height={MAP_SIZE} fill="#0a0f1a" />

                      {/* Map image — positioned according to image bounds */}
                      <image href={trackingData?.mapImageUrl || '/api/game/map-image'} x={imgX} y={imgY} width={imgW} height={imgH} preserveAspectRatio="none" opacity="0.95" />

                      {/* Subtle grid */}
                      {(() => {
                        const lines: JSX.Element[] = [];
                        let i = 0;
                        for (let wx = Math.ceil(minX / gridStepNice) * gridStepNice; wx <= maxX; wx += gridStepNice) {
                          const sx = toSvgX(wx);
                          lines.push(
                            <g key={`gv-${i}`}>
                              <line x1={sx} y1={PAD} x2={sx} y2={MAP_SIZE - PAD} stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" />
                              <text x={sx} y={PAD - 5} fill="#64748b" fontSize="9" textAnchor="middle" fontFamily="monospace">{Math.round(wx)}</text>
                            </g>
                          );
                          i++;
                        }
                        for (let wz = Math.ceil(minZ / gridStepNice) * gridStepNice; wz <= maxZ; wz += gridStepNice) {
                          const sy = toSvgY(wz);
                          lines.push(
                            <g key={`gh-${i}`}>
                              <line x1={PAD} y1={sy} x2={MAP_SIZE - PAD} y2={sy} stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" />
                              <text x={PAD - 4} y={sy + 3} fill="#64748b" fontSize="9" textAnchor="end" fontFamily="monospace">{Math.round(wz)}</text>
                            </g>
                          );
                          i++;
                        }
                        return lines;
                      })()}

                      {/* Map border */}
                      <rect x={PAD} y={PAD} width={INNER} height={INNER} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />

                      {/* Field positions — small teal badges */}
                      {fieldsWithPos.map(f => {
                        const px = toSvgX(Number(f.posX));
                        const py = toSvgY(Number(f.posZ));
                        if (px < PAD || px > MAP_SIZE - PAD || py < PAD || py > MAP_SIZE - PAD) return null;
                        const isOwned = (f as any).isOwned;
                        return (
                          <g key={`field-${f.id}`}>
                            <rect x={px - 8} y={py - 6} width="16" height="12" fill={isOwned ? '#047857' : '#1e3a2f'} rx="2" stroke={isOwned ? '#10b981' : '#2dd4bf'} strokeWidth="0.8" opacity={isOwned ? 0.9 : 0.5} />
                            <text x={px} y={py + 3} fill={isOwned ? '#6ee7b7' : '#5eead4'} fontSize="7" textAnchor="middle" fontWeight="bold" opacity={isOwned ? 1 : 0.7}>{f.fieldId}</text>
                            <title>Polje #{f.fieldId}{isOwned ? ' (tvoje)' : ''} — {f.fruitName || 'Prazno'} ({f.fieldArea?.toFixed(1)} ha)</title>
                          </g>
                        );
                      })}

                      {/* Vehicle positions — colored circles with emoji category */}
                      {vehWithPos.map(v => {
                        const parts = String(v.position).split(' ').map(Number);
                        const [vx, , vz] = parts;
                        const px = toSvgX(vx);
                        const py = toSvgY(vz);
                        if (px < PAD || px > MAP_SIZE - PAD || py < PAD || py > MAP_SIZE - PAD) return null;
                        const color = v.farmId ? ({
                          '0': '#64748b', '1': '#3b82f6', '2': '#f59e0b', '3': '#f43f5e',
                          '4': '#a855f7', '5': '#06b6d4', '6': '#10b981', '7': '#f97316', '8': '#ec4899'
                        } as Record<string, string>)[v.farmId] || '#94a3b8' : '#94a3b8';
                        const cat = getVehicleCategory(v.name, v.vehType);
                        const icon = vehIcon(cat);
                        return (
                          <g key={`veh-${v.id}`}>
                            <circle cx={px} cy={py} r="9" fill={color} opacity="0.85" stroke="#000" strokeWidth="1.5" />
                            <text x={px} y={py + 4} textAnchor="middle" fontSize="9">{icon}</text>
                            <title>{v.name} (F{v.farmId}) — {cat}</title>
                          </g>
                        );
                      })}

                      {/* Player tracking lines */}
                      {(tracks as any[]).map((track: any, idx: number) => {
                        const pts = (track.points || []) as Array<{ x: number; z: number; t: number }>;
                        if (pts.length < 2) return null;
                        const colors = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#f97316', '#ec4899'];
                        const color = colors[idx % colors.length];
                        const polyPoints = pts.map(p => `${toSvgX(p.x).toFixed(1)},${toSvgY(p.z).toFixed(1)}`).join(' ');
                        const lastPt = pts[pts.length - 1];
                        const lastPx = toSvgX(lastPt.x);
                        const lastPy = toSvgY(lastPt.z);
                        return (
                          <g key={`track-${idx}`}>
                            <polyline points={polyPoints} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
                            <circle cx={lastPx} cy={lastPy} r="7" fill={color} stroke="#000" strokeWidth="1.5" />
                            <text x={lastPx} y={lastPy + 3} textAnchor="middle" fontSize="8">👤</text>
                            <text x={lastPx + 12} y={lastPy + 4} fill={color} fontSize="11" fontWeight="bold" stroke="#000" strokeWidth="0.4">{track.nickname || track.id}</text>
                          </g>
                        );
                      })}

                      {/* Empty state */}
                      {!hasData && (
                        <g>
                          <rect x={MAP_SIZE/2 - 140} y={MAP_SIZE/2 - 40} width="280" height="80" rx="8" fill="#111827" stroke="#334155" strokeWidth="1" opacity="0.95" />
                          <text x={MAP_SIZE / 2} y={MAP_SIZE / 2 - 8} fill="#94a3b8" fontSize="15" textAnchor="middle" fontWeight="bold">Nema podataka za prikaz</text>
                          <text x={MAP_SIZE / 2} y={MAP_SIZE / 2 + 18} fill="#64748b" fontSize="11" textAnchor="middle">{fields.length} polja · {vehicles.length} vozila</text>
                        </g>
                      )}

                      {/* Stats bar at bottom */}
                      {hasData && (
                        <text x={PAD + 4} y={MAP_SIZE - 8} fill="#64748b" fontSize="9" fontFamily="monospace">
                          {vehWithPos.length > 0 ? `${vehWithPos.length} vozila` : ''}{vehWithPos.length > 0 && fieldsWithPos.length > 0 ? ' · ' : ''}{fieldsWithPos.length > 0 ? `${fieldsWithPos.length} polja` : ''}{(tracks as any[]).length > 0 ? ` · ${(tracks as any[]).length} igrača` : ''}
                        </text>
                      )}
                    </svg>
                  </div>
                );
              })()}
              {/* Legend */}
              <div className="flex gap-4 mt-3 flex-wrap text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5"><span className="text-sm">🚜</span> Traktor</div>
                <div className="flex items-center gap-1.5"><span className="text-sm">🌾</span> Kombajn</div>
                <div className="flex items-center gap-1.5"><span className="text-sm">🚛</span> Kamion</div>
                <div className="flex items-center gap-1.5"><span className="text-sm">🚗</span> Auto</div>
                <div className="flex items-center gap-1.5"><span className="text-sm">⚙️</span> Ostalo</div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-2.5 rounded-sm border border-emerald-500/60 bg-emerald-900/50 text-[6px] text-emerald-300 flex items-center justify-center font-bold">1</div> Polje</div>
                <div className="flex items-center gap-1.5"><span className="text-sm">👤</span> Igrač</div>
              </div>
              {/* Farm colors legend */}
              <div className="flex gap-3 mt-2 flex-wrap text-xs text-muted-foreground">
                <span className="font-medium">Farme:</span>
                {[
                  { id: '1', color: '#3b82f6', name: 'F1' }, { id: '2', color: '#f59e0b', name: 'F2' },
                  { id: '3', color: '#f43f5e', name: 'F3' }, { id: '4', color: '#a855f7', name: 'F4' },
                  { id: '5', color: '#06b6d4', name: 'F5' }, { id: '6', color: '#10b981', name: 'F6' },
                ].map(f => (
                  <div key={f.id} className="flex items-center gap-1">
                    <div className="w-3 h-3 rounded-full border border-black/30" style={{ backgroundColor: f.color }} />
                    {farms.find(fm => String(fm.farmId) === f.id)?.name || f.name}
                  </div>
                ))}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="logs">
            <div className="h-[600px]">
              <LogsPanel logs={logsData || []} isLoading={logsLoading} />
            </div>
          </TabsContent>
          <TabsContent value="admin">
            {/* Registrirane Farme */}
            {farms.filter(f => !String(f.farmId).startsWith('U:')).length > 0 && (
              <Card className="p-6 mb-6">
                <h3 className="font-bold text-lg mb-4">Registrirane Farme</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {farms
                    .filter(f => !String(f.farmId).startsWith('U:'))
                    .map((farm) => {
                      const fc = getFarmColor(farm.farmId);
                      return (
                        <div key={farm.id} className={`rounded-lg p-4 border ${fc.bg} ${fc.border}`}>
                          <h4 className="font-bold">{farm.name}</h4>
                          <p className="text-sm text-muted-foreground">ID: {farm.farmId}</p>
                          <p className="text-sm text-muted-foreground">Vlasnik: {farm.owner || 'N/A'}</p>
                          <p className="font-bold text-primary mt-2">{farm.balance?.toLocaleString() || 0}€</p>
                        </div>
                      );
                    })}
                </div>
              </Card>
            )}

            {/* Discord Send Panel */}
            <Card className="p-6 mb-6" data-testid="admin-panel">
              <div className="flex items-center gap-3 mb-6">
                <Settings className="w-6 h-6" />
                <h3 className="font-bold text-xl">Slanje u Discord</h3>
              </div>
              
              <div className="mb-6">
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Odaberi Discord kanal:
                </label>
                <Select value={selectedChannel} onValueChange={setSelectedChannel}>
                  <SelectTrigger className="w-full md:w-80" data-testid="select-channel">
                    <SelectValue placeholder="Odaberi kanal..." />
                  </SelectTrigger>
                  <SelectContent>
                    {channels.map((channel) => (
                      <SelectItem key={channel.id} value={channel.id}>
                        #{channel.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 lg:grid-cols-10 gap-3">
                <Button onClick={() => handleSendToDiscord('status')} disabled={sendToDiscordMutation.isPending || !selectedChannel} size="sm" data-testid="button-send-status">
                  {sendToDiscordMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
                  Status
                </Button>
                <Button onClick={() => handleSendToDiscord('farms')} disabled={sendToDiscordMutation.isPending || !selectedChannel} variant="outline" size="sm" data-testid="button-send-farms"><Home className="w-4 h-4 mr-1" />Farme</Button>
                <Button onClick={() => handleSendToDiscord('fields')} disabled={sendToDiscordMutation.isPending || !selectedChannel} variant="outline" size="sm" data-testid="button-send-fields"><Sprout className="w-4 h-4 mr-1" />Polja</Button>
                <Button onClick={() => handleSendToDiscord('vehicles')} disabled={sendToDiscordMutation.isPending || !selectedChannel} variant="outline" size="sm" data-testid="button-send-vehicles"><Tractor className="w-4 h-4 mr-1" />Vozila</Button>
                <Button onClick={() => handleSendToDiscord('silos')} disabled={sendToDiscordMutation.isPending || !selectedChannel} variant="outline" size="sm" data-testid="button-send-silos"><Warehouse className="w-4 h-4 mr-1" />Silosi</Button>
                <Button onClick={() => handleSendToDiscord('productions')} disabled={sendToDiscordMutation.isPending || !selectedChannel} variant="outline" size="sm" data-testid="button-send-productions"><Factory className="w-4 h-4 mr-1" />Proizvodnje</Button>
                <Button onClick={() => handleSendToDiscord('animals')} disabled={sendToDiscordMutation.isPending || !selectedChannel} variant="outline" size="sm" data-testid="button-send-animals"><Dog className="w-4 h-4 mr-1" />Životinje</Button>
                <Button onClick={() => handleSendToDiscord('weather')} disabled={sendToDiscordMutation.isPending || !selectedChannel} variant="outline" size="sm" data-testid="button-send-weather"><Thermometer className="w-4 h-4 mr-1" />Vrijeme</Button>
                <Button onClick={() => handleSendToDiscord('players')} disabled={sendToDiscordMutation.isPending || !selectedChannel} variant="outline" size="sm"><Users className="w-4 h-4 mr-1" />Igrači</Button>
                <Button onClick={() => handleSendToDiscord('player_hours')} disabled={sendToDiscordMutation.isPending || !selectedChannel} variant="outline" size="sm"><Clock className="w-4 h-4 mr-1" />Sati</Button>
              </div>

              {!selectedChannel && channels.length > 0 && (
                <p className="text-sm text-muted-foreground mt-4">
                  Odaberi kanal da omogucis slanje poruka u Discord.
                </p>
              )}
              {channels.length === 0 && (
                <p className="text-sm text-amber-600 mt-4">
                  Bot nije povezan ili nema dostupnih kanala. Provjeri da je bot online.
                </p>
              )}
            </Card>

            {/* Webhook Panel */}
            <Card className="p-6 mb-6" data-testid="web-push-panel">
              <div className="flex items-center gap-3 mb-6">
                <Rocket className="w-6 h-6" />
                <h3 className="font-bold text-xl">Slanje na Web (Webhook)</h3>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 lg:grid-cols-10 gap-3">
                <Button onClick={() => handleSendToWeb('status')} disabled={sendToWebMutation.isPending} size="sm" data-testid="button-web-status">
                  {sendToWebMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}Status
                </Button>
                <Button onClick={() => handleSendToWeb('farms')} disabled={sendToWebMutation.isPending} variant="outline" size="sm" data-testid="button-web-farms"><Home className="w-4 h-4 mr-1" />Farme</Button>
                <Button onClick={() => handleSendToWeb('fields')} disabled={sendToWebMutation.isPending} variant="outline" size="sm" data-testid="button-web-fields"><Sprout className="w-4 h-4 mr-1" />Polja</Button>
                <Button onClick={() => handleSendToWeb('vehicles')} disabled={sendToWebMutation.isPending} variant="outline" size="sm" data-testid="button-web-vehicles"><Tractor className="w-4 h-4 mr-1" />Vozila</Button>
                <Button onClick={() => handleSendToWeb('silos')} disabled={sendToWebMutation.isPending} variant="outline" size="sm" data-testid="button-web-silos"><Warehouse className="w-4 h-4 mr-1" />Silosi</Button>
                <Button onClick={() => handleSendToWeb('productions')} disabled={sendToWebMutation.isPending} variant="outline" size="sm" data-testid="button-web-productions"><Factory className="w-4 h-4 mr-1" />Proizvodnje</Button>
                <Button onClick={() => handleSendToWeb('animals')} disabled={sendToWebMutation.isPending} variant="outline" size="sm" data-testid="button-web-animals"><Dog className="w-4 h-4 mr-1" />Životinje</Button>
                <Button onClick={() => handleSendToWeb('weather')} disabled={sendToWebMutation.isPending} variant="outline" size="sm" data-testid="button-web-weather"><Thermometer className="w-4 h-4 mr-1" />Vrijeme</Button>
                <Button onClick={() => handleSendToWeb('players')} disabled={sendToWebMutation.isPending} variant="outline" size="sm"><Users className="w-4 h-4 mr-1" />Igrači</Button>
                <Button onClick={() => handleSendToWeb('player_hours')} disabled={sendToWebMutation.isPending} variant="outline" size="sm"><Clock className="w-4 h-4 mr-1" />Sati</Button>
              </div>

              <p className="text-sm text-muted-foreground mt-4">
                Za ovo mora biti postavljen <strong>WEB_PUSH_URL</strong> (i opcionalno <strong>WEB_PUSH_TOKEN</strong>) u env varijablama.
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                Status: {webPushStatus?.enabled ? '✅ omogućeno' : '⏸ opcionalno/isključeno'} | timeout: {webPushStatus?.timeoutMs ?? 4000}ms. Ako web ne radi, bot nastavlja normalno.
              </p>
            </Card>

            {/* Player Links Management */}
            <Card className="p-6 mb-6">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <UserCog className="w-6 h-6" />
                  <h3 className="font-bold text-xl">Povezani igrači (Discord ↔ Igra)</h3>
                  <Badge variant="outline" className="text-xs">{playerLinks.length} povezano</Badge>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  className="btn-glow"
                  disabled={resetHoursMutation.isPending}
                  onClick={() => {
                    if (confirm('Jesi li siguran? Ovo će resetirati sate svih igrača na 0.')) {
                      resetHoursMutation.mutate();
                    }
                  }}
                >
                  {resetHoursMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-1" />}
                  Reset sati
                </Button>
              </div>
              {playerLinks.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nema povezanih igrača. Klikni na igrača iznad da ga povežeš s Discord računom.</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {playerLinks.map(link => {
                    const fc = getFarmColor(link.defaultFarmId);
                    return (
                      <div key={link.id} className={`p-3 rounded-lg border ${fc.bg} ${fc.border} flex items-center justify-between`}>
                        <div>
                          <p className="font-medium text-sm">{link.playerName || link.uniqueUserId}</p>
                          <p
                            className="text-xs text-muted-foreground cursor-pointer hover:text-primary transition-colors"
                            title={link.discordUserId}
                            onClick={() => {
                              navigator.clipboard.writeText(link.discordUserId);
                              setCopiedDiscordId(link.discordUserId);
                              setTimeout(() => setCopiedDiscordId(null), 2000);
                            }}
                          >
                            Discord: {copiedDiscordId === link.discordUserId ? '✓ Kopirano!' : (discordNames[link.discordUserId] || link.discordUserId)}
                          </p>
                          {link.defaultFarmId && <p className="text-xs text-muted-foreground">Farma: {link.defaultFarmId}</p>}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="shrink-0"
                          onClick={() => unlinkPlayerMutation.mutate(link.discordUserId)}
                        >
                          <X className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* Ratar Members from Discord */}
            <Card className="p-6 mb-6">
              <div className="flex items-center gap-3 mb-4">
                <Leaf className="w-6 h-6 text-green-500" />
                <h3 className="font-bold text-xl">🌾 Ratari na Discordu</h3>
                <Badge variant="secondary" className="text-xs">{ratarMembers.length}</Badge>
              </div>
              <p className="text-xs text-muted-foreground mb-4">Svi korisnici koji trenutno imaju Ratar ulogu. Ako im se rola makne, automatski se arhiviraju.</p>
              {ratarMembers.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nema korisnika s Ratar ulogom.</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                  {ratarMembers.map(member => {
                    const linked = playerLinks.find(l => l.discordUserId === member.id);
                    return (
                      <div key={member.id} className={`p-2.5 rounded-lg border flex items-center gap-2.5 ${linked ? 'bg-green-500/10 border-green-500/30' : 'bg-muted/30 border-border'}`}>
                        {member.avatar && <img src={member.avatar} alt="" className="w-7 h-7 rounded-full shrink-0" />}
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-sm truncate">{member.displayName}</p>
                          <p className="text-[10px] text-muted-foreground truncate">
                            {linked ? `🔗 ${linked.playerName || linked.uniqueUserId}` : '❌ Nije povezan'}
                          </p>
                        </div>
                        {linked && <Badge variant="outline" className="text-[9px] shrink-0 text-green-500 border-green-500/30">Povezan</Badge>}
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* Removed/Archived Players */}
            {removedPlayers.length > 0 && (
              <Card className="p-6 mb-6">
                <div className="flex items-center gap-3 mb-4">
                  <LogOut className="w-6 h-6 text-red-500" />
                  <h3 className="font-bold text-xl">Arhivirani igrači</h3>
                  <Badge variant="destructive" className="text-xs">{removedPlayers.length}</Badge>
                </div>
                <p className="text-xs text-muted-foreground mb-4">Igrači kojima je uklonjena Ratar rola. Ako se isti Game ID vrati, dobit ćeš upozorenje.</p>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                  {removedPlayers.map((rp: any) => (
                    <div key={rp.id} className="p-2.5 rounded-lg border border-red-500/20 bg-red-500/5 flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{rp.playerName || rp.discordName || 'Nepoznat'}</p>
                        <p className="text-[10px] text-muted-foreground">Discord: {rp.discordName || rp.discordUserId}</p>
                        {rp.uniqueUserId && <p className="text-[10px] text-muted-foreground">Game ID: {rp.uniqueUserId}</p>}
                        <p className="text-[10px] text-red-400">{rp.reason || 'Rola uklonjena'} — {rp.removedAt ? new Date(rp.removedAt).toLocaleDateString('hr') : '?'}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Game Commands Panel */}
            <Card className="p-6 mb-6 card-hover">
              <div className="flex items-center gap-3 mb-6">
                <Gamepad2 className="w-6 h-6 text-primary" />
                <h3 className="font-bold text-xl">Komande u igru</h3>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                Šalji komande direktno u FS25 server preko Companion moda (FTP inbox).
              </p>

              {/* Server Selector */}
              {serversData && serversData.servers.length > 1 && (
                <div className="border rounded-lg p-4 mb-4">
                  <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                    <Wifi className="w-4 h-4 text-primary" /> Aktivni server
                  </h4>
                  <div className="flex gap-2">
                    <Select value={serversData.activeId || ''} onValueChange={(id) => switchServerMutation.mutate(id)}>
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Odaberi server..." />
                      </SelectTrigger>
                      <SelectContent>
                        {serversData.servers.map(s => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name} ({s.host})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {/* Quick Actions */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
                <Button
                  className="btn-glow"
                  variant="outline"
                  disabled={gameCommandMutation.isPending}
                  onClick={() => gameCommandMutation.mutate({ command: 'saveGame' })}
                >
                  {gameCommandMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  Spremi igru
                </Button>
              </div>

              {/* Send Chat Message */}
              <div className="border rounded-lg p-4 mb-4">
                <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-primary" /> Pošalji poruku u igru
                </h4>
                <div className="flex gap-2">
                  <Input
                    placeholder="Ime pošiljatelja"
                    value={chatFromUser}
                    onChange={e => setChatFromUser(e.target.value)}
                    className="w-32"
                  />
                  <Input
                    placeholder="Poruka..."
                    value={chatMessage}
                    onChange={e => setChatMessage(e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    className="btn-glow"
                    disabled={gameCommandMutation.isPending || !chatMessage.trim()}
                    onClick={() => gameCommandMutation.mutate({
                      command: 'sendChat',
                      params: { fromUser: chatFromUser || 'Admin', content: chatMessage }
                    })}
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Money Transfer */}
              <div className="border rounded-lg p-4 mb-4">
                <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-primary" /> Transfer novca na farmu
                </h4>
                <div className="flex gap-2">
                  <Select value={moneyFarmId} onValueChange={setMoneyFarmId}>
                    <SelectTrigger className="w-40">
                      <SelectValue placeholder="Farma..." />
                    </SelectTrigger>
                    <SelectContent>
                      {farmIds.map(fid => (
                        <SelectItem key={String(fid)} value={String(fid)}>
                          {farms.find(f => f.farmId === fid)?.name || `Farma ${fid}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    placeholder="Iznos €"
                    value={moneyAmount}
                    onChange={e => setMoneyAmount(e.target.value)}
                    className="w-32"
                  />
                  <Button
                    className="btn-glow"
                    disabled={gameCommandMutation.isPending || !moneyFarmId || !moneyAmount}
                    onClick={() => gameCommandMutation.mutate({
                      command: 'moneyTransfer',
                      params: { farmId: moneyFarmId, amount: moneyAmount }
                    })}
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Ban / Unban / Promote */}
              <div className="border rounded-lg p-4">
                <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                  <Shield className="w-4 h-4 text-primary" /> Upravljanje igračima
                </h4>
                <div className="flex gap-2 mb-3">
                  <Select value={banPlayerUid} onValueChange={(val) => {
                    setBanPlayerUid(val);
                    const p = players.find(pl => pl.uniqueUserId === val);
                    if (p) setBanPlayerName(p.name);
                  }}>
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Odaberi igrača..." />
                    </SelectTrigger>
                    <SelectContent>
                      {players.map(p => (
                        <SelectItem key={p.uniqueUserId} value={p.uniqueUserId}>
                          {p.name} {p.isOnline ? '🟢' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="btn-glow"
                    disabled={gameCommandMutation.isPending || !banPlayerUid}
                    onClick={() => {
                      if (confirm(`Banati igrača ${banPlayerName}?`)) {
                        gameCommandMutation.mutate({
                          command: 'banUser',
                          params: { userNickname: banPlayerName, uniqueUserId: banPlayerUid }
                        });
                      }
                    }}
                  >
                    <Shield className="w-4 h-4 mr-1" /> Ban
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="btn-glow"
                    disabled={gameCommandMutation.isPending || !banPlayerUid}
                    onClick={() => gameCommandMutation.mutate({
                      command: 'unBanUser',
                      params: { userNickname: banPlayerName, uniqueUserId: banPlayerUid }
                    })}
                  >
                    <ShieldOff className="w-4 h-4 mr-1" /> Unban
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="btn-glow"
                    disabled={gameCommandMutation.isPending || !banPlayerUid}
                    onClick={() => {
                      if (confirm(`Kickati igrača ${banPlayerName}?`)) {
                        gameCommandMutation.mutate({
                          command: 'kickUser',
                          params: { uniqueUserId: banPlayerUid, userNickname: banPlayerName }
                        });
                      }
                    }}
                  >
                    <LogOut className="w-4 h-4 mr-1" /> Kick
                  </Button>
                </div>
              </div>

              {/* Farm Manager Assignment */}
              <div className="border rounded-lg p-4 mb-4">
                <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                  <Crown className="w-4 h-4 text-yellow-500" /> Postavi Farm Managera
                </h4>
                <p className="text-xs text-muted-foreground mb-3">
                  Odaberi igrača i farmu, zatim klikni "Postavi" da igraču daš Farm Manager prava u igri.
                </p>
                <div className="flex gap-2 items-center flex-wrap">
                  <Select value={banPlayerUid} onValueChange={(val) => {
                    setBanPlayerUid(val);
                    const p = players.find(pl => pl.uniqueUserId === val);
                    if (p) setBanPlayerName(p.name);
                  }}>
                    <SelectTrigger className="w-48">
                      <SelectValue placeholder="Odaberi igrača..." />
                    </SelectTrigger>
                    <SelectContent>
                      {players.map(p => (
                        <SelectItem key={p.uniqueUserId} value={p.uniqueUserId}>
                          {p.name} {p.isOnline ? '🟢' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={fmFarmId} onValueChange={setFmFarmId}>
                    <SelectTrigger className="w-40">
                      <SelectValue placeholder="Odaberi farmu..." />
                    </SelectTrigger>
                    <SelectContent>
                      {farmIds.map(fid => (
                        <SelectItem key={String(fid)} value={String(fid)}>
                          {farms.find(f => String(f.farmId) === String(fid))?.name || `Farma ${fid}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    className="btn-glow"
                    size="sm"
                    disabled={gameCommandMutation.isPending || !banPlayerUid || !fmFarmId}
                    onClick={() => {
                      if (confirm(`Postaviti ${banPlayerName} kao Farm Managera na farmi ${farms.find(f => String(f.farmId) === fmFarmId)?.name || fmFarmId}?`)) {
                        gameCommandMutation.mutate({
                          command: 'makeFarmManager',
                          params: { userNickname: banPlayerName, uniqueUserId: banPlayerUid, farmId: fmFarmId }
                        });
                      }
                    }}
                  >
                    <Crown className="w-4 h-4 mr-1" /> Postavi
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={gameCommandMutation.isPending || !banPlayerUid || !fmFarmId}
                    onClick={() => {
                      if (confirm(`Ukloniti Farm Manager prava od ${banPlayerName}?`)) {
                        gameCommandMutation.mutate({
                          command: 'removeFarmManager',
                          params: { userNickname: banPlayerName, uniqueUserId: banPlayerUid, farmId: fmFarmId }
                        });
                      }
                    }}
                  >
                    <ShieldOff className="w-4 h-4 mr-1" /> Ukloni
                  </Button>
                </div>
              </div>

              {/* Private Message */}
              <div className="border rounded-lg p-4 mb-4 mt-4">
                <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                  <Mail className="w-4 h-4 text-primary" /> Privatna poruka igraču
                </h4>
                <div className="flex gap-2">
                  <Select value={pmPlayerUid} onValueChange={setPmPlayerUid}>
                    <SelectTrigger className="w-48">
                      <SelectValue placeholder="Odaberi igrača..." />
                    </SelectTrigger>
                    <SelectContent>
                      {players.filter(p => p.isOnline).map(p => (
                        <SelectItem key={p.uniqueUserId} value={p.uniqueUserId}>
                          {p.name} 🟢
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder="Poruka..."
                    value={pmMessage}
                    onChange={e => setPmMessage(e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    className="btn-glow"
                    disabled={gameCommandMutation.isPending || !pmPlayerUid || !pmMessage.trim()}
                    onClick={() => {
                      gameCommandMutation.mutate({
                        command: 'sendPrivateMsg',
                        params: { uniqueUserId: pmPlayerUid, content: pmMessage, fromUser: 'Admin' }
                      });
                      setPmMessage('');
                    }}
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Vehicle Transfer */}
              <div className="border rounded-lg p-4 mb-4">
                <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                  <ArrowRightLeft className="w-4 h-4 text-primary" /> Prijenos vozila na drugu farmu
                </h4>
                <div className="flex gap-2 items-center mb-3">
                  <Select value={vehTransferSourceFarm} onValueChange={v => { setVehTransferSourceFarm(v); setVehTransferId(''); }}>
                    <SelectTrigger className="w-40">
                      <SelectValue placeholder="Sa farme..." />
                    </SelectTrigger>
                    <SelectContent>
                      {farmIds.map(fid => (
                        <SelectItem key={String(fid)} value={String(fid)}>
                          {farms.find(f => f.farmId === fid)?.name || `Farma ${fid}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-muted-foreground text-sm">→</span>
                  <Select value={vehTransferFarm} onValueChange={setVehTransferFarm}>
                    <SelectTrigger className="w-40">
                      <SelectValue placeholder="Na farmu..." />
                    </SelectTrigger>
                    <SelectContent>
                      {farmIds.filter(fid => fid !== vehTransferSourceFarm).map(fid => (
                        <SelectItem key={String(fid)} value={String(fid)}>
                          {farms.find(f => f.farmId === fid)?.name || `Farma ${fid}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {vehTransferSourceFarm && (() => {
                  const sourceVehicles = vehicles.filter(v => v.farmId === vehTransferSourceFarm);
                  const categories = Array.from(new Set(sourceVehicles.map(v => getVehicleCategory(v.name, v.vehType)))).sort();
                  return categories.length > 0 ? (
                    <div className="space-y-2">
                      {categories.map(cat => {
                        const catVehicles = sourceVehicles.filter(v => getVehicleCategory(v.name, v.vehType) === cat);
                        return (
                          <div key={cat}>
                            <p className="text-xs text-muted-foreground font-medium mb-1">{cat} ({catVehicles.length})</p>
                            <div className="flex gap-1 flex-wrap">
                              {catVehicles.map(v => (
                                <Button
                                  key={String(v.id)}
                                  variant={vehTransferId === String(v.id) ? "default" : "outline"}
                                  size="sm"
                                  className="text-xs h-7"
                                  onClick={() => setVehTransferId(String(v.id))}
                                >
                                  {v.name || `#${v.id}`}
                                </Button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                      <Button
                        className="btn-glow mt-2"
                        disabled={gameCommandMutation.isPending || !vehTransferId || !vehTransferFarm}
                        onClick={() => {
                          if (confirm(`Prebaciti vozilo na farmu ${vehTransferFarm}?`)) {
                            gameCommandMutation.mutate({
                              command: 'transferVehicle',
                              params: { vehicleId: vehTransferId, farmId: vehTransferFarm }
                            });
                          }
                        }}
                      >
                        <Send className="w-4 h-4 mr-1" /> Prenesi
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">Nema vozila na ovoj farmi.</p>
                  );
                })()}
              </div>

              {/* Repair Vehicle */}
              <div className="border rounded-lg p-4 mb-4">
                <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                  <Wrench className="w-4 h-4 text-primary" /> Popravi vozilo
                </h4>
                <div className="flex gap-2 mb-3 flex-wrap">
                  <Select value={vehRepairFarm} onValueChange={v => { setVehRepairFarm(v); setVehRepairId(''); setVehRepairCategory(''); }}>
                    <SelectTrigger className="w-48">
                      <SelectValue placeholder="Odaberi farmu..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Sve farme</SelectItem>
                      {farmIds.map(fid => (
                        <SelectItem key={String(fid)} value={String(fid)}>
                          {farms.find(f => f.farmId === fid)?.name || `Farma ${fid}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {vehRepairFarm && (() => {
                    const repairVehicles = vehRepairFarm !== 'all'
                      ? vehicles.filter(v => v.farmId === vehRepairFarm)
                      : vehicles;
                    const categories = Array.from(new Set(repairVehicles.map(v => getVehicleCategory(v.name, v.vehType)))).sort();
                    return categories.length > 0 ? (
                      <Select value={vehRepairCategory} onValueChange={v => { setVehRepairCategory(v); setVehRepairId(''); }}>
                        <SelectTrigger className="w-48">
                          <SelectValue placeholder="Kategorija..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Sve kategorije</SelectItem>
                          {categories.map(cat => {
                            const count = repairVehicles.filter(v => getVehicleCategory(v.name, v.vehType) === cat).length;
                            return <SelectItem key={cat} value={cat}>{cat} ({count})</SelectItem>;
                          })}
                        </SelectContent>
                      </Select>
                    ) : null;
                  })()}
                </div>
                {vehRepairFarm ? (() => {
                  const repairVehicles = vehRepairFarm !== 'all'
                    ? vehicles.filter(v => v.farmId === vehRepairFarm)
                    : vehicles;
                  const categoriesToShow = vehRepairCategory && vehRepairCategory !== 'all'
                    ? [vehRepairCategory]
                    : Array.from(new Set(repairVehicles.map(v => getVehicleCategory(v.name, v.vehType)))).sort();
                  return categoriesToShow.length > 0 ? (
                    <div className="space-y-2">
                      {categoriesToShow.map(cat => {
                        const catVehicles = repairVehicles.filter(v => getVehicleCategory(v.name, v.vehType) === cat);
                        if (catVehicles.length === 0) return null;
                        return (
                          <div key={cat}>
                            <p className="text-xs text-muted-foreground font-medium mb-1">{cat} ({catVehicles.length})</p>
                            <div className="flex gap-1 flex-wrap">
                              {catVehicles.map(v => {
                                const dmg = v.damage != null ? Math.round(Number(v.damage) * 100) : null;
                                return (
                                  <Button
                                    key={String(v.id)}
                                    variant={vehRepairId === String(v.id) ? "default" : "outline"}
                                    size="sm"
                                    className="text-xs h-7"
                                    onClick={() => setVehRepairId(String(v.id))}
                                  >
                                    {v.name || `#${v.id}`}{dmg != null && dmg > 0 ? ` 🛠${dmg}%` : ''}
                                  </Button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                      <div className="flex gap-2 mt-2">
                        <Button
                          className="btn-glow"
                          disabled={gameCommandMutation.isPending || !vehRepairId}
                          onClick={() => gameCommandMutation.mutate({
                            command: 'repairVehicle',
                            params: { vehicleId: vehRepairId }
                          })}
                        >
                          <Wrench className="w-4 h-4 mr-1" /> Popravi
                        </Button>
                        <Button
                          variant="outline"
                          className="btn-glow"
                          disabled={gameCommandMutation.isPending}
                          onClick={() => {
                            const toRepair = (vehRepairFarm !== 'all'
                              ? vehicles.filter(v => v.farmId === vehRepairFarm)
                              : vehicles
                            ).filter(v => v.damage != null && Number(v.damage) > 0);
                            if (toRepair.length === 0) return;
                            if (confirm(`Popraviti svih ${toRepair.length} oštećenih vozila?`)) {
                              toRepair.forEach(v => {
                                gameCommandMutation.mutate({
                                  command: 'repairVehicle',
                                  params: { vehicleId: String(v.id) }
                                });
                              });
                            }
                          }}
                        >
                          <Wrench className="w-4 h-4 mr-1" /> Popravi sve oštećene
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">Nema vozila.</p>
                  );
                })() : (
                  <p className="text-xs text-muted-foreground">Odaberi farmu za prikaz vozila.</p>
                )}
              </div>

              {/* Time & Sync Controls */}
              <div className="border rounded-lg p-4 mb-4">
                <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                  <Timer className="w-4 h-4 text-primary" /> Vrijeme & Sinkronizacija
                </h4>

                {/* Time Scale */}
                <div className="mb-4">
                  <p className="text-xs text-muted-foreground mb-2">Brzina vremena (timeScale):</p>
                  <div className="flex gap-2 items-center flex-wrap">
                    <div className="flex gap-1">
                      {[1, 5, 15, 30, 60, 120].map(s => (
                        <Button
                          key={s}
                          variant={timeScaleValue === String(s) ? "default" : "outline"}
                          size="sm"
                          onClick={() => setTimeScaleValue(String(s))}
                        >
                          {s}x
                        </Button>
                      ))}
                    </div>
                    <Input
                      type="number"
                      placeholder="Custom..."
                      value={timeScaleValue}
                      onChange={e => setTimeScaleValue(e.target.value)}
                      className="w-24"
                      min={0.1}
                      max={240}
                      step={0.1}
                    />
                    <Button
                      className="btn-glow"
                      size="sm"
                      disabled={gameCommandMutation.isPending || !timeScaleValue}
                      onClick={() => {
                        const val = parseFloat(timeScaleValue);
                        if (val >= 0.1 && val <= 240) {
                          gameCommandMutation.mutate({
                            command: 'setTimeScale',
                            params: { timeScale: timeScaleValue }
                          });
                        }
                      }}
                    >
                      <Send className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                {/* Server Offset */}
                <div className="mb-4">
                  <p className="text-xs text-muted-foreground mb-2">UTC Offset servera (serverOffset): <span className="text-foreground font-medium">{farmPlayersData?.modSettings?.serverOffset != null ? `UTC${(Number(farmPlayersData.modSettings.serverOffset) - 12) >= 0 ? '+' : ''}${Number(farmPlayersData.modSettings.serverOffset) - 12}` : 'N/A'}</span></p>
                  <div className="flex gap-1 items-center flex-wrap">
                    {[-2, -1, 0, 1, 2, 3].map(offset => (
                      <Button
                        key={offset}
                        variant="outline"
                        size="sm"
                        disabled={gameCommandMutation.isPending}
                        onClick={() => gameCommandMutation.mutate({
                          command: 'setSetting',
                          params: { settingName: 'serverOffset', settingValue: String(offset + 12), settingType: 'int' }
                        })}
                      >
                        UTC{offset >= 0 ? '+' : ''}{offset}
                      </Button>
                    ))}
                    <Input
                      type="number"
                      placeholder="UTC±"
                      className="w-20"
                      min={-12}
                      max={12}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          const val = parseInt((e.target as HTMLInputElement).value);
                          if (!isNaN(val) && val >= -12 && val <= 12) {
                            gameCommandMutation.mutate({
                              command: 'setSetting',
                              params: { settingName: 'serverOffset', settingValue: String(val + 12), settingType: 'int' }
                            });
                          }
                        }
                      }}
                    />
                  </div>
                </div>

                {/* Time Fix Hour */}
                <div className="mb-4">
                  <p className="text-xs text-muted-foreground mb-2">Sat sinkronizacije (timeFixHour): <span className="text-foreground font-medium">{farmPlayersData?.modSettings?.timeFixHour === 1 ? 'Uvijek' : farmPlayersData?.modSettings?.timeFixHour != null ? `${farmPlayersData.modSettings.timeFixHour}:00` : 'N/A'}</span></p>
                  <div className="flex gap-1 items-center flex-wrap">
                    <Button
                      variant={farmPlayersData?.modSettings?.timeFixHour === 1 ? "default" : "outline"}
                      size="sm"
                      disabled={gameCommandMutation.isPending}
                      onClick={() => gameCommandMutation.mutate({
                        command: 'setSetting',
                        params: { settingName: 'timeFixHour', settingValue: '1', settingType: 'int' }
                      })}
                    >
                      Uvijek
                    </Button>
                    {[6, 8, 12, 18, 22].map(h => (
                      <Button
                        key={h}
                        variant={farmPlayersData?.modSettings?.timeFixHour === h ? "default" : "outline"}
                        size="sm"
                        disabled={gameCommandMutation.isPending}
                        onClick={() => gameCommandMutation.mutate({
                          command: 'setSetting',
                          params: { settingName: 'timeFixHour', settingValue: String(h), settingType: 'int' }
                        })}
                      >
                        {h}:00
                      </Button>
                    ))}
                  </div>
                </div>

                {/* Time Sync Toggles */}
                <div className="flex gap-3 flex-wrap">
                  <div className="flex items-center gap-2 p-2 rounded bg-muted/50">
                    <span className="text-xs">Time Sync</span>
                    <Button
                      variant={farmPlayersData?.modSettings?.timeSyncEnable ? "default" : "outline"}
                      size="sm"
                      disabled={gameCommandMutation.isPending}
                      onClick={() => gameCommandMutation.mutate({
                        command: 'setSetting',
                        params: { settingName: 'timeSyncEnable', settingValue: farmPlayersData?.modSettings?.timeSyncEnable ? 'false' : 'true', settingType: 'bool' }
                      })}
                    >
                      {farmPlayersData?.modSettings?.timeSyncEnable ? <Lock className="w-3 h-3 mr-1" /> : <Unlock className="w-3 h-3 mr-1" />}
                      {farmPlayersData?.modSettings?.timeSyncEnable ? 'ON' : 'OFF'}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded bg-muted/50">
                    <span className="text-xs">Auto Set Time</span>
                    <Button
                      variant={farmPlayersData?.modSettings?.autoSetTime ? "default" : "outline"}
                      size="sm"
                      disabled={gameCommandMutation.isPending}
                      onClick={() => gameCommandMutation.mutate({
                        command: 'setSetting',
                        params: { settingName: 'autoSetTime', settingValue: farmPlayersData?.modSettings?.autoSetTime ? 'false' : 'true', settingType: 'bool' }
                      })}
                    >
                      {farmPlayersData?.modSettings?.autoSetTime ? <Lock className="w-3 h-3 mr-1" /> : <Unlock className="w-3 h-3 mr-1" />}
                      {farmPlayersData?.modSettings?.autoSetTime ? 'ON' : 'OFF'}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded bg-muted/50">
                    <span className="text-xs">Notifikacije</span>
                    <Button
                      variant={farmPlayersData?.modSettings?.progressNoti ? "default" : "outline"}
                      size="sm"
                      disabled={gameCommandMutation.isPending}
                      onClick={() => gameCommandMutation.mutate({
                        command: 'setSetting',
                        params: { settingName: 'progressNoti', settingValue: farmPlayersData?.modSettings?.progressNoti ? 'false' : 'true', settingType: 'bool' }
                      })}
                    >
                      {farmPlayersData?.modSettings?.progressNoti ? 'ON' : 'OFF'}
                    </Button>
                  </div>
                </div>

                {/* Target Time */}
                <div className="mt-4 p-3 rounded bg-muted/30 border border-border/30">
                  <p className="text-xs font-medium mb-2">
                    Postavi vrijeme u igri: <span className="text-foreground">
                      {farmPlayersData?.modSettings?.targetTimeEnabled
                        ? `Ciljano: ${String(Math.max(0, (Number(farmPlayersData.modSettings.targetTimeHour) || 1) - 1)).padStart(2, '0')}:${String(((Number(farmPlayersData.modSettings.targetTimeMinute) || 1) - 1) * 5).padStart(2, '0')}`
                        : `UTC offset: ${(Number(farmPlayersData?.modSettings?.serverOffset) || 12) - 12 >= 0 ? '+' : ''}${(Number(farmPlayersData?.modSettings?.serverOffset) || 12) - 12}`}
                    </span>
                  </p>
                  <div className="flex gap-2 items-center flex-wrap">
                    <Input
                      type="number"
                      placeholder="Sat (0-23)"
                      className="w-24 h-8 text-sm"
                      id="targetTimeHour"
                      min={0}
                      max={23}
                    />
                    <span className="text-muted-foreground">:</span>
                    <Input
                      type="number"
                      placeholder="Min (0-55)"
                      className="w-24 h-8 text-sm"
                      id="targetTimeMinute"
                      min={0}
                      max={55}
                      step={5}
                    />
                    <Button
                      className="btn-glow"
                      size="sm"
                      disabled={gameCommandMutation.isPending}
                      onClick={() => {
                        const h = parseInt((document.getElementById('targetTimeHour') as HTMLInputElement)?.value);
                        const m = parseInt((document.getElementById('targetTimeMinute') as HTMLInputElement)?.value);
                        if (!isNaN(h) && h >= 0 && h <= 23 && !isNaN(m) && m >= 0 && m <= 55) {
                          const doConfirm = window.confirm(
                            `Postaviti igru na ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}?\n\n` +
                            `Igra ce odmah skociti na to vrijeme.\n` +
                            `Ako je ciljano vrijeme PRIJE trenutnog, preskocit ce u sljedeci dan.\n\n` +
                            `UTC offset ce se automatski prilagoditi.`
                          );
                          if (doConfirm) {
                            gameCommandMutation.mutate({
                              command: 'setTargetTime',
                              params: { enabled: 'true', hour: String(h), minute: String(m), confirm: 'true' }
                            });
                          }
                        }
                      }}
                    >
                      Postavi
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">Odmah postavlja vrijeme u igri i automatski prilagodava UTC offset za sync.</p>
                </div>
              </div>

              {/* Farm Management */}
              <div className="border rounded-lg p-4 mb-4">
                <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                  <Home className="w-4 h-4 text-primary" /> Upravljanje farmama
                </h4>
                {/* Existing farms overview */}
                {(farmPlayersData?.farms || []).length > 0 && (
                  <div className="mb-3 p-2 rounded bg-muted/30 border border-border/20">
                    <p className="text-[10px] text-muted-foreground mb-1">Postojeće farme:</p>
                    <div className="flex gap-2 flex-wrap">
                      {(farmPlayersData?.farms || []).filter((f: any) => f.farmId > 0).map((f: any) => {
                        const colorEmoji = ['','🔵','🟢','🟡','🔴','🩷','🟠','🩵','🟤'][f.color] || '⚪';
                        return (
                          <span key={f.farmId} className="text-xs bg-background px-2 py-0.5 rounded border">
                            {colorEmoji} <b>#{f.farmId}</b> {f.name}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* Create Farm */}
                  <div className="p-3 rounded bg-muted/30 border border-border/30">
                    <p className="text-xs font-medium mb-2">Kreiraj farmu</p>
                    <div className="space-y-2">
                      <Input placeholder="Ime farme..." id="newFarmName" className="h-8 text-sm" />
                      <div className="flex gap-2">
                        <Select value={newFarmId} onValueChange={setNewFarmId}>
                          <SelectTrigger className="w-28 h-8 text-sm">
                            <SelectValue placeholder="Farm ID..." />
                          </SelectTrigger>
                          <SelectContent>
                            {(() => {
                              const usedIds = new Set((farmPlayersData?.farms || []).filter((f: any) => f.farmId > 0).map((f: any) => String(f.farmId)));
                              return Array.from({ length: 14 }, (_, i) => String(i + 2)).map(id => (
                                <SelectItem key={id} value={id} disabled={usedIds.has(id)}>
                                  #{id}{usedIds.has(id) ? ' ✓ zauzeto' : ''}
                                </SelectItem>
                              ));
                            })()}
                          </SelectContent>
                        </Select>
                        <Select value={newFarmColor} onValueChange={setNewFarmColor}>
                          <SelectTrigger className="w-24 h-8 text-sm">
                            <SelectValue placeholder="Boja..." />
                          </SelectTrigger>
                          <SelectContent>
                            {(() => {
                              const usedColors = new Set((farmPlayersData?.farms || []).map((f: any) => String(f.color)));
                              return [{v:'1',l:'Plava',e:'🔵'},{v:'2',l:'Zelena',e:'🟢'},{v:'3',l:'Žuta',e:'🟡'},{v:'4',l:'Crvena',e:'🔴'},{v:'5',l:'Roza',e:'🩷'},{v:'6',l:'Narančasta',e:'🟠'},{v:'7',l:'Tirkizna',e:'🩵'},{v:'8',l:'Smeđa',e:'🟤'}].map(c => (
                                <SelectItem key={c.v} value={c.v}>
                                  {c.e} {c.l}{usedColors.has(c.v) ? ' ✓' : ''}
                                </SelectItem>
                              ));
                            })()}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex gap-2">
                        <Input placeholder="Lozinka" id="newFarmPassword" className="h-8 text-sm flex-1" />
                        <Input placeholder="Start €" id="newFarmMoney" type="number" defaultValue="100000" className="h-8 text-sm w-24" />
                      </div>
                      <Button
                        size="sm"
                        className="btn-glow w-full"
                        disabled={gameCommandMutation.isPending}
                        onClick={() => {
                          const name = (document.getElementById('newFarmName') as HTMLInputElement)?.value;
                          const farmId = newFarmId;
                          const password = (document.getElementById('newFarmPassword') as HTMLInputElement)?.value || '';
                          const startMoney = (document.getElementById('newFarmMoney') as HTMLInputElement)?.value || '100000';
                          const color = newFarmColor || '1';
                          if (name && farmId) {
                            if (confirm(`Kreirati farmu "${name}" (ID: ${farmId})?`)) {
                              gameCommandMutation.mutate({
                                command: 'createFarm',
                                params: { name, farmId, password, startMoney, color }
                              });
                            }
                          }
                        }}
                      >
                        <Home className="w-3 h-3 mr-1" /> Kreiraj
                      </Button>
                    </div>
                  </div>
                  {/* Delete Farm */}
                  <div className="p-3 rounded bg-muted/30 border border-border/30">
                    <p className="text-xs font-medium mb-2">Obriši farmu</p>
                    <div className="flex gap-2">
                      <Select onValueChange={val => {
                        if (confirm(`Sigurno obrisati farmu ${val}? Ovo je nepovratno!`)) {
                          gameCommandMutation.mutate({ command: 'deleteFarm', params: { farmId: val } });
                        }
                      }}>
                        <SelectTrigger className="flex-1 h-8">
                          <SelectValue placeholder="Odaberi farmu..." />
                        </SelectTrigger>
                        <SelectContent>
                          {farmIds.map(fid => (
                            <SelectItem key={fid} value={fid}>
                              {farms.find(f => f.farmId === fid)?.name || `Farma ${fid}`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </div>

              {/* Farmland Management */}
              <div className="border rounded-lg p-4 mb-4">
                <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-primary" /> Upravljanje zemljištem
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="p-3 rounded bg-muted/30 border border-border/30">
                    <p className="text-xs font-medium mb-2">Kupi zemljište</p>
                    <div className="flex gap-2">
                      <Input placeholder="Farmland ID" id="buyFarmlandId" type="number" className="h-8 text-sm w-28" />
                      <Select onValueChange={val => {
                        const farmlandId = (document.getElementById('buyFarmlandId') as HTMLInputElement)?.value;
                        if (farmlandId && val) {
                          gameCommandMutation.mutate({
                            command: 'purchaseFarmland',
                            params: { farmlandId, farmId: val }
                          });
                        }
                      }}>
                        <SelectTrigger className="flex-1 h-8">
                          <SelectValue placeholder="Za farmu..." />
                        </SelectTrigger>
                        <SelectContent>
                          {farmIds.map(fid => (
                            <SelectItem key={fid} value={fid}>
                              {farms.find(f => f.farmId === fid)?.name || `Farma ${fid}`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="p-3 rounded bg-muted/30 border border-border/30">
                    <p className="text-xs font-medium mb-2">Prodaj zemljište</p>
                    <div className="flex gap-2">
                      <Input placeholder="Farmland ID" id="sellFarmlandId" type="number" className="h-8 text-sm w-28" />
                      <Select onValueChange={val => {
                        const farmlandId = (document.getElementById('sellFarmlandId') as HTMLInputElement)?.value;
                        if (farmlandId && val) {
                          if (confirm(`Prodati zemljište #${farmlandId} od farme ${val}?`)) {
                            gameCommandMutation.mutate({
                              command: 'sellFarmland',
                              params: { farmlandId, farmId: val }
                            });
                          }
                        }
                      }}>
                        <SelectTrigger className="flex-1 h-8">
                          <SelectValue placeholder="Od farme..." />
                        </SelectTrigger>
                        <SelectContent>
                          {farmIds.map(fid => (
                            <SelectItem key={fid} value={fid}>
                              {farms.find(f => f.farmId === fid)?.name || `Farma ${fid}`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </div>

              {/* Coop Silo Store */}
              <div className="border rounded-lg p-4 mb-4">
                <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                  <Warehouse className="w-4 h-4 text-primary" /> Coop Silo - Dodaj materijal
                </h4>
                <div className="flex gap-2 items-center flex-wrap">
                  <Select value={coopFarmId} onValueChange={setCoopFarmId}>
                    <SelectTrigger className="w-40">
                      <SelectValue placeholder="Farma..." />
                    </SelectTrigger>
                    <SelectContent>
                      {farmIds.map(fid => (
                        <SelectItem key={String(fid)} value={String(fid)}>
                          {farms.find(f => f.farmId === fid)?.name || `Farma ${fid}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={coopFillType} onValueChange={setCoopFillType}>
                    <SelectTrigger className="w-40">
                      <SelectValue placeholder="Materijal..." />
                    </SelectTrigger>
                    <SelectContent>
                      {['WHEAT', 'BARLEY', 'OAT', 'CANOLA', 'CORN', 'SOYBEAN', 'SUNFLOWER', 'SUGARBEET', 'POTATO', 'COTTON', 'GRASS_WINDROW', 'STRAW', 'SILAGE', 'CHAFF', 'WOOD', 'WOODCHIPS', 'LIME', 'FERTILIZER', 'SEEDS', 'LIQUIDFERTILIZER', 'HERBICIDE', 'DIESEL', 'WATER', 'MILK', 'WOOL', 'EGG', 'HONEY', 'GRAPE', 'OLIVE', 'RICE', 'SORGHUM', 'POPLAR'].map(ft => (
                        <SelectItem key={ft} value={ft}>{ft}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    placeholder="Količina (L)"
                    value={coopAmount}
                    onChange={e => setCoopAmount(e.target.value)}
                    className="w-28"
                    min={1}
                  />
                  <Button
                    className="btn-glow"
                    disabled={gameCommandMutation.isPending || !coopFarmId || !coopFillType || !coopAmount}
                    onClick={() => {
                      gameCommandMutation.mutate({
                        command: 'coopSiloStore',
                        params: { farmId: coopFarmId, fillType: coopFillType, amount: coopAmount }
                      });
                      setCoopAmount('');
                    }}
                  >
                    <Send className="w-4 h-4 mr-1" /> Dodaj
                  </Button>
                </div>
              </div>

              {/* Restriction Toggles */}
              {farmPlayersData?.modSettings && Object.keys(farmPlayersData.modSettings).length > 0 && (
                <div className="border rounded-lg p-4">
                  <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                    <Lock className="w-4 h-4 text-primary" /> Postavke moda (Restrictions)
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {Object.entries(farmPlayersData.modSettings).map(([key, value]) => {
                      const isBool = typeof value === 'boolean';
                      return (
                        <div key={key} className="flex items-center justify-between gap-2 p-2 rounded bg-muted/50">
                          <span className="text-sm font-mono truncate">{key}</span>
                          {isBool ? (
                            <Button
                              variant={value ? "default" : "outline"}
                              size="sm"
                              disabled={gameCommandMutation.isPending}
                              onClick={() => gameCommandMutation.mutate({
                                command: 'setSetting',
                                params: { settingName: key, settingValue: value ? 'false' : 'true', settingType: 'bool' }
                              })}
                            >
                              {value ? <Lock className="w-3 h-3 mr-1" /> : <Unlock className="w-3 h-3 mr-1" />}
                              {value ? 'ON' : 'OFF'}
                            </Button>
                          ) : (
                            <div className="flex items-center gap-1">
                              <Input
                                type="number"
                                defaultValue={String(value)}
                                className="w-20 h-8 text-sm"
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    gameCommandMutation.mutate({
                                      command: 'setSetting',
                                      params: { settingName: key, settingValue: (e.target as HTMLInputElement).value, settingType: 'int' }
                                    });
                                  }
                                }}
                              />
                              <span className="text-xs text-muted-foreground">Enter</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </Card>

            {/* Set Field State Panel */}
            <Card className="p-6 mb-6 card-hover">
              <div className="flex items-center gap-3 mb-6">
                <Sprout className="w-6 h-6 text-green-500" />
                <h3 className="font-bold text-xl">Postavi stanje polja</h3>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                Promijeni tip tla, usjev i rast na odabranom polju (ili na svim poljima).
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
                {/* Field ID */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Polje (0 = sva polja)</label>
                  <Select value={fieldStateFieldId} onValueChange={setFieldStateFieldId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Odaberi polje..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">0 — Sva polja</SelectItem>
                      {fields.map(f => (
                        <SelectItem key={f.fieldId} value={f.fieldId}>
                          {f.fieldId} — {f.fruitName || 'prazno'} ({farms.find(fm => String(fm.farmId) === f.ownerFarmId)?.name || `Farma ${f.ownerFarmId || '?'}`})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Ground Type */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Tip tla</label>
                  <Select value={fieldStateGroundType} onValueChange={setFieldStateGroundType}>
                    <SelectTrigger>
                      <SelectValue placeholder="Odaberi tip tla..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NONE">NONE — Bez promjene</SelectItem>
                      <SelectItem value="CULTIVATED">CULTIVATED — Kultivirano</SelectItem>
                      <SelectItem value="SOWN">SOWN — Posijano</SelectItem>
                      <SelectItem value="PLOWED">PLOWED — Poorano</SelectItem>
                      <SelectItem value="SEEDBED">SEEDBED — Sjemenska posteljica</SelectItem>
                      <SelectItem value="RIDGE">RIDGE — Greben</SelectItem>
                      <SelectItem value="RIDGE_SOWN">RIDGE_SOWN — Greben posijan</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Fruit Type */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Usjev (opcionalno)</label>
                  <Select value={fieldStateFruitType} onValueChange={setFieldStateFruitType}>
                    <SelectTrigger>
                      <SelectValue placeholder="Bez promjene..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NONE">Bez promjene</SelectItem>
                      {['WHEAT', 'BARLEY', 'OAT', 'CANOLA', 'SOYBEAN', 'SUNFLOWER', 'CORN', 'POTATO', 'SUGARBEET', 'COTTON', 'SORGHUM', 'RICE', 'GRASS', 'MEADOW', 'CARROT', 'PARSNIP', 'GREENBEAN', 'PEA', 'SPINACH', 'BEETROOT'].map(f => (
                        <SelectItem key={f} value={f}>{f}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Growth State */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Faza rasta (1-max)</label>
                  <Input
                    type="number"
                    placeholder="npr. 5"
                    min={1}
                    max={20}
                    value={fieldStateGrowth}
                    onChange={e => setFieldStateGrowth(e.target.value)}
                  />
                </div>

                {/* Plow Level */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Plow Level (0-3)</label>
                  <Input type="number" placeholder="" min={0} max={3} value={fieldStatePlow} onChange={e => setFieldStatePlow(e.target.value)} />
                </div>

                {/* Spray Level */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Spray / Fertilizer Level (0-3)</label>
                  <Input type="number" placeholder="" min={0} max={3} value={fieldStateSpray} onChange={e => setFieldStateSpray(e.target.value)} />
                </div>

                {/* Lime Level */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Lime Level (0-1)</label>
                  <Input type="number" placeholder="" min={0} max={1} value={fieldStateLime} onChange={e => setFieldStateLime(e.target.value)} />
                </div>

                {/* Weed State */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Weed State (0-3)</label>
                  <Input type="number" placeholder="" min={0} max={3} value={fieldStateWeed} onChange={e => setFieldStateWeed(e.target.value)} />
                </div>

                {/* Stone Level */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Stone Level (0-5)</label>
                  <Input type="number" placeholder="" min={0} max={5} value={fieldStateStone} onChange={e => setFieldStateStone(e.target.value)} />
                </div>

                {/* Roller Level */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Roller Level (0-2)</label>
                  <Input type="number" placeholder="" min={0} max={2} value={fieldStateRoller} onChange={e => setFieldStateRoller(e.target.value)} />
                </div>

                {/* Stubble Shred Level */}
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Stubble Shred Level (0-3)</label>
                  <Input type="number" placeholder="" min={0} max={3} value={fieldStateStubble} onChange={e => setFieldStateStubble(e.target.value)} />
                </div>
              </div>

              <div className="flex gap-3 items-center">
                <Button
                  className="btn-glow"
                  disabled={gameCommandMutation.isPending || !fieldStateFieldId || !fieldStateGroundType}
                  onClick={() => {
                    const label = fieldStateFieldId === '0' ? 'SVA POLJA' : `polje ${fieldStateFieldId}`;
                    if (confirm(`Postaviti stanje na ${label}? Ovo je nepovratno!`)) {
                      const params: Record<string, string> = {
                        fieldId: fieldStateFieldId,
                        groundType: fieldStateGroundType,
                      };
                      if (fieldStateFruitType && fieldStateFruitType !== 'NONE') params.fruitType = fieldStateFruitType;
                      if (fieldStateGrowth) params.growthState = fieldStateGrowth;
                      if (fieldStatePlow) params.plowLevel = fieldStatePlow;
                      if (fieldStateSpray) params.sprayLevel = fieldStateSpray;
                      if (fieldStateLime) params.limeLevel = fieldStateLime;
                      if (fieldStateWeed) params.weedState = fieldStateWeed;
                      if (fieldStateStone) params.stoneLevel = fieldStateStone;
                      if (fieldStateRoller) params.rollerLevel = fieldStateRoller;
                      if (fieldStateStubble) params.stubbleShredLevel = fieldStateStubble;
                      gameCommandMutation.mutate({ command: 'setFieldState', params });
                    }
                  }}
                >
                  {gameCommandMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Zap className="w-4 h-4 mr-2" />}
                  Primijeni na polje
                </Button>
                <span className="text-xs text-muted-foreground">
                  Zahtijeva aktivan FS25 server s Companion modom.
                </span>
              </div>
            </Card>
          </TabsContent>

          {/* ====== COOP TRŽNICA ====== */}
          <TabsContent value="market">
            <CoopMarketPanel />
          </TabsContent>

          {/* ====== POSLOVI NA UGOVOR ====== */}
          <TabsContent value="poslovi">
            <PosloviPanel />
          </TabsContent>

          {/* ====== BACKUP ====== */}
          <TabsContent value="backup">
            <BackupPanel />
          </TabsContent>

          {/* ====== KONZOLA ====== */}
          <TabsContent value="console">
            <ServerConsolePanel />
          </TabsContent>
          <TabsContent value="server">
            <BotServerPanel />
          </TabsContent>
          <TabsContent value="database">
            <MongoDbPanel />
          </TabsContent>
          <TabsContent value="channels">
            <ChannelManager />
          </TabsContent>
          <TabsContent value="requests">
            <RequestPanel />
          </TabsContent>
        </Tabs>
      </div>

      {/* Player Link Dialog */}
      <Dialog open={!!selectedPlayer} onOpenChange={(open) => { if (!open) { setSelectedPlayer(null); setDiscordIdInput(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upravljanje igračem: {selectedPlayer?.name}</DialogTitle>
          </DialogHeader>
          {selectedPlayer && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Game UID:</span>
                  <p className="font-mono text-xs break-all">{selectedPlayer.uniqueUserId}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Farma:</span>
                  <p>{selectedPlayer.farmId || 'N/A'}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Vrijeme igre:</span>
                  <p>{formatPlayTime(selectedPlayer.playTime)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Status:</span>
                  <p>{selectedPlayer.isOnline ? '🟢 Online' : '⚫ Offline'}</p>
                </div>
              </div>

              <div className="border-t pt-4">
                <label className="block text-sm font-medium mb-2">Dodijeli farmu:</label>
                <div className="flex gap-2 items-center">
                  <Select
                    value={selectedPlayer.farmId || '__none__'}
                    onValueChange={(val) => {
                      const farmId = val === '__none__' ? null : val;
                      setPlayerFarmMutation.mutate({ uid: selectedPlayer.uniqueUserId, farmId });
                    }}
                  >
                    <SelectTrigger className="flex-1 h-8 text-sm">
                      <SelectValue placeholder="Odaberi farmu..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— Bez farme —</SelectItem>
                      {(farmPlayersData?.farms || []).filter((f: any) => f.farmId > 0).map((f: any) => {
                        const colorEmoji = ['','🔵','🟢','🟡','🔴','🩷','🟠','🩵','🟤'][f.color] || '⚪';
                        return (
                          <SelectItem key={f.farmId} value={String(f.farmId)}>
                            {colorEmoji} #{f.farmId} {f.name}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  {setPlayerFarmMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                </div>
              </div>

              <div className="border-t pt-4">
                <label className="block text-sm font-medium mb-2">Poveži s Discord ID-om:</label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Unesi Discord User ID..."
                    value={discordIdInput}
                    onChange={(e) => setDiscordIdInput(e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    disabled={!discordIdInput.trim() || linkPlayerMutation.isPending}
                    onClick={() => {
                      if (selectedPlayer && discordIdInput.trim()) {
                        linkPlayerMutation.mutate({
                          discordUserId: discordIdInput.trim(),
                          uniqueUserId: selectedPlayer.uniqueUserId,
                          playerName: selectedPlayer.name,
                          defaultFarmId: selectedPlayer.farmId || undefined,
                        });
                      }
                    }}
                  >
                    {linkPlayerMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Poveži'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Discord ID možeš kopirati desnim klikom na korisnika u Discordu → "Copy User ID"
                </p>
              </div>

              {playerLinks.find(l => l.uniqueUserId === selectedPlayer.uniqueUserId) && (
                <div className="border-t pt-4">
                  <p className="text-sm text-green-500 mb-2">
                    ✅ Već povezan s Discord: {playerLinks.find(l => l.uniqueUserId === selectedPlayer.uniqueUserId)?.discordUserId}
                  </p>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      const link = playerLinks.find(l => l.uniqueUserId === selectedPlayer.uniqueUserId);
                      if (link) unlinkPlayerMutation.mutate(link.discordUserId);
                    }}
                  >
                    Ukloni vezu
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
