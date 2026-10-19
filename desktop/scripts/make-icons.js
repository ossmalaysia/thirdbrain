// Renders the tray icons (16 px and 32 px for high DPI) from assets/icon.png, the portal's icon.
// Run once after the icon changes: bun run icons
const { app, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.whenReady().then(() => {
  const assets = path.join(__dirname, "..", "assets");
  const icon = nativeImage.createFromPath(path.join(assets, "icon.png"));
  for (const [name, size] of [["tray.png", 16], ["tray@2x.png", 32]]) {
    fs.writeFileSync(path.join(assets, name), icon.resize({ width: size, height: size, quality: "best" }).toPNG());
  }
  app.quit();
});
