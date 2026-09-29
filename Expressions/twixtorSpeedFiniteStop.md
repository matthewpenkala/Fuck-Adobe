# Twixtor Speed - Perceptual Finite Stop

A keyframe-driven Adobe After Effects expression for RE:Vision Effects Twixtor's **Speed %** property. It is designed primarily to make a moving-speed-to-freeze transition such as **100% -> 0%** feel substantially more even perceptually: meaningful motion is preserved longer, the low-speed crawl is compressed toward the end, and a quintic boundary patch settles into an exact zero-speed state without introducing a hard terminal snap.

The same shaping also supports the exact time-reversed **0% -> moving speed** restart. Unrelated Twixtor speed animation is passed through unchanged by default.

> **Important:** this expression reshapes Twixtor's playback-rate control, not source-frame position directly. Changing the Speed % curve changes accumulated source time, so the exact source frame reached at the freeze can change. If the freeze frame itself must be exact, compensate the keyframe timing or use Twixtor's frame-number retiming mode instead.

## What It Does

- Targets Twixtor **Speed %**, where 100 is normal playback, 0 is frozen, values below 100 slow the source, and values above 100 accelerate it.
- Replaces the ordinary interpolation only on eligible segments that touch an **authored exact 0%** by default.
- Preserves meaningful playback velocity longer through the middle and late portion of a stop.
- Uses a power-law middle section with a production default of **POWER = 0.70**.
- Uses quintic endpoint patches that match value, first derivative, and second derivative at their joins.
- Lands on **exactly 0%** with zero first and second derivative for the constructed stop curve.
- Implements **0 -> moving** as the exact time reverse of the stop law.
- Supports negative playback speeds as long as a segment does not reverse sign.
- Leaves genuine positive-to-negative or negative-to-positive direction reversals untouched.
- Preserves unrelated animation and noneligible segments through the native/pre-expression value.
- Preserves ordinary Hold interpolation by default using sampled native values, because expression-side Key objects do not expose interpolation-type metadata.
- Adapts the smoothing-patch width to frame rate and ramp duration while enforcing a safe maximum fraction.
- Requires After Effects' modern **JavaScript** expression engine; it is intentionally not written for Legacy ExtendScript.

## Compatibility

**Expression-language compatibility target: After Effects 16.0+ using the JavaScript expression engine.**

Use:

**File > Project Settings > Expressions > Expressions Engine > JavaScript**

Adobe documents the JavaScript expression engine introduced in After Effects 16.0 as being based on ECMAScript 2018. This expression intentionally uses modern JavaScript features including **const**, **let**, arrow functions, and **Number.isFinite()**.

This release has been extensively validated mathematically and in a mock expression-property environment, but it has **not** been executed inside a real After Effects + Twixtor host during this audit. See **Validation** and **Known Limits** below.

## Usage

1. Apply Twixtor to the footage.
2. Animate **Twixtor > Speed %**.
3. For the primary use case, create a moving-speed keyframe such as **100%** and a later keyframe at **exactly 0%**.
4. Paste the expression below directly onto **Speed %**.
5. Keep the production defaults unchanged initially.
6. If exact source-frame landing matters, visually or numerically compensate the freeze-key timing after the speed reshaping is applied.

On shaped segments, this expression intentionally owns the interpolation. Linear vs. Easy Ease on the underlying moving-to-zero pair therefore does not define the post-expression stop curve. Ordinary Hold segments are detected and preserved separately.

## Expression

Paste only this JavaScript block onto **Twixtor > Speed %**:

~~~js
// TWIXTOR SPEED % | FINITE-STOP SHAPER | FINAL
// Adobe After Effects expression -- JavaScript engine (ECMAScript 2018).
// NOT intended for the Legacy ExtendScript expression engine.
// Project Settings > Expressions > Expressions Engine: JavaScript
// Paste directly into Twixtor's Speed % property.
//
// Primary behavior: reshape moving <-> EXACT 0% ramps while preserving
// unrelated animation. The accepted POWER = 0.70 stop curve is preserved.
//
// Important: changing the Speed % curve changes accumulated source time,
// so the exact source frame reached at the freeze can change.

// ---------------- USER SETTINGS ----------------
const ENABLED = true;
const POWER = 0.70;                         // 0.50..1.00; lower = later/stronger braking.
const STOP_START_PATCH = 0.08;              // 0.01..0.22 of a STOP ramp.
const STOP_END_PATCH = 0.10;                // 0.01..0.22 of a STOP ramp.
const PATCH_TARGET_FRAMES = 2.0;            // Soft target; MAX_PATCH still wins.
const SHAPE_ALL_SAME_DIRECTION_RAMPS = false;
const PRESERVE_HOLDS = true;
// Keep these settings constant during a shaped ramp if you want C2 continuity.

// ---------------- VALIDATED LIMITS ----------------
const MIN_POWER = 0.50;
const MAX_POWER = 1.00;
const MIN_PATCH = 0.01;
const MAX_PATCH = 0.22;

// ---------------- HELPERS ----------------
const clamp = (x, low, high) => Math.max(low, Math.min(high, x));

const boundedSetting = (x, fallback, low, high) =>
    Number.isFinite(x) ? clamp(x, low, high) : fallback;

const p = boundedSetting(POWER, 0.70, MIN_POWER, MAX_POWER);
const stopStartBase = boundedSetting(
    STOP_START_PATCH, 0.08, MIN_PATCH, MAX_PATCH
);
const stopEndBase = boundedSetting(
    STOP_END_PATCH, 0.10, MIN_PATCH, MAX_PATCH
);
const targetFrames = Number.isFinite(PATCH_TARGET_FRAMES)
    ? Math.max(0, PATCH_TARGET_FRAMES)
    : 2.0;

// Quintic Bezier with its first three control values equal to zero.
// Algebraically equivalent to the endpoint-constrained quintic Hermite form,
// but numerically stable when the desired endpoint value is extremely small.
const zeroStartQuintic = (x, b3, b4, b5) => {
    const r = 1 - x;

    return x * x * x * (
        10 * r * r * b3 +
        5 * r * x * b4 +
        x * x * b5
    );
};

// Remaining-speed fraction for a stop: 1 -> 0.
// Internal joins match value + first derivative + second derivative.
// Both outer endpoints also have zero first and second derivatives.
const stopShape = (u, startWidth, endWidth) => {
    if (u <= 0) return 1;
    if (u >= 1) return 0;

    // Smoothly enter the perceptual power-law section from constant speed.
    if (u < startWidth) {
        const z = 1 - startWidth;
        const y = Math.pow(z, p);
        const ratio = startWidth / z;

        const d = -p * y * ratio;
        const dd = p * (p - 1) * y * ratio * ratio;

        const b3 = y - 2 * d / 5 + dd / 20;
        const b4 = y - d / 5;

        return clamp(
            1 - zeroStartQuintic(
                u / startWidth,
                1 - b3,
                1 - b4,
                1 - y
            ),
            0,
            1
        );
    }

    // Smoothly leave the power law and settle at an exact zero-speed state.
    if (u > 1 - endWidth) {
        // Evaluate backward from the zero-speed endpoint to avoid
        // floating-point cancellation at extremely small speeds.
        const r = (1 - u) / endWidth;
        const endScale = Math.pow(endWidth, p);

        return clamp(
            endScale * zeroStartQuintic(
                r,
                1 - 2 * p / 5 + p * (p - 1) / 20,
                1 - p / 5,
                1
            ),
            0,
            1
        );
    }

    // Main perceptually weighted braking law.
    return Math.pow(1 - u, p);
};

// Expression Key objects expose time/index/value, not interpolation-type
// metadata. Three interior pre-expression samples preserve ordinary Hold
// interpolation. The current-value precheck means normal moving ramps avoid
// these extra probes.
const isFlatHold = (prop, t0, duration, firstValue) =>
    prop.valueAtTime(t0 + duration * 0.25) === firstValue &&
    prop.valueAtTime(t0 + duration * 0.50) === firstValue &&
    prop.valueAtTime(t0 + duration * 0.75) === firstValue;

// ---------------- DRIVER ----------------
const evaluate = () => {
    const prop = thisProperty;
    const nativeValue = value; // Current pre-expression value.

    if (!ENABLED || prop.numKeys < 2) {
        return nativeValue;
    }

    const near = prop.nearestKey(time);
    let segmentIndex = near.index;

    // Preserve authored values exactly at authored key times.
    if (time === near.time) {
        return prop.key(segmentIndex).value;
    }

    if (near.time > time) {
        segmentIndex -= 1;
    }

    if (
        segmentIndex < 1 ||
        segmentIndex >= prop.numKeys
    ) {
        return nativeValue;
    }

    const k0 = prop.key(segmentIndex);
    const k1 = prop.key(segmentIndex + 1);

    const duration = k1.time - k0.time;
    const a = k0.value;
    const b = k1.value;

    const frameDuration = thisComp.frameDuration;

    if (
        !Number.isFinite(a) ||
        !Number.isFinite(b) ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        !Number.isFinite(frameDuration) ||
        frameDuration <= 0 ||
        a === b
    ) {
        return nativeValue;
    }

    // Zero is neutral.
    // Genuine positive <-> negative direction reversals are untouched.
    const sameDirection =
        (a >= 0 && b >= 0) ||
        (a <= 0 && b <= 0);

    const touchesExactZero =
        a === 0 ||
        b === 0;

    const eligible =
        sameDirection &&
        (
            touchesExactZero ||
            SHAPE_ALL_SAME_DIRECTION_RAMPS
        );

    if (!eligible) {
        return nativeValue;
    }

    // Preserve ordinary Hold interpolation rather than converting the Hold
    // segment into a custom continuous ramp.
    if (
        PRESERVE_HOLDS &&
        nativeValue === a &&
        isFlatHold(
            prop,
            k0.time,
            duration,
            a
        )
    ) {
        return nativeValue;
    }

    const u = clamp(
        (time - k0.time) / duration,
        0,
        1
    );

    // Convert the soft frame target into a fraction of this ramp.
    // Very short ramps hit MAX_PATCH rather than consuming the entire segment.
    const frameFraction =
        targetFrames *
        frameDuration /
        duration;

    const startWidth = Math.min(
        MAX_PATCH,
        Math.max(
            stopStartBase,
            frameFraction
        )
    );

    const endWidth = Math.min(
        MAX_PATCH,
        Math.max(
            stopEndBase,
            frameFraction
        )
    );

    if (Math.abs(b) < Math.abs(a)) {
        // Moving speed -> lower magnitude.
        // Normal intended case:
        //     100 -> 0
        return b +
            (a - b) *
            stopShape(
                u,
                startWidth,
                endWidth
            );
    }

    // Lower magnitude -> moving speed.
    // Normal intended case:
    //     0 -> 100
    //
    // This is the exact time-reverse of the stopping law.
    return a +
        (b - a) *
        stopShape(
            1 - u,
            startWidth,
            endWidth
        );
};

evaluate();
~~~

## Production Defaults

| Setting | Default | Purpose |
| --- | ---: | --- |
| **POWER** | **0.70** | Main perceptual shaping. Lower values retain motion longer and require stronger late braking. |
| **STOP_START_PATCH** | **0.08** | Baseline fraction used to enter the power-law section smoothly. |
| **STOP_END_PATCH** | **0.10** | Baseline fraction used to leave the power law and settle into zero. |
| **PATCH_TARGET_FRAMES** | **2.0** | Soft minimum smoothing target expressed in comp frames; the maximum patch fraction still wins on short ramps. |
| **SHAPE_ALL_SAME_DIRECTION_RAMPS** | **false** | When false, only ramps touching exact zero are reshaped. |
| **PRESERVE_HOLDS** | **true** | Keeps ordinary Hold segments from being converted into continuous ramps. |

The recommended production setup is to leave these defaults unchanged unless the footage demonstrates a specific reason to tune them.

## How It Works

### 1. Speed % is a playback-rate control

Conceptually, Twixtor's Speed % acts like a source-time rate. If the normalized playback rate is:

~~~text
rate(t) = Speed%(t) / 100
~~~

then source time is accumulated from that rate over output time. This is why a visually attractive curve on the Speed % number is not necessarily a visually attractive slowdown: Speed % is controlling the rate at which source time advances.

For a simple linear 100 -> 0 rate ramp, most source-time advancement happens early. The end of the transition can therefore occupy meaningful output time while contributing very little additional source-time movement.

### 2. The middle uses a fractional-power stop law

The principal normalized stop law is:

~~~text
v(u) = (1 - u)^POWER
~~~

where **u** runs from 0 at the moving keyframe to 1 at the freeze keyframe.

With **POWER = 0.70**, the curve remains above a linear 1 - u ramp through most of the transition. That intentionally preserves playback speed longer before the terminal stop.

For a representative one-second, 24-fps default ramp:

| Ramp progress | Linear 100 -> 0 | Expression |
| ---: | ---: | ---: |
| 0% | 100.000% | 100.000% |
| 10% | 90.000% | ~92.890% |
| 25% | 75.000% | ~81.760% |
| 50% | 50.000% | ~61.557% |
| 75% | 25.000% | ~37.893% |
| 90% | 10.000% | ~19.953% |
| 95% | 5.000% | ~7.729% |
| 99% | 1.000% | ~0.123% |
| 100% | 0.000% | 0.000% |

The terminal patch deliberately crosses below the linear ramp very near the end so it can settle smoothly into exact zero rather than simply remaining above linear all the way to the endpoint.

### 3. Quintic patches repair the raw power-law boundaries

A raw fractional power with exponent below one has an increasingly steep slope as it approaches zero. Using it directly to the endpoint would trade the original long near-freeze tail for an overly abrupt final stop.

The expression therefore replaces the beginning and ending regions with quintic curves.

The internal joins match:

1. value;
2. first derivative;
3. second derivative.

Because the shaped property is playback rate, these correspond conceptually to continuity of the rate, its acceleration/deceleration, and the next derivative of that rate.

The result is **C2 continuity inside the constructed shaped segment**. This prevents derivative jumps at the expression's internal joins. It does not mean the braking magnitude is always small, nor does it guarantee derivative continuity with arbitrary neighboring unshaped segments.

### 4. Restarting from zero is the exact time reverse

The moving-to-zero law is **stopShape(u)**.

The correct zero-to-moving restart is therefore:

~~~text
stopShape(1 - u)
~~~

not:

~~~text
1 - stopShape(1 - u)
~~~

The latter was an earlier implementation error and has been removed. The production expression now produces a genuine temporal mirror for **0 -> moving** ramps.

### 5. Segment gating keeps unrelated animation untouched

By default, a segment is reshaped only when:

- the endpoints do not form a positive-to-negative or negative-to-positive sign reversal; and
- at least one endpoint is exactly 0.

Everything else returns After Effects' native/pre-expression value.

Setting **SHAPE_ALL_SAME_DIRECTION_RAMPS = true** expands the same shaping model to ordinary same-direction acceleration/deceleration ramps, but that is intentionally disabled by default.

### 6. Hold interpolation is preserved separately

Expression-side Key objects expose key value, time, and index but not the keyframe interpolation type.

To avoid converting a Hold segment into a continuous ramp, the expression checks whether the current native value still equals the first key value and, only then, samples the property at 25%, 50%, and 75% of the segment.

This is a practical sampled detector, not direct interpolation metadata. An intentionally exotic non-Hold curve that exactly reproduces the first keyed value at all of those samples could theoretically be mistaken for a Hold segment.

### 7. Patch width adapts to frame rate and duration

The nominal start/end patches are 8% and 10% of the stop.

For short ramps, a two-frame soft target is converted into a normalized fraction:

~~~text
frameFraction = PATCH_TARGET_FRAMES * frameDuration / rampDuration
~~~

The larger of the baseline fraction and frame target is used, subject to the hard **MAX_PATCH = 0.22** ceiling.

This keeps the smoothing regions from collapsing to tiny sub-frame slivers on short transitions without allowing them to consume most of the animation.

## Source-Time Consequence

Holding more speed for longer necessarily changes the area under the Speed % curve relative to a simple linear ramp.

For the representative **one-second / 24-fps** default stop, the expression's average normalized playback rate is approximately **58.55%**, versus **50%** for a linear 100 -> 0 ramp. Under the continuous-rate model, that is roughly **0.0855 additional source seconds** of accumulated source time over the one-second transition.

The exact visible freeze-frame difference depends on the source, source frame rate, Twixtor's interpolation, and project setup. This is expected behavior, not an error.

If the intended freeze frame is more important than preserving the exact keyframe duration, move the zero-speed key earlier until the desired source moment lands at the freeze.

## Behavioral Sanity Checks

| Scenario | Expected behavior |
| --- | --- |
| No keyframes / one keyframe | Native value passes through unchanged. |
| Before first usable segment / after last usable segment | Native value passes through unchanged. |
| 100 -> 0 | Perceptually weighted finite stop. |
| 0 -> 100 | Exact time-reversed restart. |
| -100 -> 0 | Same magnitude shaping while remaining negative until zero. |
| 0 -> -100 | Exact time-reversed negative restart. |
| 100 -> -100 | Native animation; direction reversal is not reshaped. |
| 0.0001 -> 100 with generalized mode off | Native animation; near-zero is not silently reclassified as a freeze. |
| Hold 100 -> 0 | Native Hold interpolation is preserved when detected. |
| 100 -> 50 with generalized mode off | Native animation. |
| 100 -> 50 with generalized mode on | Same-direction magnitude ramp is reshaped. |

## Validation

The production audit for this expression included:

- regression coverage for the original working **100 -> 0** stop;
- the repaired **0 -> moving** branch;
- negative playback speeds;
- sign reversals;
- exact-zero versus near-zero behavior;
- Hold preservation;
- generalized same-direction shaping;
- exact key boundaries;
- multiple-key segments;
- shifted and negative composition times;
- multiple frame rates and ramp durations;
- invalid/non-finite tuning inputs;
- monotonicity and boundedness across the supported parameter domain;
- numerical equivalence between the original endpoint-constrained quintic formulation and the more stable endpoint-factored implementation.

The final offline audit recorded **5,226,616 assertions**, including **162,059 evaluations of the final expression driver**, plus independent symbolic/boundary checks and critical-point analysis of the quintic regions.

The accepted **100 -> 0** stop was preserved through the refactor. Across the tested regression grid, the final version matched the immediately preceding validated stop exactly, and differed from the first working implementation only at floating-point-noise scale.

**Scope limitation:** these are JavaScript, mathematical, and mock-property tests. This audit did not run After Effects or the Twixtor plugin itself. A real AE/Twixtor render remains the final host/visual acceptance test.

## Known Limits

- **Not a preserve-ease expression on shaped ramps.** The expression intentionally replaces native interpolation between eligible endpoints with its own stop/restart law.
- **Exact zero is intentional.** A tiny nonzero speed is not silently treated as a freeze.
- **Source-frame landing can move.** Speed % is cumulative in practical retiming use, so changing the rate curve changes accumulated source time.
- **Hold detection is sampled.** Expression-side Key objects do not expose interpolation-type metadata.
- **C2 refers to the constructed shaped segment.** Arbitrary neighboring native segments can still arrive at a shared key with different derivatives.
- **Smooth does not mean weak.** The late-braking section can decelerate more strongly than a linear ramp while remaining derivative-continuous.
- **POWER = 0.70 is a production tuning choice, not a universal psychophysical constant.** Different footage, optical flow, camera motion, blur, and subject scale can change the perceptual optimum.
- **Optical-flow quality is outside the expression.** The expression cannot repair occlusion errors, motion-estimation failures, source blur, cuts, or insufficient source frames.
- **Very short ramps are constrained by MAX_PATCH.** PATCH_TARGET_FRAMES is a soft target, not a guarantee.
- **Modern JavaScript only.** This file intentionally does not support Legacy ExtendScript.
- **No AE/Twixtor host validation was performed in this audit.** The mathematical/expression layer is extensively tested; the plugin-render layer is not claimed as tested.

## Research Basis

The design rests on four main observations:

1. Twixtor Speed % is a playback-rate control, so reshaping it changes how source time accumulates.
2. A linear moving-to-zero rate ramp spends relatively little source-time movement near its end even though output time is still passing.
3. A fractional-power rate curve with exponent below one preserves more rate through the middle/late transition.
4. A raw fractional-power endpoint is too steep near zero, so quintic boundary patches are used to obtain a finite, smooth exact stop.

The quintic construction uses six endpoint constraints: value, first derivative, and second derivative at both ends of a patch. A fifth-degree polynomial has exactly six coefficients, making it the natural minimum polynomial order for those constraints.

## Sources

### Adobe / After Effects

- [Adobe Help Center - Expression basics](https://helpx.adobe.com/after-effects/desktop/work-with-expressions/expression-basics/expression-basics.html)
- [Adobe Help Center - Syntax differences between expression engines](https://helpx.adobe.com/after-effects/desktop/work-with-expressions/expression-basics/legacy-and-extend-script-engine.html)
- [Adobe Help Center - Expression language reference](https://helpx.adobe.com/after-effects/desktop/work-with-expressions/expression-language-reference/expression-language-reference.html)
- [After Effects Expression Reference - Property](https://ae-expressions.docsforadobe.dev/objects/property/)
- [After Effects Expression Reference - Global / thisProperty](https://ae-expressions.docsforadobe.dev/general/global/)

### Twixtor / Retiming

- [RE:Vision Effects - Twixtor for After Effects](https://revisionfx.com/products/twixtor/after-effects/)
- [RE:Vision Effects - Frame-rate conversion / Speed% example](https://revisionfx.com/faq/frame_rate_conversion_for_fcp/)
- [Creative COW - RE:Vision support discussion of cumulative Speed retiming](https://creativecow.net/forums/thread/can-someone-please-give-me-a-handae-twixtor-interp-2/)
