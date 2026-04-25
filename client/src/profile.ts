import { useEffect, useState } from "react";
import { api, type ProfileDto } from "./api";

const PROFILE_STORAGE_KEY = "whatson.profileId.v1";

export type Profile = ProfileDto;

interface ProfileState {
  profiles: Profile[];
  activeId: number | null;
  /** True until the initial /api/profiles fetch has resolved. */
  loading: boolean;
  /**
   * True when there are multiple profiles AND no active one stored — the app
   * should render the picker until the user chooses.
   */
  needsPick: boolean;
}

const listeners = new Set<(state: ProfileState) => void>();

function readStoredId(): number | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function writeStoredId(id: number | null): void {
  if (typeof localStorage === "undefined") return;
  if (id === null) localStorage.removeItem(PROFILE_STORAGE_KEY);
  else localStorage.setItem(PROFILE_STORAGE_KEY, String(id));
}

let current: ProfileState = {
  profiles: [],
  activeId: readStoredId(),
  loading: true,
  needsPick: false,
};

function notify(): void {
  listeners.forEach((l) => l(current));
}

function reconcile(profiles: Profile[]): void {
  const stored = readStoredId();
  const knownIds = new Set(profiles.map((p) => p.id));
  let activeId: number | null = null;
  let needsPick = false;
  if (stored !== null && knownIds.has(stored)) {
    activeId = stored;
  } else if (profiles.length === 1 && profiles[0]) {
    // Single profile (the seeded default): silently use it.
    activeId = profiles[0].id;
    writeStoredId(activeId);
  } else if (profiles.length > 1) {
    // Multiple profiles + nothing valid stored → user has to pick.
    activeId = null;
    needsPick = true;
    if (stored !== null) writeStoredId(null);
  }
  current = { profiles, activeId, loading: false, needsPick };
  notify();
}

async function loadFromServer(): Promise<void> {
  try {
    const profiles = await api.profiles.list();
    reconcile(profiles);
  } catch (err) {
    console.error("profile load failed:", err);
    current = { profiles: [], activeId: null, loading: false, needsPick: false };
    notify();
  }
}

if (typeof window !== "undefined") {
  void loadFromServer();
}

export async function refreshProfiles(): Promise<void> {
  await loadFromServer();
}

/**
 * Persist the active profile and reload the page. Reload is the simplest way
 * to ensure every cache (marks, grid, modals) starts fresh against the new
 * profile — the alternative would be threading active-profile context through
 * every state hook, which is a lot of code for a rare action.
 */
export function setActiveProfile(id: number): void {
  writeStoredId(id);
  if (typeof window !== "undefined") window.location.reload();
}

export function useProfileState(): ProfileState {
  const [state, setState] = useState<ProfileState>(current);
  useEffect(() => {
    const onChange = (next: ProfileState): void => setState(next);
    listeners.add(onChange);
    onChange(current);
    return () => {
      listeners.delete(onChange);
    };
  }, []);
  return state;
}
