import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "@/hooks/use-theme";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sprout, Tractor, Warehouse, Factory, Dog, Home, Sun, Moon, ArrowLeft,
  Loader2, Wifi, Clock, DollarSign, Wheat, Droplets, Bug, Shovel, Scale
} from "lucide-react";
import { Link } from "wouter";
import type { Field, Vehicle, Silo, Production, Animal, Farm } from "@shared/schema";

interface FillLevel {
  fillType?: string;
  level?: number;
}

interface ProductionIO {
  fillType?: string;
  amount?: number;
}

interface FarmOverviewItem {
  farmId: string;
  name: string;
  balance: number;
  fieldCount: number;
  vehicleCount: number;
  siloCount: number;
  productionCount: number;
  animalCount: number;
  players: PlayerInfo[];
}

interface PlayerInfo {
  id: number;
  uniqueUserId: string;
  name: string;
  farmId: string | null;
  playTime: number;
  isOnline: boolean;
  lastPlayed: string | null;
  discordUserId: string | null;
}

interface MyFarmData {
  linked: boolean;
  hasFarm?: boolean;
  message?: string;
  farm?: Farm;
  player?: PlayerInfo;
  fields?: Field[];
  vehicles?: Vehicle[];
  silos?: Silo[];
  productions?: Production[];
  animals?: Animal[];
}

function parseFillLevels(data: unknown): FillLevel[] {
  if (!data || !Array.isArray(data)) return [];
  return data as FillLevel[];
}

function parseProductionIO(data: unknown): ProductionIO[] {
  if (!data || !Array.isArray(data)) return [];
  return data as ProductionIO[];
}

function formatPlayTime(hours: number): string {
  if (!hours || hours < 0) return "0m";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "nikad";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "N/A";
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "upravo";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

function getStatusColor(status: string) {
  const lower = status?.toLowerCase() || "";
  if (lower.includes("ready") || lower.includes("harvest")) return "bg-green-500";
  if (lower.includes("growing")) return "bg-yellow-500";
  if (lower.includes("planted") || lower.includes("seeded")) return "bg-blue-500";
  return "bg-gray-500";
}

export default function MojaFarma() {
  const { theme, toggle: toggleTheme } = useTheme();
  const [selectedFarmId, setSelectedFarmId] = useState<string | null>(null);

  // Fetch farm overview (all farms with summary)
  const { data: farmOverview = [], isLoading: overviewLoading } = useQuery<FarmOverviewItem[]>({
    queryKey: ["/api/farm-overview"],
  });

  // Fetch detailed farm data when a farm is selected
  const { data: farmDetail, isLoading: detailLoading } = useQuery<MyFarmData>({
    queryKey: ["/api/my-farm/farm", selectedFarmId],
    queryFn: async () => {
      // Find a player linked to this farm
      const farmInfo = farmOverview.find((f) => f.farmId === selectedFarmId);
      if (farmInfo && farmInfo.players.length > 0 && farmInfo.players[0].discordUserId) {
        const res = await fetch(`/api/my-farm/${farmInfo.players[0].discordUserId}`);
        return res.json();
      }
      // If no linked player, fetch data directly via farm APIs
      const [farmsRes, fieldsRes, vehiclesRes, silosRes, prodRes, animalsRes] = await Promise.all([
        fetch("/api/farms").then((r) => r.json()),
        fetch("/api/fields").then((r) => r.json()),
        fetch("/api/vehicles").then((r) => r.json()),
        fetch("/api/silos").then((r) => r.json()),
        fetch("/api/productions").then((r) => r.json()),
        fetch("/api/animals").then((r) => r.json()),
      ]);
      const farm = farmsRes.find((f: Farm) => f.farmId === selectedFarmId);
      return {
        linked: true,
        hasFarm: true,
        farm: farm || { farmId: selectedFarmId, name: `Farma ${selectedFarmId}`, balance: 0 },
        player: null,
        fields: fieldsRes.filter((f: Field) => f.ownerFarmId === selectedFarmId),
        vehicles: vehiclesRes.filter((v: Vehicle) => v.farmId === selectedFarmId),
        silos: silosRes.filter((s: Silo) => s.farmId === selectedFarmId),
        productions: prodRes.filter((p: Production) => p.farmId === selectedFarmId),
        animals: animalsRes.filter((a: Animal) => a.farmId === selectedFarmId),
      };
    },
    enabled: !!selectedFarmId,
  });

  // If a farm is selected, show detailed view
  if (selectedFarmId && farmDetail?.hasFarm) {
    return (
      <FarmDetailView
        farm={farmDetail}
        theme={theme}
        toggleTheme={toggleTheme}
        onBack={() => setSelectedFarmId(null)}
      />
    );
  }

  // Farm selection overview
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
                Moja <span className="text-primary">Farma</span>
              </h1>
            </div>
            <p className="text-lg text-muted-foreground max-w-xl">
              Statistike i pregled farmi — odaberi svoju farmu za detaljni prikaz
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              className="rounded-full"
              title={theme === "dark" ? "Svijetla tema" : "Tamna tema"}
            >
              {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </Button>
            <Link href="/">
              <Button variant="outline" size="sm">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Dashboard
              </Button>
            </Link>
          </div>
        </header>

        {overviewLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <span className="ml-3 text-muted-foreground">Učitavanje farmi...</span>
          </div>
        ) : farmOverview.length === 0 ? (
          <Card className="p-12 text-center">
            <div className="text-6xl mb-4">🌱</div>
            <h2 className="text-2xl font-bold mb-2">Nema dostupnih farmi</h2>
            <p className="text-muted-foreground mb-6">
              Pokrenite Sync na Dashboardu da se podaci učitaju sa servera.
            </p>
            <Link href="/">
              <Button>
                <ArrowLeft className="w-4 h-4 mr-2" />
                Idi na Dashboard
              </Button>
            </Link>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {farmOverview.map((farm) => (
              <Card
                key={farm.farmId}
                className="p-0 overflow-hidden cursor-pointer transition-all duration-300 hover:shadow-xl hover:shadow-primary/10 hover:-translate-y-1 hover:border-primary/30"
                onClick={() => setSelectedFarmId(farm.farmId)}
              >
                {/* Farm Header */}
                <div className="bg-gradient-to-br from-primary/15 via-primary/5 to-transparent p-6 border-b border-border/50">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xl font-bold">{farm.name}</h3>
                    <Badge variant="outline" className="font-mono">
                      #{farm.farmId}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-primary font-bold text-2xl">
                    <DollarSign className="w-5 h-5" />
                    <span>{(farm.balance || 0).toLocaleString("hr-HR")} €</span>
                  </div>
                </div>

                {/* Farm Stats Grid */}
                <div className="p-6">
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <div className="text-center">
                      <Sprout className="w-5 h-5 mx-auto mb-1 text-green-500" />
                      <p className="text-xl font-bold">{farm.fieldCount}</p>
                      <p className="text-xs text-muted-foreground">Polja</p>
                    </div>
                    <div className="text-center">
                      <Tractor className="w-5 h-5 mx-auto mb-1 text-blue-500" />
                      <p className="text-xl font-bold">{farm.vehicleCount}</p>
                      <p className="text-xs text-muted-foreground">Vozila</p>
                    </div>
                    <div className="text-center">
                      <Dog className="w-5 h-5 mx-auto mb-1 text-amber-500" />
                      <p className="text-xl font-bold">{farm.animalCount}</p>
                      <p className="text-xs text-muted-foreground">Životinje</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Warehouse className="w-4 h-4" />
                      <span>{farm.siloCount} silosa</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Factory className="w-4 h-4" />
                      <span>{farm.productionCount} proizvodnji</span>
                    </div>
                  </div>

                  {/* Players */}
                  {farm.players.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-border/50">
                      <p className="text-xs text-muted-foreground mb-2">Igrači:</p>
                      <div className="flex flex-wrap gap-2">
                        {farm.players.map((p) => (
                          <div
                            key={p.uniqueUserId}
                            className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-muted/50 text-xs"
                          >
                            <div
                              className={`w-2 h-2 rounded-full ${
                                p.isOnline
                                  ? "bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.5)]"
                                  : "bg-muted-foreground/40"
                              }`}
                            />
                            <span className="font-medium">{p.name}</span>
                            <span className="text-muted-foreground">
                              {formatPlayTime(p.playTime || 0)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// === Farm Detail View Component ===

function FarmDetailView({
  farm,
  theme,
  toggleTheme,
  onBack,
}: {
  farm: MyFarmData;
  theme: string;
  toggleTheme: () => void;
  onBack: () => void;
}) {
  const farmData = farm.farm!;
  const fFields = farm.fields || [];
  const fVehicles = farm.vehicles || [];
  const fSilos = farm.silos || [];
  const fProductions = farm.productions || [];
  const fAnimals = farm.animals || [];
  const player = farm.player;

  const totalAnimals = fAnimals.reduce((sum, a) => sum + (a.numAnimals || 0), 0);
  const totalSiloFill = fSilos.reduce((sum, s) => sum + (s.totalFill || 0), 0);
  const totalSiloCapacity = fSilos.reduce((sum, s) => sum + (s.capacity || 0), 0);
  const totalFieldArea = fFields.reduce((sum, f) => sum + (f.fieldArea || 0), 0);
  const vehicleValue = fVehicles.reduce((sum, v) => sum + (v.price || 0), 0);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-primary/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-primary/5 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2" />
      </div>

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
        {/* Header */}
        <header className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <img src="/logo.png" alt="FarmBudy" className="w-12 h-12 rounded-xl shadow-lg" />
              <h1 className="text-4xl md:text-5xl font-display font-bold text-foreground tracking-tight">
                {farmData.name || "Moja Farma"}
              </h1>
            </div>
            <p className="text-lg text-muted-foreground max-w-xl">
              {player
                ? `Igrač: ${player.name} · ${player.isOnline ? "🟢 Online" : `🔴 Offline · ${timeAgo(player.lastPlayed)}`}`
                : "Pregled farme"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              className="rounded-full"
              title={theme === "dark" ? "Svijetla tema" : "Tamna tema"}
            >
              {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </Button>
            <Button variant="outline" size="sm" onClick={onBack}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              Sve farme
            </Button>
            <Link href="/">
              <Button variant="outline" size="sm">
                <Home className="w-4 h-4 mr-2" />
                Dashboard
              </Button>
            </Link>
          </div>
        </header>

        {/* Stats Overview Cards */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-8">
          <Card className="p-4 bg-gradient-to-br from-primary/10 to-transparent border-primary/20">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <DollarSign className="w-4 h-4 text-primary" />
              <span className="text-xs">Stanje</span>
            </div>
            <p className="text-xl font-bold text-primary">
              {(farmData.balance || 0).toLocaleString("hr-HR")} €
            </p>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Sprout className="w-4 h-4 text-green-500" />
              <span className="text-xs">Polja</span>
            </div>
            <p className="text-2xl font-bold">{fFields.length}</p>
            <p className="text-xs text-muted-foreground">{totalFieldArea.toFixed(1)} ha</p>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Tractor className="w-4 h-4 text-blue-500" />
              <span className="text-xs">Vozila</span>
            </div>
            <p className="text-2xl font-bold">{fVehicles.length}</p>
            <p className="text-xs text-muted-foreground">{vehicleValue.toLocaleString("hr-HR")} €</p>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Warehouse className="w-4 h-4 text-amber-500" />
              <span className="text-xs">Silosi</span>
            </div>
            <p className="text-2xl font-bold">{fSilos.length}</p>
            <p className="text-xs text-muted-foreground">
              {totalSiloCapacity > 0
                ? `${Math.round((totalSiloFill / totalSiloCapacity) * 100)}% puno`
                : "Prazno"}
            </p>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Factory className="w-4 h-4 text-purple-500" />
              <span className="text-xs">Proizvodnje</span>
            </div>
            <p className="text-2xl font-bold">{fProductions.length}</p>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Dog className="w-4 h-4 text-orange-500" />
              <span className="text-xs">Životinje</span>
            </div>
            <p className="text-2xl font-bold">{totalAnimals}</p>
          </Card>
        </div>

        {/* Tabbed Content */}
        <Tabs defaultValue="fields" className="w-full">
          <TabsList className="grid w-full grid-cols-5 mb-6">
            <TabsTrigger value="fields">
              <Sprout className="w-4 h-4 mr-2" />
              Polja ({fFields.length})
            </TabsTrigger>
            <TabsTrigger value="vehicles">
              <Tractor className="w-4 h-4 mr-2" />
              Vozila ({fVehicles.length})
            </TabsTrigger>
            <TabsTrigger value="silos">
              <Warehouse className="w-4 h-4 mr-2" />
              Silosi ({fSilos.length})
            </TabsTrigger>
            <TabsTrigger value="productions">
              <Factory className="w-4 h-4 mr-2" />
              Proizvodnje ({fProductions.length})
            </TabsTrigger>
            <TabsTrigger value="animals">
              <Dog className="w-4 h-4 mr-2" />
              Životinje ({fAnimals.length})
            </TabsTrigger>
          </TabsList>

          {/* FIELDS TAB */}
          <TabsContent value="fields">
            {fFields.length === 0 ? (
              <Card className="p-8 text-center text-muted-foreground">
                <Sprout className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p>Nema polja za ovu farmu.</p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                {fFields.map((field) => (
                  <Card key={field.id} className="p-4 transition-all hover:shadow-md hover:-translate-y-0.5">
                    <div className="flex items-center justify-between mb-3">
                      <span className="font-bold text-lg">#{field.fieldId}</span>
                      <Badge className={`text-xs ${getStatusColor(field.fruitStatus || "")}`}>
                        {field.fruitStatus || "N/A"}
                      </Badge>
                    </div>
                    <p className="text-base font-semibold mb-1">{field.fruitName || "Prazno polje"}</p>
                    <p className="text-sm text-muted-foreground mb-3">
                      {field.fieldArea?.toFixed(1) || 0} ha
                      {field.growthStage && ` · Rast: ${field.growthStage}`}
                    </p>

                    {/* Field condition indicators */}
                    <div className="flex flex-wrap gap-1.5">
                      {field.fertilizationInfo && (
                        <Badge variant="secondary" className="text-xs gap-1">
                          <Droplets className="w-3 h-3" />
                          {field.fertilizationInfo}
                        </Badge>
                      )}
                      {field.weedInfo && (
                        <Badge variant="secondary" className="text-xs gap-1">
                          <Bug className="w-3 h-3" />
                          {field.weedInfo}
                        </Badge>
                      )}
                      {field.plowingInfo && (
                        <Badge variant="secondary" className="text-xs gap-1">
                          <Shovel className="w-3 h-3" />
                          {field.plowingInfo}
                        </Badge>
                      )}
                      {field.limeInfo && (
                        <Badge variant="secondary" className="text-xs gap-1">
                          <Scale className="w-3 h-3" />
                          {field.limeInfo}
                        </Badge>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* VEHICLES TAB */}
          <TabsContent value="vehicles">
            {fVehicles.length === 0 ? (
              <Card className="p-8 text-center text-muted-foreground">
                <Tractor className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p>Nema vozila za ovu farmu.</p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {fVehicles.map((vehicle) => {
                  const dmgPct = Math.min(100, Math.round((vehicle.damage || 0) * 100));
                  const fillUnits = parseFillLevels(vehicle.fillUnits);
                  return (
                    <Card key={vehicle.id} className="p-4 transition-all hover:shadow-md hover:-translate-y-0.5">
                      <h3 className="font-bold text-base mb-3 truncate">{vehicle.name}</h3>
                      <div className="space-y-2.5 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground w-16 shrink-0">Gorivo</span>
                          <Progress value={vehicle.fuelLevel || 0} className="h-2 flex-1" />
                          <span className="w-10 text-right font-medium">
                            {Math.round(vehicle.fuelLevel || 0)}%
                          </span>
                        </div>
                        {dmgPct > 0 && (
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground w-16 shrink-0">Šteta</span>
                            <Progress value={dmgPct} className="h-2 flex-1" />
                            <span className="w-10 text-right font-medium text-destructive">
                              {dmgPct}%
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between pt-1">
                          <span className="text-muted-foreground">{vehicle.vehType || "N/A"}</span>
                          <span className="font-medium">
                            {(vehicle.price || 0).toLocaleString("hr-HR")} €
                          </span>
                        </div>
                        {fillUnits.length > 0 && (
                          <div className="pt-2 border-t border-border/50">
                            <p className="text-xs text-muted-foreground mb-1.5">Teret:</p>
                            <div className="flex flex-wrap gap-1">
                              {fillUnits.slice(0, 4).map((fu, i) => (
                                <Badge key={i} variant="secondary" className="text-xs">
                                  {String(fu.fillType || "N/A")}: {(fu.level || 0).toLocaleString()}L
                                </Badge>
                              ))}
                              {fillUnits.length > 4 && (
                                <Badge variant="outline" className="text-xs">
                                  +{fillUnits.length - 4}
                                </Badge>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* SILOS TAB */}
          <TabsContent value="silos">
            {fSilos.length === 0 ? (
              <Card className="p-8 text-center text-muted-foreground">
                <Warehouse className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p>Nema silosa za ovu farmu.</p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {fSilos
                  .sort((a, b) => (b.totalFill || 0) - (a.totalFill || 0))
                  .map((silo) => {
                    const fills = parseFillLevels(silo.fillLevels);
                    return (
                      <Card key={silo.id} className="p-5 transition-all hover:shadow-md hover:-translate-y-0.5">
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="font-bold text-lg">{silo.name}</h3>
                          <Badge variant="outline" className="font-mono">
                            {Math.round(silo.percent || 0)}%
                          </Badge>
                        </div>
                        <div className="mb-3">
                          <Progress value={silo.percent || 0} className="h-3" />
                        </div>
                        <div className="flex justify-between text-sm text-muted-foreground mb-3">
                          <span>Popunjeno: {(silo.totalFill || 0).toLocaleString("hr-HR")} L</span>
                          <span>Kapacitet: {(silo.capacity || 0).toLocaleString("hr-HR")} L</span>
                        </div>
                        {fills.length > 0 && (
                          <div className="pt-3 border-t border-border/50">
                            <p className="text-xs text-muted-foreground mb-2">Sadržaj:</p>
                            <div className="flex flex-wrap gap-1.5">
                              {fills.map((fill, i) => (
                                <Badge key={i} variant="secondary" className="text-xs">
                                  {String(fill.fillType || "N/A")}: {(fill.level || 0).toLocaleString()}L
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </Card>
                    );
                  })}
              </div>
            )}
          </TabsContent>

          {/* PRODUCTIONS TAB */}
          <TabsContent value="productions">
            {fProductions.length === 0 ? (
              <Card className="p-8 text-center text-muted-foreground">
                <Factory className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p>Nema proizvodnji za ovu farmu.</p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {fProductions.map((prod) => {
                  const inputs = parseProductionIO(prod.inputs);
                  const outputs = parseProductionIO(prod.outputs);
                  return (
                    <Card key={prod.id} className="p-5 transition-all hover:shadow-md hover:-translate-y-0.5">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="font-bold text-lg">{prod.name}</h3>
                        <Badge variant={prod.isOwned ? "default" : "secondary"}>
                          {prod.isOwned ? "Aktivno" : "Neaktivno"}
                        </Badge>
                      </div>
                      <div className="space-y-3 text-sm">
                        {inputs.length > 0 && (
                          <div>
                            <p className="text-xs text-muted-foreground mb-1.5">Ulaz:</p>
                            <div className="flex flex-wrap gap-1.5">
                              {inputs.map((inp, i) => (
                                <Badge key={i} variant="outline" className="text-xs">
                                  {String(inp.fillType || "N/A")}
                                  {inp.amount ? `: ${inp.amount.toLocaleString()}` : ""}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {outputs.length > 0 && (
                          <div>
                            <p className="text-xs text-muted-foreground mb-1.5">Izlaz:</p>
                            <div className="flex flex-wrap gap-1.5">
                              {outputs.map((out, i) => (
                                <Badge key={i} variant="secondary" className="text-xs">
                                  {String(out.fillType || "N/A")}
                                  {out.amount ? `: ${out.amount.toLocaleString()}` : ""}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* ANIMALS TAB */}
          <TabsContent value="animals">
            {fAnimals.length === 0 ? (
              <Card className="p-8 text-center text-muted-foreground">
                <Dog className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p>Nema životinja za ovu farmu.</p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {fAnimals.map((animal) => (
                  <Card key={animal.id} className="p-5 transition-all hover:shadow-md hover:-translate-y-0.5">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-bold text-lg">{animal.name}</h3>
                      <Badge variant="outline">{animal.animalType || "N/A"}</Badge>
                    </div>
                    <div className="space-y-2.5 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Broj</span>
                        <span className="font-bold text-lg">
                          {animal.numAnimals || 0}
                          {animal.maxAnimals ? ` / ${animal.maxAnimals}` : ""}
                        </span>
                      </div>
                      {animal.health != null && (
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground w-20 shrink-0">Zdravlje</span>
                          <Progress
                            value={Math.round((animal.health || 0) * 100)}
                            className="h-2 flex-1"
                          />
                          <span className="w-10 text-right font-medium">
                            {Math.round((animal.health || 0) * 100)}%
                          </span>
                        </div>
                      )}
                      {animal.productivity != null && (
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground w-20 shrink-0">Produktivnost</span>
                          <Progress
                            value={Math.round((animal.productivity || 0) * 100)}
                            className="h-2 flex-1"
                          />
                          <span className="w-10 text-right font-medium">
                            {Math.round((animal.productivity || 0) * 100)}%
                          </span>
                        </div>
                      )}
                      {animal.reproduction != null && (
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground w-20 shrink-0">Reprodukcija</span>
                          <Progress
                            value={Math.round((animal.reproduction || 0) * 100)}
                            className="h-2 flex-1"
                          />
                          <span className="w-10 text-right font-medium">
                            {Math.round((animal.reproduction || 0) * 100)}%
                          </span>
                        </div>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
