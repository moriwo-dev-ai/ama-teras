/**
 * M178(world.html整理・第1弾): 訪問者ゴースト(M176)のモジュール化。
 * 整理の原則: 独立性の高いセクションから1つずつ、テストハーネス(コピー状態のworld-server+
 * ヘッドレス実行係)で起動検証しながら段階的に切り出す。共有状態はinitで注入し、グローバルを増やさない。
 */
export function initGhosts(THREE, scene) {
  const visitors = new Map(); // id -> {grp, target, bob}

  function makeVisitorGhost(name) {
    const grp = new THREE.Group();
    // 名前から色を決める(同じ人はいつも同じ色)
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    const color = new THREE.Color(`hsl(${h}, 65%, 70%)`);
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.28, 0.7, 6, 12),
      new THREE.MeshToonMaterial({ color, transparent: true, opacity: 0.75 }),
    );
    body.position.y = 0.85;
    grp.add(body);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 16, 12),
      new THREE.MeshToonMaterial({ color, transparent: true, opacity: 0.85 }),
    );
    head.position.y = 1.55;
    grp.add(head);
    // 名札(canvasスプライト)
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const cx2 = cv.getContext('2d');
    cx2.fillStyle = 'rgba(255,255,255,0.85)';
    cx2.beginPath(); cx2.roundRect(28, 8, 200, 48, 24); cx2.fill();
    cx2.fillStyle = '#34406b'; cx2.font = 'bold 28px sans-serif';
    cx2.textAlign = 'center'; cx2.textBaseline = 'middle';
    cx2.fillText(name, 128, 33);
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true }));
    tag.scale.set(1.6, 0.4, 1); tag.position.y = 2.1;
    grp.add(tag);
    return { grp, target: new THREE.Vector3(), bob: Math.random() * Math.PI * 2 };
  }

  /** visitor_sync コマンド: 出現 or 目標位置の更新 */
  function syncVisitor(c) {
    let g = visitors.get(c.id);
    if (!g) {
      g = makeVisitorGhost(c.name ?? 'ゲスト');
      g.grp.position.set(c.x ?? 0, 0, c.z ?? 0);
      scene.add(g.grp);
      visitors.set(c.id, g);
    }
    g.target.set(c.x ?? 0, 0, c.z ?? 0);
  }

  /** visitor_gone コマンド: 退場 */
  function removeVisitor(c) {
    const g = visitors.get(c.id);
    if (g) { scene.remove(g.grp); visitors.delete(c.id); }
  }

  /** 毎フレーム: lerp移動+ふわふわ(幽体ではなく気配の表現) */
  function tickVisitors(dt, t) {
    for (const g of visitors.values()) {
      const p = g.grp.position;
      p.x += (g.target.x - p.x) * Math.min(1, dt * 4);
      p.z += (g.target.z - p.z) * Math.min(1, dt * 4);
      g.grp.position.y = Math.sin(t * 2 + g.bob) * 0.06;
    }
  }

  return { syncVisitor, removeVisitor, tickVisitors };
}
