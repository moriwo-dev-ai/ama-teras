/**
 * M191: 訪問者アバター v3 — Mixamo Y Bot + 既存モーション資産(assets-lab)。
 * Y Botとassets-labのFBXは同一Mixamo骨格なのでリターゲット不要でそのまま再生できる。
 * 移動速度で歩き/走りを自動切替、スタンス(立つ/すわる/しゃがむ)を同期。
 * 読込失敗時は旧カプセルゴーストにフォールバック。
 */
import { clone as skClone } from 'three/addons/utils/SkeletonUtils.js';

export function initGhosts(THREE, scene, loaders) {
  const visitors = new Map(); // id -> ghost
  let selfId = null;
  let rig = null; // {base, clips} | false(失敗→カプセル)
  const pendingMakes = [];

  // M191: Y Bot(Mixamo)+既存モーション資産(同じMixamo骨格なのでそのまま動く)
  // 歩き/走りは前進成分(Hipsの水平移動)を初期位置に固定してその場再生にする。
  // 上下動(y)と座りの腰下げは残したいので、トラック削除ではなく値の上書きで対応
  const stripRootMove = (clip) => {
    if (!clip) return clip;
    for (const t of clip.tracks) {
      if (/Hips\.position/.test(t.name)) {
        for (let i = 3; i < t.values.length; i += 3) {
          t.values[i] = t.values[0];
          t.values[i + 2] = t.values[2];
        }
      }
    }
    return clip;
  };
  Promise.all([
    loaders.fbx('./avatars/ybot.fbx'),
    loaders.fbx('./assets-lab/Breathing Idle.fbx'),
    loaders.fbx('./assets-lab/Walking.fbx'),
    loaders.fbx('./assets-lab/Fast Run.fbx'),
    loaders.fbx('./assets-lab/Sitting Idle.fbx'),
  ])
    .then(([base, idle, walk, run, sit]) => {
      rig = {
        base,
        clips: {
          Idle: stripRootMove(idle.animations[0]),
          Walking: stripRootMove(walk.animations[0]),
          Running: stripRootMove(run.animations[0]),
          Sitting: stripRootMove(sit.animations[0]),
        },
      };
      for (const f of pendingMakes) f();
      pendingMakes.length = 0;
    })
    .catch((e) => { console.warn('[ghosts] Y Bot読込失敗', e); rig = false; for (const f of pendingMakes) f(); pendingMakes.length = 0; });

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
    if (rig) {
      const model = skClone(rig.base);
      model.scale.setScalar(0.01); // Mixamoはcm単位 → 約1.8m
      // Y Botの白グレー基調は保ち、名前色はemissiveでうっすら
      const tint = colorOf(g.name);
      const tintMat = (m) => {
        const c = m.clone();
        if (c.emissive) { c.emissive.copy(tint); c.emissiveIntensity = 0.14; }
        return c;
      };
      model.traverse((o) => {
        if (o.isMesh && o.material) {
          o.material = Array.isArray(o.material) ? o.material.map(tintMat) : tintMat(o.material);
        }
      });
      g.grp.add(model);
      g.model = model;
      g.mixer = new THREE.AnimationMixer(model);
      g.actions = {};
      for (const [name, clip] of Object.entries(rig.clips)) {
        if (clip) g.actions[name] = g.mixer.clipAction(clip);
      }
      playAnim(g, 'Idle');
      const t = makeTag(g.name); t.position.y = 2.05; g.grp.add(t);
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
    // M196c: 改名(観戦者の名前変更)は作り直しで名札・色を更新する
    if (g && typeof c.name === 'string' && c.name !== '' && c.name !== g.name) {
      scene.remove(g.grp);
      visitors.delete(c.id);
      g = undefined;
    }
    if (!g) {
      g = { grp: new THREE.Group(), target: new THREE.Vector3(c.x ?? 0, 0, c.z ?? 0), name: c.name ?? 'ゲスト', stance: 'stand', current: undefined };
      g.grp.position.set(c.x ?? 0, 0, c.z ?? 0);
      scene.add(g.grp);
      visitors.set(c.id, g);
      if (rig === null) pendingMakes.push(() => buildBody(g));
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
