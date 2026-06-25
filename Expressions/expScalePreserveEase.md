# Hybrid Exponential Scale - Adaptive Preserve Ease

A non-destructive (i.e., doesn't bake into every frame like AE's lackluster native keyframe assistant), Bezier-aware Scale expression that applies adaptive exponential interpolation with self-detected axis/proportional-zoom behavior while preserving your existing keyframe easing and timing from the observable pre-expression value.

## What It Does

- Uses the property's own keyed values and current pre-expression `value`; no Effect Controls are read.
- Requires After Effects' modern JavaScript expression engine, not Legacy ExtendScript.
- Infers eased progress from AE's native value at the current time.
- Uses signed geometric interpolation for same-sign nonzero scale changes.
- Uses symlog/log-modulus interpolation at zero, extremely near zero, or through sign changes.
- Computes tolerances from each segment's own magnitude instead of using a fixed epsilon.
- Preserves limited native overshoot when it is safe, with an automatic cap that tightens as endpoint ratios get more extreme.
- Detects obvious proportional axis groups from segment endpoints, including XY, XZ, or YZ in 3D.
- Leaves independent axes independent.
- Passes through axes whose endpoints are effectively unchanged, preserving equal-endpoint value-graph motion.
- Handles scalar, 2D, and 3D properties while returning the same dimensional shape it received.

## Expression

Compatibility: After Effects 16.0+ with `File > Project Settings > Expressions > Expressions Engine` set to `JavaScript`.

```js
// Hybrid Exponential Scale - Adaptive Preserve Ease
// Requires the modern JavaScript expression engine.
// Drop on Scale. No sliders, dropdowns, checkboxes, or Effect Controls.
// The keyframes themselves are the only UI.

(() => {
  const ABS_TOL = 1e-7;
  const REL_TOL = 1e-6;
  const ZERO_ABS = 1e-3;
  const Z_BAND = Math.max(ABS_TOL * 4, ZERO_ABS);
  const SYMLOG_REL = 5e-2;
  const SNAP_U = 1e-5;
  const TINY = 1e-12;
  const TIME_TINY = 1e-9;
  const MAX_EXTRA_U = 0.35;
  const GROUP_LOG_TOL = 0.025;
  const GEOM_BLEND_MULT = 64;

  function clamp(x, lo, hi) {
    return Math.min(Math.max(x, lo), hi);
  }

  function hasLength(x) {
    return x !== null && typeof x.length === "number";
  }

  function asVec(x) {
    if (!hasLength(x)) return [x];

    const a = [];
    for (let i = 0; i < x.length; i++) a[i] = x[i];
    return a;
  }

  function fromVec(v, wasVec) {
    return wasVec ? v : v[0];
  }

  function makeVec(n, fillValue) {
    const a = [];
    for (let i = 0; i < n; i++) a[i] = fillValue;
    return a;
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

  function zeroBand(a, b) {
    return Z_BAND;
  }

  function symlogC(a, b) {
    return Math.max(tol1(a, b), SYMLOG_REL * magRef(a, b));
  }

  function sameNonZeroSign(a, b, z) {
    return (a > z && b > z) || (a < -z && b < -z);
  }

  function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function geomWeight(a, b) {
    const z = zeroBand(a, b);
    if (!sameNonZeroSign(a, b, z)) return 0;

    const m = Math.min(Math.abs(a), Math.abs(b));
    const hi = Math.max(z * GEOM_BLEND_MULT, z + ABS_TOL);
    return smoothstep(z, hi, m);
  }

  function symlog(x, c) {
    return Math.sign(x) * Math.log1p(Math.abs(x) / c);
  }

  function symexp(y, c) {
    return Math.sign(y) * c * Math.expm1(Math.abs(y));
  }

  function signedGeom(a, b, u) {
    const r = b / a;
    if (r > 0 && Number.isFinite(r)) return a * Math.pow(r, u);

    return Math.sign(a) * Math.exp(Math.log(Math.abs(a)) + u * (Math.log(Math.abs(b)) - Math.log(Math.abs(a))));
  }

  function symlogMix(a, b, u) {
    const c = symlogC(a, b);
    const ya = symlog(a, c);
    const yb = symlog(b, c);
    return symexp(ya + u * (yb - ya), c);
  }

  function mixAdaptive(a, b, u) {
    if (nearSame(a, b)) return a;
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
      r = s * (1 - gw) + g * gw;
    }

    if (a * b <= 0 && Math.abs(r) <= tol1(a, b)) r = 0;
    if (u > 0 && u <= SNAP_U && Math.abs(r - a) <= tol1(a, b) * 4) return a;
    if (u < 1 && u >= 1 - SNAP_U && Math.abs(r - b) <= tol1(a, b) * 4) return b;

    return r;
  }

  function componentU(a, b, cur, t, t0, dt) {
    const d = b - a;
    return (Math.abs(d) > tol1(a, b))
      ? (cur - a) / d
      : (t - t0) / Math.max(TIME_TINY, dt);
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
    return syRisk * (1 - gw) + geomRisk * gw;
  }

  function extraForRisk(risk) {
    if (risk <= TINY) return 0;

    // Risk is the transform-space span. Larger spans get less extrapolation room.
    const maxFactor = 1.25 + 0.75 / (1 + risk);
    const extra = Math.log(maxFactor) / Math.max(risk, TINY);
    return clamp(extra, 0, MAX_EXTRA_U);
  }

  function limitU(u, extra) {
    if (!Number.isFinite(u)) return 0;
    return clamp(u, -extra, 1 + extra);
  }

  function axisWeight(a, b) {
    return Math.abs(b - a) / Math.max(tol1(a, b), magRef(a, b));
  }

  function changedEnough(a, b) {
    return Math.abs(b - a) > tol1(a, b);
  }

  function bothNearZero(a, b) {
    return Math.abs(a) <= zeroBand(a, b) && Math.abs(b) <= zeroBand(a, b);
  }

  function startsNearZero(i, j, v0, v1) {
    return Math.abs(v0[i]) <= zeroBand(v0[i], v1[i]) &&
           Math.abs(v0[j]) <= zeroBand(v0[j], v1[j]) &&
           Math.abs(v1[i]) > zeroBand(v0[i], v1[i]) &&
           Math.abs(v1[j]) > zeroBand(v0[j], v1[j]);
  }

  function endsNearZero(i, j, v0, v1) {
    return Math.abs(v1[i]) <= zeroBand(v0[i], v1[i]) &&
           Math.abs(v1[j]) <= zeroBand(v0[j], v1[j]) &&
           Math.abs(v0[i]) > zeroBand(v0[i], v1[i]) &&
           Math.abs(v0[j]) > zeroBand(v0[j], v1[j]);
  }

  function sameSignPair(a0, a1, b0, b1) {
    return ((a0 > 0 && a1 > 0) || (a0 < 0 && a1 < 0)) &&
           ((b0 > 0 && b1 > 0) || (b0 < 0 && b1 < 0));
  }

  function proportionalPair(i, j, v0, v1) {
    if (!changedEnough(v0[i], v1[i]) || !changedEnough(v0[j], v1[j])) return false;

    // Grow-from-zero and shrink-to-zero are valid proportional cases if both axes do it.
    if (startsNearZero(i, j, v0, v1)) return true;
    if (endsNearZero(i, j, v0, v1)) return true;

    if (bothNearZero(v0[i], v1[i]) || bothNearZero(v0[j], v1[j])) return false;

    const zi = zeroBand(v0[i], v1[i]);
    const zj = zeroBand(v0[j], v1[j]);
    if (!sameNonZeroSign(v0[i], v1[i], zi)) return false;
    if (!sameNonZeroSign(v0[j], v1[j], zj)) return false;
    if (!sameSignPair(v0[i], v1[i], v0[j], v1[j])) return false;

    const ri = v1[i] / v0[i];
    const rj = v1[j] / v0[j];
    if (ri * rj <= 0) return false;

    return Math.abs(Math.log(Math.abs(ri)) - Math.log(Math.abs(rj))) <= GROUP_LOG_TOL;
  }

  function pairError(i, j, v0, v1) {
    if (startsNearZero(i, j, v0, v1)) {
      return Math.abs(Math.log(Math.abs(v1[i])) - Math.log(Math.abs(v1[j])));
    }

    if (endsNearZero(i, j, v0, v1)) {
      return Math.abs(Math.log(Math.abs(v0[i])) - Math.log(Math.abs(v0[j])));
    }

    const ri = v1[i] / v0[i];
    const rj = v1[j] / v0[j];
    return Math.abs(Math.log(Math.abs(ri)) - Math.log(Math.abs(rj)));
  }

  function groupU(mask, dim, uRaw, extraAxis, v0, v1) {
    let uSum = 0;
    let wSum = 0;
    let extra = MAX_EXTRA_U;

    for (let i = 0; i < dim; i++) {
      if (mask[i]) {
        const w = Math.max(axisWeight(v0[i], v1[i]), 0.0001);
        uSum += uRaw[i] * w;
        wSum += w;
        extra = Math.min(extra, extraAxis[i]);
      }
    }

    if (wSum <= TINY) return 0;
    return limitU(uSum / wSum, extra);
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
      }
    }

    if (bestA >= 0) addPairGroup(mask, bestA, bestB);
  }

  function pairCount(a, b, c) {
    return (a ? 1 : 0) + (b ? 1 : 0) + (c ? 1 : 0);
  }

  const raw = value;
  const rawWasVec = hasLength(raw);
  const v = asVec(raw);
  const dim = v.length;
  const prop = thisProperty;

  if (prop.numKeys < 2) return raw;

  const nk = prop.nearestKey(time);
  const k = (nk.time > time) ? nk.index - 1 : nk.index;

  if (k < 1 || k >= prop.numKeys) return raw;

  const key0 = prop.key(k);
  const key1 = prop.key(k + 1);
  const t0 = key0.time;
  const t1 = key1.time;
  const dt = t1 - t0;
  const v0 = asVec(key0.value);
  const v1 = asVec(key1.value);

  const uRaw = makeVec(dim, 0);
  const uAxis = makeVec(dim, 0);
  const extraAxis = makeVec(dim, 0);
  const grouped = makeVec(dim, false);

  for (let i = 0; i < dim; i++) {
    const risk = transformRisk(v0[i], v1[i]);
    extraAxis[i] = extraForRisk(risk);
    uRaw[i] = componentU(v0[i], v1[i], v[i], time, t0, dt);
    uAxis[i] = limitU(uRaw[i], extraAxis[i]);
  }

  // Internalized aspect behavior:
  // if the keys prove axes are proportional, process that proportional group
  // with one shared u. In 3D, avoid fuzzy transitive chains: XYZ groups only
  // when XY, XZ, and YZ all pass; otherwise use the single tightest pair.
  if (dim >= 2) {
    const xy = proportionalPair(0, 1, v0, v1);

    if (dim < 3) {
      if (xy) addPairGroup(grouped, 0, 1);
    } else {
      const xz = proportionalPair(0, 2, v0, v1);
      const yz = proportionalPair(1, 2, v0, v1);
      const pairs = pairCount(xy, xz, yz);

      if (pairs === 3) {
        grouped[0] = true;
        grouped[1] = true;
        grouped[2] = true;
      } else if (pairs > 0) {
        addBestPair(grouped, xy, xz, yz, v0, v1);
      }
    }
  }

  if (grouped[0] || grouped[1] || grouped[2]) {
    const ug = groupU(grouped, dim, uRaw, extraAxis, v0, v1);
    for (let i = 0; i < dim; i++) {
      if (grouped[i]) {
        uAxis[i] = ug;
      }
    }
  }

  const expVec = makeVec(dim, 0);
  for (let i = 0; i < dim; i++) {
    expVec[i] = nearSame(v0[i], v1[i])
      ? v[i]
      : mixAdaptive(v0[i], v1[i], uAxis[i]);
  }

  return fromVec(expVec, rawWasVec);
})();
```

## Internal Heuristics

### Former `Blend`

There is no blend amount. Each axis is adaptively remapped using the safest transform for that segment. Dead/no-change axes pass through the original pre-expression value, which preserves equal-endpoint value-graph motion.

### Former `Epsilon`

The expression uses combined absolute-plus-relative tolerances:

```txt
tol = max(1e-7, 1e-6 * max(1, abs(a), abs(b)))
```

That makes the safety threshold scale with the values being animated. A 0-to-100 scale segment and a 0-to-100000 scale segment should not use the same absolute epsilon.

### Former `Axis Driver`

Ordinary axes recover their own progress:

```txt
u_i = (value_i - keyStart_i) / (keyEnd_i - keyStart_i)
```

That preserves axis-specific easing better than one global driver. A shared driver is created only when the keyed segment clearly says multiple axes are proportional.

### Former `Uniform Aspect`

Aspect/grouping behavior is inferred, not chosen.

The expression groups any obviously proportional axis pair:

- X/Y in 2D or 3D,
- X/Z in 3D,
- Y/Z in 3D.

Each pair must meaningfully change and have keyed start/end values that are obviously proportional, or both axes must grow from zero / shrink to zero together. A default unchanged `100` Z scale will not be pulled into an XY zoom.

This grouping is heuristic and segment-stable. If proportional endpoints use intentionally different per-axis easing, the grouped result averages the recovered progress of the grouped axes. Use non-proportional endpoint values if you want to force fully independent axis treatment.

Pairwise 3D grouping is intentional behavior, not just an optimization. It allows cases such as Y/Z scaling together while X remains unchanged. If two 3D pairs pass but the third pair does not, the expression groups only the tightest pair rather than merging all three through a fuzzy transitive chain.

### Former `Clamp Progress` and `Overshoot Cap`

Overshoot is always capped, but not always deleted. The cap is based on transform-space risk:

- mild scale ratios get more overshoot room,
- extreme ratios get less,
- near-zero and sign-crossing spans use symlog-space risk.

This preserves intentional Graph Editor overshoot without letting geometric extrapolation explode.

## Known Limits

- Expressions cannot read the actual Graph Editor temporal Bezier handles. This expression reuses observable native progress from `value`; it does not reconstruct hidden keyframe interpolation metadata.
- Extreme overshoot is intentionally capped. If you need mathematically unbounded extrapolation, this expression is deliberately safer than that.
- Proportional grouping is inferred from segment endpoints. In 3D, any proportional pair can group: XY, XZ, or YZ. If you want fully independent axes, make the endpoint ratios non-proportional.
- The Markdown wrapper is for GitHub. Paste only the JavaScript code block into After Effects.

## Research Basis

- Adobe's expression docs expose `value`, `valueAtTime`, `velocity`, `velocityAtTime`, `key`, `nearestKey`, and `numKeys`, but expression-side key objects do not expose temporal Bezier handles. This expression therefore infers progress from observable values rather than hidden Graph Editor metadata.
- Adobe's modern JavaScript expression engine is the target here; the expression does not attempt to support Legacy ExtendScript.
- Logarithmic interpolation is equivalent to linearly interpolating logarithms and exponentiating back.
- Symlog/log-modulus transforms handle zero and signed values where ordinary logarithms are undefined.
- Floating-point comparisons need both absolute and relative tolerance; a fixed epsilon is brittle across different value magnitudes.

Sources:

- Linear and logarithmic interpolation notes: <https://www.cmu.edu/biolphys/deserno/pdf/log_interpol.pdf>
- D3 symlog scale notes/source: <https://d3js.org/d3-scale/symlog>
- Log-modulus transform for signed values: <https://blogs.sas.com/content/iml/2014/07/14/log-transformation-of-pos-neg.html>
- Floating-point tolerance discussion: <https://realtimecollisiondetection.net/blog/?p=89>
