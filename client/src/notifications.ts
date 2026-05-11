import { useEffect, useState, useCallback } from "react";
import { api } from "./api";
import type { NotificationEntry } from "./types";

const listeners = new Set<(items: NotificationEntry[]) => void>();
let current: NotificationEntry[] = [];

function notify(): void {
  listeners.forEach((l) => l(current));
}

async function loadFromServer(): Promise<void> {
  try {
    const res = await api.notifications.list();
    current = res.items;
  } catch (err) {
    console.error("notifications load failed:", err);
    current = [];
  }
  notify();
}

let loadPromise: Promise<void> | null = null;
if (typeof window !== "undefined") {
  loadPromise = loadFromServer();
}

export function refreshNotifications(): Promise<void> {
  loadPromise = loadFromServer();
  return loadPromise;
}

export function useNotifications(): {
  items: NotificationEntry[];
  unreadCount: number;
  markRead: (id: number) => Promise<void>;
  markAllRead: () => Promise<void>;
  dismiss: (id: number) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [items, setItems] = useState<NotificationEntry[]>(current);

  useEffect(() => {
    const onChange = (next: NotificationEntry[]): void => setItems(next);
    listeners.add(onChange);
    if (loadPromise) void loadPromise.then(() => setItems(current));
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  const markRead = useCallback(async (id: number): Promise<void> => {
    const now = new Date().toISOString();
    current = current.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: now } : n));
    notify();
    try {
      await api.notifications.markRead(id, true);
    } catch (err) {
      console.error("notification markRead failed:", err);
    }
  }, []);

  const markAllRead = useCallback(async (): Promise<void> => {
    const now = new Date().toISOString();
    current = current.map((n) => (n.readAt ? n : { ...n, readAt: now }));
    notify();
    try {
      await api.notifications.markAllRead();
    } catch (err) {
      console.error("notifications markAllRead failed:", err);
    }
  }, []);

  const dismiss = useCallback(async (id: number): Promise<void> => {
    const prev = current;
    current = current.filter((n) => n.id !== id);
    notify();
    try {
      await api.notifications.dismiss(id);
    } catch (err) {
      console.error("notification dismiss failed:", err);
      current = prev;
      notify();
    }
  }, []);

  const unreadCount = items.filter((n) => !n.readAt).length;

  return { items, unreadCount, markRead, markAllRead, dismiss, refresh: refreshNotifications };
}
