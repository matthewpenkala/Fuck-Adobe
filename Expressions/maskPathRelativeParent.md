# Relative Mask-Path Position Parent

A bind-relative Adobe After Effects **Mask Path** expression that lets one layer's positional movement drive another layer's mask **without actually parenting or moving the masked footage layer**. The mask keeps its authored placement and current path animation, while inheriting only the selected driver's comp-space anchor displacement from a defined bind state.

The expression is intentionally **additive**: it adds driver displacement on top of whatever motion the masked layer already has. It is not a stabilization/world-lock system and it does not subtract host-layer movement.

> **Important:** do not also parent the masked footage to the same driver merely to move the mask. If the host already moves 30 px right and the driver contributes another 30 px right, the rendered mask can move 60 px right from its original comp position. That is the intended motion model.

## What It Does

- Targets a **Mask Path on a 2D layer**; it is not intended for a shape-group Path.
- Uses a Layer Control named **Mask Parent** on the masked layer to select the driver.
- Measures the driver's **comp-space anchor displacement** between the bind time and the current time.
- Samples the driver's anchor and transform at their matching times, so animated anchors and parent hierarchies are accounted for.
- Converts the resulting comp-space displacement back into the masked layer's **current local coordinate system as a vector**.
- Applies that displacement to the **current underlying mask vertices**, preserving existing Mask Path animation.
- Leaves relative Bezier tangents unchanged, preserving the translated curve shape.
- Preserves open/closed state.
- Uses exact no-op returns at bind and at exact zero displacement to avoid unnecessary path reconstruction.
- Treats no driver or self-selection as an unchanged/no-op state.
- Keeps a missing or renamed **Mask Parent** effect visible as a setup error rather than silently hiding it.
- Rejects a 3D masked layer and numerically non-invertible 2D host transforms instead of producing unreliable coordinates.
- Preserves even extremely small intended movement; there is no positional dead band.
- Requires After Effects' modern **JavaScript** expression engine.

## Compatibility

**Expression-language compatibility target: After Effects 16.0+ using the JavaScript expression engine.**

Use:

**File > Project Settings > Expressions > Expressions Engine > JavaScript**

The expression uses modern JavaScript features including `const`, `let`, `Number.isFinite()`, `Math.hypot()`, and `Array.prototype.map()`. It is intentionally not written for the Legacy ExtendScript expression engine.

This revision was validated mathematically and in modeled expression environments, but it was **not executed inside a native After Effects host during this audit**. See **Validation** and **Known Limits** below.

## Setup / Usage

1. Use a **2D layer** containing the mask you want to move.
2. On that same masked layer, add **Effect > Expression Controls > Layer Control**.
3. Rename the Layer Control exactly **Mask Parent**.
4. Choose the layer or null whose positional movement should drive the mask.
5. Paste the expression below directly onto the mask's **Mask Path** property.
6. Leave `overrideBindFrame = -1` for automatic binding, or set an explicit nonnegative composition-relative frame offset when the reference must remain fixed.

A normal layer or null is the intended driver. This is not a general 3D world-space attachment system, and camera/light behavior is not a supported design target.

## Bind Reference

| `overrideBindFrame` | Behavior |
| ---: | --- |
| **-1** | Automatic. If the Mask Path has exactly one keyframe, that keyframe time is the bind time; otherwise the masked layer's In Point is used. |
| **0 or greater** | Explicit composition-relative frame offset. `0` means composition time zero. Fractional frame values are supported. |

The explicit frame value is **composition-relative**, not displayed timecode. Automatic mode is also not a stored/captured bind pose: changing the mask's key count or trimming the host layer can change which automatic bind time is selected. Use an explicit override when the reference must remain stable.

## Expression

Paste only this JavaScript block onto the target **Mask Path**:

~~~js
// ============================================================
// RELATIVE MASK-PATH POSITION PARENT
// Adobe After Effects - JavaScript Expression Engine
// Reviewed revision: 2026-10-06
// Target: Mask Path on a 2D layer (not a shape-group Path).
// ============================================================
// Add a Layer Control to the MASKED layer; name it "Mask Parent".
// Choose the driver there. Do not also parent the footage to that
// driver merely to move the mask: this expression ADDS motion.
// Missing effect = setup error. None/self-selection = unchanged.
// Use an ordinary layer/null as driver, not a camera or light.

// -1 = Auto: exactly one Mask Path key -> that key's time;
//            otherwise -> this layer's In Point.
// 0+ = Composition-relative frame offset; 0 is comp time zero.
//      Not displayed timecode. Fractional frames are supported.
// Set this explicitly before changing key count/trimming if the
// reference must remain fixed; Auto is not a stored bind pose.
const overrideBindFrame = -1;

/** @param {number[]} vector @param {string} label */
function requireFiniteXY(vector, label) {
    if (!Number.isFinite(vector[0]) || !Number.isFinite(vector[1])) {
        throw new Error("Mask Parent: non-finite " + label + ".");
    }
}

function relativeMaskPosition() {
    if (
        typeof overrideBindFrame !== "number" ||
        !Number.isFinite(overrideBindFrame) ||
        (overrideBindFrame < 0 && overrideBindFrame !== -1)
    ) {
        throw new Error("Mask Parent: bind frame must be -1 or a finite number >= 0.");
    }

    // Keep a missing/renamed effect visible as a setup error.
    const control = effect("Mask Parent");
    let driver = null;
    try {
        // Parameter 1 avoids the localized UI label "Layer".
        // Access index too: None can fail only on dereferencing.
        const candidate = control(1);
        if (candidate.index > 0) {
            driver = candidate;
        }
    } catch (selectionError) {
        // Catch selection resolution only, not geometry/transform errors.
        driver = null;
    }

    if (driver === null || driver.index === thisLayer.index) {
        return value;
    }

    // threeDLayer is a scripting attribute; use expression data instead.
    if (thisLayer.transform.anchorPoint.value.length !== 2) {
        throw new Error("Mask Parent: the masked layer must be 2D.");
    }

    let bindTime;
    if (overrideBindFrame >= 0) {
        bindTime = framesToTime(overrideBindFrame);
    } else if (thisProperty.numKeys === 1) {
        bindTime = thisProperty.key(1).time;
    } else {
        bindTime = thisLayer.inPoint;
    }

    // Exact no-op: do not round/rebuild the underlying path at bind.
    if (time === bindTime) {
        return value;
    }

    // Sample each anchor AND transform at the corresponding time.
    // Own rotation/scale about that anchor adds no direct motion.
    // Ancestor transforms can move the anchor and therefore DO count.
    const anchorNow = driver.transform.anchorPoint.valueAtTime(time);
    const anchorBind = driver.transform.anchorPoint.valueAtTime(bindTime);
    const positionNow = driver.toComp(anchorNow, time);
    const positionBind = driver.toComp(anchorBind, bindTime);
    const deltaComp = [
        positionNow[0] - positionBind[0],
        positionNow[1] - positionBind[1]
    ];
    requireFiniteXY(deltaComp, "driver displacement");

    // No epsilon/dead band: preserve even very small intended motion.
    if (deltaComp[0] === 0 && deltaComp[1] === 0) {
        return value;
    }

    // Test the current 2D mapping, including the host parent hierarchy.
    // Reject collapsed or numerically near-parallel axes. Normalize first
    // so tiny but perpendicular scales are not mistaken for a collapse.
    // This stability threshold is NOT a dead band on mask movement.
    const axisX = thisLayer.toCompVec([1, 0], time);
    const axisY = thisLayer.toCompVec([0, 1], time);
    requireFiniteXY(axisX, "host X basis");
    requireFiniteXY(axisY, "host Y basis");
    const lengthX = Math.hypot(axisX[0], axisX[1]);
    const lengthY = Math.hypot(axisY[0], axisY[1]);
    const basisSine =
        (axisX[0] / lengthX) * (axisY[1] / lengthY) -
        (axisX[1] / lengthX) * (axisY[0] / lengthY);
    if (!Number.isFinite(basisSine) || Math.abs(basisSine) <= 1e-12) {
        throw new Error("Mask Parent: the host 2D transform is not invertible reliably; check layer/parent Scale.");
    }

    // A displacement is a VECTOR. Use the host transform at NOW,
    // not at bind: the mask is rendered through the current host.
    const deltaLocal = thisLayer.fromCompVec(deltaComp, time);
    requireFiniteXY(deltaLocal, "local displacement");

    // Read CURRENT underlying geometry, not the shape at bind.
    // AE's point/tangent accessors round to four decimal places.
    const sourcePoints = thisProperty.points(time);
    if (sourcePoints.length === 0) {
        return value;
    }
    const sourceInTangents = thisProperty.inTangents(time);
    const sourceOutTangents = thisProperty.outTangents(time);
    const sourceIsClosed = thisProperty.isClosed();

    // Tangents are offsets from vertices, so leave them unchanged.
    const movedPoints = sourcePoints.map(point => {
        const moved = [point[0] + deltaLocal[0], point[1] + deltaLocal[1]];
        requireFiniteXY(moved, "translated vertex");
        return moved;
    });

    return thisProperty.createPath(
        movedPoints,
        sourceInTangents,
        sourceOutTangents,
        sourceIsClosed
    );
}

relativeMaskPosition();
~~~

## How It Works

### 1. Resolve the driver and bind state

The expression reads parameter 1 of the **Mask Parent** Layer Control. Indexed parameter access avoids depending on the localized UI label for the control's child property. A missing control remains an explicit setup error; an unassigned control or self-selection returns the underlying mask unchanged.

The bind time is then resolved from `overrideBindFrame`, the sole Mask Path keyframe when exactly one exists, or the host layer's In Point.

### 2. Measure driver displacement in composition space

At both the current time and bind time, the driver's own Anchor Point is sampled and passed through `toComp()` at the corresponding time. This yields the driver's actual comp-space anchor position through any parent hierarchy.

Conceptually:

~~~text
deltaComp = driverAnchorComp(now) - driverAnchorComp(bind)
~~~

Using the driver's anchor location intentionally means rotation or scale **about that driver's own anchor** does not directly move the mask. Ancestor transforms that move the anchor in comp space do count.

### 3. Convert displacement as a vector through the host's current transform

Mask vertices live in the masked layer's local coordinate system, but `deltaComp` is a composition-space displacement. The expression therefore converts the displacement using `fromCompVec()` rather than treating it as an absolute point.

The conversion is evaluated through the host layer's **current** transform. This matters because the mask is rendered through the host's transform at the current frame.

Conceptually, for the current host transform `H_t(p) = A_t p + b_t`:

~~~text
p_out(t) = p_source(t) + inverse(A_t) * deltaComp(t)
~~~

which gives:

~~~text
H_t(p_out(t)) = H_t(p_source(t)) + deltaComp(t)
~~~

So the mask's current rendered position receives exactly the driver's measured comp-space displacement under the intended 2D affine model.

### 4. Translate the current mask geometry

The expression reads `points(time)`, `inTangents(time)`, `outTangents(time)`, and the closed/open state at the current time. It shifts only the vertices by `deltaLocal` and leaves the relative tangent offsets unchanged.

Because After Effects stores mask tangents as offsets from their corresponding vertices, translating the vertices while retaining the same tangent offsets translates the Bezier curve without reshaping it.

Existing Mask Path animation therefore remains the source geometry rather than being frozen to the bind frame.

### 5. Preserve exact no-op states

At the bind time, or when the driver displacement is exactly `[0, 0]`, the expression returns the native `value` directly rather than rebuilding an identical path.

This is intentionally exact rather than epsilon-based: tiny nonzero movement is still retained. It also avoids needless use of After Effects' path point/tangent accessors in no-op states, where those accessors can round returned geometry to four decimal places.

### 6. Guard unstable transforms and non-finite results

The host's transformed X/Y basis vectors are inspected before inversion. The determinant test is performed on normalized axes so a very small but valid perpendicular scale is not misclassified as a collapse.

Collapsed or numerically near-parallel axes, as well as `NaN`/infinite displacement or translated geometry, produce an explicit error rather than silently feeding invalid coordinates into the mask.

## Additive Motion Model

This expression deliberately **adds** driver movement; it does not compensate for movement already supplied by the masked layer or its parent hierarchy.

| Situation | Result |
| --- | --- |
| Host is static; driver moves +30 px X | Mask gains +30 px X in comp space. |
| Host moves +30 px X; driver moves +30 px X | Mask can move +60 px X from the original comp position. |
| Driver rotates/scales around its own stationary anchor | No direct mask translation from that rotation/scale alone. |
| Driver's parent moves the driver's anchor | That anchor movement contributes to the mask displacement. |
| Host transform changes after bind | Driver displacement is converted through the host's current transform. |

If the desired behavior is world locking, stabilization, subtraction of shared hierarchy motion, or a full transform parent, that is a different expression contract.

## Behavioral Sanity Checks

| Scenario | Expected behavior |
| --- | --- |
| Layer Control is unassigned | Underlying Mask Path passes through unchanged. |
| Masked layer selects itself | Underlying Mask Path passes through unchanged. |
| `Mask Parent` effect is missing/renamed | Explicit setup error. |
| Exact bind time | Native Mask Path returned directly. |
| Driver has exact zero displacement | Native Mask Path returned directly. |
| Tiny but nonzero displacement | Preserved; no positional epsilon/dead band. |
| Existing Mask Path animation | Current animated geometry is translated, not frozen to bind. |
| Open mask | Remains open. |
| Closed mask | Remains closed. |
| Driver has animated Anchor Point | Matching-time anchor sampling is respected. |
| Driver has nested animated parents | Resulting comp-space anchor movement is included. |
| Masked layer is 3D | Explicit unsupported-scope error. |
| Host 2D transform is collapsed/non-invertible | Explicit transform error. |
| Invalid `overrideBindFrame` | Explicit bind-setting error. |

## Validation

The review and regression pass for this revision included:

- syntax parsing of the original and revised expression;
- strict TypeScript checking against minimal locally authored AE declarations, with zero diagnostics;
- **73 / 73** directed modeled-expression tests;
- **10,000 / 10,000** seeded randomized 2D affine hierarchy cases;
- original-versus-revised moving-coordinate regression comparison with a **maximum modeled difference of 0** across those 10,000 cases;
- **14 / 14** deliberately faulty variants detected by the test suite;
- **10,000 / 10,000** independent NumPy affine-solver checks;
- **5,000 / 5,000** independent cubic-Bezier translation checks;
- coverage for animated parents, negative/nonuniform scales, host animation, animated driver anchors, fractional timing, automatic/explicit binding, current path animation, open/empty/single-point paths, tiny motion, None/self selection, expected error propagation, collapsed axes, and out-of-order evaluation.

The largest saved floating-point residuals in those offline checks were on the order of `1e-11` to `1e-12` in the modeled coordinate calculations.

These are **mathematical/model validation results, not native After Effects render measurements**. A native acceptance harness was prepared separately during the audit, but the final expression was not executed in a real AE runtime as part of that review.

## Known Limits

- The masked/host layer must be **2D**.
- This is a **position-displacement attachment**, not a complete transform parent. It does not inherit the driver's rotation, scale, opacity, or full transform matrix.
- The intended driver is a normal layer or null. True camera-projected 3D behavior was not natively validated.
- Shared motion between host and driver is not automatically subtracted.
- Automatic binding is derived each evaluation; it is not a permanently captured pose.
- Reconstructing a moving path through `points()` / tangent accessors inherits After Effects' documented four-decimal point/tangent accessor precision. Exact no-op branches avoid that reconstruction where possible.
- RotoBezier behavior, variable-width mask feather metadata, mixed 2D/3D hierarchies, continuously rasterized/collapsed-transform edge cases, non-square pixel-aspect relationships, time stretch/remapping combinations, motion blur, and multi-frame rendering were not natively validated in the production project.
- Expression dependency cycles remain possible if the selected driver ultimately depends back on this mask or its result.

Those items are coverage/contract boundaries, not claims that every listed configuration is necessarily broken.

## Performance Notes

The moving branch performs two driver `toComp()` projections, two host-basis `toCompVec()` probes, one `fromCompVec()` conversion, and one linear pass over the current mask vertices. Path accessors occur once per moving evaluation outside the vertex loop.

Exact bind and exact-zero-displacement states return early. No native After Effects performance benchmark was run, so no frame-time improvement or performance-equivalence claim is made.

## References

- Adobe After Effects Expression Language Reference: `https://helpx.adobe.com/after-effects/desktop/work-with-expressions/expression-language-reference/expression-language-reference.html`
- Adobe expression engine / syntax differences: `https://helpx.adobe.com/after-effects/desktop/work-with-expressions/expression-basics/legacy-and-extend-script-engine.html`
- Adobe expression controls: `https://helpx.adobe.com/after-effects/desktop/work-with-expressions/expression-controls/expression-controls.html`
- Adobe shape paths and masks: `https://helpx.adobe.com/gr_en/after-effects/desktop/animate-in-after-effects/animate-shape-paths-and-masks/animating-shape-paths-masks.html`

## Recommended Production Use

Use this revision when the requirement is specifically:

> Keep the footage layer's own transform independent, preserve the authored/animated mask shape, and add one selected layer's bind-relative **position displacement** to that mask in comp space.

If that is the intended motion model, the revised expression is the recommended implementation from this review. Native inspection of the actual production shot remains the final acceptance step before treating the composition itself as fully validated.