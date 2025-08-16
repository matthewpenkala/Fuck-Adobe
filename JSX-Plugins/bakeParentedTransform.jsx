/*  Bake Parented Transform — Trim- & Work-Area Aware (Optimized)
    Bakes the transform of a parented layer into an unparented layer.
    Now only bakes frames that are BOTH within the comp Work Area AND within the layer’s trimmed span.
    Samples exactly on frame boundaries for accuracy and performance.
    
    Original By: Michael Gochoco (v1.06, Dec 2010)
    Mod/Refactor: Matthew Penkala 2025-08 — work-area & trim aware + perf tweaks

    Notes:
    - Intersects [comp.workAreaStart, workAreaEnd] with [layer.inPoint, layer.outPoint].
    - If no intersection, the layer is skipped.
    - Progress bar updates are throttled to reduce UI overhead.
*/
{
    // ------------------------ Globals / UI ------------------------
    var proj = app.project;
    var progBarUI = buildProgressBarUI(" Progress", 300, 40);
    var totalDurationToBake = 0;
    var progTime = 0;

    // ------------------------ UI Helpers ------------------------
    function buildProgressBarUI(windowTitle, windowWidth, windowHeight)
    {
        if (windowWidth == null) windowWidth = 300;
        if (windowHeight == null) windowHeight = 20;

        var dlg = new Window("palette", windowTitle, undefined, { resizeable: false });
        var res =
            "group { \
                orientation:'column', alignment:['left','top'], alignChildren:['fill','fill'],  \
                progress: Group { alignment:['fill','top'], alignChildren:['fill','top'], val: Progressbar {} }, \
                text: Group { text: StaticText { preferredSize: ["+windowWidth+","+windowHeight+"], alignment:['left','top'], properties:{multiline:true} } } \
            }";

        dlg.grp = dlg.add(res);
        dlg.layergrp = dlg.add(res);

        dlg.center();
        return dlg;
    }

    function updateProgBar(progBarUIObj, isLayerProgress, barValue, barMaxValue, progressText)
    {
        var g = isLayerProgress ? progBarUIObj.layergrp : progBarUIObj.grp;
        var progBar = g.progress.val;
        var progText = g.text.text;
        if (progressText == null) progressText = "";
        progBar.maxvalue = Math.max(1, barMaxValue);
        progBar.value = (barValue <= 0) ? 0.01 : barValue;
        progText.text = progressText;
        if (parseFloat(app.version) >= 9) progBar.window.update();
    }

    // ------------------------ Math Helpers ------------------------
    function r2d(r) { return r * (180 / Math.PI); }
    function d2r(d) { return d * (Math.PI / 180); }

    function eulerToMatrix(angle, x, y, z) {
        var c = Math.cos(angle), s = Math.sin(angle), ic = 1 - c;
        return [
            ic * x * x + c,     ic * x * y - s * z,  ic * x * z + s * y,  0,
            ic * x * y + s * z, ic * y * y + c,      ic * y * z - s * x,  0,
            ic * x * z - s * y, ic * y * z + s * x,  ic * z * z + c,      0,
            0, 0, 0, 1
        ];
    }

    function matrixMultiply(a, b) {
        var r = new Array(16);
        for (var row = 0; row < 4; row++) {
            for (var col = 0; col < 4; col++) {
                var idx = row * 4 + col;
                r[idx] = a[row * 4 + 0] * b[col + 0] +
                         a[row * 4 + 1] * b[col + 4] +
                         a[row * 4 + 2] * b[col + 8] +
                         a[row * 4 + 3] * b[col + 12];
            }
        }
        return r;
    }

    function matrixToEuler(m) {
        // Matches original’s convention (ZYX)
        var theta = -Math.asin(m[2]); // -asin(m13)
        var cosT = Math.cos(theta);
        theta = -r2d(theta);
        var phi, psi, tx, ty;
        if (Math.abs(cosT) > 0.0005) {
            tx = m[10] / cosT; ty = -m[6] / cosT;     // m33, -m23
            phi = r2d(Math.atan2(ty, tx));
            tx = m[0] / cosT;  ty = -m[1] / cosT;     // m11, -m12
            psi = r2d(Math.atan2(ty, tx));
        } else {
            phi = 0;
            tx = m[5]; ty = m[4];                     // m22, m21
            psi = r2d(Math.atan2(ty, tx));
        }
        return [phi, theta, psi];
    }

    // ------------------------ Feature Flags / Counting ------------------------
    function preBake(layer) {
        // returns how many transform groups we’ll bake (for progress sizing)
        var count = 0;
        if (layer.position.selected) count++;
        if (layer.scale.selected) count++;
        if (layer.orientation.selected || layer.rotation.selected || layer.xRotation.selected || layer.yRotation.selected || layer.zRotation.selected) count++;
        return count || 3; // if none selected, we bake all three
    }

    // ------------------------ Frame Windowing ------------------------
    function getLayerBakeWindow(comp, layer) {
        // Intersect work area with layer trim
        var waStart = comp.workAreaStart;
        var waEnd = comp.workAreaStart + comp.workAreaDuration;
        var tStart = Math.max(waStart, layer.inPoint);
        var tEnd = Math.min(waEnd, layer.outPoint);
        if (tEnd <= tStart) return null; // no overlap

        // Snap to exact frame ticks to avoid subframe drift
        var fps = comp.frameRate;
        var fd = 1 / fps;

        // First actual frame >= tStart
        var first = Math.ceil(tStart * fps) / fps;
        // Last actual frame <= tEnd - epsilon (do not include the outPoint frame)
        var last = Math.floor((tEnd - 1e-6) * fps) / fps;
        if (last < first) return null;

        // Build an array of times (strictly on frames)
        var times = [];
        for (var t = first; t <= last + 1e-10; t += fd) {
            times.push(Math.round(t * fps) / fps);
        }
        return { times: times, start: first, end: last, duration: (last - first + fd) };
    }

    // ------------------------ Core Bake Dispatcher ------------------------
    function bake(inLayer, outLayer, timeWin) {
        var doPos = false, doScl = false, doRot = false;
        if (outLayer.position.selected) doPos = true;
        if (outLayer.scale.selected) doScl = true;
        if (outLayer.orientation.selected || outLayer.rotation.selected || outLayer.xRotation.selected || outLayer.yRotation.selected || outLayer.zRotation.selected) doRot = true;
        if (!doPos && !doScl && !doRot) { doPos = true; doScl = true; doRot = true; }

        // Position/Scale
        if (doPos || doScl) {
            if (inLayer.position.dimensionsSeparated) {
                if (inLayer.threeDLayer || inLayer instanceof CameraLayer || inLayer instanceof LightLayer)
                    bakePositionScale3DSeperateDimensions(inLayer, outLayer, doPos, doScl, timeWin);
                else
                    bakePositionScale2DSeperateDimensions(inLayer, outLayer, doPos, doScl, timeWin);
            } else {
                bakePositionScale(inLayer, outLayer, doPos, doScl, timeWin);
            }
        }
        // Rotation
        if (doRot) {
            if (inLayer.threeDLayer || inLayer instanceof CameraLayer || inLayer instanceof LightLayer)
                bake3DRotation(inLayer, outLayer, timeWin);
            else
                bake2DRotation(inLayer, outLayer, timeWin);
        }
    }

    // ------------------------ Baking Helpers (Rotation) ------------------------
    function bake3DRotation(inLayer, outLayer, timeWin) {
        var rotX = [], rotY = [], rotZ = [], times = timeWin.times;
        var fps = inLayer.containingComp.frameRate;
        var progressText = "Processing " + outLayer.name + " Rotation";
        var uiModulo = Math.max(1, Math.floor(times.length / 30));

        for (var i = 0; i < times.length; i++) {
            var t = times[i];
            inLayer.containingComp.time = t;
            var tmp = inLayer.duplicate();
            tmp.parent = null;

            // Combine Orientation + XYZ Rotation into a single matrix then back to Euler
            var rx = eulerToMatrix(d2r(tmp.rotationX.valueAtTime(t, false)), 1, 0, 0);
            var ry = eulerToMatrix(d2r(tmp.rotationY.valueAtTime(t, false)), 0, 1, 0);
            var rz = eulerToMatrix(d2r(tmp.rotationZ.valueAtTime(t, false)), 0, 0, 1);
            var rMat = matrixMultiply(rx, matrixMultiply(ry, rz));

            var o = tmp.orientation.valueAtTime(t, false);
            var ox = eulerToMatrix(d2r(o[0]), 1, 0, 0);
            var oy = eulerToMatrix(d2r(o[1]), 0, 1, 0);
            var oz = eulerToMatrix(d2r(o[2]), 0, 0, 1);
            var oMat = matrixMultiply(ox, matrixMultiply(oy, oz));

            var finalMat = matrixMultiply(oMat, rMat);
            var eul = matrixToEuler(finalMat);

            rotZ.push(eul[2]); rotY.push(eul[1]); rotX.push(eul[0]);
            tmp.remove();

            // progress (throttled)
            if (i % uiModulo === 0) {
                progTime += (1 / fps);
                updateProgBar(progBarUI, false, progTime, totalDurationToBake, "Total Progress");
                updateProgBar(progBarUI, true, (t - timeWin.start), (timeWin.end - timeWin.start + 1 / fps), progressText);
            }
        }

        // clear and set
        while (outLayer.rotationX.numKeys > 0) outLayer.rotationX.removeKey(outLayer.rotationX.numKeys);
        while (outLayer.rotationY.numKeys > 0) outLayer.rotationY.removeKey(outLayer.rotationY.numKeys);
        while (outLayer.rotationZ.numKeys > 0) outLayer.rotationZ.removeKey(outLayer.rotationZ.numKeys);
        while (outLayer.orientation.numKeys > 0) outLayer.orientation.removeKey(outLayer.orientation.numKeys);
        try {
            outLayer.rotationZ.setValuesAtTimes(times, rotZ); outLayer.rotationZ.expressionEnabled = false;
            outLayer.rotationY.setValuesAtTimes(times, rotY); outLayer.rotationY.expressionEnabled = false;
            outLayer.rotationX.setValuesAtTimes(times, rotX); outLayer.rotationX.expressionEnabled = false;
            outLayer.orientation.setValue([0, 0, 0]); outLayer.orientation.expressionEnabled = false;
        } catch (e) {}
    }

    function bake2DRotation(inLayer, outLayer, timeWin) {
        var vals = [], times = timeWin.times;
        var fps = inLayer.containingComp.frameRate;
        var progressText = "Processing " + outLayer.name + " Rotation";
        var uiModulo = Math.max(1, Math.floor(times.length / 30));

        for (var i = 0; i < times.length; i++) {
            var t = times[i];
            inLayer.containingComp.time = t;
            var tmp = inLayer.duplicate();
            tmp.parent = null;
            vals.push(tmp.rotation.valueAtTime(t, false));
            tmp.remove();

            if (i % uiModulo === 0) {
                progTime += (1 / fps);
                updateProgBar(progBarUI, false, progTime, totalDurationToBake, "Total Progress");
                updateProgBar(progBarUI, true, (t - timeWin.start), (timeWin.end - timeWin.start + 1 / fps), progressText);
            }
        }
        while (outLayer.rotation.numKeys > 0) outLayer.rotation.removeKey(outLayer.rotation.numKeys);
        try {
            outLayer.rotation.setValuesAtTimes(times, vals);
            outLayer.rotation.expressionEnabled = false;
        } catch (e) {}
    }

    // ------------------------ Baking Helpers (Position/Scale) ------------------------
    function bakePositionScale(inLayer, outLayer, doPos, doScl, timeWin) {
        var pVals = [], sVals = [], times = timeWin.times, fps = inLayer.containingComp.frameRate;
        var progressText = "Processing " + outLayer.name + (doPos ? (doScl ? " Position and Scale" : " Position") : " Scale");
        var uiModulo = Math.max(1, Math.floor(times.length / 30));

        for (var i = 0; i < times.length; i++) {
            var t = times[i];
            inLayer.containingComp.time = t;
            var tmp = inLayer.duplicate();
            tmp.parent = null;
            if (doPos) pVals.push(tmp.position.valueAtTime(t, false));
            if (doScl) sVals.push(tmp.scale.valueAtTime(t, false));
            tmp.remove();

            if (i % uiModulo === 0) {
                if (doPos) progTime += (1 / fps);
                if (doScl) progTime += (1 / fps);
                updateProgBar(progBarUI, false, progTime, totalDurationToBake, "Total Progress");
                updateProgBar(progBarUI, true, (t - timeWin.start), (timeWin.end - timeWin.start + 1 / fps), progressText);
            }
        }

        if (doPos) {
            while (outLayer.position.numKeys > 0) outLayer.position.removeKey(outLayer.position.numKeys);
            try { outLayer.position.setValuesAtTimes(times, pVals); outLayer.position.expressionEnabled = false; } catch (e) {}
        }
        if (doScl) {
            while (outLayer.scale.numKeys > 0) outLayer.scale.removeKey(outLayer.scale.numKeys);
            try { outLayer.scale.setValuesAtTimes(times, sVals); outLayer.scale.expressionEnabled = false; } catch (e) {}
        }
    }

    function bakePositionScale2DSeperateDimensions(inLayer, outLayer, doPos, doScl, timeWin) {
        var xVals = [], yVals = [], sVals = [], times = timeWin.times, fps = inLayer.containingComp.frameRate;
        var progressText = "Processing " + outLayer.name + (doPos ? (doScl ? " Position and Scale" : " Position") : " Scale");
        var uiModulo = Math.max(1, Math.floor(times.length / 30));

        for (var i = 0; i < times.length; i++) {
            var t = times[i];
            inLayer.containingComp.time = t;
            var tmp = inLayer.duplicate(); tmp.parent = null;
            if (doPos) {
                xVals.push(tmp.position.getSeparationFollower(0).valueAtTime(t, false));
                yVals.push(tmp.position.getSeparationFollower(1).valueAtTime(t, false));
            }
            if (doScl) sVals.push(tmp.scale.valueAtTime(t, false));
            tmp.remove();

            if (i % uiModulo === 0) {
                if (doPos) progTime += (1 / fps);
                if (doScl) progTime += (1 / fps);
                updateProgBar(progBarUI, false, progTime, totalDurationToBake, "Total Progress");
                updateProgBar(progBarUI, true, (t - timeWin.start), (timeWin.end - timeWin.start + 1 / fps), progressText);
            }
        }

        if (doPos) {
            while (outLayer.position.getSeparationFollower(0).numKeys > 0) outLayer.position.getSeparationFollower(0).removeKey(outLayer.position.getSeparationFollower(0).numKeys);
            while (outLayer.position.getSeparationFollower(1).numKeys > 0) outLayer.position.getSeparationFollower(1).removeKey(outLayer.position.getSeparationFollower(1).numKeys);
            try {
                outLayer.position.getSeparationFollower(0).setValuesAtTimes(times, xVals); outLayer.position.getSeparationFollower(0).expressionEnabled = false;
                outLayer.position.getSeparationFollower(1).setValuesAtTimes(times, yVals); outLayer.position.getSeparationFollower(1).expressionEnabled = false;
            } catch (e) {}
        }
        if (doScl) {
            while (outLayer.scale.numKeys > 0) outLayer.scale.removeKey(outLayer.scale.numKeys);
            try { outLayer.scale.setValuesAtTimes(times, sVals); outLayer.scale.expressionEnabled = false; } catch (e) {}
        }
    }

    function bakePositionScale3DSeperateDimensions(inLayer, outLayer, doPos, doScl, timeWin) {
        var xVals = [], yVals = [], zVals = [], sVals = [], times = timeWin.times, fps = inLayer.containingComp.frameRate;
        var progressText = "Processing " + outLayer.name + (doPos ? (doScl ? " Position and Scale" : " Position") : " Scale");
        var uiModulo = Math.max(1, Math.floor(times.length / 30));

        for (var i = 0; i < times.length; i++) {
            var t = times[i];
            inLayer.containingComp.time = t;
            var tmp = inLayer.duplicate(); tmp.parent = null;
            if (doPos) {
                xVals.push(tmp.position.getSeparationFollower(0).valueAtTime(t, false));
                yVals.push(tmp.position.getSeparationFollower(1).valueAtTime(t, false));
                zVals.push(tmp.position.getSeparationFollower(2).valueAtTime(t, false));
            }
            if (doScl) sVals.push(tmp.scale.valueAtTime(t, false));
            tmp.remove();

            if (i % uiModulo === 0) {
                if (doPos) progTime += (1 / fps);
                if (doScl) progTime += (1 / fps);
                updateProgBar(progBarUI, false, progTime, totalDurationToBake, "Total Progress");
                updateProgBar(progBarUI, true, (t - timeWin.start), (timeWin.end - timeWin.start + 1 / fps), progressText);
            }
        }

        if (doPos) {
            while (outLayer.position.getSeparationFollower(0).numKeys > 0) outLayer.position.getSeparationFollower(0).removeKey(outLayer.position.getSeparationFollower(0).numKeys);
            while (outLayer.position.getSeparationFollower(1).numKeys > 0) outLayer.position.getSeparationFollower(1).removeKey(outLayer.position.getSeparationFollower(1).numKeys);
            while (outLayer.position.getSeparationFollower(2).numKeys > 0) outLayer.position.getSeparationFollower(2).removeKey(outLayer.position.getSeparationFollower(2).numKeys);
            try {
                outLayer.position.getSeparationFollower(0).setValuesAtTimes(times, xVals); outLayer.position.getSeparationFollower(0).expressionEnabled = false;
                outLayer.position.getSeparationFollower(1).setValuesAtTimes(times, yVals); outLayer.position.getSeparationFollower(1).expressionEnabled = false;
                outLayer.position.getSeparationFollower(2).setValuesAtTimes(times, zVals); outLayer.position.getSeparationFollower(2).expressionEnabled = false;
            } catch (e) {}
        }
        if (doScl) {
            while (outLayer.scale.numKeys > 0) outLayer.scale.removeKey(outLayer.scale.numKeys);
            try { outLayer.scale.setValuesAtTimes(times, sVals); outLayer.scale.expressionEnabled = false; } catch (e) {}
        }
    }

    // ------------------------ Main ------------------------
    function main() {
        app.beginUndoGroup("bakeParentedTransform (WorkArea+Trim)");
        if (!proj || proj.numItems === 0) { alert("Please select layer(s) or a layer transform(s) within an active comp!"); app.endUndoGroup(); return; }
        var comp = proj.activeItem;
        if (!(comp && comp instanceof CompItem)) { alert("Please select layer(s) or a layer transform(s) within an active comp!"); app.endUndoGroup(); return; }

        var targets = comp.selectedLayers;
        if (!targets || targets.length === 0) { alert("Please select layer(s) or a layer transform(s) within an active comp!"); app.endUndoGroup(); return; }

        // Pre-count total duration for progress (using per-layer intersections)
        totalDurationToBake = 0;
        var perLayerWindows = [];
        for (var i = 0; i < targets.length; i++) {
            var L = targets[i];
            if (L.hasAudio && !L.hasVideo) { perLayerWindows.push(null); continue; } // skip pure audio
            var win = getLayerBakeWindow(comp, L);
            perLayerWindows.push(win);
            if (win) {
                totalDurationToBake += preBake(L) * Math.max(0, (win.end - win.start + 1 / comp.frameRate));
            }
        }

        if (totalDurationToBake <= 0) {
            alert("Nothing to bake within the current Work Area and layer trims.");
            app.endUndoGroup(); return;
        }

        var originalTime = comp.time;
        if (originalTime < 0) originalTime = 0;

        progBarUI.show();
        updateProgBar(progBarUI, false, 0.01, totalDurationToBake, "Total Progress");

        for (var j = 0; j < targets.length; j++) {
            var layer = targets[j];
            if (layer.hasAudio && !layer.hasVideo) continue; // skip pure audio
            var win = perLayerWindows[j];
            if (!win) continue; // no overlap => skip

            // Duplicate, bake, remove dupe (per original behavior)
            var dupe = layer.duplicate();
            layer.parent = null; // prepare target to receive keys
            bake(dupe, layer, win);
            dupe.remove();
        }

        updateProgBar(progBarUI, false, 1, 1, "Total Progress");
        progBarUI.close();
        comp.time = originalTime;
        app.endUndoGroup();
    }

    // Kick it
    main();
}
