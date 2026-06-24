import { useCallback, useEffect, useRef, useState } from "react";
import { contextApi } from "./api";
import {
  type ContextChangeKind,
  type LinkedQueryGroup,
  type ObjectDoc,
  type ObjectListItem,
  type QueryDoc,
  type QueryListItem,
} from "./types";
import { useContextChangeListener, useContextEventBus } from "./eventBus";

interface AsyncState<T> {
  data: T;
  loading: boolean;
  error: Error | null;
}

function initial<T>(empty: T): AsyncState<T> {
  return { data: empty, loading: false, error: null };
}

function useAsync<T>(
  empty: T,
  fetcher: () => Promise<T>,
  enabled: boolean,
): { state: AsyncState<T>; refresh: () => void } {
  const [state, setState] = useState<AsyncState<T>>(() => initial(empty));

  const refresh = useCallback(() => {
    if (!enabled) {
      setState(initial(empty));
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    fetcher()
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((e: Error) => setState({ data: empty, loading: false, error: e }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fetcher]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { state, refresh };
}

const KINDS_OBJECTS: ContextChangeKind[] = ["object", "manifest"];
const KINDS_QUERIES: ContextChangeKind[] = ["query", "manifest"];

export function useContextObjects(
  connectionId: string,
  contextPath: string | null | undefined,
): AsyncState<ObjectListItem[]> & { refresh: () => void } {
  const fetcher = useCallback(() => contextApi.listObjects(connectionId), [connectionId]);
  const { state, refresh } = useAsync<ObjectListItem[]>([], fetcher, !!contextPath);
  useContextChangeListener(contextPath, KINDS_OBJECTS, refresh);
  return { ...state, refresh };
}

export function useContextQueries(
  connectionId: string,
  contextPath: string | null | undefined,
): AsyncState<QueryListItem[]> & { refresh: () => void } {
  const fetcher = useCallback(() => contextApi.listQueries(connectionId), [connectionId]);
  const { state, refresh } = useAsync<QueryListItem[]>([], fetcher, !!contextPath);
  useContextChangeListener(contextPath, KINDS_QUERIES, refresh);
  return { ...state, refresh };
}

export function useContextObject(
  connectionId: string,
  identity: string | null | undefined,
  contextPath: string | null | undefined,
): AsyncState<ObjectDoc | null> & { refresh: () => void } {
  const fetcher = useCallback(
    () =>
      identity ? contextApi.getObject(connectionId, identity) : Promise.resolve(null),
    [connectionId, identity],
  );
  const { state, refresh } = useAsync<ObjectDoc | null>(
    null,
    fetcher,
    !!contextPath && !!identity,
  );
  useContextChangeListener(contextPath, KINDS_OBJECTS, refresh);
  return { ...state, refresh };
}

export function useContextQuery(
  connectionId: string,
  name: string | null | undefined,
  contextPath: string | null | undefined,
): AsyncState<QueryDoc | null> & { refresh: () => void } {
  const fetcher = useCallback(
    () => (name ? contextApi.getQuery(connectionId, name) : Promise.resolve(null)),
    [connectionId, name],
  );
  const { state, refresh } = useAsync<QueryDoc | null>(
    null,
    fetcher,
    !!contextPath && !!name,
  );
  useContextChangeListener(contextPath, KINDS_QUERIES, refresh);
  return { ...state, refresh };
}

/**
 * Subscribe to ALL context://changed events regardless of path,
 * filtered optionally by kind. Fires the callback whenever any context folder
 * emits a change matching the given kinds.
 */
export function useAnyContextChangeListener(
  kinds: ContextChangeKind[] | "all",
  listener: () => void,
): void {
  const bus = useContextEventBus();
  const ref = useRef(listener);
  useEffect(() => {
    ref.current = listener;
  }, [listener]);

  const kindsKey = kinds === "all" ? "all" : kinds.slice().sort().join(",");

  useEffect(() => {
    return bus.subscribeAll((event) => {
      if (kinds !== "all") {
        const intersects = event.kinds.some((k) => (kinds as ContextChangeKind[]).includes(k));
        if (!intersects) return;
      }
      ref.current();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus, kindsKey]);
}

const KINDS_LINKED_QUERIES: ContextChangeKind[] = ["query", "manifest"];

/**
 * Fetches all linked context queries across all connections and refreshes
 * whenever any context folder emits a query or manifest change.
 */
export function useLinkedContextQueries(): AsyncState<LinkedQueryGroup[]> & { refresh: () => void } {
  const fetcher = useCallback(() => contextApi.listLinkedQueries(), []);
  const { state, refresh } = useAsync<LinkedQueryGroup[]>([], fetcher, true);
  useAnyContextChangeListener(KINDS_LINKED_QUERIES, refresh);
  return { ...state, refresh };
}
