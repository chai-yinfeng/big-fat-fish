/** Mood dynamics: event deltas, half-life decay, human-readable view. */

import { MOOD_EMOTIONS } from "./state.js";
import { clamp, decayFactor, HOUR_MS } from "./util.js";

export const MOOD_BASELINE = { valence: 70, energy: 60 };
export const VALENCE_HALF_LIFE_MS = 3 * HOUR_MS;
export const ENERGY_HALF_LIFE_MS = 4 * HOUR_MS;
export const EMOTION_HALF_LIFE_MS = 1.5 * HOUR_MS;

const EVENT_DELTAS = {
  praise: { valence: 6, energy: 3, emotions: { joy: 8, calm: 2 } },
  affection: { valence: 5, energy: 2, emotions: { affection: 8, joy: 4 } },
  criticism: { valence: -4, energy: -2, emotions: { sadness: 5, worry: 3 } },
  conflict: { valence: -8, energy: -5, emotions: { sadness: 6, worry: 6 } },
  repair: { valence: 5, energy: 1, emotions: { calm: 5, worry: -4 } },
  absence: { valence: -2, energy: 0, emotions: { missing: 6, worry: 3 } },
  reunion: { valence: 5, energy: 3, emotions: { joy: 8, affection: 6, missing: -6 } },
  share: { valence: 3, energy: 1, emotions: { joy: 3, calm: 2 } },
  ignore: { valence: -3, energy: -1, emotions: { sadness: 4, worry: 2 } },
};

export function decayMood(mood, now) {
  const elapsed = Math.max(0, now - (mood.at ?? now));
  const valence = MOOD_BASELINE.valence
    + (mood.valence - MOOD_BASELINE.valence) * decayFactor(elapsed, VALENCE_HALF_LIFE_MS);
  const energy = MOOD_BASELINE.energy
    + (mood.energy - MOOD_BASELINE.energy) * decayFactor(elapsed, ENERGY_HALF_LIFE_MS);
  const emotions = {};
  for (const name of MOOD_EMOTIONS) {
    emotions[name] = clamp((mood.emotions?.[name] ?? 0) * decayFactor(elapsed, EMOTION_HALF_LIFE_MS));
  }
  return { ...mood, valence, energy, emotions, at: now };
}

export function applyMoodEvent(mood, type, now, customDeltas = undefined) {
  const base = decayMood(mood, now);
  const delta = customDeltas ?? EVENT_DELTAS[type];
  if (!delta) throw new Error(`unknown mood event: ${type}`);
  const emotions = { ...base.emotions };
  for (const [name, value] of Object.entries(delta.emotions ?? {})) {
    if (!MOOD_EMOTIONS.includes(name)) throw new Error(`unknown emotion: ${name}`);
    emotions[name] = clamp((emotions[name] ?? 0) + value);
  }
  return {
    valence: clamp(base.valence + (delta.valence ?? 0)),
    energy: clamp(base.energy + (delta.energy ?? 0)),
    emotions,
    at: now,
    lastEvent: type,
  };
}

export function moodLabel(valence) {
  if (valence >= 80) return "欢喜";
  if (valence >= 62) return "开心";
  if (valence >= 42) return "一般";
  if (valence >= 25) return "心疼";
  return "难过";
}

export function dominantEmotion(mood) {
  let name = "calm";
  let value = 0;
  for (const emotion of MOOD_EMOTIONS) {
    const current = mood.emotions?.[emotion] ?? 0;
    if (current > value) {
      name = emotion;
      value = current;
    }
  }
  return { name, value };
}

export function describeMood(mood, now) {
  const view = decayMood(mood, now);
  const dominant = dominantEmotion(view);
  return {
    ...view,
    label: moodLabel(view.valence),
    dominant,
    text: `心情${moodLabel(view.valence)}（${Math.round(view.valence)}/100），`
      + `精力${Math.round(view.energy)}/100，主导情绪：${dominant.name}`,
  };
}

/** Proactive modifier in [0.6, 1.0]. */
export function moodFactor(mood, now) {
  const view = decayMood(mood, now);
  const average = (view.valence + view.energy) / 2;
  return clamp(0.6 + (average / 100) * 0.4, 0.6, 1);
}
