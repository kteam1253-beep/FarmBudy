import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  Hash, Volume2, MessageSquare, Plus, Trash2, Rocket, Eye, Copy, Loader2,
  Settings, ChevronDown, ChevronRight, Globe, Lock, Shield, Sprout, Pencil,
  Type, Smile, FolderPlus, RefreshCw, GripVertical, Check, ArrowUpDown, Save,
  RotateCcw, Zap
} from "lucide-react";

// ── Types ──
interface ChannelDef {
  name: string;
  type: 'text' | 'voice' | 'forum';
  readOnly?: boolean;
  staffOnly?: boolean;
  playerOnly?: boolean;
  farmOnly?: boolean;
  freeWrite?: boolean;
  autoEmbed?: {
    title: string;
    description: string;
    color: number;
    buttonLabel: string;
    buttonEmoji?: string;
    buttonUrlEnv?: string;
    buttonUrl?: string;
    buttonStyle: 'link';
    thumbnail?: string;
  };
}

interface CategoryDef {
  name: string;
  channels: ChannelDef[];
}

interface ChannelConfig {
  categories: CategoryDef[];
  farmChannels: ChannelDef[];
}

interface GuildChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  parentName: string | null;
  position: number;
  overwrites: Array<{
    id: string;
    type: number;
    allow: string[];
    deny: string[];
    name: string;
  }>;
}

interface GuildInfo {
  id: string;
  name: string;
  icon: string | null;
  isMain: boolean;
  isTest: boolean;
}

// Common emojis for channels
const EMOJI_LIST = [
  // Info & Communication
  '📢', '📜', '❓', '💬', '📸', '🎫', '🚀', '🌐', '📦', '🏆',
  '🔔', '⚙️', '📋', '📊', '🖇', '✅', '📝', 'ℹ️', '🔒', '🛡️',
  // Farming & Nature
  '🌾', '🚜', '🏡', '🐄', '🌻', '🏭', '🛒', '🪣', '🎙️', '🔧',
  '💰', '📡', '🎮', '🎯', '⭐', '❤️', '🔥', '💎', '🏗️', '🪵',
  '🌱', '🌿', '🍎', '🌽', '🥕', '🐔', '🐷', '🐴', '🐑', '🌳',
  // Animals
  '🐮', '🐶', '🐱', '🐰', '🐝', '🦊', '🐻', '🦅', '🐟', '🦆',
  // Food & Crops
  '🌿', '🍇', '🍒', '🍑', '🥜', '🌶️', '🧅', '🥔', '🧄', '🍄',
  '🍞', '🧀', '🥛', '🍺', '🍷', '☕', '🧃', '🍯', '🫒', '🥚',
  // Weather & Time
  '☀️', '🌧️', '❄️', '⛈️', '🌈', '🌙', '⏰', '📅', '🕐', '⌛',
  // Tools & Industry
  '🔨', '⛏️', '🪚', '🔩', '⛽', '🛠️', '🧱', '💡', '🔌', '🧲',
  // Vehicles & Transport
  '🚗', '🚛', '🏎️', '🚁', '✈️', '⛵', '🚂', '🏍️', '🚲', '⛟',
  // People & Activities
  '👋', '🤝', '👥', '👑', '🎉', '🎊', '🎁', '🎵', '🎲', '🏅',
  // Symbols
  '💥', '💫', '✨', '🌟', '💪', '🎯', '🔑', '🏷️', '📌', '📎',
  '🚩', '🏴', '🏳️', '❌', '⚠️', '♻️', '💤', '🆕', '🆓', '🔰',
  // Buildings & Places
  '🏠', '🏰', '⛪', '🏢', '🏪', '🏥', '🏫', '🗺️', '🏕️', '🌍',
];

const CHANNEL_TYPE_ICON = {
  text: Hash,
  voice: Volume2,
  forum: MessageSquare,
};

const PERM_FLAGS: Array<{ key: keyof ChannelDef; label: string; icon: typeof Lock; color: string; desc: string }> = [
  { key: 'readOnly', label: 'Read Only', icon: Lock, color: 'text-amber-400', desc: 'Samo bot/admin može pisati' },
  { key: 'staffOnly', label: 'Staff Only', icon: Shield, color: 'text-red-400', desc: 'Vidljivo samo staffu' },
  { key: 'playerOnly', label: 'Player Only', icon: Sprout, color: 'text-green-400', desc: 'Potrebna Player rola' },
  { key: 'freeWrite', label: 'Free Write', icon: Pencil, color: 'text-blue-400', desc: 'Svi mogu pisati' },
];

// ── Font transform utilities (client-side) ──
const SMALL_CAPS: Record<string, string> = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ',
  j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ',
  s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ',
  'č': 'č', 'ć': 'ć', 'đ': 'đ', 'š': 'š', 'ž': 'ž',
};

function toSmallCaps(text: string): string {
  return text.split('').map(c => SMALL_CAPS[c.toLowerCase()] ?? c).join('');
}

function toBold(text: string): string {
  return text.split('').map(c => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + (code - 97));
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
    return c;
  }).join('');
}

function toBoldItalic(text: string): string {
  return text.split('').map(c => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D63C + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D656 + (code - 97));
    return c;
  }).join('');
}

type FontStyle = 'normal' | 'smallCaps' | 'bold' | 'boldItalic';

function applyFont(text: string, style: FontStyle): string {
  if (style === 'smallCaps') return toSmallCaps(text);
  if (style === 'bold') return toBold(text);
  if (style === 'boldItalic') return toBoldItalic(text);
  return text;
}

const FONT_STYLES: Array<{ value: FontStyle; label: string; example: string }> = [
  { value: 'normal', label: 'Normal', example: 'primjer' },
  { value: 'smallCaps', label: 'Small Caps', example: toSmallCaps('primjer') },
  { value: 'bold', label: 'Bold', example: toBold('primjer') },
  { value: 'boldItalic', label: 'Bold Italic', example: toBoldItalic('primjer') },
];

// ── Discord Preview Component ──
function DiscordPreview({ categories }: { categories: CategoryDef[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]));

  const toggle = (i: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  return (
    <div className="bg-[#2b2d31] rounded-lg p-3 font-sans text-[13px] max-h-[500px] overflow-y-auto border border-[#1e1f22]">
      <div className="text-[11px] font-semibold text-[#949ba4] uppercase tracking-wider mb-2 px-1">
        Preview — Discord
      </div>
      {categories.map((cat, ci) => {
        const isOpen = expanded.has(ci);
        return (
          <div key={ci} className="mb-1">
            {/* Category header */}
            <div
              className="flex items-center gap-1 px-1 py-0.5 cursor-pointer hover:text-[#dbdee1] text-[#949ba4] text-[12px] font-semibold uppercase tracking-wide"
              onClick={() => toggle(ci)}
            >
              <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? '' : '-rotate-90'}`} />
              <span className="truncate">{cat.name}</span>
            </div>
            {/* Channels */}
            {isOpen && cat.channels.map((ch, chi) => {
              const Icon = CHANNEL_TYPE_ICON[ch.type] || Hash;
              const flags = [
                ch.readOnly && '🔒',
                ch.staffOnly && '🛡️',
                ch.playerOnly && '🌾',
                ch.freeWrite && '✏️',
              ].filter(Boolean);
              return (
                <div
                  key={chi}
                  className="flex items-center gap-1.5 px-2 py-1 ml-1 rounded hover:bg-[#35373c] cursor-default group"
                >
                  <Icon className="w-4 h-4 text-[#80848e] shrink-0" />
                  <span className="text-[#949ba4] group-hover:text-[#dbdee1] truncate flex-1">{ch.name}</span>
                  {flags.length > 0 && (
                    <span className="text-[10px] shrink-0">{flags.join('')}</span>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {categories.length === 0 && (
        <div className="text-[#949ba4] text-center py-6">Nema kategorija</div>
      )}
    </div>
  );
}

// ── Channel Editor Dialog ──
function ChannelEditorDialog({
  open,
  onClose,
  channel,
  onSave,
  copySourceChannels,
}: {
  open: boolean;
  onClose: () => void;
  channel: ChannelDef | null;
  onSave: (ch: ChannelDef) => void;
  copySourceChannels: GuildChannel[];
}) {
  const [name, setName] = useState('');
  const [rawName, setRawName] = useState('');
  const [type, setType] = useState<'text' | 'voice' | 'forum'>('text');
  const [readOnly, setReadOnly] = useState(false);
  const [staffOnly, setStaffOnly] = useState(false);
  const [playerOnly, setPlayerOnly] = useState(false);
  const [freeWrite, setFreeWrite] = useState(false);
  const [selectedEmoji, setSelectedEmoji] = useState('');
  const [fontStyle, setFontStyle] = useState<FontStyle>('smallCaps');
  const [separator, setSeparator] = useState('┃');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [copyFromId, setCopyFromId] = useState('');

  useEffect(() => {
    if (channel) {
      setName(channel.name);
      setType(channel.type);
      setReadOnly(!!channel.readOnly);
      setStaffOnly(!!channel.staffOnly);
      setPlayerOnly(!!channel.playerOnly);
      setFreeWrite(!!channel.freeWrite);
      // Try to extract emoji and raw name from existing name
      const match = channel.name.match(/^(.+?)(┃| )(.+)$/);
      if (match) {
        setSelectedEmoji(match[1]);
        setSeparator(match[2]);
        setRawName(''); // Don't reverse-transform
      } else {
        setSelectedEmoji('');
        setRawName('');
      }
    } else {
      setName('');
      setRawName('');
      setType('text');
      setReadOnly(false);
      setStaffOnly(false);
      setPlayerOnly(false);
      setFreeWrite(false);
      setSelectedEmoji('💬');
      setFontStyle('smallCaps');
      setSeparator('┃');
      setCopyFromId('');
    }
  }, [channel, open]);

  // Build final name from parts
  const buildName = () => {
    if (channel && !rawName) return name; // Editing existing without changing name
    const transformed = rawName ? applyFont(rawName, fontStyle) : '';
    if (selectedEmoji && transformed) {
      return `${selectedEmoji}${separator}${transformed}`;
    }
    return transformed || name;
  };

  const finalName = buildName();

  // Copy permissions from selected channel
  const handleCopyPerms = () => {
    const source = copySourceChannels.find(c => c.id === copyFromId);
    if (!source) return;
    // Analyze overwrites to determine permission type
    const hasEveryone = source.overwrites.find(ow => ow.name === '@everyone');
    const hasViewDeny = hasEveryone?.deny.includes('ViewChannel');
    const hasSendDeny = hasEveryone?.deny.includes('SendMessages');
    const hasStaffAllow = source.overwrites.some(ow =>
      ow.name.includes('Upravitelj') || ow.name.includes('Admin') || ow.name.includes('Nadzornik')
    );
    const hasPlayerAllow = source.overwrites.some(ow =>
      ow.name === 'Player' || ow.name === 'Igrač'
    );

    if (hasViewDeny && hasStaffAllow && !hasPlayerAllow) {
      setStaffOnly(true); setPlayerOnly(false); setReadOnly(false); setFreeWrite(false);
    } else if (hasViewDeny && hasPlayerAllow) {
      setPlayerOnly(true); setStaffOnly(false);
      setReadOnly(hasSendDeny || false);
      setFreeWrite(false);
    } else if (hasSendDeny) {
      setReadOnly(true); setStaffOnly(false); setPlayerOnly(false); setFreeWrite(false);
    } else {
      setFreeWrite(true); setReadOnly(false); setStaffOnly(false); setPlayerOnly(false);
    }

    // Also copy channel type
    if (source.type === 2) setType('voice');
    else if (source.type === 15) setType('forum');
    else setType('text');
  };

  const handleSave = () => {
    const ch: ChannelDef = {
      name: finalName,
      type,
    };
    if (readOnly) ch.readOnly = true;
    if (staffOnly) ch.staffOnly = true;
    if (playerOnly) ch.playerOnly = true;
    if (freeWrite) ch.freeWrite = true;
    onSave(ch);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{channel ? 'Uredi Kanal' : 'Novi Kanal'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* Name builder */}
          {!channel && (
            <>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Ime kanala (plain text)</label>
                <Input
                  value={rawName}
                  onChange={e => setRawName(e.target.value)}
                  placeholder="npr. obavijesti"
                  className="h-9"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                {/* Emoji picker */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Ikonica</label>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 w-12 text-lg"
                      onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                    >
                      {selectedEmoji || <Smile className="w-4 h-4" />}
                    </Button>
                    <Select value={separator} onValueChange={setSeparator}>
                      <SelectTrigger className="h-9 w-20">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="┃">┃</SelectItem>
                        <SelectItem value=" "> (space)</SelectItem>
                        <SelectItem value="│">│</SelectItem>
                        <SelectItem value="·">·</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {showEmojiPicker && (
                    <div className="grid grid-cols-10 gap-1 mt-2 p-2 bg-muted rounded-lg max-h-32 overflow-y-auto">
                      {EMOJI_LIST.map(e => (
                        <button
                          key={e}
                          className={`text-lg w-7 h-7 rounded hover:bg-primary/20 flex items-center justify-center ${selectedEmoji === e ? 'bg-primary/30 ring-1 ring-primary' : ''}`}
                          onClick={() => { setSelectedEmoji(e); setShowEmojiPicker(false); }}
                        >
                          {e}
                        </button>
                      ))}
                      <button
                        className="text-xs w-7 h-7 rounded hover:bg-destructive/20 flex items-center justify-center text-muted-foreground"
                        onClick={() => { setSelectedEmoji(''); setShowEmojiPicker(false); }}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>

                {/* Font style */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Font stil</label>
                  <Select value={fontStyle} onValueChange={(v) => setFontStyle(v as FontStyle)}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FONT_STYLES.map(fs => (
                        <SelectItem key={fs.value} value={fs.value}>
                          <span className="mr-2">{fs.label}</span>
                          <span className="text-muted-foreground text-xs">({fs.example})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Preview of built name */}
              {rawName && (
                <div className="bg-muted/50 rounded-lg p-3 border">
                  <span className="text-xs text-muted-foreground">Preview: </span>
                  <span className="font-medium">{finalName}</span>
                </div>
              )}
            </>
          )}

          {/* Edit existing name directly */}
          {channel && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Ime kanala</label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                className="h-9"
              />
            </div>
          )}

          {/* Channel type */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Tip kanala</label>
            <Select value={type} onValueChange={(v) => setType(v as 'text' | 'voice' | 'forum')}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text"><Hash className="w-3 h-3 inline mr-1" />Text</SelectItem>
                <SelectItem value="voice"><Volume2 className="w-3 h-3 inline mr-1" />Voice</SelectItem>
                <SelectItem value="forum"><MessageSquare className="w-3 h-3 inline mr-1" />Forum</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Permissions */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">Permisije</label>
            <div className="grid grid-cols-2 gap-2">
              {PERM_FLAGS.map(pf => {
                const val = pf.key === 'readOnly' ? readOnly : pf.key === 'staffOnly' ? staffOnly : pf.key === 'playerOnly' ? playerOnly : freeWrite;
                const setter = pf.key === 'readOnly' ? setReadOnly : pf.key === 'staffOnly' ? setStaffOnly : pf.key === 'playerOnly' ? setPlayerOnly : setFreeWrite;
                return (
                  <div key={pf.key} className="flex items-center justify-between bg-muted/30 rounded-lg p-2">
                    <div className="flex items-center gap-2">
                      <pf.icon className={`w-3.5 h-3.5 ${pf.color}`} />
                      <div>
                        <div className="text-xs font-medium">{pf.label}</div>
                        <div className="text-[10px] text-muted-foreground">{pf.desc}</div>
                      </div>
                    </div>
                    <Switch
                      checked={val}
                      onCheckedChange={setter}
                      className="scale-75"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Copy permissions from existing channel */}
          {copySourceChannels.length > 0 && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block flex items-center gap-1">
                <Copy className="w-3 h-3" /> Kopiraj permisije s postojećeg kanala
              </label>
              <div className="flex gap-2">
                <Select value={copyFromId} onValueChange={setCopyFromId}>
                  <SelectTrigger className="h-9 flex-1">
                    <SelectValue placeholder="Odaberi kanal..." />
                  </SelectTrigger>
                  <SelectContent>
                    {copySourceChannels
                      .filter(c => c.type !== 4) // exclude categories
                      .map(c => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.parentName && <span className="text-muted-foreground">{c.parentName} › </span>}
                          #{c.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" className="h-9" onClick={handleCopyPerms} disabled={!copyFromId}>
                  <Copy className="w-3 h-3 mr-1" /> Kopiraj
                </Button>
              </div>
            </div>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={onClose}>Odustani</Button>
            <Button onClick={handleSave} disabled={!finalName}>
              <Check className="w-4 h-4 mr-1" />
              {channel ? 'Spremi' : 'Dodaj'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Category Editor Dialog ──
function CategoryEditorDialog({
  open,
  onClose,
  category,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  category: string | null;
  onSave: (name: string) => void;
}) {
  const [rawName, setRawName] = useState('');
  const [fontStyle, setFontStyle] = useState<FontStyle>('bold');
  const [prefix, setPrefix] = useState('── ');
  const [suffix, setSuffix] = useState(' ──');
  const [selectedEmoji, setSelectedEmoji] = useState('📌');
  const [directName, setDirectName] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  useEffect(() => {
    if (category) {
      setDirectName(category);
      setRawName('');
    } else {
      setDirectName('');
      setRawName('');
      setFontStyle('bold');
      setPrefix('── ');
      setSuffix(' ──');
      setSelectedEmoji('📌');
    }
  }, [category, open]);

  const buildName = () => {
    if (category && !rawName) return directName;
    const transformed = rawName ? applyFont(rawName.toUpperCase(), fontStyle) : '';
    const p = prefix === 'none' ? '' : prefix;
    const s = prefix === 'none' ? '' : suffix;
    return `${p}${selectedEmoji} ${transformed}${s}`;
  };

  const finalName = buildName();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{category ? 'Uredi Kategoriju' : 'Nova Kategorija'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {!category && (
            <>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Ime kategorije (plain text)</label>
                <Input
                  value={rawName}
                  onChange={e => setRawName(e.target.value)}
                  placeholder="npr. INFORMACIJE"
                  className="h-9"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Ikonica</label>
                  <Button variant="outline" size="sm" className="h-9 w-12 text-lg" onClick={() => setShowEmojiPicker(!showEmojiPicker)}>
                    {selectedEmoji || <Smile className="w-4 h-4" />}
                  </Button>
                  {showEmojiPicker && (
                    <div className="grid grid-cols-10 gap-1 mt-2 p-2 bg-muted rounded-lg max-h-32 overflow-y-auto">
                      {EMOJI_LIST.map(e => (
                        <button key={e} className={`text-lg w-7 h-7 rounded hover:bg-primary/20 flex items-center justify-center ${selectedEmoji === e ? 'bg-primary/30 ring-1 ring-primary' : ''}`}
                          onClick={() => { setSelectedEmoji(e); setShowEmojiPicker(false); }}>{e}</button>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Font</label>
                  <Select value={fontStyle} onValueChange={(v) => setFontStyle(v as FontStyle)}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FONT_STYLES.map(fs => (
                        <SelectItem key={fs.value} value={fs.value}>{fs.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Okvir</label>
                <Select value={prefix} onValueChange={(v) => { setPrefix(v); setSuffix(v === '── ' ? ' ──' : v === '═══ ' ? ' ═══' : v === '▸ ' ? '' : ''); }}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="── ">── ──</SelectItem>
                    <SelectItem value="═══ ">═══ ═══</SelectItem>
                    <SelectItem value="▸ ">▸ (arrow)</SelectItem>
                    <SelectItem value="none">(bez okvira)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {category && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Ime kategorije</label>
              <Input
                value={directName}
                onChange={e => setDirectName(e.target.value)}
                className="h-9"
              />
            </div>
          )}

          {/* Preview */}
          <div className="bg-[#2b2d31] rounded-lg p-3 border border-[#1e1f22]">
            <div className="text-[12px] font-semibold text-[#949ba4] uppercase tracking-wide flex items-center gap-1">
              <ChevronDown className="w-3 h-3" />
              {finalName}
            </div>
            <div className="ml-4 mt-1 text-[13px] text-[#80848e]">
              <div className="flex items-center gap-1.5 py-0.5"><Hash className="w-3.5 h-3.5" /> primjer-kanal</div>
            </div>
          </div>

          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={onClose}>Odustani</Button>
            <Button onClick={() => { onSave(finalName); onClose(); }} disabled={!finalName.trim()}>
              <Check className="w-4 h-4 mr-1" />
              {category ? 'Spremi' : 'Dodaj'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Existing Channel Editor Dialog ──
function ExistingChannelEditorDialog({
  open,
  onClose,
  channel,
  guildId,
  categories,
  allChannels,
  onSave,
  onDelete,
  isSaving,
}: {
  open: boolean;
  onClose: () => void;
  channel: GuildChannel | null;
  guildId: string;
  categories: GuildChannel[];
  allChannels: GuildChannel[];
  onSave: (channelId: string, updates: any) => void;
  onDelete: (channelId: string) => void;
  isSaving: boolean;
}) {
  const [name, setName] = useState('');
  const [rawName, setRawName] = useState('');
  const [fontStyle, setFontStyle] = useState<FontStyle>('normal');
  const [selectedEmoji, setSelectedEmoji] = useState('');
  const [separator, setSeparator] = useState('┃');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [parentId, setParentId] = useState<string>('');
  const [readOnly, setReadOnly] = useState(false);
  const [staffOnly, setStaffOnly] = useState(false);
  const [playerOnly, setPlayerOnly] = useState(false);
  const [freeWrite, setFreeWrite] = useState(false);
  const isCategory = channel?.type === 4;

  useEffect(() => {
    if (channel) {
      setName(channel.name);
      setRawName('');
      setParentId(channel.parentId || '__none__');
      setShowEmojiPicker(false);
      setFontStyle('smallCaps');
      setSelectedEmoji('');
      setSeparator('┃');

      // Try to extract emoji, separator, and raw text from existing name
      const emojiMatch = channel.name.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?)(┃| |│|·)(.+)$/u);
      if (emojiMatch) {
        setSelectedEmoji(emojiMatch[1]);
        setSeparator(emojiMatch[2]);
        setRawName(emojiMatch[3]);
      } else {
        setRawName(channel.name);
      }

      // Analyze existing permissions
      const everyoneOw = channel.overwrites.find(ow => ow.name === '@everyone');
      const hasViewDeny = everyoneOw?.deny.includes('ViewChannel');
      const hasSendDeny = everyoneOw?.deny.includes('SendMessages');
      const hasStaffAllow = channel.overwrites.some(ow =>
        ['Upravitelj', 'Admin', 'Nadzornik', 'Čuvar', 'Gazda', 'Sugazda'].some(n => ow.name.includes(n)) &&
        ow.allow.includes('ViewChannel')
      );
      const hasPlayerAllow = channel.overwrites.some(ow =>
        (ow.name === 'Player' || ow.name === 'Igrač') && ow.allow.includes('ViewChannel')
      );

      if (hasViewDeny && hasStaffAllow && !hasPlayerAllow) {
        setStaffOnly(true); setPlayerOnly(false); setReadOnly(false); setFreeWrite(false);
      } else if (hasViewDeny && hasPlayerAllow) {
        setPlayerOnly(true); setStaffOnly(false);
        setReadOnly(hasSendDeny || false); setFreeWrite(false);
      } else if (hasSendDeny && !hasViewDeny) {
        setReadOnly(true); setStaffOnly(false); setPlayerOnly(false); setFreeWrite(false);
      } else {
        setFreeWrite(true); setReadOnly(false); setStaffOnly(false); setPlayerOnly(false);
      }
    }
  }, [channel, open]);

  const buildName = () => {
    const transformed = rawName ? applyFont(rawName, fontStyle) : '';
    if (selectedEmoji && transformed) return `${selectedEmoji}${separator}${transformed}`;
    return transformed || name;
  };

  const finalName = buildName();

  const handleSave = () => {
    if (!channel) return;
    const updates: any = {};
    if (finalName !== channel.name) updates.name = finalName;
    if (parentId !== '__none__' && parentId !== (channel.parentId || '__none__')) {
      updates.parentId = parentId === '__none__' ? null : parentId;
    }
    updates.permFlags = { readOnly, staffOnly, playerOnly, freeWrite };
    onSave(channel.id, updates);
    onClose();
  };

  if (!channel) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isCategory ? (
              <><Settings className="w-4 h-4" /> Uredi Kategoriju</>
            ) : (
              <><Pencil className="w-4 h-4" /> Uredi Kanal</>
            )}
            <Badge variant="outline" className="text-[10px] ml-auto font-mono">{channel.id}</Badge>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* Name builder */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Ime kanala (plain text)</label>
            <Input
              value={rawName}
              onChange={e => setRawName(e.target.value)}
              placeholder="npr. obavijesti"
              className="h-9"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Emoji picker */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Ikonica</label>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 w-12 text-lg"
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                >
                  {selectedEmoji || <Smile className="w-4 h-4" />}
                </Button>
                <Select value={separator} onValueChange={setSeparator}>
                  <SelectTrigger className="h-9 w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="┃">┃</SelectItem>
                    <SelectItem value=" "> (space)</SelectItem>
                    <SelectItem value="│">│</SelectItem>
                    <SelectItem value="·">·</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {showEmojiPicker && (
                <div className="grid grid-cols-10 gap-1 mt-2 p-2 bg-muted rounded-lg max-h-32 overflow-y-auto">
                  {EMOJI_LIST.map(e => (
                    <button
                      key={e}
                      className={`text-lg w-7 h-7 rounded hover:bg-primary/20 flex items-center justify-center ${selectedEmoji === e ? 'bg-primary/30 ring-1 ring-primary' : ''}`}
                      onClick={() => { setSelectedEmoji(e); setShowEmojiPicker(false); }}
                    >
                      {e}
                    </button>
                  ))}
                  <button
                    className="text-xs w-7 h-7 rounded hover:bg-destructive/20 flex items-center justify-center text-muted-foreground"
                    onClick={() => { setSelectedEmoji(''); setShowEmojiPicker(false); }}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>

            {/* Font style */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Font stil</label>
              <Select value={fontStyle} onValueChange={(v) => setFontStyle(v as FontStyle)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FONT_STYLES.map(fs => (
                    <SelectItem key={fs.value} value={fs.value}>
                      <span className="mr-2">{fs.label}</span>
                      <span className="text-muted-foreground text-xs">({fs.example})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Preview of built name */}
          {rawName && (
            <div className="bg-muted/50 rounded-lg p-3 border">
              <span className="text-xs text-muted-foreground">Preview: </span>
              <span className="font-medium">{finalName}</span>
            </div>
          )}

          {/* Move to different category (not for categories themselves) */}
          {!isCategory && categories.length > 0 && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                <ArrowUpDown className="w-3 h-3 inline mr-1" />
                Kategorija
              </label>
              <Select value={parentId} onValueChange={setParentId}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Odaberi kategoriju..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">(Bez kategorije)</SelectItem>
                  {categories.map(cat => (
                    <SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Permissions */}
          {!isCategory && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-2 block">Permisije</label>
              {/* Copy permissions from another channel */}
              <div className="mb-3">
                <Select value="__none__" onValueChange={(srcId) => {
                  if (srcId === '__none__') return;
                  const src = allChannels.find(c => c.id === srcId);
                  if (!src) return;
                  const evOw = src.overwrites.find(ow => ow.name === '@everyone');
                  const hasViewDeny = evOw?.deny.includes('ViewChannel');
                  const hasSendDeny = evOw?.deny.includes('SendMessages');
                  const hasStaffAllow = src.overwrites.some(ow =>
                    ['Upravitelj', 'Admin', 'Nadzornik', 'Čuvar', 'Gazda', 'Sugazda'].some(n => ow.name.includes(n)) &&
                    ow.allow.includes('ViewChannel')
                  );
                  const hasPlayerAllow = src.overwrites.some(ow =>
                    (ow.name === 'Player' || ow.name === 'Igrač') && ow.allow.includes('ViewChannel')
                  );
                  if (hasViewDeny && hasStaffAllow && !hasPlayerAllow) {
                    setStaffOnly(true); setPlayerOnly(false); setReadOnly(false); setFreeWrite(false);
                  } else if (hasViewDeny && hasPlayerAllow) {
                    setPlayerOnly(true); setStaffOnly(false);
                    setReadOnly(hasSendDeny || false); setFreeWrite(false);
                  } else if (hasSendDeny && !hasViewDeny) {
                    setReadOnly(true); setStaffOnly(false); setPlayerOnly(false); setFreeWrite(false);
                  } else {
                    setFreeWrite(true); setReadOnly(false); setStaffOnly(false); setPlayerOnly(false);
                  }
                }}>
                  <SelectTrigger className="h-8 text-xs">
                    <Copy className="w-3 h-3 mr-1" />
                    <SelectValue placeholder="Kopiraj permisije od kanala..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Kopiraj permisije od kanala...</SelectItem>
                    {allChannels
                      .filter(c => c.type !== 4 && c.id !== channel?.id)
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map(c => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.parentName ? `${c.parentName} › ` : ''}{c.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {PERM_FLAGS.map(pf => {
                  const val = pf.key === 'readOnly' ? readOnly : pf.key === 'staffOnly' ? staffOnly : pf.key === 'playerOnly' ? playerOnly : freeWrite;
                  const setter = pf.key === 'readOnly' ? setReadOnly : pf.key === 'staffOnly' ? setStaffOnly : pf.key === 'playerOnly' ? setPlayerOnly : setFreeWrite;
                  return (
                    <div key={pf.key} className="flex items-center justify-between bg-muted/30 rounded-lg p-2">
                      <div className="flex items-center gap-2">
                        <pf.icon className={`w-3.5 h-3.5 ${pf.color}`} />
                        <div>
                          <div className="text-xs font-medium">{pf.label}</div>
                          <div className="text-[10px] text-muted-foreground">{pf.desc}</div>
                        </div>
                      </div>
                      <Switch checked={val} onCheckedChange={setter} className="scale-75" />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Existing overwrites info */}
          {channel.overwrites.length > 0 && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Trenutne permisije</label>
              <div className="bg-muted/30 rounded-lg p-2 max-h-24 overflow-y-auto space-y-0.5">
                {channel.overwrites.map((ow, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px]">
                    <Badge variant="outline" className="text-[9px]">{ow.type === 0 ? 'Role' : 'User'}</Badge>
                    <span className="font-medium">{ow.name}</span>
                    {ow.allow.length > 0 && <span className="text-green-500">✓ {ow.allow.length}</span>}
                    {ow.deny.length > 0 && <span className="text-red-500">✕ {ow.deny.length}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 justify-between pt-2">
            <Button variant="destructive" size="sm" onClick={() => { onDelete(channel.id); onClose(); }}>
              <Trash2 className="w-3.5 h-3.5 mr-1" /> Obriši
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>Odustani</Button>
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                Spremi
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Create New Channel Dialog ──
function CreateChannelDialog({
  open,
  onClose,
  guildId,
  categories,
  allChannels,
  onCreate,
  isCreating,
}: {
  open: boolean;
  onClose: () => void;
  guildId: string;
  categories: GuildChannel[];
  allChannels: GuildChannel[];
  onCreate: (data: { name: string; type: number; parentId: string | null; permFlags: any }) => void;
  isCreating: boolean;
}) {
  const [rawName, setRawName] = useState('');
  const [fontStyle, setFontStyle] = useState<FontStyle>('smallCaps');
  const [selectedEmoji, setSelectedEmoji] = useState('');
  const [separator, setSeparator] = useState('┃');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [parentId, setParentId] = useState<string>('__none__');
  const [channelType, setChannelType] = useState<number>(0);
  const [readOnly, setReadOnly] = useState(false);
  const [staffOnly, setStaffOnly] = useState(false);
  const [playerOnly, setPlayerOnly] = useState(false);
  const [freeWrite, setFreeWrite] = useState(true);

  useEffect(() => {
    if (open) {
      setRawName('');
      setFontStyle('smallCaps');
      setSelectedEmoji('');
      setSeparator('┃');
      setShowEmojiPicker(false);
      setParentId('__none__');
      setChannelType(0);
      setReadOnly(false);
      setStaffOnly(false);
      setPlayerOnly(false);
      setFreeWrite(true);
    }
  }, [open]);

  const buildName = () => {
    const transformed = rawName ? applyFont(rawName, fontStyle) : '';
    if (selectedEmoji && transformed) return `${selectedEmoji}${separator}${transformed}`;
    return transformed;
  };

  const finalName = buildName();

  const handleCreate = () => {
    if (!finalName.trim()) return;
    onCreate({
      name: finalName,
      type: channelType,
      parentId: parentId === '__none__' ? null : parentId,
      permFlags: { readOnly, staffOnly, playerOnly, freeWrite },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="w-4 h-4" /> Kreiraj Novi Kanal
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Ime kanala (plain text)</label>
            <Input
              value={rawName}
              onChange={e => setRawName(e.target.value)}
              placeholder="npr. obavijesti"
              className="h-9"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Emoji picker */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Ikonica</label>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 w-12 text-lg"
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                >
                  {selectedEmoji || <Smile className="w-4 h-4" />}
                </Button>
                <Select value={separator} onValueChange={setSeparator}>
                  <SelectTrigger className="h-9 w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="┃">┃</SelectItem>
                    <SelectItem value=" "> (space)</SelectItem>
                    <SelectItem value="│">│</SelectItem>
                    <SelectItem value="·">·</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {showEmojiPicker && (
                <div className="grid grid-cols-10 gap-1 mt-2 p-2 bg-muted rounded-lg max-h-32 overflow-y-auto">
                  {EMOJI_LIST.map(e => (
                    <button
                      key={e}
                      className={`text-lg w-7 h-7 rounded hover:bg-primary/20 flex items-center justify-center ${selectedEmoji === e ? 'bg-primary/30 ring-1 ring-primary' : ''}`}
                      onClick={() => { setSelectedEmoji(e); setShowEmojiPicker(false); }}
                    >
                      {e}
                    </button>
                  ))}
                  <button
                    className="text-xs w-7 h-7 rounded hover:bg-destructive/20 flex items-center justify-center text-muted-foreground"
                    onClick={() => { setSelectedEmoji(''); setShowEmojiPicker(false); }}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>

            {/* Font style */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Font stil</label>
              <Select value={fontStyle} onValueChange={(v) => setFontStyle(v as FontStyle)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FONT_STYLES.map(fs => (
                    <SelectItem key={fs.value} value={fs.value}>
                      <span className="mr-2">{fs.label}</span>
                      <span className="text-muted-foreground text-xs">({fs.example})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Preview */}
          {rawName && (
            <div className="bg-muted/50 rounded-lg p-3 border">
              <span className="text-xs text-muted-foreground">Preview: </span>
              <span className="font-medium">{finalName}</span>
            </div>
          )}

          {/* Channel type */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Tip kanala</label>
            <Select value={String(channelType)} onValueChange={(v) => setChannelType(Number(v))}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0"><Hash className="w-3 h-3 inline mr-1" /> Text kanal</SelectItem>
                <SelectItem value="2"><Volume2 className="w-3 h-3 inline mr-1" /> Voice kanal</SelectItem>
                <SelectItem value="15"><MessageSquare className="w-3 h-3 inline mr-1" /> Forum kanal</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Category */}
          {categories.length > 0 && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                <ArrowUpDown className="w-3 h-3 inline mr-1" />
                Kategorija
              </label>
              <Select value={parentId} onValueChange={setParentId}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Odaberi kategoriju..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">(Bez kategorije)</SelectItem>
                  {categories.map(cat => (
                    <SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Permissions */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">Permisije</label>
            {/* Copy from existing */}
            <div className="mb-3">
              <Select value="__none__" onValueChange={(srcId) => {
                if (srcId === '__none__') return;
                const src = allChannels.find(c => c.id === srcId);
                if (!src) return;
                const evOw = src.overwrites.find(ow => ow.name === '@everyone');
                const hasViewDeny = evOw?.deny.includes('ViewChannel');
                const hasSendDeny = evOw?.deny.includes('SendMessages');
                const hasStaffAllow = src.overwrites.some(ow =>
                  ['Upravitelj', 'Admin', 'Nadzornik', 'Čuvar', 'Gazda', 'Sugazda'].some(n => ow.name.includes(n)) &&
                  ow.allow.includes('ViewChannel')
                );
                const hasPlayerAllow = src.overwrites.some(ow =>
                  (ow.name === 'Player' || ow.name === 'Igrač') && ow.allow.includes('ViewChannel')
                );
                if (hasViewDeny && hasStaffAllow && !hasPlayerAllow) {
                  setStaffOnly(true); setPlayerOnly(false); setReadOnly(false); setFreeWrite(false);
                } else if (hasViewDeny && hasPlayerAllow) {
                  setPlayerOnly(true); setStaffOnly(false);
                  setReadOnly(hasSendDeny || false); setFreeWrite(false);
                } else if (hasSendDeny && !hasViewDeny) {
                  setReadOnly(true); setStaffOnly(false); setPlayerOnly(false); setFreeWrite(false);
                } else {
                  setFreeWrite(true); setReadOnly(false); setStaffOnly(false); setPlayerOnly(false);
                }
              }}>
                <SelectTrigger className="h-8 text-xs">
                  <Copy className="w-3 h-3 mr-1" />
                  <SelectValue placeholder="Kopiraj permisije od kanala..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Kopiraj permisije od kanala...</SelectItem>
                  {allChannels
                    .filter(c => c.type !== 4)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(c => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.parentName ? `${c.parentName} › ` : ''}{c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {PERM_FLAGS.map(pf => {
                const val = pf.key === 'readOnly' ? readOnly : pf.key === 'staffOnly' ? staffOnly : pf.key === 'playerOnly' ? playerOnly : freeWrite;
                const setter = pf.key === 'readOnly' ? setReadOnly : pf.key === 'staffOnly' ? setStaffOnly : pf.key === 'playerOnly' ? setPlayerOnly : setFreeWrite;
                return (
                  <div key={pf.key} className="flex items-center justify-between bg-muted/30 rounded-lg p-2">
                    <div className="flex items-center gap-2">
                      <pf.icon className={`w-3.5 h-3.5 ${pf.color}`} />
                      <div>
                        <div className="text-xs font-medium">{pf.label}</div>
                        <div className="text-[10px] text-muted-foreground">{pf.desc}</div>
                      </div>
                    </div>
                    <Switch checked={val} onCheckedChange={setter} className="scale-75" />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Buttons */}
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={onClose}>Odustani</Button>
            <Button onClick={handleCreate} disabled={isCreating || !finalName.trim()}>
              {isCreating ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
              Kreiraj
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Create Category Dialog (simple) ──
function CreateCategoryDialog({
  open,
  onClose,
  onCreate,
  isCreating,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => void;
  isCreating: boolean;
}) {
  const [rawName, setRawName] = useState('');
  const [fontStyle, setFontStyle] = useState<FontStyle>('bold');
  const [prefix, setPrefix] = useState('── ');
  const [suffix, setSuffix] = useState(' ──');
  const [selectedEmoji, setSelectedEmoji] = useState('📌');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  useEffect(() => {
    if (open) {
      setRawName('');
      setFontStyle('bold');
      setPrefix('── ');
      setSuffix(' ──');
      setSelectedEmoji('📌');
      setShowEmojiPicker(false);
    }
  }, [open]);

  const buildName = () => {
    const transformed = rawName ? applyFont(rawName.toUpperCase(), fontStyle) : '';
    if (!transformed) return '';
    return `${selectedEmoji} ${prefix}${transformed}${suffix} ${selectedEmoji}`;
  };

  const finalName = buildName();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlus className="w-4 h-4" /> Kreiraj Kategoriju
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Ime kategorije (plain text)</label>
            <Input
              value={rawName}
              onChange={e => setRawName(e.target.value)}
              placeholder="npr. Glasovni Kanali"
              className="h-9"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Ikonica</label>
              <Button
                variant="outline"
                size="sm"
                className="h-9 w-12 text-lg"
                onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              >
                {selectedEmoji || <Smile className="w-4 h-4" />}
              </Button>
              {showEmojiPicker && (
                <div className="grid grid-cols-10 gap-1 mt-2 p-2 bg-muted rounded-lg max-h-32 overflow-y-auto">
                  {EMOJI_LIST.map(e => (
                    <button
                      key={e}
                      className={`text-lg w-7 h-7 rounded hover:bg-primary/20 flex items-center justify-center ${selectedEmoji === e ? 'bg-primary/30 ring-1 ring-primary' : ''}`}
                      onClick={() => { setSelectedEmoji(e); setShowEmojiPicker(false); }}
                    >
                      {e}
                    </button>
                  ))}
                  <button
                    className="text-xs w-7 h-7 rounded hover:bg-destructive/20 flex items-center justify-center text-muted-foreground"
                    onClick={() => { setSelectedEmoji(''); setShowEmojiPicker(false); }}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Font stil</label>
              <Select value={fontStyle} onValueChange={(v) => setFontStyle(v as FontStyle)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FONT_STYLES.map(fs => (
                    <SelectItem key={fs.value} value={fs.value}>
                      <span className="mr-2">{fs.label}</span>
                      <span className="text-muted-foreground text-xs">({fs.example})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Prefix</label>
              <Input value={prefix} onChange={e => setPrefix(e.target.value)} className="h-9 text-xs" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Suffix</label>
              <Input value={suffix} onChange={e => setSuffix(e.target.value)} className="h-9 text-xs" />
            </div>
          </div>

          {rawName && (
            <div className="bg-muted/50 rounded-lg p-3 border">
              <span className="text-xs text-muted-foreground">Preview: </span>
              <span className="font-semibold text-xs uppercase tracking-wide">{finalName}</span>
            </div>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={onClose}>Odustani</Button>
            <Button onClick={() => { if (finalName.trim()) { onCreate(finalName); } }} disabled={isCreating || !finalName.trim()}>
              {isCreating ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <FolderPlus className="w-4 h-4 mr-1" />}
              Kreiraj
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Channel Manager Component ──
export function ChannelManager() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Guild selector
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(null);

  // Editor state
  const [editCategoryDialog, setEditCategoryDialog] = useState<{ open: boolean; index: number | null }>({ open: false, index: null });
  const [editChannelDialog, setEditChannelDialog] = useState<{ open: boolean; catIndex: number; chIndex: number | null }>({ open: false, catIndex: -1, chIndex: null });
  const [expandedCategories, setExpandedCategories] = useState<Set<number>>(new Set());
  const [showPreview, setShowPreview] = useState(true);
  const [deployingCat, setDeployingCat] = useState<number | null>(null);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showCreateCategory, setShowCreateCategory] = useState(false);

  // ── Queries ──
  const guildsQuery = useQuery<GuildInfo[]>({
    queryKey: ['/api/bot/guilds'],
    queryFn: async () => { const r = await fetch('/api/bot/guilds'); return r.json(); },
  });

  const configQuery = useQuery<ChannelConfig>({
    queryKey: ['/api/channels/config', selectedGuildId],
    queryFn: async () => {
      const url = selectedGuildId ? `/api/channels/config?guildId=${selectedGuildId}` : '/api/channels/config';
      const r = await fetch(url);
      return r.json();
    },
    enabled: !!selectedGuildId,
  });

  const guildChannelsQuery = useQuery<GuildChannel[]>({
    queryKey: ['/api/channels/guild', selectedGuildId],
    queryFn: async () => { const r = await fetch(`/api/channels/guild/${selectedGuildId}`); return r.json(); },
    enabled: !!selectedGuildId,
    staleTime: 0,
    refetchInterval: 15000,
  });

  // Channel key bindings (Mod Log, Dobrodošlica, etc.)
  const channelKeysQuery = useQuery<Array<{ key: string; label: string; desc: string }>>({
    queryKey: ['/api/bot/channel-keys'],
    queryFn: async () => { const r = await fetch('/api/bot/channel-keys'); if (!r.ok) throw new Error('Failed'); return r.json(); },
    staleTime: 60000,
  });

  const settingsQuery = useQuery<{
    assignments: Record<string, { channelId: string | null; channelName: string | null }>;
    channels: Array<{ id: string; name: string; type: number; parentId: string | null; parentName: string | null }>;
  }>({
    queryKey: ['/api/bot/guilds', selectedGuildId, 'settings'],
    queryFn: async () => { const r = await fetch(`/api/bot/guilds/${selectedGuildId}/settings`); if (!r.ok) throw new Error('Failed'); return r.json(); },
    enabled: !!selectedGuildId,
  });

  const updateSettingMutation = useMutation({
    mutationFn: async ({ key, channelId }: { key: string; channelId: string | null }) => {
      const r = await fetch(`/api/bot/guilds/${selectedGuildId}/settings/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId }),
      });
      if (!r.ok) throw new Error('Failed');
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/bot/guilds', selectedGuildId, 'settings'] });
      toast({ title: '✅ Postavka spremljena' });
    },
    onError: () => {
      toast({ title: '❌ Greška pri spremanju', variant: 'destructive' });
    },
  });

  // Embed editing
  const [embedChannelId, setEmbedChannelId] = useState<string | null>(null);
  const [editingEmbed, setEditingEmbed] = useState<{ messageId: string; embeds: any[]; components: any[] } | null>(null);
  const embedsQuery = useQuery<Array<{ id: string; embeds: Array<{ title?: string; description?: string; color?: number; url?: string; footer?: { text: string } }>; components: Array<{ type: number; components: Array<{ label?: string; url?: string; style: number; emoji?: { name: string } }> }> }>>({
    queryKey: ['/api/channels/guild', selectedGuildId, embedChannelId, 'messages'],
    queryFn: async () => {
      const r = await fetch(`/api/channels/guild/${selectedGuildId}/${embedChannelId}/messages`);
      if (!r.ok) throw new Error('Failed');
      return r.json();
    },
    enabled: !!selectedGuildId && !!embedChannelId,
  });

  const editEmbedMutation = useMutation({
    mutationFn: async ({ channelId, messageId, embeds, components }: { channelId: string; messageId: string; embeds: any[]; components?: any[] }) => {
      const r = await fetch(`/api/channels/guild/${selectedGuildId}/${channelId}/messages/${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds, components }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Failed'); }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/channels/guild', selectedGuildId, embedChannelId, 'messages'] });
      toast({ title: '✅ Embed ažuriran' });
    },
    onError: (e: any) => {
      toast({ title: '❌ Greška', description: e.message, variant: 'destructive' });
    },
  });

  // Auto-select main guild
  useEffect(() => {
    if (!selectedGuildId && guildsQuery.data?.length) {
      const main = guildsQuery.data.find(g => g.isMain) || guildsQuery.data[0];
      setSelectedGuildId(main.id);
    }
  }, [guildsQuery.data, selectedGuildId]);

  // Refetch guild channels when guild changes
  useEffect(() => {
    if (selectedGuildId) {
      queryClient.invalidateQueries({ queryKey: ['/api/channels/guild', selectedGuildId] });
    }
  }, [selectedGuildId, queryClient]);

  // Expand all categories on load
  useEffect(() => {
    if (configQuery.data?.categories) {
      setExpandedCategories(new Set(configQuery.data.categories.map((_, i) => i)));
    }
  }, [configQuery.data]);

  // ── Mutations ──
  const saveConfigMutation = useMutation({
    mutationFn: async (config: ChannelConfig) => {
      const r = await fetch('/api/channels/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...config, guildId: selectedGuildId }),
      });
      if (!r.ok) throw new Error('Failed to save');
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/channels/config', selectedGuildId] });
      toast({ title: '✅ Konfiguracija spremljena' });
    },
    onError: () => {
      toast({ title: '❌ Greška pri spremanju', variant: 'destructive' });
    },
  });

  const deployMutation = useMutation({
    mutationFn: async ({ guildId, categoryIndex }: { guildId: string; categoryIndex: number }) => {
      const r = await fetch('/api/channels/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId, categoryIndex }),
      });
      if (!r.ok) throw new Error('Failed to deploy');
      return r.json();
    },
    onSuccess: (data) => {
      const created = data.results?.filter((r: any) => r.created).length || 0;
      const existing = data.results?.filter((r: any) => !r.created).length || 0;
      toast({ title: `🚀 Deploy: ${data.category}`, description: `Kreirano: ${created}, Postojeći: ${existing}` });
      queryClient.invalidateQueries({ queryKey: ['/api/channels/guild'] });
      setDeployingCat(null);
    },
    onError: () => {
      toast({ title: '❌ Deploy greška', variant: 'destructive' });
      setDeployingCat(null);
    },
  });

  // Mutations for editing existing Discord channels
  const editExistingMutation = useMutation({
    mutationFn: async ({ guildId, channelId, updates }: { guildId: string; channelId: string; updates: any }) => {
      const r = await fetch(`/api/channels/guild/${guildId}/${channelId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Failed'); }
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: `✅ Kanal ažuriran: ${data.name}` });
      queryClient.invalidateQueries({ queryKey: ['/api/channels/guild'] });
    },
    onError: (e: any) => {
      toast({ title: '❌ Greška', description: e.message, variant: 'destructive' });
    },
  });

  const deleteExistingMutation = useMutation({
    mutationFn: async ({ guildId, channelId }: { guildId: string; channelId: string }) => {
      const r = await fetch(`/api/channels/guild/${guildId}/${channelId}`, { method: 'DELETE' });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Failed'); }
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: `🗑️ Kanal obrisan: ${data.name}` });
      queryClient.invalidateQueries({ queryKey: ['/api/channels/guild'] });
    },
    onError: (e: any) => {
      toast({ title: '❌ Greška', description: e.message, variant: 'destructive' });
    },
  });

  const createChannelMutation = useMutation({
    mutationFn: async (data: { guildId: string; name: string; type: number; parentId: string | null; permFlags: any }) => {
      const r = await fetch(`/api/channels/guild/${data.guildId}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: data.name, type: data.type, parentId: data.parentId, permFlags: data.permFlags }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Failed'); }
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: `✅ Kanal kreiran: ${data.name}` });
      queryClient.invalidateQueries({ queryKey: ['/api/channels/guild'] });
      setShowCreateChannel(false);
    },
    onError: (e: any) => {
      toast({ title: '❌ Greška', description: e.message, variant: 'destructive' });
    },
  });

  const createCategoryMutation = useMutation({
    mutationFn: async ({ guildId, categoryName }: { guildId: string; categoryName: string }) => {
      const r = await fetch('/api/channels/deploy-category', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId, categoryName }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Failed'); }
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: `✅ Kategorija kreirana: ${data.name}` });
      queryClient.invalidateQueries({ queryKey: ['/api/channels/guild'] });
      setShowCreateCategory(false);
    },
    onError: (e: any) => {
      toast({ title: '❌ Greška', description: e.message, variant: 'destructive' });
    },
  });

  // State for editing existing channels
  const [editExistingDialog, setEditExistingDialog] = useState<{ open: boolean; channel: GuildChannel | null }>({ open: false, channel: null });

  // Factory reset mutation
  const resetConfigMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/channels/config/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId: selectedGuildId }),
      });
      if (!r.ok) throw new Error('Failed to reset');
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/channels/config', selectedGuildId] });
      toast({ title: '🔄 Konfiguracija vraćena na tvorničke postavke' });
    },
    onError: () => {
      toast({ title: '❌ Greška pri resetu', variant: 'destructive' });
    },
  });

  // Auto-assign channels mutation
  const autoAssignMutation = useMutation({
    mutationFn: async (guildId: string) => {
      const r = await fetch(`/api/bot/guilds/${guildId}/auto-assign`, { method: 'POST' });
      if (!r.ok) throw new Error('Failed to auto-assign');
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: `⚡ Auto-assign: ${data.assigned} kanala povezano` });
      queryClient.invalidateQueries({ queryKey: ['/api/bot/guilds'] });
    },
    onError: () => {
      toast({ title: '❌ Greška pri auto-assign', variant: 'destructive' });
    },
  });

  // Deploy category to Discord
  const deployCategoryMutation = useMutation({
    mutationFn: async ({ guildId, categoryName }: { guildId: string; categoryName: string }) => {
      const r = await fetch('/api/channels/deploy-category', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId, categoryName }),
      });
      if (!r.ok) throw new Error('Failed to create category');
      return r.json();
    },
    onSuccess: (data) => {
      if (data.created) {
        toast({ title: `🚀 Kategorija kreirana na Discordu: ${data.name}` });
      } else {
        toast({ title: `✅ Kategorija već postoji: ${data.name}` });
      }
      queryClient.invalidateQueries({ queryKey: ['/api/channels/guild'] });
    },
    onError: () => {
      toast({ title: '❌ Greška pri kreiranju kategorije', variant: 'destructive' });
    },
  });

  // ── Config helpers ──
  const config = configQuery.data || { categories: [], farmChannels: [] };

  const updateConfig = (updater: (c: ChannelConfig) => ChannelConfig) => {
    const newConfig = updater({ ...config, categories: [...config.categories], farmChannels: [...config.farmChannels] });
    saveConfigMutation.mutate(newConfig);
  };

  const addCategory = (name: string) => {
    updateConfig(c => ({ ...c, categories: [...c.categories, { name, channels: [] }] }));
    // Auto-deploy to Discord
    if (selectedGuildId) {
      deployCategoryMutation.mutate({ guildId: selectedGuildId, categoryName: name });
    }
  };

  const editCategory = (index: number, name: string) => {
    updateConfig(c => {
      const cats = [...c.categories];
      cats[index] = { ...cats[index], name };
      return { ...c, categories: cats };
    });
  };

  const deleteCategory = (index: number) => {
    if (!confirm(`Obrisati kategoriju "${config.categories[index]?.name}" i sve njene kanale iz konfiguracije?`)) return;
    updateConfig(c => {
      const cats = [...c.categories];
      cats.splice(index, 1);
      return { ...c, categories: cats };
    });
  };

  // Deploy single channel to Discord
  const deploySingleMutation = useMutation({
    mutationFn: async ({ guildId, categoryName, channel }: { guildId: string; categoryName: string; channel: ChannelDef }) => {
      const r = await fetch('/api/channels/deploy-single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId, categoryName, channel }),
      });
      if (!r.ok) throw new Error('Failed to deploy');
      return r.json();
    },
    onSuccess: (data) => {
      if (data.created) {
        toast({ title: `🚀 Kanal kreiran na Discordu: ${data.name}` });
      } else {
        toast({ title: `✅ Kanal već postoji: ${data.name}` });
      }
      queryClient.invalidateQueries({ queryKey: ['/api/channels/guild'] });
    },
    onError: () => {
      toast({ title: '❌ Greška pri deployu kanala', variant: 'destructive' });
    },
  });

  const addChannel = (catIndex: number, channel: ChannelDef) => {
    updateConfig(c => {
      const cats = [...c.categories];
      cats[catIndex] = { ...cats[catIndex], channels: [...cats[catIndex].channels, channel] };
      return { ...c, categories: cats };
    });
    // Auto-deploy to Discord
    if (selectedGuildId && config.categories[catIndex]) {
      deploySingleMutation.mutate({
        guildId: selectedGuildId,
        categoryName: config.categories[catIndex].name,
        channel,
      });
    }
  };

  const editChannel = (catIndex: number, chIndex: number, channel: ChannelDef) => {
    updateConfig(c => {
      const cats = [...c.categories];
      const chs = [...cats[catIndex].channels];
      chs[chIndex] = channel;
      cats[catIndex] = { ...cats[catIndex], channels: chs };
      return { ...c, categories: cats };
    });
    // Auto-deploy edited channel to Discord
    if (selectedGuildId && config.categories[catIndex]) {
      deploySingleMutation.mutate({
        guildId: selectedGuildId,
        categoryName: config.categories[catIndex].name,
        channel,
      });
    }
  };

  const deleteChannel = (catIndex: number, chIndex: number) => {
    const ch = config.categories[catIndex]?.channels[chIndex];
    if (!confirm(`Obrisati kanal "${ch?.name}" iz konfiguracije?`)) return;
    updateConfig(c => {
      const cats = [...c.categories];
      const chs = [...cats[catIndex].channels];
      chs.splice(chIndex, 1);
      cats[catIndex] = { ...cats[catIndex], channels: chs };
      return { ...c, categories: cats };
    });
  };

  const moveChannel = (catIndex: number, chIndex: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? chIndex - 1 : chIndex + 1;
    if (newIndex < 0 || newIndex >= config.categories[catIndex].channels.length) return;
    updateConfig(c => {
      const cats = [...c.categories];
      const chs = [...cats[catIndex].channels];
      [chs[chIndex], chs[newIndex]] = [chs[newIndex], chs[chIndex]];
      cats[catIndex] = { ...cats[catIndex], channels: chs };
      return { ...c, categories: cats };
    });
  };

  const moveCategory = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= config.categories.length) return;
    updateConfig(c => {
      const cats = [...c.categories];
      [cats[index], cats[newIndex]] = [cats[newIndex], cats[index]];
      return { ...c, categories: cats };
    });
  };

  const toggleCategory = (i: number) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  // ── Render ──
  if (configQuery.isLoading || guildsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
        <span className="ml-2 text-muted-foreground">Učitavanje...</span>
      </div>
    );
  }

  const totalChannels = config.categories.reduce((s, c) => s + c.channels.length, 0);

  return (
    <div className="space-y-4">
      {/* Header — guild selector + stats */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">Server:</span>
              <Select value={selectedGuildId || ''} onValueChange={setSelectedGuildId}>
                <SelectTrigger className="h-8 w-56">
                  <SelectValue placeholder="Odaberi server..." />
                </SelectTrigger>
                <SelectContent>
                  {guildsQuery.data?.map(g => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                      {g.isMain && ' (Glavni)'}
                      {g.isTest && ' (Test)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              {selectedGuildId && guildChannelsQuery.data && (
                <Badge variant="secondary">{guildChannelsQuery.data.filter(c => c.type !== 4).length} kanala</Badge>
              )}
              {selectedGuildId && guildChannelsQuery.data && (
                <Badge variant="secondary">{guildChannelsQuery.data.filter(c => c.type === 4).length} kategorija</Badge>
              )}
              {saveConfigMutation.isPending && (
                <Badge variant="outline" className="text-yellow-400 border-yellow-400/30">
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Spremanje...
                </Badge>
              )}
              {saveConfigMutation.isSuccess && !saveConfigMutation.isPending && (
                <Badge variant="outline" className="text-green-400 border-green-400/30">
                  <Check className="w-3 h-3 mr-1" /> Spremljeno
                </Badge>
              )}
            </div>

            <div className="ml-auto flex items-center gap-2">
              {selectedGuildId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => autoAssignMutation.mutate(selectedGuildId)}
                  disabled={autoAssignMutation.isPending}
                  className="h-8"
                  title="Automatski poveži kanale (log, welcome, console...)"
                >
                  <Zap className="w-3.5 h-3.5 mr-1" />
                  Auto-assign
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (selectedGuildId) guildChannelsQuery.refetch();
                }}
                className="h-8"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 grid-cols-1">
        {/* Existing Discord channels — main panel */}
        <div>
          {selectedGuildId && guildChannelsQuery.data ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-1">
                  <Globe className="w-4 h-4" /> Postojeći kanali
                  <span className="text-xs text-muted-foreground font-normal">
                    ({guildsQuery.data?.find(g => g.id === selectedGuildId)?.name || '...'})
                  </span>
                  <Badge variant="outline" className="text-[10px] ml-auto">
                    {guildChannelsQuery.data.filter(c => c.type !== 4).length} ch
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="max-h-[600px] overflow-y-auto text-xs space-y-0.5">
                  {(() => {
                    const channels = guildChannelsQuery.data;
                    const categories = channels.filter(c => c.type === 4).sort((a, b) => a.position - b.position);
                    const uncategorized = channels.filter(c => c.type !== 4 && !c.parentId);

                    const renderChannel = (ch: GuildChannel) => (
                      <div key={ch.id} className="flex items-center gap-1 px-2 py-1 text-muted-foreground hover:text-foreground hover:bg-muted/30 rounded group cursor-pointer"
                        onClick={() => setEditExistingDialog({ open: true, channel: ch })}
                      >
                        {ch.type === 2 ? <Volume2 className="w-3 h-3 shrink-0" /> : ch.type === 15 ? <MessageSquare className="w-3 h-3 shrink-0" /> : <Hash className="w-3 h-3 shrink-0" />}
                        <span className="truncate flex-1">{ch.name}</span>
                        {ch.overwrites.length > 0 && (
                          <Lock className="w-2.5 h-2.5 text-muted-foreground/40 shrink-0" />
                        )}
                        <Pencil className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 text-primary shrink-0" />
                      </div>
                    );

                    return (
                      <>
                        {uncategorized.map(renderChannel)}
                        {categories.map(cat => {
                          const children = channels.filter(c => c.parentId === cat.id).sort((a, b) => a.position - b.position);
                          return (
                            <div key={cat.id}>
                              <div className="font-semibold text-[10px] text-muted-foreground uppercase tracking-wide px-1 pt-2 pb-0.5 truncate flex items-center gap-1 group cursor-pointer hover:text-foreground"
                                onClick={() => setEditExistingDialog({ open: true, channel: { ...cat, type: 4 } as any })}
                              >
                                <span className="truncate flex-1">{cat.name}</span>
                                <Pencil className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 text-primary shrink-0" />
                              </div>
                              {children.map(renderChannel)}
                            </div>
                          );
                        })}
                      </>
                    );
                  })()}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="p-8 text-center">
              <Globe className="w-8 h-8 mx-auto mb-2 text-muted-foreground opacity-50" />
              <p className="text-muted-foreground">Odaberi server da vidiš postojeće kanale.</p>
            </Card>
          )}
        </div>
      </div>

      {/* ── Postavke Kanala (Channel key bindings) ── */}
      {selectedGuildId && channelKeysQuery.data && settingsQuery.data && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1">
              <Settings className="w-4 h-4" /> Postavke Kanala
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">Odaberi koji Discord kanal se koristi za svaku funkciju bota.</p>
            <div className="space-y-2">
              {channelKeysQuery.data.map(ck => {
                const assignment = settingsQuery.data!.assignments[ck.key];
                const textChannels = settingsQuery.data!.channels.filter(c => [0, 5, 15].includes(c.type));
                return (
                  <div key={ck.key} className="flex items-center gap-3 bg-muted/30 rounded-lg p-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium">{ck.label}</div>
                      <div className="text-[10px] text-muted-foreground truncate">{ck.desc}</div>
                    </div>
                    <Select
                      value={assignment?.channelId || '__none__'}
                      onValueChange={(val) => {
                        updateSettingMutation.mutate({ key: ck.key, channelId: val === '__none__' ? null : val });
                      }}
                    >
                      <SelectTrigger className="w-[200px] h-8 text-xs">
                        <SelectValue placeholder="Nije postavljeno" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">
                          <span className="text-muted-foreground">— Nije postavljeno —</span>
                        </SelectItem>
                        {textChannels.map(ch => (
                          <SelectItem key={ch.id} value={ch.id}>
                            <span className="text-muted-foreground">{ch.parentName ? `${ch.parentName} ›` : ''}</span> #{ch.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
      {selectedGuildId && settingsQuery.isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Učitavanje postavki...
        </div>
      )}

      {/* ── Kreiraj kanal/kategoriju ── */}
      {selectedGuildId && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1">
              <Plus className="w-4 h-4" /> Kreiraj
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCreateCategory(true)}
              >
                <FolderPlus className="w-3.5 h-3.5 mr-1" /> Nova Kategorija
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCreateChannel(true)}
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Novi Kanal
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Embedovi — pregled i uređivanje poruka ── */}
      {selectedGuildId && guildChannelsQuery.data && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1">
              <Eye className="w-4 h-4" /> Embedovi
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 mb-3">
              <Select value={embedChannelId || '__none__'} onValueChange={(v) => setEmbedChannelId(v === '__none__' ? null : v)}>
                <SelectTrigger className="h-8 w-64 text-xs">
                  <SelectValue placeholder="Odaberi kanal..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">
                    <span className="text-muted-foreground">— Odaberi kanal —</span>
                  </SelectItem>
                  {guildChannelsQuery.data.filter(c => [0, 5, 15].includes(c.type)).map(ch => (
                    <SelectItem key={ch.id} value={ch.id}>#{ch.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {embedsQuery.isFetching && <Loader2 className="w-3 h-3 animate-spin" />}
            </div>

            {embedChannelId && embedsQuery.data && (
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {embedsQuery.data.length === 0 && (
                  <p className="text-xs text-muted-foreground">Nema poruka s embedovima u ovom kanalu.</p>
                )}
                {embedsQuery.data.map(msg => (
                  <div key={msg.id} className="border rounded-lg p-3 space-y-2">
                    {msg.embeds.map((emb, i) => (
                      <div key={i} className="bg-muted/30 rounded p-2 text-xs space-y-1" style={{ borderLeft: `3px solid ${emb.color ? `#${emb.color.toString(16).padStart(6, '0')}` : '#5865F2'}` }}>
                        {emb.title && <div className="font-semibold">{emb.title}</div>}
                        {emb.description && <div className="text-muted-foreground whitespace-pre-wrap">{emb.description.slice(0, 200)}{emb.description.length > 200 ? '...' : ''}</div>}
                        {emb.footer?.text && <div className="text-[10px] text-muted-foreground/60">{emb.footer.text}</div>}
                      </div>
                    ))}
                    {msg.components.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {msg.components.flatMap(row => row.components).map((btn, i) => (
                          <Badge key={i} variant="outline" className="text-[10px]">
                            {btn.emoji?.name && <span className="mr-0.5">{btn.emoji.name}</span>}
                            {btn.label || 'Button'}
                            {btn.url && <span className="text-muted-foreground ml-1">↗</span>}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px]"
                      onClick={() => setEditingEmbed({ messageId: msg.id, embeds: JSON.parse(JSON.stringify(msg.embeds)), components: JSON.parse(JSON.stringify(msg.components)) })}
                    >
                      <Pencil className="w-3 h-3 mr-1" /> Uredi
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Embed Editor Dialog ── */}
      <Dialog open={!!editingEmbed} onOpenChange={(open) => { if (!open) setEditingEmbed(null); }}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm">Uredi Embed</DialogTitle>
          </DialogHeader>
          {editingEmbed && (
            <div className="space-y-4">
              {editingEmbed.embeds.map((emb, i) => (
                <div key={i} className="space-y-2 border rounded p-3">
                  <div className="text-xs font-semibold">Embed {i + 1}</div>
                  <div>
                    <label className="text-xs text-muted-foreground">Naslov</label>
                    <Input
                      className="h-8 text-xs"
                      value={emb.title || ''}
                      onChange={(e) => {
                        const next = { ...editingEmbed };
                        next.embeds = [...next.embeds];
                        next.embeds[i] = { ...next.embeds[i], title: e.target.value };
                        setEditingEmbed(next);
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Opis</label>
                    <Textarea
                      className="text-xs min-h-[80px]"
                      value={emb.description || ''}
                      onChange={(e) => {
                        const next = { ...editingEmbed };
                        next.embeds = [...next.embeds];
                        next.embeds[i] = { ...next.embeds[i], description: e.target.value };
                        setEditingEmbed(next);
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">URL</label>
                    <Input
                      className="h-8 text-xs"
                      value={emb.url || ''}
                      onChange={(e) => {
                        const next = { ...editingEmbed };
                        next.embeds = [...next.embeds];
                        next.embeds[i] = { ...next.embeds[i], url: e.target.value };
                        setEditingEmbed(next);
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Boja</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        className="w-10 h-8 rounded cursor-pointer border border-border bg-transparent p-0"
                        value={emb.color ? `#${emb.color.toString(16).padStart(6, '0')}` : '#000000'}
                        onChange={(e) => {
                          const next = { ...editingEmbed };
                          next.embeds = [...next.embeds];
                          const hex = e.target.value.replace('#', '');
                          next.embeds[i] = { ...next.embeds[i], color: parseInt(hex, 16) || 0 };
                          setEditingEmbed(next);
                        }}
                      />
                      <span className="text-xs text-muted-foreground">{emb.color ? `#${emb.color.toString(16).padStart(6, '0').toUpperCase()}` : 'Nema'}</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Footer <span className="text-muted-foreground/60">(mali tekst na dnu embeda)</span></label>
                    <Input
                      className="h-8 text-xs"
                      value={emb.footer?.text || ''}
                      onChange={(e) => {
                        const next = { ...editingEmbed };
                        next.embeds = [...next.embeds];
                        next.embeds[i] = { ...next.embeds[i], footer: { text: e.target.value } };
                        setEditingEmbed(next);
                      }}
                    />
                  </div>
                </div>
              ))}

              {/* Button URL editor */}
              {editingEmbed.components.length > 0 && (
                <div className="space-y-2 border rounded p-3">
                  <div className="text-xs font-semibold">Gumbi / Linkovi</div>
                  {editingEmbed.components.flatMap((row, ri) => row.components.map((btn: any, bi: number) => (
                    <div key={`${ri}-${bi}`} className="flex gap-2 items-center">
                      <Input
                        className="h-8 text-xs flex-1"
                        placeholder="Label"
                        value={btn.label || ''}
                        onChange={(e) => {
                          const next = { ...editingEmbed, components: editingEmbed.components.map((r: any, rIdx: number) => rIdx === ri ? { ...r, components: r.components.map((b: any, bIdx: number) => bIdx === bi ? { ...b, label: e.target.value } : b) } : r) };
                          setEditingEmbed(next);
                        }}
                      />
                      {btn.url !== undefined && (
                        <Input
                          className="h-8 text-xs flex-1"
                          placeholder="URL"
                          value={btn.url || ''}
                          onChange={(e) => {
                            const next = { ...editingEmbed, components: editingEmbed.components.map((r: any, rIdx: number) => rIdx === ri ? { ...r, components: r.components.map((b: any, bIdx: number) => bIdx === bi ? { ...b, url: e.target.value } : b) } : r) };
                            setEditingEmbed(next);
                          }}
                        />
                      )}
                    </div>
                  )))}
                </div>
              )}

              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => setEditingEmbed(null)}>Odustani</Button>
                <Button size="sm" disabled={editEmbedMutation.isPending} onClick={() => {
                  if (!embedChannelId) return;
                  editEmbedMutation.mutate(
                    { channelId: embedChannelId, messageId: editingEmbed.messageId, embeds: editingEmbed.embeds, components: editingEmbed.components },
                    { onSuccess: () => setEditingEmbed(null) }
                  );
                }}>
                  {editEmbedMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
                  Spremi
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Category Editor Dialog */}
      <CategoryEditorDialog
        open={editCategoryDialog.open}
        onClose={() => setEditCategoryDialog({ open: false, index: null })}
        category={editCategoryDialog.index !== null ? config.categories[editCategoryDialog.index]?.name : null}
        onSave={(name) => {
          if (editCategoryDialog.index !== null) {
            editCategory(editCategoryDialog.index, name);
          } else {
            addCategory(name);
          }
          setEditCategoryDialog({ open: false, index: null });
        }}
      />

      {/* Channel Editor Dialog */}
      <ChannelEditorDialog
        open={editChannelDialog.open}
        onClose={() => setEditChannelDialog({ open: false, catIndex: -1, chIndex: null })}
        channel={editChannelDialog.chIndex !== null ? config.categories[editChannelDialog.catIndex]?.channels[editChannelDialog.chIndex] : null}
        onSave={(ch) => {
          if (editChannelDialog.chIndex !== null) {
            editChannel(editChannelDialog.catIndex, editChannelDialog.chIndex, ch);
          } else {
            addChannel(editChannelDialog.catIndex, ch);
          }
          setEditChannelDialog({ open: false, catIndex: -1, chIndex: null });
        }}
        copySourceChannels={guildChannelsQuery.data || []}
      />

      {/* Edit existing Discord channel dialog */}
      <ExistingChannelEditorDialog
        open={editExistingDialog.open}
        onClose={() => setEditExistingDialog({ open: false, channel: null })}
        channel={editExistingDialog.channel}
        guildId={selectedGuildId || ''}
        categories={guildChannelsQuery.data?.filter(c => c.type === 4) || []}
        allChannels={guildChannelsQuery.data || []}
        onSave={(channelId, updates) => {
          if (!selectedGuildId) return;
          editExistingMutation.mutate({ guildId: selectedGuildId, channelId, updates });
        }}
        onDelete={(channelId) => {
          if (!selectedGuildId) return;
          if (!confirm('Jesi li siguran da želiš OBRISATI ovaj kanal s Discorda? Ovo se ne može poništiti!')) return;
          deleteExistingMutation.mutate({ guildId: selectedGuildId, channelId });
        }}
        isSaving={editExistingMutation.isPending}
      />

      {/* Create new channel dialog */}
      <CreateChannelDialog
        open={showCreateChannel}
        onClose={() => setShowCreateChannel(false)}
        guildId={selectedGuildId || ''}
        categories={guildChannelsQuery.data?.filter(c => c.type === 4) || []}
        allChannels={guildChannelsQuery.data || []}
        onCreate={(data) => {
          if (!selectedGuildId) return;
          createChannelMutation.mutate({ guildId: selectedGuildId, ...data });
        }}
        isCreating={createChannelMutation.isPending}
      />

      {/* Create new category dialog */}
      <CreateCategoryDialog
        open={showCreateCategory}
        onClose={() => setShowCreateCategory(false)}
        onCreate={(name) => {
          if (!selectedGuildId) return;
          createCategoryMutation.mutate({ guildId: selectedGuildId, categoryName: name });
        }}
        isCreating={createCategoryMutation.isPending}
      />
    </div>
  );
}
