/** Where the viewer stopped in each video, kept in this browser only. */

export interface Spot {
  readonly time: number;
  readonly duration: number;
  readonly at: number;
}

const KEY = 'gcast-progress';

const read = (): Record<string, Spot> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Spot>;
  } catch {
    return {};
  }
};

export const spots = (): Record<string, Spot> => read();

/** The place to continue from, or 0 when the video was barely started or nearly finished. */
export const resumeAt = (id: string): number => {
  const spot = read()[id];
  if (!spot || spot.time < 10 || spot.time > spot.duration - 15) return 0;
  return spot.time;
};

let lastSave = 0;
export const remember = (id: string, time: number, duration: number): void => {
  if (!(duration > 0) || Date.now() - lastSave < 4000) return;
  lastSave = Date.now();
  try {
    const all = read();
    all[id] = { time, duration, at: Date.now() };
    // ponytail: the 200 most recent videos are kept
    const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // private mode: nothing is remembered
  }
};

export const forget = (id: string): void => {
  try {
    const all = read();
    delete all[id];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {}
};
