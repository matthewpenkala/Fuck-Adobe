# Continuous Groups - Multi-Key Gesture Easing

A keyframe-driven Adobe After Effects expression that treats related waypoint keys as one **continuous motion gesture** instead of restarting the same ease independently on every interval. One cubic-Bezier clock drives each detected group, while a spline reconstructs the numeric value path through every waypoint in that group.

The production default now uses **sampling-aware adaptive grouping**. The timing detector still identifies unusually prominent gaps, but a proposed split can be suppressed when the surrounding keyed motion provides bounded predictive evidence that the long interval belongs to the same gesture—for example constant acceleration, a short constant-rate turn, or a fixed-direction exponential rate change.

By default, authored keyframe **times and values remain exact arrival points**. Scalar properties and flat numeric vectors of consistent dimensionality are supported componentwise.

> **Important:** this expression reconstructs interpolation from numeric key times and values. It does **not** read or preserve native Graph Editor temporal handles, spatial motion-path tangents, or arbitrary Hold interpolation. Automatic grouping is an evidence-based motion-design heuristic, not recovered semantic intent; `splitAfter` and `joinAfter` remain authoritative when the intended grouping is known.

## What It Does

- Uses one cubic-Bezier timing clock across each detected multi-key gesture rather than restarting the same ease on every neighboring pair.
- Preserves authored key values exactly; with the production default `timingFreedom: 0`, authored key **times** remain exact waypoint-arrival times as well.
- Supports an arbitrary number of keys and scalar, 1D, 2D, 3D, or other flat numeric-vector values of consistent dimensionality.
- Uses **shape-preserving C1 interpolation** by default so each component remains within its neighboring keyed range when no explicit Bezier-Y excess is requested.
- Provides an optional bounded **C2 quintic** mode and an optional **natural cubic C2** mode that may overshoot or reverse.
- Detects sampled rests and unusually prominent local timing gaps while keeping explicit split/join controls available.
- Uses **adaptive continuation evidence** on proposed timing splits: affine samples, constant acceleration, short-arc constant turn, fixed-direction exponential rate, and—only with additional independent flank data—quadratic velocity.
- Treats the historical 0.95 direction cosine and 2x speed-ratio criteria only as a **soft near-constant prior** in adaptive mode rather than the sole hard continuation veto.
- Bounds how much non-affine motion evidence can cancel a timing split, so an attractive local model cannot erase an arbitrarily large pause-like gap.
- Retains `grouping: "legacy"` for the previous classifier when an existing project must reproduce the prior grouping policy.
- Builds motion features from normalized displacement direction and logarithmic speed to avoid unnecessary overflow/underflow in extreme finite values.
- Allows Bezier Y handles outside `[0,1]`; their excess becomes an endpoint-relative, waypoint-corrected term rather than destroying ordered waypoint traversal.
- Preserves native/pre-expression output when host data is malformed, dimensions disagree, a time span is not representable, carrier knots collapse numerically, or a trustworthy spline result cannot be produced.
- Requires After Effects' modern **JavaScript** expression engine.

## Compatibility

**Expression-language compatibility target: After Effects 16.0+ using the JavaScript expression engine.**

Use:

**File > Project Settings > Expressions > Expressions Engine > JavaScript**

Adobe documents the JavaScript expression engine introduced with After Effects 16.0 as being based on ECMAScript 2018. The expression intentionally uses modern JavaScript syntax and standard-library features such as `const`, `let`, arrow functions, `Set`, object spread, `Number.isFinite()`, `Number.isInteger()`, `Number.EPSILON`, `Math.cbrt()`, `Math.expm1()`, `Math.log1p()`, and `Math.hypot()`.

The implementation has been validated numerically, in modeled property environments, and in disposable native After Effects 25.6.5 JavaScript-engine jobs. The language target above is broader than the native version tested. See **Validation** for the precise acceptance scope and remaining render/performance limits.

## Setup / Usage

1. Animate a finite numeric After Effects property with at least two keyframes.
2. Paste the complete JavaScript expression below onto that same property.
3. Start with the production defaults unchanged: `shape`, `timingFreedom: 0`, and `grouping: "adaptive"`.
4. Use `splitAfter` or `joinAfter` when you know a boundary's intended semantics. These are one-based **interval** indices: `[3]` refers to the interval from key 3 to key 4.
5. Use `grouping: "legacy"` only when you deliberately want the previous continuation classifier for compatibility or comparison.
6. If the source animation relies on native temporal handles, spatial path tangents, or Hold interpolation, verify that replacing those semantics is intended before applying this expression.

A split does not teleport between values. A nonflat separated interval becomes an ordinary two-key Bezier bridge; a sampled flat rest remains flat.

Use continuous numeric properties whose component metric makes sense for the animation. A numeric dropdown or layer index is not made continuous by this expression. Position is measured in the property's supplied coordinates, including its parent-relative coordinates; the grouping metric is not automatically screen-space distance. Separated Position followers run independently on their own scalar keys, so their group boundaries can differ from a combined Position property.

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
    grouping: "adaptive",   // "adaptive": predictive evidence; "legacy": prior classifier
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
    // Keyed values are validated by the adapter. Guard malformed native rest
    // probes here without rescanning every valid key's numeric components.
    if (typeof a === "number") return typeof b === "number" && a === b;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    // An indexed comparison must visit holes in malformed native arrays too.
    // Array.every() would silently skip them and could accept a false rest.
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
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

function cgAddExcess(base, first, last, excess) {
    if (excess === 0 || first === last) return base;
    const result = base + (last - first) * excess;
    if (Number.isFinite(result)) return result;
    // Opposite-sign endpoints or a cancelling product can overflow before
    // the final sum. Halve all value terms before restoring their units.
    return (base / 2 + (last / 2 - first / 2) * excess) * 2;
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
    if (settings.grouping !== undefined && ["adaptive", "legacy"].indexOf(settings.grouping) < 0) {
        fail('grouping must be "adaptive" or "legacy".');
    }
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

// Grouping policy, not learned probabilities or physical laws. Model parameters
// adapt to the local keys; tolerances remain explicit, bounded design choices.
const CG_GROUP_POLICY = {
    priorCosine: 0.95,               // soft near-constant prior, no longer sole veto
    priorSpeedRatio: 2,
    relativePredictionTolerance: 0.12, // quality = 0.5 at a 12% prediction error
    maximumLogGapCredit: Math.log(4),  // soft evidence cannot erase arbitrary gaps
    affineRoundoff: 1024 * Number.EPSILON,
    parallelTolerance: 1e-8,
    antipodalTolerance: 1e-6
};

function cgDot(a, b) { return a.reduce((s, v, d) => s + v * b[d], 0); }

// Scale displacement before taking its norm; store speed logarithmically.
// Dividing a displacement by a duration first can overflow/underflow even when
// its direction and speed ratios are perfectly meaningful.
function cgMotionFeature(a, b, duration) {
    if (!(duration > 0) || !Number.isFinite(duration)) return null;
    const av = cgVector(a), bv = cgVector(b);
    let delta = av.map((v, d) => bv[d] - v), logFactor = 0;
    if (!delta.every(Number.isFinite)) {
        delta = av.map((v, d) => bv[d] / 2 - v / 2);
        logFactor = Math.LN2;
    }
    const scale = delta.reduce((s, v) => Math.max(s, Math.abs(v)), 0);
    if (!(scale > 0) || !Number.isFinite(scale)) return null;
    const unit = delta.map(v => v / scale), length = cgNorm(unit);
    if (!(length > 0) || !Number.isFinite(length)) return null;
    return {
        unit: unit.map(v => v / length),
        logSpeed: Math.log(scale) + Math.log(length) + logFactor - Math.log(duration)
    };
}

function cgSinc(x) {
    if (Math.abs(x) < 1e-4) {
        const z = x * x;
        return 1 - z / 6 + z * z / 120;
    }
    return Math.sin(x) / x;
}

// log(sinh(x)/x), evaluated without overflow or near-zero cancellation.
function cgLogSinhc(x) {
    const a = Math.abs(x);
    if (a < 1e-3) {
        const z = a * a;
        return z / 6 - z * z / 180 + z * z * z / 2835;
    }
    return a + Math.log(-Math.expm1(-2 * a)) - Math.log(2 * a);
}

function cgPredictionError(predicted, observed) {
    if (!predicted || !predicted.every(Number.isFinite)) return Infinity;
    const scale = Math.max(cgNorm(predicted), cgNorm(observed));
    if (!(scale > 0) || !Number.isFinite(scale)) return Infinity;
    // Normalize first: extrapolated model values may be much larger than data.
    return cgNorm(predicted.map((v, d) => v / scale - observed[d] / scale));
}

// Small reorthogonalized QR fit for interval-averaged quadratic velocity.
// It is used only with extra outer observations; fitting a cubic POSITION curve
// through four keys would otherwise explain every possible four-key input.
function cgQuadraticVelocityFit(records, scale) {
    if (records.length < 3) return null;
    const basis = r => {
        const x = (r.midpoint - 0.5) / scale, h = r.width / scale;
        return [1, x, x * x + h * h / 12];
    };
    const rows = records.map(basis), q = [], upper = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let j = 0; j < 3; j++) {
        let column = rows.map(row => row[j]);
        for (let pass = 0; pass < 2; pass++) {
            for (let k = 0; k < j; k++) {
                const projection = cgDot(q[k], column);
                upper[k][j] += projection;
                column = column.map((v, r) => v - projection * q[k][r]);
            }
        }
        upper[j][j] = cgNorm(column);
        // Conditioning guard, not a positional movement dead band.
        if (!(upper[j][j] > 1e-10)) return null;
        q[j] = column.map(v => v / upper[j][j]);
    }
    const coefficients = records[0].vector.map((unused, d) => {
        const y = records.map(r => r.vector[d]);
        const c = q.map(column => cgDot(column, y));
        for (let j = 2; j >= 0; j--) {
            for (let k = j + 1; k < 3; k++) c[j] -= upper[j][k] * c[k];
            c[j] /= upper[j][j];
        }
        return c;
    });
    return r => {
        const row = basis(r);
        return coefficients.map(c => cgDot(c, row));
    };
}

// Predict the candidate using the two closest OUTER intervals, never the
// candidate itself. Further outer intervals are held-out validation evidence,
// not a license to inflate a noise tolerance. The window is bounded on each side
// by the same decisive rests/splits and equal-or-larger gaps used by timing.
function cgMotionEvidence(i, gaps, values, left, right, cache) {
    const policy = CG_GROUP_POLICY;
    const empty = { score: 0, model: "unresolved", support: 0, residual: null, affine: false };
    if (!left.length || !right.length) return empty;
    const indices = left.slice().reverse().concat([i], right);
    const records = [];
    let reference = -Infinity;
    for (let k = 0; k < indices.length; k++) {
        const j = indices[k];
        if (cache[j] === undefined) cache[j] = cgMotionFeature(values[j], values[j + 1], gaps[j]);
        const feature = cache[j];
        if (!feature) return empty; // zero displacement supplies no heading evidence
        reference = Math.max(reference, feature.logSpeed);
        records.push({ index: j, feature: feature, width: gaps[j] / gaps[i], midpoint: 0, vector: [] });
    }
    // Gap-local time avoids subtracting large absolute midpoint times.
    const center = left.length;
    records[center].midpoint = 0.5;
    let edge = 0;
    for (let k = center - 1; k >= 0; k--) {
        records[k].midpoint = edge - records[k].width / 2;
        edge -= records[k].width;
    }
    edge = 1;
    for (let k = center + 1; k < records.length; k++) {
        records[k].midpoint = edge + records[k].width / 2;
        edge += records[k].width;
    }
    for (let k = 0; k < records.length; k++) {
        const r = records[k], magnitude = Math.exp(r.feature.logSpeed - reference);
        if (!(r.width > 0) || !Number.isFinite(r.midpoint) || !(magnitude > 0)) return empty;
        r.vector = r.feature.unit.map(v => v * magnitude);
    }
    const L = records[center - 1], R = records[center + 1], G = records[center];
    const span = R.midpoint - L.midpoint;
    const support = Math.min(left.length, right.length) / (1 + Math.min(left.length, right.length));
    // Preserve the established sparse-key affine invariant. This proves only
    // compatibility of these sampled secants, NOT the animator's semantic intent.
    const affineError = Math.max.apply(null, records.map(r => cgPredictionError(L.vector, r.vector)));
    if (affineError <= policy.affineRoundoff) {
        return { score: 1, model: "affine-samples", support: support, residual: affineError, affine: true };
    }

    const models = [];
    const assess = (name, predict) => {
        let error = 0;
        for (let k = 0; k < records.length; k++) {
            error = Math.max(error, cgPredictionError(predict(records[k]), records[k].vector));
        }
        if (Number.isFinite(error)) models.push({ model: name, residual: error, support: support });
    };
    const alignment = Math.max(-1, Math.min(1, cgDot(L.feature.unit, R.feature.unit)));
    // An affine VELOCITY model integrates exactly to quadratic position. A
    // secant is its velocity at the interval midpoint, even with unequal gaps.
    // Do not extrapolate this model through an opposing-direction ambiguity.
    if (alignment > 0) {
        assess("linear-velocity", r => {
            const w = (r.midpoint - L.midpoint) / span;
            return L.vector.map((v, d) => v + w * (R.vector[d] - v));
        });
    }

    // Constant-rate rotation in the plane of the two outer directions.
    // For a circular trajectory, chord speed is speed*sinc(omega*duration/2).
    // Ignoring this factor mistakes long-chord sampling bias for deceleration.
    const tangent = R.feature.unit.map((v, d) => v - alignment * L.feature.unit[d]);
    const sine = cgNorm(tangent), angle = Math.atan2(sine, alignment);
    if (sine > policy.antipodalTolerance && Math.PI - angle > policy.antipodalTolerance) {
        const basis = tangent.map(v => v / sine), omega = angle / span;
        const speedL = cgNorm(L.vector) / cgSinc(omega * L.width / 2);
        const speedR = cgNorm(R.vector) / cgSinc(omega * R.width / 2);
        const speed = (speedL + speedR) / 2;
        assess("constant-turn", r => {
            const phase = omega * (r.midpoint - L.midpoint);
            // Each interval must have a short-arc interpretation. Farther
            // observed flanks can accumulate more than pi from the fit origin;
            // they validate that accumulated phase rather than aliasing it.
            if (omega * r.width >= Math.PI) return null;
            const magnitude = speed * cgSinc(omega * r.width / 2);
            return L.feature.unit.map((v, d) => magnitude *
                (v * Math.cos(phase) + basis[d] * Math.sin(phase)));
        });
    }

    // A fixed-direction exponentially changing rate is a different model from
    // constant acceleration. Integrate over each interval; log(secant speed)
    // at its midpoint alone is biased when the interval durations differ.
    if (alignment >= 1 - policy.parallelTolerance) {
        const logRatio = R.feature.logSpeed - L.feature.logSpeed;
        let rate = 0;
        if (L.width === R.width) {
            rate = logRatio / span;
        } else if (logRatio !== 0) {
            // Outer intervals are separated by this unit-width candidate gap;
            // the derivative of their log-integral ratio is at least one.
            let lo = Math.min(0, logRatio), hi = Math.max(0, logRatio);
            for (let step = 0; step < 48; step++) {
                const mid = (lo + hi) / 2;
                const residual = mid * span + cgLogSinhc(mid * R.width / 2) -
                    cgLogSinhc(mid * L.width / 2) - logRatio;
                if (residual < 0) lo = mid; else hi = mid;
            }
            rate = (lo + hi) / 2;
        }
        const originLog = L.feature.logSpeed - reference - cgLogSinhc(rate * L.width / 2);
        assess("exponential-rate", r => {
            const logMagnitude = originLog + rate * (r.midpoint - L.midpoint) + cgLogSinhc(rate * r.width / 2);
            if (!Number.isFinite(logMagnitude) || logMagnitude > 700) return null;
            const magnitude = Math.exp(logMagnitude);
            return L.feature.unit.map(v => magnitude * v);
        });
    }
    // Higher-order dynamics require extra data on BOTH sides. The candidate
    // is excluded from fitting, and every outer observation is also predicted
    // in a leave-one-out refit. Complexity reduces, rather than inflates, credit.
    const outerCount = left.length + right.length;
    const quadraticSupport = outerCount > 3 ? support * (outerCount - 3) / (outerCount - 2) : 0;
    const simpleMerit = models.reduce((best, m) => {
        const ratio = m.residual / policy.relativePredictionTolerance;
        return Math.max(best, m.support * Math.max(0, 2 / (1 + ratio * ratio) - 1));
    }, 0);
    // An exact upper bound: skip QR if it cannot beat a simpler model, even
    // with a perfect residual. This changes work, not the selection policy.
    if (left.length >= 2 && right.length >= 2 && simpleMerit <= quadraticSupport) {
        const outer = records.filter(r => r.index !== i);
        const scale = Math.max.apply(null, records.map(r => Math.max(1, Math.abs(r.midpoint - 0.5) + r.width / 2)));
        const predict = cgQuadraticVelocityFit(outer, scale);
        let error = predict ? cgPredictionError(predict(G), G.vector) : Infinity;
        for (let k = 0; k < outer.length && Number.isFinite(error); k++) {
            const heldout = cgQuadraticVelocityFit(outer.filter((unused, j) => j !== k), scale);
            error = Math.max(error, heldout ? cgPredictionError(heldout(outer[k]), outer[k].vector) : Infinity);
        }
        if (Number.isFinite(error)) models.push({
            model: "quadratic-velocity", residual: error,
            support: quadraticSupport
        });
    }

    // Failed prediction means "not explained by these models", not "a new
    // artistic gesture". Retain a soft near-constant prior for modest unmodeled
    // speed humps/turns; it never borrows extra confidence from more keyframes.
    const nearCosine = Math.min(cgDot(G.feature.unit, L.feature.unit), cgDot(G.feature.unit, R.feature.unit));
    const logRange = Math.max(L.feature.logSpeed, G.feature.logSpeed, R.feature.logSpeed) -
        Math.min(L.feature.logSpeed, G.feature.logSpeed, R.feature.logSpeed);
    const priorDistance = Math.max(Math.max(0, 1 - nearCosine) / (1 - policy.priorCosine),
        logRange / Math.log(policy.priorSpeedRatio));
    let best = {
        score: 1 / (1 + priorDistance * priorDistance), model: "near-constant-prior",
        support: 0.5, residual: null, affine: false
    };
    for (let k = 0; k < models.length; k++) {
        const ratio = models[k].residual / policy.relativePredictionTolerance;
        const quality = 1 / (1 + ratio * ratio);
        const merit = models[k].support * Math.max(0, 2 * quality - 1);
        const priorMerit = best.support * Math.max(0, 2 * best.score - 1);
        if (merit > priorMerit || (merit === priorMerit && quality >= best.score)) best = {
            score: quality, model: models[k].model, support: models[k].support,
            residual: models[k].residual, affine: false
        };
    }
    return best;
}

// Local, multiscale classifier. Returns evidence records, not probabilities.
// Independent of current evaluation time; never groups differently per frame.
function cgAnalyze(times, values, sampleNative, settings) {
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const forcedJoins = new Set(settings.joinAfter), forcedSplits = new Set(settings.splitAfter);
    const motionCache = []; // evaluation-local only; no order-dependent persistent state
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
        const neighbors = { left: [], right: [] };
        const collect = direction => {
            const result = [];
            for (let j = i + direction; j >= 0 && j < gaps.length && result.length < 4; j += direction) {
                // Do not borrow cadence across another clear rest or an equally
                // large/larger gap. Use the initial mask, not scan-order decisions.
                if (decisive[j].split || gaps[j] >= duration * (1 - CG_EPSILON)) break;
                result.push(Math.log(gaps[j]));
                (direction < 0 ? neighbors.left : neighbors.right).push(j);
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
        if (settings.grouping === "adaptive") {
            const margin = score - Math.log(settings.gapRatio);
            const base = { logProminence: score, effectiveGapRatio: Math.exp(Math.min(score, 700)), scales: scores.length };
            // Dynamics can suppress a timing split, not create a new one in an
            // ordinary-cadence interval. No additional native samples are taken.
            if (margin + CG_EPSILON < 0) {
                return { ...base, split: false, reason: "ordinary-spacing" };
            }
            const evidence = cgMotionEvidence(i, gaps, values, neighbors.left, neighbors.right, motionCache);
            const credit = CG_GROUP_POLICY.maximumLogGapCredit * evidence.support *
                Math.max(0, 2 * evidence.score - 1);
            const split = !evidence.affine && margin + CG_EPSILON >= credit;
            return {
                ...base, split: split,
                reason: split ? "relative-gap" : "motion-continuation",
                model: evidence.model, motionScore: evidence.score, support: evidence.support,
                predictionResidual: evidence.residual, logGapCredit: credit,
                boundaryMargin: margin - credit, affineSamples: evidence.affine
            };
        }
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
    if (!(duration > 0) || !Number.isFinite(duration)) return null;
    const u = cgClamp01((currentTime - start) / duration);
    if (u === 0) return values[first];
    if (u === 1) return values[last];

    const curve = settings.curve, carrier = cgCarrierCurve(curve);
    if (last === first + 1) return cgMix(values[first], values[last], cgBezier(u, curve));
    const freedom = cgClamp01(settings.timingFreedom);
    const hasExcess = (curve[1] !== carrier[1] || curve[3] !== carrier[3]) &&
        !cgEqual(values[first], values[last]);
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
        // Reuse the scaled spline retry: unrestricted finite Y handles can
        // overflow correction derivatives while the correction is finite.
        excess = current.delta - cgSplineValue(x, deltas, segment, q, "smooth");
    }
    const vectors = values.slice(first, last + 1).map(cgVector);
    const result = vectors[0].map((unused, dimension) => {
        // Compute shared derivative data from the original values. Center only
        // evaluation within its segment: changing the origin before computing
        // slopes can erase small differences elsewhere and break continuity.
        const y = vectors.map(v => v[dimension]);
        const interpolated = cgSplineValue(x, y, segment, q, settings.interpolation);
        return hasExcess ? cgAddExcess(interpolated, y[0], y[y.length - 1], excess) : interpolated;
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
        const duration = times[interval + 1] - times[interval];
        if (!(duration > 0) || !Number.isFinite(duration)) return null;
        const u = (currentTime - times[interval]) / duration;
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
        (i > 0 && (t <= times[i - 1] || !Number.isFinite(t - times[i - 1])))) ||
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
| **`curve`** | **`[0.50, 0.00, 0.10, 1.00]`** | Cubic-Bezier timing clock in `[x1,y1,x2,y2]` form. X handles must remain in `[0,1]`; Y handles may be any finite values. |
| **`interpolation`** | **`"shape"`** | Componentwise base spline. `"shape"` = bounded C1; `"shapeC2"` = bounded quintic C2 in carrier coordinates; `"smooth"` = natural cubic C2 that may overshoot/reverse. |
| **`timingFreedom`** | **`0`** | `0` keeps authored key times as exact waypoint arrivals. `1` lets the group clock fully retime normalized interior waypoint positions. Intermediate values blend the two coordinate layouts. |
| **`grouping`** | **`"adaptive"`** | Sampling-aware predictive continuation evidence. `"legacy"` restores the previous hard three-secant continuation policy. |
| **`gapRatio`** | **`4`** | Sensitivity for automatic relative-gap splitting. `0` disables only this timing-gap heuristic; sampled rests and explicit splits still operate. |
| **`splitAfter`** | **`[]`** | Optional one-based interval indices to force separation, e.g. `[3]` splits key 3 from key 4. |
| **`joinAfter`** | **`[]`** | Optional one-based interval indices that force continuity and override automatic or forced splitting at the same interval. |

The recommended production starting point is to leave these defaults unchanged. Manual joins/splits are not a failure mode; they are the highest-authority source of intent when automatic inference cannot know what the animator meant.

## Adaptive Grouping Policy

The following constants are implementation policy rather than user-facing animation controls. They are intentionally separate from the `CG` block so routine use does not invite threshold tuning without evidence.

| Constant | Value | Role |
| --- | ---: | --- |
| `priorCosine` | `0.95` | Direction scale for the soft near-constant prior. In adaptive mode it is no longer the sole binary continuation threshold. |
| `priorSpeedRatio` | `2` | Speed-range scale for the same soft prior. |
| `relativePredictionTolerance` | `0.12` | Reference normalized prediction error; model quality is 0.5 at this residual. |
| `maximumLogGapCredit` | `log(4)` | Maximum evidence credit before support weighting; prevents nonlinear models from vetoing arbitrarily large timing gaps. |
| `affineRoundoff` | `1024 * Number.EPSILON` | Very narrow numerical allowance for roundoff-compatible constant sampled velocity. |
| `parallelTolerance` | `1e-8` | Conditioning requirement for the fixed-direction exponential-rate model. |
| `antipodalTolerance` | `1e-6` | Rejects ambiguous near-opposite directions in the constant-turn model. |

These numbers are **not** learned probabilities, psychophysical constants, or claims about universal human gesture perception. They define a conservative local policy whose behavior is documented and regression-tested.

## How It Works

### 1. A detected gesture gets one clock

For a group spanning several keys, time is normalized across the group and evaluated through the configured cubic-Bezier curve. That produces a single shared progress clock rather than restarting an ease on every interval.

For a two-key group, the result is simply the endpoints mixed by that Bezier clock. For groups with three or more keys, the clock feeds the selected spline through the keyed waypoints.

### 2. `timingFreedom` controls waypoint-arrival authority

The expression separates authored time from carrier-clock progress.

With the default:

~~~text
timingFreedom = 0
~~~

interior carrier knots are arranged so that every authored key time still lands on its exact authored value.

At:

~~~text
timingFreedom = 1
~~~

interior knots use their normalized authored positions while the current sample follows the eased group carrier. The Bezier clock can therefore shift effective interior arrivals earlier or later. Intermediate values blend those two coordinate constructions.

### 3. Three interpolation modes define the value path

**`shape`** uses componentwise PCHIP-style cubic Hermite slopes. Sign changes and flat secants receive zero tangent where required to preserve shape, while continuing monotone components retain nonzero shared tangents. With no explicit Y-handle excess, each component stays within its neighboring keyed range.

**`shapeC2`** begins from the same shape-preserving tangent estimates, applies a shared limiter, and evaluates a monotone quintic control polygon with de Casteljau interpolation. Its second derivative is zero at each knot **in carrier coordinates**.

**`smooth`** uses a natural cubic spline. It is C2 inside a valid group and is intentionally allowed to overshoot or reverse. On Position, that means the componentwise path may bow outside the rectangle implied by neighboring points.

`shape` and `shapeC2` are componentwise constructions. Their boundedness contract is therefore coordinate-basis dependent; they are not advertised as rotation-equivariant geometric splines.

### 4. Gesture boundaries start with explicit and sampled evidence

Grouping is independent of the current evaluation frame, so a property does not change group membership simply because playback moved to a different frame.

Each interval first receives a decisive classification:

1. `joinAfter` wins immediately and overrides every other split mechanism at that interval;
2. `splitAfter` forces separation unless overridden by the same explicit join;
3. repeated keyed values are treated as a rest only when native/pre-expression sampling at 25%, 50%, and 75% is also exactly unchanged.

Rest sampling is finite evidence, not proof against an arbitrary hidden excursion.

### 5. Local multiscale cadence proposes timing-gap splits

For remaining intervals, the expression examines nearby log durations on both sides at several local scales. The timing score asks whether the candidate interval is unusually large relative to nearby cadence while refusing to borrow cadence across a known rest or an equal-or-larger gap.

If useful evidence is not available on both sides, the interval is not declared an isolated timing peak. `gapRatio` sets the prominence threshold; `gapRatio: 0` disables this relative-gap stage only.

Adaptive motion modeling runs **only after** this timing stage proposes a split. It can suppress a timing split; it does not manufacture a new dynamics-only split in ordinary cadence.

### 6. Motion evidence respects interval-average sampling

A keyed displacement divided by its duration is an **interval-average velocity**, not automatically an instantaneous velocity at the key or midpoint. The adaptive stage uses models whose observations match that sampling geometry.

| Model | Evidence it can explain | Safeguard |
| --- | --- | --- |
| **Affine samples** | Roundoff-compatible constant sampled velocity across the local window. | Exception is intentionally extremely narrow; it says only that the sampled secants are affine-compatible. |
| **Linear velocity** | Constant acceleration / quadratic position. | Not extrapolated through opposing-direction ambiguity. |
| **Constant turn** | Constant-rate rotation supported by individually observed short intervals in the plane of the outer directions. | Corrects chord speed with `sinc(omega*h/2)`, rejects ambiguous near-antipodal training directions and unobserved half-turn-or-larger intervals, and validates additional flanks without mistaking their accumulated rotation for one unobserved gap. |
| **Exponential rate** | Fixed-direction exponential acceleration/deceleration. | Integrates over interval width using `sinh(k*h/2)/(k*h/2)` rather than fitting raw log secant speeds as if durations were equal. |
| **Quadratic velocity** | Cubic position with enough surrounding observations. | Requires at least two flank intervals per side, excludes the candidate from fitting, validates every outer sample through leave-one-out refits, and receives reduced support for model complexity. |
| **Near-constant prior** | Modest unmodeled speed or direction change that may still be one gesture. | Soft, bounded, and receives no extra support merely because more keys exist. |

These are **grouping models only**. A circle-compatible decision does not force the rendered interpolation onto a circle; the configured spline remains responsible for the path between keys.

### 7. Motion features are scale-normalized and dimension-generic

The continuation stage stores displacement direction separately from logarithmic speed. It normalizes displacement before taking its norm and falls back to a half-scaled difference when a direct subtraction of two finite endpoints overflows.

This avoids unnecessary failure from computing `displacement / duration` at extreme finite scales merely to obtain a direction and relative speed. The same logic works for scalar and multi-component numeric values without choosing a privileged X/Y/Z axis.

### 8. More complex explanations require more independent evidence

The candidate interval is never used to fit the simple continuation models that are meant to predict it. Additional outer observations validate those models rather than automatically widening their tolerance.

The quadratic-velocity model is stricter: it is enabled only when there are at least two outer intervals on each side. Every outer observation must survive a leave-one-out fit, preventing the degenerate shortcut where a sufficiently flexible curve simply interpolates the same samples it is supposed to validate.

Higher-order QR work is skipped when its maximum possible merit cannot beat an already-supported simpler model. That optimization was explicitly regression-checked against evaluating every available model.

### 9. Motion evidence has bounded authority

For non-affine models, prediction quality and available support produce a finite credit against the timing-gap margin. A successful local model therefore cannot erase an arbitrarily large pause-like gap.

At the production defaults, a perfect simple model with only one outer interval per side can rescue a non-affine gap below approximately **8x** local cadence. With four supporting intervals per side, the corresponding upper limit is approximately **12.13x**.

The exact affine-sample exemption is intentionally different: a constant sampled velocity can remain one continuous sparse move even across a very large key spacing. Use explicit split overrides when that interpretation is not desired.

This exemption uses the **stored sampled secants**, not a nominal affine law before host rounding. For example, at times `[0,1,101,102]`, values authored as `1.1*t` are affine-compatible, but Float32-rounded values exceed the narrow roundoff allowance and adaptive mode splits the 100x gap. That partition change can materially change the gesture clock even though the value perturbations are tiny. Time storage and large coordinate offsets can amplify the same sensitivity. The expression does not assume a universal property precision or time grid, or silently grant uncertain samples an unlimited continuation veto. Use `joinAfter: [2]` for this known gesture, or `grouping: "legacy"` when the broader historical continuation behavior is intended.

### 10. Split intervals remain value-continuous

A sampled flat separator remains flat. A nonflat interval separated by timing or explicit logic becomes a two-key Bezier bridge. The expression does not teleport and does not invent a Hold.

Velocity or acceleration does **not** universally match at a split boundary. The guarantee there is value continuity.

### 11. Out-of-range Y handles add corrected excess motion

The X handles always define an ordered timing domain. For the group carrier, Y handles are clamped to `[0,1]` so waypoint traversal remains ordered.

If authored Y handles extend below 0 or above 1, the difference between the unrestricted curve and the carrier is retained as a separate excess term. A shared natural-cubic correction forces that excess through the waypoint constraints, and the result is scaled by the group's endpoint displacement.

This explicit excess can intentionally defeat the ordinary bounds of `shape` or `shapeC2`. A closed loop whose first and last group values are identical has zero endpoint displacement, so this endpoint-relative global excess is also zero by design.

Closed groups skip the irrelevant excess correction entirely, including when enormous finite Y handles would make that correction overflow. Other groups reuse the natural spline's scaled retry for the correction. The final excess addition retains ordinary finite arithmetic and retries overflow/cancellation in halved value units.

### 12. Numerical failure degrades to native output

The production implementation includes several defensive safeguards:

- opposite-sign finite endpoints can be mixed without overflowing their difference when the intended result is still representable;
- endpoint-relative excess addition retries avoidable difference/product overflow and cancellation while preserving the ordinary finite fast path;
- a closed group's zero endpoint displacement bypasses its excess solve, and nonclosed corrections reuse the natural-cubic scaled retry;
- PCHIP endpoint/interior slope calculations are normalized before vulnerable weighted arithmetic;
- quintic tangent limiting uses scaled ratios so large intermediates do not create an avoidable `Infinity / Infinity`;
- multi-key spline evaluation retries in power-of-two-scaled units only after a non-finite derivative/result, and declines the retry if scaling would erase a nonzero value or merge distinct waypoints;
- adjacent key-time differences are required to remain finite, so finite timestamps whose subtraction overflows fall back to native output;
- group and bridge durations are checked before normalized progress is computed;
- malformed native rest probes cannot trigger an invalid vector-length access;
- indexed rest comparisons visit sparse array holes instead of accepting them through `Array.every()`;
- malformed values, dimension mismatches, collapsed carrier knots, and unrepresentable final results preserve the current native/pre-expression value rather than fabricating a custom answer.

### 13. Exact keys and simple paths avoid unnecessary work

With `timingFreedom: 0`, exact authored key times can return the keyed value before gesture classification. Two-key properties likewise need no multi-key grouping decision.

Those paths avoid native rest probes when the classification result cannot affect the output.

## Behavioral Sanity Checks

| Scenario | Expected behavior |
| --- | --- |
| No keys / one key | Native/pre-expression value passes through unchanged. |
| Before first key / after last key | Native/pre-expression value passes through unchanged. |
| Exactly two numeric keys | One Bezier clock mixes the two endpoints; grouping policy is irrelevant. |
| Ordinary multi-key move | One group clock unless rest/timing/manual evidence creates a boundary. |
| Exact key with `timingFreedom: 0` | Returns the exact authored keyed value. |
| `[0,1,5,6]` circular samples at 8 degrees/second | Adaptive mode recognizes short-arc continuation; legacy mode reproduces the previous hard-threshold split. |
| Circle at 0.6 radians/second with `[0,.9,1.8,5.8,6.7,7.6]` | Extra corroborating flanks do not invalidate the central constant-turn explanation merely because cumulative observed rotation exceeds pi. |
| `p(t)=t^2` at `[0,1,5,6]` | Linear-velocity model recognizes the constant-acceleration continuation. |
| Unequal interval widths with exponential velocity | Integrated exponential model accounts for the width-dependent secant bias. |
| Cubic position with only four keys | No cubic self-fit is invented; the timing split can remain. |
| Cubic position with at least two validating outer intervals per side | Quadratic-velocity model may support continuation when held-out predictions agree. |
| Huge nonlinear timing gap | Bounded evidence may be insufficient; the interval remains split. |
| Affine secants across a very large gap | Roundoff-compatible affine exemption preserves continuous sampled motion. |
| Equal keyed endpoints plus equal 25/50/75% native probes | Classified as a sampled rest unless explicitly joined. |
| Equal keyed endpoints but a sampled native excursion | Not classified as a flat rest by those probes. |
| Same interval in `splitAfter` and `joinAfter` | Explicit join wins. |
| `gapRatio: 0` | Relative-gap inference is disabled; sampled rests and manual boundaries still operate. |
| `grouping: "legacy"` | Uses the previous 2x-speed / 0.95-cosine continuation veto. |
| Bezier Y outside `[0,1]` | Ordered carrier plus waypoint-corrected endpoint-relative excess. |
| Malformed native rest sample | Not accepted as equality evidence; no vector-length exception. |
| Finite keys with non-finite adjacent time difference | Native/pre-expression fallback. |
| Rotate an otherwise identical bounded Position path | Adaptive grouping is rotation-invariant within tested numerical tolerance; the componentwise bounded spline path itself need not be. |
| Closed loop plus out-of-range Y handles | Endpoint-relative added excess remains zero because endpoint displacement is zero. |

## Validation

The production review covered the inherited interpolation engine, the adaptive grouping logic, the After Effects-facing adapter, numerical edge cases, invariance properties, regression behavior, and performance tradeoffs.

### Final production-source checks

The follow-up review verified all 49 checksummed files in the recovered investigation package against its manifest, reconciled that candidate with repository commit `aec1d9d`, and repaired five demonstrated defect classes: observed-turn rejection, overflowing excess addition, closed-loop excess evaluation, correction retry bypass, and sparse rest equality. The repaired source was then checked directly:

- **51 / 51 inherited regression/property tests passed**;
- **41 / 41 adaptive grouping, invariance, edge-case, and pruning tests passed**;
- **6 / 6 modeled AE runner-control tests passed**;
- **20 / 20 maintained regressions passed**, reading the expression from this Markdown file; run `node --test tests/continuousGroups/*.test.cjs` from the repository root;
- a separate review suite passed **20 / 20 tests**, including 2,160 exact ordinary group-output matches against the immutable inherited candidate;
- Node JavaScript syntax validation passed;
- TypeScript 5.8.3 `checkJs` against an **ES2018** target passed;
- the noninteractive native observation job covers **31 fixtures and 1,389 samples** over 24000/1001, 24 and 60 fps, plus a native authored-excursion/self-sampling positive control;
- the production expression contains no dependency on Node, Python, external packages, persistent state, or random decisions.

The adaptive tests include the reproduced circular-threshold failure, constant acceleration, unequal-width exponential rate, extra-flank validation, opposing-direction ambiguity, huge/tiny finite secants, affine long-gap behavior, bounded model authority, legacy parity, uniform time/value scaling, translation, orthogonal transformations/reflections, time reversal, unchanged added coordinates, manual precedence, rest sampling, malformed probes, unrepresentable time spans, deterministic evaluation, exact arrivals, closed-loop policy, higher-order leave-one-out validation, and pruning equivalence.

### Independent numerical references

The adaptive numerical helpers were independently checked in **1,522 reference cases**:

- **608** motion-feature cases against 100-digit calculations;
- **114** `sinc` / log-`sinhc` special-function cases;
- **200** arbitrary quadratic-velocity QR fits against NumPy's SVD least-squares solver;
- **600** integrated motion-family examples generated at 100-digit precision: linear velocity, constant turn, exponential rate, and quadratic velocity.

The rerun reported maximum unit-vector absolute error about **1.11e-16**, maximum log-speed absolute error about **2.27e-13**, maximum QR output absolute error about **2.11e-15**, and maximum tested integrated-family residual about **2.03e-13**.

### Interpolation-core non-regression

The follow-up repairs preserve the existing spline/Bezier engine and ordinary finite arithmetic. Fresh additional checks covered **280 Bezier inversions** against an independent 1,200-bit fixed-point reference and **91,154 bounded-spline samples** across 800 seeded datasets. The largest measured Bezier-parameter relative error was about 3.664e-15; no tested finite bounded-spline result exceeded its adjacent component range beyond a 5e-14 relative roundoff allowance.

The recovered earlier investigation reported the following additional core validation; these are historical results, not newly executed counts:

- **700** Bezier-inversion cases against independent 100-digit bisection;
- **49,194 scalar spline comparisons** over 250 datasets against independent PCHIP, natural-cubic, and Bernstein/quintic reference constructions;
- a selected 10-dataset natural-cubic cross-check against an independent 100-digit dense solve;
- **3,420 complete-group scalar samples** across 180 datasets against an independently reconstructed group evaluator.

For the adaptive revision specifically, fixed group boundaries produced **10,500 exact 2D output matches** against the previous production engine, confirming that ordinary value-path changes come from intentional regrouping rather than an unrelated interpolation rewrite.

Legacy mode also reproduced the previous classifier's complete records across **600 seeded ordinary cases**. Additional checks included 500 rotations/reflections, 500 time reversals, 500 pruning comparisons, and 2,000 extreme affine rescalings.

### Synthetic behavior atlas

A 3,250-case synthetic atlas was used as a behavior probe, **not** as a human-labeled accuracy benchmark. It recorded substantial improvements for constant acceleration, short-arc circular motion, exponential rate, and cubic position when enough independent flank evidence exists. Sparse cubic samples, general helices, and unmodeled rate humps remain limited or mixed, which is reflected in the documented limits rather than hidden by progressively more permissive fitting.

### Native host observations

The adapted job runs through the approved disposable-job runner, with fresh source/run-correlated completion and verified cleanup. It tests Slider, true 2D Point Control, 2D/3D Position, 4D Color, separated X Position, Hold-source replacement, all spline modes, timing freedom, adaptive/legacy grouping, sampled rests and closed-loop huge Y handles.

Native parity must use the expression-visible `time`, authored key times and authored key values measured from the host. Requested decimal times and original doubles are not an interchangeable oracle: AE quantizes stored times/values, and 2D Position has three-component scripting storage with an inactive zero Z component. Cross-property key probes must disable the target expression while measuring authored data. Numerical tolerance remains `2e-6 * max(1, abs(expected))`; measuring the correct inputs does not relax it.

The historical interactive smoke script is not the approved native entry point. Its modeled six-test result is separate evidence from the new native runner's completion. Rendered behavior and representative-comp performance also require their own checks.

The final qualified native run on **AE 25.6.5x3** passes all **1,389 corrected-domain samples**, with maximum normalized residual about **6.01e-14**, zero setup/expression errors, native self-sampling positive controls and verified cleanup. Authored-key probes disable the target expression, and native serialization round-trip assertions pass. Earlier exploratory and serialization-invalid evidence is retained separately. A further **162-sample** native job confirms the nominal affine storage sensitivity for Slider/2D Position and verifies that explicit joins restore the intended grouped behavior in those fixtures. Neither numeric gate establishes semantic accuracy. The controlled render is a separate acceptance gate.

## Performance Notes

Adaptive classification performs more work than the previous three-secant continuation test. The model window is bounded to at most four intervals per side, motion features are cached only for the current evaluation, and the higher-order QR model is skipped when its maximum possible merit cannot beat an already-supported simpler model.

In the recorded Node full-expression microbenchmark, adaptive/default evaluation ranged from approximately **1.06x to 3.52x** the previous production version across four fixtures. The worst ratio occurred on the tiny four-key circle specifically designed to activate the new model stage; dense ordinary cadence was close to the previous full-expression cost. Sparse 48-key and 240-key fixtures were approximately 1.31x and 1.47x respectively in that run.

Those measurements are **not After Effects performance forecasts**. Expression scheduling, host overhead, native property access, comp complexity, and changed group sizes all matter. `grouping: "legacy"` remains available for compatibility/performance comparison, and unusually large procedural key counts should be profiled in the actual comp.

## Known Limits

- **Automatic grouping remains inference, not semantic metadata.** Scores are engineering evidence, not calibrated probabilities or recovered artistic intent. Manual overrides remain authoritative.
- **Partitions are discrete.** Continuous model scores reduce a specific hard-threshold cliff but do not make every possible group-boundary edit continuous.
- **Nominal affine motion can lose the sparse-gap exemption after storage.** The narrow allowance applies to literal sampled secants; Float32 value rounding, time storage and coordinate cancellation can remove it. Use an explicit join for a known continuous sparse move. Native numeric parity does not prove that an intended pre-storage partition survived rounding.
- **The model family is intentionally finite.** Near-antipodal turns, unobserved multi-turn motion, zero-displacement headings, general helices, changing curvature, arbitrary oscillation, and other dynamics are not universally resolved.
- **Equally long adjacent large gaps retain the inherited isolated-peak limitation.** A candidate must have useful shorter-cadence evidence on both sides before relative-gap analysis is applied.
- **Numeric vectors use their supplied component metric.** There is no automatic angle unwrapping, quaternion geometry, perceptual color transform, or screen-space weighting.
- **The bounded spline modes are componentwise.** Their path is not generally rotation-equivariant; `smooth` is geometrically linear in the supplied components but may overshoot/reverse instead.
- **Native Graph Editor handles are not reconstructed.** The expression owns interpolation inside a constructed group.
- **Native spatial paths are not preserved.** Position uses generated component splines rather than the source spatial Bezier path.
- **Arbitrary Hold interpolation is not preserved.** Repeated-value rests can be detected by sampling, but a Hold between different endpoint values is not treated as authoritative native interpolation.
- **Rest detection is finitely sampled.** A deliberately unusual native curve could equal the first key at all three probes while moving elsewhere between them.
- **C1/C2 labels describe the spline in carrier coordinates.** Real-time derivative continuity also requires a regular timing clock; boundary X handles can intentionally produce singular derivatives.
- **Split boundaries guarantee value continuity, not universal velocity or acceleration continuity.**
- **Out-of-range Y handles intentionally permit excess motion.** They can push final output beyond the base bounds of `shape` / `shapeC2`.
- **Closed-loop endpoint-relative excess is zero.** When the group's first and last values are identical, the global excess scale is zero by design.
- **Large key counts cost more per evaluation.** Adaptive grouping has bounded local model windows but the property still must be scanned and group interpolation still scales with group size.
- **Floating-point information already lost by representation cannot be recovered.** Defensive fallbacks prioritize finite native output over pretending otherwise.
- **Some extreme intermediate excesses remain unrepresentable.** Enormous handles combined with nearly collapsed carrier knots can overflow the correction or its subtraction even when a tiny endpoint displacement could make a mathematically scaled final contribution finite. The current scalar-excess representation falls back to native output; it is not arbitrary-precision arithmetic.
- **AE sampling uses the host's time/value representation.** Exact arrival means the actual authored host key time and value, not an unrounded decimal supplied by a separate scripting fixture.
- **Modern JavaScript only.** Legacy ExtendScript is not a compatibility target.
- **Native version coverage is limited to AE 25.6.5.** Representative-comp profiling and artistic acceptance remain environment-specific checks, even after numerical host parity.

## Revision Highlights

Relative to the previous production file, this revision:

1. replaces the old hard 0.95-cosine / 2x-speed continuation veto in the default mode with sampling-aware, bounded predictive evidence;
2. adds `grouping: "legacy"` so the previous behavior remains directly selectable;
3. introduces interval-aware constant-acceleration, constant-turn, exponential-rate, and independently validated higher-order motion models;
4. retains a bounded near-constant prior so “not explained by these models” is not silently equated with “new artistic gesture”;
5. normalizes motion features to improve scale robustness and prevent avoidable velocity overflow/underflow;
6. adds finite adjacent-time-span, group-duration, bridge-duration, and malformed-rest-probe safeguards;
7. preserves the existing spline, carrier, Bezier inversion, `timingFreedom`, explicit overshoot, manual override, and native-fallback contracts;
8. expands regression, invariance, high-precision reference, synthetic behavior, and native-runner fixture coverage.

The follow-up repair retains those defaults and model parameters. It distinguishes observed cumulative turning from an unobserved interval, recovers representable endpoint-relative excess after avoidable overflow, bypasses closed-loop zero excess, reuses the existing correction retry, and rejects sparse malformed rest probes. Maintained regressions are in [`tests/continuousGroups`](../tests/continuousGroups/README.md).

## Research / Numerical Basis

The implementation combines standard numerical methods with project-specific grouping policy:

1. cubic-Bezier timing with monotone X-domain inversion;
2. PCHIP-style shape-preserving cubic Hermite interpolation;
3. a monotone quintic Bezier/control-polygon construction for bounded C2 carrier-space interpolation;
4. natural cubic splines for the optional free-smoothing mode;
5. local multiscale log-duration statistics for candidate timing-gap evidence;
6. interval-average kinematic models whose predictions account for unequal sampling widths;
7. bounded evidence credit and explicit manual overrides rather than an unbounded best-fit veto;
8. scale-normalized arithmetic and finite-result fallback behavior for floating-point robustness.

The grouping layer should be understood as a motion-design heuristic built on observable keyed samples. It is deliberately more adaptive than the previous threshold but is not presented as a universal gesture-recognition theorem.

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
- [SciPy - median_abs_deviation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.median_abs_deviation.html)
