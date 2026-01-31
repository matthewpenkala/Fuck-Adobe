/*  FitCubicBezierFromBakedKeys.jsx
    ---------------------------------
    Dockable ScriptUI panel that fits a single CSS-style cubic-bezier(x1,y1,x2,y2)
    to selected baked keyframes on selected 1D properties.

    - Reads selected keyframes (>= 3) on selected properties.
    - Converts to normalized time t in [0..1] and progress s in [0..1].
    - Fits a single cubic bezier easing by minimizing SSE over interior samples.
    - Inverts x(u)=t per sample via Newton + bisection fallback.
    - Optimizes with Nelder–Mead (derivative-free), optionally with a restart grid.
    - Optionally collapses keys to first+last selected and applies AE temporal ease.
	
    1) Reads selected keyframes on selected 1D properties (e.g. X Position, Slider, Opacity).
    2) Fits ONE CSS-style cubic-bezier(x1,y1,x2,y2) that best matches the baked samples:
         - Normalizes time to [0..1] and progress to [0..1]
         - For each sample time t: solves x(u)=t (Newton + bisection fallback), then uses y(u) as progress
         - Minimizes least-squares error over interior samples using Nelder–Mead (derivative-free)
         - Optional multi-start "Restart grid" for robustness
    3) On "Fit + Apply":
         - Optionally removes ALL keys strictly between first+last selected key times (span collapse)
         - Applies the fitted easing to ONLY the segment between the first and last key
           by setting AE temporal easing on:
              * first key OUT (outgoing)
              * last key  IN (incoming)
           while preserving the outside sides (first IN, last OUT) to avoid messing adjacent segments.

    Notes:
    - Works on 1D properties only.
    - Requires at least 2 selected keys to define the span.
    - For fitting:
        * If >=3 keys are selected: uses SELECTED keys as samples (what you originally asked)
        * If only 2 keys are selected: tries to use ALL keys in the span as samples (robust baked workflow)
          (must be >=3 total keys in span; otherwise it skips because the curve is underdetermined)

    Tested conceptually with AE ExtendScript API conventions.
    Save into ScriptUI Panels folder for dockable panel.
*/

#target aftereffects

(function FitCubicBezier_UI(thisObj) {

    // -----------------------------
    // CONFIG (UI drives these)
    // -----------------------------
    var CFG = {
        COLLAPSE_ALL_IN_SPAN: true,   // remove all interior keys between first+last
        CLAMP_Y_TO_0_1: false,        // constrain y1,y2 into [0..1]
        ENFORCE_X_ORDER: false,       // penalty if x1 > x2
        RESTART_GRID: true,           // multi-start
        MAX_NM_ITERS: 260,            // per start
        EPS: 1e-8,
        LOG_TO_CONSOLE: true
    };

    // -----------------------------
    // UTILS
    // -----------------------------
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function abs(v) { return Math.abs(v); }
    function sq(v) { return v * v; }
    function isComp(item) { return item && (item instanceof CompItem); }
    function fmt(n, d) { if (d === undefined) d = 6; return n.toFixed(d); }
    function influenceClamp(v) { return clamp(v, 0.1, 100.0); } // AE-ish safe range

    function safeWriteln(msg) {
        if (!CFG.LOG_TO_CONSOLE) return;
        try { $.writeln(msg); } catch (e) {}
    }

    function tryCopyToClipboard(text) {
        // ExtendScript has no native clipboard. Use OS helpers.
        // macOS: pbcopy, Windows: clip
        try {
            if ($.os.toLowerCase().indexOf("mac") !== -1) {
                var esc = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
                system.callSystem('echo "' + esc + '" | pbcopy');
                return true;
            } else {
                var escW = text.replace(/\^/g, "^^")
                               .replace(/&/g, "^&")
                               .replace(/\|/g, "^|")
                               .replace(/</g, "^<")
                               .replace(/>/g, "^>")
                               .replace(/"/g, '\\"');
                system.callSystem('cmd.exe /c "echo ' + escW + ' | clip"');
                return true;
            }
        } catch (e) {
            return false;
        }
    }

    // -----------------------------
    // CUBIC BEZIER (CSS-style)
    // P0=(0,0), P1=(x1,y1), P2=(x2,y2), P3=(1,1)
    // -----------------------------
    function bezierCoord(u, a1, a2) {
        var om = 1.0 - u;
        return 3.0 * om * om * u * a1 + 3.0 * om * u * u * a2 + u * u * u;
    }

    function bezierCoordDeriv(u, a1, a2) {
        var om = 1.0 - u;
        return 3.0 * om * om * a1 + 6.0 * om * u * (a2 - a1) + 3.0 * u * u * (1.0 - a2);
    }

    function invertUForT(t, x1, x2) {
        // Solve x(u)=t with Newton, fallback to bisection
        var u = t;
        var i, xu, d, uNext;

        for (i = 0; i < 12; i++) {
            xu = bezierCoord(u, x1, x2);
            var err = xu - t;
            if (abs(err) < 1e-7) return u;

            d = bezierCoordDeriv(u, x1, x2);
            if (abs(d) < 1e-9) break;

            uNext = u - err / d;
            if (uNext < 0.0 || uNext > 1.0) break;
            u = uNext;
        }

        var lo = 0.0, hi = 1.0, mid;
        for (i = 0; i < 32; i++) {
            mid = (lo + hi) * 0.5;
            xu = bezierCoord(mid, x1, x2);
            if (xu < t) lo = mid;
            else hi = mid;
        }
        return (lo + hi) * 0.5;
    }

    function easeYforT(t, x1, y1, x2, y2) {
        var u = invertUForT(t, x1, x2);
        return bezierCoord(u, y1, y2);
    }

    // -----------------------------
    // NELDER–MEAD (derivative-free)
    // -----------------------------
    function nmMinimize(f, x0, step, maxIter) {
        var n = x0.length;
        var simplex = [];
        var values = [];

        function copyVec(v) {
            var out = [];
            for (var i = 0; i < v.length; i++) out.push(v[i]);
            return out;
        }
        function addVec(a, b, scaleB) {
            var out = [];
            for (var i = 0; i < a.length; i++) out.push(a[i] + b[i] * scaleB);
            return out;
        }
        function subVec(a, b) {
            var out = [];
            for (var i = 0; i < a.length; i++) out.push(a[i] - b[i]);
            return out;
        }
        function centroid(exceptIndex) {
            var c = [];
            for (var i = 0; i < n; i++) c.push(0.0);
            for (var j = 0; j < simplex.length; j++) {
                if (j === exceptIndex) continue;
                for (var i2 = 0; i2 < n; i2++) c[i2] += simplex[j][i2];
            }
            var denom = (simplex.length - 1);
            for (var i3 = 0; i3 < n; i3++) c[i3] /= denom;
            return c;
        }

        simplex.push(copyVec(x0));
        for (var i = 0; i < n; i++) {
            var v = copyVec(x0);
            v[i] += step[i];
            simplex.push(v);
        }

        for (var s = 0; s < simplex.length; s++) values.push(f(simplex[s]));

        function sortSimplex() {
            var idx = [];
            for (var i = 0; i < values.length; i++) idx.push(i);
            idx.sort(function(a, b) { return values[a] - values[b]; });

            var newSimplex = [];
            var newValues = [];
            for (var j = 0; j < idx.length; j++) {
                newSimplex.push(simplex[idx[j]]);
                newValues.push(values[idx[j]]);
            }
            simplex = newSimplex;
            values = newValues;
        }

        var alpha = 1.0, gamma = 2.0, rho = 0.5, sigma = 0.5;

        for (var iter = 0; iter < maxIter; iter++) {
            sortSimplex();

            var best = simplex[0];
            var worst = simplex[n];
            var secondWorstVal = values[n - 1];
            var worstVal = values[n];

            var c = centroid(n);

            // Reflection
            var xr = addVec(c, subVec(c, worst), alpha);
            var fr = f(xr);

            if (fr < values[0]) {
                // Expansion
                var xe = addVec(c, subVec(xr, c), gamma);
                var fe = f(xe);
                if (fe < fr) { simplex[n] = xe; values[n] = fe; }
                else         { simplex[n] = xr; values[n] = fr; }
            } else if (fr < secondWorstVal) {
                simplex[n] = xr; values[n] = fr;
            } else {
                // Contraction
                var xc;
                if (fr < worstVal) xc = addVec(c, subVec(xr, c), rho);
                else               xc = addVec(c, subVec(worst, c), -rho);

                var fc = f(xc);
                if (fc < worstVal) {
                    simplex[n] = xc; values[n] = fc;
                } else {
                    // Shrink
                    for (var j2 = 1; j2 < simplex.length; j2++) {
                        simplex[j2] = addVec(best, subVec(simplex[j2], best), sigma);
                        values[j2] = f(simplex[j2]);
                    }
                }
            }
        }

        sortSimplex();
        return { x: simplex[0], fx: values[0] };
    }

    // -----------------------------
    // AE SELECTION + SAMPLING
    // -----------------------------
    function getSelectedKeyIndicesSorted(prop) {
        var sk = prop.selectedKeys;
        if (!sk || sk.length < 2) return null;

        var idx = [];
        for (var i = 0; i < sk.length; i++) idx.push(sk[i]);
        idx.sort(function(a, b) { return prop.keyTime(a) - prop.keyTime(b); });
        return idx;
    }

    function getKeyIndicesInSpan(prop, t0, t1, eps) {
        // inclusive span [t0, t1]
        var idx = [];
        for (var k = 1; k <= prop.numKeys; k++) {
            var kt = prop.keyTime(k);
            if (kt >= t0 - eps && kt <= t1 + eps) idx.push(k);
        }
        idx.sort(function(a, b) { return prop.keyTime(a) - prop.keyTime(b); });
        return idx;
    }

    function extractSamplesFromKeyIndices(prop, keyIdx) {
        // Returns sample arrays + endpoints
        var times = [];
        var values = [];

        for (var i = 0; i < keyIdx.length; i++) {
            var k = keyIdx[i];
            times.push(prop.keyTime(k));
            values.push(prop.keyValue(k));
        }

        if (times.length < 2) return null;

        var t0 = times[0], tN = times[times.length - 1];
        var v0 = values[0], vN = values[values.length - 1];
        var dt = tN - t0;
        var dv = vN - v0;

        if (abs(dt) < 1e-12) return null;
        if (abs(dv) < 1e-12) return null;

        return { times: times, values: values, t0: t0, tN: tN, v0: v0, vN: vN, dt: dt, dv: dv, count: times.length };
    }

    function normalizeSamples(samples) {
        var tNorm = [];
        var sNorm = [];
        for (var i = 0; i < samples.count; i++) {
            var ti = (samples.times[i] - samples.t0) / samples.dt;
            var si = (samples.values[i] - samples.v0) / samples.dv;
            tNorm.push(ti);
            sNorm.push(si);
        }
        return { t: tNorm, s: sNorm };
    }

    function estimateEndpointSlopes(norm) {
        var t = norm.t, s = norm.s;
        var n = t.length;

        // simple finite differences at ends
        var m0 = (s[1] - s[0]) / Math.max(1e-6, (t[1] - t[0]));
        var m1 = (s[n - 1] - s[n - 2]) / Math.max(1e-6, (t[n - 1] - t[n - 2]));
        return { m0: m0, m1: m1 };
    }

    function collectTargets() {
        var comp = app.project.activeItem;
        if (!isComp(comp)) throw new Error("Make a Comp active.");

        var layers = comp.selectedLayers;
        if (!layers || layers.length === 0) throw new Error("Select at least one layer.");

        var targets = [];

        for (var li = 0; li < layers.length; li++) {
            var layer = layers[li];
            var selProps = layer.selectedProperties;
            if (!selProps || selProps.length === 0) continue;

            for (var pi = 0; pi < selProps.length; pi++) {
                var p = selProps[pi];

                if (p.propertyType !== PropertyType.PROPERTY) continue;
                if (!p.isTimeVarying) continue;
                if (p.propertyValueType !== PropertyValueType.OneD) continue;

                var selectedIdx = getSelectedKeyIndicesSorted(p);
                if (!selectedIdx) continue; // need at least 2 selected keys to define span

                targets.push({ layer: layer, prop: p, selectedIdx: selectedIdx });
            }
        }

        return targets;
    }

    // -----------------------------
    // FITTING
    // -----------------------------
    function fitCubicBezierToSamples(norm) {
        var t = norm.t, s = norm.s;
        var n = t.length;

        var slopes = estimateEndpointSlopes(norm);
        var eps = CFG.EPS;

        function penaltyX(x1, x2) {
            var p = 0.0;
            if (x1 < eps) p += sq(eps - x1) * 1e6;
            if (x1 > 1.0 - eps) p += sq(x1 - (1.0 - eps)) * 1e6;
            if (x2 < eps) p += sq(eps - x2) * 1e6;
            if (x2 > 1.0 - eps) p += sq(x2 - (1.0 - eps)) * 1e6;
            if (CFG.ENFORCE_X_ORDER && x1 > x2) p += sq(x1 - x2) * 1e4;
            return p;
        }

        function obj(vec) {
            var x1 = vec[0], y1 = vec[1], x2 = vec[2], y2 = vec[3];

            var p = penaltyX(x1, x2);

            if (CFG.CLAMP_Y_TO_0_1) {
                y1 = clamp(y1, 0.0, 1.0);
                y2 = clamp(y2, 0.0, 1.0);
            }

            // SSE on interior points
            var err = 0.0;
            for (var i = 1; i < n - 1; i++) {
                var shat = easeYforT(t[i], x1, y1, x2, y2);
                var r = shat - s[i];
                err += r * r;
            }
            return err + p;
        }

        function makeSeed(x1, x2) {
            // slope-based init
            var y1 = slopes.m0 * x1;
            var y2 = 1.0 - slopes.m1 * (1.0 - x2);
            if (CFG.CLAMP_Y_TO_0_1) {
                y1 = clamp(y1, 0.0, 1.0);
                y2 = clamp(y2, 0.0, 1.0);
            }
            return [x1, y1, x2, y2];
        }

        var seeds = [];
        if (CFG.RESTART_GRID) {
            var x1s = [0.15, 0.25, 0.35, 0.50, 0.75];
            var x2s = [0.50, 0.65, 0.80, 0.90];
            for (var i1 = 0; i1 < x1s.length; i1++) {
                for (var i2 = 0; i2 < x2s.length; i2++) {
                    seeds.push(makeSeed(x1s[i1], x2s[i2]));
                }
            }
        } else {
            seeds.push(makeSeed(0.30, 0.70));
        }

        var best = null;
        for (var si = 0; si < seeds.length; si++) {
            var x0 = seeds[si];
            var step = [0.08, 0.20, 0.08, 0.20];
            var res = nmMinimize(obj, x0, step, CFG.MAX_NM_ITERS);
            if (!best || res.fx < best.fx) best = res;
        }

        var bx1 = clamp(best.x[0], eps, 1.0 - eps);
        var by1 = best.x[1];
        var bx2 = clamp(best.x[2], eps, 1.0 - eps);
        var by2 = best.x[3];

        if (CFG.CLAMP_Y_TO_0_1) {
            by1 = clamp(by1, 0.0, 1.0);
            by2 = clamp(by2, 0.0, 1.0);
        }

        return { x1: bx1, y1: by1, x2: bx2, y2: by2, sse: best.fx };
    }

    function computeMaxAbsError(samples, norm, fit) {
        var t = norm.t;
        var vals = samples.values;
        var v0 = samples.v0;
        var dv = samples.dv;

        var maxErr = 0.0;
        var maxIdx = 0;

        for (var i = 0; i < t.length; i++) {
            var shat = easeYforT(t[i], fit.x1, fit.y1, fit.x2, fit.y2);
            var vhat = v0 + dv * shat;
            var e = abs(vhat - vals[i]);
            if (e > maxErr) { maxErr = e; maxIdx = i; }
        }
        return { maxErr: maxErr, maxIdx: maxIdx };
    }

    // -----------------------------
    // APPLY (COLLAPSE ALL KEYS IN SPAN + SET EASE ON FIRST/LAST)
    // -----------------------------
    function removeAllKeysBetweenTimes(prop, t0, t1, eps) {
        var toRemove = [];
        for (var k = 1; k <= prop.numKeys; k++) {
            var kt = prop.keyTime(k);
            if (kt > t0 + eps && kt < t1 - eps) {
                toRemove.push(k);
            }
        }
        toRemove.sort(function(a, b) { return b - a; });
        for (var i = 0; i < toRemove.length; i++) {
            prop.removeKey(toRemove[i]);
        }
    }

    function findKeyIndexByTime(prop, time, eps) {
        for (var k = 1; k <= prop.numKeys; k++) {
            if (abs(prop.keyTime(k) - time) < eps) return k;
        }
        return -1;
    }

    function applyFitToSpan(prop, spanT0, spanT1, spanV0, spanV1, fit) {
        var eps = 1e-6;

        if (CFG.COLLAPSE_ALL_IN_SPAN) {
            removeAllKeysBetweenTimes(prop, spanT0, spanT1, eps);
        }

        // After collapse, locate endpoints by time
        var kFirst = findKeyIndexByTime(prop, spanT0, eps);
        var kLast  = findKeyIndexByTime(prop, spanT1, eps);
        if (kFirst < 0 || kLast < 0) {
            throw new Error("Could not locate first/last key by time. (Did keys move or get deleted?)");
        }

        var dt = spanT1 - spanT0;
        var dv = spanV1 - spanV0;

        // Slopes in normalized coordinates
        var m0 = fit.y1 / Math.max(CFG.EPS, fit.x1);
        var m1 = (1.0 - fit.y2) / Math.max(CFG.EPS, (1.0 - fit.x2));

        // Convert to AE speed units (value/sec). Use magnitude.
        var outSpeed = abs(m0 * (dv / dt));
        var inSpeed  = abs(m1 * (dv / dt));

        // Influence mapping from time handle lengths
        var outInfluence = influenceClamp(fit.x1 * 100.0);
        var inInfluence  = influenceClamp((1.0 - fit.x2) * 100.0);

        // Preserve outside sides so we don't affect adjacent segments:
        // - keep first key's incoming ease (from previous segment)
        // - keep last key's outgoing ease (to next segment)
        var inEaseFirst  = prop.keyInTemporalEase(kFirst);
        var outEaseLast  = prop.keyOutTemporalEase(kLast);

        // Apply only the segment sides we care about:
        var outEaseNew = [ new KeyframeEase(outSpeed, outInfluence) ];
        var inEaseNew  = [ new KeyframeEase(inSpeed,  inInfluence)  ];

        prop.setTemporalEaseAtKey(kFirst, inEaseFirst, outEaseNew);
        prop.setTemporalEaseAtKey(kLast,  inEaseNew,   outEaseLast);

        // Ensure bezier interpolation on the segment sides
        var inTypeFirst  = prop.keyInInterpolationType(kFirst);
        var outTypeLast  = prop.keyOutInterpolationType(kLast);

        prop.setInterpolationTypeAtKey(kFirst, inTypeFirst, KeyframeInterpolationType.BEZIER);
        prop.setInterpolationTypeAtKey(kLast,  KeyframeInterpolationType.BEZIER, outTypeLast);

        return {
            outInfluence: outInfluence,
            inInfluence: inInfluence,
            outSpeed: outSpeed,
            inSpeed: inSpeed
        };
    }

    // -----------------------------
    // RUN FIT (WITH OPTIONAL APPLY)
    // -----------------------------
    function runFit(applyNow) {
        var comp = app.project.activeItem;
        if (!isComp(comp)) throw new Error("Make a Comp active.");

        var frameRate = comp.frameRate;
        var targets = collectTargets();

        if (!targets || targets.length === 0) {
            throw new Error("No valid targets found.\n\nSelect a 1D property and at least 2 keyframes on it.");
        }

        var reports = [];

        app.beginUndoGroup(applyNow ? "Fit + Apply Cubic Bezier" : "Fit Cubic Bezier (Report Only)");

        try {
            for (var ti = 0; ti < targets.length; ti++) {
                var prop = targets[ti].prop;
                var selectedIdx = targets[ti].selectedIdx;

                // Span defined by FIRST/LAST selected key
                var spanT0 = prop.keyTime(selectedIdx[0]);
                var spanT1 = prop.keyTime(selectedIdx[selectedIdx.length - 1]);
                var spanV0 = prop.keyValue(selectedIdx[0]);
                var spanV1 = prop.keyValue(selectedIdx[selectedIdx.length - 1]);

                // Decide sampling set:
                // - If >=3 selected keys: use selected keys as samples (as requested).
                // - If only 2 selected: attempt to use all keys in span as samples (baked workflow).
                var sampleIdx = null;
                var sampleMode = "";

                if (selectedIdx.length >= 3) {
                    sampleIdx = selectedIdx;
                    sampleMode = "selected keys";
                } else {
                    // only 2 selected keys; try using all keys in span
                    var spanIdx = getKeyIndicesInSpan(prop, spanT0, spanT1, 1e-6);
                    if (spanIdx && spanIdx.length >= 3) {
                        sampleIdx = spanIdx;
                        sampleMode = "all keys in span";
                    } else {
                        sampleIdx = null;
                        sampleMode = "insufficient samples";
                    }
                }

                if (!sampleIdx) {
                    reports.push({
                        propName: prop.name,
                        layerName: targets[ti].layer.name,
                        status: "SKIP (need ≥3 samples)",
                        cubic: "",
                        sampleMode: sampleMode
                    });
                    continue;
                }

                var samples = extractSamplesFromKeyIndices(prop, sampleIdx);
                if (!samples || samples.count < 3) {
                    reports.push({
                        propName: prop.name,
                        layerName: targets[ti].layer.name,
                        status: "SKIP (bad dt/dv or <3 samples)",
                        cubic: "",
                        sampleMode: sampleMode
                    });
                    continue;
                }

                // Normalize + fit
                var norm = normalizeSamples(samples);
                var fit = fitCubicBezierToSamples(norm);
                var err = computeMaxAbsError(samples, norm, fit);

                var cubicStr = "cubic-bezier(" +
                    fmt(fit.x1, 6) + ", " + fmt(fit.y1, 6) + ", " +
                    fmt(fit.x2, 6) + ", " + fmt(fit.y2, 6) + ")";

                var maxErrTime = samples.times[err.maxIdx];
                var maxErrFrame = Math.round(maxErrTime * frameRate);

                // Apply (always applies if applyNow==true)
                var applied = null;
                if (applyNow) {
                    applied = applyFitToSpan(prop, spanT0, spanT1, spanV0, spanV1, fit);
                }

                reports.push({
                    propName: prop.name,
                    layerName: targets[ti].layer.name,
                    status: "OK",
                    cubic: cubicStr,
                    x1: fit.x1, y1: fit.y1, x2: fit.x2, y2: fit.y2,
                    sse: fit.sse,
                    maxErr: err.maxErr,
                    maxErrFrame: maxErrFrame,
                    sampleCount: samples.count,
                    sampleMode: sampleMode,
                    applied: applied,
                    spanInfo: { t0: spanT0, t1: spanT1 }
                });

                safeWriteln(prop.name + " -> " + cubicStr + " | maxErr=" + fmt(err.maxErr, 6));
            }

        } finally {
            app.endUndoGroup();
        }

        return reports;
    }

    // -----------------------------
    // UI
    // -----------------------------
    function buildUI(thisObj) {
        var pal = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", "Fit Cubic Bezier (Baked Keys)", undefined, { resizeable: true });

        pal.orientation = "column";
        pal.alignChildren = ["fill", "top"];

        // ---- Options panel
        var grpOpts = pal.add("panel", undefined, "Options");
        grpOpts.orientation = "column";
        grpOpts.alignChildren = ["fill", "top"];

        var row1 = grpOpts.add("group");
        row1.orientation = "row";
        row1.alignChildren = ["left", "center"];

        var cbCollapse = row1.add("checkbox", undefined, "Remove ALL keys between first+last");
        cbCollapse.value = CFG.COLLAPSE_ALL_IN_SPAN;
        cbCollapse.helpTip = "When applying: deletes every key strictly inside the time span defined by the first and last selected key (keeps endpoints).";

        var row2 = grpOpts.add("group");
        row2.orientation = "row";
        row2.alignChildren = ["left", "center"];

        var cbClampY = row2.add("checkbox", undefined, "Clamp Y to [0..1]");
        cbClampY.value = CFG.CLAMP_Y_TO_0_1;
        cbClampY.helpTip = "Constrain y1 and y2 to [0..1] (no anticipation/overshoot). May increase fit error.";

        var cbXOrder = row2.add("checkbox", undefined, "Enforce x1 ≤ x2");
        cbXOrder.value = CFG.ENFORCE_X_ORDER;
        cbXOrder.helpTip = "Encourages conventional curves by penalizing solutions where x1 > x2.";

        var row3 = grpOpts.add("group");
        row3.orientation = "row";
        row3.alignChildren = ["left", "center"];

        var cbRestart = row3.add("checkbox", undefined, "Restart grid");
        cbRestart.value = CFG.RESTART_GRID;
        cbRestart.helpTip = "Tries multiple starting points and keeps the best fit (more robust, slightly slower).";

        row3.add("statictext", undefined, "Iterations:");
        var etIters = row3.add("edittext", undefined, String(CFG.MAX_NM_ITERS));
        etIters.characters = 6;
        etIters.helpTip = "Nelder–Mead iterations per restart. Higher = potentially better fit, slower.";

        var cbLog = row3.add("checkbox", undefined, "Console log");
        cbLog.value = CFG.LOG_TO_CONSOLE;
        cbLog.helpTip = "Prints brief per-property results to the JavaScript Console.";

        // ---- Actions panel
        var grpActions = pal.add("panel", undefined, "Actions");
        grpActions.orientation = "row";
        grpActions.alignChildren = ["fill", "center"];

        var btnFit = grpActions.add("button", undefined, "Fit (no apply)");
        btnFit.helpTip = "Fits cubic-bezier and reports results. Does not modify keyframes.";

        var btnFitApply = grpActions.add("button", undefined, "Fit + Apply");
        btnFitApply.helpTip = "Fits cubic-bezier then applies easing to the first+last selected key segment. Optionally deletes all interior keys in the span.";

        var btnClear = grpActions.add("button", undefined, "Clear");

        // ---- Results panel
        var grpRes = pal.add("panel", undefined, "Results");
        grpRes.orientation = "column";
        grpRes.alignChildren = ["fill", "fill"];

        var list = grpRes.add("listbox", undefined, [], { multiselect: false });
        list.preferredSize.height = 170;

        var detail = grpRes.add("edittext", undefined, "", { multiline: true, readonly: true, scrollable: true });
        detail.preferredSize.height = 150;

        var rowCopy = grpRes.add("group");
        rowCopy.orientation = "row";
        rowCopy.alignChildren = ["left", "center"];

        var btnCopy = rowCopy.add("button", undefined, "Copy cubic-bezier");
        var btnCopyAll = rowCopy.add("button", undefined, "Copy report");
        var lblStatus = rowCopy.add("statictext", undefined, "Ready");
        lblStatus.alignment = ["fill", "center"];

        // ---- State
        var lastReports = [];

        function syncCFGFromUI() {
            CFG.COLLAPSE_ALL_IN_SPAN = cbCollapse.value;
            CFG.CLAMP_Y_TO_0_1 = cbClampY.value;
            CFG.ENFORCE_X_ORDER = cbXOrder.value;
            CFG.RESTART_GRID = cbRestart.value;
            CFG.LOG_TO_CONSOLE = cbLog.value;

            var it = parseInt(etIters.text, 10);
            if (isNaN(it) || it < 40) it = 40;
            if (it > 2000) it = 2000;
            CFG.MAX_NM_ITERS = it;
            etIters.text = String(it);
        }

        function clearUI() {
            list.removeAll();
            detail.text = "";
            lblStatus.text = "Cleared";
            lastReports = [];
        }

        function showDetailForIndex(idx) {
            if (!lastReports || lastReports.length === 0) return;
            if (idx < 0 || idx >= lastReports.length) return;

            var r = lastReports[idx];
            var lines = [];
            lines.push("Layer: " + r.layerName);
            lines.push("Property: " + r.propName);
            lines.push("Status: " + r.status);

            if (r.sampleMode) {
                lines.push("Samples: " + r.sampleMode + (r.sampleCount ? (" (" + r.sampleCount + ")") : ""));
            }

            if (r.status === "OK") {
                lines.push("");
                lines.push("Fit:");
                lines.push("  " + r.cubic);
                lines.push("");
                lines.push("Numbers:");
                lines.push("  x1=" + fmt(r.x1, 6) + "  y1=" + fmt(r.y1, 6));
                lines.push("  x2=" + fmt(r.x2, 6) + "  y2=" + fmt(r.y2, 6));
                lines.push("");
                lines.push("Error:");
                lines.push("  SSE (norm): " + fmt(r.sse, 10));
                lines.push("  MaxAbsError (value units): " + fmt(r.maxErr, 6) + " @ ~frame " + r.maxErrFrame);

                if (r.applied) {
                    lines.push("");
                    lines.push("Applied AE temporal ease (segment only):");
                    lines.push("  OUT influence: " + fmt(r.applied.outInfluence, 3) + "%");
                    lines.push("  OUT speed:     " + fmt(r.applied.outSpeed, 6) + " units/s");
                    lines.push("  IN  influence: " + fmt(r.applied.inInfluence, 3) + "%");
                    lines.push("  IN  speed:     " + fmt(r.applied.inSpeed, 6) + " units/s");
                    lines.push("  Collapse:      " + (CFG.COLLAPSE_ALL_IN_SPAN ? "YES (all interior keys removed)" : "NO"));
                }
            } else {
                lines.push("");
                lines.push("Tip:");
                lines.push("  Select at least 3 baked keys, OR select only 2 keys and ensure there are 3+ total keys in the span.");
            }

            detail.text = lines.join("\n");
        }

        function pushReportsToUI(reports) {
            list.removeAll();
            lastReports = reports;

            for (var i = 0; i < reports.length; i++) {
                var r = reports[i];
                var label = "[" + r.status + "] " + r.layerName + " → " + r.propName;
                if (r.cubic) label += "   " + r.cubic;
                list.add("item", label);
            }

            if (reports.length > 0) {
                list.selection = 0;
                showDetailForIndex(0);
            }
        }

        function doRun(applyNow) {
            syncCFGFromUI();
            try {
                lblStatus.text = "Working...";
                pal.update();

                var reports = runFit(applyNow);
                pushReportsToUI(reports);

                var okCount = 0;
                for (var i = 0; i < reports.length; i++) if (reports[i].status === "OK") okCount++;

                lblStatus.text = applyNow ? ("Done. Applied to " + okCount + " property(s).")
                                         : ("Done. Fit " + okCount + " property(s).");
            } catch (e) {
                lblStatus.text = "Error.";
                alert("Error:\n\n" + e.toString());
            }
        }

        // ---- Events
        btnFit.onClick = function() { doRun(false); };
        btnFitApply.onClick = function() { doRun(true); };
        btnClear.onClick = function() { clearUI(); };

        list.onChange = function() {
            if (!list.selection) return;
            showDetailForIndex(list.selection.index);
        };

        btnCopy.onClick = function() {
            if (!list.selection || !lastReports || lastReports.length === 0) {
                alert("Select a result first.");
                return;
            }
            var r = lastReports[list.selection.index];
            if (!r.cubic) {
                alert("No cubic-bezier string on this row.");
                return;
            }
            var ok = tryCopyToClipboard(r.cubic);
            lblStatus.text = ok ? "Copied cubic-bezier." : "Copy failed (clipboard blocked).";
            if (!ok) alert("Copy failed.\n\nYou can manually copy from the details field.");
        };

        btnCopyAll.onClick = function() {
            if (!lastReports || lastReports.length === 0) {
                alert("No report yet.");
                return;
            }
            var lines = [];
            for (var i = 0; i < lastReports.length; i++) {
                var r = lastReports[i];
                if (r.status === "OK") {
                    lines.push(r.layerName + " :: " + r.propName +
                               " -> " + r.cubic +
                               " | maxErr=" + fmt(r.maxErr, 6) +
                               " | sse=" + fmt(r.sse, 10) +
                               " | samples=" + (r.sampleMode ? r.sampleMode : ""));
                } else {
                    lines.push(r.layerName + " :: " + r.propName + " -> " + r.status);
                }
            }
            var text = lines.join("\n");
            var ok = tryCopyToClipboard(text);
            lblStatus.text = ok ? "Copied report." : "Copy failed (clipboard blocked).";
            if (!ok) alert("Copy failed.\n\nYou can manually copy from the details field.");
        };

        // ---- Resize behavior
        pal.onResizing = pal.onResize = function() {
            try { this.layout.resize(); } catch (e) {}
        };

        return pal;
    }

    // -----------------------------
    // BOOT
    // -----------------------------
    var pal = buildUI(thisObj);
    if (pal instanceof Window) {
        pal.center();
        pal.show();
    } else {
        pal.layout.layout(true);
    }

})(this);