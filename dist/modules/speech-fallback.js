"use strict";

(function () {
  const api = window.__TAURI__;
  if (!api?.event?.listen) return;

  function speak(text, voiceName) {
    if (!text || !window.speechSynthesis) return;
    const utter = new SpeechSynthesisUtterance(text);
    if (voiceName) {
      const v = speechSynthesis.getVoices().find(x => x.name === voiceName);
      if (v) utter.voice = v;
    }
    speechSynthesis.speak(utter);
  }

  api.event.listen("speak-fallback", (event) => {
    const { text, voiceName } = event.payload || {};
    speak(text, voiceName);
  });
})();
