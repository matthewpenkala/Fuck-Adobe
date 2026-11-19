# C∞ Afterglow - Adaptive Opacity Fade

Fade a shot up from black, leave it clear, then fade it back down with one black solid. This multi-key successor to the **C∞ (C-infinity) dip to black** follows your Opacity keyframes and uses the surrounding frames to ease into and out of each fade. A fade keyed at a visible cut can still land on exactly black.

## Why use Afterglow?

A fade can look smooth in the Graph Editor and still feel rushed near black. Try fading a white frame under a black solid. At 50% Opacity in a linear-light blend, half the light still gets through, and that gray looks brighter than halfway to black. Afterglow’s default lightness correction takes out more light through the middle of the fade, leaving smaller changes as the last detail disappears.

The timing solves a separate editing problem. An interior key can mark the beat where you want to *feel* the fade, while the last visible frame may need to be completely black for the cut. Afterglow lets the motion ease across interior keys and fits it to the visible frames when you key an endpoint at the cut. You can retime the shot by moving the keys without rebuilding the easing handles for each new duration.

## Apply it

1. Place a comp-sized black solid above the footage and set its blending mode to **Normal**.
2. Press **T** to reveal **Transform > Opacity**. For a fade at each end, key **100% → 0% → 0% → 100%**. Place the first and last keys on the first and last visible frames. The two middle keys leave room for the shot to play clear.
3. In **File > Project Settings > Expressions**, choose the **JavaScript** expression engine. Alt-click the Opacity stopwatch on Windows or Option-click it on macOS, then paste the entire [expression](#expression) into the field. [Adobe’s expression editor guide](https://helpx.adobe.com/after-effects/desktop/work-with-expressions/edit-expressions/edit-expressions.html)

### What you’ll see

In a 10-second comp at 24 fps, try these four **linear** keys on a full-length solid. Frame numbers start at zero. The measured output uses the defaults below.

| Frame | Keyed Opacity | Opacity with the expression |
| ---: | ---: | ---: |
| 0 | 100% | 100% |
| 24 | 0% | 9.08% |
| 120 | No key | 0% |
| 215 | 0% | 9.08% |
| 239 | 100% | 100% |

At frame 24 the opening fade is still settling. At frame 215 the closing fade has already begun. Between them the solid reaches exactly 0%, so the footage shows through at full brightness. Move the middle keys farther apart for a longer clear stretch.

## Expression

Copy this block onto **Transform > Opacity**.

```javascript
// Transform > Opacity | JavaScript expression engine
// Smooth every changing pair. Preserve stationary stretches and fit fades at visible cuts.
const startKey = 0;               // 0 processes the whole track. A positive index isolates one pair.
const model = "blackSolid";       // "blackSolid", "footageOverBlack", or "opacity".
const remapExistingCurve = true;  // Sample authored easing. False uses elapsed time as the input curve.
const perceptualAmount = 0.65;    // 0 uses ordinary Opacity. 1 applies full CIE L* correction.

const luminanceToe = 216 / 24389;
const lightnessSlope = 24389 / 27;

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

function mix(a, b, weight) {
    return a + (b - a) * weight;
}

// Integral of the quintic step 6x^5 - 15x^4 + 10x^3.
function integratedStep(x) {
    const x2 = x * x;
    return x2 * x2 * (2.5 + x * (x - 3));
}

// A symmetric averaging kernel rounds the join between a flat hold and a unit-slope ramp.
function roundedRamp(x, radius) {
    if (x <= -radius) return 0;
    if (x >= radius) return x;
    return 2 * radius * integratedStep((x + radius) / (2 * radius));
}

function automaticProgress(u, radius, duration, first, opacitySpan) {
    if (u <= -radius) return 0;
    if (u >= 1 + radius) return 1;
    if (!remapExistingCurve) return roundedRamp(u, radius) - roundedRamp(u - 1, radius);

    // Approximate the authored curve with short ramps. Round only ramps in the kernel's reach.
    const segments = 24;
    const left = Math.max(0, Math.floor((u - radius) * segments));
    const right = Math.min(segments, Math.ceil((u + radius) * segments));
    function sample(index) {
        if (index === 0) return 0;
        if (index === segments) return 1;
        const authored = valueAtTime(first.time + duration * index / segments);
        return clamp01((authored - first.value) / opacitySpan);
    }

    let previous = sample(left);
    let progress = previous;
    let leftRamp = roundedRamp(u - left / segments, radius);
    for (let i = left + 1; i <= right; i++) {
        const next = sample(i);
        const rightRamp = roundedRamp(u - i / segments, radius);
        progress += (next - previous) * (leftRamp - rightRamp) * segments;
        previous = next;
        leftRamp = rightRamp;
    }
    return progress;
}

function intervalProgress(u) {
    // Ease the selected segment in place when other Opacity keys share the track.
    const entry = 0.10;
    const exit = 0.16;
    const area = 1 - (entry + exit) / 2;
    if (u < entry) return entry * integratedStep(u / entry) / area;
    if (1 - u < exit) return 1 - exit * integratedStep((1 - u) / exit) / area;
    return (u - entry / 2) / area;
}

function luminanceToLightness(y) {
    return y <= luminanceToe ? lightnessSlope * y : 116 * Math.cbrt(y) - 16;
}

function lightnessToLuminance(lightness) {
    if (lightness <= 8) return lightness / lightnessSlope;
    const f = (lightness + 16) / 116;
    return f * f * f;
}

function fadeBetween(from, to, progress) {
    if (progress <= 0) return from;
    if (progress >= 1) return to;

    const ordinaryOpacity = mix(from, to, progress);
    const blackSolid = model === "blackSolid";
    const amount = clamp01(perceptualAmount);
    if (amount === 0 || (!blackSolid && model !== "footageOverBlack")) return ordinaryOpacity;

    // In Normal linear-light blending, the visible light under a black solid is 1 - alpha.
    const y0 = blackSolid ? 1 - from / 100 : from / 100;
    const y1 = blackSolid ? 1 - to / 100 : to / 100;
    const lightness = mix(luminanceToLightness(y0), luminanceToLightness(y1), progress);
    const luminance = clamp01(lightnessToLuminance(lightness));
    const perceptualOpacity = 100 * (blackSolid ? 1 - luminance : luminance);
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    return Math.max(low, Math.min(high, mix(ordinaryOpacity, perceptualOpacity, amount)));
}

function fadeOpacity() {
    if (numKeys < 2 || !Number.isInteger(startKey) || startKey < 0 || startKey >= numKeys) {
        return value;
    }

    if (startKey > 0 && numKeys > 2) {
        const first = key(startKey);
        const last = key(startKey + 1);
        const span = last.value - first.value;
        if (span === 0 || time <= first.time || time >= last.time) return value;
        const u = remapExistingCurve ? (value - first.value) / span : (time - first.time) / (last.time - first.time);
        return fadeBetween(first.value, last.value, intervalProgress(clamp01(u)));
    }

    const frame = thisComp.frameDuration;
    const layerStart = Math.min(thisLayer.inPoint, thisLayer.outPoint);
    const layerEnd = Math.max(thisLayer.inPoint, thisLayer.outPoint);
    const epsilon = 1e-7;
    const timeTolerance = epsilon * frame;
    const visibleStart = Math.max(0, layerStart);
    const visibleEnd = Math.min(thisComp.duration, layerEnd);
    const firstVisible = Math.ceil(visibleStart / frame - epsilon) * frame;
    const lastVisible = (Math.ceil(visibleEnd / frame - epsilon) - 1) * frame;
    const hasVisibleFrame = firstVisible <= lastVisible;
    const hasRoomToFit = firstVisible < lastVisible;

    const keys = [];
    for (let i = 1; i <= numKeys; i++) keys.push(key(i));

    let result = keys[0].value;
    let hasFade = false;
    let priorFadeEnd = keys[0].time;
    let afterHold = -Infinity;
    let beforeHold = Infinity;
    let nextHold = 0;
    for (let i = 1; i < keys.length; i++) {
        const first = keys[i - 1];
        const last = keys[i];
        const span = last.value - first.value;
        const duration = last.time - first.time;
        if (span !== 0 && duration > 0) {
            hasFade = true;
            const radius = Math.hypot(0.18, 1.25 * frame / duration);
            const begin = first.time - radius * duration;
            const end = last.time + radius * duration;

            // Fit visible transitions at a cut while retaining the smooth shape of each wing.
            let left = hasRoomToFit && first.time >= visibleStart - timeTolerance && last.time > firstVisible
                ? Math.max(begin, firstVisible) : begin;
            let right = hasRoomToFit && last.time <= visibleEnd + timeTolerance && first.time < lastVisible
                ? Math.min(end, lastVisible) : end;

            // Keep the wings of wholly offscreen transitions on their side of the trim.
            if (hasVisibleFrame && last.time <= firstVisible + timeTolerance) {
                right = Math.min(right, firstVisible);
            }
            if (hasVisibleFrame && first.time >= lastVisible - timeTolerance) {
                left = Math.max(left, lastVisible);
            }

            // Protect the middle of a hold from every fade in the adjacent groups.
            if (first.time > priorFadeEnd) {
                afterHold = first.time - Math.max(0, (first.time - priorFadeEnd - frame) / 2);
            }
            priorFadeEnd = last.time;
            if (i >= nextHold) {
                nextHold = i + 1;
                while (nextHold < keys.length && keys[nextHold].value !== keys[nextHold - 1].value) nextHold++;
                beforeHold = Infinity;
                if (nextHold < keys.length) {
                    const holdStart = keys[nextHold - 1];
                    let j = nextHold;
                    while (j + 1 < keys.length && keys[j + 1].value === holdStart.value) j++;
                    beforeHold = holdStart.time + Math.max(0, (keys[j].time - holdStart.time - frame) / 2);
                }
            }
            left = Math.max(left, afterHold);
            right = Math.min(right, beforeHold);

            if (time >= right || (right < end && time >= right - timeTolerance)) {
                result = last.value;
            } else if (time > left && (left === begin || time > left + timeTolerance) && right > left) {
                const u = left === begin && right === end
                    ? (time - first.time) / duration
                    : mix(-radius, 1 + radius, (time - left) / (right - left));
                const progress = automaticProgress(u, radius, duration, first, span);
                // A later overlapping fade blends from the current result toward its destination.
                result = fadeBetween(result, last.value, progress);
            }
        } else if (remapExistingCurve && span === 0 && time > first.time && time < last.time && value !== first.value) {
            // Equal keys can still contain an intentionally shaped Graph Editor excursion.
            result = result === first.value ? value : 100 * clamp01((result + value - first.value) / 100);
        }
    }
    return hasFade ? result : value;
}

fadeOpacity();
```

## Controls

| Setting | Default | When to change it |
| --- | --- | --- |
| `startKey` | `0` | Processes the whole Opacity track. On a track with three or more keys, enter a pair’s first key number (counting from 1) to shape only the time between those two keys. On a two-key track, `0` and `1` both use the automatic lead and settle. |
| `model` | `"blackSolid"` | Use `"blackSolid"` for a black overlay above the shot, `"footageOverBlack"` for footage fading over black, or `"opacity"` for ordinary opacity interpolation with the same timing treatment. |
| `remapExistingCurve` | `true` | Samples your Graph Editor easing as the input to the fade. Set it to `false` to use elapsed time as the input. Smoothing still applies. |
| `perceptualAmount` | `0.65` | Blends ordinary opacity (`0`) with a fade interpolated in CIE L\* lightness (`1`). Applies to the two black-fade models. |

## From the C∞ dip to black to a multi-key fade

The original dip used an infinitely flat ease at the endpoints of a single transition. Here an interior key can sit *inside* the motion. The expression samples each changing interval on a 24-segment grid, then rounds the sampled curve with a finite-width averaging kernel. The smoothing window scales with the interval’s duration and the comp’s frame duration.

The kernel integrates the quintic curve `6x⁵ − 15x⁴ + 10x³`. Where the rounded ramp joins a flat hold or a straight ramp, its first three derivatives match (**C³**). C∞ describes the original easing design. The C³ statement applies specifically to these temporal joins.

For a black overlay, 75% Opacity transmits 25% of the underlying image light under Normal blending in linear light. The expression uses that relationship at both keyed endpoints, including partial fades such as 20% → 70%. The lightness adjustment assumes linear-light compositing and uses no footage samples. Choose `"opacity"` if you want only the timing change.

## Timing limits

- **Cuts and trims.** If the smoothing would run past a cut, the expression fits it into the available frames. A destination keyed exactly at the composition’s exclusive end can land on the last visible frame. Trimming through the middle of an existing fade can leave a partial value at the cut.
- **Level stretches and Hold keys.** Two equal-valued keys give adjacent fades room to settle and restart while protecting the center of the pause. A Hold key that jumps to a *different* value is a different case. Whole-track smoothing rounds that jump. Use ordinary keyframes without this expression for a frame-exact hard cut.
- **Peaks and reversals.** When fades overlap, the next fade starts from the current result. A fast reversal can turn around short of the keyed peak. Give it a flat stretch if the shot must dwell there. Sampled progress on a changing pair is bounded by that pair’s values, so a Bézier overshoot can be lost.
- **Dense animation.** Whole-track mode walks the keys at each evaluation. The intended use is a track of authored fades. A property with a baked key on every frame can cost more to evaluate.

## Validation

The published expression passed 36,036 sampled range checks in a JavaScript model of the Opacity property, plus targeted checks for cut frames, short pauses, overlapping fades, partial ranges, trims and fractional frame rates. The four-key example above was measured from this expression in the same type of model.

An earlier revision produced 814 native Opacity samples in After Effects 25.6.5. This revision adds a trim fix that keeps adjacent offscreen fades from moving a keyed cut endpoint. The new trim cases passed in JavaScript. An active After Effects session prevented a fresh native run of this revision.
