# Continuous Groups - Multi-Key Gesture Easing

A keyframe-driven Adobe After Effects expression that treats a run of keyed values as a **continuous motion gesture** instead of easing every keyframe interval independently. One cubic-Bezier clock drives each detected group, while a spline reconstructs the value path through every waypoint in that group.

By default, authored keyframe **times and values remain exact arrival points**. The expression can automatically separate rests and unusually large timing gaps into new gestures, or those boundaries can be overridden explicitly. Scalar properties and flat numeric vectors are supported componentwise.

> **Important:** this expression reconstructs interpolation from key times and values. It does **not** read or preserve native Graph Editor temporal handles, spatial motion-path tangents, or arbitrary Hold interpolation. Apply it when the intended result is a new grouped easing system, not when native interpolation must remain semantically authoritative.

## What It Does

- Uses a single cubic-Bezier timing clock across each detected multi-key gesture rather than restarting the same ease independently on every interval.
- Preserves authored key values exactly; with the production default `timingFreedom: 0`, authored key **times** are exact waypoint-arrival times as well.
- Supports an arbitrary number of keyframes and scalar, 1D, 2D, 3D, or other flat numeric-vector values of consistent dimensionality.
- Uses **shape-preserving C1 interpolation** by default so each component stays within its surrounding keyed segment when no explicit Bezier-Y excess is requested.
- Provides an optional bounded **C2 quintic** mode and an optional **natural cubic C2** mode that may overshoot or reverse.
- Detects exact sampled rests and can separate them into gesture boundaries.
- Detects unusually prominent timing gaps using a local multiscale cadence heuristic, while avoiding a split when neighboring velocities strongly indicate continuing motion.
- Supports manual `splitAfter` and `joinAfter` overrides; explicit joins take precedence over automatic or forced splits.
- Allows Bezier Y handles outside `[0, 1]`. Their excess becomes an endpoint-relative, waypoint-corrected overshoot term rather than destroying ordered waypoint traversal.
- Preserves native/pre-expression output when input data is malformed, dimensions disagree, the numerical spline becomes untrustworthy, or the current time lies outside the keyed span.
- Includes overflow-resistant interpolation and spline-derivative calculations for pathological finite floating-point inputs.
- Requires After Effects' modern **JavaScript** expression engine.

## Compatibility

**Expression-language compatibility target: After Effects 16.0+ using the JavaScript expression engine.**

Use:

**File > Project Settings > Expressions > Expressions Engine > JavaScript**

The expression uses modern JavaScript features including `const`, `let`, arrow functions, `Set`, `Number.isFinite()`, `Number.isInteger()`, `Math.cbrt()`, `Math.expm1()`, `Math.log1p()`, and `Math.hypot()`. It is intentionally not written for the Legacy ExtendScript expression engine.

The implementation has been extensively validated numerically and in modeled expression-property environments, but this release was **not executed inside a native After Effects host during this audit**. See **Validation** and **Known Limits** below.

## Setup / Usage

1. Animate a numeric After Effects property with at least two keyframes.
2. Paste the complete JavaScript expression below onto that same property.
3. Leave the production defaults unchanged initially.
4. Adjust only the `CG` settings block at the top when the motion requires a different clock, interpolation model, grouping sensitivity, or manual split/join override.
5. If the source animation relies on native temporal handles, spatial path tangents, or Hold interpolation, verify that replacing those semantics is actually intended before using this expression.

The expression is particularly useful when several waypoint keys should read as one designed move rather than a chain of visibly restarted eases.

## Expression

Paste only this JavaScript block onto the target numeric property:

~~~js
/* Continuous Groups | production revision 2026-10-06.
   One Bezier clock per detected gesture; arbitrary number of keys.
   Default: exact key times/values, componentwise shape-preserving spline.
   C1/C2 describes the spline in carrier coordinates. Real-time continuity
   additionally requires a regular clock; split boundaries are value-continuous.
   Out-of-range Y handles add an endpoint-relative, waypoint-corrected excess.
   This rebuilds interpolation, not native AE handles, paths, or Hold keys.
   Paste on a numeric property using the JavaScript expression engine.
   Design limits and validation: see the repository Markdown documentation. */

const CG = {
    curve: [0.50, 0.00, 0.10, 1.00], // EDIT HERE: [x1, y1, x2, y2]
                                    // x1,x2: 0..1 inclusive; y1,y2: any finite number
    interpolation: "shape", // Base spline: "shape" bounded C1; "shapeC2" bounded C2;
                            // "smooth" natural cubic C2, may overshoot/reverse.
                            // Explicit out-of-range Y excess can defeat bounds.
    timingFreedom: 0,        // 0: exact key times; 1: full group easing of authored timing
    gapRatio: 4,             // relative-gap detection; 0 disables ONLY this heuristic
    splitAfter: [],          // optional 1-based interval indices, e.g. [3] splits k3--k4
    joinAfter: []            // override automatic/forced split at these interval indices
};

// Dimensionless roundoff tolerance for classification boundaries, never seconds.
const CG_EPSILON = 1e-9;

// Pure numerical core. No vector arithmetic overloading or frame-rate dependence.
function cgClamp01(x) { return Math.max(0, Math.min(1, x)); }

function cgNumeric(v) {
    if (typeof v === "number") return Number.isFinite(v);
    if (!Array.isArray(v) || v.length === 0) return false;
    for (let i = 0; i < v.length; i++) {
        if (!Number.isFinite(v[i])) return false;
    }
    return true;
}

function cgVector(v) { return typeof v === "number" ? [v] : v; }

function cgEqual(a, b) {
    const x = cgVector(a), y = cgVector(b);
    return x.length === y.length && x.every((v, i) => v === y[i]);
}

function cgMix(a, b, u) {
    if (u === 0) return a;
    if (u === 1) return b;
    const mix = (x, y) => {
        // Keep the origin-relative form for precision with nearby large values.
        // Opposite-sign finite endpoints can have an unrepresentable difference
        // even when the interpolated result is finite (e.g. -1e308 to +1e308).
        if (!Number.isFinite(y - x)) return (1 - u) * x + u * y;
        return u <= 0.5 ? x + (y - x) * u : y + (x - y) * (1 - u);
    };
    if (typeof a === "number") return mix(a, b);
    return a.map((v, i) => mix(v, b[i]));
}

// Standard cubic-Bezier easing domain. Reversed Y handles are valid too.
// Boundary X handles may create a genuine infinite time derivative; preserve
// their curve values rather than silently moving the supplied control points.
function cgValidCurve(c) {
    return Array.isArray(c) && c.length === 4 &&
        [0, 1, 2, 3].every(i => Number.isFinite(c[i])) &&
        c[0] >= 0 && c[0] <= 1 && c[2] >= 0 && c[2] <= 1;
}

function cgValidateSettings(settings, count) {
    const fail = message => { throw new Error("Continuous Groups: " + message); };
    if (!cgValidCurve(settings.curve)) {
        fail("curve requires [x1,y1,x2,y2]: four finite numbers with 0 <= x1,x2 <= 1; Y handles are unrestricted.");
    }
    if (["shape", "shapeC2", "smooth"].indexOf(settings.interpolation) < 0) {
        fail('interpolation must be "shape", "shapeC2", or "smooth".');
    }
    if (!Number.isFinite(settings.timingFreedom) || settings.timingFreedom < 0 || settings.timingFreedom > 1) {
        fail("timingFreedom must be a finite number from 0 to 1.");
    }
    if (!Number.isFinite(settings.gapRatio) || (settings.gapRatio !== 0 && settings.gapRatio <= 1)) {
        fail("gapRatio must be 0 (disabled) or a finite number greater than 1.");
    }
    ["splitAfter", "joinAfter"].forEach(name => {
        const list = settings[name];
        if (!Array.isArray(list)) {
            fail(name + " must be an array of positive, one-based key indices.");
        }
        for (let i = 0; i < list.length; i++) {
            if (!Number.isInteger(list[i]) || list[i] <= 0) {
                fail(name + " must be an array of positive, one-based key indices.");
            }
            if (count >= 2 && list[i] >= count) {
                fail(name + " contains an index with no following key; update it after changing the keys.");
            }
        }
    });
}

function cgBezierCoordinate(p, a, b) {
    const r = 1 - p;
    return (3 * r * r * p) * a + (3 * r * p * p) * b + p * p * p;
}

// Invert a monotone cubic coordinate with controls a,b in [0,1].
function cgBezierParameter(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Reflect only near the endpoint. Around a nearly stationary center,
    // rounding 1-b can change the intended root by much more than one ULP.
    if (x > 0.75) return 1 - cgBezierParameter(1 - x, 1 - b, 1 - a);
    if (a === 0 && b === 0) return Math.cbrt(x);
    if (a === 1 && b === 1) return -Math.expm1(Math.log1p(-x) / 3);
    // The only stationary interior X coordinate: X=.5+4*(p-.5)^3.
    // Use the analytic form near its center, the endpoint form for tiny x.
    if (a === 1 && b === 0 && x >= 0.125) return 0.5 + Math.cbrt((x - 0.5) / 4);
    let low = 0, high = Math.min(1, Math.cbrt(x));
    // Each nonnegative Bernstein term supplies an upper bound on the root.
    // Tighten the bracket when a tiny x1 makes the quadratic term dominate.
    const minimumRemainder = 1 - high;
    high = Math.min(high, x / (3 * minimumRemainder * minimumRemainder * a),
        Math.sqrt(x) / Math.sqrt(3 * minimumRemainder * b));
    let p = Math.min(high, x / (3 * a));
    const minimumPositive = Number.MIN_VALUE, precision = 8 * Number.EPSILON;
    const tolerance = Math.max(minimumPositive, precision * x);
    const coordinate = cgBezierCoordinate;
    const centerA = 1 + 3 * (a - b), centerB = 1.5 * ((1 - a) - b);
    const centerC = 0.75 * ((1 - a) + b), centerD = (0.5 - x) + 0.375 * ((a - 1) + b);
    const corner00 = (1 - a) * (1 - b), corner01 = (1 - a) * b;
    const corner10 = a * (1 - b), corner11 = a * b;
    // Relative residual precision avoids a fixed output floor near time zero.
    // A Newton proposal must remain bracketed; otherwise bisect the bracket.
    for (let i = 0; i < 128; i++) {
        const z = p - 0.5, r = 1 - p;
        // Center the residual near an almost-stationary middle. Forming X(p)
        // first would erase the small difference that identifies the root.
        const error = p >= 0.25 && p <= 0.75 ?
            ((centerA * z + centerB) * z + centerC) * z + centerD :
            coordinate(p, a, b) - x;
        // Convex combination of the four control-square corner derivatives:
        // all terms are nonnegative, even near a=1,b=0,p=.5.
        const derivative = 3 * (corner00 * p * p + corner01 * 2 * r * p +
            corner10 * (1 - 2 * p) * (1 - 2 * p) + corner11 * r * r);
        const parameterTolerance = Math.max(minimumPositive, precision * p);
        if (error === 0 || (Math.abs(error) <= tolerance && derivative > 0 &&
            Math.abs(error) / derivative <= parameterTolerance)) break;
        if (error < 0) low = p;
        else high = p;
        let next = derivative > 0 ? p - error / derivative : NaN;
        if (!Number.isFinite(next) || next <= low || next >= high) next = (low + high) / 2;
        if (next === p) break;
        p = next;
    }
    return p;
}

function cgBezier(x, c) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    if (x > 0.75) return 1 - cgBezierCoordinate(
        cgBezierParameter(1 - x, 1 - c[2], 1 - c[0]), 1 - c[3], 1 - c[1]);
    return cgBezierCoordinate(cgBezierParameter(x, c[0], c[2]), c[1], c[3]);
}

function cgCarrierCurve(c) {
    return [c[0], cgClamp01(c[1]), c[2], cgClamp01(c[3])];
}

// E-C directly from the handle differences; do not subtract nearly equal
// eased outputs. Endpoints of this global excess curve are exactly zero.
function cgCurveDelta(p, c) {
    const r = 1 - p;
    return (3 * r * r * p) * (c[1] - cgClamp01(c[1])) +
        (3 * r * p * p) * (c[3] - cgClamp01(c[3]));
}

function cgCurveSample(x, c) {
    const carrier = cgCarrierCurve(c);
    if (x <= 0) return { carrier: 0, delta: 0 };
    if (x >= 1) return { carrier: 1, delta: 0 };
    if (x > 0.75) {
        const p = cgBezierParameter(1 - x, 1 - c[2], 1 - c[0]), r = 1 - p;
        return {
            carrier: 1 - cgBezierCoordinate(p, 1 - carrier[3], 1 - carrier[1]),
            delta: (3 * r * r * p) * (c[3] - carrier[3]) +
                (3 * r * p * p) * (c[1] - carrier[1])
        };
    }
    const p = cgBezierParameter(x, c[0], c[2]);
    return { carrier: cgBezierCoordinate(p, carrier[1], carrier[3]), delta: cgCurveDelta(p, c) };
}

function cgMedian(values) {
    const a = values.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function cgNorm(v) { return Math.hypot.apply(null, v); }

function cgContinuingMotion(i, gaps, values) {
    const velocities = [i - 1, i, i + 1].map(j => {
        const a = cgVector(values[j]), b = cgVector(values[j + 1]);
        return a.map((v, d) => (b[d] - v) / gaps[j]);
    });
    const speeds = velocities.map(cgNorm);
    if (!speeds.every(v => v > 0 && Number.isFinite(v))) return false;
    const cosine = j => velocities[1].reduce((sum, v, d) =>
        sum + (v / speeds[1]) * (velocities[j][d] / speeds[j]), 0);
    return Math.max.apply(null, speeds) / Math.min.apply(null, speeds) <= 2 * (1 + CG_EPSILON) &&
        cosine(0) >= 0.95 - CG_EPSILON && cosine(2) >= 0.95 - CG_EPSILON;
}

// Local, multiscale classifier. Returns evidence records, not probabilities.
// Independent of current evaluation time; never groups differently per frame.
function cgAnalyze(times, values, sampleNative, settings) {
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const forcedJoins = new Set(settings.joinAfter), forcedSplits = new Set(settings.splitAfter);
    const decisive = gaps.map((duration, i) => {
        const index = i + 1;
        if (forcedJoins.has(index)) return { split: false, reason: "forced-join" };
        if (forcedSplits.has(index)) return { split: true, reason: "forced-split" };

        // Repeated keys are a rest candidate. Check native interior samples too.
        // Finite sampling is evidence, not proof against an arbitrary excursion.
        const flat = cgEqual(values[i], values[i + 1]) &&
            [0.25, 0.5, 0.75].every(f =>
                cgEqual(sampleNative(times[i] + duration * f), values[i]));
        return { split: flat, reason: flat ? "sampled-rest" : "moving" };
    });
    return gaps.map((duration, i) => {
        const initial = decisive[i];
        if (initial.split || initial.reason === "forced-join" || settings.gapRatio <= 1) return initial;
        const collect = direction => {
            const result = [];
            for (let j = i + direction; j >= 0 && j < gaps.length && result.length < 4; j += direction) {
                // Do not borrow cadence across another clear rest or an equally
                // large/larger gap. Use the initial mask, not scan-order decisions.
                if (decisive[j].split || gaps[j] >= duration * (1 - CG_EPSILON)) break;
                result.push(Math.log(gaps[j]));
            }
            return result;
        };
        const left = collect(-1), right = collect(1);
        if (!left.length || !right.length) return { split: false, reason: "no-two-sided-peak" };
        const baseline = side => {
            const median = cgMedian(side);
            const mad = cgMedian(side.map(v => Math.abs(v - median)));
            // Avoid extrapolating a fictitious slow cadence from just 1--2 gaps.
            return Math.min(Math.max.apply(null, side), median + 2 * 1.4826 * mad);
        };
        const scores = [], used = [];
        [1, 2, 4].forEach(radius => {
            const a = left.slice(0, radius), b = right.slice(0, radius);
            const signature = a.length + ":" + b.length;
            if (used.indexOf(signature) >= 0) return;
            used.push(signature);
            scores.push(Math.log(duration) - Math.max(baseline(a), baseline(b)));
        });
        const score = cgMedian(scores);
        const continuing = cgContinuingMotion(i, gaps, values);
        const split = score + CG_EPSILON >= Math.log(settings.gapRatio) && !continuing;
        return {
            split: split,
            reason: continuing ? "motion-continuation" : split ? "relative-gap" : "ordinary-spacing",
            logProminence: score,
            effectiveGapRatio: Math.exp(Math.min(score, 700)),
            scales: scores.length
        };
    });
}

function cgBreaks(times, values, sampleNative, settings) {
    return cgAnalyze(times, values, sampleNative, settings).map(record => record.split);
}

function cgEndpointSlope(h0, h1, d0, d1) {
    if (!Number.isFinite(d0) || !Number.isFinite(d1)) return NaN;
    if (d0 === 0 || d0 === d1) return d0;
    // Evaluate and limit in scaled coordinates before restoring units. The
    // original weighted numerator can overflow although the slope is finite.
    const hs = Math.max(h0, h1), ds = Math.max(Math.abs(d0), Math.abs(d1));
    const w = (h0 / hs) / (h0 / hs + h1 / hs);
    const m = (1 + w) * (d0 / ds) - w * (d1 / ds);
    if (Math.sign(m) !== Math.sign(d0)) return 0;
    if (Math.sign(d0) !== Math.sign(d1) && Math.abs(m) > 3 * (Math.abs(d0) / ds)) {
        return 3 * d0;
    }
    return m * ds;
}

function cgPchipSlopes(x, y) {
    const n = x.length;
    const h = x.slice(1).map((v, i) => v - x[i]);
    const d = h.map((v, i) => (y[i + 1] - y[i]) / v);
    if (n === 2) return [d[0], d[0]];
    const m = new Array(n).fill(0);
    m[0] = cgEndpointSlope(h[0], h[1], d[0], d[1]);
    m[n - 1] = cgEndpointSlope(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
    for (let i = 1; i < n - 1; i++) {
        if (d[i - 1] === 0 || d[i] === 0 || Math.sign(d[i - 1]) !== Math.sign(d[i])) continue;
        if (!Number.isFinite(d[i - 1]) || !Number.isFinite(d[i])) {
            m[i] = NaN;
            continue;
        }
        const hs = Math.max(h[i], h[i - 1]);
        const w1 = 2 * (h[i] / hs) + h[i - 1] / hs;
        const w2 = h[i] / hs + 2 * (h[i - 1] / hs);
        const weight = w1 / (w1 + w2);
        const small = Math.min(Math.abs(d[i - 1]), Math.abs(d[i]));
        // A scaled harmonic mean avoids reciprocal overflow for tiny secants.
        m[i] = Math.sign(d[i]) * (small / (weight * (small / Math.abs(d[i - 1])) +
            (1 - weight) * (small / Math.abs(d[i]))));
    }
    return m;
}

function cgHermite(x, y, m, i, q) {
    const h = x[i + 1] - x[i], r = (q - x[i]) / h;
    if (r === 0) return y[i];
    if (r === 1) return y[i + 1];
    const r2 = r * r, r3 = r2 * r;
    const origin = r <= 0.5 ? y[i] : y[i + 1];
    const residual = (2 * r3 - 3 * r2 + 1) * (y[i] - origin) +
        (r3 - 2 * r2 + r) * h * m[i] +
        (-2 * r3 + 3 * r2) * (y[i + 1] - origin) + (r3 - r2) * h * m[i + 1];
    return origin + residual;
}

// Optional bounded C2 construction, derived from a monotone quintic control
// polygon. S'' is zero at each knot IN EASED COORDINATES (not in real time).
// Limiting a shared tangent once preserves agreement on both sides of the key.
function cgQuinticSlopes(x, y) {
    const m = cgPchipSlopes(x, y);
    const factors = x.slice(1).map((v, i) => {
        const d = (y[i + 1] - y[i]) / (v - x[i]);
        const scale = Math.max(Math.abs(d), Math.abs(m[i]), Math.abs(m[i + 1]));
        if (!Number.isFinite(scale)) return NaN;
        if (scale === 0) return 1;
        const sum = Math.abs(m[i]) / scale + Math.abs(m[i + 1]) / scale;
        return sum === 0 ? 1 : Math.min(1, 2.5 * (Math.abs(d) / scale) / sum);
    });
    return m.map((v, i) => v * Math.min(i > 0 ? factors[i - 1] : 1,
                                      i < factors.length ? factors[i] : 1));
}

function cgQuintic(x, y, m, i, q) {
    const h = x[i + 1] - x[i], r = (q - x[i]) / h;
    if (r === 0) return y[i];
    if (r === 1) return y[i + 1];
    const origin = r <= 0.5 ? y[i] : y[i + 1];
    const left = y[i] - origin, right = y[i + 1] - origin;
    const a = h * m[i] / 5, b = h * m[i + 1] / 5;
    const p = [left, left + a, left + 2 * a,
               right - 2 * b, right - b, right];
    // de Casteljau keeps evaluation within the control polygon, up to rounding.
    for (let level = 5; level > 0; level--) {
        for (let j = 0; j < level; j++) p[j] = (1 - r) * p[j] + r * p[j + 1];
    }
    return origin + p[0];
}

// Natural cubic spline, tridiagonal solve for second derivatives.
// C2 inside a group; may overshoot values and bow outside a Position rectangle.
function cgNaturalSecond(x, y) {
    const n = x.length;
    const upper = new Array(n).fill(0), rhs = new Array(n).fill(0);
    const second = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
        const left = x[i] - x[i - 1], right = x[i + 1] - x[i];
        const diagonal = 2 * (left + right) - left * upper[i - 1];
        upper[i] = right / diagonal;
        rhs[i] = (6 * ((y[i + 1] - y[i]) / right - (y[i] - y[i - 1]) / left) -
            left * rhs[i - 1]) / diagonal;
    }
    for (let i = n - 2; i > 0; i--) second[i] = rhs[i] - upper[i] * second[i + 1];
    return second;
}

function cgNaturalValue(x, y, second, i, q) {
    const h = x[i + 1] - x[i], a = (x[i + 1] - q) / h, b = (q - x[i]) / h;
    if (b === 0) return y[i];
    if (a === 0) return y[i + 1];
    const origin = b <= 0.5 ? y[i] : y[i + 1];
    const residual = a * (y[i] - origin) + b * (y[i + 1] - origin) +
        ((a * a * a - a) * second[i] + (b * b * b - b) * second[i + 1]) * h * h / 6;
    return origin + residual;
}

// Use the original values normally. Only retry in power-of-two-scaled units
// when derivative construction or evaluation overflows. Never center the entire
// group: doing that can erase small but representable differences near zero.
// NaN is an explicit failure signal to the adapter, which preserves native value.
function cgSplineValue(x, y, segment, q, interpolation) {
    const derivatives = interpolation === "smooth" ? cgNaturalSecond :
        interpolation === "shapeC2" ? cgQuinticSlopes : cgPchipSlopes;
    const evaluate = interpolation === "smooth" ? cgNaturalValue :
        interpolation === "shapeC2" ? cgQuintic : cgHermite;
    let data = derivatives(x, y);
    let result = data.every(v => Number.isFinite(v)) ? evaluate(x, y, data, segment, q) : NaN;
    if (Number.isFinite(result)) return result;

    const magnitude = y.reduce((maximum, v) => Math.max(maximum, Math.abs(v)), 0);
    if (!Number.isFinite(magnitude) || magnitude === 0) return NaN;
    const scale = Math.pow(2, Math.min(1023, Math.floor(Math.log2(magnitude))));
    const normalized = y.map(v => v / scale);
    // Decline a retry that would destroy a nonzero value or a distinct waypoint.
    if (normalized.some((v, i) => (y[i] !== 0 && v === 0) ||
        (i > 0 && y[i] !== y[i - 1] && v === normalized[i - 1]))) return NaN;
    data = derivatives(x, normalized);
    if (!data.every(v => Number.isFinite(v))) return NaN;
    result = evaluate(x, normalized, data, segment, q) * scale;
    return result;
}

function cgGroup(currentTime, times, values, first, last, settings) {
    const start = times[first], duration = times[last] - start;
    const u = cgClamp01((currentTime - start) / duration);
    if (u === 0) return values[first];
    if (u === 1) return values[last];

    const curve = settings.curve, carrier = cgCarrierCurve(curve);
    if (last === first + 1) return cgMix(values[first], values[last], cgBezier(u, curve));
    const freedom = cgClamp01(settings.timingFreedom);
    const hasExcess = curve[1] !== carrier[1] || curve[3] !== carrier[3];
    // Exact authored times are authoritative. Carrier progress alone can round
    // to a knot while the unrestricted-Y residual is still changing nearby.
    if (freedom === 0) {
        for (let i = first + 1; i < last; i++) {
            if (currentTime === times[i]) return values[i];
        }
    }
    const samples = times.slice(first, last + 1).map(t => cgCurveSample((t - start) / duration, curve));
    const x = times.slice(first, last + 1).map((t, i) => {
        const authored = (t - start) / duration;
        return (1 - freedom) * samples[i].carrier + freedom * authored;
    });
    const current = cgCurveSample(u, curve), q = current.carrier;
    // An extreme key distribution can collapse two knots in floating point.
    // The caller preserves the native value if no numerically valid spline exists.
    if (x.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= x[i - 1]))) return null;
    let segment = 0;
    while (segment < x.length - 2 && q > x[segment + 1]) segment++;
    if (!hasExcess && q === x[segment]) return values[first + segment];
    if (!hasExcess && q === x[segment + 1]) return values[first + segment + 1];
    // Unrestricted Y may revisit the same raw progress. Traverse the ordered
    // carrier once and add the raw excess, corrected at every waypoint by ONE
    // shared natural cubic. At freedom=0 these are authored arrival times.
    // Scaling by the group endpoint displacement keeps the extension relative.
    let excess = 0;
    if (hasExcess) {
        const deltas = x.map((v, i) => freedom === 0 ? samples[i].delta :
            cgCurveDelta(cgBezierParameter(v, carrier[1], carrier[3]), curve));
        excess = current.delta - cgNaturalValue(x, deltas, cgNaturalSecond(x, deltas), segment, q);
    }
    const vectors = values.slice(first, last + 1).map(cgVector);
    const result = vectors[0].map((unused, dimension) => {
        // Compute shared derivative data from the original values. Center only
        // evaluation within its segment: changing the origin before computing
        // slopes can erase small differences elsewhere and break continuity.
        const y = vectors.map(v => v[dimension]);
        const interpolated = cgSplineValue(x, y, segment, q, settings.interpolation);
        return hasExcess ? interpolated + (y[y.length - 1] - y[0]) * excess : interpolated;
    });
    return typeof values[first] === "number" ? result[0] : result;
}

function cgEvaluate(currentTime, times, values, breaks, settings) {
    if (currentTime <= times[0]) return values[0];
    if (currentTime >= times[times.length - 1]) return values[values.length - 1];
    let interval = 0;
    while (interval < times.length - 2 && currentTime >= times[interval + 1]) interval++;

    if (breaks[interval]) {
        // A flat separator stays flat. A forced/spacing-based nonflat separator
        // becomes a two-key eased bridge; it never teleports or invents a hold.
        const u = (currentTime - times[interval]) / (times[interval + 1] - times[interval]);
        return cgMix(values[interval], values[interval + 1], cgBezier(u, settings.curve));
    }
    let first = interval, last = interval + 1;
    while (first > 0 && !breaks[first - 1]) first--;
    while (last < times.length - 1 && !breaks[last]) last++;
    return cgGroup(currentTime, times, values, first, last, settings);
}

// AE adapter. This property supplies key data; native sampling never evaluates
// this same expression recursively. No unsupported scripting API calls.
function cgExpression() {
    cgValidateSettings(CG, numKeys);
    if (numKeys < 2 || !cgNumeric(value)) return value;
    const firstKey = key(1), lastKey = key(numKeys);
    if (time < firstKey.time || time > lastKey.time) return value;
    const times = [], values = [];
    let exactKey = -1;
    for (let i = 1; i <= numKeys; i++) {
        const currentKey = i === 1 ? firstKey : i === numKeys ? lastKey : key(i);
        times.push(currentKey.time);
        values.push(currentKey.value);
        if (time === currentKey.time) exactKey = i - 1;
    }
    if (!cgNumeric(values[0])) return value;
    const dimensions = cgVector(values[0]).length;
    const scalar = typeof values[0] === "number";
    if (!Number.isFinite(time) || times.some((t, i) => !Number.isFinite(t) ||
        (i > 0 && t <= times[i - 1])) ||
        (typeof value === "number") !== scalar || cgVector(value).length !== dimensions ||
        !values.every(v => cgNumeric(v) && (typeof v === "number") === scalar &&
        cgVector(v).length === dimensions)) return value;
    // Key arrival and two-key results do not depend on gesture classification.
    // Avoid native sampling where it cannot change the output.
    if (exactKey >= 0 && (CG.timingFreedom === 0 || exactKey === 0 || exactKey === numKeys - 1)) {
        return values[exactKey];
    }
    const breaks = numKeys === 2 ? [false] :
        cgBreaks(times, values, t => thisProperty.valueAtTime(t), CG);
    const result = cgEvaluate(time, times, values, breaks, CG);
    return result !== null && cgNumeric(result) ? result : value;
}

cgExpression();

~~~

## Production Defaults

| Setting | Default | Purpose |
| --- | --- | --- |
| **`curve`** | **`[0.50, 0.00, 0.10, 1.00]`** | Cubic-Bezier timing clock in `[x1, y1, x2, y2]` form. X handles must remain within `[0,1]`; Y handles may be any finite values. |
| **`interpolation`** | **`"shape"`** | Componentwise base spline. `"shape"` = bounded C1; `"shapeC2"` = bounded quintic C2 in carrier coordinates; `"smooth"` = natural cubic C2 that may overshoot/reverse. |
| **`timingFreedom`** | **`0`** | `0` keeps authored key times as exact waypoint arrivals. `1` allows the group clock to fully retime those interior arrivals. Values between blend the two timing layouts. |
| **`gapRatio`** | **`4`** | Sensitivity for automatic relative-gap splitting. `0` disables only this timing-gap heuristic; sampled rests and explicit splits can still create boundaries. |
| **`splitAfter`** | **`[]`** | Optional one-based interval indices to force a split after a key, e.g. `[3]` splits key 3 from key 4. |
| **`joinAfter`** | **`[]`** | Optional one-based interval indices that force continuity across a boundary and override automatic or forced splitting there. |

The recommended production starting point is to keep these defaults unchanged and use manual split/join overrides only when the automatic gesture interpretation disagrees with the intended motion.

## How It Works

### 1. A gesture gets one clock

For a detected group spanning several keys, time is normalized across the entire group and evaluated through the configured cubic-Bezier timing curve. That produces one shared progress clock instead of a new ease restarting between every neighboring pair.

For a two-key group, the result is simply the two endpoint values mixed by that Bezier clock. For groups with three or more keys, the clock feeds a spline that passes through the interior waypoints.

### 2. `timingFreedom` controls waypoint-arrival authority

The expression separates **authored time** from **carrier-clock progress**.

With the default:

~~~text
timingFreedom = 0
~~~

interior carrier knots are positioned so that every authored key time still lands on its exact authored value. You get one continuous group-level clock without moving the waypoint arrivals in time.

At:

~~~text
timingFreedom = 1
~~~

interior knots use their normalized authored positions while the current sample follows the eased carrier clock. The Bezier clock can therefore move the effective waypoint arrivals earlier or later.

Intermediate values blend between those two interpretations.

### 3. The default `shape` mode uses a monotone PCHIP-style spline

For each numeric component, `shape` constructs shape-preserving cubic Hermite slopes. Sign changes and flat secants receive zero tangent where needed, while continuing monotone motion retains a shared nonzero tangent.

Without an explicit out-of-range Y-handle excess, each component remains bounded by the neighboring keyed values for that segment. This makes `shape` the safest general-purpose production default.

### 4. `shapeC2` adds a bounded quintic option

`shapeC2` begins from the same shape-preserving tangent estimates, then applies a shared tangent limiter and evaluates a monotone quintic control polygon with de Casteljau interpolation.

Its second derivative is zero at each knot **in carrier/eased coordinates**, giving a bounded C2 construction there. That statement is intentionally not generalized into an unconditional real-time C2 guarantee: a singular timing clock can still produce a singular real-time derivative.

### 5. `smooth` uses a natural cubic spline

`smooth` solves the standard natural-cubic tridiagonal system for each component. It is C2 inside a valid group and can produce broader, softer trajectories than the bounded modes.

Unlike `shape` and `shapeC2`, natural cubic interpolation is allowed to overshoot keyed component ranges or reverse locally. On Position, that also means the componentwise path may bow outside the rectangle implied by neighboring points.

### 6. Gesture boundaries are evidence-based

The grouping pass evaluates each interval independently of the current frame, so a gesture does not change membership from frame to frame.

A boundary can come from:

1. an explicit `splitAfter` entry;
2. a repeated-value interval whose native value is also unchanged at 25%, 50%, and 75% of the interval;
3. a sufficiently prominent timing gap relative to nearby cadence.

The relative-gap classifier uses neighboring log-duration statistics at several local scales. It refuses to infer cadence when there is not useful evidence on both sides and will not split a large gap when three neighboring interval velocities strongly indicate continuing motion.

`joinAfter` wins over every automatic or forced split at the same interval.

### 7. Split intervals remain value-continuous

A sampled flat rest remains flat. A nonflat interval that is separated because of manual or timing-gap logic becomes an ordinary two-key Bezier bridge. The expression does not teleport between values and does not invent a Hold.

Velocity or acceleration does **not** necessarily match across a split boundary. The guarantee there is value continuity.

### 8. Out-of-range Y handles create corrected excess motion

The X handles always define an ordered timing domain. For the group carrier, Y handles are clamped to `[0,1]` so waypoint traversal stays ordered.

If the authored Y handles extend below 0 or above 1, the difference between the unrestricted curve and that carrier is retained as a separate excess term. A shared natural-cubic correction forces that excess back through the relevant waypoint constraints, and the excess is scaled by the group's endpoint displacement.

This means explicit Y-handle overshoot can intentionally defeat the ordinary boundedness of `shape` or `shapeC2`. A closed loop whose first and last values are identical has zero endpoint displacement, so this endpoint-relative global excess is intentionally absent there.

### 9. Exact keys and simple paths avoid unnecessary sampling

With the default exact-timing mode, evaluation directly on an authored key can return that key value before gesture classification. Two-key properties likewise do not need a grouping decision.

Those fast paths avoid `valueAtTime()` probes when the classification result cannot alter the answer.

### 10. Numerical failure degrades to native output

The production implementation includes several defensive numerical safeguards:

- opposite-sign finite endpoints can be mixed without overflowing their difference when the correct interpolated result is still finite;
- PCHIP endpoint and interior slope calculations are normalized before vulnerable weighted arithmetic;
- quintic tangent limiting is ratio-scaled so `Infinity / Infinity` is not introduced by intermediate magnitude alone;
- if a multi-key spline still becomes non-finite, it is retried in power-of-two-scaled value units;
- that retry is rejected if scaling would erase a nonzero value or merge distinct waypoints;
- malformed key times, malformed first-key values, dimension mismatches, collapsed carrier knots, and unrepresentable final results fall back to the native/pre-expression value rather than emitting a fabricated result.

These branches are defensive. They are not intended to alter ordinary motion-design value ranges.

## Behavioral Sanity Checks

| Scenario | Expected behavior |
| --- | --- |
| No keyframes / one keyframe | Native/pre-expression value passes through unchanged. |
| Time before first key or after last key | Native/pre-expression value passes through unchanged. |
| Exactly two numeric keys | One Bezier clock mixes the two endpoints; multi-key spline mode is irrelevant. |
| Three or more ordinary monotone keys, default settings | One group clock, exact authored waypoint arrivals, bounded shape-preserving component interpolation. |
| Interior local maximum/minimum in `shape` | Tangent is flattened as needed to avoid shape-breaking overshoot. |
| `shapeC2` | Bounded quintic interpolation with zero knot second derivatives in carrier coordinates. |
| `smooth` | Natural-cubic C2 interpolation; overshoot/reversal is permitted. |
| Equal neighboring keyed values and sampled native rest | Boundary is split as a rest. |
| Equal keyed endpoints but sampled native interior excursion | Not classified as a flat rest by those samples. |
| Isolated large timing gap | Splits when prominence exceeds `gapRatio`, unless continuing-motion evidence overrides it. |
| `gapRatio: 0` | Relative-gap splitting is disabled; rest and manual boundaries still work. |
| Same interval in both `splitAfter` and `joinAfter` | Explicit join wins. |
| Bezier Y outside `[0,1]` | Waypoint-corrected endpoint-relative excess is added to the ordered carrier result. |
| Invalid setting | Explicit `Continuous Groups:` configuration error is thrown. |
| Malformed/non-finite host data | Native value is preserved where a reliable custom result cannot be produced. |

## Validation

The production audit covered the executable numerical core, the After Effects-facing adapter logic, classification behavior, continuity/boundedness properties, pathological floating-point cases, and regression parity.

### Current production-source checks

After the final branding/header cleanup, the current source was revalidated with:

- **51 / 51 expression regression and property tests passed**, zero failures or skips;
- **6 / 6 modeled AE adapter/runner tests passed**, including guard and cleanup paths;
- Node JavaScript syntax validation passed;
- TypeScript 5.8.3 `checkJs` against an **ES2018** target passed;
- a namespace/branding scan found no old branded identifiers or standalone branded name;
- the final expression entry point appears exactly once and the file ends cleanly with a newline.

The test coverage includes exact key arrivals, two-key equivalence, scalar through 4D numeric values, all three spline modes, boundedness, real-time derivative agreement under regular clocks, overshoot correction, rest/gap classification, forced joins/splits, malformed data, deterministic repeated evaluation, a **2,000-key** stress case, and the numerical regressions repaired during the audit.

### Independent numerical cross-checks

The executable implementation was independently compared against high-precision and external numerical references before the final comment-only polish:

- **700** Bezier-inversion cases against independent **100-digit bisection**, with maximum parameter relative error approximately **1.87e-15**;
- **49,194 scalar spline comparisons** over **250 datasets** against SciPy `PchipInterpolator`, natural `CubicSpline`, and `BPoly` reference constructions;
- a selected **10-dataset** natural-cubic cross-check against an independent **100-digit dense LU solve**;
- **3,420 complete-group scalar samples** across **180 datasets** against an independent reconstruction using separate Bezier inversion and interpolation machinery;
- **36,600 original-versus-repaired evaluations** covering **91,500 numeric components**, with **6,119 classifier intervals** unchanged and maximum normalized output difference approximately **2.83e-16** in the ordinary representable comparison domain.

The later namespace de-branding was mechanically equivalence-checked against that executable implementation, and the current source's unit, adapter, syntax, and ES2018 static checks were rerun after the final header polish.

**Scope limitation:** these results establish strong JavaScript, mathematical, and adapter-level evidence. They do **not** replace running the expression inside a real After Effects host and visually accepting the intended motion in the production comp.

## Performance Notes

The expression necessarily scans the keyed property and performs group analysis, so evaluation cost grows with key count. A Node-based adapter microbenchmark showed that the extra numerical safeguards add measurable arithmetic cost on non-key multi-key evaluations, while exact-key paths became faster through early return.

That benchmark is not an After Effects performance measurement and no blanket speed claim is made. For ordinary motion-design key counts this is principally a correctness/robustness tradeoff; very large procedural key counts should still be profiled in the actual comp.

## Known Limits

- **Native Graph Editor handles are not reconstructed.** The expression operates from key times/values and native sampling used for limited grouping evidence; it does not read hidden temporal Bezier ease metadata.
- **Spatial motion paths are not preserved.** Vector properties are reconstructed componentwise. Position therefore follows the generated component splines, not native spatial Bezier tangents.
- **Arbitrary Hold interpolation is not preserved.** A repeated-value interval can be recognized as a sampled rest, but a Hold between different endpoint values is not treated as authoritative native interpolation.
- **Automatic grouping is heuristic.** Sampled rest detection and relative-gap classification are evidence-driven rather than semantic metadata. Use `splitAfter` / `joinAfter` when a boundary must be explicit.
- **Rest detection is finitely sampled.** A deliberately exotic native curve could theoretically match the first key at the three probe points while moving elsewhere inside the interval.
- **C1/C2 labels describe the spline in carrier coordinates.** Real-time derivative continuity additionally requires a regular timing clock. Boundary X handles can intentionally create singular derivatives.
- **Split boundaries guarantee value continuity, not universal velocity/acceleration continuity.**
- **Out-of-range Y handles intentionally permit excess motion.** They can push the final output beyond the ordinary bounded range of the base `shape` / `shapeC2` spline.
- **Natural cubic mode can overshoot and reverse.** That is the purpose of the `smooth` option, not a failure of its bounds.
- **Endpoint-relative excess disappears on a closed loop.** If the first and last group values are identical, their displacement is zero and the global excess scale is therefore zero.
- **Large key counts cost more per evaluation.** The implementation is designed for correctness and robustness rather than constant-time lookup over thousands of keys.
- **Modern JavaScript only.** Legacy ExtendScript is not a compatibility target.
- **No native AE host/render validation was performed in this audit.** Final host/visual acceptance remains the last production gate.

## Research / Numerical Basis

The implementation combines standard numerical ideas rather than depending on native AE interpolation metadata:

1. cubic-Bezier timing with monotone X-domain inversion;
2. PCHIP-style shape-preserving cubic Hermite interpolation;
3. a monotone quintic Bezier/control-polygon construction for bounded C2 carrier-space interpolation;
4. natural cubic splines for the optional free-smoothing mode;
5. local robust timing statistics for gesture-gap evidence;
6. scale-normalized arithmetic and finite-result fallbacks for floating-point robustness.

The automatic grouping layer is project-specific logic built on top of those numerical components; it should be understood as a motion-design heuristic, not as a claim that After Effects exposes semantic gesture boundaries.

## Sources

### Adobe / After Effects

- [Adobe Help Center - Expression basics](https://helpx.adobe.com/after-effects/desktop/work-with-expressions/expression-basics/expression-basics.html)
- [Adobe Help Center - Syntax differences between expression engines](https://helpx.adobe.com/after-effects/desktop/work-with-expressions/expression-basics/legacy-and-extend-script-engine.html)
- [Adobe Help Center - Expression language reference](https://helpx.adobe.com/after-effects/desktop/work-with-expressions/expression-language-reference/expression-language-reference.html)
- [After Effects Expression Reference - Property](https://ae-expressions.docsforadobe.dev/objects/property/)
- [After Effects Expression Reference - Key](https://ae-expressions.docsforadobe.dev/objects/key/)

### Numerical references used for independent validation

- [SciPy - PchipInterpolator](https://docs.scipy.org/doc/scipy/reference/generated/scipy.interpolate.PchipInterpolator.html)
- [SciPy - CubicSpline](https://docs.scipy.org/doc/scipy/reference/generated/scipy.interpolate.CubicSpline.html)
- [SciPy - BPoly](https://docs.scipy.org/doc/scipy/reference/generated/scipy.interpolate.BPoly.html)