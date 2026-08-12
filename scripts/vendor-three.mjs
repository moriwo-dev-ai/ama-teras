/**
 * M201: 3D基盤(three.js / addons / three-vrm)をローカルへ同梱し直す。
 * 世界ページはCDNを使わない = 外に出られない回線(LAN限定・機内・トンネル越し)でも真っ白にならない。
 * バージョンを上げるときはここのTHREE_VER/VRM_VERを変えて実行する。
 * 使い方: node scripts/vendor-three.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const THREE_VER = '0.160.0';
const VRM_VER = '2.1.1';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'remote-ui', 'public', 'vendor');

const three = (p) => `https://cdn.jsdelivr.net/npm/three@${THREE_VER}/${p}`;
const FILES = [
  [three('build/three.module.js'), 'three.module.js'],
  [`https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@${VRM_VER}/lib/three-vrm.module.min.js`, 'three-vrm.module.min.js'],
  [three('examples/jsm/loaders/GLTFLoader.js'), 'addons/loaders/GLTFLoader.js'],
  [three('examples/jsm/loaders/FBXLoader.js'), 'addons/loaders/FBXLoader.js'],
  [three('examples/jsm/controls/OrbitControls.js'), 'addons/controls/OrbitControls.js'],
  [three('examples/jsm/utils/SkeletonUtils.js'), 'addons/utils/SkeletonUtils.js'],
  [three('examples/jsm/utils/BufferGeometryUtils.js'), 'addons/utils/BufferGeometryUtils.js'],
  [three('examples/jsm/libs/fflate.module.js'), 'addons/libs/fflate.module.js'],
  [three('examples/jsm/curves/NURBSCurve.js'), 'addons/curves/NURBSCurve.js'],
  [three('examples/jsm/curves/NURBSUtils.js'), 'addons/curves/NURBSUtils.js'],
];

for (const [url, dest] of FILES) {
  const res = await fetch(url);
  if (!res.ok) { console.error(`失敗 ${res.status}: ${url}`); process.exitCode = 1; continue; }
  const text = await res.text();
  const path = join(OUT, dest);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`OK ${dest} ${Math.round(text.length / 1024)}KB`);
}
console.log('同梱おわり(world.html の importmap は ./vendor/ を指している)');
