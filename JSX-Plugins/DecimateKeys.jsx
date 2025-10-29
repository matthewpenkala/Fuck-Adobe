/*  DecimateKeys.jsx
    v1.1 — Keep every Nth selected key on each selected property; optional endpoint preservation.
           Remaining keys inside the original selection span are set to Auto Bezier
           (temporal + spatial when applicable).

    UI
    • Integer "Every Nth to KEEP" (1 = remove every other of the SELECTED keys)
    • Checkbox: "Preserve first & last in selection" (default OFF)
    • Button: "Reduce"
*/

(function DecimateKeys_UI(){
    // ---------- Helpers ----------
    function getSelectedLeafProperties(comp){
        var out = [];
        if (!comp || !comp.selectedProperties || comp.selectedProperties.length === 0) return out;

        function collectLeaf(p){
            if (!p) return;
            if (p.propertyType && p.propertyType === PropertyType.PROPERTY){
                out.push(p);
            } else if (p.numProperties){
                for (var i=1; i<=p.numProperties; i++){
                    collectLeaf(p.property(i));
                }
            }
        }
        for (var i=0; i<comp.selectedProperties.length; i++){
            collectLeaf(comp.selectedProperties[i]);
        }
        return out;
    }

    function getSelectedKeyIndices(prop){
        if (prop.selectedKeys && prop.selectedKeys.length !== undefined) {
            return prop.selectedKeys.slice(); // ascending
        }
        var idxs = [];
        for (var k=1; k<=prop.numKeys; k++){
            if (prop.keySelected(k)) idxs.push(k);
        }
        return idxs;
    }

    function timesFromIndices(prop, indices){
        var arr = [];
        for (var i=0; i<indices.length; i++){
            arr.push(prop.keyTime(indices[i]));
        }
        arr.sort(function(a,b){ return a - b; });
        return arr;
    }

    function removeKeysAtTimes(prop, times){
        // Delete latest→earliest to avoid reindex issues
        times.sort(function(a,b){ return b - a; });
        for (var i=0; i<times.length; i++){
            var t = times[i];
            var k = prop.nearestKeyIndex(t);
            if (k >= 1 && Math.abs(prop.keyTime(k) - t) < 1e-9){
                prop.removeKey(k);
            }
        }
    }

    function setAutoBezierInsideSpan(prop, tMin, tMax){
        for (var k=1; k<=prop.numKeys; k++){
            var kt = prop.keyTime(k);
            if (kt + 1e-12 >= tMin && kt - 1e-12 <= tMax){
                // Temporal Auto Bezier
                try { prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER); } catch(e){}
                try { prop.setTemporalContinuousAtKey(k, true); } catch(e){}
                try { prop.setTemporalAutoBezierAtKey(k, true); } catch(e){}

                // Spatial Auto Bezier (if meaningful)
                try {
                    if (prop.isSpatial){
                        prop.setSpatialContinuousAtKey(k, true);
                        prop.setSpatialAutoBezierAtKey(k, true);
                    }
                } catch(e){}
            }
        }
    }

    // Decimate using a pre-snapshotted selection
    function decimateFromSnapshot(prop, selTimes, keepEveryNth, preserveEndpoints){
        if (!selTimes || selTimes.length === 0) return;

        var stride = Math.max(1, keepEveryNth);
        var tMin = selTimes[0], tMax = selTimes[selTimes.length - 1];

        var toRemove = [];
        for (var i=0; i<selTimes.length; i++){
            var keep = (i % stride) === 0; // keep 0, N, 2N...
            if (!keep) toRemove.push(selTimes[i]);
        }

        // If preserving endpoints, ensure first and last selected times are kept
        if (preserveEndpoints && selTimes.length > 0){
            var firstT = selTimes[0];
            var lastT  = selTimes[selTimes.length - 1];
            // remove first/last from toRemove if present
            for (var r = toRemove.length - 1; r >= 0; r--){
                var t = toRemove[r];
                if (Math.abs(t - firstT) < 1e-9 || Math.abs(t - lastT) < 1e-9){
                    toRemove.splice(r, 1);
                }
            }
        }

        removeKeysAtTimes(prop, toRemove);
        setAutoBezierInsideSpan(prop, tMin, tMax);
    }

    // ---------- UI ----------
    var win = new Window("palette", "Decimate Keys", undefined, {resizeable:true});
    var g = win.add("group"); g.orientation = "column"; g.alignChildren = ["fill","top"]; g.margins = 10; g.spacing = 8;

    var row = g.add("group"); row.orientation = "row"; row.alignChildren = ["left","center"];
    row.add("statictext", undefined, "Every Nth to KEEP:");
    var et = row.add("edittext", undefined, "1"); et.characters = 6;

    var chk = g.add("checkbox", undefined, "Preserve first & last in selection");
    chk.value = false; // default OFF

    var btn = g.add("button", undefined, "Reduce");

    btn.onClick = function(){
        var comp = app.project && app.project.activeItem;
        if (!(comp && comp instanceof CompItem)){
            alert("Open a composition and select properties with keyframes.");
            return;
        }

        var n = parseInt(et.text, 10);
        if (!isFinite(n) || n < 1){
            alert("Enter an integer ≥ 1 (e.g., 1 removes every other SELECTED key).");
            return;
        }
        var preserve = !!chk.value;

        // Snapshot properties AND their selected key TIMES up front
        var props = getSelectedLeafProperties(comp);
        var jobs = []; // {prop: p, selTimes: [...]}

        for (var i=0; i<props.length; i++){
            var p = props[i];
            if (!p || !p.canVaryOverTime || p.numKeys < 1) continue;

            var selIdx = getSelectedKeyIndices(p);
            if (selIdx.length === 0) continue;

            jobs.push({ prop: p, selTimes: timesFromIndices(p, selIdx) });
        }

        if (jobs.length === 0){
            alert("Select one or more properties and some keyframes on them.");
            return;
        }

        app.beginUndoGroup("Decimate Keys (Keep every Nth selected)");
        try{
            for (var j=0; j<jobs.length; j++){
                var job = jobs[j];
                decimateFromSnapshot(job.prop, job.selTimes, n, preserve);
            }
        } catch(err){
            alert("Error: " + err.toString());
        } finally {
            app.endUndoGroup();
        }
    };

    win.onResizing = win.onResize = function(){ this.layout.resize(); };
    win.center();
    win.show();
})();