# Forest / Lake

A desktop browser adaptation of the Alpine Hike environment. Follow a 3.9 km mountain trail from the woods at 1,500 m to Lac des Aiguilles at 2,300 m, with about 813 m of cumulative ascent.

Explore in third person on foot, by mountain bike, or on horseback. The browser edition uses Three.js, a preserved terrain heightfield, animated characters, and compact local assets.

## Controls

| Action | Control |
| --- | --- |
| Move | WASD / ZQSD / arrow keys |
| Run, pedal faster, or gallop | Hold Shift |
| Rotate the camera | Drag on the scene |
| Zoom | Mouse wheel |
| Walk / bike / horse | 1 / 2 / 3 |
| Travel to the lake | L |
| Return to the trailhead | Home |
| Pause / resume | Escape |
| Restart the hike | R |

The interface also has buttons for travel modes, fast travel, sound, and pause. Fast travel preserves the distance and ascent you actually covered.

## Run locally

Requires Node.js 22.12 or newer and a desktop browser with WebGL 2.

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

- Horse: [Quaternius, Ultimate Animated Animal Pack](https://quaternius.com/packs/ultimateanimatedanimals.html), CC0; adapted with original saddle and riding equipment.
- Conifers, rocks, and photographic terrain/plant textures: [Poly Haven](https://polyhaven.com/), CC0. Individual sources are listed in the asset credit files.
- Hiker, bicycle, trail furniture, terrain design, and character animation additions: original project assets.
- DM Sans and Libre Caslon Display fonts: SIL Open Font License 1.1, included with the fonts.

Detailed credits: [models](public/assets/models/credits.json), [terrain and plants](public/assets/world/credits.json), [fonts](public/assets/fonts/font-sources.json).
