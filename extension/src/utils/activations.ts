// 0次球面調和関数の係数 C0 = 0.5 * sqrt(1/π)
const SH_C0 = 0.28209479177387814;

/** logit → [0, 1] */
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** SH DC 係数 → RGB [0, 1] */
export function shDcToRgb(dc: number): number {
  return Math.max(0, Math.min(1, 0.5 + SH_C0 * dc));
}

/** log-scale → positive scale */
export function expScale(x: number): number {
  return Math.exp(x);
}

/** quaternion を正規化 (in-place で [w, x, y, z] を返す) */
export function normalizeQuat(w: number, x: number, y: number, z: number): [number, number, number, number] {
  const len = Math.sqrt(w * w + x * x + y * y + z * z);
  if (len < 1e-10) {
    return [1, 0, 0, 0];
  }
  const inv = 1 / len;
  return [w * inv, x * inv, y * inv, z * inv];
}
