# Forest / Lake

A mountain-bike adventure for desktop and mobile browsers, adapted from the Alpine Hike environment. Follow a 3.9 km mountain trail from the woods at 1,500 m to Lac des Aiguilles at 2,300 m, with about 813 m of cumulative ascent.

Explore in third person on your mountain bike. The browser edition uses Three.js, a preserved terrain heightfield, an animated cyclist, and compact local assets.

## Controls

| Action | Control |
| --- | --- |
| Move | WASD / ZQSD / arrow keys |
| Pedal faster | Hold Shift |
| Brake | Hold Space |
| Rotate the camera | Drag on the scene |
| Zoom | Mouse wheel |
| Travel to the lake | L |
| Return to the trailhead | Home |
| Pause / resume | Escape |
| Restart the ride | R |

On touchscreens, use the left joystick to move, hold **Boost** to pedal faster, and hold **Brake** to stop. Drag on the scenery to turn the camera; pinch with two fingers to zoom. The interface adapts to portrait and landscape orientations, with fast travel available from the pause menu.

Fast travel preserves the distance and ascent you actually covered. Mobile rendering uses fewer nearby details and a capped resolution to reduce graphics load while keeping the complete trail and surrounding mountains.

## Run locally

Requires Node.js 22.12 or newer and a browser with WebGL 2.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5188/forest-lake/`.

```sh
npm test
npm run verify:assets
npm run build
npm run preview
```

The production preview is available at `http://127.0.0.1:4188/forest-lake/`.

## Asset credits

- Conifers, rocks, and photographic terrain/plant textures: [Poly Haven](https://polyhaven.com/), CC0. Individual sources are listed in the asset credit files.
- Hiker, bicycle, trail furniture, terrain design, and character animation additions: original project assets.
- DM Sans and Libre Caslon Display fonts: SIL Open Font License 1.1, included with the fonts.

Detailed credits: [models](public/assets/models/credits.json), [terrain and plants](public/assets/world/credits.json), [fonts](public/assets/fonts/font-sources.json).
