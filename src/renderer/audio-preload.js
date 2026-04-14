"use strict";

const { ipcRenderer } = require("electron");

ipcRenderer.on("play-sound", (_, filePath) => {
  const audio = new Audio(filePath);
  audio.play().catch(() => {});
});

ipcRenderer.on("speak-text", (_, payload) => {
  const { text, voiceName } = typeof payload === "string" ? { text: payload, voiceName: null } : payload;
  if (!text) return;
  const utterance = new SpeechSynthesisUtterance(text);
  if (voiceName) {
    const voices = speechSynthesis.getVoices();
    const voice = voices.find(v => v.name === voiceName);
    if (voice) utterance.voice = voice;
  }
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
});
