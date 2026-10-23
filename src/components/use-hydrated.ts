"use client";

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

const noSubscribe = () => () => undefined;

/**
 * False during the server render and hydration, true afterwards. Components read browser storage
 * (localStorage) only once this is true, so the first client render matches the server HTML.
 */
export function useHydrated() {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

/**
 * A ref that always holds the latest value. It is updated after each render (in a layout effect,
 * before any passive effect or event handler runs), never during render.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
