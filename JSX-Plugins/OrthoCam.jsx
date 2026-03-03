// OrthoCam v1.1 — After Effects Camera Rig Generator
// Adds a named camera + parented control null for any standard viewing angle.

var CAMERA_CONFIGS = [
    { camera_name: "Front Camera",      null_name: "Front Camera Control",      rx: 0,      ry: 0,      rz: 0      },
    { camera_name: "Left Camera",       null_name: "Left Camera Control",       rx: 0,      ry: 90,     rz: 0      },
    { camera_name: "Right Camera",      null_name: "Right Camera Control",      rx: 0,      ry: -90,    rz: 0      },
    { camera_name: "Top Camera",        null_name: "Top Camera Control",        rx: -90,    ry: 0,      rz: 0      },
    { camera_name: "Back Camera",       null_name: "Back Camera Control",       rx: 180,    ry: 0,      rz: 180    },
    { camera_name: "Bottom Camera",     null_name: "Bottom Camera Control",     rx: 90,     ry: 0,      rz: 0      },
    { camera_name: "Isometric Camera",  null_name: "Isometric Camera Control",  rx: 35.264, ry: 35.264, rz: 35.264 }
];

// ------------------------------------------------------------

function orthocam(thisObj) {

    function build_ui(thisObj) {
        var panel = thisObj instanceof Panel
            ? thisObj
            : new Window("palette", "OrthoCam.", undefined, { resizeable: true });

        var res = "group{\
                        orientation:'column', alignment:['fill','fill'], alignChildren:['fill','fill'],\
                        preferredSize:[260,80],\
                        dropPanel: Panel{\
                            text:'Choose Camera Position', orientation:'column',\
                            alignChildren:['fill','top'], margins:[10,10,10,10],\
                            camera_choice: DropDownList{properties:{items:[\
                                'Front Camera','Left Camera','Right Camera','Top Camera',\
                                'Back Camera','Bottom Camera','Isometric Camera'\
                            ]}},\
                            add_btn: Button{text:'Add Camera', preferredSize:[-1,30]},\
                        },\
                   }";

        panel.grp = panel.add(res);
        panel.layout.layout(true);
        panel.grp.minimumSize = panel.grp.size;

        // Default to Front Camera so the panel is ready to use immediately
        panel.grp.dropPanel.camera_choice.selection = 0;

        // onResize is only meaningful for floating windows; when docked as a Panel
        // the host application owns the resize lifecycle
        if (panel instanceof Window) {
            panel.onResizing = panel.onResize = function () {
                panel.layout.resize();
            };
        }

        panel.grp.dropPanel.add_btn.onClick = function () {
            var selection = panel.grp.dropPanel.camera_choice.selection;
            if (selection !== null) {
                create_camera(selection.index);
            } else {
                alert("Please select a camera from the drop down list.", "No Camera Selected");
            }
        };

        return panel;
    }

    var pal = build_ui(thisObj);
    if (pal instanceof Window) {
        pal.center();
        pal.show();
    }
}

// ------------------------------------------------------------

function create_camera(index) {
    var comp = app.project.activeItem;
    if (!comp || !(comp instanceof CompItem)) {
        alert("Please select a composition.", "No Composition Selected");
        return;
    }

    var config = CAMERA_CONFIGS[index];
    if (!config) {
        alert("Unknown camera type.", "Error");
        return;
    }

    // Prompt before stacking a duplicate rig
    if (find_layer_by_name(comp, config.camera_name)) {
        var proceed = confirm(
            "\"" + config.camera_name + "\" already exists in this composition.\nAdd another one anyway?",
            false,
            "Duplicate Camera"
        );
        if (!proceed) return;
    }

    app.beginUndoGroup("Add " + config.camera_name);

    try {
        var cx = comp.width  / 2;
        var cy = comp.height / 2;

        var camera = comp.layers.addCamera(config.camera_name, [cx, cy]);

        var ctrl = comp.layers.addNull();
        ctrl.name        = config.null_name;
        ctrl.threeDLayer = true;
        ctrl.label       = 8; // Blue — visually pairs the rig layers in the timeline

        // Match names are locale- and version-invariant; display names like
        // "Position" or "Zoom" can differ across languages and AE releases
        ctrl.property("ADBE Transform Group").property("ADBE Position").setValue([cx, cy, 0]);

        camera.setParentWithJump(ctrl);
        camera.label = 8;
        camera.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0, -5000]);
        camera.property("ADBE Camera Options Group").property("ADBE Camera Zoom").setValue(5000);

        ctrl.property("ADBE Transform Group").property("ADBE Rotate X").setValue(config.rx);
        ctrl.property("ADBE Transform Group").property("ADBE Rotate Y").setValue(config.ry);
        ctrl.property("ADBE Transform Group").property("ADBE Rotate Z").setValue(config.rz);

        // Keep null immediately above its camera in the layer stack
        ctrl.moveBefore(camera);

    } catch (e) {
        alert("Failed to create camera rig:\n" + e.toString(), "Error");
    }

    app.endUndoGroup();
}

// ------------------------------------------------------------

function find_layer_by_name(comp, name) {
    for (var i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === name) return comp.layer(i);
    }
    return null;
}

// ------------------------------------------------------------

orthocam(this);