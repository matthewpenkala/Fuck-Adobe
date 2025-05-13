/**************************************************************************************************
 * CURVE-CONTINUE v2.1 (Refactored Version!)
 * Original Code: [Matthew T. Penkala]
 *
 * Description:
 * This After Effects expression continues the motion path of a property with a curve
 * after its last keyframe. It intelligently fits a circular path to the motion leading
 * up to the last keyframe and extrapolates along this circle.
 *
 * Features:
 * - Effect Controls: Customizable look-back frames and curve influence via sliders.
 * - 3D Handling: Extrapolates Z-depth linearly while XY follows a curve.
 * - Blending: Allows blending between pure circular and linear continuation.
 * - Robustness: Handles cases with no keyframes, 1D properties, and collinear points.
 *
 * Instructions:
 * 1. Apply this expression to a spatial property (e.g., Position) or any multi-dimensional property
 * that has at least two dimensions for the curve calculation.
 * 2. Add three Slider Controls to the same layer (or a control layer referenced via pick-whipping):
 * - "LookBack1 (frames)" (Recommended default: 8, Min: 2)
 * - "LookBack2 (frames)" (Recommended default: 4, Min: 1)
 * - "Curve Influence (%)" (Recommended default: 100, Min: 0, Max: 100)
 * Ensure the names in the `getSliderValue` calls match your slider names exactly.
 *
 * Notes on LookBack sliders:
 * - "LookBack1 (frames)" defines the time for the earliest sample point (P1) before the last keyframe.
 * - "LookBack2 (frames)" defines the time for a later sample point (P2), closer to the last keyframe.
 * - The script ensures LookBack1 > LookBack2 to maintain chronological sampling P1 -> P2 -> P3 (last keyframe).
 * - These values determine the segment of recent animation used to calculate the curve.
 **************************************************************************************************/
(function curveContinue() {
    // --- Essential Timing & Property Info ---
    var compFrameDuration = thisComp.frameDuration;
    var currentExpressionTime = time; // The current time at which the expression is being evaluated

    // --- Helper Function: Safely Get Slider Values ---
    /**
     * Retrieves a numeric value from an effect slider control.
     * @param {string} effectName - The name of the effect controller (e.g., "LookBack1 (frames)").
     * @param {number} defaultValue - The value to return if the effect is not found or returns an invalid number.
     * @param {number} minValue - The minimum allowed value for the slider (after rounding).
     * @returns {number} The validated slider value.
     */
    function getSliderValue(effectName, defaultValue, minValue) {
        try {
            var sliderCtrl = effect(effectName)("Slider");
            if (typeof sliderCtrl === 'number' && !isNaN(sliderCtrl)) {
                return Math.max(minValue, Math.round(sliderCtrl));
            }
            // If slider value is not a valid number, return default.
            return defaultValue;
        } catch (e) {
            // Effect not found or other error accessing slider.
            return defaultValue;
        }
    }

    // --- User-Configurable Parameters via Effect Controls ---
    var lookBackFrames1 = getSliderValue("LookBack1 (frames)", 8, 2);
    var lookBackFrames2 = getSliderValue("LookBack2 (frames)", 4, 1);

    // Ensure lookBackFrames1 results in an earlier sample time than lookBackFrames2.
    // (Larger frame count means further back in time).
    if (lookBackFrames1 <= lookBackFrames2) {
        lookBackFrames1 = lookBackFrames2 + 1; // Ensure distinct and ordered samples.
    }

    var curveInfluenceFactor = clamp(getSliderValue("Curve Influence (%)", 100, 0) / 100, 0, 1); // Normalize to 0-1 range.

    // --- Preliminary Checks and Property State ---
    var propertyKeyCount = thisProperty.numKeys;

    // If there are no keyframes, return the property's current static value.
    if (propertyKeyCount === 0) {
        return thisProperty.value;
    }

    var lastKnotTime = thisProperty.key(propertyKeyCount).time;

    // If current time is before or at the last keyframe, use the original animation value.
    if (currentExpressionTime <= lastKnotTime) {
        return thisProperty.value;
    }

    // --- Calculate Sample Point Times ---
    // These are the times at which we'll sample the property's value to define the curve.
    // P3: lastKnotTime (the time of the last keyframe)
    // P2: lastKnotTime - (lookBackFrames2 * compFrameDuration)
    // P1: lastKnotTime - (lookBackFrames1 * compFrameDuration)
    var lookBackDuration1 = lookBackFrames1 * compFrameDuration;
    var lookBackDuration2 = lookBackFrames2 * compFrameDuration;

    var sampleTimeP1 = Math.max(0, lastKnotTime - lookBackDuration1); // Earliest sample time
    var sampleTimeP2 = Math.max(0, lastKnotTime - lookBackDuration2); // Intermediate sample time

    // Ensure distinct sample times, especially if lastKnotTime is close to the composition start.
    // If initial calculations result in P1 and P2 being too close or in the wrong order:
    if (sampleTimeP1 >= sampleTimeP2) {
        if (lastKnotTime > compFrameDuration) { // If last key isn't at the very start of the timeline
            sampleTimeP2 = Math.max(0, lastKnotTime - compFrameDuration); // Set P2 one frame duration before last knot.
            sampleTimeP1 = Math.max(0, sampleTimeP2 - compFrameDuration); // Set P1 one frame duration before P2.
        } else { // Last keyframe is at or very near time 0.
            sampleTimeP1 = sampleTimeP2 = lastKnotTime; // All sample times become the last knot time. This will lead to linear continuation.
        }
    }

    // --- Fetch Property Values at Sample Times ---
    var valueP1 = thisProperty.valueAtTime(sampleTimeP1);
    var valueP2 = thisProperty.valueAtTime(sampleTimeP2);
    var valueP3_LastKnot = thisProperty.valueAtTime(lastKnotTime);

    // --- Validate Property Type for Curve Calculation ---
    // Curve calculation requires at least 2D vector data (e.g., Position XY).
    // If property is scalar (1D) or not an array, fallback to linear continuation.
    if (!(valueP1 instanceof Array) || valueP1.length < 2) {
        try {
            return thisProperty.loopOut("continue"); // Standard linear continuation.
        } catch (e) {
            // Fallback for properties that might not support loopOut, or if it fails.
            // Manual linear extrapolation for scalar values: value + velocity * deltaTime
            if (typeof valueP3_LastKnot === 'number') {
                var scalarVelocity = 0;
                if (lastKnotTime - sampleTimeP2 !== 0) {
                    scalarVelocity = (valueP3_LastKnot - valueP2) / (lastKnotTime - sampleTimeP2);
                } else if (sampleTimeP2 - sampleTimeP1 !== 0) {
                    scalarVelocity = (valueP2 - valueP1) / (sampleTimeP2 - sampleTimeP1);
                } else if (propertyKeyCount > 0) { // Should always be true here
                     try { scalarVelocity = thisProperty.velocityAtTime(lastKnotTime); } catch(ve) {/*ignore*/}
                }
                if (typeof scalarVelocity !== 'number' || isNaN(scalarVelocity)) scalarVelocity = 0;
                return valueP3_LastKnot + scalarVelocity * (currentExpressionTime - lastKnotTime);
            }
            return valueP3_LastKnot; // Absolute failsafe: return the last keyframe's value.
        }
    }

    // --- Circular Path Calculation (Primarily in XY Plane) ---
    // Define vectors in the XY plane from P1 to P2, and P1 to P3.
    var vec_P1P2_XY = [valueP2[0] - valueP1[0], valueP2[1] - valueP1[1]];
    var vec_P1P3_XY = [valueP3_LastKnot[0] - valueP1[0], valueP3_LastKnot[1] - valueP1[1]];

    // Calculate the Z component of the 2D cross product: 2 * (v1.x*v2.y - v1.y*v2.x).
    // This value is proportional to the signed area of the triangle formed by P1, P2, P3.
    // If it's zero, the points are collinear in the XY plane.
    var crossProductZ_XY = 2 * (vec_P1P2_XY[0] * vec_P1P3_XY[1] - vec_P1P2_XY[1] * vec_P1P3_XY[0]);

    var colinearityToleranceXY = 1e-6; // Tolerance for checking if points are collinear.
    if (Math.abs(crossProductZ_XY) < colinearityToleranceXY) {
        // Points are collinear (or identical); circular path is undefined or unstable. Fallback to linear.
        return thisProperty.loopOut("continue");
    }

    // Squared magnitudes of the vectors.
    var magSq_P1P2_XY = dot(vec_P1P2_XY, vec_P1P2_XY);
    var magSq_P1P3_XY = dot(vec_P1P3_XY, vec_P1P3_XY);

    // Calculate the center of the circle passing through P1, P2, P3 in the XY plane.
    // Formula for circumcenter of a triangle.
    var circleCenterX_XY = valueP1[0] + (vec_P1P3_XY[1] * magSq_P1P2_XY - vec_P1P2_XY[1] * magSq_P1P3_XY) / crossProductZ_XY;
    var circleCenterY_XY = valueP1[1] + (vec_P1P2_XY[0] * magSq_P1P3_XY - vec_P1P3_XY[0] * magSq_P1P2_XY) / crossProductZ_XY;
    var circleCenterXY = [circleCenterX_XY, circleCenterY_XY];

    // Calculate the radius of this circle in the XY plane.
    var radiusXY = length([valueP3_LastKnot[0] - circleCenterX_XY, valueP3_LastKnot[1] - circleCenterY_XY]);

    var radiusTolerance = 1e-4; // Tolerance for minimum radius.
    if (radiusXY < radiusTolerance) {
        // Radius is extremely small; points are effectively collinear or coincident. Fallback to linear.
        return thisProperty.loopOut("continue");
    }

    // Angles of P2 and P3 relative to the circle center in the XY plane.
    var angleP2_XY = Math.atan2(valueP2[1] - circleCenterY_XY, valueP2[0] - circleCenterX_XY);
    var angleP3_XY = Math.atan2(valueP3_LastKnot[1] - circleCenterY_XY, valueP3_LastKnot[0] - circleCenterX_XY);
    
    // Calculate normalized angular velocity in the XY plane.
    var timeDelta_P2P3 = lastKnotTime - sampleTimeP2;
    var angularVelocityXY = calculateNormalizedAngularVelocity(angleP3_XY, angleP2_XY, timeDelta_P2P3);

    // --- Extrapolate Position Along the Curve ---
    var timeSinceLastKnot = currentExpressionTime - lastKnotTime;
    var extrapolatedAngleXY = angleP3_XY + angularVelocityXY * timeSinceLastKnot;

    // Calculate the new XY position on the circle.
    var extrapolatedPosition = [
        circleCenterX_XY + Math.cos(extrapolatedAngleXY) * radiusXY,
        circleCenterY_XY + Math.sin(extrapolatedAngleXY) * radiusXY
    ];

    // Handle Z-coordinate for 3D properties (linear extrapolation for Z).
    if (valueP3_LastKnot.length > 2) {
        var zVelocity = 0;
        if (valueP2.length > 2 && timeDelta_P2P3 !== 0) {
            zVelocity = (valueP3_LastKnot[2] - valueP2[2]) / timeDelta_P2P3;
        } else if (valueP2.length > 2 && timeDelta_P2P3 === 0) { // P2 and P3 at same time, try AE velocity
            try {
                var fullVelocity = thisProperty.velocityAtTime(lastKnotTime);
                if (fullVelocity instanceof Array && fullVelocity.length > 2) zVelocity = fullVelocity[2];
            } catch(e){ zVelocity = 0; }
        }
        if (typeof zVelocity !== 'number' || isNaN(zVelocity)) zVelocity = 0;
        extrapolatedPosition.push(valueP3_LastKnot[2] + zVelocity * timeSinceLastKnot);
    }

    // --- Blend Between Circular and Linear Continuation ---
    // If curveInfluenceFactor is effectively 1 (full curve), return the circular position.
    if (curveInfluenceFactor > 0.9999) { // Using a small tolerance for floating point comparison.
        return extrapolatedPosition;
    }

    // Calculate linear extrapolation if blending is needed.
    var velocityAtLastKnot;
    try {
        // Get AE's calculated velocity at the last keyframe.
        velocityAtLastKnot = toArray(thisProperty.velocityAtTime(lastKnotTime), valueP3_LastKnot.length);
    } catch (e) {
        // Fallback if velocityAtTime fails: manually calculate velocity P2->P3 or P1->P2.
        var manualVelocity = [];
        var N = valueP3_LastKnot.length;
        if (timeDelta_P2P3 !== 0) {
            for(var i=0; i<N; i++) manualVelocity[i] = (valueP3_LastKnot[i] - (valueP2[i]||0)) / timeDelta_P2P3;
        } else {
            var timeDelta_P1P2 = sampleTimeP2 - sampleTimeP1;
            if (timeDelta_P1P2 !== 0) {
                for(var i=0; i<N; i++) manualVelocity[i] = ((valueP2[i]||0) - (valueP1[i]||0)) / timeDelta_P1P2;
            } else { // All points at same time, no velocity
                for(var i=0; i<N; i++) manualVelocity[i] = 0;
            }
        }
        velocityAtLastKnot = toArray(manualVelocity, N); // Ensure correct format/length
    }
    
    var linearExtrapolatedPosition = add(valueP3_LastKnot, mul(velocityAtLastKnot, timeSinceLastKnot));

    // Blend the linear and circular extrapolated positions.
    return blend(linearExtrapolatedPosition, extrapolatedPosition, curveInfluenceFactor);

    // --- Core Helper Functions ---

    /** Clamps a value between a minimum and maximum. */
    function clamp(value, minValue, maxValue) {
        return Math.min(Math.max(value, minValue), maxValue);
    }

    /** Computes the dot product of two 2D vectors (assumed to be arrays of length at least 2). */
    function dot(vector1, vector2) {
        return vector1[0] * vector2[0] + vector1[1] * vector2[1];
    }

    /** Computes the length (magnitude) of a 2D vector (assumed to be an array of length at least 2). */
    function length(vector) {
        return Math.sqrt(dot(vector, vector)); // Same as Math.hypot(vector[0], vector[1])
    }

    /**
     * Calculates the normalized angular velocity between two angles over a time delta.
     * Ensures the shortest angle is used for calculating velocity.
     * @param {number} angleEnd - The final angle in radians.
     * @param {number} angleStart - The initial angle in radians.
     * @param {number} timeDelta - The time duration between the angles.
     * @returns {number} The normalized angular velocity in radians per unit of time.
     */
    function calculateNormalizedAngularVelocity(angleEnd, angleStart, timeDelta) {
        var deltaAngle = angleEnd - angleStart;
        var effectiveTimeDelta = timeDelta;

        // Prevent division by zero or extremely small deltaTime values.
        if (Math.abs(timeDelta) < (compFrameDuration / 100000) ) { // Check against a very small fraction of frame duration
             if (compFrameDuration > 0) {
                effectiveTimeDelta = Math.sign(timeDelta || 1) * compFrameDuration; // Use frame duration, preserving sign if original delta was non-zero
             } else {
                effectiveTimeDelta = Math.sign(timeDelta || 1) * 0.001; // Absolute fallback if frame duration is zero (e.g. stills comp)
             }
        }
         if (effectiveTimeDelta === 0) effectiveTimeDelta = 1; // Ultimate fallback to prevent division by zero

        var PI2 = 2 * Math.PI;
        // Normalize deltaAngle to the range [-PI, PI] to ensure the shortest path around the circle.
        // Uses true mathematical modulo: ((x % N) + N) % N for positive result, then adjusts.
        var normalizedDeltaAngle = (((deltaAngle + Math.PI) % PI2 + PI2) % PI2) - Math.PI;
        
        return normalizedDeltaAngle / effectiveTimeDelta;
    }

    /**
     * Adds two vectors (arrays of numbers) component-wise.
     * Assumes vectors are of the same length, or that the main logic handles discrepancies.
     */
    function add(vector1, vector2) {
        return vector1.map(function(value, index) {
            // Ensure vector2 has a corresponding component, otherwise default to 0 for addition.
            return value + (vector2[index] || 0);
        });
    }

    /** Multiplies a vector (array of numbers) by a scalar. */
    function mul(vector, scalar) {
        return vector.map(function(value) {
            return value * scalar;
        });
    }

    /**
     * Converts a scalar value to an array of a given length, or ensures an input array
     * is conformed to the target length (padding with zero or truncating).
     * @param {number|Array<number>} valueOrArray - The scalar value or an existing array.
     * @param {number} targetLength - The desired length of the output array.
     * @returns {Array<number>} An array of the specified targetLength.
     */
    function toArray(valueOrArray, targetLength) {
        var newArray = [];
        if (valueOrArray instanceof Array) {
            for (var i = 0; i < targetLength; i++) {
                newArray[i] = (i < valueOrArray.length && typeof valueOrArray[i] === 'number' && !isNaN(valueOrArray[i])) ? valueOrArray[i] : 0;
            }
        } else { // Input is a scalar
            var fillValue = (typeof valueOrArray === 'number' && !isNaN(valueOrArray)) ? valueOrArray : 0;
            for (var i = 0; i < targetLength; i++) {
                newArray[i] = fillValue;
            }
        }
        return newArray;
    }

    /**
     * Blends two vectors component-wise using After Effects' linear interpolation.
     * Assumes vectorA and vectorB have compatible lengths based on prior logic.
     * @param {Array<number>} vectorA - Value when blendFactor is 0.
     * @param {Array<number>} vectorB - Value when blendFactor is 1.
     * @param {number} blendFactor - Blend factor from 0.0 to 1.0.
     * @returns {Array<number>} The blended vector.
     */
    function blend(vectorA, vectorB, blendFactor) {
        return vectorA.map(function(valueA, index) {
            // Ensure vectorB has a corresponding component, otherwise use valueA (effectively no change for that component from B).
            var valueB = (vectorB.length > index && typeof vectorB[index] === 'number' && !isNaN(vectorB[index])) ? vectorB[index] : valueA;
            return linear(blendFactor, valueA, valueB);
        });
    }

})();
