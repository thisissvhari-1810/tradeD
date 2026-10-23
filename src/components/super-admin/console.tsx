"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, Ban, Check, ClipboardCopy, KeyRound, Layers, RefreshCw, Search, ShieldCheck, UserCheck, UserPlus, Users, UserX, Wallet } from "lucide-react";
import { api, istStamp } from "@/components/api";
import { Badge, Button, cx, Drawer, EmptyState, Notice, PageHeader, Section, Skeleton, StatCard, Tabs, type Tone } from "@/components/ui";
import { FEATURES, type FeatureKey, type Features } from "@/lib/auth/features";

type Wallet = { available: string; reserved: string; availablePaise: string } | null;
type UserRow = {
  id: string; name: string; email: string; role: "SUPER_ADMIN" | "STUDENT" | "INSTRUCTOR"; roleLabel: string; status: "ACTIVE" | "SUSPENDED" | "DISABLED";
  notes: string; createdAt: string; lastLoginAt: string | null; features: Features; wallets: { DEMO: Wallet; LIVE: Wallet };
};
type Summary = { users: { total: number; active: number; suspendedOrDisabled: number }; multiAccount: { enabled: number; disabled: number }; wallets: { totalBalance: string; adminCredits: string; adminCreditCount: number; adminDebits: string; adminDebitCount: number } };
type Detail = {
  user: UserRow;
  ledger: Array<{ id: string; wallet: "DEMO" | "LIVE"; type: string; amount: string; amountPaise: string; balanceBefore: string; balanceAfter: string; reason: string; admin: string | null; at: string }>;
  orders: Array<{ id: string; wallet: "DEMO" | "LIVE"; symbol: string; name: string; side: string; type: string; quantity: number; status: string; avgFill: string | null; replay: boolean; at: string }>;
  audit: Array<{ id: string; action: string; actor: string | null; reason: string; at: string }>;
};

const FIELD = "h-9 w-full rounded-input px-3 text-dense";
const LABEL = "flex flex-col gap-1 text-data font-medium text-text-2";
const STATUS_TONE: Record<UserRow["status"], Tone> = { ACTIVE: "profit", SUSPENDED: "warning", DISABLED: "neutral" };
const STATUS_LABEL: Record<UserRow["status"], string> = { ACTIVE: "Active", SUSPENDED: "Suspended", DISABLED: "Archived" };

function defaultFeatures(role: "SUPER_ADMIN" | "STUDENT"): Features {
  return { standardTrading: true, demoTrading: true, replay: true, multiAccount: role === "SUPER_ADMIN", brokerConnection: role === "SUPER_ADMIN", portfolio: true, orderHistory: true, analytics: true };
}

function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-input border border-border-soft bg-sunken px-2.5 py-2">
      <code className="min-w-0 flex-1 break-all text-micro text-text">{text}</code>
      <Button size="sm" variant="ghost" icon={copied ? <Check className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />} onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy"}</Button>
    </div>
  );
}

function FeatureToggles({ value, onChange, disabled }: { value: Features; onChange: (next: Features) => void; disabled?: boolean }) {
  return (
    <ul className="grid gap-1.5 sm:grid-cols-2">
      {FEATURES.map((item) => (
        <li key={item.key}>
          <label className={cx("flex cursor-pointer items-start gap-2.5 rounded-input border px-3 py-2", value[item.key] ? "border-primary/30 bg-primary-soft/40" : "border-border-soft bg-sunken")}>
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={value[item.key]} disabled={disabled} onChange={(event) => onChange({ ...value, [item.key]: event.target.checked })} />
            <span className="min-w-0">
              <span className="block text-dense font-medium text-text">{item.label}</span>
              <span className="block text-micro text-muted">{item.detail}</span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

export function SuperAdminConsole() {
  const [tab, setTab] = useState<"overview" | "users" | "audit">("overview");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [reload, setReload] = useState(0);
  const [openUser, setOpenUser] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const refresh = useCallback(() => setReload((value) => value + 1), []);

  useEffect(() => {
    let stop = false;
    api<Summary>("/api/super-admin/summary").then((data) => { if (!stop) setSummary(data); }).catch(() => undefined);
    return () => { stop = true; };
  }, [reload]);

  return (
    <div className="mx-auto flex w-full max-w-[87.5rem] flex-col gap-4 p-4 lg:p-6">
      <PageHeader
        eyebrow={<><Badge tone="primary"><ShieldCheck className="h-3 w-3" aria-hidden />Super Admin</Badge> Restricted</>}
        title="Administration"
        description="Users, permissions and practice wallets. Every change is checked on the server and written to the audit log."
        actions={<Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setCreating(true)}>Create user</Button>}
      />
      <Tabs label="Administration" value={tab} onChange={setTab} items={[{ id: "overview", label: "Overview" }, { id: "users", label: "Users", count: summary?.users.total }, { id: "audit", label: "Audit log" }]} />
      {tab === "overview" ? <Overview summary={summary} onUsers={() => setTab("users")} /> : null}
      {tab === "users" ? <UserTable reload={reload} onOpen={setOpenUser} /> : null}
      {tab === "audit" ? <AuditTab reload={reload} /> : null}
      {openUser ? <UserDrawer key={openUser} id={openUser} onClose={() => setOpenUser(null)} onChanged={refresh} /> : null}
      {creating ? <CreateUserDrawer onClose={() => setCreating(false)} onCreated={(id) => { refresh(); setTab("users"); setOpenUser(id); }} /> : null}
    </div>
  );
}

function Overview({ summary, onUsers }: { summary: Summary | null; onUsers: () => void }) {
  const loading = !summary;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="Registered users" value={summary?.users.total ?? "—"} icon={<Users className="text-primary" />} loading={loading} />
      <StatCard label="Active users" value={summary?.users.active ?? "—"} icon={<UserCheck className="text-profit" />} loading={loading} />
      <StatCard label="Suspended or archived" value={summary?.users.suspendedOrDisabled ?? "—"} icon={<UserX className="text-warning" />} loading={loading} />
      <StatCard label="Total wallet balance" value={summary?.wallets.totalBalance ?? "—"} hint="All practice wallets, incl. reserved" icon={<Wallet className="text-info" />} loading={loading} />
      <StatCard label="Admin credits" value={summary?.wallets.adminCredits ?? "—"} hint={summary ? `${summary.wallets.adminCreditCount} adjustments` : undefined} icon={<ArrowDownLeft className="text-profit" />} loading={loading} />
      <StatCard label="Admin debits" value={summary?.wallets.adminDebits ?? "—"} hint={summary ? `${summary.wallets.adminDebitCount} adjustments` : undefined} icon={<ArrowUpRight className="text-loss" />} loading={loading} />
      <StatCard label="Multi-account enabled" value={summary?.multiAccount.enabled ?? "—"} icon={<Layers className="text-demo" />} loading={loading} />
      <StatCard label="Multi-account disabled" value={summary?.multiAccount.disabled ?? "—"} icon={<Ban className="text-muted" />} loading={loading} />
      <div className="sm:col-span-2 xl:col-span-4"><Button variant="secondary" onClick={onUsers}>Manage users</Button></div>
    </div>
  );
}

function UserTable({ reload, onOpen }: { reload: number; onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [role, setRole] = useState("");
  const [multi, setMulti] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pageSize: number; users: UserRow[] } | null>(null);
  const [error, setError] = useState("");
  const query = useMemo(() => new URLSearchParams({ q, status, role, multi, page: String(page), pageSize: "20" }).toString(), [q, status, role, multi, page]);
  useEffect(() => {
    let stop = false;
    const timer = window.setTimeout(() => {
      api<{ total: number; pageSize: number; users: UserRow[] }>(`/api/super-admin/users?${query}`)
        .then((result) => { if (!stop) { setData(result); setError(""); } })
        .catch((caught: unknown) => { if (!stop) setError(caught instanceof Error ? caught.message : "Users could not be loaded."); });
    }, 200);
    return () => { stop = true; window.clearTimeout(timer); };
  }, [query, reload]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <Section flush>
      <div className="flex flex-wrap items-end gap-2 border-b border-border-soft p-3">
        <label className={cx(LABEL, "min-w-[13.75rem] flex-1")}>Search
          <span className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden /><input className={cx(FIELD, "pl-8")} placeholder="Name, email or user ID" value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }} /></span>
        </label>
        <label className={cx(LABEL, "w-36")}>Status<select className={FIELD} value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option><option value="DISABLED">Archived</option></select></label>
        <label className={cx(LABEL, "w-40")}>Role<select className={FIELD} value={role} onChange={(event) => { setRole(event.target.value); setPage(1); }}><option value="">All</option><option value="SUPER_ADMIN">Super Admin</option><option value="STUDENT">Standard User</option></select></label>
        <label className={cx(LABEL, "w-40")}>Multi-account<select className={FIELD} value={multi} onChange={(event) => { setMulti(event.target.value); setPage(1); }}><option value="">All</option><option value="on">Enabled</option><option value="off">Disabled</option></select></label>
      </div>
      {error ? <div className="p-3"><Notice tone="loss">{error}</Notice></div> : null}
      {!data && !error ? <div className="flex flex-col gap-2 p-3">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-10" />)}</div> : null}
      {data && data.users.length === 0 ? <EmptyState icon={<Users />} title="No users match these filters" /> : null}
      {data && data.users.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="ui-table w-full min-w-[61.25rem] border-separate border-spacing-0 text-data" aria-label="Users">
            <thead><tr className="text-left text-micro text-muted">{["User", "Role", "Status", "Demo wallet", "Live wallet", "Multi-account", "Created", "Last login", ""].map((header) => <th key={header} scope="col" className="border-b border-border-soft px-3 py-2 font-medium">{header || <span className="sr-only">Open</span>}</th>)}</tr></thead>
            <tbody>
              {data.users.map((user) => (
                <tr key={user.id} className="cursor-pointer hover:bg-hover" onClick={() => onOpen(user.id)}>
                  <td className="border-b border-border-soft px-3 py-2"><span className="block font-semibold text-text">{user.name}</span><span className="block text-micro text-muted">{user.email}</span><span className="num block text-[0.625rem] text-muted">{user.id}</span></td>
                  <td className="border-b border-border-soft px-3 py-2"><Badge tone={user.role === "SUPER_ADMIN" ? "primary" : "neutral"}>{user.roleLabel}</Badge></td>
                  <td className="border-b border-border-soft px-3 py-2"><Badge tone={STATUS_TONE[user.status]} dot>{STATUS_LABEL[user.status]}</Badge></td>
                  <td className="num border-b border-border-soft px-3 py-2">{user.wallets.DEMO?.available ?? <span className="text-muted">—</span>}</td>
                  <td className="num border-b border-border-soft px-3 py-2">{user.wallets.LIVE?.available ?? <span className="text-muted">Not opened</span>}</td>
                  <td className="border-b border-border-soft px-3 py-2">{user.features.multiAccount ? <Badge tone="demo">Enabled</Badge> : <Badge tone="neutral">Disabled</Badge>}</td>
                  <td className="num border-b border-border-soft px-3 py-2 text-muted">{istStamp(user.createdAt)}</td>
                  <td className="num border-b border-border-soft px-3 py-2 text-muted">{user.lastLoginAt ? istStamp(user.lastLoginAt) : "Never"}</td>
                  <td className="border-b border-border-soft px-3 py-2 text-right"><Button size="sm" variant="secondary" onClick={(event) => { event.stopPropagation(); onOpen(user.id); }}>Manage</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data && data.total > data.pageSize ? (
        <div className="flex items-center justify-between border-t border-border-soft px-3 py-2 text-data text-muted">
          <span>{data.total} users · page {page} of {pages}</span>
          <span className="flex gap-1"><Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></span>
        </div>
      ) : null}
    </Section>
  );
}

function CreateUserDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"SUPER_ADMIN" | "STUDENT">("STUDENT");
  const [status, setStatus] = useState<"ACTIVE" | "SUSPENDED">("ACTIVE");
  const [features, setFeatures] = useState<Features>(defaultFeatures("STUDENT"));
  const [credit, setCredit] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ userId: string; setupLink: string; linkExpiresHours: number } | null>(null);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const amount = credit.trim() ? Number(credit) : null;
      const created = await api<{ userId: string; setupLink: string; linkExpiresHours: number }>("/api/super-admin/users", { name, email, role, status, features, initialCreditRupees: amount, notes });
      setResult(created);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The user could not be created.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open onClose={onClose} modal label="Create user" title="Create user" subtitle="The user sets their own password through a one-time link." width="w-[35rem]" footer={
      result ? <Button block variant="primary" onClick={() => { onCreated(result.userId); onClose(); }}>Open user</Button> : (
        <div className="flex flex-col gap-2">
          {error ? <Notice tone="loss">{error}</Notice> : null}
          <div className="flex gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button className="flex-1" variant="primary" loading={busy} disabled={!name.trim() || !email.trim()} onClick={() => void submit()}>Create user</Button></div>
        </div>
      )
    }>
      {result ? (
        <div className="flex flex-col gap-3 text-dense">
          <Notice tone="info">User created. Send them this one-time link to set a password (valid {result.linkExpiresHours} hours). TradeD never shows or stores a readable password.</Notice>
          <Copyable text={result.setupLink} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={LABEL}>Full name<input className={FIELD} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} autoFocus /></label>
            <label className={LABEL}>Email<input className={FIELD} type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label className={LABEL}>Role<select className={FIELD} value={role} onChange={(event) => { const next = event.target.value as "SUPER_ADMIN" | "STUDENT"; setRole(next); setFeatures(defaultFeatures(next)); }}><option value="STUDENT">Standard User</option><option value="SUPER_ADMIN">Super Admin</option></select></label>
            <label className={LABEL}>Status<select className={FIELD} value={status} onChange={(event) => setStatus(event.target.value as "ACTIVE" | "SUSPENDED")}><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option></select></label>
            <label className={LABEL}>Initial credit (₹, optional)<input className={FIELD} inputMode="decimal" placeholder="Leave empty for none" value={credit} onChange={(event) => setCredit(event.target.value)} /></label>
            <label className={LABEL}>Notes (optional)<input className={FIELD} maxLength={500} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
          </div>
          <p className="text-micro text-muted">The Demo wallet opens with the standard starting capital. An initial credit is an administrative credit on top of it, not a deposit.</p>
          <h3 className="text-dense font-semibold text-text">Permissions</h3>
          <FeatureToggles value={features} onChange={setFeatures} />
        </div>
      )}
    </Drawer>
  );
}

function UserDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<"profile" | "permissions" | "wallet" | "premium" | "activity" | "audit">("profile");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stop = false;
    api<Detail>(`/api/super-admin/users/${id}`).then((data) => { if (!stop) { setDetail(data); setError(""); } }).catch((caught: unknown) => { if (!stop) setError(caught instanceof Error ? caught.message : "User could not be loaded."); });
    return () => { stop = true; };
  }, [id, tick]);
  const changed = () => { setTick((value) => value + 1); onChanged(); };
  const user = detail?.user;
  return (
    <Drawer open onClose={onClose} modal label="Manage user" title={user?.name ?? "User"} subtitle={user ? `${user.email} · ${user.roleLabel}` : undefined} width="w-[47.5rem]" footer={<Button block variant="secondary" onClick={onClose}>Close</Button>}>
      {error ? <Notice tone="loss">{error}</Notice> : null}
      {!detail && !error ? <div className="flex flex-col gap-2">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-10" />)}</div> : null}
      {detail && user ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={STATUS_TONE[user.status]} dot>{STATUS_LABEL[user.status]}</Badge>
            <Badge tone={user.role === "SUPER_ADMIN" ? "primary" : "neutral"}>{user.roleLabel}</Badge>
            {user.features.multiAccount ? <Badge tone="demo">Multi-account</Badge> : null}
            <span className="num text-micro text-muted">ID {user.id}</span>
          </div>
          <Tabs label="User sections" value={tab} onChange={setTab} items={[{ id: "profile", label: "Profile" }, { id: "permissions", label: "Permissions" }, { id: "wallet", label: "Wallet" }, { id: "premium", label: "Premium" }, { id: "activity", label: "Activity", count: detail.orders.length || undefined }, { id: "audit", label: "Audit" }]} />
          {tab === "profile" ? <ProfilePanel user={user} onChanged={changed} /> : null}
          {tab === "permissions" ? <PermissionsPanel user={user} onChanged={changed} /> : null}
          {tab === "wallet" ? <WalletPanel detail={detail} onChanged={changed} /> : null}
          {tab === "premium" ? <PremiumPanel userId={user.id} role={user.role} onChanged={changed} /> : null}
          {tab === "activity" ? <ActivityPanel orders={detail.orders} /> : null}
          {tab === "audit" ? <ListPanel rows={detail.audit.map((item) => ({ id: item.id, title: item.action, meta: `${item.actor ?? "system"} · ${istStamp(item.at)}`, body: item.reason }))} empty="No audit entries yet." /> : null}
        </div>
      ) : null}
    </Drawer>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "loss"; text: string } | null>(null);
  const run = async (task: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await task();
      if (text) setMessage({ tone: "info", text });
    } catch (caught) {
      setMessage({ tone: "loss", text: caught instanceof Error ? caught.message : "The change was not saved." });
    } finally {
      setBusy(false);
    }
  };
  return { busy, message, run };
}

async function patchUser(id: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/super-admin/users/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as { message?: string };
  if (!response.ok) throw new Error(data.message ?? "The change was not saved.");
}

function ProfilePanel({ user, onChanged }: { user: UserRow; onChanged: () => void }) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [notes, setNotes] = useState(user.notes);
  const [role, setRole] = useState(user.role === "SUPER_ADMIN" ? "SUPER_ADMIN" : "STUDENT");
  const [confirm, setConfirm] = useState<null | "SUSPENDED" | "DISABLED" | "ACTIVE">(null);
  const [link, setLink] = useState<string | null>(null);
  const { busy, message, run } = useAction();
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className={LABEL}>Full name<input className={FIELD} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
        <label className={LABEL}>Email<input className={FIELD} type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label className={LABEL}>Role<select className={FIELD} value={role} onChange={(event) => setRole(event.target.value as "SUPER_ADMIN" | "STUDENT")}><option value="STUDENT">Standard User</option><option value="SUPER_ADMIN">Super Admin</option></select></label>
        <label className={LABEL}>Notes<input className={FIELD} value={notes} maxLength={500} onChange={(event) => setNotes(event.target.value)} /></label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={busy} onClick={() => void run(async () => { await patchUser(user.id, { name, email, notes, ...(role !== user.role ? { role } : {}) }); onChanged(); return "Saved."; })}>Save details</Button>
        <Button variant="secondary" icon={<KeyRound className="h-4 w-4" />} disabled={busy || user.status === "DISABLED"} onClick={() => void run(async () => { const data = await api<{ setupLink: string }>(`/api/super-admin/users/${user.id}`, { action: "password-link" }); setLink(data.setupLink); onChanged(); return "New one-time password link created. Older links stop working."; })}>Password setup / reset link</Button>
      </div>
      {link ? <Copyable text={link} /> : null}
      <div className="flex flex-wrap gap-2 border-t border-border-soft pt-3">
        {user.status !== "ACTIVE" ? <Button variant="secondary" icon={<UserCheck className="h-4 w-4" />} onClick={() => setConfirm("ACTIVE")}>Reactivate</Button> : null}
        {user.status === "ACTIVE" ? <Button variant="secondary" icon={<UserX className="h-4 w-4" />} onClick={() => setConfirm("SUSPENDED")}>Suspend</Button> : null}
        {user.status !== "DISABLED" ? <Button variant="danger" icon={<Ban className="h-4 w-4" />} onClick={() => setConfirm("DISABLED")}>Archive account</Button> : null}
      </div>
      {confirm ? (
        <Notice tone={confirm === "ACTIVE" ? "info" : "loss"}>
          <p className="font-semibold">{confirm === "ACTIVE" ? "Reactivate this account?" : confirm === "SUSPENDED" ? "Suspend this account? They can sign in but cannot trade, and current sessions end." : "Archive this account? They can no longer sign in. History and wallets are kept."}</p>
          <span className="mt-2 flex gap-2"><Button size="sm" variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button><Button size="sm" variant={confirm === "ACTIVE" ? "primary" : "danger"} loading={busy} onClick={() => void run(async () => { await patchUser(user.id, { status: confirm }); setConfirm(null); onChanged(); return "Status updated."; })}>Confirm</Button></span>
        </Notice>
      ) : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
    </div>
  );
}

function PermissionsPanel({ user, onChanged }: { user: UserRow; onChanged: () => void }) {
  const [features, setFeatures] = useState<Features>(user.features);
  const dirty = FEATURES.some((item) => features[item.key] !== user.features[item.key]);
  const { busy, message, run } = useAction();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-data text-muted">Changes apply on the user&apos;s next request; no redeploy needed. Each permission is enforced by the server, not just hidden.</p>
      <FeatureToggles value={features} onChange={setFeatures} disabled={busy} />
      <Button variant="primary" disabled={!dirty} loading={busy} onClick={() => void run(async () => { await patchUser(user.id, { features }); onChanged(); return "Permissions saved."; })}>Save permissions</Button>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
    </div>
  );
}

function WalletPanel({ detail, onChanged }: { detail: Detail; onChanged: () => void }) {
  const { user } = detail;
  const [form, setForm] = useState<{ wallet: "DEMO" | "LIVE"; direction: "credit" | "debit" } | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [sure, setSure] = useState(false);
  const [key, setKey] = useState("");
  const [walletFilter, setWalletFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { busy, message, run } = useAction();
  const open = (wallet: "DEMO" | "LIVE", direction: "credit" | "debit") => { setForm({ wallet, direction }); setAmount(""); setReason(""); setSure(false); setKey(crypto.randomUUID()); };
  const rows = detail.ledger.filter((row) => (!walletFilter || row.wallet === walletFilter) && (!typeFilter || row.type === typeFilter) && (!from || row.at.slice(0, 10) >= from) && (!to || row.at.slice(0, 10) <= to));
  const types = [...new Set(detail.ledger.map((row) => row.type))];
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {(["DEMO", "LIVE"] as const).map((wallet) => (
          <div key={wallet} className="rounded-card bg-sunken p-3">
            <p className="flex items-center gap-1.5 text-micro font-medium text-muted"><Wallet className={cx("h-3.5 w-3.5", wallet === "DEMO" ? "text-demo" : "text-warning")} aria-hidden />{wallet === "DEMO" ? "Demo wallet" : "Live view wallet"}</p>
            <p className="num mt-1 text-section font-semibold text-text">{user.wallets[wallet]?.available ?? "Not opened"}</p>
            {user.wallets[wallet] ? <p className="num text-micro text-muted">Reserved {user.wallets[wallet]!.reserved}</p> : <p className="text-micro text-muted">Opens with the starting capital on first use or first credit.</p>}
            <span className="mt-2 flex gap-1.5"><Button size="sm" variant="secondary" icon={<ArrowDownLeft className="h-3.5 w-3.5 text-profit" />} onClick={() => open(wallet, "credit")}>Add money</Button><Button size="sm" variant="secondary" icon={<ArrowUpRight className="h-3.5 w-3.5 text-loss" />} disabled={!user.wallets[wallet]} onClick={() => open(wallet, "debit")}>Deduct</Button></span>
          </div>
        ))}
      </div>
      {form ? (
        <div className="flex flex-col gap-2 rounded-card border border-border p-3">
          <p className="text-dense font-semibold text-text">{form.direction === "credit" ? "Add money" : "Deduct money"} · {form.wallet === "DEMO" ? "Demo wallet" : "Live view wallet"}</p>
          <p className="text-data text-muted">{user.name} · {user.email} · current {user.wallets[form.wallet]?.available ?? "not opened"}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={LABEL}>Amount (₹)<input className={FIELD} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus /></label>
            <label className={LABEL}>Reason (required)<input className={FIELD} maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          </div>
          <label className="flex items-start gap-2 text-data text-text"><input type="checkbox" className="mt-0.5 h-4 w-4" checked={sure} onChange={(event) => setSure(event.target.checked)} />This is an administrative {form.direction === "credit" ? "credit" : "debit"} to a practice wallet, not a real deposit or withdrawal.</label>
          <span className="flex gap-2"><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button variant={form.direction === "credit" ? "buy" : "sell"} loading={busy} disabled={!sure || !(Number(amount) > 0) || reason.trim().length < 3} onClick={() => void run(async () => {
            const result = await api<{ balance: string }>(`/api/super-admin/users/${user.id}`, { action: "wallet", wallet: form.wallet, direction: form.direction, amountRupees: Number(amount), reason, key, confirmed: true });
            setForm(null);
            onChanged();
            return `Done. New balance ${result.balance}.`;
          })}>Confirm {form.direction === "credit" ? "credit" : "debit"}</Button></span>
        </div>
      ) : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className={cx(LABEL, "w-32")}>Wallet<select className={FIELD} value={walletFilter} onChange={(event) => setWalletFilter(event.target.value)}><option value="">Both</option><option value="DEMO">Demo</option><option value="LIVE">Live view</option></select></label>
        <label className={cx(LABEL, "w-44")}>Type<select className={FIELD} value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">All</option>{types.map((type) => <option key={type} value={type}>{type.replace(/_/g, " ").toLowerCase()}</option>)}</select></label>
        <label className={cx(LABEL, "w-36")}>From<input className={FIELD} type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className={cx(LABEL, "w-36")}>To<input className={FIELD} type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      </div>
      {rows.length === 0 ? <EmptyState icon={<Wallet />} title="No transactions" /> : (
        <div className="max-h-[22.5rem] overflow-auto rounded-md border border-border-soft">
          <table className="ui-table w-full min-w-[45rem] border-separate border-spacing-0 text-data" aria-label="Wallet transactions">
            <thead><tr className="text-left text-micro text-muted">{["When", "Wallet", "Type", "Amount", "Before", "After", "Reason", "Admin"].map((header) => <th key={header} scope="col" className="sticky top-0 border-b border-border-soft bg-panel px-2.5 py-2 font-medium">{header}</th>)}</tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="num border-b border-border-soft px-2.5 py-1.5 text-muted">{istStamp(row.at)}</td>
                  <td className="border-b border-border-soft px-2.5 py-1.5"><Badge tone={row.wallet === "DEMO" ? "demo" : "warning"}>{row.wallet === "DEMO" ? "Demo" : "Live"}</Badge></td>
                  <td className="border-b border-border-soft px-2.5 py-1.5">{row.type.replace(/_/g, " ").toLowerCase()}</td>
                  <td className={cx("num border-b border-border-soft px-2.5 py-1.5 font-semibold", BigInt(row.amountPaise) < 0n ? "text-loss" : "text-profit")}>{row.amount}</td>
                  <td className="num border-b border-border-soft px-2.5 py-1.5 text-muted">{row.balanceBefore}</td>
                  <td className="num border-b border-border-soft px-2.5 py-1.5">{row.balanceAfter}</td>
                  <td className="max-w-[13.75rem] truncate border-b border-border-soft px-2.5 py-1.5 text-text-2" title={row.reason}>{row.reason || "—"}</td>
                  <td className="border-b border-border-soft px-2.5 py-1.5 text-muted">{row.admin ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type PremiumRow = { id: string; plan: string; label: string; state: "Active" | "Scheduled" | "Expired" | "Cancelled"; startsAt: string; endsAt: string; source: string; note: string; createdAt: string };

/** Premium for one user: grant a plan (stacks after current access), or revoke one. Audited on the server. */
function PremiumPanel({ userId, role, onChanged }: { userId: string; role: string; onChanged: () => void }) {
  const [rows, setRows] = useState<PremiumRow[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [plan, setPlan] = useState("YEARLY");
  const [note, setNote] = useState("");
  const [sure, setSure] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeNote, setRevokeNote] = useState("");
  const { busy, message, run } = useAction();
  const load = useCallback(() => {
    api<{ subscriptions: PremiumRow[] }>(`/api/super-admin/users/${userId}/premium`).then((data) => { setRows(data.subscriptions); setLoadError(""); }).catch((caught: unknown) => setLoadError(caught instanceof Error ? caught.message : "Premium history could not be loaded."));
  }, [userId]);
  useEffect(() => { load(); }, [load]);
  const current = rows?.find((row) => row.state === "Active");
  const tone: Record<PremiumRow["state"], Tone> = { Active: "profit", Scheduled: "primary", Expired: "neutral", Cancelled: "loss" };
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="info">{role === "SUPER_ADMIN" ? "Super Admins always have Premium. " : ""}{current ? `Premium is active until ${istStamp(current.endsAt)}.` : "No active Premium."} Online payment is not connected yet, so Premium is granted here.</Notice>
      <div className="grid gap-2 rounded-card border border-border-soft p-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <label className={LABEL}>Plan
          <select className={FIELD} value={plan} onChange={(event) => setPlan(event.target.value)}>
            <option value="MONTHLY">Monthly (1 month)</option>
            <option value="HALF_YEARLY">6 Months</option>
            <option value="YEARLY">1 Year</option>
          </select>
        </label>
        <label className={LABEL}>Reason<input className={FIELD} value={note} maxLength={200} placeholder="e.g. Paid by UPI on 23 Oct" onChange={(event) => setNote(event.target.value)} /></label>
        <label className="flex items-center gap-2 text-data text-text-2 sm:col-span-2"><input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />Grant this plan. It starts now, or after the current Premium ends.</label>
        <div className="sm:col-span-2">
          <Button variant="primary" disabled={busy || !sure || note.trim().length < 3} onClick={() => void run(async () => {
            await api(`/api/super-admin/users/${userId}/premium`, { action: "grant", plan, note: note.trim() });
            setNote(""); setSure(false); load(); onChanged();
            return "Premium granted.";
          })}>Grant Premium</Button>
        </div>
      </div>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {loadError ? <Notice tone="loss">{loadError}</Notice> : null}
      {rows && rows.length === 0 ? <EmptyState icon={<ShieldCheck />} title="No Premium history" /> : null}
      {rows?.map((row) => (
        <div key={row.id} className="rounded-card border border-border-soft p-3 text-data">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-text">{row.label}</span>
            <Badge tone={tone[row.state]}>{row.state}</Badge>
            <span className="num text-muted">{istStamp(row.startsAt)} → {istStamp(row.endsAt)}</span>
            {row.state === "Active" || row.state === "Scheduled" ? <Button size="sm" variant="ghost" className="ml-auto text-loss" onClick={() => { setRevoking(row.id); setRevokeNote(""); }}>Revoke</Button> : null}
          </div>
          {row.note ? <p className="mt-1 text-muted">{row.note}</p> : null}
          {revoking === row.id ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className={cx(LABEL, "min-w-0 flex-1")}>Reason for revoking<input className={FIELD} value={revokeNote} maxLength={200} onChange={(event) => setRevokeNote(event.target.value)} /></label>
              <Button size="sm" onClick={() => setRevoking(null)}>Cancel</Button>
              <Button size="sm" variant="danger" disabled={busy || revokeNote.trim().length < 3} onClick={() => void run(async () => {
                await api(`/api/super-admin/users/${userId}/premium`, { action: "revoke", subscriptionId: row.id, note: revokeNote.trim() });
                setRevoking(null); load(); onChanged();
                return "Premium revoked.";
              })}>Revoke Premium</Button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ActivityPanel({ orders }: { orders: Detail["orders"] }) {
  if (orders.length === 0) return <EmptyState icon={<RefreshCw />} title="No orders yet" />;
  return (
    <div className="max-h-[27.5rem] overflow-auto rounded-md border border-border-soft">
      <table className="ui-table w-full min-w-[40rem] border-separate border-spacing-0 text-data" aria-label="Orders">
        <thead><tr className="text-left text-micro text-muted">{["When", "Wallet", "Instrument", "Side", "Qty", "Status", "Avg fill"].map((header) => <th key={header} scope="col" className="sticky top-0 border-b border-border-soft bg-panel px-2.5 py-2 font-medium">{header}</th>)}</tr></thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id}>
              <td className="num border-b border-border-soft px-2.5 py-1.5 text-muted">{istStamp(order.at)}</td>
              <td className="border-b border-border-soft px-2.5 py-1.5"><span className="flex gap-1"><Badge tone={order.wallet === "DEMO" ? "demo" : "warning"}>{order.wallet === "DEMO" ? "Demo" : "Live"}</Badge>{order.replay ? <Badge tone="info">Replay</Badge> : null}</span></td>
              <td className="border-b border-border-soft px-2.5 py-1.5"><span className="block font-medium text-text">{order.name}</span></td>
              <td className={cx("border-b border-border-soft px-2.5 py-1.5 font-semibold", order.side === "BUY" ? "text-profit" : "text-loss")}>{order.side}</td>
              <td className="num border-b border-border-soft px-2.5 py-1.5">{order.quantity}</td>
              <td className="border-b border-border-soft px-2.5 py-1.5">{order.status.replace(/_/g, " ").toLowerCase()}</td>
              <td className="num border-b border-border-soft px-2.5 py-1.5">{order.avgFill ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListPanel({ rows, empty }: { rows: Array<{ id: string; title: string; meta: string; body?: string }>; empty: string }): ReactNode {
  if (rows.length === 0) return <EmptyState icon={<ShieldCheck />} title={empty} />;
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <li key={row.id} className="rounded-input bg-sunken px-3 py-2 text-data">
          <p className="font-medium text-text">{row.title}</p>
          <p className="text-micro text-muted">{row.meta}</p>
          {row.body ? <p className="mt-0.5 text-micro text-text-2">{row.body}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function AuditTab({ reload }: { reload: number }) {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Array<{ id: string; action: string; actor: string; target: string; reason: string; at: string }> | null>(null);
  useEffect(() => {
    let stop = false;
    api<{ entries: Array<{ id: string; action: string; actor: string; target: string; reason: string; at: string }> }>(`/api/super-admin/audit?page=${page}`).then((data) => { if (!stop) setRows(data.entries); }).catch(() => { if (!stop) setRows([]); });
    return () => { stop = true; };
  }, [page, reload]);
  return (
    <Section title="Audit log" description="Administrative and security events, newest first.">
      {!rows ? <Skeleton className="h-40" /> : <ListPanel rows={rows.map((row) => ({ id: row.id, title: `${row.action} · ${row.target}`, meta: `${row.actor} · ${istStamp(row.at)}`, body: row.reason }))} empty="No audit entries yet." />}
      <span className="mt-3 flex gap-1"><Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button><Button size="sm" variant="secondary" disabled={!rows || rows.length < 50} onClick={() => setPage(page + 1)}>Older</Button></span>
    </Section>
  );
}

export type { FeatureKey };
