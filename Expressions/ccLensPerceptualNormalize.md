A non-destructive (i.e., avoids the tedious hell of re-easing curves just to fix perceptual speed), Bezier-aware `CC Lens › Size` expression which remaps keyed values. It applies perceptual normalization: *Power-Reciprocal × Gamma-Linear with a subtle constant-ratio nudge* to tame the effect's "too-hot near zero" response and fix its unnatural linear interpolation, all while preserving your existing keyframe easing and timing.

```
// CC Lens — Size [value] Normalization (non-destructive, Bezier-aware)
// v1.2 | Perceptual Power-Reciprocal ⨉ Gamma-Linear (+ misc. tuning)
// --- Refactored & Optimized ---

// ----- Shared Tunables (same as both inputs unless noted) -----
var S_MIN = 0;
var S_MAX = 500;
var GAMMA = 2.0;
var POWER = 0.7;
var EPS = 0.5;
var KLOG = 0.0;

// ----- Version-specific knobs (kept exactly from your two expressions) -----
// Expression 1 (v1.2)
var MIX1 = 0.60;
var EXP_BIAS1 = 0.15;

// Expression 2 (v1.3)
var MIX2 = 0.85;
var EXP_BIAS2 = 0.0;

// ----- Internals -----
var TINY = 1e-12;
var TIME_TINY = 1e-9;

function clamp(x, a, b) {
  return Math.min(b, Math.max(a, x));
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Perceptual: interpolate in 1/Size^GAMMA, then invert
function powerRecipLerp(a, b, t, gamma, eps) {
  var A = Math.max(a, eps), B = Math.max(b, eps);
  var invNegGamma = -1 / gamma; // [Opt] Cache reciprocal calculation
  var p0 = Math.pow(A, -gamma);
  var p1 = Math.pow(B, -gamma);
  var p = lerp(p0, p1, t);
  return Math.pow(Math.max(p, TINY), invNegGamma);
}

// Gamma-on-linear
function gammaLinearLerp(a, b, t, pow, lo, hi) {
  var span = Math.max(hi - lo, 1e-6);
  var invSpan = 1 / span; // [Opt] Cache reciprocal for multiplication
  var invPow = 1 / pow; // [Opt] Cache reciprocal calculation

  var n0 = clamp((a - lo) * invSpan, 0, 1);
  var n1 = clamp((b - lo) * invSpan, 0, 1);

  var c0 = Math.pow(n0, pow), c1 = Math.pow(n1, pow);
  var c = lerp(c0, c1, t);

  var nR = Math.pow(Math.max(c, TINY), invPow);
  return nR * span + lo;
}

// Constant-ratio (multiplicative)
function expLerp(a, b, t, eps) {
  var A = Math.max(a, eps), B = Math.max(b, eps);
  // Handle division by zero if A is extremely small but B is not
  if (A < TINY) return lerp(a, b, t);
  return A * Math.pow(B / A, t);
}

if (numKeys < 2) {
  value; // no segment to normalize
} else {
  // Active segment
  var nk = nearestKey(time);
  var k = (nk.time > time) ? nk.index - 1 : nk.index;

  if (k < 1 || k >= numKeys) {
    value; // outside any segment
  } else {
    var t0 = key(k).time, t1 = key(k + 1).time, dt = t1 - t0;
    var v0 = key(k).value, v1 = key(k + 1).value;
    var v = value; // AE’s Bezier-eased value

    // Bezier-aware progress (prefer value space, fallback to time)
    var den = (v1 - v0);
    var u = (Math.abs(den) < TINY) ?
      ((time - t0) / Math.max(TIME_TINY, dt)) :
      ((v - v0) / den);
    u = clamp(u, 0, 1);

    // Optional logistic shaping
    if (KLOG > 0) {
      var ksig = Math.max(1e-6, KLOG);
      u = 1 / (1 + Math.exp(-ksig * (u - 0.5)));
    }

    // Core interpolants
    var sPR = powerRecipLerp(v0, v1, u, GAMMA, EPS);
    var sGL = gammaLinearLerp(v0, v1, u, POWER, S_MIN, S_MAX);
    var sEX = expLerp(v0, v1, u, EPS);

    // Expression 1 fusion
    var hybrid1 = lerp(sGL, sPR, MIX1); // [Refactor] Use lerp() for cleaner mix
    var out1 = lerp(hybrid1, sEX, EXP_BIAS1);
    var out1C = clamp(out1, S_MIN, S_MAX);

    // Expression 2 fusion
    var hybrid2 = lerp(sGL, sPR, MIX2); // [Refactor] Use lerp() for cleaner mix
    var out2 = lerp(hybrid2, sEX, EXP_BIAS2);
    var out2C = clamp(out2, S_MIN, S_MAX);

    // Final: average their remapped outputs
    // [Opt] Removed redundant final clamp, as the average of two
    // clamped values will already be within the same range.
    0.5 * (out1C + out2C);
  }
}
```
