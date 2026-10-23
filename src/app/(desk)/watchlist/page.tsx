"use client";

import { WatchlistCard } from "@/components/watchlist-card";

/** The watchlist on its own screen (the phone's Watchlist tab); the same card Home shows beside the dashboard. */
export default function Page() {
  return (
    <div className="flex h-full min-h-0 flex-col p-2 sm:p-4 lg:mx-auto lg:w-full lg:max-w-3xl lg:p-6">
      <WatchlistCard full />
    </div>
  );
}
