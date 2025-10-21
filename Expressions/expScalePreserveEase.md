A non-destructive (i.e., doesn't bake into every frame like AE's lackluster native keyframe assistant), Bezier-aware scale expression that applies exponential interpolation, optionally auto/axis-driven with uniform-zoom locking, blendable with the original while preserving your existing keyframe easing and timing.

```
// Hybrid Exponential Scale — Bezier-aware + Axis driver + Uniform zoom
// v2.0  |  Non-destructive (respects your keyframe easing and timing)

// ---------- Controls (optional; auto-detected) ----------
// • Slider "ExpScale Blend" (0–100)          : mix original vs exponential (default 100)
// • Slider "ExpScale Epsilon"                : min magnitude to avoid log/zero (default 0.001)
// • Slider "ExpScale Axis Driver"            : 0=Auto, 1=X, 2=Y, 3=Z (default 0)
// • Slider "ExpScale Uniform Aspect"         : 0=Off, 1=Lock to Start, 2=Lock to End (default 0)

function getCtrl(name, def) {
  try { return effect(name)(1); } catch (e) { return def; }
}

var BLEND  = getCtrl("ExpScale Blend", 100) / 100;
var EPS    = getCtrl("ExpScale Epsilon", 0.001);
var DRIVER = Math.round(getCtrl("ExpScale Axis Driver", 0));    // 0 auto, 1..3 axis
var UASP   = Math.round(getCtrl("ExpScale Uniform Aspect", 0)); // 0 off, 1 start, 2 end

// Small thresholds for numerical safety
var TINY = 1e-12;
var TIME_TINY = 1e-9;

if (numKeys < 2) {
  value;
} else {
  // --- segment detection (nearest then look-back) ---
  var nk = nearestKey(time);
  var k  = (nk.time > time) ? nk.index - 1 : nk.index;

  if (k < 1 || k >= numKeys) {
    value;
  } else {
    var t0 = key(k).time;
    var t1 = key(k + 1).time;
    var dt = t1 - t0;

    var v0 = key(k).value;       // start vector
    var v1 = key(k + 1).value;   // end vector
    var v  = value;              // pre-expression (Bezier-eased) value
    var dim = v.length;

    // ---- eased progress u ----
    var u;
    if (DRIVER >= 1 && DRIVER <= dim) {
      // Axis-driven
      var ax   = DRIVER - 1;
      var denA = (v1[ax] - v0[ax]);
      u = (Math.abs(denA) < TINY)
        ? (time - t0) / Math.max(TIME_TINY, dt)
        : (v[ax] - v0[ax]) / denA;
    } else {
      // Projection of (v - v0) onto (v1 - v0)
      var num = 0, den = 0;
      for (var i = 0; i < dim; i++) {
        var di = v1[i] - v0[i];
        var wi = v[i]  - v0[i];
        num += wi * di;
        den += di * di;
      }
      u = (den > TINY)
        ? (num / den)
        : (time - t0) / Math.max(TIME_TINY, dt);
    }
    if (u < 0) u = 0; else if (u > 1) u = 1;

    // ---- exponential interpolation helper (pow-based, sign-safe) ----
    function expLerpScalarPow(a, b, u, eps) {
      if (Math.abs(b - a) < TINY) return a;
      var sameSign = (a >= 0 && b >= 0) || (a <= 0 && b <= 0);
      var aa = Math.abs(a), bb = Math.abs(b);
      if (sameSign && aa >= eps && bb >= eps) {
        var sgn = (a >= 0) ? 1 : -1;             // both same sign
        return sgn * (aa * Math.pow(bb / aa, u)); // cheaper than log/exp
      }
      return a + u * (b - a);                    // safe fallback
    }

    // ---- compute exponential result vector ----
    var expVec = (dim == 3) ? [0, 0, 0] : [0, 0];

    if (UASP === 1 || UASP === 2) {
      // Uniform aspect: lock direction to start or end, lerp magnitude exponentially
      var axv = (UASP === 1) ? v0 : v1;          // anchor direction

      // Magnitudes of endpoints
      var m0 = 0, m1 = 0;
      for (var j = 0; j < dim; j++) { m0 += v0[j] * v0[j]; m1 += v1[j] * v1[j]; }
      m0 = Math.sqrt(m0); if (m0 < EPS) m0 = EPS;
      m1 = Math.sqrt(m1); if (m1 < EPS) m1 = EPS;

      var mag = expLerpScalarPow(m0, m1, u, EPS);

      // Normalize anchor direction (fallback to unit X if degenerate)
      var am = 0; for (var q = 0; q < dim; q++) am += axv[q] * axv[q];
      am = Math.sqrt(am);
      if (am < EPS) {
        for (var q2 = 0; q2 < dim; q2++) expVec[q2] = (q2 === 0) ? mag : 0;
      } else {
        var invAm = 1 / am;
        for (var q3 = 0; q3 < dim; q3++) expVec[q3] = axv[q3] * invAm * mag;
      }
    } else {
      // Per-component exponential
      for (var p = 0; p < dim; p++) {
        expVec[p] = expLerpScalarPow(v0[p], v1[p], u, EPS);
      }
    }

    // ---- blend with original (pre-expression) ----
    var w = 1 - BLEND;
    for (var b = 0; b < dim; b++) {
      expVec[b] = expVec[b] * BLEND + v[b] * w;
    }

    expVec;
  }
}
```
