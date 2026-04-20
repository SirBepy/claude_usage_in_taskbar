"use strict";

// Sound pack UI helpers. Authoritative catalog lives in Rust (soundpacks::catalog).
// Fetched lazily and cached. Exposes window.SoundPacks namespace.

(function () {
  let packCache = null;

  async function loadPacks() {
    if (packCache) return packCache;
    try {
      packCache = await window.electronAPI.listSoundPacks();
    } catch (e) {
      console.error("[sound-packs] list failed", e);
      packCache = [];
    }
    return packCache;
  }

  function invalidateCache() { packCache = null; }

  function findPack(packs, id) {
    return packs.find(p => p.id === id) || null;
  }

  function findSound(pack, soundId) {
    return pack?.sounds.find(s => s.id === soundId) || null;
  }

  function populatePackSelect(selectEl, packs, currentPackId) {
    selectEl.innerHTML = packs.map(p => {
      const label = p.installed ? p.label : `${p.label} (not installed)`;
      const sel = p.id === currentPackId ? " selected" : "";
      return `<option value="${p.id}"${sel}>${label}</option>`;
    }).join("");
  }

  function populateSoundSelect(selectEl, pack, currentSoundId) {
    if (!pack || !pack.sounds) { selectEl.innerHTML = ""; return; }
    selectEl.innerHTML = pack.sounds.map(s => {
      const sel = s.id === currentSoundId ? " selected" : "";
      return `<option value="${s.id}"${sel}>${s.label}</option>`;
    }).join("");
  }

  async function installPack(packId) {
    await window.electronAPI.installSoundPack(packId);
    invalidateCache();
    return loadPacks();
  }

  window.SoundPacks = {
    loadPacks,
    invalidateCache,
    findPack,
    findSound,
    populatePackSelect,
    populateSoundSelect,
    installPack,
  };
})();
