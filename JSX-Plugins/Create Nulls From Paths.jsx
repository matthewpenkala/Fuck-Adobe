/*
    Create Nulls From Paths.jsx (v1.2) - Updated, Optimized version
    -------------------------------------------------------
    Based on:
        "Create Nulls From Paths.jsx v.0.6" by Adobe
        -  Fixes by Rana Hamid
        -  Enhancements by Pablo Cuello v1.1

    Consolidation & refactoring by Matthew Penkala (+ LLMs ◔̯ ◔) and updated with robust path selection recursion.
*/

/* Wrap everything in an IIFE */
(function createNullsFromPaths (thisObj) {

    /* --------------------------------------------------
       Build UI
    -------------------------------------------------- */
    function buildUI(thisObj) {
        var windowTitle = localize("$$$/AE/Script/CreatePathNulls/CreateNullsFromPaths=Create Nulls From Paths");
        var firstButton = localize("$$$/AE/Script/CreatePathNulls/PathPointsToNulls=Points Follow Nulls");
        var secondButton = localize("$$$/AE/Script/CreatePathNulls/NullsToPathPoints=Nulls Follow Points");
        var thirdButton = localize("$$$/AE/Script/CreatePathNulls/TracePath=Trace Path");
        var checkRotate = localize("$$$/AE/Script/CreatePathNulls/AddControlsForHandles=Rotate Nulls");

        var win = (thisObj instanceof Panel) ? thisObj : new Window('palette', windowTitle);
        win.spacing = 0;
        win.margins = 8;

        var myButtonGroup = win.add ("group");
            myButtonGroup.spacing = 4;
            myButtonGroup.margins = 0;
            myButtonGroup.orientation = "row";
            myButtonGroup.alignment = ["center", "top"];
            myButtonGroup.alignChildren = ["center", "top"];

        var col1 = myButtonGroup.add ("group");
            col1.orientation = "column";
        var col2 = myButtonGroup.add ("group");
            col2.orientation = "column";
        var col3 = myButtonGroup.add ("group");
            col3.orientation = "column";

        // Buttons
        win.button1 = col1.add ("button", undefined, firstButton);
        win.button2 = col2.add ("button", undefined, secondButton);
        win.button3 = col3.add ("button", undefined, thirdButton);

        // Checkbox
        win.checkRotate = col2.add ("checkbox", undefined, checkRotate);
        win.checkRotate.value = true;

        // Button click handlers
        win.button1.onClick = function() {
            selectFirstPathProperty();
            linkPointsToNulls();
        };
        win.button2.onClick = function() {
            selectFirstPathProperty();
            linkNullsToPoints();
        };
        win.button3.onClick = function() {
            selectFirstPathProperty();
            tracePath();
        };

        win.layout.layout(true);

        return win;
    }

    // Show the Panel
    var w = buildUI(thisObj);
    if (w.toString() === "[object Panel]") {
        // If dockable
        w;
    } else {
        w.show();
    }


    /* --------------------------------------------------
       SELECT FIRST PATH PROPERTY - FIXED
    -------------------------------------------------- */
    /**
     * Recursively search for the first "ADBE Vector Shape" property
     * within shape contents (any level of nesting).
     * @param {PropertyGroup} group - The current property group to search.
     * @return {Boolean} true if a path is found and selected.
     */
    function findFirstPathProperty(group) {
        if (!group || group.numProperties === 0) {
            return false;
        }
        for (var i = 1; i <= group.numProperties; i++) {
            var p = group.property(i);
            if (!p) continue;

            // Check if p is a shape path
            if (p.matchName === "ADBE Vector Shape") {
                p.selected = true;
                return true;
            }

            // If p is another group, search inside it
            if (
                p.propertyType === PropertyType.INDEXED_GROUP ||
                p.propertyType === PropertyType.NAMED_GROUP
            ) {
                if (findFirstPathProperty(p)) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Finds the first selected shape layer (if any) and attempts to
     * select its first path property by searching all subgroups.
     */
    function selectFirstPathProperty() {
        var activeComp = app.project.activeItem;
        if (!activeComp || !(activeComp instanceof CompItem)) {
            alert("No active composition found.");
            return;
        }

        var layers = activeComp.selectedLayers;
        if (!layers || layers.length === 0) {
            // You can choose to alert or just silently do nothing
            // alert("Please select a shape layer first.");
            return;
        }

        var foundPath = false;
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            if (layer.matchName === "ADBE Vector Layer") {
                var contents = layer.property("ADBE Root Vectors Group");
                if (!contents) continue;

                // Use the recursive search
                if (findFirstPathProperty(contents)) {
                    foundPath = true;
                    // If you only want the first path in the first shape layer
                    // then stop; if you want to check *all* selected shape layers,
                    // remove this `break`.
                    break;
                }
            }
        }

        if (!foundPath) {
            // We never found a path in any of the selected shape layers
            // Possibly because they have no path or are not shape layers
            // or the shape is empty.
            alert("Path property not found in the shape layer(s).");
        }
    }


    /* --------------------------------------------------
       GENERAL FUNCTIONS
    -------------------------------------------------- */
    function getActiveComp(){
        var theComp = app.project.activeItem;
        if (!theComp) {
            var errorMsg = localize("$$$/AE/Script/CreatePathNulls/ErrorNoComp=Error: Please select a composition.");
            alert(errorMsg);
            return null;
        }
        return theComp;
    }

    function getSelectedLayers(targetComp){
        return targetComp.selectedLayers;
    }

    function createNull(targetComp){
        return targetComp.layers.addNull();
    }

    function getSelectedProperties(targetLayer){
        var props = targetLayer.selectedProperties;
        return (props && props.length > 0) ? props : null;
    }

    function forEachLayer(targetLayerArray, doSomething) {
        for (var i = 0; i < targetLayerArray.length; i++){
            doSomething(targetLayerArray[i]);
        }
    }

    function forEachProperty(targetProps, doSomething){
        for (var i = 0; i < targetProps.length; i++){
            doSomething(targetProps[i]);
        }
    }

    function forEachEffect(targetLayer, doSomething){
        var fx = targetLayer.property("ADBE Effect Parade");
        if (!fx) return;
        for (var i = 1; i <= fx.numProperties; i++) {
            doSomething(fx.property(i));
        }
    }

    function matchMatchName(targetEffect, matchNameString){
        if (targetEffect && targetEffect.matchName === matchNameString) {
            return targetEffect;
        }
        return null;
    }

    function getPropPath(currentProp, pathHierarchy){
        var pathPath = "";
        while (currentProp.parentProperty !== null){
            if (currentProp.parentProperty.propertyType === PropertyType.INDEXED_GROUP) {
                pathHierarchy.unshift(currentProp.propertyIndex);
                pathPath = "(" + currentProp.propertyIndex + ")" + pathPath;
            } else {
                pathPath = "(\"" + currentProp.matchName.toString() + "\")" + pathPath;
            }
            // Traverse up
            currentProp = currentProp.parentProperty;
        }
        return pathPath;
    }

    function getGroupPath(currentProp, pathHierarchy){
        // Typically up 3 levels from the path to the group's transform
        currentProp = currentProp.parentProperty.parentProperty.parentProperty;
        return getPropPath(currentProp, pathHierarchy);
    }

    function getPathPoints(path){
        return path.value.vertices;
    }

    function getCheckRotate(){
        return w.checkRotate.value;
    }


    /* --------------------------------------------------
       forEachPath
       (Executes a function on each selected path property.)
    -------------------------------------------------- */
    function forEachPath(doSomething){
        var comp = getActiveComp();
        if (!comp) return;

        var selectedLayers = getSelectedLayers(comp);
        if (!selectedLayers || selectedLayers.length === 0) return;

        var selectedPaths = [];
        var parentLayers = [];

        forEachLayer(selectedLayers, function(selectedLayer){
            var props = getSelectedProperties(selectedLayer);
            if (!props) return;
            forEachProperty(props, function(path){
                var isShapePath = matchMatchName(path, "ADBE Vector Shape");
                var isMaskPath  = matchMatchName(path, "ADBE Mask Shape");
                // Excluding Paint & Roto because not script-accessible
                if (isShapePath || isMaskPath) {
                    selectedPaths.push(path);
                    parentLayers.push(selectedLayer);
                }
            });
        });

        if (selectedPaths.length === 0){
            var pathError = localize("$$$/AE/Script/CreatePathNulls/ErrorNoPathsSelected=Error: No paths selected.");
            alert(pathError);
            return;
        }

        for (var p = 0; p < selectedPaths.length; p++) {
            doSomething(comp, parentLayers[p], selectedPaths[p]);
        }
    }


    /* --------------------------------------------------
       LINK NULLS TO POINTS
       (Nulls follow path vertices)
    -------------------------------------------------- */
    function linkNullsToPoints(){
        var undoGroup = localize("$$$/AE/Script/CreatePathNulls/LinkNullsToPathPoints=Link Nulls to Path Points");
        app.beginUndoGroup(undoGroup);

        forEachPath(function(comp, selectedLayer, path){
            var pathHierarchy = [];
            var pathPath  = getPropPath(path, pathHierarchy);
            var groupPath = getGroupPath(path, pathHierarchy);

            var pathPoints = getPathPoints(path);
            for (var i = 0; i < pathPoints.length; i++){
                var nullName = selectedLayer.name + ": " + path.parentProperty.name + " [" + pathHierarchy.join(".") + "." + i + "]";
                if (!comp.layer(nullName)) {
                    var newNull = createNull(comp);
                    newNull.moveBefore(selectedLayer);
                    newNull.name = nullName;
                    newNull.label = 10;  // color label

                    // Position expression to follow path point
                    newNull.position.setValue(pathPoints[i]);
                    newNull.position.expression =
                        "var srcLayer = thisComp.layer(\"" + selectedLayer.name + "\");\r" +
                        "var srcPos   = srcLayer" + groupPath + ".transform.position;\r" +
                        "var srcPath  = srcLayer" + pathPath + ".points()[" + i + "];\r" +
                        "srcLayer.toComp(srcPath + srcPos);";

                    // Optional rotation using tangents
                    if (getCheckRotate()){
                        newNull.rotation.expression =
                            "var srcLayer = thisComp.layer(\"" + selectedLayer.name + "\");\r" +
                            "var tang     = srcLayer" + pathPath + ".outTangents()[" + i + "];\r" +
                            "var d        = tang + transform.position;\r" +
                            "if (d[0] == 0){\r" +
                            "   A = (d[1]<0) ? 90 : -90;\r" +
                            "} else {\r" +
                            "   A = radiansToDegrees(Math.atan(d[1]/d[0]));\r" +
                            "}\r" +
                            "((d[0]>0) ? A : 180 + A) + srcLayer.rotation;";
                    }
                }
            }
        });

        app.endUndoGroup();
    }


    /* --------------------------------------------------
       LINK POINTS TO NULLS
       (Path points follow the Nulls)
    -------------------------------------------------- */
    function linkPointsToNulls(){
        var undoGroup = localize("$$$/AE/Script/CreatePathNulls/LinkPathPointsToNulls=Link Path Points to Nulls");
        app.beginUndoGroup(undoGroup);

        forEachPath(function(comp, selectedLayer, path){
            var pathHierarchy = [];
            var pathPath  = getPropPath(path, pathHierarchy);
            var groupPath = getGroupPath(path, pathHierarchy);
            var groupId   = pathHierarchy.slice();

            var nullSet   = [];
            var pathPoints= getPathPoints(path);

            // Create (or find) a Null per vertex
            for (var i = 0; i < pathPoints.length; i++){
                var nullName = selectedLayer.name + ": " + path.parentProperty.name + " [" + pathHierarchy.join(".") + "." + i + "]";
                nullSet.push(nullName);

                if (!comp.layer(nullName)) {
                    var newNull = createNull(comp);
                    newNull.moveBefore(selectedLayer);
                    newNull.name = nullName;
                    newNull.label = 11;

                    // Initialize position to the shape vertex
                    newNull.position.setValue(pathPoints[i]);
                    // Expression to account for shape group offset, then bake in
                    newNull.position.expression =
                        "var srcLayer = thisComp.layer(\"" + selectedLayer.name + "\");\r" +
                        "var srcPos   = srcLayer" + groupPath + ".transform.position;\r" +
                        "var srcPath  = srcLayer" + pathPath + ".points()[" + i + "];\r" +
                        "srcLayer.toComp(srcPath + srcPos);";
                    newNull.position.setValue(newNull.position.value);
                    newNull.position.expression = '';
                }
            }

            // Add or re-link any needed Layer Control effects on the shape layer
            var existingEffects = [];
            forEachEffect(selectedLayer, function(targetEffect){
                if (matchMatchName(targetEffect, "ADBE Layer Control")) {
                    existingEffects.push(targetEffect.name);
                }
            });

            for (var n = 0; n < nullSet.length; n++){
                var nullLayerName = nullSet[n];
                if (existingEffects.join("|").indexOf(nullLayerName) !== -1) {
                    // Re-link existing effect
                    selectedLayer.property("ADBE Effect Parade")(nullLayerName)
                        .property("ADBE Layer Control-0001")
                        .setValue(comp.layer(nullLayerName).index);
                } else {
                    // Create new effect
                    var newControl = selectedLayer.property("ADBE Effect Parade").addProperty("ADBE Layer Control");
                    newControl.name = nullLayerName;
                    newControl.property("ADBE Layer Control-0001").setValue(comp.layer(nullLayerName).index);
                }
            }

            // Expression on the path: references each Null
            path.expression =
                "var nullLayerNames = [\"" + nullSet.join("\",\"") + "\"];\r" +
                "var origPath   = thisProperty;\r" +
                "var origPoints = origPath.points();\r" +
                "var origInTang = origPath.inTangents();\r" +
                "var origOutTang= origPath.outTangents();\r" +
                "// transform offset from the group transform:\r" +
                "var origPos    = content(" + groupId[0] + ").transform.position;\r" +
                "var getNullLayers = [];\r" +
                "for (var i = 0; i < nullLayerNames.length; i++){\r" +
                "    try {\r" +
                "        getNullLayers.push(effect(nullLayerNames[i])(\"ADBE Layer Control-0001\"));\r" +
                "    } catch(err) {\r" +
                "        getNullLayers.push(null);\r" +
                "    }\r" +
                "}\r" +
                "for (var i = 0; i < getNullLayers.length; i++){\r" +
                "    if (getNullLayers[i] != null && getNullLayers[i].index != thisLayer.index){\r" +
                "        origPoints[i] = fromCompToSurface(getNullLayers[i].toComp(getNullLayers[i].anchorPoint)) - origPos;\r" +
                "    }\r" +
                "}\r" +
                "createPath(origPoints, origInTang, origOutTang, origPath.isClosed());";
        });

        app.endUndoGroup();
    }


    /* --------------------------------------------------
       TRACE PATH
       (Creates a Null traveling along the path)
    -------------------------------------------------- */
    function tracePath(){
        var undoGroup = localize("$$$/AE/Script/CreatePathNulls/CreatePathTracerNull=Create Path Tracer Null");
        app.beginUndoGroup(undoGroup);

        forEachPath(function(comp, selectedLayer, path){
            var pathHierarchy = [];
            var pathPath = getPropPath(path, pathHierarchy);

            // Create tracer null
            var newNull = createNull(comp);
            newNull.moveBefore(selectedLayer);
            newNull.name = "Trace " + selectedLayer.name + ": " + path.parentProperty.name + " [" + pathHierarchy.join(".") + "]";
            newNull.label = 10;

            // Add expression-control effect
            var traceEffect = newNull.property("ADBE Effect Parade").addProperty("Pseudo/ADBE Trace Path");
            traceEffect.property("Pseudo/ADBE Trace Path-0002").setValue(true); // loop on
            traceEffect.property("Pseudo/ADBE Trace Path-0001").setValuesAtTimes([0,1],[0,100]);
            traceEffect.property("Pseudo/ADBE Trace Path-0001").expression =
                "if(thisProperty.propertyGroup(1)(\"Pseudo/ADBE Trace Path-0002\") == true && thisProperty.numKeys > 1){\r" +
                "   thisProperty.loopOut(\"cycle\");\r" +
                "} else {\r" +
                "   value;\r" +
                "}";

            // Position expression
            newNull.position.expression =
                "var pathLayer  = thisComp.layer(\"" + selectedLayer.name + "\");\r" +
                "var progress   = thisLayer.effect(\"Pseudo/ADBE Trace Path\")(\"Pseudo/ADBE Trace Path-0001\")/100;\r" +
                "var pathToTrace= pathLayer" + pathPath + ";\r" +
                "pathLayer.toComp(pathToTrace.pointOnPath(progress));";

            // Rotation expression
            newNull.rotation.expression =
                "var pathToTrace= thisComp.layer(\"" + selectedLayer.name + "\")" + pathPath + ";\r" +
                "var progress   = thisLayer.effect(\"Pseudo/ADBE Trace Path\")(\"Pseudo/ADBE Trace Path-0001\")/100;\r" +
                "var pathTan    = pathToTrace.tangentOnPath(progress);\r" +
                "radiansToDegrees(Math.atan2(pathTan[1], pathTan[0]));";
        });

        app.endUndoGroup();
    }

})(this);
