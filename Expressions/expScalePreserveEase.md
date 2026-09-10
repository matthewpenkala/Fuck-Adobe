# Hybrid Exponential Scale - Adaptive Preserve Ease

A non-destructive, keyframe-driven Scale expression for Adobe After Effects that remaps the property's native animation into an adaptive exponential interpolation using the **observable native eased progress** of the existing keyframes as its input. Keyframe times remain unchanged. Independent axes reuse their own recovered progress; inferred coupled axes share weighted progress, and overshoot limits and endpoint snapping can adjust that progress or its resulting value. It does not bake animation, add Effect Controls, or require a separate controller layer; the Scale keyframes remain the animation UI.

Here, **hybrid** refers exclusively to the interpolation strategy itself: the expression uses signed geometric interpolation where logarithmic behavior is well-defined and numerically safe, symlog/log-modulus interpolation around zero and across sign changes, and a smooth transition between those regimes near zero.

> **Important meaning of “preserve ease”:** the expression reuses the normalized progress already produced by After Effects' pre-expression value. It inherits its progress signal from the native keyframed animation, subject to the documented axis-grouping, overshoot-limiting, and endpoint-snapping rules. It does **not** claim to read hidden Graph Editor Bezier handles, nor does it preserve identical post-remap velocity or acceleration in Scale-units-per-second.

## What It Does

- Uses only the Scale property's own keyframes and current pre-expression `value`; no sliders, dropdowns, checkboxes, or other Effect Controls are read.
- Targets After Effects' modern JavaScript expression engine, not Legacy ExtendScript.
- Finds the currently active keyframe segment and leaves the native/pre-expression value untouched before the first segment, after the last segment, or when fewer than two keyframes exist.
- Recovers eased progress independently for each meaningfully changing axis from the native value already calculated by After Effects.
- Uses signed geometric interpolation when same-sign endpoints are safely away from zero.
- Uses symlog/log-modulus interpolation when ordinary logarithmic interpolation is unsafe or undefined, including zero, very-near-zero values, and sign changes.
- Smoothly blends symlog and geometric interpolation through a narrow near-zero transition band rather than switching abruptly.
- Uses combined absolute-plus-relative equality tolerances so numerical decisions scale with the magnitude of the keyed values.
- Retains a bounded amount of native normalized-progress overshoot, with less extrapolation allowed as the nonlinear transform span becomes more extreme.
- Detects coupled/proportional axis groups from the keyframe endpoints, including XY, XZ, or YZ pairs in 3D.
- Keeps clearly independent axes independent and does not pull an unchanged default Z axis into an XY zoom.
- Passes through axes whose endpoints are effectively unchanged, preserving native equal-endpoint value-graph excursions rather than dividing by an unstable near-zero endpoint delta.
- Includes last-resort finite-value safeguards for pathological floating-point ranges: overflow-prone progress subtraction is rescaled, and a non-finite nonlinear result falls back to the native pre-expression component instead of emitting `NaN`/`Infinity`.
- Returns the same scalar/vector shape it receives; the intended use is Scale, so normal use is 2D or 3D.

## Compatibility

**Compatibility target: After Effects 16.0+.**

**Host-tested for this release: After Effects 2025, version 25.6.5x3, on Windows.** Earlier supported versions remain compatibility targets; this validation did not execute them.

Use:

`File > Project Settings > Expressions > Expressions Engine` set to **JavaScript**.

Adobe documents the JavaScript expression engine introduced with After Effects 16.0 as being based on ECMAScript 2018. This expression intentionally uses modern JavaScript features such as `const`, `let`, an arrow-function IIFE, `Number.isFinite()`, `Math.log1p()`, and `Math.expm1()`. It does not attempt Legacy ExtendScript compatibility.

The segment lookup deliberately continues to use `nearestKey()` instead of the newer `previousKey()` / `nextKey()` helpers. Those neighboring-key methods were added only in After Effects 26.0; retaining `nearestKey()` preserves the much broader AE 16.0+ compatibility target.

## Expression

Paste only the JavaScript code block below onto **Scale**:

```js
// Hybrid Exponential Scale - Adaptive Preserve Ease
// Modern After Effects JavaScript expression engine (not Legacy ExtendScript).
// Drop on Scale. No sliders, dropdowns, checkboxes, or Effect Controls.
// The keyframes themselves are the only animation UI.

(() => {
  const ABS_TOL = 1e-7;
  const REL_TOL = 1e-6;
  const ZERO_ABS = 1e-3;
  const Z_BAND = Math.max(ABS_TOL * 4, ZERO_ABS);
  const SYMLOG_REL = 5e-2;
  const SNAP_U = 1e-5;
  const TINY = 1e-12;
  const MAX_EXTRA_U = 0.35;
  const GROUP_LOG_TOL = 0.025;
  const GEOM_BLEND_MULT = 64;
  const GEOM_BLEND_HI = Math.max(Z_BAND * GEOM_BLEND_MULT, Z_BAND + ABS_TOL);

  function clamp(x, lo, hi) {
    return Math.min(Math.max(x, lo), hi);
  }

  function hasLength(x) {
    return x !== null && typeof x.length === "number";
  }

  function asVec(x) {
    if (!hasLength(x)) return [x];

    const out = [];
    for (let i = 0; i < x.length; i++) out[i] = x[i];
    return out;
  }

  function fromVec(v, wasVec) {
    return wasVec ? v : v[0];
  }

  function makeVec(n, fillValue) {
    const out = [];
    for (let i = 0; i < n; i++) out[i] = fillValue;
    return out;
  }

  function magRef(a, b) {
    return Math.max(1, Math.abs(a), Math.abs(b));
  }

  function tol1(a, b) {
    return Math.max(ABS_TOL, REL_TOL * magRef(a, b));
  }

  function nearSame(a, b) {
    return Math.abs(a - b) <= tol1(a, b);
  }

  function symlogC(a, b) {
    return Math.max(tol1(a, b), SYMLOG_REL * magRef(a, b));
  }

  function sameNonZeroSign(a, b, z) {
    return (a > z && b > z) || (a < -z && b < -z);
  }

  function crossesOrTouchesZero(a, b) {
    return a === 0 || b === 0 || (a < 0) !== (b < 0);
  }

  function smoothstep(edge0, edge1, x) {
    const u = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return u * u * (3 - 2 * u);
  }

  function geomWeight(a, b) {
    if (!sameNonZeroSign(a, b, Z_BAND)) return 0;
    return smoothstep(Z_BAND, GEOM_BLEND_HI, Math.min(Math.abs(a), Math.abs(b)));
  }

  function symlog(x, c) {
    return Math.sign(x) * Math.log1p(Math.abs(x) / c);
  }

  function symexp(y, c) {
    return Math.sign(y) * c * Math.expm1(Math.abs(y));
  }

  function signedGeom(a, b, u) {
    const ratio = b / a;
    if (ratio > 0 && Number.isFinite(ratio)) return a * Math.pow(ratio, u);

    // Defensive fallback if b / a overflows even though a and b share sign.
    return Math.sign(a) * Math.exp(
      Math.log(Math.abs(a)) +
      u * (Math.log(Math.abs(b)) - Math.log(Math.abs(a)))
    );
  }

  function symlogMix(a, b, u) {
    const c = symlogC(a, b);
    const ya = symlog(a, c);
    const yb = symlog(b, c);
    return symexp(ya + u * (yb - ya), c);
  }

  function mixAdaptive(a, b, u, fallback) {
    const tol = tol1(a, b);
    if (Math.abs(a - b) <= tol) return a;
    if (u === 0) return a;
    if (u === 1) return b;

    const gw = geomWeight(a, b);
    let r;

    if (gw >= 1) {
      r = signedGeom(a, b, u);
    } else if (gw <= 0) {
      r = symlogMix(a, b, u);
    } else {
      const s = symlogMix(a, b, u);
      const g = signedGeom(a, b, u);
      r = s + (g - s) * gw;
    }

    if (!Number.isFinite(r)) {
      return Number.isFinite(fallback) ? fallback : (u < 0.5 ? a : b);
    }

    if (crossesOrTouchesZero(a, b) && Math.abs(r) <= tol) r = 0;
    if (u > 0 && u <= SNAP_U && Math.abs(r - a) <= tol * 4) return a;
    if (u < 1 && u >= 1 - SNAP_U && Math.abs(r - b) <= tol * 4) return b;

    return r;
  }

  function componentU(a, b, cur) {
    const d = b - a;
    const n = cur - a;
    if (Number.isFinite(d) && Number.isFinite(n)) return n / d;

    // Last-resort rescaling avoids overflow in the subtraction itself.
    const m = Math.max(1, Math.abs(a), Math.abs(b), Math.abs(cur));
    return (cur / m - a / m) / (b / m - a / m);
  }

  function transformRisk(a, b) {
    if (nearSame(a, b)) return 0;

    const gw = geomWeight(a, b);
    if (gw >= 1) {
      return Math.abs(Math.log(Math.abs(b)) - Math.log(Math.abs(a)));
    }

    const c = symlogC(a, b);
    const syRisk = Math.abs(symlog(b, c) - symlog(a, c));
    if (gw <= 0) return syRisk;

    const geomRisk = Math.abs(Math.log(Math.abs(b)) - Math.log(Math.abs(a)));
    return syRisk + (geomRisk - syRisk) * gw;
  }

  function extraForRisk(risk) {
    if (risk <= TINY) return 0;

    // Larger transform-space spans get less extrapolation room.
    const maxFactor = 1.25 + 0.75 / (1 + risk);
    const extra = Math.log(maxFactor) / risk;
    return clamp(extra, 0, MAX_EXTRA_U);
  }

  function limitU(u, extra) {
    if (!Number.isFinite(u)) return 0;
    return clamp(u, -extra, 1 + extra);
  }

  function axisWeight(a, b) {
    return Math.abs(b - a) / magRef(a, b);
  }

  function bothNearZero(a, b) {
    return Math.abs(a) <= Z_BAND && Math.abs(b) <= Z_BAND;
  }

  function startsNearZero(i, j, v0, v1) {
    return Math.abs(v0[i]) <= Z_BAND &&
           Math.abs(v0[j]) <= Z_BAND &&
           Math.abs(v1[i]) > Z_BAND &&
           Math.abs(v1[j]) > Z_BAND;
  }

  function endsNearZero(i, j, v0, v1) {
    return Math.abs(v1[i]) <= Z_BAND &&
           Math.abs(v1[j]) <= Z_BAND &&
           Math.abs(v0[i]) > Z_BAND &&
           Math.abs(v0[j]) > Z_BAND;
  }

  function proportionalPair(i, j, v0, v1, changed) {
    if (!changed[i] || !changed[j]) return false;

    // Simultaneous grow-from-zero / shrink-to-zero is treated as a coupled scale move.
    if (startsNearZero(i, j, v0, v1)) return true;
    if (endsNearZero(i, j, v0, v1)) return true;

    if (bothNearZero(v0[i], v1[i]) || bothNearZero(v0[j], v1[j])) return false;
    if (!sameNonZeroSign(v0[i], v1[i], Z_BAND)) return false;
    if (!sameNonZeroSign(v0[j], v1[j], Z_BAND)) return false;

    const ri = v1[i] / v0[i];
    const rj = v1[j] / v0[j];
    if (!(ri > 0) || !(rj > 0) || !Number.isFinite(ri) || !Number.isFinite(rj)) return false;

    return Math.abs(Math.log(ri) - Math.log(rj)) <= GROUP_LOG_TOL;
  }

  function pairError(i, j, v0, v1) {
    if (startsNearZero(i, j, v0, v1)) {
      return Math.abs(Math.log(Math.abs(v1[i])) - Math.log(Math.abs(v1[j])));
    }

    if (endsNearZero(i, j, v0, v1)) {
      return Math.abs(Math.log(Math.abs(v0[i])) - Math.log(Math.abs(v0[j])));
    }

    const ri = Math.abs(v1[i] / v0[i]);
    const rj = Math.abs(v1[j] / v0[j]);
    return Math.abs(Math.log(ri) - Math.log(rj));
  }

  function groupU(mask, dim, uRaw, extraAxis, v0, v1) {
    let uSum = 0;
    let wSum = 0;
    let extra = MAX_EXTRA_U;

    for (let i = 0; i < dim; i++) {
      if (!mask[i]) continue;

      const w = Math.max(axisWeight(v0[i], v1[i]), 0.0001);
      uSum += uRaw[i] * w;
      wSum += w;
      extra = Math.min(extra, extraAxis[i]);
    }

    return wSum > TINY ? limitU(uSum / wSum, extra) : 0;
  }

  function addPairGroup(mask, a, b) {
    mask[a] = true;
    mask[b] = true;
  }

  function addBestPair(mask, xy, xz, yz, v0, v1) {
    let bestA = -1;
    let bestB = -1;
    let bestErr = Infinity;

    if (xy) {
      bestA = 0;
      bestB = 1;
      bestErr = pairError(0, 1, v0, v1);
    }

    if (xz) {
      const err = pairError(0, 2, v0, v1);
      if (err < bestErr) {
        bestA = 0;
        bestB = 2;
        bestErr = err;
      }
    }

    if (yz) {
      const err = pairError(1, 2, v0, v1);
      if (err < bestErr) {
        bestA = 1;
        bestB = 2;
        bestErr = err;
      }
    }

    if (bestA >= 0) addPairGroup(mask, bestA, bestB);
  }

  const raw = value;
  const rawWasVec = hasLength(raw);
  const native = asVec(raw);
  const dim = native.length;
  const prop = thisProperty;
  const numKeys = prop.numKeys;

  // Outside an active keyframe segment, preserve the native/pre-expression value exactly.
  if (numKeys < 2) return raw;

  const nk = prop.nearestKey(time);
  const k = nk.time > time ? nk.index - 1 : nk.index;
  if (k < 1 || k >= numKeys) return raw;

  const key0 = prop.key(k);
  const key1 = prop.key(k + 1);
  const v0 = asVec(key0.value);
  const v1 = asVec(key1.value);

  const uRaw = makeVec(dim, 0);
  const uAxis = makeVec(dim, 0);
  const extraAxis = makeVec(dim, 0);
  const changed = makeVec(dim, false);
  const grouped = makeVec(dim, false);
  let changedCount = 0;

  for (let i = 0; i < dim; i++) {
    if (nearSame(v0[i], v1[i])) continue;

    changed[i] = true;
    changedCount++;
    const risk = transformRisk(v0[i], v1[i]);
    extraAxis[i] = extraForRisk(risk);
    uRaw[i] = componentU(v0[i], v1[i], native[i]);
    uAxis[i] = limitU(uRaw[i], extraAxis[i]);
  }

  // If every axis is effectively unchanged, preserve native value-graph motion directly.
  if (changedCount === 0) return raw;

  // Infer proportional intent from the keyed endpoints. In 3D, require all
  // three pair tests for XYZ grouping; otherwise group only the tightest pair.
  if (dim >= 2 && changedCount >= 2) {
    const xy = proportionalPair(0, 1, v0, v1, changed);

    if (dim < 3) {
      if (xy) addPairGroup(grouped, 0, 1);
    } else {
      const xz = proportionalPair(0, 2, v0, v1, changed);
      const yz = proportionalPair(1, 2, v0, v1, changed);
      const pairs = (xy ? 1 : 0) + (xz ? 1 : 0) + (yz ? 1 : 0);

      if (pairs === 3) {
        grouped[0] = true;
        grouped[1] = true;
        grouped[2] = true;
      } else if (pairs > 0) {
        addBestPair(grouped, xy, xz, yz, v0, v1);
      }
    }
  }

  let hasGroup = false;
  for (let i = 0; i < dim; i++) {
    if (grouped[i]) {
      hasGroup = true;
      break;
    }
  }

  if (hasGroup) {
    const ug = groupU(grouped, dim, uRaw, extraAxis, v0, v1);
    for (let i = 0; i < dim; i++) {
      if (grouped[i]) uAxis[i] = ug;
    }
  }

  const out = makeVec(dim, 0);
  for (let i = 0; i < dim; i++) {
    // Equal/near-equal endpoints can still contain native value-graph motion.
    out[i] = changed[i]
      ? mixAdaptive(v0[i], v1[i], uAxis[i], native[i])
      : native[i];
  }

  return fromVec(out, rawWasVec);
})();
```

## How It Works

### 1. After Effects' native value is the easing signal

For a meaningfully changing component with keyframe endpoints `a` and `b`, the expression reconstructs the normalized progress already visible in After Effects' pre-expression value:

```text
u = (value - a) / (b - a)
```

This is the central preserve-ease mechanism. Instead of replacing the keyframe timing with a fresh `linear(time, ...)`, `ease()`, or hand-authored curve, the expression observes what After Effects has already produced at the current frame and reuses that progress as the driver for nonlinear interpolation.

If the native animation reaches its ordinary midpoint, `u = 0.5`. If a temporal/value curve overshoots an endpoint, `u` can move below `0` or above `1`, after which the expression's risk-based extrapolation limiter decides how much of that overshoot is safe to retain.

For an axis whose endpoints are equal or effectively equal, the denominator is not a reliable progress signal. The expression classifies that axis once, excludes it from proportional grouping, skips unnecessary progress/risk work for it, and passes through the native `value` instead. This also preserves native equal-endpoint value-graph motion or excursions that could otherwise be destroyed. Because such axes never consume recovered progress, no synthetic time-based fallback is needed.

### 2. Active-segment selection is non-destructive

The expression first identifies the segment surrounding the current time using `nearestKey()` and the returned key's `time` and `index`.

If there are fewer than two keyframes, if the current time is before the first usable segment, or if it is at/after the final segment boundary where no following key exists, the expression returns the native/pre-expression value unchanged.

That means EXP_2 affects only intervals that actually have two neighboring keyed endpoints to remap. It does not invent extrapolated animation outside the keyed range.

### 3. Signed geometric interpolation handles ordinary exponential scale changes

When both endpoints have the same nonzero sign and are sufficiently far from zero, interpolation is geometric:

```text
result = a * (b / a)^u
```

Equivalently, this linearly interpolates in logarithmic magnitude space and exponentiates back. At `u = 0.5`, positive values produce the geometric mean rather than the arithmetic mean.

Examples with linear native progress:

| Keyed segment | `u` | Linear/native value | Adaptive exponential result |
| --- | ---: | ---: | ---: |
| `100 -> 400` | `0.5` | `250` | `200` |
| `-100 -> -400` | `0.5` | `-250` | `-200` |
| `100 -> 200` | `0.5` | `150` | `141.421356...` |

Negative-to-negative interpolation is handled as a signed geometric interpolation: magnitude changes exponentially while the negative sign is retained.

### 4. Symlog handles zero, near-zero, and sign changes

Ordinary logarithms are undefined at zero and cannot directly span positive and negative values. For those cases, the expression maps values through a symmetric logarithmic transform:

```text
symlog(x, c) = sign(x) * log(1 + abs(x) / c)
```

It linearly interpolates the transformed values, then applies the inverse:

```text
symexp(y, c) = sign(y) * c * (exp(abs(y)) - 1)
```

The scale constant `c` is adaptive:

```text
c = max(tolerance(a, b), 0.05 * max(1, abs(a), abs(b)))
```

This keeps the transform well-conditioned around zero while allowing large magnitudes to retain logarithmic character.

For example, with keyed endpoints `0 -> 100` and native `u = 0.5`, the current constants yield approximately `17.9128785`, not the linear midpoint `50`. For `-100 -> 100` at `u = 0.5`, symmetry produces `0`.

### 5. Near zero, the transform changes smoothly rather than abruptly

For same-sign endpoints, the expression computes a geometric weight from the smaller endpoint magnitude. With the current constants:

```text
Z_BAND       = 0.001
GEOM_BLEND_HI = 0.064
```

If the smaller magnitude is at or below `0.001`, geometric interpolation is disabled and symlog is used. From `0.001` through `0.064`, a smoothstep weight blends symlog and geometric results. At or above `0.064`, the result is fully geometric, provided the endpoints still share a safe nonzero sign.

A sign-changing segment always uses the symlog path because ordinary geometric interpolation is not defined across the sign change.

### 6. Equality decisions use magnitude-aware tolerances

The expression does not rely on one fixed epsilon. Its principal equality tolerance is:

```text
tol(a, b) = max(1e-7, 1e-6 * max(1, abs(a), abs(b)))
```

With the current constants, `max(1, abs(a), abs(b))` is always at least `1`, so the relative term is always at least `1e-6` and dominates `ABS_TOL = 1e-7`. The effective equality tolerance is therefore `1e-6 * max(1, abs(a), abs(b))`, with a minimum of **`1e-6`**. This floor protects comparisons near zero; above unit magnitude, the tolerance scales with the keyed values. The constants and expression behavior are unchanged.

The dedicated zero band remains intentionally absolute (`0.001`) because it defines where logarithmic/geometric behavior should transition, rather than merely testing floating-point equality.

### 7. Coupled/proportional axes share progress only when the keys justify it

Ordinary axes first recover their own native progress independently. This preserves per-axis easing when the keyframes describe genuinely independent scale motion.

For two nonzero axes to be recognized as proportional, both must meaningfully change, each axis must keep a safe nonzero sign over the segment, and their keyed multiplicative ratios must be close in log space:

```text
abs(log(ratio_i) - log(ratio_j)) <= 0.025
```

The current `0.025` log tolerance corresponds to roughly a **2.53% multiplicative ratio difference**.

A simultaneous grow-from-near-zero or shrink-to-near-zero is also treated as coupled. That special case is necessary because an ordinary endpoint ratio is undefined when an endpoint is zero.

When a group is detected, its shared `u` is a weighted average of the axes' recovered native progress. Axes with more meaningful relative endpoint change receive more weight, and the group's extrapolation allowance is limited by the safest member of the group.

In 2D, XY can group. In 3D, XY, XZ, and YZ are tested separately. All three axes group as XYZ only when **all three pair tests pass**. If one or two pair tests pass without full three-way agreement, only the single tightest valid pair is grouped. This prevents a fuzzy transitive chain from accidentally merging all three axes.

### 8. Overshoot is retained only within a transform-risk budget

The expression does not simply clamp every axis to `[0, 1]`, because doing so would erase useful native progress overshoot. Instead, it measures the nonlinear transform-space span of each axis.

For a fully geometric segment:

```text
risk = abs(log(abs(b)) - log(abs(a)))
```

Near zero or across a sign change, the equivalent span is measured in symlog space. In the geometric/symlog transition band, the risk values are blended using the same geometric weight.

That risk determines an allowed normalized-progress extrapolation:

```text
if risk <= tiny:
    extra = 0
else:
    maxFactor = 1.25 + 0.75 / (1 + risk)
    extra     = log(maxFactor) / risk
    extra     = clamp(extra, 0, 0.35)

uLimited = clamp(uRaw, -extra, 1 + extra)
```

Small transform spans can retain as much as `0.35` of normalized-progress extrapolation. Large logarithmic spans receive progressively less. For geometric segments, this directly constrains how violently multiplicative extrapolation can grow; for symlog/blended segments it serves as an analogous transform-space safety heuristic.

This is intentionally conservative. The goal is to preserve useful easing overshoot without allowing extreme endpoint ratios to turn modest Graph Editor overshoot into enormous or non-finite scale values.

### 9. Endpoint snapping suppresses numerical fuzz

Very close to `u = 0` or `u = 1`, the nonlinear transform can produce a result that differs from the endpoint only by tiny floating-point noise. `SNAP_U` allows the expression to return the exact endpoint when both the progress and value error are already inside a very small tolerance neighborhood.

This is not a general clamp and does not suppress deliberate overshoot outside the endpoints.

### 10. Pathological floating-point overflow fails safe

Ordinary After Effects Scale values never need this path, but the final production expression includes two defensive fallbacks so mathematically extreme finite inputs do not turn into expression-breaking non-finite output.

First, native progress normally uses the direct formula `(cur - a) / (b - a)`. If either subtraction itself overflows the JavaScript number range, all three values are divided by a common magnitude before the subtraction is retried. Because the same nonzero scale factor is applied to numerator and denominator, the normalized progress is unchanged in exact arithmetic while the intermediate values remain representable.

Second, after geometric/symlog interpolation, the result is checked with `Number.isFinite()`. If the nonlinear calculation has exceeded the representable range, the expression returns the current native pre-expression component for that frame. If even that native component is non-finite, it falls back to the nearer keyed endpoint in normalized-progress space.

These safeguards are intentionally last-resort behavior. They do not alter ordinary finite Scale interpolation; they exist to ensure that a pathological numerical edge case degrades to a finite host value rather than poisoning the property with `NaN` or `Infinity`.

## Internal Heuristics and Constants

These are implementation constants, not user-facing controls. The keyframes remain the only animation UI.

| Constant | Value | Purpose |
| --- | ---: | --- |
| `ABS_TOL` | `1e-7` | Configured absolute term; dominated by the relative term in current equality tests. The effective equality floor is `1e-6`. |
| `REL_TOL` | `1e-6` | Relative component of magnitude-aware equality tests. |
| `ZERO_ABS` | `1e-3` | Absolute near-zero floor used to build `Z_BAND`. |
| `Z_BAND` | `0.001` with current constants | Region at/below which ordinary geometric interpolation is considered unsafe. |
| `SYMLOG_REL` | `0.05` | Relative scale used to choose the symlog constant `c`. |
| `SNAP_U` | `1e-5` | Tiny normalized-progress neighborhood used for exact endpoint snapping. |
| `TINY` | `1e-12` | Generic guard against effectively zero internal denominators/spans. |
| `MAX_EXTRA_U` | `0.35` | Maximum normalized-progress extrapolation allowed by the risk system. |
| `GROUP_LOG_TOL` | `0.025` | Log-ratio tolerance for proportional/coupled axis detection. |
| `GEOM_BLEND_MULT` | `64` | Expands the zero band to define the upper end of the symlog-to-geometric blend. |
| `GEOM_BLEND_HI` | `0.064` with current constants | Precomputed top of the near-zero blend band. |

### Former `Blend`

There is no global blend amount. Each axis automatically chooses or blends the safest interpolation domain for the current keyed segment. Same-sign values far from zero are geometric, dangerous zero/sign regions are symlog, and a narrow same-sign near-zero band blends between them.

### Former `Epsilon`

There is no single fixed epsilon controlling all comparisons. Equality uses combined absolute and relative tolerances; the zero-transition band is a separate semantic threshold.

### Former `Axis Driver`

There is no permanent X/Y/Z driver. Each changing axis normally recovers its own `u` from its own native value. A shared progress driver exists only for a detected coupled/proportional group.

### Former `Uniform Aspect`

There is no manual uniform-aspect switch. Coupling is inferred from the keyed endpoints on a per-segment basis. A default unchanged `100` Z Scale will therefore remain independent during an otherwise proportional XY zoom.

### Former `Clamp Progress` / `Overshoot Cap`

Progress is not globally forced into `[0, 1]`. Instead, transform-space risk dynamically chooses how far outside that interval each axis or group may travel.

## Refactors and Repairs in This Revision

This rewrite keeps EXP_2's animation model intact while incorporating the general code-quality, performance, and numerical lessons from the later hybrid work:

1. **Removed the redundant `sameSignPair()` test.** The preceding per-axis `sameNonZeroSign()` checks already proved the same condition, so the additional function did not reject any case that had not already been rejected.
2. **Hardened proportional-ratio validation.** Ratios must be strictly positive and finite before logarithms are evaluated.
3. **Made `pairError()` explicitly use absolute ratio magnitudes.** Valid proportional pairs are already positive-ratio cases, but the implementation now states the magnitude-space intent directly and defensively.
4. **Corrected `addBestPair()` bookkeeping.** The YZ-winning branch now updates `bestErr` consistently. YZ was the final comparison, so the old omission did not alter the selected result, but the function is now internally correct rather than accidentally correct by ordering.
5. **Simplified linear blend algebra.** Expressions of the form `a * (1 - w) + b * w` are written as `a + (b - a) * w`, reducing redundant arithmetic while preserving the same interpolation.
6. **Precomputed the geometric blend ceiling.** `GEOM_BLEND_HI` is constant for the lifetime of an evaluation and no longer needs to be rebuilt inside every `geomWeight()` call.
7. **Removed the unused-argument `zeroBand(a, b)` wrapper.** The zero band is genuinely constant, so the code now references `Z_BAND` directly instead of implying that the function depends on its arguments.
8. **Replaced the product-based zero-crossing test with an explicit sign test.** `a * b <= 0` can theoretically overflow or underflow merely to answer a sign question. `crossesOrTouchesZero()` tests the actual condition without multiplying the endpoints.
9. **Kept a defensive logarithmic fallback in `signedGeom()`.** If `b / a` becomes non-finite even though the endpoints share a safe sign, the expression interpolates logarithmic magnitudes directly rather than trusting the overflowed ratio.
10. **Classified changed axes once per segment evaluation.** A `changed` mask now becomes the single source of truth for whether an axis participates in progress recovery, grouping, or nonlinear output. This removes repeated near-equality work and keeps the pass-through invariant explicit.
11. **Removed the dead time-progress fallback and `TIME_TINY`.** Near-equal axes were already excluded from proportional groups and ultimately passed through from native `value`, so their synthetic time fraction could never affect output. The associated key-time reads and denominator guard were therefore unnecessary.
12. **Cached `numKeys` and removed unused key-time reads.** This slightly reduces repeated host-property access and makes the active-segment code easier to audit.
13. **Short-circuited all-unchanged segments.** If every axis is effectively unchanged between the current key pair, the expression returns the native value immediately, preserving any native equal-endpoint excursion without running grouping or nonlinear interpolation.
14. **Simplified mathematically dominated arithmetic.** `axisWeight()` now divides directly by `magRef(a, b)` because, with the fixed production tolerances, that quantity always dominates the old `max(tol1(...), magRef(...))` denominator. Likewise, `extraForRisk()` divides directly by `risk` after the preceding `risk <= TINY` guard has already guaranteed a safe nonzero denominator.
15. **Cached the per-call tolerance inside `mixAdaptive()`.** The same endpoint tolerance is reused for zero snapping and endpoint snapping instead of being recomputed several times.
16. **Added overflow-safe normalized-progress recovery.** Direct subtraction remains the fast path. Only if the numerator or denominator subtraction becomes non-finite are the values normalized by a common magnitude before progress is recovered.
17. **Added a final finite-output fail-safe.** If nonlinear interpolation ever produces a non-finite number, the current native component is returned instead; only if that is also non-finite does the expression fall back to a keyed endpoint.
18. **Made group-presence detection dimension-generic.** The code does not depend on checking only hard-coded group-array positions, even though normal Scale is 2D/3D.
19. **Clarified native-value naming and comments.** `native` consistently means the observable pre-expression value supplied by After Effects, making the distinction between native animation and nonlinear output easier to audit.
20. **Retained `nearestKey()` intentionally.** The newer neighboring-key helpers would shorten segment lookup in AE 26.0+, but using them would unnecessarily discard compatibility with AE 16.0 through 25.x.

A side-by-side randomized comparison against the immediately preceding EXP_2 revision found no output differences in the ordinary finite test domain used for the production audit. The new rescaling and finite-output branches activate only when ordinary JavaScript arithmetic itself becomes non-finite, so they harden pathological numerical cases without changing normal animation semantics.

## Behavioral Sanity Checks

The following examples assume a native normalized progress of `u = 0.5` unless otherwise noted:

| Scenario | Expected behavior |
| --- | --- |
| No keyframes, native Scale `[100, 100]` | Returns `[100, 100]` unchanged. |
| Before the first usable segment / after the last | Returns native `value` unchanged. |
| `100 -> 400` | Geometric midpoint `200`. |
| `-100 -> -400` | Signed geometric midpoint `-200`. |
| `0 -> 100` | Symlog result `~17.9128785`. |
| `-100 -> 100` | Symlog midpoint `0`. |
| Equal endpoints with a native value-graph excursion | Passes through the native excursion instead of flattening it. |
| 3D `[100,100,100] -> [200,200,100]` | XY may share progress; unchanged Z remains native and is not pulled into the group. |
| Proportional endpoints with intentionally different per-axis easing | Grouped axes use their weighted shared recovered progress, by design. |
| Non-proportional endpoints | Axes retain independent recovered progress. |

## Validation Performed on This Revision

### Previously Reported Numerical Validation

The two randomized runs described below were reported before the AE host validation in the next subsection. Their original harness and raw results were not independently reproduced in the 10 September 2026 review; the new audit results are recorded separately.

The final expression was extracted back out of this Markdown file, syntax-checked as modern JavaScript, and exercised in a mock After Effects property environment covering:

- scalar, 2D, and 3D return shapes;
- no-key, before-first-key, exact-key, between-key, and after-last-key behavior;
- positive and negative geometric interpolation;
- zero endpoints and sign-crossing symlog interpolation;
- equal/near-equal endpoint native excursions;
- independent per-axis easing;
- proportional shared-progress grouping;
- 3D XY grouping with unchanged Z;
- hold-like native progress behavior;
- bounded normalized-progress extrapolation;
- finite-value recovery at extreme floating-point magnitudes.

A **500,000-case randomized side-by-side regression test** compared this production candidate against the immediately preceding EXP_2 revision over ordinary finite inputs, including scalar/2D/3D shapes, equal/near-equal axes, and recovered progress both inside and outside `[0, 1]`. It produced **zero mismatches** and a measured maximum relative output difference of **0** in that test run.

A separate **250,000-case extreme-range stress test** spanned finite magnitudes across hundreds of decimal orders, including cases designed to overflow intermediate subtraction or nonlinear extrapolation while the native input itself remained finite. All 250,000 cases produced finite output after the production version's rescaling and final finite-output safeguards.

The preceding tests concern JavaScript/numerical behavior. The following validation additionally exercised the real After Effects host.

### AE 2025 Host Validation — 10 September 2026

The exact expression committed in [be0ce5c](https://github.com/matthewpenkala/Fuck-Adobe/commit/be0ce5cd8e8aab1fe8704af377c2e0c98604bd17) was tested in **After Effects 2025, version 25.6.5x3**, using the modern JavaScript expression engine on Windows. The JavaScript code block was not changed by the documentation update.

- **76 host scenarios and 5,481 sampled property values** completed without expression errors, disabled expressions, or non-finite output.
- **15,939 component comparisons** matched a separate mathematical oracle within tolerance. Maximum observed absolute difference was approximately **4.46e-10**. The same samples also matched execution of the exact expression in Node.js.
- Coverage included positive/negative Scale, zero growth/shrinkage, sign crossing, near-zero transition boundaries, scalar and vector shapes, independent axis easing, XY/XZ/YZ/XYZ coupling, non-transitive pair selection, equal-endpoint excursions, hold keys, positive and negative recovered-progress overshoot, Auto Bezier, and continuous multisegment easing.
- Source keyframe values, times, interpolation types, and temporal-ease settings remained unchanged. A separate saved-project reopen verified **70 cases and 702 additional sampled values**, plus persisted expression text and keyframe/ease metadata.
- A six-scenario composition rendered successfully: **36 frames at 960 × 540, 12 fps**. The resulting three-second preview passed a full decode check.
- A separate independent Node.js audit passed **505,082 assertions**, including sign/reversal symmetry, endpoint and midpoint-tie handling, all three-axis grouping graph configurations, near-zero monotonicity, aspect preservation, and positive/negative extrapolation. These are numerical assertions, not additional AE host cases.
- All accepted host runs returned fresh, run-bound completion evidence and successful owned-process cleanup through the approved automation runner.

Scale returned three components through AE's scripting API on both 2D and 3D layers. A Point Control fixture separately verified a true two-component return; its shared spatial timing was not counted as independent per-axis temporal easing. Scale fixtures supplied that independent-axis coverage.

This supports release on the tested AE 2025 host. It does not establish runtime compatibility for every AE 16.0+ release, an exhaustive test of every possible animation, or a measured performance improvement.


## Known Limits

- **No direct Graph Editor handle access.** Expression-side `Key` objects expose keyframe `index`, `time`, and `value`; they do not expose the full temporal Bezier handle/ease metadata available to scripting APIs. This expression therefore observes the native pre-expression result instead of reconstructing hidden handles.
- **“Preserve ease” means native progress drives the remap, subject to its documented rules.** Independent axes recover their own progress; coupled axes use a weighted shared value. Overshoot limits can clamp progress, and endpoint snapping can adjust the final result. The nonlinear remap also changes Scale-space velocity and acceleration. Keyframe times remain unchanged, but identical per-axis progress, velocity, and acceleration are not guaranteed in every case.
- **Extreme overshoot is deliberately bounded.** If mathematically unbounded exponential extrapolation is required, this expression is intentionally safer than that requirement.
- **Representational overflow falls back to native output.** At pathological floating-point magnitudes where the requested nonlinear value cannot be represented as a finite JavaScript number, the expression prioritizes a finite native component over preserving an unrepresentable exponential result.
- **Axis grouping is heuristic and endpoint-driven.** Proportional endpoints are interpreted as evidence of coupled scaling. If those endpoints intentionally use different axis easing, the group averages their recovered progress. Use sufficiently non-proportional endpoint ratios if fully independent treatment is required.
- **Grow-from-zero / shrink-to-zero coupling is inferred specially.** Ratios are undefined at zero, so simultaneous near-zero starts or ends are treated as coupled scale motion.
- **Near-zero behavior is intentionally not pure exponential interpolation.** Symlog is a numerical and semantic fallback for regions where ordinary logarithmic interpolation is undefined or unstable.
- **Negative Scale is supported mathematically.** In After Effects, negative Scale also implies the expected axis flip; the expression does not suppress that visual behavior.
- **The Markdown wrapper is documentation.** Paste only the JavaScript code block into After Effects.

## Research Basis

- Adobe's current expression documentation states that a property has a pre-expression value and that the `value` attribute accesses that value from within the expression. This is the basis for using native `value` as the observable easing/progress signal.
- Adobe documents the JavaScript expression engine in After Effects 16.0 as based on ECMAScript 2018, which supports the modern JavaScript constructs used here.
- The expression-side `Key` reference exposes `index`, `time`, and `value`. Because temporal Bezier handles are not part of that expression-side Key API, this implementation does not pretend to reconstruct them.
- `nearestKey()` is available across the compatibility range used here. `previousKey()` and `nextKey()` were added only in After Effects 26.0, so they are intentionally not required.
- Geometric/logarithmic interpolation is equivalent to interpolating logarithms linearly and exponentiating back.
- Symlog/log-modulus transforms provide a signed, zero-preserving alternative where ordinary logarithms cannot operate.
- Robust floating-point comparisons benefit from combined absolute and relative tolerances rather than a single fixed epsilon.

## Sources

### Adobe / After Effects

- [Adobe Help Center - Expression basics](https://helpx.adobe.com/after-effects/desktop/work-with-expressions/expression-basics/expression-basics.html)
- [Adobe Help Center - Syntax differences between expression engines](https://helpx.adobe.com/after-effects/desktop/work-with-expressions/expression-basics/legacy-and-extend-script-engine.html)
- [Adobe Help Center - Expression language reference](https://helpx.adobe.com/after-effects/desktop/work-with-expressions/expression-language-reference/expression-language-reference.html)
- [After Effects Expression Reference - Property](https://ae-expressions.docsforadobe.dev/objects/property/)
- [After Effects Expression Reference - Key](https://ae-expressions.docsforadobe.dev/objects/key/)
- [After Effects Expression Reference - Changelog](https://ae-expressions.docsforadobe.dev/introduction/changelog/)

### Mathematics / Numerical Robustness

- [Markus Deserno - Linear and Logarithmic Interpolation](https://www.cmu.edu/biolphys/deserno/pdf/log_interpol.pdf)
- [D3 - Symlog scales](https://d3js.org/d3-scale/symlog)
- [SAS - A log transformation of positive and negative values](https://blogs.sas.com/content/iml/2014/07/14/log-transformation-of-pos-neg.html)
- [Christer Ericson - Floating-point tolerances revisited](https://realtimecollisiondetection.net/blog/?p=89)