"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Archive, ArrowLeft, Download, FileText, Forward, Inbox, Mail, MailOpen, Paperclip,
  RefreshCw, Reply, Search, Send, ShieldAlert, Star, Trash2, X,
} from "lucide-react";
import { useToast } from "@/components/toast-provider";
import {
  downloadAdminMailboxAttachment,
  forwardAdminMailboxMessage,
  getAdminMailboxMessage,
  getAdminMailboxMessages,
  replyAdminMailboxMessage,
  updateAdminMailboxMessage,
  type AdminMailboxFolder,
  type AdminMailboxMessage,
  type AdminMailboxThread,
} from "@/lib/admin";

const FOLDERS: Array<{ id: AdminMailboxFolder; label: string; Icon: typeof Inbox }> = [
  { id: "inbox", label: "收件箱", Icon: Inbox },
  { id: "starred", label: "已星标", Icon: Star },
  { id: "sent", label: "已发送", Icon: Send },
  { id: "archive", label: "归档", Icon: Archive },
  { id: "spam", label: "垃圾邮件", Icon: ShieldAlert },
  { id: "trash", label: "垃圾箱", Icon: Trash2 },
];

function displayAddress(message: AdminMailboxMessage): string {
  return message.from.name?.trim() || message.from.email;
}

function formatMailboxDate(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function normalizeThread(response: AdminMailboxThread, fallback: AdminMailboxMessage): AdminMailboxMessage[] {
  const messages = response.thread || response.messages || (response.message ? [response.message] : []);
  return messages.length > 0 ? messages : [fallback];
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

interface AdminMailboxProps {
  onError: (error: unknown) => string;
  refreshToken?: number;
}

export function AdminMailbox({ onError, refreshToken = 0 }: AdminMailboxProps) {
  const { showToast } = useToast();
  const [folder, setFolder] = useState<AdminMailboxFolder>("inbox");
  const [messages, setMessages] = useState<AdminMailboxMessage[]>([]);
  const [folderCounts, setFolderCounts] = useState<Partial<Record<AdminMailboxFolder, number>>>({});
  const [selected, setSelected] = useState<AdminMailboxMessage | null>(null);
  const [thread, setThread] = useState<AdminMailboxMessage[]>([]);
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [composer, setComposer] = useState<"reply" | "forward" | null>(null);
  const [composerBody, setComposerBody] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  const [sending, setSending] = useState(false);
  const listAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const detailRequestSerialRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pageRef = useRef(1);
  const mobileDialogRef = useRef<HTMLDivElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);

  const loadMessages = useCallback(async (showLoading = true, nextPage = 1, append = false, refreshLoaded = false) => {
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    if (showLoading) setLoading(true);
    if (append) setLoadingMore(true);
    setError("");
    try {
      const requestedPages = refreshLoaded
        ? Array.from({ length: Math.max(1, pageRef.current) }, (_, index) => index + 1)
        : [nextPage];
      const responses = [];
      for (const requestedPage of requestedPages) {
        responses.push(await getAdminMailboxMessages({ folder, q: query || undefined, page: requestedPage, pageSize: 50, signal: controller.signal }));
      }
      if (controller.signal.aborted || !mountedRef.current) return;
      const response = responses.at(-1)!;
      const seenMessageIds = new Set<string>();
      const nextMessages = responses
        .flatMap((item) => item.items || item.messages || [])
        .filter((item) => {
          if (seenMessageIds.has(item.id)) return false;
          seenMessageIds.add(item.id);
          return true;
        });
      setMessages((current) => append
        ? [...current, ...nextMessages.filter((item) => !current.some((existing) => existing.id === item.id))]
        : nextMessages);
      setTotal(response.total || 0);
      const resolvedPage = refreshLoaded ? requestedPages.length : response.page || nextPage;
      pageRef.current = resolvedPage;
      setPage(resolvedPage);
      setFolderCounts(response.folders || {});
    } catch (loadError) {
      if (isAbortError(loadError) || !mountedRef.current) return;
      setError(onError(loadError));
    } finally {
      if (listAbortRef.current === controller) {
        listAbortRef.current = null;
        if (mountedRef.current) setLoading(false);
        if (mountedRef.current) setLoadingMore(false);
      }
    }
  }, [folder, onError, query]);

  useEffect(() => {
    pageRef.current = 1;
    setPage(1);
    void loadMessages();
    return () => listAbortRef.current?.abort();
  }, [loadMessages]);

  useEffect(() => {
    const timer = window.setInterval(() => { void loadMessages(false, 1, false, true); }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadMessages]);

  useEffect(() => {
    if (refreshToken > 0) void loadMessages(true, 1, false, true);
  }, [loadMessages, refreshToken]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      detailRequestSerialRef.current += 1;
      detailAbortRef.current?.abort();
    };
  }, []);

  const cancelDetailRequest = useCallback(() => {
    detailRequestSerialRef.current += 1;
    detailAbortRef.current?.abort();
    detailAbortRef.current = null;
    setDetailLoading(false);
  }, []);

  const loadThread = useCallback(async (message: AdminMailboxMessage) => {
    if (!mountedRef.current) return;
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    const serial = ++detailRequestSerialRef.current;
    detailAbortRef.current = controller;
    setDetailLoading(true);
    try {
      const response = await getAdminMailboxMessage(message.id, { signal: controller.signal });
      if (controller.signal.aborted || !mountedRef.current || serial !== detailRequestSerialRef.current || selectedIdRef.current !== message.id) return;
      setThread(normalizeThread(response, { ...message, is_read: true }));
    } catch (detailError) {
      if (!isAbortError(detailError) && mountedRef.current && serial === detailRequestSerialRef.current && selectedIdRef.current === message.id) {
        showToast({ title: onError(detailError), type: "error" });
      }
    } finally {
      if (serial === detailRequestSerialRef.current) {
        detailAbortRef.current = null;
        if (mountedRef.current) setDetailLoading(false);
      }
    }
  }, [onError, showToast]);

  const openMessage = (message: AdminMailboxMessage) => {
    selectedIdRef.current = message.id;
    setSelected(message);
    setThread([message]);
    setComposer(null);
    if (!message.is_read) {
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, is_read: true } : item));
      void updateAdminMailboxMessage(message.id, { is_read: true }).catch((updateError) => showToast({ title: onError(updateError), type: "error" }));
    }
    void loadThread(message);
  };

  const patchMessage = async (message: AdminMailboxMessage, patch: { is_read?: boolean; is_starred?: boolean; folder?: AdminMailboxFolder }, successMessage: string) => {
    const optimistic = { ...message, ...patch };
    setMessages((current) => current.map((item) => item.id === message.id ? optimistic : item));
    if (selected?.id === message.id) setSelected(optimistic);
    try {
      await updateAdminMailboxMessage(message.id, patch);
      showToast({ title: successMessage, type: "success" });
      if (patch.folder && patch.folder !== folder) {
        setMessages((current) => current.filter((item) => item.id !== message.id));
        selectedIdRef.current = null;
        cancelDetailRequest();
        setSelected(null);
        setThread([]);
      }
    } catch (patchError) {
      showToast({ title: onError(patchError), type: "error" });
      void loadMessages();
    }
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setQuery(searchDraft.trim());
    selectedIdRef.current = null;
    cancelDetailRequest();
    setSelected(null);
    setThread([]);
  };

  const submitComposer = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !composerBody.trim()) return;
    const recipients = forwardTo.split(/[;,\s]+/).map((value) => value.trim()).filter(Boolean);
    if (composer === "forward" && recipients.length === 0) {
      showToast({ title: "请填写转发收件人", type: "warning" });
      return;
    }
    setSending(true);
    try {
      if (composer === "forward") await forwardAdminMailboxMessage(selected.id, { to: recipients, body_text: composerBody.trim() });
      else await replyAdminMailboxMessage(selected.id, { body_text: composerBody.trim() });
      showToast({ title: composer === "forward" ? "邮件已转发" : "回复已发送", type: "success" });
      setComposer(null);
      setComposerBody("");
      setForwardTo("");
      if (selectedIdRef.current === selected.id) await loadThread(selected);
    } catch (sendError) {
      showToast({ title: onError(sendError), type: "error" });
    } finally {
      setSending(false);
    }
  };

  const selectFolder = (nextFolder: AdminMailboxFolder) => {
    setFolder(nextFolder);
    selectedIdRef.current = null;
    cancelDetailRequest();
    setSelected(null);
    setThread([]);
    setComposer(null);
  };

  const closeMessage = useCallback(() => {
    selectedIdRef.current = null;
    cancelDetailRequest();
    setSelected(null);
    setThread([]);
    setComposer(null);
  }, [cancelDetailRequest]);

  useEffect(() => {
    if (!selected || !window.matchMedia("(max-width: 1023px)").matches) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => mobileCloseRef.current?.focus());
    const handleDialogKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMessage();
        return;
      }
      if (event.key !== "Tab" || !mobileDialogRef.current) return;
      const focusable = Array.from(mobileDialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleDialogKey);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleDialogKey);
      previousFocus?.focus();
    };
  }, [closeMessage, selected]);

  return (
    <section data-testid="admin-mailbox" className="retro-panel overflow-hidden">
      <div className="grid min-h-[680px] lg:grid-cols-[190px_330px_minmax(0,1fr)] xl:grid-cols-[210px_370px_minmax(0,1fr)]">
        <aside className="hidden border-r border-black/8 p-3 dark:border-white/10 lg:block">
          <p className="px-3 py-2 retro-kicker">邮箱文件夹</p>
          <nav className="mt-2 grid gap-1" aria-label="邮箱文件夹">
            {FOLDERS.map(({ id, label, Icon }) => (
              <button key={id} type="button" onClick={() => selectFolder(id)} aria-current={folder === id ? "page" : undefined} className={`flex min-h-[44px] items-center gap-3 rounded-xl px-3 text-left type-body-sm font-semibold transition ${folder === id ? "bg-orange-500 text-white shadow-[0_8px_24px_rgba(255,138,61,0.22)]" : "retro-text hover:bg-orange-500/10 hover:text-orange-600"}`}>
                <Icon className="h-4 w-4" /><span className="flex-1">{label}</span>{folderCounts[id] !== undefined && <span className="type-caption opacity-70">{folderCounts[id]}</span>}
              </button>
            ))}
          </nav>
          <div className="mx-3 mt-6 border-t border-black/8 pt-4 type-caption leading-5 retro-muted dark:border-white/10">邮件内容按纯文本显示，避免后台直接执行外部 HTML。</div>
        </aside>

        <div className="min-w-0 border-r border-black/8 dark:border-white/10">
          <div className="border-b border-black/8 p-3 dark:border-white/10">
            <div className="flex items-center gap-2 lg:hidden">
              <label className="sr-only" htmlFor="mailbox-folder-mobile">邮箱文件夹</label>
              <select id="mailbox-folder-mobile" value={folder} onChange={(event) => selectFolder(event.target.value as AdminMailboxFolder)} className="retro-input type-body-sm min-w-0 flex-1 px-3">{FOLDERS.map((item) => <option key={item.id} value={item.id}>{item.label}{folderCounts[item.id] !== undefined ? ` (${folderCounts[item.id]})` : ""}</option>)}</select>
              <button type="button" onClick={() => void loadMessages(true, 1, false, true)} className="retro-icon-button" aria-label="刷新邮件"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></button>
            </div>
            <form onSubmit={submitSearch} className="relative mt-2 lg:mt-0">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 retro-muted" />
              <input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="搜索发件人、主题或正文" aria-label="搜索邮件" className="retro-input type-body-sm w-full pl-9 pr-12" />
              <button type="submit" className="absolute right-1 top-1/2 min-h-[38px] -translate-y-1/2 rounded-lg px-3 type-caption font-semibold text-orange-600 hover:bg-orange-500/10">搜索</button>
            </form>
          </div>

          <div className="max-h-[calc(100dvh-18rem)] min-h-[520px] overflow-y-auto lg:max-h-[680px]">
            {loading ? <div className="flex min-h-72 items-center justify-center type-body-sm retro-muted"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />加载邮件...</div>
              : error ? <div role="alert" className="m-4 rounded-2xl border border-red-400/25 bg-red-500/10 p-4 type-body-sm text-red-700 dark:text-red-200"><p>{error}</p><button type="button" onClick={() => void loadMessages()} className="retro-btn-secondary mt-3">重试</button></div>
              : messages.length === 0 ? <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center"><Mail className="h-9 w-9 retro-muted" /><p className="mt-4 type-body-sm font-semibold retro-text">这个文件夹是空的</p><p className="mt-1 type-caption retro-muted">没有匹配当前搜索条件的邮件。</p></div>
              : <>
                  {messages.map((message) => (
                    <button key={message.id} type="button" onClick={() => void openMessage(message)} className={`relative block w-full border-b border-black/8 px-4 py-4 text-left transition dark:border-white/10 ${selected?.id === message.id ? "bg-orange-500/12" : "hover:bg-orange-500/7"}`} aria-label={`打开邮件 ${message.subject}`}>
                      {!message.is_read && <span className="absolute left-1.5 top-5 h-2 w-2 rounded-full bg-orange-500" />}
                      <div className="flex items-start justify-between gap-3"><span className={`truncate type-body-sm ${message.is_read ? "retro-text" : "font-bold retro-text"}`}>{displayAddress(message)}</span><span className="shrink-0 type-caption retro-muted">{formatMailboxDate(message.received_at || message.sent_at || "")}</span></div>
                      <div className="mt-1 flex items-center gap-2"><p className={`min-w-0 flex-1 truncate type-body-sm ${message.is_read ? "retro-text" : "font-semibold retro-text"}`}>{message.subject || "（无主题）"}</p>{message.is_starred && <Star className="h-3.5 w-3.5 shrink-0 fill-orange-400 text-orange-500" />}{message.attachment_count > 0 && <Paperclip className="h-3.5 w-3.5 shrink-0 retro-muted" />}</div>
                      <p className="mt-1 line-clamp-2 type-caption leading-5 retro-muted">{message.snippet || "无正文预览"}</p>
                    </button>
                  ))}
                  {messages.length < total && (
                    <button type="button" disabled={loadingMore} onClick={() => void loadMessages(false, page + 1, true)} className="mx-auto my-4 flex min-h-[44px] items-center justify-center rounded-xl px-5 type-body-sm font-semibold text-orange-600 hover:bg-orange-500/10 disabled:opacity-50">
                      {loadingMore ? "加载中…" : `加载更多（${messages.length} / ${total}）`}
                    </button>
                  )}
                </>}
          </div>
        </div>

        <div data-testid="mailbox-desktop-detail" className="hidden min-w-0 lg:block">
          {selected ? <MessageDetail message={selected} thread={thread} loading={detailLoading} composer={composer} composerBody={composerBody} forwardTo={forwardTo} sending={sending} onComposer={setComposer} onBody={setComposerBody} onForwardTo={setForwardTo} onSubmit={submitComposer} onPatch={patchMessage} onDownload={(messageId, attachmentId, fileName) => void downloadAdminMailboxAttachment(messageId, attachmentId, fileName).catch((downloadError) => showToast({ title: onError(downloadError), type: "error" }))} />
            : <div className="flex h-full min-h-[680px] flex-col items-center justify-center p-8 text-center"><MailOpen className="h-12 w-12 retro-muted" /><p className="mt-5 type-section retro-text">选择一封邮件</p><p className="mt-2 max-w-xs type-body-sm retro-muted">查看线程、附件和完整操作。未读邮件会在打开时标记已读。</p></div>}
        </div>
      </div>

      {selected && (
        <div ref={mobileDialogRef} className="fixed inset-0 z-[80] bg-[color:var(--background)] lg:hidden" role="dialog" aria-modal="true" aria-label={selected.subject || "邮件详情"}>
          <div className="nyy-product-shell h-dvh overflow-y-auto">
            <div className="nyy-product-content min-h-full">
              <div className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-black/8 bg-white/85 px-3 py-2 backdrop-blur-xl dark:border-white/10 dark:bg-[#12091a]/90"><button ref={mobileCloseRef} type="button" onClick={closeMessage} className="retro-nav-button"><ArrowLeft className="h-4 w-4" />返回列表</button><button type="button" onClick={closeMessage} className="retro-close-button" aria-label="关闭邮件详情"><X className="h-4 w-4" /></button></div>
              <MessageDetail message={selected} thread={thread} loading={detailLoading} composer={composer} composerBody={composerBody} forwardTo={forwardTo} sending={sending} onComposer={setComposer} onBody={setComposerBody} onForwardTo={setForwardTo} onSubmit={submitComposer} onPatch={patchMessage} onDownload={(messageId, attachmentId, fileName) => void downloadAdminMailboxAttachment(messageId, attachmentId, fileName).catch((downloadError) => showToast({ title: onError(downloadError), type: "error" }))} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

interface MessageDetailProps {
  message: AdminMailboxMessage;
  thread: AdminMailboxMessage[];
  loading: boolean;
  composer: "reply" | "forward" | null;
  composerBody: string;
  forwardTo: string;
  sending: boolean;
  onComposer: (mode: "reply" | "forward" | null) => void;
  onBody: (value: string) => void;
  onForwardTo: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onPatch: (message: AdminMailboxMessage, patch: { is_read?: boolean; is_starred?: boolean; folder?: AdminMailboxFolder }, label: string) => void;
  onDownload: (messageId: string, attachmentId: string, fileName: string) => void;
}

function MessageDetail({ message, thread, loading, composer, composerBody, forwardTo, sending, onComposer, onBody, onForwardTo, onSubmit, onPatch, onDownload }: MessageDetailProps) {
  return (
    <div className="min-w-0 p-4 sm:p-6">
      <div className="flex flex-col gap-4 border-b border-black/8 pb-5 dark:border-white/10 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0"><p className="retro-kicker">邮件线程 · {thread.length || 1} 封</p><h2 className="mt-2 break-words text-2xl font-bold leading-tight retro-text">{message.subject || "（无主题）"}</h2><p className="mt-2 type-caption retro-muted">来自 {displayAddress(message)} &lt;{message.from.email}&gt;</p></div>
        <div className="flex flex-wrap gap-1">
          <button type="button" onClick={() => onPatch(message, { is_read: !message.is_read }, message.is_read ? "已标记未读" : "已标记已读")} className="retro-icon-button" aria-label={message.is_read ? "标记未读" : "标记已读"}>{message.is_read ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}</button>
          <button type="button" onClick={() => onPatch(message, { is_starred: !message.is_starred }, message.is_starred ? "已取消星标" : "已星标")} className="retro-icon-button" aria-label={message.is_starred ? "取消星标" : "星标"}><Star className={`h-4 w-4 ${message.is_starred ? "fill-orange-400 text-orange-500" : ""}`} /></button>
          {message.folder !== "inbox" && message.folder !== "sent" && <button type="button" onClick={() => onPatch(message, { folder: "inbox" }, "邮件已移回收件箱")} className="retro-icon-button" aria-label="移回收件箱"><Inbox className="h-4 w-4" /></button>}
          <button type="button" onClick={() => onPatch(message, { folder: "archive" }, "邮件已归档")} className="retro-icon-button" aria-label="归档"><Archive className="h-4 w-4" /></button>
          <button type="button" onClick={() => onPatch(message, { folder: "spam" }, "已移至垃圾邮件")} className="retro-icon-button" aria-label="标记垃圾邮件"><ShieldAlert className="h-4 w-4" /></button>
          <button type="button" onClick={() => onPatch(message, { folder: "trash" }, "已移至垃圾箱")} className="retro-icon-button retro-icon-button-danger" aria-label="移至垃圾箱"><Trash2 className="h-4 w-4" /></button>
        </div>
      </div>

      {loading ? <div className="flex min-h-64 items-center justify-center type-body-sm retro-muted"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />加载线程...</div> : (
        <div className="mt-5 space-y-4">
          {thread.map((threadMessage) => (
            <article key={threadMessage.id} className="retro-card p-5">
              <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><p className="type-body-sm font-semibold retro-text">{displayAddress(threadMessage)} <span className="font-normal retro-muted">&lt;{threadMessage.from.email}&gt;</span></p><p className="mt-1 type-caption retro-muted">发送给 {(threadMessage.to || []).map((address) => address.name || address.email).join("、") || "admin@nyy.app"}</p></div><time className="shrink-0 type-caption retro-muted">{new Date(threadMessage.received_at || threadMessage.sent_at || "").toLocaleString("zh-CN")}</time></header>
              <div className="mt-5 whitespace-pre-wrap break-words text-sm leading-7 retro-text">{threadMessage.body_text || threadMessage.snippet || "（无纯文本正文）"}</div>
              {(threadMessage.attachments || []).length > 0 && <div className="mt-5 border-t border-black/8 pt-4 dark:border-white/10"><p className="retro-kicker">附件</p><div className="mt-3 grid gap-2 sm:grid-cols-2">{threadMessage.attachments?.map((attachment) => <button key={attachment.id} type="button" onClick={() => onDownload(threadMessage.id, attachment.id, attachment.file_name)} className="retro-card flex items-center gap-3 p-3 text-left"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-orange-500/10 text-orange-500"><FileText className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block truncate type-body-sm font-medium retro-text">{attachment.file_name}</span><span className="type-caption retro-muted">{attachment.size.toLocaleString()} bytes</span></span><Download className="h-4 w-4 shrink-0 retro-muted" /></button>)}</div></div>}
            </article>
          ))}
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2"><button type="button" onClick={() => onComposer(composer === "reply" ? null : "reply")} className="btn-primary"><Reply className="h-4 w-4" />回复</button><button type="button" onClick={() => onComposer(composer === "forward" ? null : "forward")} className="retro-btn-secondary"><Forward className="h-4 w-4" />转发</button></div>
      {composer && <form onSubmit={onSubmit} className="retro-panel-strong mt-4 p-4 sm:p-5"><div className="flex items-center justify-between"><div><p className="retro-kicker">{composer === "forward" ? "Forward" : "Reply"}</p><h3 className="mt-1 type-section retro-text">{composer === "forward" ? "转发这封邮件" : `回复 ${message.from.name || message.from.email}`}</h3></div><button type="button" onClick={() => onComposer(null)} className="retro-close-button" aria-label="关闭编辑器"><X className="h-4 w-4" /></button></div>{composer === "forward" && <label className="mt-4 block"><span className="type-label retro-text">收件人</span><input type="text" value={forwardTo} onChange={(event) => onForwardTo(event.target.value)} placeholder="name@example.com，多个地址用逗号分隔" className="retro-input mt-1.5 w-full type-body-sm" required /></label>}<label className="mt-4 block"><span className="type-label retro-text">正文</span><textarea value={composerBody} onChange={(event) => onBody(event.target.value)} rows={8} className="retro-input mt-1.5 w-full resize-y py-3 type-body-sm" placeholder={composer === "forward" ? "补充转发说明..." : "输入回复内容..."} required /></label><button type="submit" disabled={sending || !composerBody.trim()} className="btn-primary mt-4"><Send className="h-4 w-4" />{sending ? "发送中..." : "发送邮件"}</button></form>}
    </div>
  );
}
