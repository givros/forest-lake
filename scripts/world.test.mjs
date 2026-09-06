import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const root = new URL('../public/assets/world/', import.meta.url);
const data = JSON.parse(fs.readFileSync(new URL('world.json', root), 'utf8'));
const heights = fs.readFileSync(new URL('height.r16', root));
const route = fs.readFileSync(new URL('route.bin', root));
const report = JSON.parse(fs.readFileSync(new URL('export-report.json', root), 'utf8'));
const point = i => [0,1,2].map(axis => route.readFloatLE((i*3+axis)*4));
function heightAt(x, z) {
  const gx=(x+data.nativeHalfWidth)/data.heightStep;
  const gy=(-z+data.nativeHalfWidth)/data.heightStep;
  const ix=Math.max(0,Math.min(data.heightSize-2,Math.floor(gx)));
  const iy=Math.max(0,Math.min(data.heightSize-2,Math.floor(gy)));
  const fx=gx-ix, fy=gy-iy;
  const h=(x,y)=>(heights.readUInt16LE((y*data.heightSize+x)*2)-data.heightBias)*data.heightScale+data.heightOrigin-data.altitudeOffset;
  return (h(ix,iy)*(1-fx)+h(ix+1,iy)*fx)*(1-fy)+(h(ix,iy+1)*(1-fx)+h(ix+1,iy+1)*fx)*fy;
}

test('the browser terrain preserves the original authored heightfield byte for byte', () => {
  assert.equal(heights.length, data.heightSize*data.heightSize*2);
  assert.equal(crypto.createHash('sha256').update(heights).digest('hex'), report.nativeHeightSHA256);
  assert.equal(report.nativeHeightBytesIdentical, true);
});

test('the complete trail has the requested ascent, altitude and ground contact', () => {
  assert.equal(route.length, data.routePoints*3*4);
  let distance=0, ascent=0, worstContact=0;
  for(let i=0;i<data.routePoints;i++) {
    const p=point(i); assert.ok(p.every(Number.isFinite));
    assert.ok(Math.abs(p[0])<=756 && Math.abs(p[2])<=756);
    worstContact=Math.max(worstContact,Math.abs(p[1]-heightAt(p[0],p[2])));
    if(i) { const last=point(i-1); distance+=Math.hypot(...p.map((v,a)=>v-last[a])); ascent+=Math.max(0,p[1]-last[1]); }
  }
  assert.ok(distance>3800 && distance<4100, `route length ${distance}`);
  assert.ok(ascent>=700 && ascent<=900, `ascent ${ascent}`);
  assert.ok(worstContact<.20, `route / terrain maximum contact error ${worstContact}`);
  assert.ok(Math.abs(data.start[1]+data.altitudeOffset-1500)<.2);
  assert.equal(data.waterLevel+data.altitudeOffset,2300);
});

test('both fast-travel destinations stand on dry ground', () => {
  for(const destination of [data.start, data.lakeArrival]) {
    assert.ok(destination.every(Number.isFinite));
    assert.ok(Math.abs(heightAt(destination[0],destination[2])-destination[1])<.15);
  }
  assert.ok(heightAt(data.lakeArrival[0],data.lakeArrival[2])>data.waterLevel+1);
});

test('the surrounding massif and forest are complete binary assets', () => {
  const massif=fs.readFileSync(new URL('massif.bin',root));
  const vertices=massif.readUInt32LE(0), indices=massif.readUInt32LE(4);
  assert.equal(massif.length,8+vertices*12+indices*4);
  assert.equal(indices/3,data.massif.triangles);
  for(let i=8+vertices*12;i<massif.length;i+=4) assert.ok(massif.readUInt32LE(i)<vertices);
  assert.ok(data.trees>=48000);
  assert.equal(fs.readFileSync(new URL('forest.bin',root)).length,data.trees*8*4);
});
