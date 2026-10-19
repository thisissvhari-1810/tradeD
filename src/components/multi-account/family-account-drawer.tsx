"use client";

import { useState } from "react";
import { CircleCheck, CircleX, Copy, ExternalLink, KeyRound, Trash2, Unplug } from "lucide-react";
import { api } from "@/components/api";
import { FIELD, LABEL } from "@/components/multi-account/format";
import { StateChip } from "@/components/multi-account/live-order-panel";
import { Badge, Button, cx, Drawer, Notice } from "@/components/ui";
import type { LiveAccount } from "@/lib/multi-account/live";

const RELATIONSHIPS = [
  { id: "SPOUSE", label: "Spouse" },
  { id: "DEPENDENT_CHILD", label: "Dependent child" },
  { id: "DEPENDENT_PARENT", label: "Dependent parent" },
  { id: "SELF", label: "Self (another of my own Dhan accounts)" },
] as const;

type Relationship = (typeof RELATIONSHIPS)[number]["id"];

async function removeAccount(id: string) {
  const response = await fetch(`/api/broker-accounts/${id}`, { method: "DELETE" });
  const data = (await response.json().catch(() => ({}))) as { message?: string };
  if (!response.ok) throw new Error(data.message ?? "The account could not be removed.");
}

/**
 * Adds or manages one family member's Dhan account. The holder creates their own API key in Dhan and signs in
 * on Dhan's page; TradeD stores the key and secret encrypted and never sees their password or OTP.
 */
export function FamilyAccountDrawer({ open, onClose, account, requirements, onChanged }: { open: boolean; onClose: () => void; account: LiveAccount | null; requirements: string[]; onChanged: () => void }) {
  const family = account?.family ?? null;
  const self = Boolean(family?.self);
  const [accountId, setAccountId] = useState<string | null>(family?.brokerAccountId ?? null);
  const [callbackUrl, setCallbackUrl] = useState(family?.callbackUrl ?? "");
  const [nickname, setNickname] = useState(account?.nickname ?? "");
  const [relationship, setRelationship] = useState<Relationship>(family?.relationship ?? "SPOUSE");
  const [clientId, setClientId] = useState(self ? account?.clientId ?? "" : "");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [staticIp, setStaticIp] = useState(family?.staticIp ?? "");
  const [ipConfirmed, setIpConfirmed] = useState(family?.ipConfirmed ?? false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const run = async (tag: string, task: () => Promise<void>) => {
    setBusy(tag);
    setError("");
    setNote("");
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request failed.");
    } finally {
      setBusy("");
    }
  };

  const create = () => run("create", async () => {
    const data = await api<{ account: { id: string } }>("/api/broker-accounts", { nickname: nickname.trim(), relationship });
    setAccountId(data.account.id);
    setCallbackUrl(`${window.location.origin}/api/broker-accounts/callback/${data.account.id}`);
    onChanged();
  });

  const save = () => run("save", async () => {
    if (!accountId) return;
    await api(`/api/broker-accounts/${accountId}`, { action: "configure", clientId: clientId.trim(), appId: appId.trim(), ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}), staticIp: staticIp.trim(), ipConfirmed: self || ipConfirmed });
    setAppSecret("");
    setNote("Saved. Next: Sign in with Dhan.");
    onChanged();
  });

  const connect = () => run("connect", async () => {
    if (!accountId) return;
    const data = await api<{ url: string }>(`/api/broker-accounts/${accountId}`, { action: "connect" });
    window.location.assign(data.url);
  });

  const disconnect = () => run("disconnect", async () => {
    if (!accountId) return;
    await api(`/api/broker-accounts/${accountId}`, { action: "disconnect" });
    setNote("Disconnected. The saved API key and token were deleted.");
    onChanged();
  });

  const remove = () => run("remove", async () => {
    if (!accountId) return;
    await removeAccount(accountId);
    onChanged();
    onClose();
  });

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setNote("Copied.")).catch(() => setNote("Copy failed: select the text and copy it."));
  };

  const configured = family?.configured ?? false;
  const needsSignIn = account?.connection === "AUTH_REQUIRED" || account?.connection === "EXPIRED" || account?.connection === "ERROR";

  return (
    <Drawer open={open} onClose={onClose} modal label="Family broker account" title={self ? "Sign in with Dhan" : accountId ? nickname || "Family account" : "Add family account"} subtitle={self ? `Your account · Client ID ${account?.clientId ?? ""}` : family ? family.relationshipLabel : "Your own or your family's Dhan account"} width="w-[520px]" footer={
      <div className="flex flex-col gap-2">
        {error ? <Notice tone="loss">{error}</Notice> : null}
        {note ? <p className="text-micro text-profit">{note}</p> : null}
        <Button block variant="secondary" onClick={onClose}>Close</Button>
      </div>
    }>
      <div className="flex flex-col gap-4 text-dense">
        {self
          ? <Notice tone="info">Set this up once, then sign in through Dhan each trading day instead of pasting a token in Admin. Dhan also sends your KYC name, shown on your card. TradeD never sees your password or OTP.</Notice>
          : <Notice tone="warning">Only your own and your family&apos;s accounts are allowed (spouse, dependent children, dependent parents). Each holder signs in on Dhan&apos;s own page; TradeD never asks for their password or OTP.</Notice>}

        {account && account.target ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <StateChip state={account.connection} />
            {family?.ipConfirmed ? <Badge tone="profit"><CircleCheck className="h-3 w-3" aria-hidden />IP {family.staticIp}</Badge> : <Badge tone="warning"><CircleX className="h-3 w-3" aria-hidden />Static IP not confirmed</Badge>}
            {account.maskedId ? <span className="num text-micro text-muted">{account.maskedId}</span> : null}
          </div>
        ) : null}

        {self ? null : <section className="flex flex-col gap-2">
          <h3 className="font-semibold text-text">1 · Who is the holder?</h3>
          <label className={LABEL}>Nickname
            <input className={FIELD} value={nickname} maxLength={40} disabled={Boolean(accountId)} onChange={(event) => setNickname(event.target.value)} placeholder="e.g. Amma" />
          </label>
          <label className={LABEL}>Relationship to you
            <select className={FIELD} value={relationship} disabled={Boolean(accountId)} onChange={(event) => setRelationship(event.target.value as Relationship)}>
              {RELATIONSHIPS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          {!accountId ? <Button variant="primary" disabled={!nickname.trim() || busy !== ""} onClick={() => void create()}>{busy === "create" ? "Adding…" : "Add account"}</Button> : null}
        </section>}

        {accountId ? (
          <>
            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-text">{self ? "1 · Create your Dhan API key" : "2 · Holder creates a Dhan API key"}</h3>
              <ol className="list-decimal space-y-1 pl-5 text-data text-text-2">
                <li>{self ? "Sign in to" : "The holder signs in to"} <strong>web.dhan.co</strong> → My Profile → <strong>Access DhanHQ APIs</strong> → <strong>API key</strong>.</li>
                <li>App name: <strong>TradeD</strong>. Redirect URL: the address below.</li>
                <li>{self ? <>Copy the <strong>API key</strong> and <strong>API secret</strong> (valid 12 months).</> : <>They give you the <strong>API key</strong> and <strong>API secret</strong> (valid 12 months) and their <strong>Dhan client id</strong>.</>}</li>
              </ol>
              <div className="flex items-center gap-2 rounded-input border border-border-soft bg-sunken px-2.5 py-2">
                <code className="min-w-0 flex-1 break-all text-micro text-text">{callbackUrl || family?.callbackUrl}</code>
                <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(callbackUrl || family?.callbackUrl || "")}>Copy</Button>
              </div>
            </section>

            {self ? null : <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-text">3 · Static IP for this holder</h3>
              <p className="text-data text-text-2">Dhan needs a different static IP for each person. Add an Elastic IP for them on the execution server, then register it as the <strong>primary IP</strong> in <em>their</em> Dhan account (Access DhanHQ APIs → Static IP).</p>
            </section>}

            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-text">{self ? "2 · Save your API key" : "4 · Save the holder's details"}</h3>
              <div className="grid grid-cols-2 gap-2">
                {self ? null : <><label className={LABEL}>Dhan client id
                  <input className={FIELD} inputMode="numeric" autoComplete="off" value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder={configured && account?.maskedId ? `Re-enter (${account.maskedId})` : "e.g. 1100012345"} />
                </label>
                <label className={LABEL}>Static IP (public)
                  <input className={FIELD} inputMode="decimal" autoComplete="off" value={staticIp} onChange={(event) => setStaticIp(event.target.value)} placeholder="e.g. 13.50.1.2" />
                </label></>}
                <label className={cx(LABEL, "col-span-2")}>API key
                  <input className={FIELD} autoComplete="off" spellCheck={false} value={appId} onChange={(event) => setAppId(event.target.value)} />
                </label>
                <label className={cx(LABEL, "col-span-2")}>API secret
                  <input className={FIELD} type="password" autoComplete="new-password" spellCheck={false} value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder={configured ? "Leave blank to keep the saved secret" : ""} />
                </label>
              </div>
              {self ? null : <label className="flex items-start gap-2 text-data text-text">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={ipConfirmed} onChange={(event) => setIpConfirmed(event.target.checked)} />
                <span>This IP is registered as the primary static IP in this holder&apos;s Dhan account.</span>
              </label>}
              <Button variant="primary" disabled={busy !== "" || !appId.trim() || (!self && (!clientId.trim() || !staticIp.trim())) || (!configured && !appSecret.trim())} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save details"}</Button>
              <p className="text-micro text-muted">The API key and secret are stored encrypted on the server and never shown again.</p>
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="font-semibold text-text">{self ? "3 · Sign in through Dhan" : "5 · Holder signs in through Dhan"} <span className="font-normal text-muted">(once a day)</span></h3>
              <p className="text-data text-text-2">{self ? "Opens Dhan's login. Enter your password and OTP there; Dhan sends you back here. The new token also powers live charts. Repeat each trading day." : "Opens Dhan's login. The holder enters their own password and OTP there, and Dhan sends them back here. Tokens last 24 hours, so repeat this each trading day."}</p>
              <Button variant={needsSignIn || !account?.authorized ? "primary" : "secondary"} disabled={!configured || busy !== ""} icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => void connect()}>{busy === "connect" ? "Opening Dhan…" : "Sign in with Dhan"}</Button>
              {!configured ? <p className="text-micro text-muted">{self ? "Save your API key first." : "Save the holder's details first."}</p> : null}
            </section>

            <section className="flex flex-wrap gap-2 border-t border-border-soft pt-3">
              <Button size="sm" variant="secondary" disabled={busy !== "" || !configured} icon={<Unplug className="h-3.5 w-3.5" />} onClick={() => void disconnect()}>Disconnect</Button>
              {self ? null : confirmRemove
                ? <Button size="sm" variant="danger" disabled={busy !== ""} icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => void remove()}>Confirm remove</Button>
                : <Button size="sm" variant="ghost" disabled={busy !== ""} icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirmRemove(true)}>Remove account</Button>}
            </section>
          </>
        ) : null}

        {self ? null : <details className="rounded-input border border-border-soft bg-sunken p-2.5 text-data text-text-2">
          <summary className="cursor-pointer font-medium text-text"><KeyRound className="mr-1 inline h-3.5 w-3.5" aria-hidden />What each holder needs</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">{requirements.map((item) => <li key={item}>{item}</li>)}</ul>
        </details>}
      </div>
    </Drawer>
  );
}
