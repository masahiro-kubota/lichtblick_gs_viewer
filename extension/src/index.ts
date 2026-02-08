import { ExtensionContext } from "@foxglove/extension";

import { initGaussianSplatPanel } from "./GaussianSplatPanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({
    name: "Gaussian Splat Viewer",
    initPanel: initGaussianSplatPanel,
  });
}
