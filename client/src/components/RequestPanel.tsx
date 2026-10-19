import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Plus, Trash2, Loader2, MessageSquarePlus, Clock, CheckCircle2, XCircle, AlertTriangle, CircleDot } from "lucide-react";

interface FeatureRequest {
  _id: string;
  title: string;
  description: string;
  priority: string;
  author: string;
  status: string;
  adminNote?: string;
  createdAt: string;
  updatedAt: string;
}

const statusConfig: Record<string, { label: string; color: string; icon: any }> = {
  pending: { label: "Na čekanju", color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30", icon: Clock },
  "in-progress": { label: "U radu", color: "bg-blue-500/20 text-blue-400 border-blue-500/30", icon: CircleDot },
  completed: { label: "Završeno", color: "bg-green-500/20 text-green-400 border-green-500/30", icon: CheckCircle2 },
  rejected: { label: "Odbijeno", color: "bg-red-500/20 text-red-400 border-red-500/30", icon: XCircle },
};

const priorityConfig: Record<string, { label: string; color: string }> = {
  low: { label: "Nizak", color: "bg-green-500/20 text-green-400 border-green-500/30" },
  medium: { label: "Srednji", color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
  high: { label: "Visok", color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  critical: { label: "Kritičan", color: "bg-red-500/20 text-red-400 border-red-500/30" },
};

export function RequestPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<FeatureRequest | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPriority, setNewPriority] = useState("medium");
  const [newAuthor, setNewAuthor] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: requests = [], isLoading } = useQuery<FeatureRequest[]>({
    queryKey: ["/api/requests"],
    refetchInterval: 30000,
  });

  const createMutation = useMutation({
    mutationFn: async (data: { title: string; description: string; priority: string; author: string }) => {
      const res = await apiRequest("POST", "/api/requests", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/requests"] });
      toast({ title: "Zahtjev poslan!", description: "Novi zahtjev je uspješno kreiran." });
      setShowNewDialog(false);
      setNewTitle("");
      setNewDescription("");
      setNewPriority("medium");
      setNewAuthor("");
    },
    onError: (e: any) => toast({ title: "Greška", description: e.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: string; status?: string; adminNote?: string }) => {
      const res = await apiRequest("PATCH", `/api/requests/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/requests"] });
      toast({ title: "Ažurirano", description: "Status zahtjeva je promijenjen." });
    },
    onError: (e: any) => toast({ title: "Greška", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/requests/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/requests"] });
      setSelectedRequest(null);
      toast({ title: "Obrisano", description: "Zahtjev je uspješno obrisan." });
    },
    onError: (e: any) => toast({ title: "Greška", description: e.message, variant: "destructive" }),
  });

  const filtered = statusFilter === "all" ? requests : requests.filter(r => r.status === statusFilter);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <MessageSquarePlus className="h-5 w-5 text-purple-400" />
          <h2 className="text-lg font-semibold text-white">Zahtjevi za izmjene</h2>
          <Badge variant="outline" className="text-xs">{requests.length} ukupno</Badge>
        </div>
        <Button onClick={() => setShowNewDialog(true)} className="gap-2 bg-purple-600 hover:bg-purple-700">
          <Plus className="h-4 w-4" /> Novi zahtjev
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        {Object.entries(statusConfig).map(([key, cfg]) => {
          const count = requests.filter(r => r.status === key).length;
          const Icon = cfg.icon;
          return (
            <Card key={key} className="bg-gray-800/50 border-gray-700 cursor-pointer hover:border-gray-500 transition-colors"
              onClick={() => setStatusFilter(statusFilter === key ? "all" : key)}>
              <CardContent className="p-3 flex items-center gap-3">
                <Icon className="h-4 w-4 text-gray-400" />
                <div>
                  <p className="text-xs text-gray-400">{cfg.label}</p>
                  <p className="text-lg font-bold text-white">{count}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Request List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : filtered.length === 0 ? (
        <Card className="bg-gray-800/50 border-gray-700">
          <CardContent className="p-8 text-center text-gray-400">
            {statusFilter !== "all" ? "Nema zahtjeva s ovim statusom." : "Još nema zahtjeva. Klikni \"Novi zahtjev\" da kreneš."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((req) => {
            const sCfg = statusConfig[req.status] || statusConfig.pending;
            const pCfg = priorityConfig[req.priority] || priorityConfig.medium;
            const StatusIcon = sCfg.icon;
            return (
              <Card key={req._id} className="bg-gray-800/50 border-gray-700 hover:border-gray-500 transition-colors cursor-pointer"
                onClick={() => setSelectedRequest(req)}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <StatusIcon className="h-4 w-4 shrink-0" />
                        <h3 className="font-medium text-white truncate">{req.title}</h3>
                      </div>
                      <p className="text-sm text-gray-400 line-clamp-2">{req.description}</p>
                      <div className="flex items-center gap-2 mt-2 text-xs text-gray-500">
                        <span>Od: {req.author}</span>
                        <span>•</span>
                        <span>{new Date(req.createdAt).toLocaleDateString('hr-HR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className={`text-xs ${pCfg.color}`}>{pCfg.label}</Badge>
                      <Badge variant="outline" className={`text-xs ${sCfg.color}`}>{sCfg.label}</Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* New Request Dialog */}
      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent className="bg-gray-900 border-gray-700 max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-white">Novi zahtjev</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm text-gray-400 mb-1 block">Naslov</label>
              <Input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Kratki opis zahtjeva..."
                className="bg-gray-800 border-gray-600 text-white" />
            </div>
            <div>
              <label className="text-sm text-gray-400 mb-1 block">Opis</label>
              <Textarea value={newDescription} onChange={e => setNewDescription(e.target.value)}
                placeholder="Detaljni opis što treba napraviti..." rows={4}
                className="bg-gray-800 border-gray-600 text-white" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-gray-400 mb-1 block">Prioritet</label>
                <Select value={newPriority} onValueChange={setNewPriority}>
                  <SelectTrigger className="bg-gray-800 border-gray-600 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-gray-800 border-gray-600">
                    <SelectItem value="low">🟢 Nizak</SelectItem>
                    <SelectItem value="medium">🟡 Srednji</SelectItem>
                    <SelectItem value="high">🟠 Visok</SelectItem>
                    <SelectItem value="critical">🔴 Kritičan</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm text-gray-400 mb-1 block">Autor</label>
                <Input value={newAuthor} onChange={e => setNewAuthor(e.target.value)} placeholder="Tvoje ime..."
                  className="bg-gray-800 border-gray-600 text-white" />
              </div>
            </div>
            <Button onClick={() => createMutation.mutate({ title: newTitle, description: newDescription, priority: newPriority, author: newAuthor || "Nepoznato" })}
              disabled={!newTitle.trim() || !newDescription.trim() || createMutation.isPending}
              className="w-full bg-purple-600 hover:bg-purple-700">
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
              Pošalji zahtjev
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Request Detail Dialog */}
      <Dialog open={!!selectedRequest} onOpenChange={(open) => !open && setSelectedRequest(null)}>
        <DialogContent className="bg-gray-900 border-gray-700 max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-white">{selectedRequest?.title}</DialogTitle>
          </DialogHeader>
          {selectedRequest && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-400 mb-1 block">Opis</label>
                <p className="text-sm text-gray-300 bg-gray-800 p-3 rounded-md whitespace-pre-wrap">{selectedRequest.description}</p>
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <span className="text-gray-400">Autor:</span>
                  <p className="text-white">{selectedRequest.author}</p>
                </div>
                <div>
                  <span className="text-gray-400">Prioritet:</span>
                  <Badge variant="outline" className={`mt-1 ${(priorityConfig[selectedRequest.priority] || priorityConfig.medium).color}`}>
                    {(priorityConfig[selectedRequest.priority] || priorityConfig.medium).label}
                  </Badge>
                </div>
                <div>
                  <span className="text-gray-400">Kreirano:</span>
                  <p className="text-white text-xs">{new Date(selectedRequest.createdAt).toLocaleString('hr-HR')}</p>
                </div>
              </div>

              {/* Admin controls */}
              <div>
                <label className="text-sm text-gray-400 mb-1 block">Status</label>
                <Select value={selectedRequest.status} onValueChange={(val) => {
                  updateMutation.mutate({ id: selectedRequest._id, status: val });
                  setSelectedRequest({ ...selectedRequest, status: val });
                }}>
                  <SelectTrigger className="bg-gray-800 border-gray-600 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-gray-800 border-gray-600">
                    <SelectItem value="pending">⏳ Na čekanju</SelectItem>
                    <SelectItem value="in-progress">🔵 U radu</SelectItem>
                    <SelectItem value="completed">✅ Završeno</SelectItem>
                    <SelectItem value="rejected">❌ Odbijeno</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {selectedRequest.adminNote && (
                <div>
                  <label className="text-sm text-gray-400 mb-1 block">Admin bilješka</label>
                  <p className="text-sm text-gray-300 bg-gray-800 p-3 rounded-md">{selectedRequest.adminNote}</p>
                </div>
              )}

              <Button variant="destructive" className="w-full" onClick={() => {
                if (confirm("Jesi li siguran da želiš obrisati ovaj zahtjev?")) {
                  deleteMutation.mutate(selectedRequest._id);
                }
              }}>
                <Trash2 className="h-4 w-4 mr-2" /> Obriši zahtjev
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
