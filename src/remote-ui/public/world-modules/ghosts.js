/**
 * M190: 訪問者アバター v2 — RobotExpressive(three.js公式・MIT)。
 * モーション内蔵(Idle/Walking/Running/Sitting/Wave等)。移動速度で歩き/走りを自動切替、
 * スタンス(立つ/すわる/しゃがむ)を同期。読込失敗時は旧カプセルゴーストにフォールバック。
 */
import { clone as skClone } from 'three/addons/utils/SkeletonUtils.js';

export function initGhosts(THREE, scene, loadGltf) {
  const visitors = new Map(); // id -> ghost
  let selfId = null;
  let robot = null; // gltf | false(失敗)
  const pendingMakes = [];

  loadGltf('./avatars/robot.glb')
    .then((g) => {
      robot = g;
      for (const f of pendingMakes) f();
      pendingMakes.length = 0;
    })
    .catch(() => { robot = false; for (const f of pendingMakes) f(); pendingMakes.length = 0; });

  function setSelf(id) {
    selfId = id;
    const g = visitors.get(id);
    if (g) { scene.remove(g.grp); visitors.delete(id); }
  }

  function makeTag(name) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const cx2 = cv.getContext('2d');
    cx2.fillStyle = 'rgba(255,255,255,0.85)';
    cx2.beginPath(); cx2.roundRect(28, 8, 200, 48, 24); cx2.fill();
    cx2.fillStyle = '#34406b'; cx2.font = 'bold 28px sans-serif';
    cx2.textAlign = 'center'; cx2.textBaseline = 'middle';
    cx2.fillText(name, 128, 33);
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true }));
    tag.scale.set(1.6, 0.4, 1);
    return tag;
  }

  function colorOf(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return new THREE.Color(`hsl(${h}, 65%, 62%)`);
  }

  function buildBody(g) {
    if (robot) {
      const model = skClone(robot.scene);
      model.scale.setScalar(0.5); // 素の背丈約3.1 → 約1.55m
      // 名前色をワンポイントに(頭部などの主要メッシュへ薄く着色)
      const tint = colorOf(g.name);
      model.traverse((o) => {
        if (o.isMesh && o.material && o.material.name === 'Main') {
          o.material = o.material.clone();
          o.material.color.lerp(tint, 0.55);
        }
      });
      g.grp.add(model);
      g.model = model;
      g.mixer = new THREE.AnimationMixer(model);
      g.actions = {};
      for (const clip of robot.animations) g.actions[clip.name] = g.mixer.clipAction(clip);
      playAnim(g, 'Idle');
      const t = makeTag(g.name); t.position.y = 2.0; g.grp.add(t);
    } else {
      // フォールバック: 旧カプセルゴースト
      const color = colorOf(g.name);
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.7, 6, 12), new THREE.MeshToonMaterial({ color, transparent: true, opacity: 0.75 }));
      body.position.y = 0.85; g.grp.add(body);
      const t = makeTag(g.name); t.position.y = 2.0; g.grp.add(t);
    }
  }

  function playAnim(g, name, fade = 0.25) {
    if (!g.actions || g.current === name) return;
    const next = g.actions[name];
    if (!next) return;
    const prev = g.current !== undefined ? g.actions[g.current] : undefined;
    next.reset();
    if (name === 'Sitting') { next.setLoop(THREE.LoopOnce); next.clampWhenFinished = true; }
    next.fadeIn(fade).play();
    if (prev) prev.fadeOut(fade);
    g.current = name;
  }

  function applyStance(g, stance) {
    g.stance = stance;
    if (!g.actions) return;
    if (stance === 'sit') playAnim(g, 'Sitting');
    else if (stance === 'crouch') { playAnim(g, 'Idle'); if (g.model) g.model.position.y = -0.35; }
    else { playAnim(g, 'Idle'); if (g.model) g.model.position.y = 0; }
  }

  function syncVisitor(c) {
    if (c.id === selfId) return;
    let g = visitors.get(c.id);
    if (!g) {
      g = { grp: new THREE.Group(), target: new THREE.Vector3(c.x ?? 0, 0, c.z ?? 0), name: c.name ?? 'ゲスト', stance: 'stand', current: undefined };
      g.grp.position.set(c.x ?? 0, 0, c.z ?? 0);
      scene.add(g.grp);
      visitors.set(c.id, g);
      if (robot === null) pendingMakes.push(() => buildBody(g));
      else buildBody(g);
    }
    g.target.set(c.x ?? 0, 0, c.z ?? 0);
    if (typeof c.stance === 'string' && c.stance !== g.stance) applyStance(g, c.stance);
  }

  function removeVisitor(c) {
    const g = visitors.get(c.id);
    if (g) { scene.remove(g.grp); visitors.delete(c.id); }
  }

  function tickVisitors(dt, _t) {
    for (const g of visitors.values()) {
      const p = g.grp.position;
      const dx = g.target.x - p.x, dz = g.target.z - p.z;
      const dist = Math.hypot(dx, dz);
      p.x += dx * Math.min(1, dt * 4);
      p.z += dz * Math.min(1, dt * 4);
      if (dist > 0.05) g.grp.rotation.y = Math.atan2(dx, dz); // 進行方向を向く
      if (g.mixer) {
        if (g.stance === 'stand') {
          const speed = dist * 4; // lerp速度の近似
          playAnim(g, speed > 2.2 ? 'Running' : speed > 0.15 ? 'Walking' : 'Idle');
        }
        g.mixer.update(dt);
      }
    }
  }

  return { syncVisitor, removeVisitor, tickVisitors, setSelf };
}
