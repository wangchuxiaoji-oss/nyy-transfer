import {
  Archive,
  Captions,
  ChevronRight,
  Code2,
  FileQuestion,
  FileSpreadsheet,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Music,
  Package,
  Presentation,
  type LucideIcon,
} from "lucide-react";

type Tone = "video" | "audio" | "image" | "pdf" | "document" | "sheet" | "deck" | "code" | "archive" | "installer" | "subtitle" | "unknown";

interface FormatItem {
  ext: string;
  label?: string;
  note?: string;
}

interface FormatGroup {
  title: string;
  summary: string;
  tone: Tone;
  icon: LucideIcon;
  items: FormatItem[];
}

const mineralTones: Record<Tone, { badge: string; glow: string; chip: string; icon: LucideIcon }> = {
  video: { badge: "from-[#49323a] via-[#8a4d4f] to-[#c97755]", glow: "shadow-[0_0_18px_rgba(201,119,85,0.12)]", chip: "border-[#c97755]/28 bg-[#c97755]/12 text-[#f2d3c6]", icon: Film },
  audio: { badge: "from-[#27423f] via-[#3f766d] to-[#72a997]", glow: "shadow-[0_0_18px_rgba(114,169,151,0.10)]", chip: "border-[#72a997]/28 bg-[#72a997]/12 text-[#d8f0ea]", icon: Music },
  image: { badge: "from-[#2e4052] via-[#546f8b] to-[#8e87b6]", glow: "shadow-[0_0_18px_rgba(142,172,208,0.10)]", chip: "border-[#8eacd0]/26 bg-[#8eacd0]/12 text-[#e1edfb]", icon: ImageIcon },
  pdf: { badge: "from-[#4e2c32] via-[#94515a] to-[#d48772]", glow: "shadow-[0_0_18px_rgba(212,135,114,0.11)]", chip: "border-[#d48772]/28 bg-[#d48772]/12 text-[#f5dcd5]", icon: FileText },
  document: { badge: "from-[#293a55] via-[#4e678d] to-[#7f9fc4]", glow: "shadow-[0_0_18px_rgba(127,159,196,0.10)]", chip: "border-[#7f9fc4]/26 bg-[#7f9fc4]/12 text-[#e3edf8]", icon: FileText },
  sheet: { badge: "from-[#2d4534] via-[#54785b] to-[#93ad7d]", glow: "shadow-[0_0_18px_rgba(147,173,125,0.10)]", chip: "border-[#93ad7d]/26 bg-[#93ad7d]/12 text-[#edf5e5]", icon: FileSpreadsheet },
  deck: { badge: "from-[#56382f] via-[#97634f] to-[#d7a06d]", glow: "shadow-[0_0_18px_rgba(215,160,109,0.10)]", chip: "border-[#d7a06d]/26 bg-[#d7a06d]/12 text-[#f7e3cd]", icon: Presentation },
  code: { badge: "from-[#32354f] via-[#5a5f89] to-[#8e92bd]", glow: "shadow-[0_0_18px_rgba(142,146,189,0.10)]", chip: "border-[#8e92bd]/26 bg-[#8e92bd]/12 text-[#ebeaff]", icon: Code2 },
  archive: { badge: "from-[#54452c] via-[#92764a] to-[#d6b06f]", glow: "shadow-[0_0_18px_rgba(214,176,111,0.10)]", chip: "border-[#d6b06f]/26 bg-[#d6b06f]/12 text-[#f7ebd4]", icon: Archive },
  installer: { badge: "from-[#354532] via-[#687d58] to-[#a7b878]", glow: "shadow-[0_0_18px_rgba(167,184,120,0.09)]", chip: "border-[#a7b878]/24 bg-[#a7b878]/12 text-[#f0f6df]", icon: Package },
  subtitle: { badge: "from-[#3e3654] via-[#6d5d8e] to-[#a991c0]", glow: "shadow-[0_0_18px_rgba(169,145,192,0.10)]", chip: "border-[#a991c0]/26 bg-[#a991c0]/12 text-[#f0e8f8]", icon: Captions },
  unknown: { badge: "from-[#343940] via-[#525a63] to-[#7c858e]", glow: "shadow-[0_0_18px_rgba(255,255,255,0.06)]", chip: "border-white/15 bg-white/[0.08] text-white/70", icon: FileQuestion },
};

const groups: FormatGroup[] = [
  { title: "视频", summary: "常规视频、Remux、字幕音轨文件。", tone: "video", icon: Film, items: [{ ext: "mp4" }, { ext: "mkv", note: "Remux 常见" }, { ext: "mov" }, { ext: "webm" }, { ext: "avi" }, { ext: "wmv" }, { ext: "m4v" }] },
  { title: "音频", summary: "音频格式统一音符语义。", tone: "audio", icon: Music, items: [{ ext: "mp3" }, { ext: "flac", note: "无损常见" }, { ext: "wav" }, { ext: "aac" }, { ext: "m4a" }, { ext: "ogg" }] },
  { title: "图片", summary: "图片类统一低饱和蓝紫。", tone: "image", icon: ImageIcon, items: [{ ext: "jpg" }, { ext: "jpeg" }, { ext: "png" }, { ext: "webp" }, { ext: "gif" }, { ext: "svg" }, { ext: "avif" }, { ext: "bmp" }] },
  { title: "PDF", summary: "PDF 单独暖红棕识别。", tone: "pdf", icon: FileText, items: [{ ext: "pdf", label: "PDF" }] },
  { title: "文档", summary: "DOC、ODT、RTF 文档语义。", tone: "document", icon: FileText, items: [{ ext: "doc" }, { ext: "docx" }, { ext: "odt" }, { ext: "rtf" }] },
  { title: "表格", summary: "表格和 CSV 统一网格语义。", tone: "sheet", icon: FileSpreadsheet, items: [{ ext: "xls" }, { ext: "xlsx" }, { ext: "csv" }, { ext: "ods" }] },
  { title: "演示", summary: "PPT、PPTX、KEY 演示语义。", tone: "deck", icon: Presentation, items: [{ ext: "ppt" }, { ext: "pptx" }, { ext: "key" }] },
  { title: "文本 / 代码", summary: "文本、配置、轻量代码文件。", tone: "code", icon: Code2, items: [{ ext: "txt", label: "TXT" }, { ext: "md", label: "MD" }, { ext: "json", label: "{}" }, { ext: "xml", label: "<>" }, { ext: "yml", label: "YML" }, { ext: "yaml", label: "YAML" }, { ext: "log", label: "LOG" }, { ext: "ini", label: "INI" }] },
  { title: "压缩包", summary: "归档文件统一矿物金色。", tone: "archive", icon: Archive, items: [{ ext: "zip" }, { ext: "rar" }, { ext: "7z" }, { ext: "tar" }, { ext: "gz" }, { ext: "bz2" }, { ext: "xz" }] },
  { title: "安装 / 镜像", summary: "安装包和镜像强调包体。", tone: "installer", icon: Package, items: [{ ext: "exe" }, { ext: "msi" }, { ext: "apk" }, { ext: "dmg" }, { ext: "pkg" }, { ext: "iso", label: "ISO" }] },
  { title: "字幕", summary: "字幕独立紫灰识别。", tone: "subtitle", icon: Captions, items: [{ ext: "srt" }, { ext: "ass" }, { ext: "ssa" }, { ext: "vtt" }] },
  { title: "未知 / 二进制", summary: "未知类型中性兜底。", tone: "unknown", icon: FileQuestion, items: [{ ext: "dll" }, { ext: "bin" }, { ext: "dat" }, { ext: "unknown", label: "…" }] },
];

function shortLabel(item: FormatItem): string {
  if (item.label) return item.label;
  return item.ext.length > 4 ? item.ext.slice(0, 4).toUpperCase() : item.ext.toUpperCase();
}

function FileIcon({ item, group, compact = false }: { item: FormatItem; group: FormatGroup; compact?: boolean }) {
  const tone = mineralTones[group.tone];
  const Icon = tone.icon;
  const size = compact ? "h-10 w-10" : "h-12 w-12";
  const iconClass = compact ? "top-1.5 h-4 w-4" : "top-2 h-5 w-5";
  const labelClass = compact ? "inset-x-1 bottom-1 text-[7px] leading-[10px]" : "inset-x-1.5 bottom-1.5 text-[8px] leading-3";

  return (
    <div className={`relative ${size} shrink-0 overflow-hidden rounded-lg bg-gradient-to-br ${tone.badge} ${tone.glow}`}>
      <div className="absolute inset-px rounded-[0.45rem] bg-black/10" />
      <Icon className={`absolute left-1/2 ${iconClass} -translate-x-1/2 text-white/92`} />
      <span className={`absolute ${labelClass} rounded bg-black/38 px-0.5 text-center font-tech font-black text-white/92 backdrop-blur-sm`}>
        {shortLabel(item)}
      </span>
    </div>
  );
}

function FileBadge({ item, group, compact = false }: { item: FormatItem; group: FormatGroup; compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-white/[0.09] bg-white/[0.045] p-3">
      <FileIcon item={item} group={group} compact={compact} />
      <div className="min-w-0">
        <p className="truncate font-tech text-sm font-black text-white">.{item.ext}</p>
        <p className="mt-0.5 truncate text-[11px] text-white/45">{item.note || group.title}</p>
      </div>
    </div>
  );
}

function FolderBadgePreview({ open }: { open: boolean }) {
  const Icon = open ? FolderOpen : Folder;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/[0.09] bg-white/[0.045] p-3">
      <ChevronRight className={`h-4 w-4 text-[#d6b06f] ${open ? "rotate-90" : ""}`} />
      <div className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-gradient-to-br from-[#54452c] via-[#92764a] to-[#d6b06f] shadow-[0_0_18px_rgba(214,176,111,0.10)]">
        <div className="absolute inset-px rounded-[0.45rem] bg-black/10" />
        <Icon className="relative h-5 w-5 text-white/92" />
      </div>
      <div className="min-w-0">
        <p className="font-tech text-sm font-black text-white">{open ? "展开文件夹" : "特殊命名"}</p>
        <p className="mt-0.5 text-[11px] text-white/45">{open ? "1 个文件 · 1 个文件夹" : "7 个文件 · 9 个文件夹"}</p>
      </div>
    </div>
  );
}

function GroupCard({ group }: { group: FormatGroup }) {
  const Icon = group.icon;
  const tone = mineralTones[group.tone];

  return (
    <article className="rounded-[1.75rem] border border-white/[0.10] bg-[linear-gradient(180deg,rgba(255,255,255,0.075),rgba(255,255,255,0.035))] p-5 shadow-[0_22px_80px_rgba(0,0,0,0.28)] backdrop-blur-2xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 font-tech text-[10px] font-black uppercase tracking-[0.18em] ${tone.chip}`}>
            <Icon className="h-3.5 w-3.5" /> {group.title}
          </div>
          <h2 className="mt-3 text-2xl font-black tracking-tight text-white">{group.title}</h2>
          <p className="mt-2 text-sm leading-6 text-white/54">{group.summary}</p>
        </div>
        <FileIcon item={group.items[0]} group={group} />
      </div>
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        {group.items.map((item) => <FileBadge key={item.ext} item={item} group={group} compact />)}
      </div>
    </article>
  );
}

export default function FileIconPreviewPage() {
  const totalFormats = groups.reduce((sum, group) => sum + group.items.length, 0);
  const sampleGroups = [groups[0], groups[1], groups[3], groups[5], groups[8], groups[10], groups[11]];
  const samples = sampleGroups.map((group) => ({ group, item: group.items[0] }));

  return (
    <main className="min-h-dvh overflow-hidden bg-[#0a0418] px-4 py-10 text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_10%_10%,rgba(255,138,61,0.20),transparent_32%),radial-gradient(circle_at_85%_15%,rgba(0,212,255,0.10),transparent_30%),radial-gradient(circle_at_72%_82%,rgba(255,51,102,0.10),transparent_34%)]" />
      <div className="pointer-events-none fixed inset-0 opacity-[0.08] [background-image:linear-gradient(rgba(255,255,255,.5)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.5)_1px,transparent_1px)] [background-size:44px_44px]" />
      <section className="relative mx-auto max-w-7xl">
        <div className="rounded-[2rem] border border-white/[0.12] bg-white/[0.055] p-5 shadow-[0_30px_120px_rgba(0,0,0,0.40)] backdrop-blur-2xl sm:p-8">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-end">
            <div>
              <p className="font-tech text-xs font-black uppercase tracking-[0.28em] text-yc-accent">NYY File Icon Lab</p>
              <h1 className="mt-3 max-w-3xl text-4xl font-black tracking-tight sm:text-6xl">最终文件图标方案</h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-white/58">
                已保留 V1 类型图标和底部格式标签，改为小圆角近正方形徽章，并落地矿物低饱和配色。当前覆盖 {totalFormats} 个格式。
              </p>
            </div>
            <div className="rounded-[1.5rem] border border-white/[0.10] bg-black/20 p-4">
              <p className="font-tech text-[10px] font-black uppercase tracking-[0.22em] text-white/45">36px 文件列表模拟</p>
              <div className="mt-4 grid gap-2">
                {samples.slice(0, 5).map(({ group, item }) => <FileBadge key={`${group.title}-${item.ext}`} item={item} group={group} compact />)}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 rounded-[1.75rem] border border-white/[0.10] bg-white/[0.045] p-5 backdrop-blur-2xl">
          <p className="font-tech text-[10px] font-black uppercase tracking-[0.22em] text-yc-accent">Folder Final Style</p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-white">文件夹最终样式</h2>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-white/54">
            已采用方向 A：文件夹也使用同尺寸小圆角近正方形矿物徽章，和文件图标的尺寸、圆角、材质统一；文件夹不放格式标签。
          </p>
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <FolderBadgePreview open={false} />
            <FolderBadgePreview open />
          </div>
        </div>

        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          {groups.map((group) => <GroupCard key={group.title} group={group} />)}
        </div>
      </section>
    </main>
  );
}
