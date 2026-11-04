/** Proactive policy: hard constraints, probability, opener intent. */

import { describeMood, moodFactor } from "./mood.js";
import { clamp, HOUR_MS, inQuietHours, isPeak } from "./util.js";

const PRESENCE_FACTORS = { active: 0.2, away: 1.2, unknown: 1 };

function latestInteraction(state) {
  const { interaction, meta } = state;
  const known = [
    interaction.lastUserAt,
    interaction.lastAssistantAt,
    interaction.lastSpokeAt,
    interaction.lastProactiveAt,
  ].filter((value) => Number.isFinite(value));
  return known.length > 0 ? Math.max(...known) : (meta.createdAt ?? 0);
}

function timeFactor(state, now, policy) {
  const elapsedMinutes = Math.max(0, now - latestInteraction(state)) / 60_000;
  if (elapsedMinutes < policy.recentMinutes) return 0.15;
  if (elapsedMinutes > policy.awayMinutes) return 1.5;
  return 1;
}

function dailyCount(state, day) {
  return state.interaction.proactiveDay === day ? state.interaction.proactiveCount ?? 0 : 0;
}

/**
 * Decide whether the companion may speak now.
 * `rng` is injected so tests are deterministic.
 */
export function shouldSpeak({ state, now, parts, presence = "unknown", rng }) {
  const policy = state.policy;
  const factors = {
    base: 0,
    time: 1,
    presence: PRESENCE_FACTORS[presence] ?? 1,
    mood: moodFactor(state.mood, now),
    unresponded: Math.pow(0.5, state.interaction.unrespondedProactive ?? 0),
  };

  if (policy.pausedUntil && now < policy.pausedUntil) {
    return { speak: false, probability: 0, factors, reason: "paused" };
  }
  if (inQuietHours(parts.hour, policy.quietHours)) {
    return { speak: false, probability: 0, factors, reason: "quiet-hours" };
  }
  if (state.interaction.lastProactiveAt !== null
    && now < state.interaction.lastProactiveAt + policy.cooldownMinutes * 60_000) {
    return { speak: false, probability: 0, factors, reason: "cooldown" };
  }
  if ((state.interaction.unrespondedProactive ?? 0) >= (policy.maxUnanswered ?? 1)) {
    return { speak: false, probability: 0, factors, reason: "awaiting-reply" };
  }
  if (dailyCount(state, parts.date) >= policy.dailyCap) {
    return { speak: false, probability: 0, factors, reason: "daily-cap" };
  }

  factors.base = isPeak(parts, policy.peakWindows) ? policy.peakProbability : policy.offPeakProbability;
  factors.time = timeFactor(state, now, policy);
  const probability = clamp(
    factors.base * factors.time * factors.presence * factors.mood * factors.unresponded,
    0,
    1,
  );
  const roll = rng.next();
  const speak = roll < probability;
  return {
    speak,
    probability: Number(probability.toFixed(4)),
    roll: Number(roll.toFixed(4)),
    factors,
    reason: speak ? "speak" : "probability",
  };
}

const SEEDS = {
  missing: "好久没听到你的声音了，想问问你今天过得怎么样。",
  care: "感觉你最近可能有点累，想陪你说会儿话。",
  share: "今天想到一件小事，想跟你分享一下。",
  "check-in": "在忙吗？突然想跟你说句话。",
};

/** Intent + seed text; the model writes the final words. */
export function composeOpener({ state, now, presence = "unknown" }) {
  const mood = describeMood(state.mood, now);
  const elapsedHours = Math.max(0, now - latestInteraction(state)) / HOUR_MS;
  let intent = "check-in";
  if (elapsedHours > 6) intent = "missing";
  else if (mood.valence < 45) intent = "care";
  else if (mood.valence > 75) intent = "share";
  return {
    at: now,
    intent,
    seed: SEEDS[intent],
    tone: `${mood.label}/${mood.dominant.name}`,
    channel: presence === "away" ? "im" : "desktop",
    mood: { valence: Math.round(mood.valence), energy: Math.round(mood.energy) },
  };
}
