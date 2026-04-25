import { createPortal } from "react-dom";
import type { Profile } from "../profile";

interface Props {
  profiles: Profile[];
  onPick: (id: number) => void;
}

/**
 * Fullscreen sheet shown only when multiple profiles exist and the browser
 * has no valid stored selection yet. Picking a profile reloads the page into
 * that profile's context (see profile.ts/setActiveProfile).
 */
export function ProfilePicker({ profiles, onPick }: Props): JSX.Element {
  return createPortal(
    <div className="fixed inset-0 z-50 bg-bg flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h2 className="text-2xl font-semibold mb-1 text-center">Who's watching?</h2>
        <p className="text-sm text-mute mb-6 text-center">Pick a profile to continue.</p>
        <div className="flex flex-col gap-2">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p.id)}
              className="rounded-lg bg-panel ring-1 ring-white/10 hover:ring-accent px-4 py-3 text-left text-ink transition-colors"
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
