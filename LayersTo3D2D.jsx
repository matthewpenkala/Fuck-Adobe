function makeLayers3DOr2D(whichD) {
	var activeComp = app.project.activeItem;

	if (activeComp && activeComp instanceof CompItem) {
		app.beginUndoGroup("Make All Layers 3D");

		for (var i = 1; i <= activeComp.numLayers; i++) {
			var workingLayer = activeComp.layer(i);

			if (
				workingLayer.canSetEnabled &&
				workingLayer.threeDLayer !== undefined
			) {
				if (whichD === "threeD") {
					if (workingLayer.name.startsWith("2d_")) {
						continue;
					}
					workingLayer.threeDLayer = true;
				} else if (whichD === "twoD") {
					if (workingLayer.name.startsWith("3d_")) {
						continue;
					}
					workingLayer.threeDLayer = false;
				}
			}
		}

		app.endUndoGroup();
	} else {
		alert("No Comp Found!");
	}
}

function renameD(whichD) {
	var activeComp = app.project.activeItem;
	var selectedLayers = activeComp.selectedLayers;

	if (activeComp && activeComp instanceof CompItem) {
		app.beginUndoGroup("Rename Layers");
		if (selectedLayers.length > 0) {
			for (var i = 0; i < selectedLayers.length; i++) {
				if (whichD === "threeD") {
					if (
						!selectedLayers[i].name.startsWith("3d_") &&
						!selectedLayers[i].name.startsWith("2d_")
					) {
						selectedLayers[i].name = "3d_" + selectedLayers[i].name;
					} else if (selectedLayers[i].name.startsWith("2d_")) {
						selectedLayers[i].name =
							"3d_" + selectedLayers[i].name.slice(3);
					}
					selectedLayers[i].threeDLayer = true;
				} else if (whichD === "twoD") {
					if (
						!selectedLayers[i].name.startsWith("3d_") &&
						!selectedLayers[i].name.startsWith("2d_")
					) {
						selectedLayers[i].name = "2d_" + selectedLayers[i].name;
					} else if (selectedLayers[i].name.startsWith("3d_")) {
						selectedLayers[i].name =
							"2d_" + selectedLayers[i].name.slice(3);
					}
					selectedLayers[i].threeDLayer = false;
				}
			}
		} else {
			alert("No Layer is selected!");
		}
		app.endUndoGroup();
	} else {
		alert("No active comp found!");
	}
}

function createUI(thisObj) {
	var myPanel =
		thisObj instanceof Panel
			? thisObj
			: new Window("palette", "Make All Layers 3D", [0, 0, 200, 60], {
					resizeable: true,
			  });

	var myButtonGroup = myPanel.add("group");
	myButtonGroup.spacing = 4;
	myButtonGroup.margins = 0;
	myButtonGroup.orientation = "row";
	myButtonGroup.alignment = "left";
	myButtonGroup.alignChildren = "center";

	myPanel.threeDButton = myButtonGroup.add("button", undefined, "All 3D");
	myPanel.twoDButton = myButtonGroup.add("button", undefined, "All 2D");
	myPanel.renameThreeDButton = myButtonGroup.add(
		"button",
		undefined,
		"Re 3D"
	);
	myPanel.renameTwoDButton = myButtonGroup.add("button", undefined, "Re 2D");

	myPanel.threeDButton.onClick = function () {
		makeLayers3DOr2D("threeD");
	};
	myPanel.twoDButton.onClick = function () {
		makeLayers3DOr2D("twoD");
	};
	myPanel.renameThreeDButton.onClick = function () {
		renameD("threeD");
	};
	myPanel.renameTwoDButton.onClick = function () {
		renameD("twoD");
	};

	myPanel.layout.layout(true);
	myPanel.layout.resize();

	return myPanel;
}

var myScriptPanel = createUI(this);

if (myScriptPanel instanceof Window) {
	myScriptPanel.center();
	myScriptPanel.show();
}
