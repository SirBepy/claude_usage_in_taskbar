/**
 * Sound-pack UI helpers. Authoritative catalog lives in Rust (soundpacks::catalog);
 * fetched lazily and cached. Ported from src/modules/sound-packs.js.
 */

export interface SoundEntry {
  id: string;
  label: string;
  [k: string]: unknown;
}

export interface SoundPack {
  id: string;
  label: string;
  installed: boolean;
  sounds: SoundEntry[];
  [k: string]: unknown;
}

interface ElectronAPIShape {
  listSoundPacks(): Promise<SoundPack[]>;
  installSoundPack(id: string): Promise<unknown>;
  playPackSoundPreview(packId: string, soundId: string): Promise<unknown>;
}

function api(): ElectronAPIShape | null {
  return (window as unknown as { electronAPI?: ElectronAPIShape }).electronAPI ?? null;
}

let packCache: SoundPack[] | null = null;

export async function loadPacks(): Promise<SoundPack[]> {
  if (packCache) return packCache;
  const a = api();
  if (!a) { packCache = []; return packCache; }
  try {
    packCache = await a.listSoundPacks();
  } catch (e) {
    console.error("[sound-packs] list failed", e);
    packCache = [];
  }
  return packCache;
}

export function invalidateCache(): void {
  packCache = null;
}

export function findPack(packs: SoundPack[], id: string): SoundPack | null {
  return packs.find((p) => p.id === id) || null;
}

export function findSound(pack: SoundPack | null, soundId: string): SoundEntry | null {
  return pack?.sounds.find((s) => s.id === soundId) || null;
}

export function populatePackSelect(
  selectEl: HTMLSelectElement,
  packs: SoundPack[],
  currentPackId: string,
): void {
  selectEl.innerHTML = packs.map((p) => {
    const label = p.installed ? p.label : `${p.label} (not installed)`;
    const sel = p.id === currentPackId ? " selected" : "";
    return `<option value="${p.id}"${sel}>${label}</option>`;
  }).join("");
}

export function populateSoundSelect(
  selectEl: HTMLSelectElement,
  pack: SoundPack | null,
  currentSoundId: string | undefined,
): void {
  if (!pack || !pack.sounds) { selectEl.innerHTML = ""; return; }
  selectEl.innerHTML = pack.sounds.map((s) => {
    const sel = s.id === currentSoundId ? " selected" : "";
    return `<option value="${s.id}"${sel}>${s.label}</option>`;
  }).join("");
}

export async function installPack(packId: string): Promise<SoundPack[]> {
  const a = api();
  if (!a) return loadPacks();
  await a.installSoundPack(packId);
  invalidateCache();
  return loadPacks();
}

// Legacy shim: expose on window for any remaining callers in dashboard.js.
(window as unknown as { SoundPacks?: unknown }).SoundPacks = {
  loadPacks,
  invalidateCache,
  findPack,
  findSound,
  populatePackSelect,
  populateSoundSelect,
  installPack,
};
