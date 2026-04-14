"use strict";

const { ipcRenderer } = require("electron");

function done() {
  try { ipcRenderer.send("sound-finished"); } catch {}
}

ipcRenderer.on("play-sound", (_, filePath) => {
  try {
    const audio = new Audio(filePath);
    let finished = false;
    const finishOnce = () => { if (finished) return; finished = true; done(); };
    audio.addEventListener("ended", finishOnce);
    audio.addEventListener("error", finishOnce);
    audio.play().catch(finishOnce);
  } catch {
    done();
  }
});

ipcRenderer.on("speak-text", (_, payload) => {
  try {
    const { text, voiceName } = typeof payload === "string" ? { text: payload, voiceName: null } : payload;
    if (!text) { done(); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    if (voiceName) {
      const voices = speechSynthesis.getVoices();
      const voice = voices.find(v => v.name === voiceName);
      if (voice) utterance.voice = voice;
    }
    let finished = false;
    const finishOnce = () => { if (finished) return; finished = true; done(); };
    utterance.onend = finishOnce;
    utterance.onerror = finishOnce;
    speechSynthesis.speak(utterance);
  } catch {
    done();
  }
});
