import { type ProfileWrite } from "../src/profiles.js";

export function exampleProfile(name = "Daily drive"): ProfileWrite {
  return {
    schemaVersion: 5,
    name,
    settings: {
      clock: { style: "digital", sizePercent: 112.5 },
      positions: { clock: { x: 24, y: 80 }, shortcuts: { x: 0, y: 240 }, actions: null },
      sectionSizes: { clock: null, shortcuts: { width: 320, height: 120 } },
      musicLayouts: {
        local: { position: { x: 24, y: 400 }, size: { width: 320, height: 120 } },
        radio: { position: { x: 0, y: 240 }, size: null },
        spotify: { position: null, size: { width: 360, height: 142 } },
      },
      showShortcuts: false,
      hideStatusBar: true,
      useSteeringWheelButtons: true,
      musicMode: "none",
      radio: { serverUrl: "https://radio.example.com/stream?station=jazz", autoplay: true, width: 360, height: 126 },
      spotify: { clientId: null, playbackUri: null, autoConnect: true, width: 360, height: 142, maxTitleLines: 2 },
      background: { type: "dark" },
    },
  };
}
