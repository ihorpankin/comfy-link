const { app, core } = require("photoshop");
const { executeAsModal } = core;
const { batchPlay } = require("photoshop").action;
const fs = require("uxp").storage.localFileSystem;

// ─── State ───
let serverUrl = localStorage.getItem("ps_bridge_url") || "";
let currentMode = "mask"; // "mask" or "crop"
let ws = null;
let isGenerating = false;
let selectionBounds = null;
let pendingResult = null; // { base64, width, height, selectionBounds, mode }

// ─── DOM ───
const connDot = document.getElementById("connDot");
const connLabel = document.getElementById("connLabel");
const settingsBtn = document.getElementById("settingsBtn");
const settingsDialog = document.getElementById("settingsDialog");
const serverUrlInput = document.getElementById("serverUrl");
const saveBtn = document.getElementById("saveBtn");
const cancelBtn = document.getElementById("cancelBtn");
const testBtn = document.getElementById("testBtn");
const testResult = document.getElementById("testResult");
const generateBtn = document.getElementById("generateBtn");
const progressSection = document.getElementById("progressSection");
const progressBar = document.getElementById("progressBar");
const statusLabel = document.getElementById("statusLabel");
const modeMask = document.getElementById("modeMask");
const modeCrop = document.getElementById("modeCrop");
const previewSection = document.getElementById("previewSection");
const previewImage = document.getElementById("previewImage");
const dismissPreview = document.getElementById("dismissPreview");

// ─── Settings ───
settingsBtn.addEventListener("click", () => {
    serverUrlInput.value = serverUrl;
    testResult.textContent = "";
    testResult.className = "test-result";
    settingsDialog.showModal();
});

cancelBtn.addEventListener("click", () => {
    settingsDialog.close();
});

saveBtn.addEventListener("click", () => {
    serverUrl = serverUrlInput.value.replace(/\/+$/, "");
    localStorage.setItem("ps_bridge_url", serverUrl);
    settingsDialog.close();
    connectWebSocket();
});

testBtn.addEventListener("click", async () => {
    const url = serverUrlInput.value.replace(/\/+$/, "");
    testResult.textContent = "Testing...";
    testResult.className = "test-result";
    try {
        const resp = await fetch(`${url}/ps-bridge/ping`);
        if (resp.ok) {
            testResult.textContent = "Connected successfully!";
            testResult.className = "test-result success";
        } else {
            testResult.textContent = `Error: HTTP ${resp.status}`;
            testResult.className = "test-result error";
        }
    } catch (e) {
        testResult.textContent = `Failed: ${e.message}`;
        testResult.className = "test-result error";
    }
});

// ─── Mode Toggle ───
modeMask.addEventListener("click", () => {
    currentMode = "mask";
    modeMask.setAttribute("selected", "");
    modeCrop.removeAttribute("selected");
});

modeCrop.addEventListener("click", () => {
    currentMode = "crop";
    modeCrop.setAttribute("selected", "");
    modeMask.removeAttribute("selected");
});

// ─── Preview Actions ───
dismissPreview.addEventListener("click", () => {
    clearPreview();
});

previewImage.addEventListener("click", async () => {
    await applyResultToCanvas();
});

// ─── WebSocket ───
function connectWebSocket() {
    if (ws) {
        ws.close();
        ws = null;
    }

    if (!serverUrl) {
        updateConnection(false);
        return;
    }

    const wsProto = serverUrl.startsWith("https") ? "wss" : "ws";
    const host = serverUrl.replace(/^https?:\/\//, "");
    const wsUrl = `${wsProto}://${host}/ps-bridge/ws`;

    try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            updateConnection(true);
            if (ws._pingInterval) clearInterval(ws._pingInterval);
            ws._pingInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "ping" }));
                }
            }, 30000);
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleWsMessage(msg);
            } catch (e) {
                console.error("[PS Bridge] WS parse error:", e);
            }
        };

        ws.onclose = () => {
            updateConnection(false);
            if (ws && ws._pingInterval) clearInterval(ws._pingInterval);
            setTimeout(() => {
                if (serverUrl && (!ws || ws.readyState === WebSocket.CLOSED)) {
                    connectWebSocket();
                }
            }, 5000);
        };

        ws.onerror = (err) => {
            console.error("[PS Bridge] WS error:", err);
        };
    } catch (e) {
        console.error("[PS Bridge] WS connection failed:", e);
        updateConnection(false);
    }
}

function updateConnection(connected) {
    connDot.className = connected ? "dot connected" : "dot";
    connLabel.textContent = connected ? "Connected" : "Disconnected";
}

function handleWsMessage(msg) {
    switch (msg.type) {
        case "progress":
            showProgress(msg.value);
            break;
        case "status":
            handleStatus(msg.status, msg.error);
            break;
        case "result":
            handleResult(msg);
            break;
        case "pong":
            break;
    }
}

// ─── Progress UI ───
function showProgress(value) {
    progressSection.hidden = false;
    progressBar.value = value;
    statusLabel.textContent = `Generating... ${value}%`;
}

function handleStatus(status, error) {
    switch (status) {
        case "executing":
            progressSection.hidden = false;
            progressBar.value = 0;
            statusLabel.textContent = "Starting...";
            break;
        case "complete":
            statusLabel.textContent = "Complete!";
            progressBar.value = 100;
            setTimeout(() => {
                progressSection.hidden = true;
                progressBar.value = 0;
                isGenerating = false;
                generateBtn.disabled = false;
                generateBtn.textContent = "Generate";
            }, 1500);
            break;
        case "error":
            statusLabel.textContent = `Error: ${error || "Unknown"}`;
            progressBar.value = 0;
            isGenerating = false;
            generateBtn.disabled = false;
            generateBtn.textContent = "Generate";
            break;
    }
}

// ─── Generate ───
generateBtn.addEventListener("click", async () => {
    if (isGenerating || !serverUrl) return;
    if (!app.activeDocument) {
        statusLabel.textContent = "No document open";
        progressSection.hidden = false;
        return;
    }

    isGenerating = true;
    generateBtn.disabled = true;
    generateBtn.textContent = "Generating...";
    clearPreview();

    try {
        let imageData;
        await executeAsModal(async () => {
            imageData = await captureImageData();
            if (!imageData) {
                throw new Error("Failed to capture image data");
            }
        }, { commandName: "Capture image for ComfyUI" });

        await uploadToComfyUI(imageData);
        await queueWorkflow();
    } catch (e) {
        console.error("[PS Bridge] Generate error:", e);
        statusLabel.textContent = `Error: ${e?.message || e?.description || String(e) || "Unknown error"}`;
        progressSection.hidden = false;
        isGenerating = false;
        generateBtn.disabled = false;
        generateBtn.textContent = "Generate";
    }
});

// ─── Capture Image Data ───
async function captureImageData() {
    const doc = app.activeDocument;
    const docWidth = doc.width;
    const docHeight = doc.height;

    // Always save the full canvas as PNG
    const imageBytes = await saveDocAsPng();

    // Check for active selection
    let hasSelection = false;
    let bounds = null;
    try {
        const selInfo = await batchPlay([{
            _obj: "get",
            _target: [{ _property: "selection" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
        }], { synchronousExecution: true });

        if (selInfo[0] && selInfo[0].selection) {
            hasSelection = true;
            const sel = selInfo[0].selection;
            bounds = {
                left: Math.round(sel.left._value),
                top: Math.round(sel.top._value),
                right: Math.round(sel.right._value),
                bottom: Math.round(sel.bottom._value)
            };
        }
    } catch (e) {
        // No selection — that's fine
    }

    let maskBytes;
    let sendWidth = docWidth;
    let sendHeight = docHeight;

    if (currentMode === "crop" && hasSelection && bounds) {
        // Crop mode: send full canvas + bounds. Server/node will crop.
        selectionBounds = bounds;
        sendWidth = docWidth;
        sendHeight = docHeight;
        // White mask for the entire canvas (no masking, just crop via bounds)
        maskBytes = createSolidMask(docWidth, docHeight, 255);
    } else {
        // Mask mode: send full canvas + selection as mask
        if (hasSelection) {
            selectionBounds = bounds;
            maskBytes = createSelectionBoundsMask(docWidth, docHeight, bounds);
        } else {
            selectionBounds = null;
            maskBytes = createSolidMask(docWidth, docHeight, 255);
        }
    }

    return { image: imageBytes, mask: maskBytes, width: sendWidth, height: sendHeight };
}

async function saveDocAsPng() {
    const tempFolder = await fs.getTemporaryFolder();
    const tempFile = await tempFolder.createFile("ps_bridge_temp.png", { overwrite: true });
    const token = fs.createSessionToken(tempFile);

    await batchPlay([{
        _obj: "save",
        as: {
            _obj: "PNGFormat",
            PNGInterlaceType: { _enum: "PNGInterlaceType", _value: "PNGInterlaceNone" },
            compression: 6
        },
        in: { _path: token, _kind: "local" },
        copy: true,
        lowerCase: true,
        saveStage: { _enum: "saveStageType", _value: "saveBegin" }
    }], { synchronousExecution: true });

    const data = await tempFile.read({ format: require("uxp").storage.formats.binary });
    return data;
}

function createSolidMask(width, height, value) {
    const size = width * height;
    const buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer);
    view.fill(value);
    return buffer;
}

function createSelectionBoundsMask(width, height, bounds) {
    const size = width * height;
    const buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer);
    // Black everywhere (masked out)
    view.fill(0);
    // White inside selection (visible area)
    for (let y = bounds.top; y < bounds.bottom && y < height; y++) {
        for (let x = bounds.left; x < bounds.right && x < width; x++) {
            view[y * width + x] = 255;
        }
    }
    return buffer;
}

// ─── Upload to ComfyUI ───
async function uploadToComfyUI(data) {
    const formData = new FormData();

    const imageBlob = new Blob([data.image], { type: "image/png" });
    formData.append("image", imageBlob, "canvas.png");

    const maskBlob = new Blob([data.mask], { type: "application/octet-stream" });
    formData.append("mask", maskBlob, "mask.raw");

    formData.append("width", String(data.width));
    formData.append("height", String(data.height));
    formData.append("mode", currentMode);

    // Send crop bounds if in crop mode
    if (selectionBounds) {
        formData.append("crop_bounds", JSON.stringify(selectionBounds));
    }

    const resp = await fetch(`${serverUrl}/ps-bridge/upload`, {
        method: "POST",
        body: formData
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Upload failed: ${resp.status} ${text}`);
    }

    return resp.json();
}

// ─── Queue Workflow ───
async function queueWorkflow() {
    const resp = await fetch(`${serverUrl}/ps-bridge/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
    });

    if (!resp.ok) {
        throw new Error(`Queue failed: ${resp.status}`);
    }
}

// ─── Handle Result (show preview) ───
function handleResult(msg) {
    pendingResult = {
        base64: msg.image,
        width: msg.width,
        height: msg.height,
        selectionBounds: selectionBounds ? { ...selectionBounds } : null,
        mode: currentMode
    };

    previewImage.src = `data:image/png;base64,${msg.image}`;
    previewSection.hidden = false;
    progressSection.hidden = true;
    isGenerating = false;
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate";
}

// ─── Apply Result to Canvas ───
async function applyResultToCanvas() {
    if (!pendingResult) return;
    if (!app.activeDocument) {
        statusLabel.textContent = "No document open";
        progressSection.hidden = false;
        return;
    }

    const result = pendingResult;

    try {
        await executeAsModal(async () => {
            const binaryStr = atob(result.base64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
            }

            const tempFolder = await fs.getTemporaryFolder();
            const tempFile = await tempFolder.createFile("ps_bridge_result.png", { overwrite: true });
            await tempFile.write(bytes.buffer, { format: require("uxp").storage.formats.binary });
            const token = fs.createSessionToken(tempFile);

            // Place as smart object (not rasterized)
            await batchPlay([{
                _obj: "placeEvent",
                null: { _path: token, _kind: "local" },
                freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
                linked: true
            }], { synchronousExecution: true });

            // Scale and position to match selection bounds
            if (result.selectionBounds) {
                const sb = result.selectionBounds;
                const targetW = sb.right - sb.left;
                const targetH = sb.bottom - sb.top;

                // Get current layer bounds after placement
                const boundsResult = await batchPlay([{
                    _obj: "get",
                    _target: [
                        { _property: "bounds" },
                        { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }
                    ]
                }], { synchronousExecution: true });

                const lb = boundsResult[0].bounds;
                const curW = lb.right._value - lb.left._value;
                const curH = lb.bottom._value - lb.top._value;

                // Scale from center to match selection size
                const scaleX = (targetW / curW) * 100;
                const scaleY = (targetH / curH) * 100;

                await batchPlay([{
                    _obj: "transform",
                    _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                    freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
                    width: { _unit: "percentUnit", _value: scaleX },
                    height: { _unit: "percentUnit", _value: scaleY }
                }], { synchronousExecution: true });

                // Query actual bounds after transform (no rounding guesswork)
                const postBounds = await batchPlay([{
                    _obj: "get",
                    _target: [
                        { _property: "bounds" },
                        { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }
                    ]
                }], { synchronousExecution: true });

                const nb = postBounds[0].bounds;
                const deltaX = Math.round(sb.left - nb.left._value);
                const deltaY = Math.round(sb.top - nb.top._value);

                if (deltaX !== 0 || deltaY !== 0) {
                    await batchPlay([{
                        _obj: "move",
                        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                        to: {
                            _obj: "offset",
                            horizontal: { _unit: "pixelsUnit", _value: deltaX },
                            vertical: { _unit: "pixelsUnit", _value: deltaY }
                        }
                    }], { synchronousExecution: true });
                }

                // Restore selection
                await batchPlay([{
                    _obj: "set",
                    _target: [{ _ref: "channel", _property: "selection" }],
                    to: {
                        _obj: "rectangle",
                        top: { _unit: "pixelsUnit", _value: sb.top },
                        left: { _unit: "pixelsUnit", _value: sb.left },
                        bottom: { _unit: "pixelsUnit", _value: sb.bottom },
                        right: { _unit: "pixelsUnit", _value: sb.right }
                    }
                }], { synchronousExecution: true });
            }

        }, { commandName: "Place ComfyUI Result" });

    } catch (e) {
        console.error("[PS Bridge] Result placement error:", e);
        statusLabel.textContent = `Error placing result: ${e?.message || e?.description || String(e) || "Unknown error"}`;
        progressSection.hidden = false;
    }
}

// ─── Clear Preview ───
function clearPreview() {
    pendingResult = null;
    previewImage.src = "";
    previewSection.hidden = true;
}

// ─── Init ───
if (serverUrl) {
    connectWebSocket();
}
