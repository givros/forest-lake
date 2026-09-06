import * as THREE from 'three';
import { createWorld, type AlpineWorld } from './world/World';
import { createTraveler } from './actors/Traveler';
import { createUI } from './ui';
import { Input } from './core/Input';
import { TrailAudio } from './core/TrailAudio';
import { createLighting } from './core/Lighting';
import './style.css';

type Traveler = Awaited<ReturnType<typeof createTraveler>>;
const QA = new URLSearchParams(location.search).has('qa') || import.meta.env.DEV;
const mobile = matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && Math.min(innerWidth, innerHeight) < 900);
if (navigator.maxTouchPoints > 0) document.body.classList.add('has-touch');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(63, innerWidth / innerHeight, .1, 14000);
const audio = new TrailAudio();
let world: AlpineWorld;
let traveler: Traveler;
let input: Input;
let renderer: THREE.WebGLRenderer;
let ready = false, playing = false, paused = false, arrived = false;
const mode = 'bike';
let yaw = 0, pitch = .12, zoom = 6.2, heading = 0;
let speed = 0, ascent = 0, distance = 0, routeProgress = 0;
let elapsed = 0, updateHUD = 0, progressTime = 0, frameCount = 0, lastBlockToast = -20;
const position = new THREE.Vector3(), velocity = new THREE.Vector3();
const intended = new THREE.Vector3(), candidate = new THREE.Vector3();
const viewTarget = new THREE.Vector3(), cameraGoal = new THREE.Vector3();
const look = new THREE.Vector3(), oldPosition = new THREE.Vector3();
const routeLengths: number[] = [];
const frameSamples: number[] = [];
let totalRouteLength = 1;
const lighting = createLighting(scene, mobile);

const ui = createUI({
  onStart: () => start(),
  onPause: () => pause(true), onResume: () => pause(false),
  onRestart: () => restart(),
  onTravel: (destination: 'lake' | 'start') => travel(destination),
  onMute: (muted: boolean) => audio.setMuted(muted)
});

function start() {
  if (!ready) return;
  playing = true; paused = false; input.enabled = true;
  ui.setPaused(false); audio.setPaused(false); void audio.unlock();
}

function pause(value: boolean) {
  if (!ready || !playing) return;
  paused = value; input.enabled = !value; input.clear();
  velocity.set(0, 0, 0); speed = 0;
  ui.setPaused(value); audio.setPaused(value);
  if (!value) void audio.unlock();
}

function routeDirection(atStart = true) {
  const index = atStart ? 0 : Math.max(0, world.route.length - 15);
  const a = world.route[index], b = world.route[Math.min(index + 6, world.route.length - 1)];
  yaw = Math.atan2(b.x - a.x, b.z - a.z); heading = yaw;
}

function travel(destination: 'lake' | 'start') {
  if (!ready) return;
  input.clear(); velocity.set(0, 0, 0); speed = 0;
  position.copy(destination === 'lake' ? world.lakeArrival : world.start);
  position.y = world.getHeight(position.x, position.z);
  if (destination === 'lake') {
    yaw = Math.atan2(world.lakeCenter.x - position.x, world.lakeCenter.z - position.z);
    heading = yaw;
  } else routeDirection();
  traveler.root.position.copy(position); traveler.root.rotation.y = heading;
  setCamera(true); updateRouteProgress(); pushHUD();
  ui.showToast(destination === 'lake' ? 'Lac des Aiguilles · 2,300 m' : 'Back at the trailhead · 1,500 m');
  if (destination === 'lake') reachLake();
}

function restart() {
  if (!ready) return;
  arrived = false; ascent = 0; distance = 0; routeProgress = 0;
  pitch = .12; zoom = 6.2;
  travel('start'); start();
}

function reachLake() {
  if (arrived) return;
  arrived = true; ui.showArrival(); audio.cue();
}

function updateRouteProgress() {
  let best = Infinity, bestIndex = 0;
  for (let i = 0; i < world.route.length; i++) {
    const p = world.route[i];
    const d = (p.x-position.x)**2 + (p.z-position.z)**2 + (p.y-position.y)**2 * .6;
    if (d < best) { best = d; bestIndex = i; }
  }
  routeProgress = routeLengths[bestIndex] / totalRouteLength;
}

function pushHUD() {
  ui.update({ altitude: position.y + 1500, ascent, distance, speed,
    sprinting: !!input?.sprint && speed > .5, progress: routeProgress,
    heading: ((yaw * 180 / Math.PI) % 360 + 360) % 360 });
}

function canMove(x: number, z: number) {
  if (Math.abs(x) > 744 || Math.abs(z) > 744) return false;
  const height = world.getHeight(x, z);
  if (!Number.isFinite(height)) return false;
  const extension = world as AlpineWorld & { isWalkable?: (x: number,z: number) => boolean };
  if (extension.isWalkable && !extension.isWalkable(x, z)) return false;
  const delta = Math.hypot(x-position.x, z-position.z);
  if (delta > .0001 && Math.abs(height-position.y) / delta > 1.12) return false;
  return true;
}

function move(dt: number) {
  intended.set(input.forward * Math.sin(yaw) - input.side * Math.cos(yaw), 0,
    input.forward * Math.cos(yaw) + input.side * Math.sin(yaw));
  // Screen right is perpendicular to the camera's forward vector.
  if (intended.lengthSq() > 1) intended.normalize();
  const maximum = input.braking ? 0 : input.sprint ? 14 : 8.5;
  intended.multiplyScalar(maximum);
  velocity.lerp(intended, 1 - Math.exp(-dt * (input.braking ? 22 : 4.5)));
  if (velocity.lengthSq() < .0001) velocity.set(0, 0, 0);
  oldPosition.copy(position);
  candidate.copy(position).addScaledVector(velocity, dt);
  candidate.copy(world.resolveMovement(position, candidate));
  if (canMove(candidate.x, candidate.z)) {
    position.x = candidate.x; position.z = candidate.z;
  } else {
    if (canMove(candidate.x, position.z)) position.x = candidate.x;
    if (canMove(position.x, candidate.z)) position.z = candidate.z;
    if (elapsed-lastBlockToast > 8 && intended.lengthSq() > 1) {
      ui.showToast('Follow the trail around steep ground and water.'); lastBlockToast = elapsed;
    }
  }
  position.y = world.getHeight(position.x, position.z);
  const step = Math.hypot(position.x-oldPosition.x, position.z-oldPosition.z);
  speed = step / Math.max(.001, dt);
  const oldHeading = heading;
  if (step > .001) {
    distance += position.distanceTo(oldPosition);
    ascent += Math.max(0, position.y-oldPosition.y);
    const target = Math.atan2(position.x-oldPosition.x, position.z-oldPosition.z);
    const difference = Math.atan2(Math.sin(target-heading), Math.cos(target-heading));
    heading += difference * (1-Math.exp(-dt*9));
  }
  traveler.root.position.copy(position); traveler.root.rotation.y = heading;
  traveler.update(dt, speed, input.sprint, (heading-oldHeading)/Math.max(.001,dt));
  if (position.distanceTo(world.lakeArrival) < 18) reachLake();
  audio.update(dt, speed, position.y+1500);
}

function setCamera(snap = false, dt = 1 / 60) {
  const targetHeight = 1.3;
  viewTarget.copy(position); viewTarget.y += targetHeight;
  const radius = zoom + .1;
  cameraGoal.set(position.x - Math.sin(yaw) * Math.cos(pitch) * radius,
    viewTarget.y + Math.sin(pitch) * radius,
    position.z - Math.cos(yaw) * Math.cos(pitch) * radius);
  cameraGoal.y = Math.max(cameraGoal.y, world.getHeight(cameraGoal.x, cameraGoal.z) + .75);
  // Shorten the camera boom when the terrain crosses the line of sight.
  for (let i = 1; i < 12; i++) {
    candidate.lerpVectors(viewTarget, cameraGoal, i/12);
    if (world.getHeight(candidate.x, candidate.z) + .30 > candidate.y) {
      cameraGoal.lerpVectors(viewTarget, cameraGoal, Math.max(.16, (i-1)/12));
      cameraGoal.y = Math.max(cameraGoal.y, world.getHeight(cameraGoal.x,cameraGoal.z)+.75);
      break;
    }
  }
  if (snap) { camera.position.copy(cameraGoal); look.copy(viewTarget); }
  else { camera.position.lerp(cameraGoal, 1-Math.exp(-dt*8)); look.lerp(viewTarget, 1-Math.exp(-dt*12)); }
  camera.lookAt(look);
  const goalFov = 63 + Math.min(5, speed*.28);
  if (Math.abs(camera.fov-goalFov) > .015) { camera.fov = THREE.MathUtils.lerp(camera.fov, goalFov, 1-Math.exp(-dt*3)); camera.updateProjectionMatrix(); }
}

async function boot() {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: QA });
    renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1 : 1.5)); renderer.setSize(innerWidth, innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = !mobile; renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.id = 'game-canvas'; renderer.domElement.setAttribute('aria-label', 'Playable alpine cycling environment');
    document.body.prepend(renderer.domElement);
    input = new Input(renderer.domElement);
    input.attachTouchControls(ui.touchControls);
    input.onOrbit = (dx, dy) => { yaw -= dx*.0045; pitch = THREE.MathUtils.clamp(pitch+dy*.0035, -.12, 1.03); };
    input.onZoom = amount => { zoom = THREE.MathUtils.clamp(zoom+amount*.65, 3.5, 12); };
    input.onAction = code => {
      if (code === 'Escape') { if (playing) pause(!paused); return; }
      if (!playing || paused) return;
      if (code === 'KeyL') travel('lake');
      else if (code === 'Home') travel('start'); else if (code === 'KeyR') restart();
    };
    ui.setLoading(.06, 'Reading the alpine terrain');
    let loadProgress = .08;
    world = await createWorld(scene, label => { loadProgress = Math.min(.74, loadProgress + .08); ui.setLoading(loadProgress, label); }, mobile);
    ui.setLoading(.78, 'Preparing your mountain bike');
    traveler = await createTraveler(scene, label => ui.setLoading(.87, label));
    position.copy(world.start); position.y = world.getHeight(position.x, position.z);
    traveler.root.position.copy(position);
    routeDirection(); traveler.root.rotation.y = heading;
    routeLengths.push(0);
    for (let i = 1; i < world.route.length; i++) routeLengths.push(routeLengths[i-1] + world.route[i].distanceTo(world.route[i-1]));
    totalRouteLength = routeLengths[routeLengths.length-1];
    setCamera(true); lighting.update(position); world.update(0, position, camera);
    ui.setLoading(.95, 'Preparing the forest light');
    await renderer.compileAsync(scene, camera);
    ready = true; ui.setLoading(1, 'The trail is ready'); ui.setReady(); pushHUD();
    let last = performance.now();
    renderer.setAnimationLoop((time: number) => {
      const realDt = Math.max(0, (time-last)/1000); last = time;
      const dt = Math.min(realDt, .05); elapsed += dt;
      if (playing && !paused) move(dt); else traveler.update(dt, 0, false, 0);
      setCamera(false, dt); lighting.update(position);
      world.update(paused ? 0 : dt, position, camera);
      progressTime += dt; updateHUD += dt;
      if (progressTime > .3) { progressTime=0; updateRouteProgress(); }
      if (updateHUD > .12) { updateHUD=0; pushHUD(); }
      renderer.render(scene, camera); frameCount++;
      if (QA && frameCount % 3 === 0 && realDt < 2) { frameSamples.push(realDt*1000); if (frameSamples.length>500) frameSamples.shift(); }
    });
    addEventListener('resize', () => {
      camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth,innerHeight);
    });
    addEventListener('blur', () => { if (playing && !paused) pause(true); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && playing && !paused) pause(true); });
    renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault(); pause(true); ui.setError('The graphics connection was interrupted. Reload to return to the trail.');
    });
    if (QA) Object.defineProperty(window, '__FOREST_LAKE__', { value: {
      getState: () => ({ ready, playing, paused, arrived, mode, position:position.toArray(),
        altitude:position.y+1500, speed, ascent, distance, routeProgress, totalRouteLength,
        camera:camera.position.toArray(), heading, cameraYaw:yaw, cameraPitch:pitch, cameraZoom:zoom,
        input:{forward:input.forward,side:input.side,boost:input.sprint,brake:input.braking}, mobile,
        ground:world.getHeight(position.x,position.z), waterLevel:world.waterLevel,
        start:world.start.toArray(), lake:world.lakeArrival.toArray(),
        render:{calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,
          geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures},
        frameSamples:[...frameSamples] })
    }, configurable: true });
  } catch (error) {
    console.error(error);
    ui.setError(error instanceof Error ? `Unable to open the trail: ${error.message}` : 'Unable to open the trail. Reload to try again.');
  }
}
void boot();
