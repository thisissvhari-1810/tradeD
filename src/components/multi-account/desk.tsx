"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleX, LayoutGrid, Plus, Rows3, UsersRound } from "lucide-react";
import { api, istStamp } from "@/components/api";
import { useDesk } from "@/components/shell";
import { AccountCard, ACCOUNT_GRID, AccountsSkeleton, AccountTable, BulkBar } from "@/components/multi-account/accounts";
import { AccountSettings } from "@/components/multi-account/account-settings";
import { ConsoleHeader } from "@/components/multi-account/console-header";
import { ComplianceChecklist, LiveLockedBanner } from "@/components/multi-account/live-compliance";
import { LiveDesk } from "@/components/multi-account/live-desk";
import { OrderConfirmation, OrderEntry, OrderResultPanel } from "@/components/multi-account/order-panel";
import { SummarySkeleton, SummaryStrip } from "@/components/multi-account/summary-strip";
import { OrdersTable, PositionsView } from "@/components/multi-account/tables";
import { useAccountView, useLayout } from "@/components/multi-account/use-layout";
import { useOrderForm } from "@/components/multi-account/use-order-form";
import { Button, Drawer, EmptyState, Notice, Section, SegmentedControl, Skeleton, Tabs } from "@/components/ui";
import { kolkataParts } from "@/lib/market/clock";
import { liveGate } from "@/lib/multi-account/compliance";
import type { DemoAccount, Leg, PriceSource } from "@/lib/multi-account/engine";
import type { LiveView } from "@/lib/multi-account/live";
import type { MultiAccountView } from "@/lib/multi-account/view";

type Tab = "orders" | "positions" | "compliance";

function sourceQuery(source: PriceSource) {
  return source.kind === "replay" ? `?source=replay&date=${source.date}&time=${source.time}` : "?source=chain";
}

export function MultiAccountDesk() {
  const { toast } = useDesk();
  const layout = useLayout();
  const [accountView, setAccountView] = useAccountView();
  const [view, setView] = useState<MultiAccountView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [mode, setMode] = useState<"DEMO" | "LIVE">("LIVE");
  const [liveView, setLiveView] = useState<LiveView | null>(null);
  const [liveError, setLiveError] = useState("");
  const [liveSyncing, setLiveSyncing] = useState(false);
  const [liveSyncedAt, setLiveSyncedAt] = useState<Date | null>(null);
  const [sourceKind, setSourceKind] = useState<"chain" | "replay">("chain");
  const [replayDate, setReplayDate] = useState(() => kolkataParts(new Date()).dateKey);
  const [replayTime, setReplayTime] = useState("10:00");
  const [tab, setTab] = useState<Tab>("orders");
  const [busy, setBusy] = useState<string | null>(null);
  const [haltAsk, setHaltAsk] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const source: PriceSource = useMemo(() => (sourceKind === "replay" ? { kind: "replay", date: replayDate, time: replayTime } : { kind: "chain" }), [sourceKind, replayDate, replayTime]);

  useEffect(() => {
    if (mode !== "LIVE") return;
    let stop = false;
    const load = () => {
      setLiveSyncing(true);
      api<LiveView>("/api/multi-account/live")
        .then((data) => { if (!stop) { setLiveView(data); setLiveError(""); setLiveSyncedAt(new Date(data.syncedAt)); } })
        .catch((error: unknown) => { if (!stop) setLiveError(error instanceof Error ? error.message : "Live accounts could not be loaded."); })
        .finally(() => { if (!stop) setLiveSyncing(false); });
    };
    load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 60_000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [mode, reload]);

  useEffect(() => {
    if (mode !== "DEMO") return;
    let stop = false;
    const load = () => {
      setRefreshing(true);
      api<MultiAccountView>(`/api/multi-account${sourceQuery(source)}`)
        .then((data) => { if (!stop) { setView(data); setLoadError(""); setUpdatedAt(new Date()); } })
        .catch((error: unknown) => { if (!stop) setLoadError(error instanceof Error ? error.message : "Could not load the accounts."); })
        .finally(() => { if (!stop) setRefreshing(false); });
    };
    load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 30_000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [mode, source, reload]);

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  const act = useCallback(async <T,>(tag: string, body: Record<string, unknown>, done?: (data: T) => void) => {
    setBusy(tag);
    try {
      const data = await api<T>("/api/multi-account", body);
      done?.(data);
      refresh();
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : "The change was not saved.", { tone: "error" });
      refresh();
      return false;
    } finally {
      setBusy(null);
    }
  }, [refresh, toast]);

  const patchAccounts = useCallback((patches: Array<Partial<DemoAccount> & { id: string }>) => {
    setView((current) => current ? { ...current, doc: { ...current.doc, accounts: current.doc.accounts.map((account) => { const patch = patches.find((item) => item.id === account.id); return patch ? { ...account, ...patch } : account; }) } } : current);
    void act("accounts", { action: "accounts", patches: patches.map(({ id, nickname, selected, lots, tradingEnabled, risk }) => ({ id, nickname, selected, lots, tradingEnabled, risk })) });
  }, [act]);

  const doc = view?.doc ?? null;
  const selected = useMemo(() => doc?.accounts.filter((account) => account.selected).map((account) => account.id) ?? [], [doc]);
  const enabledIds = useMemo(() => doc?.accounts.filter((account) => account.tradingEnabled).map((account) => account.id) ?? [], [doc]);
  const setSelected = useCallback((next: string[]) => {
    if (!doc) return;
    const patches = doc.accounts.filter((account) => account.selected !== next.includes(account.id)).map((account) => ({ id: account.id, selected: next.includes(account.id) }));
    if (patches.length) patchAccounts(patches);
  }, [doc, patchAccounts]);
  const toggleAccount = useCallback((account: DemoAccount) => setSelected(account.selected ? selected.filter((id) => id !== account.id) : [...selected, account.id]), [selected, setSelected]);

  const latestLeg = useMemo(() => {
    const map = new Map<string, Leg>();
    for (const request of doc?.requests ?? []) for (const leg of request.legs) if (!map.has(leg.accountId)) map.set(leg.accountId, leg);
    return map;
  }, [doc]);

  const form = useOrderForm({ doc, source, selected, reloadToken: reload, onPlaced: refresh, toast });

  const live = mode === "LIVE";
  const summary = view?.summary;
  const editAccount = doc?.accounts.find((account) => account.id === editing) ?? null;
  const selectedLots = doc?.accounts.filter((account) => account.selected).reduce((sum, account) => sum + account.lots, 0) ?? 0;
  const orderDisabled = Boolean(doc?.halted) || !view?.marketData.pricesAvailable;
  const orderDisabledReason = doc?.halted ? "Emergency stop is on. Resume orders to place new requests." : view?.marketData.message ?? "";

  const review = useCallback(async () => {
    const opened = await form.startReview();
    if (opened) setSheetOpen(false);
  }, [form]);

  const entry = doc && view ? (
    <OrderEntry form={form} doc={doc} source={source} selected={selected} onSelect={setSelected} disabled={orderDisabled} disabledReason={orderDisabledReason} onReview={() => void review()} />
  ) : null;

  const openOrder = () => {
    if (layout === "narrow") setSheetOpen(true);
    else document.getElementById("ma-order-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="mx-auto w-full max-w-[105rem] px-3 pb-24 sm:px-4 lg:px-5 xl:pb-8">
      <ConsoleHeader
        mode={mode}
        onMode={setMode}
        sourceKind={sourceKind}
        onSourceKind={setSourceKind}
        replayDate={replayDate}
        onReplayDate={setReplayDate}
        replayTime={replayTime}
        onReplayTime={setReplayTime}
        maxDate={kolkataParts(new Date()).dateKey}
        updatedAt={live ? liveSyncedAt : updatedAt}
        refreshing={live ? liveSyncing : refreshing}
        onRefresh={refresh}
        halted={Boolean(doc?.halted)}
        showHalt={!live && doc != null}
        onHalt={() => setHaltAsk(true)}
      />

      <div className="flex flex-col gap-4 pt-4">
        {live ? (
          <LiveDesk view={liveView} error={liveError} syncing={liveSyncing} layout={layout} accountView={accountView} onAccountView={setAccountView} reloadToken={reload} gate={liveView?.gate ?? liveGate()} onReload={refresh} />
        ) : !view && !loadError ? (
          <LoadingState view={accountView} />
        ) : !view || !doc ? (
          <Section><EmptyState icon={<CircleX />} title="Accounts could not be loaded" body={loadError} action={<Button onClick={refresh}>Try again</Button>} /></Section>
        ) : (
          <>
            {loadError ? <Notice tone="warning">Connection problem. Showing data from {updatedAt ? istStamp(updatedAt.toISOString()) : "the last load"}. {loadError}</Notice> : null}
            {doc.halted ? <Notice tone="loss">Emergency stop is on since {istStamp(doc.haltedAt)}. New orders are blocked for every account. Open positions can still be closed from the Positions tab.</Notice> : null}
            {!view.marketData.pricesAvailable ? <Notice tone="warning">{view.marketData.message}</Notice> : null}
            {source.kind === "replay" ? <p className="-mt-1 text-micro text-muted">Replay: fills and marks use the 1-minute premium completed by {replayDate} {replayTime} IST. Only currently listed expiries can be replayed.</p> : null}

            {summary ? <SummaryStrip summary={summary} /> : null}
            {form.result ? <OrderResultPanel request={form.result} onDismiss={form.dismissResult} /> : null}

            <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
              <div className="flex min-w-0 flex-col gap-4">
                <Section
                  title="Accounts"
                  description="Eight demo accounts with virtual balances. No broker link, no credentials stored."
                  actions={
                    <>
                      {selected.length === 0 ? <Button size="sm" variant="ghost" onClick={() => setSelected(enabledIds)} disabled={enabledIds.length === 0}>Select all enabled</Button> : null}
                      <SegmentedControl label="Account layout" size="sm" value={accountView} onChange={setAccountView} options={[{ id: "grid", label: <span className="inline-flex items-center gap-1"><LayoutGrid className="h-3.5 w-3.5" aria-hidden />Grid</span> }, { id: "table", label: <span className="inline-flex items-center gap-1"><Rows3 className="h-3.5 w-3.5" aria-hidden />Table</span> }]} />
                    </>
                  }
                  bodyClassName="flex flex-col gap-2.5"
                >
                  <BulkBar count={selected.length} lots={selectedLots} canSelectMore={selected.length < enabledIds.length} onSelectAll={() => setSelected(enabledIds)} onClear={() => setSelected([])} />
                  {accountView === "table" ? (
                    <AccountTable accounts={doc.accounts} summaries={summary?.accounts ?? []} latest={latestLeg} onToggle={toggleAccount} onLots={(account, lots) => patchAccounts([{ id: account.id, lots }])} onEdit={(account) => setEditing(account.id)} />
                  ) : (
                    <div className={ACCOUNT_GRID}>
                      {doc.accounts.map((account) => (
                        <AccountCard
                          key={account.id}
                          account={account}
                          stats={summary?.accounts.find((row) => row.accountId === account.id) ?? null}
                          latest={latestLeg.get(account.id) ?? null}
                          onToggle={() => toggleAccount(account)}
                          onLots={(lots) => patchAccounts([{ id: account.id, lots }])}
                          onEdit={() => setEditing(account.id)}
                        />
                      ))}
                    </div>
                  )}
                </Section>

                {layout === "medium" ? <div id="ma-order-panel" className="scroll-mt-20"><Section title="New CE / PE order" description="One instruction, placed separately for each selected account.">{entry}</Section></div> : null}

                <Section flush>
                  <div className="border-b border-border-soft px-4 pt-2">
                    <Tabs label="Multi-account views" value={tab} onChange={setTab} items={[
                      { id: "orders", label: "Orders", count: doc.requests.reduce((sum, request) => sum + request.legs.length, 0) },
                      { id: "positions", label: "Positions", count: summary?.combined.openPositions },
                      { id: "compliance", label: "Live trading rules" },
                    ]} />
                  </div>
                  <div className="p-4">
                    {tab === "orders" ? (
                      <OrdersTable
                        doc={doc}
                        busy={busy}
                        onReconcile={(requestId) => void act<{ changed: number; priceNote: string }>(`reconcile:${requestId}`, { action: "reconcile", requestId, source }, (data) => toast(data.changed ? `Reconciled ${data.changed} ${data.changed === 1 ? "leg" : "legs"}.` : data.priceNote || "Nothing changed: the limit is still not reached.", { tone: "info" }))}
                        onCancel={(requestId) => void act(`cancel:${requestId}`, { action: "cancel", requestId }, () => toast("Pending legs cancelled.", { tone: "info" }))}
                      />
                    ) : null}
                    {tab === "positions" ? (
                      <PositionsView
                        doc={doc}
                        marks={view.marks}
                        busy={busy === "close"}
                        onClose={(positions) => act<{ results: Array<{ symbol: string; error: string | null }> }>("close", { action: "close", mode: "DEMO", key: crypto.randomUUID(), positions, source, confirmed: true }, (data) => {
                          const failed = data.results.filter((item) => item.error);
                          toast(failed.length ? `Closed ${data.results.length - failed.length} of ${data.results.length} contracts. ${failed[0]?.error ?? ""}` : "Close requests placed. Check the Orders tab for each account's result.", { tone: failed.length ? "warning" : "success" });
                        })}
                      />
                    ) : null}
                    {tab === "compliance" ? (
                      <div className="flex flex-col gap-4">
                        <LiveLockedBanner />
                        <ComplianceChecklist gate={view.live} />
                      </div>
                    ) : null}
                  </div>
                </Section>
              </div>

              {layout === "wide" ? (
                <aside className="no-scrollbar sticky top-[4.25rem] max-h-[calc(100dvh-var(--topbar)-84px)] overflow-y-auto rounded-card" aria-label="Order entry">
                  <Section title="CE / PE order" description="One instruction, placed separately for each selected account.">{entry}</Section>
                </aside>
              ) : null}
            </div>
          </>
        )}
      </div>

      {!live && doc && layout !== "wide" ? (
        <button type="button" onClick={openOrder} className="fixed bottom-[calc(var(--tabbar)+env(safe-area-inset-bottom)+1rem)] right-4 z-30 inline-flex h-11 items-center gap-2 rounded-pill bg-primary px-5 text-dense font-semibold text-on-primary shadow-e2 transition hover:bg-primary-hover lg:bottom-6">
          <Plus className="h-4 w-4" aria-hidden />New order{selected.length ? <span className="num rounded-pill bg-on-primary/20 px-1.5 text-micro">{selected.length}</span> : null}
        </button>
      ) : null}

      {layout === "narrow" ? (
        <Drawer open={sheetOpen} onClose={() => setSheetOpen(false)} modal label="New CE / PE order" title="New CE / PE order" subtitle={<span className="inline-flex items-center gap-1"><UsersRound className="h-3 w-3" aria-hidden />{selected.length} selected</span>}>
          {entry}
        </Drawer>
      ) : null}

      <OrderConfirmation form={form} />

      <Drawer open={haltAsk} onClose={() => setHaltAsk(false)} modal label="Emergency stop" title={doc?.halted ? "Resume new orders?" : "Stop all new orders?"} footer={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setHaltAsk(false)}>Cancel</Button>
          <Button className="flex-1" variant={doc?.halted ? "primary" : "danger"} loading={busy === "halt"} onClick={() => void act("halt", { action: "halt", halted: !doc?.halted }, () => { setHaltAsk(false); toast(doc?.halted ? "New orders are allowed again." : "Emergency stop is on.", { tone: doc?.halted ? "success" : "warning" }); })}>
            {doc?.halted ? "Resume orders" : "Stop new orders"}
          </Button>
        </div>
      }>
        <p className="text-dense text-text-2">{doc?.halted ? "New demo orders will be accepted again for accounts that have trading turned on." : "Every account immediately refuses new orders. Pending limit orders are not filled by reconcile while stopped. Open positions stay open; close them separately from the Positions tab."}</p>
      </Drawer>

      {editAccount ? <AccountSettings key={editAccount.id} account={editAccount} busy={busy} onClose={() => setEditing(null)} onSave={(patch) => { patchAccounts([{ id: editAccount.id, ...patch }]); setEditing(null); }} onReset={(startingPaise) => void act("reset", { action: "reset", accountId: editAccount.id, startingPaise }, () => { toast("Demo account reset.", { tone: "success" }); setEditing(null); })} /> : null}
    </div>
  );
}

function LoadingState({ view }: { view: "grid" | "table" }) {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading accounts">
      <SummarySkeleton />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="surface flex flex-col gap-3 p-4">
          <Skeleton className="h-5 w-40" />
          <AccountsSkeleton view={view} />
        </div>
        <Skeleton className="hidden h-[38.75rem] rounded-card xl:block" />
      </div>
    </div>
  );
}
