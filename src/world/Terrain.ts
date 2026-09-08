import * as THREE from 'three';
import { Heightfield, worldURL } from './Heightfield';
import { SurfaceHeight } from './SurfaceHeight';

type TerrainTile = { mesh: THREE.Mesh; geometries: Map<number, THREE.BufferGeometry>;
  x: number; z: number; ix: number; iy: number; level: number };

const strides = [1, 3, 9, 21];

export async function loadWorldTexture(name: string, data = false): Promise<THREE.Texture> {
  const texture = await new THREE.TextureLoader().loadAsync(worldURL(name));
  texture.colorSpace = data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = data ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  texture.anisotropy = 8;
  if (data) texture.flipY = false;
  return texture;
}

export class Terrain {
  readonly root = new THREE.Group();
  private tiles: TerrainTile[] = [];
  private textures: THREE.Texture[] = [];
  private materials: THREE.Material[] = [];
  private clock = { value: 0 };
  private water?: THREE.Mesh;
  private lastCenter = new THREE.Vector3(Infinity, 0, 0);
  private readonly surface: SurfaceHeight;

  constructor(private readonly field: Heightfield, private readonly mobile = false) {
    this.root.name = 'Alpine terrain and glacial lake';
    this.surface = new SurfaceHeight(field);
  }

  getSurfaceHeight = (x: number, z: number): number => this.surface.getHeight(x, z);

  async build(massifBuffer: ArrayBuffer, route: THREE.Vector3[]): Promise<void> {
    const [turf, dry, rock, trail, floor, ecology, native] = await Promise.all([
      loadWorldTexture('turf.jpg'), loadWorldTexture('dry-grass.jpg'), loadWorldTexture('rock.jpg'),
      loadWorldTexture('trail.jpg'), loadWorldTexture('forest-floor.jpg'),
      loadWorldTexture('mountain-ecology.png', true), loadWorldTexture('native-surface.png', true),
    ]);
    this.textures.push(turf, dry, rock, trail, floor, ecology, native);
    const material = new THREE.MeshStandardMaterial({ roughness: .94, metalness: 0,
      color: 0xffffff, envMapIntensity: .18 });
    material.name = 'Photographed alpine turf, rock and worn trail';
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, { alpineTurf: { value: turf }, alpineDry: { value: dry },
        alpineRock: { value: rock }, alpineTrail: { value: trail }, alpineFloor: { value: floor },
        alpineEcology: { value: ecology }, alpineNative: { value: native } });
      shader.vertexShader = `varying vec3 vAlpineWorld; varying vec3 vAlpineNormal;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vAlpineWorld=(modelMatrix*vec4(transformed,1.0)).xyz;
          vAlpineNormal=normalize(mat3(modelMatrix)*normal);`);
      shader.fragmentShader = `
        varying vec3 vAlpineWorld; varying vec3 vAlpineNormal;
        uniform sampler2D alpineTurf, alpineDry, alpineRock, alpineTrail, alpineFloor;
        uniform sampler2D alpineEcology, alpineNative;
        vec3 alpineTri(sampler2D tex,vec3 p,float scale,vec3 w){
          return texture2D(tex,p.yz/scale).rgb*w.x+texture2D(tex,p.xz/scale).rgb*w.y
            +texture2D(tex,p.xy/scale).rgb*w.z;
        }
        ${shader.fragmentShader}`.replace('#include <map_fragment>', `
          vec3 p=vAlpineWorld;
          vec3 w=pow(abs(normalize(vAlpineNormal)),vec3(5.0));w/=w.x+w.y+w.z;
          vec2 uvNative=vec2(p.x+756.0,-p.z+756.0)/1512.0;
          vec4 eco=texture2D(alpineEcology,vec2(p.x+4406.0,-p.z+4406.0)/8812.0);
          vec4 field=texture2D(alpineNative,clamp(uvNative,0.0,1.0));
          float inside=1.0-smoothstep(746.0,756.0,max(abs(p.x),abs(p.z)));
          float altitude=p.y+1500.0;
          float steep=1.0-abs(normalize(vAlpineNormal).y);
          float mineral=max(smoothstep(.21,.50,steep),smoothstep(2370.0,2690.0,altitude));
          mineral=mix(mineral,field.r,inside);
          vec3 green=alpineTri(alpineTurf,p,5.8,w);
          vec3 macro=alpineTri(alpineTurf,p+vec3(123.0,18.0,237.0),73.0,w);
          green=mix(green,macro,.24);
          green*=mix(vec3(.48,.80,.48),vec3(.34,.80,.50),eco.g);
          green*=mix(.82,1.18,eco.b);
          vec3 straw=alpineTri(alpineDry,p,8.7,w)*vec3(.74,.73,.53);
          float dryAmount=mix(.18+.32*smoothstep(2060.0,2440.0,altitude),field.g,inside);
          green=mix(green,straw,dryAmount*.48);
          float lowWoodland=(1.0-smoothstep(1850.0,2160.0,altitude))*.28;
          green=mix(green,alpineTri(alpineFloor,p,5.1,w)*vec3(.76,.81,.68),lowWoodland);
          green*=mix(1.0,.48,eco.r*(1.0-inside));
          vec3 warped=p+vec3(sin(p.z*.009)*17.0,sin(p.x*.011)*13.0,cos(p.y*.012)*19.0);
          vec3 stone=alpineTri(alpineRock,warped,32.0,w);
          vec3 rotated=vec3(p.x*.73+p.z*.67,p.y*.93,-p.x*.67+p.z*.73)+vec3(470.0,73.0,-81.0);
          vec3 largeStone=alpineTri(alpineRock,rotated,163.0,w);
          stone=mix(stone,largeStone,.72);
          float mineralGrey=dot(stone,vec3(.2126,.7152,.0722));
          stone=mix(vec3(mineralGrey),stone,.045)*vec3(.84,.91,1.0);
          stone*=.89+.16*sin(p.x*.007+p.y*.004)*cos(p.z*.006-p.y*.008);
          vec3 albedo=mix(green,stone,clamp(mineral,0.0,1.0));
          vec3 gravel=texture2D(alpineTrail,p.xz/4.2).rgb*vec3(.81,.78,.69);
          albedo=mix(albedo,mix(stone,gravel,.52),field.a*inside*.87);
          albedo=mix(albedo,gravel,field.b*inside*.96);
          diffuseColor.rgb*=albedo;
        `);
    };
    material.customProgramCacheKey = () => 'alpine-world-surface-v3';
    this.materials.push(material);
    for (let iy = 0; iy < 8; iy++) for (let ix = 0; ix < 8; ix++) {
      const g = this.makeTile(ix, iy, 21);
      const mesh = new THREE.Mesh(g, material);
      mesh.name = `Native terrain ${ix},${iy}`; mesh.receiveShadow = true;
      const x = -756 + ix * 189 + 94.5, z = 756 - iy * 189 - 94.5;
      this.tiles.push({ mesh, geometries: new Map([[21, g]]), x, z, ix, iy, level: 21 });
      this.root.add(mesh);
    }
    const header = new Uint32Array(massifBuffer, 0, 2), vertices = header[0], indices = header[1];
    const massif = new THREE.BufferGeometry();
    massif.setAttribute('position', new THREE.BufferAttribute(new Float32Array(massifBuffer, 8, vertices * 3), 3));
    massif.setIndex(new THREE.BufferAttribute(new Uint32Array(massifBuffer, 8 + vertices * 12, indices), 1));
    massif.computeVertexNormals(); massif.computeBoundingSphere();
    const mountain = new THREE.Mesh(massif, material);
    mountain.name = 'Connected 8.8 km alpine massif'; mountain.receiveShadow = false;
    this.root.add(mountain);
    this.buildTrail(route, trail);
    this.buildWater();
  }

  private makeTile(ix: number, iy: number, stride: number): THREE.BufferGeometry {
    // Every LOD retains all 1.5 m boundary samples. Coarser interiors are
    // stitched with fans, so adjacent chunks share identical edges and normals.
    const quads = 126 / stride, positions: number[] = [], normals: number[] = [], indices: number[] = [];
    const lookup = new Map<string, number>(), normal = new THREE.Vector3();
    const vertex = (x: number, y: number): number => {
      const key = `${x},${y}`, old = lookup.get(key); if (old !== undefined) return old;
      const wx = -756 + (ix * 126 + x) * 1.5, wz = 756 - (iy * 126 + y) * 1.5;
      const i = positions.length / 3;
      positions.push(wx, this.field.getHeight(wx, wz), wz);
      const xm = Math.max(-756, wx - 1.5), xp = Math.min(756, wx + 1.5);
      const zm = Math.max(-756, wz - 1.5), zp = Math.min(756, wz + 1.5);
      normal.set(-(this.field.getHeight(xp, wz) - this.field.getHeight(xm, wz)) / (xp - xm), 1,
        -(this.field.getHeight(wx, zp) - this.field.getHeight(wx, zm)) / (zp - zm)).normalize();
      normals.push(normal.x, normal.y, normal.z); lookup.set(key, i); return i;
    };
    for (let y = 0; y < quads; y++) for (let x = 0; x < quads; x++) {
      const x0 = x * stride, y0 = y * stride, x1 = x0 + stride, y1 = y0 + stride;
      if (stride === 1 || (x > 0 && x < quads - 1 && y > 0 && y < quads - 1)) {
        const a = vertex(x0, y0), b = vertex(x1, y0), c = vertex(x0, y1), d = vertex(x1, y1);
        indices.push(a, b, c, b, d, c); continue;
      }
      const edge: number[] = [];
      for (let xx = x0; xx < x1; xx += y === 0 ? 1 : stride) edge.push(vertex(xx, y0));
      for (let yy = y0; yy < y1; yy += x === quads - 1 ? 1 : stride) edge.push(vertex(x1, yy));
      for (let xx = x1; xx > x0; xx -= y === quads - 1 ? 1 : stride) edge.push(vertex(xx, y1));
      for (let yy = y1; yy > y0; yy -= x === 0 ? 1 : stride) edge.push(vertex(x0, yy));
      const center = vertex((x0 + x1) / 2, (y0 + y1) / 2);
      for (let i = 0; i < edge.length; i++) indices.push(center, edge[i], edge[(i + 1) % edge.length]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    g.setIndex(indices); g.computeBoundingSphere();
    return g;
  }

  private buildTrail(route: THREE.Vector3[], texture: THREE.Texture): void {
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
    let distance = 0;
    for (let i = 0; i < route.length; i += 2) {
      const p = route[i], previous = route[Math.max(0, i - 2)], next = route[Math.min(route.length - 1, i + 2)];
      const dx = next.x - previous.x, dz = next.z - previous.z, len = Math.hypot(dx, dz) || 1;
      const width = 1.00 + .15 * Math.sin(i * .037);
      distance += i ? p.distanceTo(previous) : 0;
      for (const side of [-1, 1]) {
        const x = p.x - dz / len * width * side, z = p.z + dx / len * width * side;
        positions.push(x, this.field.getHeight(x, z) + .055, z); uvs.push((side + 1) / 2, distance / 2.4);
      }
      const j = positions.length / 3 - 2;
      if (j > 0) indices.push(j - 2, j, j - 1, j - 1, j, j + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(indices); g.computeVertexNormals();
    this.surface.indexTrail(g);
    const mat = new THREE.MeshStandardMaterial({ map: texture, color: 0xb8a790, roughness: .99,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.a*=smoothstep(0.0,.22,vMapUv.x)*(1.0-smoothstep(.78,1.0,vMapUv.x))*.74;`);
    };
    this.materials.push(mat);
    const path = new THREE.Mesh(g, mat); path.name = 'Continuous worn 3.9 km trail'; path.receiveShadow = true;
    this.root.add(path);
  }

  private buildWater(): void {
    const outline = this.field.metadata.lakeOutline, positions: number[] = [], colors: number[] = [], indices: number[] = [];
    const n = outline.length, rings = 18;
    for (let ring = 0; ring <= rings; ring++) for (let i = 0; i < n; i++) {
      const f = ring / rings, x = 300 + (outline[i][0] - 300) * f, z = -350 + (outline[i][2] + 350) * f;
      positions.push(x, 800.015, z);
      const depth = Math.max(0, 800 - this.field.getHeight(x, z));
      const color = new THREE.Color(0x46b2a6).lerp(new THREE.Color(0x168f94), THREE.MathUtils.smoothstep(depth, 1, 15));
      colors.push(color.r, color.g, color.b);
      if (ring < rings) {
        const a = ring * n + i, b = ring * n + (i + 1) % n, c = a + n, d = b + n;
        indices.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geo.setIndex(indices); geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .24, metalness: .12,
      envMapIntensity: .85, side: THREE.DoubleSide });
    mat.name = 'Turquoise glacier water with wind ripples';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.alpineTime = this.clock;
      shader.vertexShader = `uniform float alpineTime; varying vec3 vWaterWorld;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float waveA=transformed.x*.51+transformed.z*.23+alpineTime*1.15;
          float waveB=transformed.x*.19-transformed.z*.71-alpineTime*.74;
          transformed.y+=sin(waveA)*.025+sin(waveB)*.017;
          vWaterWorld=(modelMatrix*vec4(transformed,1.0)).xyz;`);
      shader.fragmentShader = `uniform float alpineTime; varying vec3 vWaterWorld;\n${shader.fragmentShader}`
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          vec2 wave=vec2(cos(vWaterWorld.x*.51+vWaterWorld.z*.23+alpineTime*1.15),
            cos(vWaterWorld.x*.19-vWaterWorld.z*.71-alpineTime*.74));
          normal=normalize(normal+vec3(wave.x*.12,wave.y*.09,.0));`)
        .replace('#include <dithering_fragment>', `
          float grazing=pow(1.0-abs(dot(normal,normalize(vViewPosition))),3.0);
          gl_FragColor.rgb=mix(gl_FragColor.rgb,vec3(.44,.64,.70),grazing*.37);
          #include <dithering_fragment>`);
    };
    this.materials.push(mat); this.water = new THREE.Mesh(geo, mat); this.water.name = 'Lac des Aiguilles — 2,300 m';
    this.root.add(this.water);
  }

  update(dt: number, position: THREE.Vector3): void {
    this.clock.value += dt;
    if (position.distanceToSquared(this.lastCenter) < 36) return;
    this.lastCenter.copy(position);
    for (const tile of this.tiles) {
      const distance = Math.hypot(Math.max(0, Math.abs(position.x - tile.x) - 94.5),
        Math.max(0, Math.abs(position.z - tile.z) - 94.5));
      const stride = distance < (this.mobile ? 12 : 48) ? strides[0]
        : distance < (this.mobile ? 120 : 240) ? strides[1]
        : distance < (this.mobile ? 360 : 650) ? strides[2] : strides[3];
      if (stride === tile.level) continue;
      if (!tile.geometries.has(stride)) tile.geometries.set(stride, this.makeTile(tile.ix, tile.iy, stride));
      tile.mesh.geometry = tile.geometries.get(stride)!; tile.level = stride;
    }
  }

  dispose(): void {
    this.surface.dispose();
    const geometries = new Set<THREE.BufferGeometry>();
    this.root.traverse((o) => { if (o instanceof THREE.Mesh) geometries.add(o.geometry); });
    for (const t of this.tiles) for (const g of t.geometries.values()) geometries.add(g);
    for (const g of geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.root.removeFromParent();
  }
}
