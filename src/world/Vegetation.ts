import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Heightfield, modelURL, worldURL } from './Heightfield';

type Tree = { x: number; y: number; z: number; sx: number; sy: number; sz: number;
  yaw: number; species: number; index: number; farIndex: number };
type Placement = { x: number; y: number; z: number; sx: number; sy: number; sz: number; yaw: number };
type Pool = { meshes: THREE.InstancedMesh[]; capacity: number };

const hash = (x: number, z: number, salt = 0): number => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(salt + 93, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export class Vegetation {
  readonly root = new THREE.Group();
  readonly trees: Tree[] = [];
  private rocks: Placement[] = [];
  private nativeTreeHash = new Map<string, Tree[]>();
  private nearbyTreeHash = new Map<string, Tree[]>();
  private farMeshes: THREE.InstancedMesh[] = [];
  private farVisibility: THREE.InstancedBufferAttribute[] = [];
  private closePools: Pool[] = [];
  private rockPool?: Pool;
  private propPools = new Map<string, Pool>();
  private grass?: THREE.InstancedMesh;
  private blades?: THREE.InstancedMesh;
  private ferns?: THREE.InstancedMesh;
  private shrubs?: THREE.InstancedMesh;
  private flowers?: THREE.InstancedMesh;
  private textures = new Set<THREE.Texture>();
  private importedMaterials = new Set<THREE.Material>();
  private clock = { value: 0 };
  private previousCenter = new THREE.Vector3(Infinity, 0, 0);
  private previousGround = new THREE.Vector3(Infinity, 0, 0);
  private previousNearTrees: Tree[] = [];
  private matrix = new THREE.Matrix4();
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(private field: Heightfield, forest: Float32Array, rockData: Float32Array) {
    this.root.name = 'Alpine woodland, meadow plants and trail furniture';
    const variantCounts = [0, 0, 0];
    for (let i = 0; i < forest.length; i += 8) {
      const species = Math.round(forest[i + 7]);
      const t: Tree = { x: forest[i], y: forest[i + 1], z: forest[i + 2],
        sx: forest[i + 3], sy: forest[i + 4], sz: forest[i + 5], yaw: forest[i + 6],
        species, index: i / 8, farIndex: variantCounts[species]++ };
      this.trees.push(t);
      const key = `${Math.floor(t.x / 64)},${Math.floor(t.z / 64)}`;
      if (!this.nearbyTreeHash.has(key)) this.nearbyTreeHash.set(key, []);
      this.nearbyTreeHash.get(key)!.push(t);
      if (Math.max(Math.abs(t.x), Math.abs(t.z)) < 756) {
        const collisionKey = `${Math.floor(t.x / 8)},${Math.floor(t.z / 8)}`;
        if (!this.nativeTreeHash.has(collisionKey)) this.nativeTreeHash.set(collisionKey, []);
        this.nativeTreeHash.get(collisionKey)!.push(t);
      }
    }
    for (let i = 0; i < rockData.length; i += 7) this.rocks.push({ x: rockData[i], y: rockData[i + 1],
      z: rockData[i + 2], sx: rockData[i + 3], sy: rockData[i + 4], sz: rockData[i + 5], yaw: rockData[i + 6] });
    // Moraine stones use the same CC0 boulder as the lower trail. Placement
    // follows actual dry ground, including the raised shoreline trail bench.
    for (let i = 0; i < 180; i++) {
      const a = i * 2.399963, r = .97 + hash(i, 91) * .38;
      const x = 300 + Math.cos(a) * 170 * r, z = -350 - Math.sin(a) * 108 * r;
      const y = field.getHeight(x, z);
      if (y < 800.35 || field.getRoadDistance(x, z) < 2.3 || field.getSlope(x, z) > .9) continue;
      const size = .36 + hash(i, 102) ** 2 * .82;
      this.rocks.push({ x, y: y - .10 * size, z, sx: size, sy: size * (.67 + hash(i, 113) * .36),
        sz: size * (.85 + hash(i, 121) * .4), yaw: a });
    }
  }

  private async loadPool(name: string, capacity: number, castShadow: boolean): Promise<Pool> {
    const gltf = await new GLTFLoader().loadAsync(modelURL(`${name}.glb`));
    gltf.scene.updateMatrixWorld(true);
    const meshes: THREE.InstancedMesh[] = [];
    gltf.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
      const materials = (Array.isArray(o.material) ? o.material : [o.material]).map((source) => {
        const material = source.clone();
        if (material instanceof THREE.MeshStandardMaterial) {
          material.envMapIntensity = .24;
          if (material.alphaMap || material.alphaTest > 0 || material.transparent) {
            material.transparent = false; material.alphaTest = .38; material.side = THREE.DoubleSide;
            material.alphaToCoverage = true;
          }
          for (const v of Object.values(material)) if (v instanceof THREE.Texture) {
            v.anisotropy = 4; this.textures.add(v);
          }
        }
        this.importedMaterials.add(material); return material;
      });
      const mesh = new THREE.InstancedMesh(geometry, Array.isArray(o.material) ? materials : materials[0], capacity);
      mesh.name = `Instanced ${name}`; mesh.count = 0;
      mesh.castShadow = castShadow; mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.root.add(mesh); meshes.push(mesh);
    });
    return { meshes, capacity };
  }

  async build(onProgress?: (text: string) => void): Promise<void> {
    onProgress?.('Growing the alpine forest');
    const response = await fetch(modelURL('conifer-impostors.json'));
    if (!response.ok) throw new Error('Unable to load conifer atlas manifest');
    const manifest = await response.json() as { sprites: { file: string; width_m: number; height_m: number }[] };
    await Promise.all(manifest.sprites.map(async (sprite, species) => {
      const texture = await new THREE.TextureLoader().loadAsync(modelURL(sprite.file));
      texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; this.textures.add(texture);
      const geometry = new THREE.PlaneGeometry(1, 1); geometry.translate(0, .5, 0);
      const trees = this.trees.filter((tree) => tree.species === species);
      const visibility = new THREE.InstancedBufferAttribute(new Float32Array(trees.length).fill(1), 1);
      visibility.setUsage(THREE.DynamicDrawUsage); geometry.setAttribute('alpineVisible', visibility);
      const material = new THREE.MeshBasicMaterial({ map: texture, color: 0x9bad91,
        alphaTest: .20, side: THREE.DoubleSide, fog: true, alphaToCoverage: true });
      material.name = 'Photographed conifer silhouette';
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = `attribute float alpineVisible;\n${shader.vertexShader}`
          .replace('#include <project_vertex>', `
            vec3 anchor=instanceMatrix[3].xyz;
            vec2 toEye=normalize(cameraPosition.xz-anchor.xz+vec2(.0001));
            vec3 right=vec3(toEye.y,0.0,-toEye.x);
            float width=length(instanceMatrix[0].xyz);
            float height=length(instanceMatrix[1].xyz);
            vec3 billboard=anchor+right*position.x*width+vec3(0.0,(position.y)*height,0.0);
            vec4 mvPosition=viewMatrix*vec4(billboard,1.0);
            gl_Position=projectionMatrix*mvPosition;
            if(alpineVisible<.5)gl_Position=vec4(2.0,2.0,2.0,1.0);
          `);
      };
      material.customProgramCacheKey = () => 'alpine-conifer-billboard-v1';
      const mesh = new THREE.InstancedMesh(geometry, material, trees.length);
      for (let i = 0; i < trees.length; i++) {
        const t = trees[i];
        this.dummy.position.set(t.x, t.y, t.z); this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(sprite.width_m * t.sx, sprite.height_m * t.sy, 1); this.dummy.updateMatrix();
        mesh.setMatrixAt(i, this.dummy.matrix);
        const shade = .84 + hash(Math.round(t.x), Math.round(t.z), species) * .22;
        this.color.setRGB(shade, shade, shade); mesh.setColorAt(i, this.color);
      }
      mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); mesh.frustumCulled = false;
      mesh.name = `Distant photographed conifer ${species}`;
      this.root.add(mesh); this.farMeshes[species] = mesh; this.farVisibility[species] = visibility;
    }));
    this.closePools = await Promise.all(['conifer-a', 'conifer-b', 'conifer-c'].map((n) => this.loadPool(n, 64, true)));
    onProgress?.('Planting grasses, ferns and wildflowers');
    await this.buildGroundcover();
    this.rockPool = await this.loadPool('rock-a', 36, true);
    const names = ['trail-sign', 'trail-marker', 'trail-bench'];
    await Promise.all(names.map(async (name) => { this.propPools.set(name, await this.loadPool(name, 56, true)); }));
  }

  private crossedCards(): THREE.BufferGeometry {
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
    for (let plane = 0; plane < 2; plane++) {
      const angle = plane * Math.PI / 2, dx = Math.cos(angle) * .5, dz = Math.sin(angle) * .5;
      const i = positions.length / 3;
      positions.push(-dx, 0, -dz, dx, 0, dz, -dx * .86, 1, -dz * .86, dx * .86, 1, dz * .86);
      uvs.push(0, 0, 1, 0, 0, 1, 1, 1); indices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(indices); g.computeVertexNormals(); return g;
  }

  private fernGeometry(): THREE.BufferGeometry {
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
    for (let frond = 0; frond < 6; frond++) {
      const a = frond / 6 * Math.PI * 2;
      const i = positions.length / 3;
      for (let segment = 0; segment <= 4; segment++) {
        const t = segment / 4, radius = t * .72, y = Math.sin(t * Math.PI * .8) * .52;
        for (const side of [-1, 1]) {
          const width = .12 * Math.sin(t * Math.PI) + .018;
          positions.push(Math.cos(a) * radius + Math.sin(a) * width * side, y,
            Math.sin(a) * radius - Math.cos(a) * width * side);
          uvs.push(.018 + (side + 1) * .115, .03 + t * .84);
        }
        if (segment < 4) { const j = i + segment * 2; indices.push(j, j + 1, j + 2, j + 1, j + 3, j + 2); }
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(indices); g.computeVertexNormals(); return g;
  }

  private shrubGeometry(): THREE.BufferGeometry {
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
    for (let leaf = 0; leaf < 18; leaf++) {
      const a = leaf * 2.39996, y = .12 + (leaf % 6) * .075, r = .12 + .09 * (leaf % 3);
      const cx = Math.sin(a) * r, cz = Math.cos(a) * r, dx = Math.cos(a) * .065, dz = -Math.sin(a) * .065;
      const i = positions.length / 3;
      positions.push(cx - dx, y, cz - dz, cx + dx, y, cz + dz,
        cx + Math.sin(a) * .16 - dx, y + .18, cz + Math.cos(a) * .16 - dz,
        cx + Math.sin(a) * .16 + dx, y + .18, cz + Math.cos(a) * .16 + dz);
      uvs.push(.22, .05, .45, .05, .22, .69, .45, .69); indices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(indices); g.computeVertexNormals(); return g;
  }

  private flowerGeometry(): THREE.BufferGeometry {
    const pos: number[] = [], color: number[] = [], indices: number[] = [];
    for (let bloom = 0; bloom < 3; bloom++) {
      const x = (bloom - 1) * .095, z = Math.sin(bloom * 4) * .08, y = .27 + bloom * .07;
      let i = pos.length / 3;
      pos.push(x - .005, 0, z, x + .005, 0, z, x, y, z);
      for (let k = 0; k < 3; k++) color.push(.10, .22, .045); indices.push(i, i + 1, i + 2);
      for (let petal = 0; petal < 7; petal++) {
        i = pos.length / 3; const a = petal / 7 * Math.PI * 2;
        pos.push(x, y, z, x + Math.cos(a - .3) * .048, y + .01, z + Math.sin(a - .3) * .048,
          x + Math.cos(a + .3) * .048, y + .01, z + Math.sin(a + .3) * .048);
        color.push(.62, .42, .04, .89, .88, .72, .89, .88, .72); indices.push(i, i + 1, i + 2);
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(color, 3)); g.setIndex(indices); g.computeVertexNormals(); return g;
  }

  private async buildGroundcover(): Promise<void> {
    const create = async (name: string, geometry: THREE.BufferGeometry, capacity: number): Promise<THREE.InstancedMesh> => {
      const texture = await new THREE.TextureLoader().loadAsync(worldURL(name));
      texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; this.textures.add(texture);
      const mat = new THREE.MeshStandardMaterial({ map: texture, alphaTest: .28, side: THREE.DoubleSide, alphaToCoverage: true,
        roughness: .94, envMapIntensity: .12, color: 0xffffff });
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.alpineTime = this.clock;
        shader.vertexShader = `uniform float alpineTime;\n${shader.vertexShader}`
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            vec3 anchor=instanceMatrix[3].xyz;
            float sway=sin(alpineTime*1.45+anchor.x*.49+anchor.z*.37);
            transformed.x+=sway*.07*pow(max(position.y,0.0),1.5);
            transformed.z+=sin(alpineTime*.82+anchor.x*.23)*.035*position.y;
          `);
        shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `
          #include <normal_fragment_maps>
          vec3 leafUp=normalize(mat3(viewMatrix)*vec3(0.0,1.0,0.0));
          normal=normalize(mix(normal,leafUp,.82));
        `);
      };
      mat.customProgramCacheKey = () => 'alpine-leaf-wind-v1';
      const mesh = new THREE.InstancedMesh(geometry, mat, capacity); mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false;
      mesh.receiveShadow = true; mesh.castShadow = false; mesh.name = `Photographed ${name}`;
      this.root.add(mesh); return mesh;
    };
    [this.grass, this.ferns, this.shrubs] = await Promise.all([
      create('grass-tuft.png', this.crossedCards(), 11000),
      create('fern.png', this.fernGeometry(), 300), create('shrub.png', this.shrubGeometry(), 380),
    ]);
    this.flowers = new THREE.InstancedMesh(this.flowerGeometry(), new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: .95, side: THREE.DoubleSide }), 650);
    this.flowers.count = 0; this.flowers.frustumCulled = false;
    this.flowers.name = 'Small meadow daisies'; this.root.add(this.flowers);
    const bladeGeometry = new THREE.BufferGeometry(), bladeVertices: number[] = [], bladeColors: number[] = [], bladeIndices: number[] = [];
    const base = new THREE.Color(0x557330), tip = new THREE.Color(0x9eaa58);
    for (let blade = 0; blade < 12; blade++) {
      const a = blade * 2.39996, r = .027 + hash(blade, 20) * .092, x = Math.sin(a) * r, z = Math.cos(a) * r;
      const width = .005 + hash(blade, 23) * .004, h = .61 + hash(blade, 27) * .39;
      const dx = Math.cos(a) * width, dz = -Math.sin(a) * width, i = bladeVertices.length / 3;
      bladeVertices.push(x - dx, 0, z - dz, x + dx, 0, z + dz,
        x + Math.sin(a) * .07, h, z + Math.cos(a) * .09);
      bladeColors.push(base.r, base.g, base.b, base.r, base.g, base.b, tip.r, tip.g, tip.b);
      bladeIndices.push(i, i + 1, i + 2);
    }
    bladeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bladeVertices, 3));
    bladeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(bladeColors, 3));
    bladeGeometry.setIndex(bladeIndices); bladeGeometry.computeVertexNormals();
    const bladeMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide,
      roughness: .92, envMapIntensity: .15 });
    bladeMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.alpineTime = this.clock;
      shader.vertexShader = `uniform float alpineTime;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec3 anchor=instanceMatrix[3].xyz;
          float wind=sin(alpineTime*1.3+anchor.x*.42+anchor.z*.31);
          transformed.x+=wind*.13*position.y*position.y;
          transformed.z+=sin(alpineTime*.8+anchor.x*.2)*.06*position.y*position.y;`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `
        #include <normal_fragment_maps>
        normal=normalize(mix(normal,normalize(mat3(viewMatrix)*vec3(0.0,1.0,0.0)),.7));`);
    };
    this.blades = new THREE.InstancedMesh(bladeGeometry, bladeMaterial, 18000);
    this.blades.count = 0; this.blades.frustumCulled = false; this.blades.receiveShadow = true;
    this.blades.name = 'Fine bent alpine grass blades'; this.blades.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.blades);
  }

  private setPool(pool: Pool, placements: Placement[]): void {
    const n = Math.min(pool.capacity, placements.length);
    for (let i = 0; i < n; i++) {
      const p = placements[i]; this.dummy.position.set(p.x, p.y, p.z); this.dummy.rotation.set(0, p.yaw, 0);
      this.dummy.scale.set(p.sx, p.sy, p.sz); this.dummy.updateMatrix();
      for (const mesh of pool.meshes) mesh.setMatrixAt(i, this.dummy.matrix);
    }
    for (const mesh of pool.meshes) { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; }
  }

  private updateTrees(position: THREE.Vector3): void {
    const cx = Math.floor(position.x / 64), cz = Math.floor(position.z / 64), candidates: Tree[] = [];
    for (let x = cx - 2; x <= cx + 2; x++) for (let z = cz - 2; z <= cz + 2; z++) {
      const bucket = this.nearbyTreeHash.get(`${x},${z}`);
      if (bucket) candidates.push(...bucket);
    }
    const distance = (p: Placement): number => (p.x - position.x) ** 2 + (p.z - position.z) ** 2 + (p.y - position.y) ** 2 * .3;
    const near = candidates.filter((t) => distance(t) < 100 ** 2).sort((a, b) => distance(a) - distance(b)).slice(0, 56);
    for (const t of this.previousNearTrees) this.farVisibility[t.species].setX(t.farIndex, 1);
    for (let species = 0; species < 3; species++) {
      this.setPool(this.closePools[species], near.filter((t) => t.species === species));
      this.farVisibility[species].needsUpdate = true;
    }
    for (const t of near) this.farVisibility[t.species].setX(t.farIndex, 0);
    this.previousNearTrees = near;
    if (this.rockPool) this.setPool(this.rockPool, this.rocks.filter((r) => distance(r) < 82 ** 2)
      .sort((a, b) => distance(a) - distance(b)).slice(0, 36));
    for (const [name, pool] of this.propPools) {
      const placements = this.field.metadata.props.filter((p) => p.model === name
        && Math.hypot(p.position[0] - position.x, p.position[2] - position.z) < 200)
        .map((p) => ({ x: p.position[0], y: p.position[1], z: p.position[2],
          sx: p.scale, sy: p.scale, sz: p.scale, yaw: p.yaw }));
      this.setPool(pool, placements);
    }
  }

  private updateGroundcover(position: THREE.Vector3): void {
    if (!this.grass || !this.ferns || !this.shrubs || !this.flowers) return;
    const counters = [0, 0, 0, 0], meshes = [this.grass, this.ferns, this.shrubs, this.flowers];
    const limits = [11000, 300, 380, 650], spacing = .82, radius = 65;
    const cx = Math.floor(position.x / spacing), cz = Math.floor(position.z / spacing), cells = Math.ceil(radius / spacing);
    for (let gz = cz - cells; gz <= cz + cells; gz++) for (let gx = cx - cells; gx <= cx + cells; gx++) {
      const r = hash(gx, gz), x = (gx + hash(gx, gz, 1) * .85) * spacing,
        z = (gz + hash(gx, gz, 2) * .85) * spacing;
      const distance = Math.hypot(x - position.x, z - position.z);
      if (distance > radius || Math.max(Math.abs(x), Math.abs(z)) > 747) continue;
      const road = this.field.getRoadDistance(x, z), h = this.field.getHeight(x, z), slope = this.field.getSlope(x, z);
      if (road < 1.52 || slope > .88 || h > 950 || (this.field.getLakeRadius(x, z) < 1.4 && h < 800.35)) continue;
      const density = h < 635 ? .54 : .45;
      if (r > density) continue;
      let kind = 0;
      if (road > 2.4 && distance < 37) {
        if (r < .016 && h < 650) kind = 1;
        else if (r < .04 && h < 815) kind = 2;
        else if (r < .068) kind = 3;
      }
      if (counters[kind] >= limits[kind]) continue;
      const scale = (kind === 0 ? .56 + hash(gx, gz, 4) * .68 : .68 + hash(gx, gz, 4) * .63)
        * (h > 730 ? .78 : 1);
      const fade = 1 - THREE.MathUtils.smoothstep(distance, 54, 65);
      this.dummy.position.set(x, h - .025, z); this.dummy.rotation.set(0, hash(gx, gz, 3) * Math.PI * 2, 0);
      this.dummy.scale.set(scale, scale * (kind === 0 ? .29 : 1) * fade, scale); this.dummy.updateMatrix();
      const mesh = meshes[kind], index = counters[kind]++;
      mesh.setMatrixAt(index, this.dummy.matrix);
      if (kind !== 3) {
        const dry = hash(gx, gz, 8) > (h > 690 ? .57 : .79), variation = .78 + hash(gx, gz, 9) * .27;
        this.color.setRGB((dry ? 1.10 : .88) * variation, (dry ? 1.03 : 1.12) * variation,
          (dry ? .80 : .80) * variation);
        mesh.setColorAt(index, this.color);
      }
    }
    for (let i = 0; i < meshes.length; i++) {
      meshes[i].count = counters[i]; meshes[i].instanceMatrix.needsUpdate = true;
      if (meshes[i].instanceColor) meshes[i].instanceColor!.needsUpdate = true;
    }
    if (!this.blades) return;
    let bladeCount = 0;
    const step = .29, bladeRadius = 22, centerX = Math.floor(position.x / step), centerZ = Math.floor(position.z / step);
    const count = Math.ceil(bladeRadius / step);
    for (let gz = centerZ - count; gz <= centerZ + count; gz++) for (let gx = centerX - count; gx <= centerX + count; gx++) {
      if (bladeCount >= 18000 || hash(gx, gz, 40) > .78) continue;
      const x = (gx + hash(gx, gz, 41)) * step, z = (gz + hash(gx, gz, 42)) * step;
      const distance = Math.hypot(x - position.x, z - position.z);
      if (distance > bladeRadius || this.field.getRoadDistance(x, z) < 1.32) continue;
      const h = this.field.getHeight(x, z);
      if (h > 970 || (this.field.getLakeRadius(x, z) < 1.4 && h < 800.35) || this.field.getSlope(x, z) > .94) continue;
      const fade = 1 - THREE.MathUtils.smoothstep(distance, 17, bladeRadius);
      const height = (.11 + hash(gx, gz, 43) * .14) * (h > 710 ? .78 : 1);
      this.dummy.position.set(x, h - .012, z); this.dummy.rotation.set(0, hash(gx, gz, 44) * Math.PI * 2, 0);
      this.dummy.scale.set(.73 + hash(gx, gz, 45) * .76, height * fade, height); this.dummy.updateMatrix();
      this.blades.setMatrixAt(bladeCount, this.dummy.matrix);
      const v = .80 + hash(gx, gz, 46) * .35;
      this.color.setRGB(v, v, v * (.80 + hash(gx, gz, 47) * .3)); this.blades.setColorAt(bladeCount++, this.color);
    }
    this.blades.count = bladeCount; this.blades.instanceMatrix.needsUpdate = true;
    if (this.blades.instanceColor) this.blades.instanceColor.needsUpdate = true;
  }

  update(dt: number, position: THREE.Vector3): void {
    this.clock.value += dt;
    if (position.distanceToSquared(this.previousCenter) > 16) {
      this.previousCenter.copy(position); this.updateTrees(position);
    }
    if (position.distanceToSquared(this.previousGround) > 12.25) {
      this.previousGround.copy(position); this.updateGroundcover(position);
    }
  }

  resolveTrunks(from: THREE.Vector3, destination: THREE.Vector3): THREE.Vector3 {
    const out = destination.clone(), cx = Math.floor(out.x / 8), cz = Math.floor(out.z / 8);
    for (let x = cx - 1; x <= cx + 1; x++) for (let z = cz - 1; z <= cz + 1; z++) {
      for (const t of this.nativeTreeHash.get(`${x},${z}`) ?? []) {
        const dx = out.x - t.x, dz = out.z - t.z, d = Math.hypot(dx, dz), radius = .35 + t.sx * .20;
        if (d < radius && Math.abs(out.y - t.y) < 3) {
          if (d < .001) { out.x = from.x; out.z = from.z; }
          else { out.x = t.x + dx / d * radius; out.z = t.z + dz / d * radius; }
        }
      }
    }
    return out;
  }

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(this.importedMaterials);
    this.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      geometries.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
    });
    for (const g of geometries) g.dispose(); for (const m of materials) m.dispose();
    for (const t of this.textures) t.dispose(); this.root.removeFromParent();
  }
}
