let context: AudioContext | undefined;

function getContext(): AudioContext | undefined {
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') {
    return undefined;
  }
  context ??= new window.AudioContext();
  return context;
}

/** Call from a user gesture so later, event-driven sounds are allowed to play. */
export function unlockAudio(): void {
  const audio = getContext();
  if (audio?.state === 'suspended') {
    audio.resume().catch(() => undefined);
  }
}

/** A short rising square-wave arpeggio, the classic "item get" jingle. */
export function playLootSound(): void {
  const audio = getContext();
  if (!audio) {
    return;
  }
  try {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    const step = 0.09;
    const start = audio.currentTime + 0.02;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.08, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + step * notes.length + 0.25);
    gain.connect(audio.destination);
    const oscillator = audio.createOscillator();
    oscillator.type = 'square';
    notes.forEach((frequency, index) => {
      oscillator.frequency.setValueAtTime(frequency, start + step * index);
    });
    oscillator.connect(gain);
    oscillator.start(start);
    oscillator.stop(start + step * notes.length + 0.3);
  } catch {
    // Audio is a nicety; a blocked or broken audio context must never break the app.
  }
}
