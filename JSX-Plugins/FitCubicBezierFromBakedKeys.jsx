/*  FitCubicBezierFromBakedKeys.jsx
    ---------------------------------
    Dockable ScriptUI panel that fits a single CSS-style cubic-bezier(x1,y1,x2,y2)
    to selected baked keyframes on selected 1D properties.

    - Reads selected keyframes (>= 3) on selected properties.
    - Converts to normalized time t in [0..1] and progress s in [0..1].
    - Fits a single cubic bezier easing by minimizing SSE over interior samples.
    - Inverts x(u)=t per sample via Newton + bisection fallback.
    - Optimizes with Nelder-Mead (derivative-free), optionally with a restart grid.
    - Optionally collapses keys to first+last selected and applies AE temporal ease.
	
    1) Reads selected keyframes on selected 1D properties (e.g. X Position, Slider, Opacity).
    2) Fits ONE CSS-style cubic-bezier(x1,y1,x2,y2) that best matches the baked samples:
         - Normalizes time to [0..1] and progress to [0..1]
         - For each sample time t: solves x(u)=t (Newton + bisection fallback), then uses y(u) as progress
         - Minimizes least-squares error over interior samples using Nelder-Mead (derivative-free)
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
        COLLAPSE_ALL_IN_SPAN: false,  // safer default: preserve interior keys unless explicitly requested
        CLAMP_Y_TO_0_1: true,         // AE-safe default: no negative endpoint speed / overshoot handles
        ENFORCE_X_ORDER: false,       // penalty if x1 > x2
        RESTART_GRID: true,           // multi-start
        MAX_NM_ITERS: 180,            // per start
        NM_VALUE_TOL: 1e-10,
        NM_SIMPLEX_TOL: 1e-5,
        MIN_SAMPLE_WARNING_COUNT: 5,
        EPS: 1e-8,
        LOG_TO_CONSOLE: true
    };

    // -----------------------------
    // UTILS
    // -----------------------------
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function abs(v) { return Math.abs(v); }
    function isComp(item) { return item && (item instanceof CompItem); }
    function fmt(n, d) { if (d === undefined) d = 6; return n.toFixed(d); }
    function influenceClamp(v) { return clamp(v, 0.1, 100.0); } // AE-ish safe range
    function isFiniteNumber(v) { return typeof v === "number" && isFinite(v); }

    function safeWriteln(msg) {
        if (!CFG.LOG_TO_CONSOLE) return;
        try { $.writeln(msg); } catch (e) {}
    }

    function tryCopyToClipboard(text) {
        // ExtendScript has no native clipboard. Use OS helpers through a temp
        // file so report/layer text never becomes shell command text.
        var f = null;
        try {
            f = new File(Folder.temp.fsName + "/FitCubicBezierClipboard_" + (new Date()).getTime() + ".txt");
            f.encoding = "UTF-8";
            if (!f.open("w")) return false;
            f.write(text);
            f.close();

            if ($.os.toLowerCase().indexOf("mac") !== -1) {
                var p = f.fsName.replace(/'/g, "'\"'\"'");
                var macRes = system.callSystem("/bin/sh -c \"pbcopy < '" + p + "' && echo __FIT_CUBIC_COPY_OK__\"");
                return macRes && macRes.indexOf("__FIT_CUBIC_COPY_OK__") !== -1;
            } else {
                var w = f.fsName.replace(/"/g, "");
                var winRes = system.callSystem('cmd.exe /c type "' + w + '" | clip && echo __FIT_CUBIC_COPY_OK__');
                return winRes && winRes.indexOf("__FIT_CUBIC_COPY_OK__") !== -1;
            }
        } catch (e) {
            return false;
        } finally {
            try { if (f && f.exists) f.remove(); } catch (ignore) {}
        }
    }

    // -----------------------------
    // OPTIMIZED CUBIC BEZIER MATH
    // -----------------------------
    function solveUForTWithCoeffs(t, ax, bx, cx) {
        if (t <= 0.0) return 0.0;
        if (t >= 1.0) return 1.0;
        var u = t; 
        var i, u2, u3, f, df, d2f, num, den, uNext, fmid, lo, hi, mid;

        for (i = 0; i < 8; i++) {
            u2 = u * u;
            u3 = u2 * u;
            
            f = ax * u3 + bx * u2 + cx * u - t;
            if (Math.abs(f) < 1e-7) return u;

            df = 3.0 * ax * u2 + 2.0 * bx * u + cx;
            if (Math.abs(df) < 1e-9) break;

            d2f = 6.0 * ax * u + 2.0 * bx;
            
            num = 2.0 * f * df;
            den = 2.0 * df * df - f * d2f;
            
            if (Math.abs(den) < 1e-12) break;
            
            uNext = u - num / den;
            if (uNext < 0.0 || uNext > 1.0) {
                uNext = u - f / df;
                if (uNext < 0.0 || uNext > 1.0) break;
            }
            u = uNext;
        }

        lo = 0.0;
        hi = 1.0;
        for (i = 0; i < 24; i++) {
            mid = (lo + hi) * 0.5;
            fmid = ax * (mid * mid * mid) + bx * (mid * mid) + cx * mid;
            if (fmid < t) lo = mid;
            else hi = mid;
        }
        return (lo + hi) * 0.5;
    }

    function invertUForT(t, x1, x2) {
        var cx = 3.0 * x1;
        var bx = 3.0 * (x2 - x1) - cx;
        var ax = 1.0 - cx - bx;
        return solveUForTWithCoeffs(t, ax, bx, cx);
    }

    function easeYforT(t, x1, y1, x2, y2) {
        var u = invertUForT(t, x1, x2);
        var cy = 3.0 * y1;
        var by = 3.0 * (y2 - y1) - cy;
        var ay = 1.0 - cy - by;
        return ay * (u * u * u) + by * (u * u) + cy * u;
    }

    // -----------------------------
    // NELDER-MEAD (derivative-free)
    // -----------------------------
    function nmMinimize(f, x0, step, maxIter, opts) {
        opts = opts || {};
        var n = x0.length;
        var i, j;
        var simplex = new Array(n + 1);
        for (i = 0; i <= n; i++) simplex[i] = new Array(n);
        
        var values = new Array(n + 1);
        var xr = new Array(n);
        var xe = new Array(n);
        var xc = new Array(n);
        var c  = new Array(n);

        function safeEval(x) {
            var v = f(x);
            return isFiniteNumber(v) ? v : 1e100;
        }
        
        for (i = 0; i < n; i++) simplex[0][i] = x0[i];
        values[0] = safeEval(simplex[0]);
        
        for (i = 1; i <= n; i++) {
            for (j = 0; j < n; j++) simplex[i][j] = x0[j];
            simplex[i][i - 1] += step[i - 1];
            values[i] = safeEval(simplex[i]);
        }
        
        var idx = new Array(n + 1);
        for (i = 0; i <= n; i++) idx[i] = i;
        
        function sortIndices() {
            var k, key, keyVal, m;
            for (k = 1; k <= n; k++) {
                key = idx[k];
                keyVal = values[key];
                m = k - 1;
                while (m >= 0 && values[idx[m]] > keyVal) {
                    idx[m + 1] = idx[m];
                    m--;
                }
                idx[m + 1] = key;
            }
        }
        
        function doShrink() {
            var bIdx = idx[0];
            var sIdx, k, m;
            for (k = 1; k <= n; k++) {
                sIdx = idx[k];
                for (m = 0; m < n; m++) {
                    simplex[sIdx][m] = simplex[bIdx][m] + sigma * (simplex[sIdx][m] - simplex[bIdx][m]);
                }
                values[sIdx] = safeEval(simplex[sIdx]);
            }
        }

        var alpha = 1.0, gamma = 2.0, rho = 0.5, sigma = 0.5;
        var iter, worstIdx, secondWorstIdx, bestVal, worstVal, secondWorstVal;
        var invN = 1.0 / n;
        var sIdx, fr, fe, fc, valueSpread, maxSimplexDelta, d;
        var valueTol = opts.valueTol !== undefined ? opts.valueTol : 0.0;
        var simplexTol = opts.simplexTol !== undefined ? opts.simplexTol : 0.0;
        var converged = false;

        for (iter = 0; iter < maxIter; iter++) {
            sortIndices();
            worstIdx = idx[n];
            secondWorstIdx = idx[n - 1];
            bestVal = values[idx[0]];
            worstVal = values[worstIdx];
            secondWorstVal = values[secondWorstIdx];

            if (valueTol > 0.0 || simplexTol > 0.0) {
                valueSpread = Math.abs(worstVal - bestVal);
                maxSimplexDelta = 0.0;
                for (j = 1; j <= n; j++) {
                    sIdx = idx[j];
                    for (i = 0; i < n; i++) {
                        d = Math.abs(simplex[sIdx][i] - simplex[idx[0]][i]);
                        if (d > maxSimplexDelta) maxSimplexDelta = d;
                    }
                }
                if ((valueTol <= 0.0 || valueSpread <= valueTol) &&
                    (simplexTol <= 0.0 || maxSimplexDelta <= simplexTol)) {
                    converged = true;
                    break;
                }
            }

            for (i = 0; i < n; i++) c[i] = 0.0;
            for (j = 0; j < n; j++) {
                sIdx = idx[j];
                for (i = 0; i < n; i++) c[i] += simplex[sIdx][i];
            }
            for (i = 0; i < n; i++) c[i] *= invN;

            for (i = 0; i < n; i++) xr[i] = c[i] + alpha * (c[i] - simplex[worstIdx][i]);
            fr = safeEval(xr);

            if (fr < bestVal) {
                for (i = 0; i < n; i++) xe[i] = c[i] + gamma * (xr[i] - c[i]);
                fe = safeEval(xe);
                if (fe < fr) { 
                    for (i = 0; i < n; i++) simplex[worstIdx][i] = xe[i];
                    values[worstIdx] = fe; 
                } else { 
                    for (i = 0; i < n; i++) simplex[worstIdx][i] = xr[i];
                    values[worstIdx] = fr; 
                }
            } else if (fr < secondWorstVal) {
                for (i = 0; i < n; i++) simplex[worstIdx][i] = xr[i];
                values[worstIdx] = fr;
            } else {
                if (fr < worstVal) {
                    for (i = 0; i < n; i++) xc[i] = c[i] + rho * (xr[i] - c[i]);
                    fc = safeEval(xc);
                    if (fc <= fr) {
                        for (i = 0; i < n; i++) simplex[worstIdx][i] = xc[i];
                        values[worstIdx] = fc;
                    } else {
                        doShrink();
                    }
                } else {
                    for (i = 0; i < n; i++) xc[i] = c[i] + rho * (simplex[worstIdx][i] - c[i]);
                    fc = safeEval(xc);
                    if (fc < worstVal) {
                        for (i = 0; i < n; i++) simplex[worstIdx][i] = xc[i];
                        values[worstIdx] = fc;
                    } else {
                        doShrink();
                    }
                }
            }
        }
        sortIndices();
        var bestRet = new Array(n);
        for (i = 0; i < n; i++) bestRet[i] = simplex[idx[0]][i];
        return { x: bestRet, fx: values[idx[0]], iterations: iter, converged: converged };
    }

    // -----------------------------
    // OPTIMIZED SELECTION + SAMPLING
    // -----------------------------
    function getSelectedKeyIndicesSorted(prop) {
        var sk = prop.selectedKeys;
        if (!sk || sk.length < 2) return null;
        var idx = [];
        for (var i = 0; i < sk.length; i++) idx.push(sk[i]);
        return idx.sort(function(a, b) { return a - b; });
    }

    function getKeyIndicesInSpan(prop, t0, t1, eps) {
        var startIdx = -1, endIdx = -1;
        var low = 1, high = prop.numKeys;
        while (low <= high) {
            var mid = Math.floor((low + high) / 2);
            if (prop.keyTime(mid) >= t0 - eps) {
                startIdx = mid;
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }
        if (startIdx === -1) return null;
        low = startIdx; high = prop.numKeys;
        while (low <= high) {
            var mid = Math.floor((low + high) / 2);
            if (prop.keyTime(mid) <= t1 + eps) {
                endIdx = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        if (endIdx === -1 || endIdx < startIdx) return null;
        var idx = new Array(endIdx - startIdx + 1);
        for (var i = 0; i < idx.length; i++) {
            idx[i] = startIdx + i;
        }
        return idx;
    }

    function collectTargets() {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) throw new Error("Please make a Composition active.");
        var layers = comp.selectedLayers;
        var numLayers = layers ? layers.length : 0;
        if (numLayers === 0) throw new Error("Please select at least one layer.");
        var targets = [];
        var propType = PropertyType.PROPERTY;
        var oneD = PropertyValueType.OneD;
        for (var li = 0; li < numLayers; li++) {
            var layer = layers[li];
            var selProps = layer.selectedProperties;
            var numProps = selProps ? selProps.length : 0;
            if (numProps === 0) continue;
            for (var pi = 0; pi < numProps; pi++) {
                var p = selProps[pi];
                if (p.propertyType !== propType || !p.isTimeVarying || p.propertyValueType !== oneD) continue;
                var selectedIdx = getSelectedKeyIndicesSorted(p);
                if (!selectedIdx) continue;
                targets.push({ layer: layer, prop: p, selectedIdx: selectedIdx });
            }
        }
        return targets;
    }

    function extractSamplesFromKeyIndices(prop, keyIdx) {
        var count = keyIdx.length;
        if (count < 2) return null;
        var times = new Array(count);
        var values = new Array(count);
        var minV = null, maxV = null;
        for (var i = 0; i < count; i++) {
            var k = keyIdx[i];
            times[i] = prop.keyTime(k);
            values[i] = prop.keyValue(k);
            if (minV === null || values[i] < minV) minV = values[i];
            if (maxV === null || values[i] > maxV) maxV = values[i];
        }
        var t0 = times[0], tN = times[count - 1];
        var v0 = values[0], vN = values[count - 1];
        var dt = tN - t0;
        var dv = vN - v0;
        var valueRange = maxV - minV;
        if (Math.abs(dt) < 1e-12) return null;
        if (Math.abs(dv) < Math.max(1e-12, Math.abs(valueRange) * 1e-8)) return null;
        return {
            times: times, values: values,
            t0: t0, tN: tN, v0: v0, vN: vN,
            dt: dt, dv: dv, count: count, valueRange: valueRange
        };
    }

    function normalizeSamples(samples) {
        var count = samples.count;
        var tNorm = new Array(count);
        var sNorm = new Array(count);
        var t0 = samples.t0, dv = samples.dv, dt = samples.dt, v0 = samples.v0;
        for (var i = 0; i < count; i++) {
            tNorm[i] = (samples.times[i] - t0) / dt;
            sNorm[i] = (samples.values[i] - v0) / dv;
        }
        return { t: tNorm, s: sNorm };
    }

    function estimateEndpointSlopes(norm) {
        var t = norm.t, s = norm.s;
        var n = t.length;
        var m0 = (s[1] - s[0]) / Math.max(1e-6, (t[1] - t[0]));
        var m1 = (s[n - 1] - s[n - 2]) / Math.max(1e-6, (t[n - 1] - t[n - 2]));
        return { m0: m0, m1: m1 };
    }

    function buildInteriorWeights(norm) {
        var t = norm.t;
        var n = t.length;
        var w = new Array(n);
        var i, sum = 0.0, wi;
        for (i = 0; i < n; i++) w[i] = 0.0;
        for (i = 1; i < n - 1; i++) {
            wi = Math.max(1e-6, (t[i + 1] - t[i - 1]) * 0.5);
            w[i] = wi;
            sum += wi;
        }
        if (sum > 0.0) {
            var scale = (n - 2) / sum;
            for (i = 1; i < n - 1; i++) w[i] *= scale;
        }
        return w;
    }

    function computeFitMetrics(samples, norm, fit) {
        var t = norm.t, s = norm.s;
        var weights = buildInteriorWeights(norm);
        var vals = samples.values;
        var v0 = samples.v0;
        var dv = samples.dv;
        var maxErr = 0.0;
        var maxNormErr = 0.0;
        var maxIdx = 0;
        var sseNorm = 0.0;
        var weightedInteriorMSE = 0.0;
        for (var i = 0; i < t.length; i++) {
            var shat = easeYforT(t[i], fit.x1, fit.y1, fit.x2, fit.y2);
            var rNorm = shat - s[i];
            var vhat = v0 + dv * shat;
            var e = abs(vhat - vals[i]);
            var en = abs(rNorm);
            sseNorm += rNorm * rNorm;
            if (i > 0 && i < t.length - 1) weightedInteriorMSE += weights[i] * rNorm * rNorm;
            if (e > maxErr) {
                maxErr = e;
                maxNormErr = en;
                maxIdx = i;
            }
        }
        var rmseNorm = Math.sqrt(sseNorm / Math.max(1, t.length));
        weightedInteriorMSE /= Math.max(1, t.length - 2);
        var weightedInteriorRMSE = Math.sqrt(weightedInteriorMSE);
        var maxErrPct = abs(dv) > 1e-12 ? (maxErr / abs(dv)) * 100.0 : 0.0;
        var quality = "GOOD";
        if (maxNormErr > 0.05 || weightedInteriorRMSE > 0.025) quality = "POOR";
        else if (maxNormErr > 0.015 || weightedInteriorRMSE > 0.0075) quality = "CAUTION";
        return {
            sseNorm: sseNorm,
            rmseNorm: rmseNorm,
            weightedInteriorMSE: weightedInteriorMSE,
            weightedInteriorRMSE: weightedInteriorRMSE,
            maxErr: maxErr,
            maxNormErr: maxNormErr,
            maxErrPct: maxErrPct,
            maxIdx: maxIdx,
            quality: quality
        };
    }

    // -----------------------------
    // FITTING
    // -----------------------------
    function fitCubicBezierToSamples(norm) {
        var t = norm.t, s = norm.s;
        var n = t.length;
        var slopes = estimateEndpointSlopes(norm);
        var weights = buildInteriorWeights(norm);
        var eps = CFG.EPS;
        var enforceX = CFG.ENFORCE_X_ORDER;
        var clampY = CFG.CLAMP_Y_TO_0_1;
        var ridge = 1e-10;

        function projectX(v) {
            if (!isFiniteNumber(v)) return 0.5;
            return clamp(v, eps, 1.0 - eps);
        }

        function scoreY(aArr, bArr, baseArr, y1, y2) {
            var err = 0.0;
            for (var k = 0; k < aArr.length; k++) {
                var r = baseArr[k] + aArr[k] * y1 + bArr[k] * y2 - s[k + 1];
                err += weights[k + 1] * r * r;
            }
            return err / Math.max(1, aArr.length);
        }

        function evalFixedX(x1, x2) {
            x1 = projectX(x1);
            x2 = projectX(x2);
            var cx = 3.0 * x1;
            var bx = 3.0 * (x2 - x1) - cx;
            var ax = 1.0 - cx - bx;
            var aArr = new Array(n - 2);
            var bArr = new Array(n - 2);
            var baseArr = new Array(n - 2);
            var A = ridge, B = 0.0, C = ridge, D = 0.0, E = 0.0;
            var i, k, u, omu, uu, a, b, base, target, w;

            for (i = 1; i < n - 1; i++) {
                k = i - 1;
                u = solveUForTWithCoeffs(t[i], ax, bx, cx);
                omu = 1.0 - u;
                uu = u * u;
                a = 3.0 * omu * omu * u;
                b = 3.0 * omu * uu;
                base = uu * u;
                target = s[i] - base;
                w = weights[i];
                aArr[k] = a;
                bArr[k] = b;
                baseArr[k] = base;
                A += w * a * a;
                B += w * a * b;
                C += w * b * b;
                D += w * a * target;
                E += w * b * target;
            }

            var det = A * C - B * B;
            var y1, y2;
            if (Math.abs(det) < 1e-14) {
                y1 = slopes.m0 * x1;
                y2 = 1.0 - slopes.m1 * (1.0 - x2);
            } else {
                y1 = (D * C - B * E) / det;
                y2 = (A * E - B * D) / det;
            }

            var bestY1 = y1;
            var bestY2 = y2;
            var bestScore;

            function consider(cy1, cy2) {
                if (clampY) {
                    cy1 = clamp(cy1, 0.0, 1.0);
                    cy2 = clamp(cy2, 0.0, 1.0);
                }
                var sc = scoreY(aArr, bArr, baseArr, cy1, cy2);
                if (!isFiniteNumber(bestScore) || sc < bestScore) {
                    bestScore = sc;
                    bestY1 = cy1;
                    bestY2 = cy2;
                }
            }

            consider(y1, y2);
            if (clampY) {
                var fixed, num, den;
                consider(clamp(y1, 0.0, 1.0), clamp(y2, 0.0, 1.0));
                for (fixed = 0; fixed <= 1; fixed++) {
                    num = 0.0; den = ridge;
                    for (k = 0; k < aArr.length; k++) {
                        w = weights[k + 1];
                        num += w * bArr[k] * (s[k + 1] - baseArr[k] - aArr[k] * fixed);
                        den += w * bArr[k] * bArr[k];
                    }
                    consider(fixed, num / den);

                    num = 0.0; den = ridge;
                    for (k = 0; k < aArr.length; k++) {
                        w = weights[k + 1];
                        num += w * aArr[k] * (s[k + 1] - baseArr[k] - bArr[k] * fixed);
                        den += w * aArr[k] * aArr[k];
                    }
                    consider(num / den, fixed);
                }
                consider(0.0, 0.0);
                consider(0.0, 1.0);
                consider(1.0, 0.0);
                consider(1.0, 1.0);
            }

            return { x1: x1, y1: bestY1, x2: x2, y2: bestY2, sse: bestScore };
        }

        function objective(vec) {
            var rawX1 = vec[0], rawX2 = vec[1];
            var x1 = projectX(rawX1);
            var x2 = projectX(rawX2);
            var ev = evalFixedX(x1, x2);
            var p = 0.0;
            var d1 = rawX1 - x1;
            var d2 = rawX2 - x2;
            p += (d1 * d1 + d2 * d2) * 1000.0;
            if (enforceX && x1 > x2) p += 1000000.0 + (x1 - x2) * (x1 - x2) * 1000000.0;
            return ev.sse + p;
        }

        var seeds = [];
        if (CFG.RESTART_GRID) {
            var x1s = [0.10, 0.20, 0.33, 0.50, 0.70];
            var x2s = [0.30, 0.50, 0.67, 0.80, 0.90];
            for (var i1 = 0; i1 < x1s.length; i1++) {
                for (var i2 = 0; i2 < x2s.length; i2++) {
                    seeds.push([x1s[i1], x2s[i2]]);
                }
            }
        } else {
            seeds.push([0.30, 0.70]);
        }

        var best = null;
        var totalIterations = 0;
        var bestConverged = false;
        for (var si = 0; si < seeds.length; si++) {
            var res = nmMinimize(objective, seeds[si], [0.10, 0.10], CFG.MAX_NM_ITERS, {
                valueTol: CFG.NM_VALUE_TOL,
                simplexTol: CFG.NM_SIMPLEX_TOL
            });
            var ev = evalFixedX(projectX(res.x[0]), projectX(res.x[1]));
            var selectionFx = objective([ev.x1, ev.x2]);
            totalIterations += res.iterations;
            if (!best || selectionFx < best.selectionFx) {
                best = ev;
                best.objectiveFx = res.fx;
                best.selectionFx = selectionFx;
                bestConverged = res.converged;
            }
            if (best && best.sse <= 1e-14) break;
        }

        var warnings = [];
        if (n < CFG.MIN_SAMPLE_WARNING_COUNT) {
            warnings.push("Low sample count: " + n + " keys. Many cubic curves can fit so little data.");
        }
        if (!clampY && (best.y1 < 0.0 || best.y2 > 1.0 || best.y1 > 1.0 || best.y2 < 0.0)) {
            warnings.push("Y handles leave [0..1]; CSS export is OK, but AE temporal ease may not apply faithfully.");
        }
        if (best.x1 * 100.0 < 0.1 || (1.0 - best.x2) * 100.0 < 0.1) {
            warnings.push("One influence is below AE's 0.1% minimum and will be clamped on apply.");
        }
        if (!bestConverged && best.sse > 1e-14) {
            warnings.push("Optimizer used the full iteration budget; consider Thorough iterations or Restart grid.");
        }

        return {
            x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2,
            sse: best.sse,
            objectiveFx: best.objectiveFx,
            optimizerIterations: totalIterations,
            optimizerConverged: bestConverged || best.sse <= 1e-14,
            fitMode: "2D timing optimize + least-squares Y",
            warnings: warnings
        };
    }

    // -----------------------------
    // OPTIMIZED APPLY / MANIPULATION
    // -----------------------------
    function findKeyIndexByTime(prop, time, eps) {
        var low = 1, high = prop.numKeys;
        while (low <= high) {
            var mid = Math.floor((low + high) / 2);
            var kt = prop.keyTime(mid);
            if (Math.abs(kt - time) <= eps) return mid;
            if (kt < time) low = mid + 1;
            else high = mid - 1;
        }
        return -1;
    }

    function getInteriorKeyInfos(prop, t0, t1, eps) {
        var infos = [];
        if (prop.numKeys < 3) return infos;
        var startIdx = -1, endIdx = -1;
        var low = 1, high = prop.numKeys;
        while (low <= high) {
            var mid = Math.floor((low + high) / 2);
            if (prop.keyTime(mid) > t0 + eps) {
                startIdx = mid;
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }
        if (startIdx === -1) return infos;
        low = startIdx; high = prop.numKeys;
        while (low <= high) {
            var mid = Math.floor((low + high) / 2);
            if (prop.keyTime(mid) < t1 - eps) {
                endIdx = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        if (endIdx === -1 || endIdx < startIdx) return infos;
        for (var k = startIdx; k <= endIdx; k++) {
            infos.push({ index: k, time: prop.keyTime(k), value: prop.keyValue(k) });
        }
        return infos;
    }

    function removeAllKeysBetweenTimes(prop, t0, t1, eps) {
        var removed = getInteriorKeyInfos(prop, t0, t1, eps);
        if (!removed || removed.length === 0) return [];
        for (var k = removed.length - 1; k >= 0; k--) {
            prop.removeKey(removed[k].index);
        }
        return removed;
    }

    function isBezierTemporalInterpolationValid(prop) {
        try {
            if (prop.isInterpolationTypeValid &&
                !prop.isInterpolationTypeValid(KeyframeInterpolationType.BEZIER)) {
                return false;
            }
        } catch (e) {}
        return true;
    }

    function clearTemporalAutoState(prop, keyIndex) {
        try {
            if (prop.setTemporalAutoBezierAtKey) prop.setTemporalAutoBezierAtKey(keyIndex, false);
        } catch (e1) {}
        try {
            if (prop.setTemporalContinuousAtKey) prop.setTemporalContinuousAtKey(keyIndex, false);
        } catch (e2) {}
    }

    function applyFitToSpan(prop, spanT0, spanT1, spanV0, spanV1, fit) {
        var eps = 1e-6;
        var interiorBefore = getInteriorKeyInfos(prop, spanT0, spanT1, eps);
        var removedKeys = [];

        var kFirstBefore = findKeyIndexByTime(prop, spanT0, eps);
        var kLastBefore  = findKeyIndexByTime(prop, spanT1, eps);
        if (kFirstBefore === -1 || kLastBefore === -1) {
            throw new Error("Could not locate first/last key by time before applying.");
        }
        if (!isBezierTemporalInterpolationValid(prop)) {
            throw new Error("This property does not accept Bezier temporal interpolation.");
        }

        var inEaseFirst  = prop.keyInTemporalEase(kFirstBefore);
        var outEaseLast  = prop.keyOutTemporalEase(kLastBefore);
        var inTypeFirst  = prop.keyInInterpolationType(kFirstBefore);
        var outTypeLast  = prop.keyOutInterpolationType(kLastBefore);
        var inTypeLast   = prop.keyInInterpolationType(kLastBefore);
        var outTypeFirst = prop.keyOutInterpolationType(kFirstBefore);

        if (CFG.COLLAPSE_ALL_IN_SPAN) {
            removedKeys = removeAllKeysBetweenTimes(prop, spanT0, spanT1, eps);
        }
        var kFirst = findKeyIndexByTime(prop, spanT0, eps);
        var kLast  = findKeyIndexByTime(prop, spanT1, eps);
        if (kFirst === -1 || kLast === -1) {
            throw new Error("Could not locate first/last key by time. (Did keys move or get deleted?)");
        }
        var dt = spanT1 - spanT0;
        var dv = spanV1 - spanV0;
        var fittedM0 = fit.y1 / Math.max(CFG.EPS, fit.x1);
        var fittedM1 = (1.0 - fit.y2) / Math.max(CFG.EPS, (1.0 - fit.x2));
        var outInfluence = influenceClamp(fit.x1 * 100.0);
        var inInfluence  = influenceClamp((1.0 - fit.x2) * 100.0);
        var appliedM0 = fit.y1 / Math.max(CFG.EPS, outInfluence / 100.0);
        var appliedM1 = (1.0 - fit.y2) / Math.max(CFG.EPS, inInfluence / 100.0);
        // AE KeyframeEase uses speed magnitude; endpoint values carry direction.
        var speedScale = Math.abs(dv / dt);
        var outSpeed = Math.abs(appliedM0 * speedScale);
        var inSpeed  = Math.abs(appliedM1 * speedScale);
        var outEaseNew = [ new KeyframeEase(outSpeed, outInfluence) ];
        var inEaseNew  = [ new KeyframeEase(inSpeed,  inInfluence)  ];
        var bez = KeyframeInterpolationType.BEZIER;
        prop.setInterpolationTypeAtKey(kFirst, inTypeFirst, bez);
        prop.setInterpolationTypeAtKey(kLast,  bez, outTypeLast);
        clearTemporalAutoState(prop, kFirst);
        clearTemporalAutoState(prop, kLast);
        prop.setTemporalEaseAtKey(kFirst, inEaseFirst, outEaseNew);
        prop.setTemporalEaseAtKey(kLast,  inEaseNew,   outEaseLast);

        var warnings = [];
        if (fittedM0 < 0.0 || fittedM1 < 0.0) {
            warnings.push("Negative endpoint slope was converted to positive AE speed; applied curve may differ from CSS fit.");
        }
        if (fit.x1 * 100.0 !== outInfluence || (1.0 - fit.x2) * 100.0 !== inInfluence) {
            warnings.push("AE influence clamp changed at least one fitted handle.");
        }
        if (!CFG.COLLAPSE_ALL_IN_SPAN && interiorBefore.length > 0) {
            warnings.push("Interior keys were preserved, so AE cannot form one continuous first-to-last segment.");
        }

        return {
            outInfluence: outInfluence,
            inInfluence: inInfluence,
            outSpeed: outSpeed,
            inSpeed: inSpeed,
            removedKeys: removedKeys,
            removedCount: removedKeys.length,
            preservedInteriorCount: CFG.COLLAPSE_ALL_IN_SPAN ? 0 : interiorBefore.length,
            firstKeyIndex: kFirst,
            lastKeyIndex: kLast,
            oldFirstOutType: outTypeFirst,
            oldLastInType: inTypeLast,
            newFirstOutType: bez,
            newLastInType: bez,
            warnings: warnings
        };
    }

    // -----------------------------
    // RUN FIT & UI
    // -----------------------------
    function formatCompTime(comp, time) {
        try {
            return timeToCurrentFormat(time, 1.0 / comp.frameDuration, false);
        } catch (e) {
            return fmt(time, 3) + "s";
        }
    }

    function compFrameNumber(comp, time) {
        try {
            return Math.round((time - comp.displayStartTime) / comp.frameDuration);
        } catch (e) {
            return Math.round(time * comp.frameRate);
        }
    }

    function runFit(applyNow, onProgress) {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) throw new Error("Please make a Composition active.");
        var targets = collectTargets();
        var numTargets = targets.length;
        if (numTargets === 0) {
            throw new Error("No valid targets found.\n\nSelect a 1D property and at least 2 keyframes on it.\n\nFor Position, use Separate Dimensions and select X/Y/Z Position.");
        }
        var reports = new Array(numTargets);
        var undoName = applyNow ? "Fit + Apply Cubic Bezier" : "Fit Cubic Bezier (Report Only)";
        if (applyNow) app.beginUndoGroup(undoName);
        try {
            for (var ti = 0; ti < numTargets; ti++) {
                var prop = targets[ti].prop;
                var layerName = targets[ti].layer.name;
                if (onProgress) onProgress(ti, numTargets, layerName, prop.name);
                try {
                var selectedIdx = targets[ti].selectedIdx;
                var numSelected = selectedIdx.length;
                var firstKeyIdx = selectedIdx[0];
                var lastKeyIdx = selectedIdx[numSelected - 1];
                var spanT0 = prop.keyTime(firstKeyIdx);
                var spanT1 = prop.keyTime(lastKeyIdx);
                var spanV0 = prop.keyValue(firstKeyIdx);
                var spanV1 = prop.keyValue(lastKeyIdx);
                var sampleIdx = null;
                var sampleMode = "";
                if (numSelected >= 3) {
                    sampleIdx = selectedIdx;
                    sampleMode = "selected keys";
                } else {
                    var spanIdx = getKeyIndicesInSpan(prop, spanT0, spanT1, 1e-6);
                    if (spanIdx && spanIdx.length >= 3) {
                        sampleIdx = spanIdx;
                        sampleMode = "all keys in span";
                    } else {
                        sampleMode = "insufficient samples";
                    }
                }
                if (!sampleIdx) {
                    reports[ti] = { propName: prop.name, layerName: layerName, status: "SKIP (need >=3 samples)", cubic: "", sampleMode: sampleMode };
                    continue;
                }
                var samples = extractSamplesFromKeyIndices(prop, sampleIdx);
                if (!samples || samples.count < 3) {
                    reports[ti] = { propName: prop.name, layerName: layerName, status: "SKIP (bad dt/dv or <3 samples)", cubic: "", sampleMode: sampleMode };
                    continue;
                }
                var norm = normalizeSamples(samples);
                var fit = fitCubicBezierToSamples(norm);
                var metrics = computeFitMetrics(samples, norm, fit);
                var cubicStr = "cubic-bezier(" + fmt(fit.x1, 6) + ", " + fmt(fit.y1, 6) + ", " + fmt(fit.x2, 6) + ", " + fmt(fit.y2, 6) + ")";
                var worstTime = samples.times[metrics.maxIdx];
                var maxErrFrame = compFrameNumber(comp, worstTime);
                var maxErrTimeText = formatCompTime(comp, worstTime);
                var applied = applyNow ? applyFitToSpan(prop, spanT0, spanT1, spanV0, spanV1, fit) : null;
                var warnings = [];
                if (fit.warnings) {
                    for (var wi = 0; wi < fit.warnings.length; wi++) warnings.push(fit.warnings[wi]);
                }
                if (applied && applied.warnings) {
                    for (var awi = 0; awi < applied.warnings.length; awi++) warnings.push(applied.warnings[awi]);
                }
                reports[ti] = {
                    propName: prop.name, layerName: layerName, status: "OK",
                    cubic: cubicStr, x1: fit.x1, y1: fit.y1, x2: fit.x2, y2: fit.y2,
                    weightedMSE: fit.sse, objectiveFx: fit.objectiveFx,
                    rmseNorm: metrics.rmseNorm,
                    weightedInteriorRMSE: metrics.weightedInteriorRMSE,
                    maxNormErr: metrics.maxNormErr,
                    maxErr: metrics.maxErr, maxErrPct: metrics.maxErrPct,
                    maxErrFrame: maxErrFrame, maxErrTimeText: maxErrTimeText,
                    quality: metrics.quality, fitMode: fit.fitMode,
                    optimizerIterations: fit.optimizerIterations,
                    optimizerConverged: fit.optimizerConverged,
                    warnings: warnings,
                    sampleCount: samples.count, sampleMode: sampleMode, applied: applied,
                    spanInfo: { t0: spanT0, t1: spanT1 }
                };
                safeWriteln(prop.name + " -> " + cubicStr + " | quality=" + metrics.quality + " | maxErr=" + fmt(metrics.maxErr, 6));
                } catch (targetErr) {
                    reports[ti] = {
                        propName: prop.name,
                        layerName: layerName,
                        status: "ERROR: " + targetErr.toString(),
                        cubic: "",
                        sampleMode: ""
                    };
                    safeWriteln(prop.name + " -> ERROR: " + targetErr.toString());
                }
            }
        } finally {
            if (applyNow) app.endUndoGroup();
        }
        return reports;
    }

    function buildUI(thisObj) {
        var pal = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", "Fit Cubic Bezier (Baked Keys)", undefined, { resizeable: true });
        pal.orientation = "column";
        pal.alignChildren = ["fill", "top"];

        var grpOpts = pal.add("panel", undefined, "Options");
        grpOpts.orientation = "column";
        grpOpts.alignChildren = ["fill", "top"];

        var row1 = grpOpts.add("group");
        row1.orientation = "row";
        row1.alignChildren = ["left", "center"];
        var cbCollapse = row1.add("checkbox", undefined, "Advanced: remove ALL interior keys on Apply");
        cbCollapse.value = CFG.COLLAPSE_ALL_IN_SPAN;
        cbCollapse.helpTip = "When applying: deletes every key strictly inside the time span defined by the first and last selected key (keeps endpoints). Off by default.";

        var row2 = grpOpts.add("group");
        row2.orientation = "row";
        row2.alignChildren = ["left", "center"];
        var cbClampY = row2.add("checkbox", undefined, "Clamp Y to [0..1] (AE-safe)");
        cbClampY.value = CFG.CLAMP_Y_TO_0_1;
        cbClampY.helpTip = "Constrain y1 and y2 to [0..1] so Fit + Apply maps more faithfully to AE temporal ease. May increase fit error.";
        var cbXOrder = row2.add("checkbox", undefined, "Enforce x1 <= x2");
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
        etIters.helpTip = "Nelder-Mead iterations per restart. Higher = potentially better fit, slower.";
        var cbLog = row3.add("checkbox", undefined, "Console log");
        cbLog.value = CFG.LOG_TO_CONSOLE;
        cbLog.helpTip = "Prints brief per-property results to the JavaScript Console.";

        var grpActions = pal.add("panel", undefined, "Actions");
        grpActions.orientation = "row";
        grpActions.alignChildren = ["fill", "center"];
        var btnFit = grpActions.add("button", undefined, "Fit (no apply)");
        btnFit.helpTip = "Fits cubic-bezier and reports results. Does not modify keyframes.";
        var btnFitApply = grpActions.add("button", undefined, "Fit + Apply");
        btnFitApply.helpTip = "Fits cubic-bezier then applies easing to the first+last selected key segment. Optionally deletes all interior keys in the span.";
        var btnClear = grpActions.add("button", undefined, "Clear");

        var grpRes = pal.add("panel", undefined, "Results");
        grpRes.orientation = "column";
        grpRes.alignChildren = ["fill", "fill"];
        var list = grpRes.add("listbox", undefined, [], { multiselect: false });
        list.preferredSize.height = 170;
        var detail = grpRes.add("edittext", undefined, "", { multiline: true, readonly: true, scrollable: true });
        detail.preferredSize.height = 190;
        var rowCopy = grpRes.add("group");
        rowCopy.orientation = "row";
        rowCopy.alignChildren = ["left", "center"];
        var btnCopy = rowCopy.add("button", undefined, "Copy cubic-bezier");
        var btnCopyAll = rowCopy.add("button", undefined, "Copy report");
        var lblStatus = rowCopy.add("statictext", undefined, "Ready");
        lblStatus.alignment = ["fill", "center"];
        var progBar = grpRes.add("progressbar", undefined, 0, 100);
        progBar.alignment = ["fill", "bottom"];
        progBar.visible = false;

        var lastReports = [];

        function safePanelUpdate() {
            try {
                if (typeof pal.update === "function") {
                    pal.update();
                } else if (pal.layout) {
                    if (typeof pal.layout.layout === "function") pal.layout.layout(true);
                    if (typeof pal.layout.resize === "function") pal.layout.resize();
                }
            } catch (e) {}
        }

        function selectedIndexContains(sortedIdx, k) {
            for (var i = 0; i < sortedIdx.length; i++) {
                if (sortedIdx[i] === k) return true;
                if (sortedIdx[i] > k) return false;
            }
            return false;
        }

        function previewCollapseImpact() {
            var targets = collectTargets();
            var total = 0;
            var unselected = 0;
            var props = 0;
            for (var i = 0; i < targets.length; i++) {
                var prop = targets[i].prop;
                var selectedIdx = targets[i].selectedIdx;
                var firstKeyIdx = selectedIdx[0];
                var lastKeyIdx = selectedIdx[selectedIdx.length - 1];
                var infos = getInteriorKeyInfos(prop, prop.keyTime(firstKeyIdx), prop.keyTime(lastKeyIdx), 1e-6);
                if (infos.length > 0) props++;
                total += infos.length;
                for (var j = 0; j < infos.length; j++) {
                    if (!selectedIndexContains(selectedIdx, infos[j].index)) unselected++;
                }
            }
            return { properties: props, keys: total, unselectedKeys: unselected };
        }

        function makeReportText(reports) {
            var lines = [];
            for (var i = 0; i < reports.length; i++) {
                var r = reports[i];
                if (r.status === "OK") {
                    lines.push(r.layerName + " :: " + r.propName +
                               " -> " + r.cubic +
                               " | quality=" + (r.quality ? r.quality : "") +
                               " | maxErr=" + fmt(r.maxErr, 6) +
                               " (" + fmt(r.maxErrPct, 3) + "%)" +
                               " | weightedRMSE=" + fmt(r.weightedInteriorRMSE, 8) +
                               " | weightedMSE=" + fmt(r.weightedMSE, 10) +
                               " | samples=" + (r.sampleMode ? r.sampleMode : ""));
                    if (r.applied) {
                        lines.push("  applied: removedKeys=" + r.applied.removedCount +
                                   " preservedInteriorKeys=" + r.applied.preservedInteriorCount +
                                   " outInfluence=" + fmt(r.applied.outInfluence, 3) +
                                   "% inInfluence=" + fmt(r.applied.inInfluence, 3) + "%");
                    }
                    if (r.warnings && r.warnings.length > 0) {
                        for (var w = 0; w < r.warnings.length; w++) lines.push("  warning: " + r.warnings[w]);
                    }
                } else {
                    lines.push(r.layerName + " :: " + r.propName + " -> " + r.status);
                }
            }
            return lines.join("\n");
        }

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
            progBar.visible = false;
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
                lines.push("  Quality: " + (r.quality ? r.quality : "n/a"));
                if (r.fitMode) lines.push("  Mode: " + r.fitMode);
                if (r.optimizerIterations !== undefined) {
                    lines.push("  Optimizer: " + r.optimizerIterations + " iterations" +
                               (r.optimizerConverged ? " (converged)" : " (budget reached)"));
                }
                lines.push("");
                lines.push("Numbers:");
                lines.push("  x1=" + fmt(r.x1, 6) + "  y1=" + fmt(r.y1, 6));
                lines.push("  x2=" + fmt(r.x2, 6) + "  y2=" + fmt(r.y2, 6));
                lines.push("");
                lines.push("Error:");
                lines.push("  Weighted MSE (norm): " + fmt(r.weightedMSE, 10));
                lines.push("  Weighted RMSE (interior norm): " + fmt(r.weightedInteriorRMSE, 10));
                lines.push("  RMSE (norm): " + fmt(r.rmseNorm, 10));
                lines.push("  MaxAbsError: " + fmt(r.maxErr, 6) + " value units (" + fmt(r.maxErrPct, 3) + "%)");
                lines.push("  Worst sample: " + r.maxErrTimeText + " / frame " + r.maxErrFrame);
                if (r.warnings && r.warnings.length > 0) {
                    lines.push("");
                    lines.push("Warnings:");
                    for (var wi = 0; wi < r.warnings.length; wi++) {
                        lines.push("  - " + r.warnings[wi]);
                    }
                }
                if (r.applied) {
                    lines.push("");
                    lines.push("Applied AE temporal ease (segment only):");
                    lines.push("  OUT influence: " + fmt(r.applied.outInfluence, 3) + "%");
                    lines.push("  OUT speed:     " + fmt(r.applied.outSpeed, 6) + " units/s");
                    lines.push("  IN  influence: " + fmt(r.applied.inInfluence, 3) + "%");
                    lines.push("  IN  speed:     " + fmt(r.applied.inSpeed, 6) + " units/s");
                    lines.push("  Removed keys:  " + r.applied.removedCount);
                    lines.push("  Preserved interior keys: " + r.applied.preservedInteriorCount);
                    lines.push("  Endpoint keys: " + r.applied.firstKeyIndex + " -> " + r.applied.lastKeyIndex);
                    lines.push("  Undo:          Edit > Undo Fit + Apply Cubic Bezier");
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
                var label = "[" + r.status + (r.quality ? ("/" + r.quality) : "") + "] " + r.layerName + " -> " + r.propName;
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
                if (applyNow && !CFG.CLAMP_Y_TO_0_1) {
                    if (!confirm("Clamp Y is off, so fitted CSS overshoot/anticipation may not apply faithfully as AE temporal ease.\n\nContinue anyway?")) {
                        lblStatus.text = "Apply cancelled.";
                        return;
                    }
                }
                if (applyNow && CFG.COLLAPSE_ALL_IN_SPAN) {
                    var impact = previewCollapseImpact();
                    if (impact.keys > 0) {
                        var msg = "This will remove " + impact.keys + " interior key(s) across " +
                                  impact.properties + " propert" + (impact.properties === 1 ? "y" : "ies") + ".";
                        if (impact.unselectedKeys > 0) {
                            msg += "\n\nWarning: " + impact.unselectedKeys + " of those key(s) are not currently selected.";
                        }
                        msg += "\n\nContinue with destructive key removal?";
                        if (!confirm(msg)) {
                            lblStatus.text = "Apply cancelled.";
                            return;
                        }
                    }
                }
                if (applyNow && !CFG.COLLAPSE_ALL_IN_SPAN) {
                    var keepImpact = previewCollapseImpact();
                    if (keepImpact.keys > 0) {
                        if (!confirm("There are " + keepImpact.keys + " interior key(s) inside the selected span.\n\nWith key removal off, AE cannot apply one continuous first-to-last ease; only the endpoint-adjacent segments will change.\n\nContinue anyway?")) {
                            lblStatus.text = "Apply cancelled.";
                            return;
                        }
                    }
                }
                lblStatus.text = "Initializing...";
                btnFit.enabled = false;
                btnFitApply.enabled = false;
                btnClear.enabled = false;
                progBar.value = 0;
                progBar.visible = true;
                safePanelUpdate();
                var onProgress = function(idx, total, lName, pName) {
                    lblStatus.text = "Fitting " + lName + " / " + pName + " (" + (idx + 1) + "/" + total + ")...";
                    progBar.value = (idx / total) * 100;
                    safePanelUpdate();
                };
                var reports = runFit(applyNow, onProgress);
                pushReportsToUI(reports);
                var okCount = 0;
                for (var i = 0; i < reports.length; i++) {
                    if (reports[i] && reports[i].status === "OK") okCount++;
                }
                lblStatus.text = applyNow ? ("Done. Applied to " + okCount + " property(s).")
                                         : ("Done. Fit " + okCount + " property(s).");
            } catch (e) {
                lblStatus.text = "Error.";
                alert("Error:\n\n" + e.toString());
            } finally {
                btnFit.enabled = true;
                btnFitApply.enabled = true;
                btnClear.enabled = true;
                progBar.visible = false;
                progBar.value = 0;
                safePanelUpdate();
            }
        }

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
            var text = makeReportText(lastReports);
            var ok = tryCopyToClipboard(text);
            lblStatus.text = ok ? "Copied report." : "Copy failed (clipboard blocked).";
            if (!ok) {
                detail.text = text;
                alert("Copy failed.\n\nThe full report is now in the details field for manual copying.");
            }
        };

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
