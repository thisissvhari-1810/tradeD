"use client";

import { useEffect, useState } from "react";
import { api, istTime } from "@/components/api";
import { useDesk } from "@/components/shell";
import { ShieldCheck } from "lucide-react";
import { Badge, Button, EmptyState, Notice, PageHeader, Section } from "@/components/ui";

type Status = {
  clientSource: string;
  clientTail: string;
  tokenSource: string;
  expiresAt: string | null;
  expired: boolean;
  updatedAt: string | null;
};

export default function AdminPage() {
  const desk = useDesk();
  const [status, setStatus] = useState<Status | null>(null);
  const [clientId, setClientId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const allowed = desk.user?.role === "SUPER_ADMIN";

  useEffect(() => {
    if (!allowed) return;
    api<Status>("/api/admin/market-data").then(setStatus).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "The connection status is unavailable.");
    });
  }, [allowed]);

  if (!allowed) return <div className="p-6"><EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="Admin only" body="This page is for the admin account." /></div>;

  function save(clearToken = false) {
    setSaving(true);
    setError("");
    setNote("");
    api<Status>("/api/admin/market-data", { clientId, accessToken: clearToken ? "" : accessToken, clearToken })
      .then((next) => {
        setStatus(next);
        setAccessToken("");
        setClientId("");
        setNote(clearToken ? "The saved token was cleared. The server token is used when one is configured." : "Saved. Quotes and charts use this connection.");
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Save failed."))
      .finally(() => setSaving(false));
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 p-3 sm:p-4 lg:p-6">
        <PageHeader eyebrow={<><Badge tone="primary">Super admin</Badge> Operations</>} title="Administration" description="Market-data connection and demo capital for student accounts." />
        <Section
          title="Market data connection"
          description="Paste the client id and access token for the connected market-data account. The token is stored on the server and is not shown again."
          actions={status ? <Badge tone={status.expired ? "loss" : status.tokenSource === "missing" ? "warning" : "profit"} dot>{status.expired ? "Expired" : status.tokenSource === "missing" ? "No token" : "Connected"}</Badge> : null}
        >
          <dl className="grid gap-x-6 gap-y-3 text-data sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-muted">Client id</dt><dd className="mt-0.5 font-medium text-text">{status?.clientTail ? `ending ${status.clientTail} (${status.clientSource})` : "Not set"}</dd></div>
            <div><dt className="text-muted">Access token</dt><dd className="mt-0.5 font-medium text-text">{status?.tokenSource === "missing" ? "Not set" : status?.tokenSource === "saved" ? "Saved in this dashboard" : status ? "Server environment" : "—"}</dd></div>
            <div><dt className="text-muted">Expiry</dt><dd className={`mt-0.5 font-medium ${status?.expired ? "text-loss" : "text-text"}`}>{status?.expiresAt ? istTime(status.expiresAt) : "Not available"}{status?.expired ? " · expired" : ""}</dd></div>
            <div><dt className="text-muted">Last saved</dt><dd className="mt-0.5 font-medium text-text">{status?.updatedAt ? istTime(status.updatedAt) : "—"}</dd></div>
          </dl>
          <div className="mt-5 grid gap-3 border-t border-border-soft pt-5 md:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-data font-medium text-text-2">Client id
              <input className="h-[2.125rem] text-dense text-text" inputMode="numeric" autoComplete="off" value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder={status?.clientTail ? `Leave blank to keep the id ending ${status.clientTail}` : "Numeric client id"} />
            </label>
            <label className="flex flex-col gap-1.5 text-data font-medium text-text-2">Access token
              <input className="h-[2.125rem] text-dense text-text" type="password" autoComplete="off" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder="Paste a new token to replace the saved one" />
            </label>
          </div>
          {error ? <Notice tone="loss" className="mt-3">{error}</Notice> : null}
          {note ? <p className="mt-3 rounded-input border border-profit/25 bg-profit-soft px-3 py-2 text-data text-profit" role="status">{note}</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" loading={saving} onClick={() => save(false)}>Save connection</Button>
            <Button disabled={saving || status?.tokenSource !== "saved"} onClick={() => save(true)}>Clear saved token</Button>
          </div>
        </Section>
        <DemoCapital />
      </div>
    </div>
  );
}

type StudentRow = {
  id: string;
  name: string;
  email: string;
  status: string;
  startingCapital: string;
  cashAvailable: string;
  cashReserved: string;
  realized: string;
  trades: number;
  wins: number;
  losses: number;
};

function DemoCapital() {
  const desk = useDesk();
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [selected, setSelected] = useState("");
  const [amount, setAmount] = useState("100000");
  const [reason, setReason] = useState("");
  const [direction, setDirection] = useState<"credit" | "debit">("credit");
  const [history, setHistory] = useState<Array<{ id: string; type: string; amount: string; cashAfter: string; reason: string; at: string }>>([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<"allocate" | "reset" | null>(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);

  function load() {
    api<{ students: StudentRow[] }>("/api/admin/capital").then((data) => setStudents(data.students)).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Student accounts are unavailable."));
  }

  useEffect(() => { load(); }, []);

  const student = students.find((item) => item.id === selected) ?? null;

  function ask(next: "allocate" | "reset") {
    setError("");
    setNote("");
    if (!student) { setError("Choose a student."); return; }
    if (reason.trim().length < 3) { setError("Enter a reason of at least 3 characters."); return; }
    setKey(crypto.randomUUID());
    setConfirm(next);
  }

  function run() {
    if (!student || !confirm || saving) return;
    setSaving(true);
    const body = confirm === "reset"
      ? { action: "reset", userId: student.id, reason }
      : { action: "allocate", userId: student.id, amountRupees: amount, direction, reason, idempotencyKey: key };
    api<{ message?: string }>("/api/admin/capital", body)
      .then((result) => {
        setNote(result.message ?? "Saved.");
        setConfirm(null);
        desk.toast(result.message ?? "Demo capital updated.");
        load();
        return api<{ entries: typeof history }>("/api/admin/capital", { action: "history", userId: student.id }).then((data) => setHistory(data.entries));
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The capital change was not saved."))
      .finally(() => setSaving(false));
  }

  return (
    <Section title="Demo capital management" description="Allocate, reduce, or reset a student’s virtual currency. Each change is stored on the account ledger. Students cannot add capital themselves." flush>
      <div className="overflow-auto">
        <table className="text-dense">
          <thead><tr><th>Student</th><th>Status</th><th className="num">Opening</th><th className="num">Available</th><th className="num">Reserved</th><th className="num">Realized</th><th className="num">Trades</th></tr></thead>
          <tbody>
            {students.length === 0 ? <tr><td colSpan={7}><EmptyState title="No student accounts" body="Student accounts appear here once they are created." /></td></tr> : students.map((row) => (
              <tr key={row.id} className={row.id === selected ? "[&>td]:bg-primary-soft" : ""} aria-selected={row.id === selected}>
                <td><button type="button" className="text-left font-semibold text-text hover:text-primary" onClick={() => { setSelected(row.id); setConfirm(null); api<{ entries: typeof history }>("/api/admin/capital", { action: "history", userId: row.id }).then((data) => setHistory(data.entries)).catch(() => setHistory([])); }}>{row.name}<span className="block text-micro font-normal text-muted">{row.email}</span></button></td>
                <td><Badge tone={row.status === "ACTIVE" ? "profit" : "neutral"}>{row.status}</Badge></td>
                <td className="num">{row.startingCapital}</td>
                <td className="num font-medium text-text">{row.cashAvailable}</td>
                <td className="num">{row.cashReserved}</td>
                <td className={`num ${row.realized.startsWith("-") ? "text-loss" : row.realized.startsWith("+") ? "text-profit" : ""}`}>{row.realized}</td>
                <td className="num">{row.trades} · <span className="text-profit">{row.wins}W</span> <span className="text-loss">{row.losses}L</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border-soft p-4">
        <p className="eyebrow mb-3">{student ? `Adjust ${student.name}` : "Select a student above"}</p>
        <div className="grid gap-3 md:grid-cols-[160px_200px_minmax(0,1fr)]">
          <label className="flex flex-col gap-1.5 text-data font-medium text-text-2">Amount (₹)
            <input className="num h-[2.125rem] text-text" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" />
          </label>
          <label className="flex flex-col gap-1.5 text-data font-medium text-text-2">Direction
            <select className="h-[2.125rem] py-0 text-text" value={direction} onChange={(event) => setDirection(event.target.value as "credit" | "debit")}>
              <option value="credit">Add capital</option>
              <option value="debit">Reduce available cash</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-data font-medium text-text-2">Reason
            <input className="h-[2.125rem] text-text" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this allocation is being made" />
          </label>
        </div>
        {student ? <p className="mt-3 text-data text-muted">{student.name} has <span className="num text-text-2">{student.cashAvailable}</span> available and <span className="num text-text-2">{student.cashReserved}</span> reserved. A reduction cannot exceed available cash, and it does not close positions.</p> : null}
        {confirm ? (
          <div className={`anim-rise mt-4 rounded-md border p-4 text-dense ${confirm === "reset" ? "border-warning/35 bg-warning-soft" : "border-primary/30 bg-primary-soft"}`} role="alertdialog" aria-label="Confirm capital change">
            <p className="text-text">{confirm === "reset" ? `Reset ${student?.name}? Open orders are cancelled, reserved cash is released, and a new practice period starts. Earlier trades and allocations stay in the ledger.` : `${direction === "credit" ? "Add" : "Reduce"} ₹${amount} for ${student?.name}?`}</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="primary" loading={saving} onClick={run}>Confirm</Button>
              <Button size="sm" onClick={() => setConfirm(null)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => ask("allocate")}>Review allocation</Button>
            <Button variant="danger" onClick={() => ask("reset")}>Review reset</Button>
          </div>
        )}
        {error ? <Notice tone="loss" className="mt-3">{error}</Notice> : null}
        {note ? <p className="mt-3 rounded-input border border-profit/25 bg-profit-soft px-3 py-2 text-data text-profit" role="status">{note}</p> : null}
      </div>
      {history.length ? (
        <div className="max-h-64 overflow-auto border-t border-border-soft">
          <table className="text-dense">
            <thead><tr><th>When</th><th>Type</th><th className="num">Amount</th><th className="num">Cash after</th><th>Reason</th></tr></thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id}>
                  <td className="whitespace-nowrap text-text-2">{istTime(entry.at)}</td>
                  <td><Badge>{entry.type}</Badge></td>
                  <td className="num font-medium text-text">{entry.amount}</td>
                  <td className="num">{entry.cashAfter}</td>
                  <td className="text-text-2">{entry.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Section>
  );
}
