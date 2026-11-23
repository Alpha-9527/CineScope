export const RUBRIC_VERSION = 'q-2026.1';

export const WEIGHTS = {
  audience: 0.35,
  artistic: 0.4,
  recommendation: 0.25,
};

export function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 编辑部综合评分。
 * Q = 0.35R + 0.40A + 0.25D
 * S = Q × C
 * 缺失维度时，对已有维度的权重重新归一化，而不是按 0 计算。
 */
export function computeScore({
  audience,
  artistic,
  recommendation,
  confidence,
}) {
  const dims = [
    ['audience', audience],
    ['artistic', artistic],
    ['recommendation', recommendation],
  ].filter(([, value]) => Number.isFinite(value));

  if (dims.length === 0) {
    throw new Error('至少需要一个评分维度');
  }

  const weightTotal = dims.reduce((sum, [key]) => sum + WEIGHTS[key], 0);
  const quality = dims.reduce(
    (sum, [key, value]) => sum + clamp(value) * (WEIGHTS[key] / weightTotal),
    0,
  );

  const c = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6;
  const final = quality * c;

  return {
    quality: round(quality),
    final: round(final),
    confidence: round(c, 2),
    normalizedWeights: Object.fromEntries(
      dims.map(([key]) => [key, round(WEIGHTS[key] / weightTotal, 3)]),
    ),
  };
}

export function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 自动选片规则：先看最终分，再看可信度。
 * 低可信度的高分不会被直接采纳，避免"资料不足但语气笃定"。
 */
export function decideStatus({ final, confidence }, thresholds = { select: 66, review: 56 }) {
  if (final >= thresholds.select && confidence >= 0.68) return 'selected';
  if (final >= thresholds.review) return 'candidate';
  return 'rejected';
}

export function summarizeScores(assessment) {
  const { audience_score: r, artistic_score: a, recommendation_score: d, confidence: c, final_score: s } =
    assessment;
  return `R${r} / A${a} / D${d} · C${Math.round(c * 100)}% → ${s}`;
}
