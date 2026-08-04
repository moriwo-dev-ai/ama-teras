import type { WorldCommand } from '../../../shared/types';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * M115: 世界(WORLD)での行動。セリフ・モーション・移動・オブジェクト生成・カメラを
 * コマンド列としてまとめて実行する。世界はエージェントの身体でありキャンバス:
 * 返答は文章だけでなく「世界で見せる」こと(say + spawn での図解など)。
 */

const MOTIONS = ['idle', 'guard', 'jab', 'hook', 'kick', 'walk', 'sit'] as const;
const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'sign', 'screen', 'custom'] as const;
const MAX_CODE_CHARS = 20_000;
const CAMERA_TARGETS = ['avatar', 'overview', 'object'] as const;
const MAX_ACTIONS = 30;
const PLAZA_RADIUS = 18;

function validate(cmds: unknown): { ok: true; cmds: WorldCommand[] } | { ok: false; error: string } {
  if (!Array.isArray(cmds) || cmds.length === 0) return { ok: false, error: 'actions は1件以上の配列で指定すること' };
  if (cmds.length > MAX_ACTIONS) return { ok: false, error: `actions は最大${MAX_ACTIONS}件(分割して実行すること)` };
  const out: WorldCommand[] = [];
  for (const [i, raw] of cmds.entries()) {
    if (raw === null || typeof raw !== 'object') return { ok: false, error: `actions[${i}] がオブジェクトでない` };
    const c = raw as WorldCommand;
    switch (c.type) {
      case 'say':
        if (typeof c.text !== 'string' || c.text.trim() === '') return { ok: false, error: `actions[${i}] say: text が必要` };
        break;
      case 'motion':
        if (!MOTIONS.includes(c.name as (typeof MOTIONS)[number]))
          return { ok: false, error: `actions[${i}] motion: name は ${MOTIONS.join('|')} のいずれか` };
        break;
      case 'move_to':
        if (typeof c.x !== 'number' || typeof c.z !== 'number') return { ok: false, error: `actions[${i}] move_to: x,z が必要` };
        if (Math.hypot(c.x, c.z) > PLAZA_RADIUS) return { ok: false, error: `actions[${i}] move_to: 広場(半径${PLAZA_RADIUS})の外` };
        break;
      case 'spawn':
        if (!SHAPES.includes(c.shape as (typeof SHAPES)[number]))
          return { ok: false, error: `actions[${i}] spawn: shape は ${SHAPES.join('|')} のいずれか` };
        if (typeof c.x !== 'number' || typeof c.z !== 'number') return { ok: false, error: `actions[${i}] spawn: x,z が必要` };
        if ((c.shape === 'sign' || c.shape === 'screen') && typeof c.label !== 'string')
          return { ok: false, error: `actions[${i}] spawn: ${c.shape} には label が必要` };
        if (c.shape === 'custom') {
          if (typeof c.code !== 'string' || c.code.trim() === '')
            return { ok: false, error: `actions[${i}] spawn: custom には code(THREEを受けObject3Dをreturnする関数本体)が必要` };
          if (c.code.length > MAX_CODE_CHARS)
            return { ok: false, error: `actions[${i}] spawn: code は${MAX_CODE_CHARS}字以内(分割して組み立てること)` };
          // 世界ページのサンドボックス外へ手を伸ばすAPIは機械的に拒否(描画コードに不要)
          const banned = /\b(fetch|XMLHttpRequest|WebSocket|document|window|localStorage|eval|import)\b/.exec(c.code);
          if (banned) return { ok: false, error: `actions[${i}] spawn: code に禁止API(${banned[1]})。描画はTHREEだけで完結させること` };
        }
        break;
      case 'remove':
        if (typeof c.id !== 'string' || c.id === '') return { ok: false, error: `actions[${i}] remove: id が必要` };
        break;
      case 'camera':
        if (!CAMERA_TARGETS.includes(c.target as (typeof CAMERA_TARGETS)[number]))
          return { ok: false, error: `actions[${i}] camera: target は ${CAMERA_TARGETS.join('|')} のいずれか` };
        break;
      case 'app_add': {
        const a = c.app;
        if (a === undefined || typeof a.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(a.id))
          return { ok: false, error: `actions[${i}] app_add: app.id は小文字英数とハイフン(1-40字)` };
        if (typeof a.name !== 'string' || a.name.trim() === '')
          return { ok: false, error: `actions[${i}] app_add: app.name が必要` };
        if (typeof a.x !== 'number' || typeof a.z !== 'number' || Math.hypot(a.x, a.z) > PLAZA_RADIUS)
          return { ok: false, error: `actions[${i}] app_add: x,z が広場(半径${PLAZA_RADIUS})内に必要` };
        if (a.kioskCode !== undefined) {
          if (a.kioskCode.length > MAX_CODE_CHARS) return { ok: false, error: `actions[${i}] app_add: kioskCode が長すぎる` };
          const banned = /\b(fetch|XMLHttpRequest|WebSocket|document|window|localStorage|eval|import)\b/.exec(a.kioskCode);
          if (banned) return { ok: false, error: `actions[${i}] app_add: kioskCode に禁止API(${banned[1]})` };
        }
        break;
      }
      case 'app_move':
        if (typeof c.appId !== 'string') return { ok: false, error: `actions[${i}] app_move: appId が必要` };
        if (typeof c.x !== 'number' || typeof c.z !== 'number' || Math.hypot(c.x, c.z) > PLAZA_RADIUS)
          return { ok: false, error: `actions[${i}] app_move: x,z が広場内に必要` };
        break;
      case 'app_remove':
      case 'app_open':
        if (typeof c.appId !== 'string') return { ok: false, error: `actions[${i}] ${c.type}: appId が必要` };
        break;
      case 'app_point':
        if (typeof c.appId !== 'string') return { ok: false, error: `actions[${i}] app_point: appId が必要` };
        if (typeof c.selector !== 'string' || c.selector.trim() === '')
          return { ok: false, error: `actions[${i}] app_point: selector(CSSセレクタ)が必要` };
        break;
      default:
        return { ok: false, error: `actions[${i}] type が不正: ${String((c as { type?: unknown }).type)}` };
    }
    out.push(c);
  }
  return { ok: true, cmds: out };
}

export default {
  name: 'world_act',
  description:
    '「世界」(ユーザーと共有する3D空間)で行動する。actions にコマンド列を渡すと世界内のあなたのアバターが順に実行する。' +
    'type: say(セリフ。世界チャットにも残る) / motion(idle=待機 guard=戦闘構え jab|hook|kick|walk|sit) / ' +
    'move_to(x,z へ歩く。広場は半径18) / spawn(box|sphere|cylinder|cone|torus|sign|screen|custom を x,z に生成。' +
    'custom は code に「THREE を受け取り THREE.Object3D を return する関数の本体」を書く自由造形 — ' +
    '家・木・乗り物など複合形状はプリミティブを並べず custom で作ること(Group に Mesh を組み合わせ、原点=接地面の中心、実寸m、MeshToonMaterial推奨。fetch/document等は禁止)。' +
    'color は #rrggbb、sx,sy,sz はサイズm、y は設置高さ、ry は向き(ラジアン)。sign は label を小さな看板に、' +
    'screen は label を高解像度の大画面(bg=背景色・color=文字色・改行可)に描く — 文字表示は必ず screen/sign を使い、boxで文字を組まないこと。' +
    'id を付けると後で remove できる) / ' +
    'remove(id のオブジェクトを消す) / camera(avatar|overview|object へ注視)。' +
    'アプリ(社): app_add(app={id,name,description,x,z,kioskCode?} — あなたが作ったWebアプリを世界に置く。' +
    '実体は userData/world-apps/<id>/index.html に write_file で作ってから登録する。kioskCode で社の外観も自作できる) / ' +
    'app_move(appId,x,z) / app_remove(appId) / app_open(appId=オーバーレイでアプリを開いて見せる) / ' +
    'app_point(appId,selector,note?=開いているアプリ内の要素を赤い矢印で指す。「ここを押して」の視覚誘導)。' +
    '世界はあなたの身体でありキャンバス。説明は文章だけでなく spawn での図解や身振りで「見せる」こと。' +
    'ユーザーへの返事は必ず say を含めること(世界のユーザーには say しか見えない)。',
  inputSchema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        description: 'コマンド列(最大30件)。上から順に実行される',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['say', 'motion', 'move_to', 'spawn', 'remove', 'camera', 'app_add', 'app_move', 'app_remove', 'app_open', 'app_point'] },
            app: {
              type: 'object',
              description: 'app_add: {id(小文字英数-), name, description?, x, z, ry?, kioskCode?}',
              properties: {
                id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
                x: { type: 'number' }, z: { type: 'number' }, ry: { type: 'number' },
                kioskCode: { type: 'string', description: '社の外観(THREEを受けObject3Dをreturn)' },
              },
              required: ['id', 'name', 'x', 'z'],
            },
            appId: { type: 'string', description: 'app_move/app_remove/app_open/app_point: 対象アプリid' },
            selector: { type: 'string', description: 'app_point: 指す要素のCSSセレクタ' },
            note: { type: 'string', description: 'app_point: 矢印に添える一言' },
            text: { type: 'string', description: 'say: セリフ' },
            name: { type: 'string', description: 'motion: idle|guard|jab|hook|kick|walk|sit' },
            x: { type: 'number', description: 'move_to/spawn: X座標' },
            z: { type: 'number', description: 'move_to/spawn: Z座標' },
            y: { type: 'number', description: 'spawn: 設置高さ(省略時は接地)' },
            id: { type: 'string', description: 'spawn/remove: オブジェクトID' },
            shape: { type: 'string', enum: ['box', 'sphere', 'cylinder', 'cone', 'torus', 'sign', 'screen'] },
            color: { type: 'string', description: 'spawn: #rrggbb(screenでは文字色)' },
            bg: { type: 'string', description: 'spawn(screen): 背景色 #rrggbb(既定は黒)' },
            ry: { type: 'number', description: 'spawn(sign/screen): Y軸回転(ラジアン)。画面の向き' },
            sx: { type: 'number', description: 'spawn: 幅m(既定1)' },
            sy: { type: 'number', description: 'spawn: 高さm(既定1)' },
            sz: { type: 'number', description: 'spawn: 奥行m(既定1)' },
            label: { type: 'string', description: 'spawn(sign): 看板に描く文字' },
            code: { type: 'string', description: 'spawn(custom): THREEを受けObject3Dをreturnする関数本体(自由造形)' },
            target: { type: 'string', enum: ['avatar', 'overview', 'object'] },
          },
          required: ['type'],
        },
      },
    },
    required: ['actions'],
  },
  risk: 'safe',
  tags: ['世界'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.world) {
      return { content: 'このセッションには世界ブリッジが注入されていない(進化ジョブ等では使えない)', isError: true };
    }
    const { actions } = (input ?? {}) as { actions?: unknown };
    const v = validate(actions);
    if (!v.ok) return { content: v.error, isError: true };
    const r = await ctx.world.act(v.cmds);
    return { content: r.detail, isError: !r.ok };
  },
} satisfies ToolPlugin;
