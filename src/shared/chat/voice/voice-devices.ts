// Mic input-device enumeration + persisted selection (webview MediaDevices).
// Output devices are picked natively (rodio, Rust side); input capture happens
// in the webview, so mic selection lives here.

const MIC_KEY = "voice_mic_device";

export interface MicDevice {
  deviceId: string;
  label: string;
}

/** All audio-input devices. Labels are blank until mic permission has been
 *  granted once, so we fall back to "Microphone N". */
export async function listMics(): Promise<MicDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === "audioinput")
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch {
    return [];
  }
}

export function getSelectedMic(): string | null {
  try {
    return localStorage.getItem(MIC_KEY) || null;
  } catch {
    return null;
  }
}

export function setSelectedMic(deviceId: string | null): void {
  try {
    if (deviceId) localStorage.setItem(MIC_KEY, deviceId);
    else localStorage.removeItem(MIC_KEY);
  } catch {
    /* storage unavailable */
  }
}
