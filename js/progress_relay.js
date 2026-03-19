import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

app.registerExtension({
    name: "PSBridge.ProgressRelay",
    setup() {
        // Listen for queue signal from PS plugin (via bridge server)
        api.addEventListener("ps_bridge_queue", () => {
            console.log("[PS Bridge] Queue signal received, queueing prompt...");
            app.queuePrompt(0, 1);
        });

        // Relay progress updates to bridge server -> PS plugin
        api.addEventListener("progress", ({ detail }) => {
            if (!detail) return;
            fetch("/ps-bridge/progress", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ value: detail.value, max: detail.max })
            }).catch(() => {});
        });

        // Execution started
        api.addEventListener("execution_start", () => {
            fetch("/ps-bridge/status", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "executing" })
            }).catch(() => {});
        });

        // Execution finished (detail is null when all nodes done)
        api.addEventListener("executing", ({ detail }) => {
            if (!detail) {
                fetch("/ps-bridge/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ status: "complete" })
                }).catch(() => {});
            }
        });

        // Execution error
        api.addEventListener("execution_error", ({ detail }) => {
            fetch("/ps-bridge/status", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    status: "error",
                    error: detail?.exception_message || "Unknown error"
                })
            }).catch(() => {});
        });
    }
});
