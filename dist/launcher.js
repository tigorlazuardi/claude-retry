import { capturePane, inject } from "./zellij.js";
export function buildDeps() {
    return {
        capture: (id) => capturePane(id),
        inject: (id, text) => inject(id, text),
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
}
//# sourceMappingURL=launcher.js.map