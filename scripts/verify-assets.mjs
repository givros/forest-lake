import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../public/',import.meta.url));
function collect(dir) { return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?collect(path.join(dir,entry.name)):[path.join(dir,entry.name)]); }
const files=collect(root);
let bytes=0;
const models={};
for(const file of files) {
  const size=fs.statSync(file).size; bytes+=size;
  assert.ok(size<50*1024*1024,`Asset exceeds 50 MB: ${file}`);
  assert.ok(!/\.export-temp|__pycache__|\.blend1$|\.log$/.test(file),`Temporary export in public assets: ${file}`);
  if(!file.endsWith('.glb')) continue;
  const buffer=fs.readFileSync(file);
  assert.equal(buffer.toString('ascii',0,4),'glTF'); assert.equal(buffer.readUInt32LE(4),2);
  assert.equal(buffer.readUInt32LE(8),buffer.length);
  const gltf=JSON.parse(buffer.toString('utf8',20,20+buffer.readUInt32LE(12)).trim());
  for(const item of [...(gltf.images??[]),...(gltf.buffers??[])]) {
    if(item.uri) assert.ok(item.uri.startsWith('data:') || fs.existsSync(path.resolve(path.dirname(file),decodeURIComponent(item.uri))),`Missing model resource: ${item.uri}`);
  }
  const triangles=(gltf.meshes??[]).flatMap(mesh=>mesh.primitives).reduce((sum,p)=>sum+(p.indices!==undefined?gltf.accessors[p.indices].count:gltf.accessors[p.attributes.POSITION].count)/3,0);
  models[path.basename(file)]={bytes:size,triangles,animations:(gltf.animations??[]).map(a=>a.name)};
}
for(const name of ['hiker.glb','horse.glb','mountain-bike.glb']) assert.ok(models[name],`Required model is missing: ${name}`);
for(const name of ['Idle','Walk','Gallop']) assert.ok(models['horse.glb'].animations.includes(name),`Horse animation missing: ${name}`);
for(const name of ['Idle','Walk','Run','Pedal','Ride']) assert.ok(models['hiker.glb'].animations.includes(name),`Hiker animation missing: ${name}`);
assert.ok(bytes<180*1024*1024,`Public assets exceed the browser download budget: ${bytes}`);
assert.ok(fs.existsSync(path.join(root,'assets/models/credits.json')));
console.log(JSON.stringify({status:'passed',files:files.length,totalMB:Math.round(bytes/1048576*100)/100,models},null,2));
