import { isWindowActive, onWindowActiveChange } from './windowActive';

type Callback = (now: number) => void;
const clocks = new Set<Callback>();
const views = new Set<Callback>();
const interval = 1000 / 60;
let animation = 0;
let nextFrameAt = 0;
let unlisten: (() => void) | undefined;

function schedule() {
  if (!animation && isWindowActive() && (clocks.size || views.size))
    animation = requestAnimationFrame(frame);
}

function frame(now: number) {
  animation = 0;
  if (!isWindowActive()) return;
  if (now + 0.5 >= nextFrameAt) {
    nextFrameAt +=
      (Math.floor((now + 0.5 - nextFrameAt) / interval) + 1) * interval;
    // Advance demo time before either radar, scrubber or killfeed reads it.
    // One rAF also keeps React updates queued until all views have drawn.
    for (const callback of clocks) callback(now);
    for (const callback of views) callback(now);
  }
  schedule();
}

export function onReplayAnimationFrame(
  callback: Callback,
  phase: 'clock' | 'view' = 'view',
): () => void {
  const callbacks = phase === 'clock' ? clocks : views;
  callbacks.add(callback);
  if (!unlisten) {
    unlisten = onWindowActiveChange((active) => {
      cancelAnimationFrame(animation);
      animation = 0;
      nextFrameAt = 0;
      if (active) schedule();
    });
  }
  schedule();
  return () => {
    callbacks.delete(callback);
    if (!clocks.size && !views.size) {
      cancelAnimationFrame(animation);
      animation = 0;
      nextFrameAt = 0;
      unlisten?.();
      unlisten = undefined;
    }
  };
}
