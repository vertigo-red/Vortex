const base = require("../../src/main/electron-builder.config.json");

module.exports = {
    ...base,
    productName: "Vortex",
    linux: {
        ...base.linux,
        target: ["dir"],
        executableName: "vortex",
        category: "Game",
    },
    // Windows runtime installers and NSIS resources do not belong in this package.
    extraResources: [{ from: "../../../locales", to: "locales" }],
    // The ELF loader cannot read companion libraries directly from app.asar.
    asarUnpack: [...base.asarUnpack, "**/*.so", "**/*.so.*"],
    npmRebuild: false,
    publish: null,
};
