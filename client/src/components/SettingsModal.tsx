import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { timeAgo } from "../App";
import { refreshProfiles, setActiveProfile, type Profile } from "../profile";
import type { Status } from "../types";

interface Props {
  profiles: Profile[];
  activeId: number | null;
  status: Status | null;
  onSync: () => void | Promise<void>;
  onClose: () => void;
}

export function SettingsModal({ profiles, activeId, status, onSync, onClose }: Props): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm overflow-y-auto"
      onClick={onClose}
    >
      <div className="min-h-full flex items-start sm:items-center justify-center p-4">
        <div
          className="bg-panel rounded-xl overflow-hidden max-w-lg w-full shadow-2xl ring-1 ring-white/10"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between p-4 border-b border-white/5">
            <h2 className="text-lg font-medium">Settings</h2>
            <button
              onClick={onClose}
              className="rounded p-1 text-mute hover:text-ink hover:bg-white/5"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div className="p-4 space-y-6">
            <CatalogSection status={status} onSync={onSync} />
            <ProfilesSection profiles={profiles} activeId={activeId} />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ProfilesSection({
  profiles,
  activeId,
}: {
  profiles: Profile[];
  activeId: number | null;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When the user is mid-flow adding their first additional profile, we hold
  // the input here so we can also surface the "rename your existing profile"
  // prompt on the same screen.
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  // Tracks the rename input for the existing-default-profile prompt that
  // appears on the *first* time a second profile is being added.
  const isFirstSecondProfile = profiles.length === 1;
  const onlyExisting = profiles[0];
  const [renameExistingTo, setRenameExistingTo] = useState(
    isFirstSecondProfile && onlyExisting ? onlyExisting.name : "",
  );

  const reset = (): void => {
    setAdding(false);
    setNewName("");
    setError(null);
  };

  const submitAdd = async (): Promise<void> => {
    const name = newName.trim();
    if (!name) {
      setError("Profile name can't be empty.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // If we're adding the second profile, optionally rename the existing
      // one first so 'Default' isn't a confusing label going forward.
      if (
        isFirstSecondProfile &&
        onlyExisting &&
        renameExistingTo.trim() &&
        renameExistingTo.trim() !== onlyExisting.name
      ) {
        await api.profiles.rename(onlyExisting.id, renameExistingTo.trim());
      }
      await api.profiles.create(name);
      await refreshProfiles();
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="text-xs uppercase tracking-wider text-mute mb-3">Profiles</div>
      <div className="flex flex-col gap-1.5">
        {profiles.map((p) => (
          <ProfileRow
            key={p.id}
            profile={p}
            active={p.id === activeId}
            canDelete={profiles.length > 1}
            otherProfile={profiles.find((q) => q.id !== p.id)}
          />
        ))}
      </div>

      {!adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-3 rounded-lg ring-1 ring-white/10 hover:ring-accent px-3 py-2 text-sm text-ink w-full"
        >
          + Add profile
        </button>
      )}

      {adding && (
        <div className="mt-3 space-y-3 rounded-lg bg-panel2 p-3 ring-1 ring-white/5">
          {isFirstSecondProfile && onlyExisting && (
            <label className="block text-xs">
              <span className="text-mute">
                Rename your existing profile (currently "{onlyExisting.name}")
              </span>
              <input
                type="text"
                value={renameExistingTo}
                onChange={(e) => setRenameExistingTo(e.target.value)}
                placeholder={onlyExisting.name}
                className="mt-1 w-full bg-bg rounded px-2 py-1.5 ring-1 ring-white/10 outline-none focus:ring-accent text-ink text-sm"
                disabled={busy}
              />
            </label>
          )}
          <label className="block text-xs">
            <span className="text-mute">New profile name</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
              className="mt-1 w-full bg-bg rounded px-2 py-1.5 ring-1 ring-white/10 outline-none focus:ring-accent text-ink text-sm"
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitAdd();
              }}
            />
          </label>
          {error && <div className="text-xs text-red-400">{error}</div>}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              className="rounded px-3 py-1.5 text-sm text-mute hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submitAdd()}
              disabled={busy || !newName.trim()}
              className="rounded px-3 py-1.5 text-sm bg-accent text-bg hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Adding…" : "Add profile"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ProfileRow({
  profile,
  active,
  canDelete,
  otherProfile,
}: {
  profile: Profile;
  active: boolean;
  canDelete: boolean;
  otherProfile: Profile | undefined;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitRename = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === profile.name) {
      setEditing(false);
      setName(profile.name);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.profiles.rename(profile.id, trimmed);
      await refreshProfiles();
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (): Promise<void> => {
    if (!confirm(`Delete profile "${profile.name}"? Its watchlist and seen list will be lost.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.profiles.remove(profile.id);
      // If we just deleted the currently active profile, switch to another
      // and reload so the rest of the app picks up the new context.
      if (active && otherProfile) {
        setActiveProfile(otherProfile.id);
        return;
      }
      await refreshProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className={`flex items-center gap-2 rounded-lg px-3 py-2 ring-1 ${
        active ? "bg-accent/10 ring-accent/40" : "bg-panel2 ring-white/5"
      }`}
    >
      {editing ? (
        <>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            className="flex-1 min-w-0 bg-bg rounded px-2 py-1 ring-1 ring-white/10 outline-none focus:ring-accent text-ink text-sm"
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitRename();
              if (e.key === "Escape") {
                setEditing(false);
                setName(profile.name);
              }
            }}
          />
          <button
            onClick={() => void submitRename()}
            disabled={busy}
            className="text-xs px-2 py-1 rounded bg-accent text-bg disabled:opacity-50"
          >
            Save
          </button>
        </>
      ) : (
        <>
          <input
            type="radio"
            name="active-profile"
            checked={active}
            onChange={() => {
              if (!active) setActiveProfile(profile.id);
            }}
            className="accent-accent shrink-0"
            aria-label={`Use profile ${profile.name}`}
          />
          <span className="flex-1 min-w-0 truncate text-sm text-ink">{profile.name}</span>
          <button
            onClick={() => setEditing(true)}
            className="text-xs text-mute hover:text-ink"
          >
            Rename
          </button>
          {canDelete && (
            <button
              onClick={() => void onDelete()}
              disabled={busy}
              className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
            >
              Delete
            </button>
          )}
        </>
      )}
      {error && <div className="text-xs text-red-400">{error}</div>}
    </div>
  );
}

function CatalogSection({
  status,
  onSync,
}: {
  status: Status | null;
  onSync: () => void | Promise<void>;
}): JSX.Element {
  const syncing = !!status?.syncing;
  return (
    <section>
      <div className="text-xs uppercase tracking-wider text-mute mb-3">Catalog</div>
      <div className="rounded-lg bg-panel2 ring-1 ring-white/5 p-3 flex items-center gap-3">
        <div className="flex-1 min-w-0 text-sm">
          {status ? (
            <>
              <div className="text-ink">{status.titleCount.toLocaleString()} titles</div>
              <div className="text-xs text-mute">
                {status.lastSyncAt ? `Last synced ${timeAgo(status.lastSyncAt)}` : "Never synced"}
              </div>
            </>
          ) : (
            <div className="text-mute">Loading…</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void onSync()}
          disabled={syncing}
          className="rounded-lg ring-1 ring-white/10 hover:ring-accent px-3 py-2 text-sm text-ink disabled:opacity-50"
        >
          {syncing ? "Syncing…" : "Force sync"}
        </button>
      </div>
    </section>
  );
}
