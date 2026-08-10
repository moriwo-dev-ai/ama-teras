/** M173(C工事): 世界アプリ注入ヘルパーを共有化 — アプリ内サーバとworld-serverの両方が使う */
/** 世界アプリへ注入する操作ヘルパー。親(world.html)からの {amaWorldOp} を実行して結果を返す。
 * M129: window.amaWorld.publish(state) — アプリが自分の状態を世界へ発信し、社の3D(kioskCodeのtick第3引数)に反映できる */
export const WORLD_APP_HELPER = `
<script>
(function () {
  window.amaWorld = {
    publish: function (state) {
      try { window.parent.postMessage({ amaWorldState: state }, '*'); } catch (e) {}
    },
  };
  // M142: アプリを開き直した時、親が最後のpublish状態を送り返す(amaWorldRestore)。
  // アプリ側は window.amaWorldOnRestore(state) を定義すればUIを実状態に同期できる
  // (例: 月アプリが進行中の落下タイマーを表示し続ける)。未定義なら amaWorldLastState に保持のみ
  window.addEventListener('message', function (ev) {
    if (ev.data && 'amaWorldRestore' in ev.data) {
      window.amaWorldLastState = ev.data.amaWorldRestore;
      if (typeof window.amaWorldOnRestore === 'function') {
        try { window.amaWorldOnRestore(ev.data.amaWorldRestore); } catch (e) {}
      }
    }
  });
  window.addEventListener('message', function (ev) {
    var req = ev.data && ev.data.amaWorldOp;
    if (!req || typeof req.op !== 'string') return;
    var src = ev.source || window.parent;
    function reply(payload) {
      payload.reqId = req.reqId;
      try { src.postMessage({ amaWorldOpResult: payload }, '*'); } catch (e) {}
    }
    try {
      // M166: scan=押せる物の列挙(ヒナタの「子どもの手」用。selector不要・副作用なし)
      if (req.op === 'scan') {
        var els = document.querySelectorAll('button, input, select, textarea, a, [onclick], [role="button"]');
        var out = [];
        var selOf = function (n) {
          var parts = [];
          while (n && n !== document.body && parts.length < 6) {
            var i = 1, s = n;
            while ((s = s.previousElementSibling) !== null) i++;
            parts.unshift(n.tagName.toLowerCase() + ':nth-child(' + i + ')');
            n = n.parentElement;
          }
          return parts.join('>');
        };
        for (var k = 0; k < els.length && out.length < 12; k++) {
          var e2 = els[k];
          var r2 = e2.getBoundingClientRect();
          if (r2.width < 2 || r2.height < 2) continue;
          var lb = String(e2.value || e2.textContent || e2.placeholder || e2.getAttribute('aria-label') || '').trim().slice(0, 12);
          out.push({ sel: selOf(e2), label: lb, kind: e2.tagName.toLowerCase() });
        }
        var scr = String(document.body.innerText || '').split('\\n').join(' ').split('"').join('').slice(0, 160);
        reply({ ok: true, items: out, text: scr });
        return;
      }
      var el = document.querySelector(req.selector);
      if (!el) { reply({ ok: false, error: 'selector が見つからない: ' + req.selector }); return; }
      if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      if (req.op === 'click') {
        el.click();
      } else if (req.op === 'type') {
        if (el.focus) el.focus();
        if ('value' in el) {
          el.value = req.text == null ? '' : String(req.text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          el.textContent = req.text == null ? '' : String(req.text);
        }
      }
      // op === 'rect'(app_pointの位置取得)/ 'read' は副作用なし
      var r = el.getBoundingClientRect();
      var text = ('value' in el && el.value !== '') ? el.value : (el.textContent || '');
      reply({ ok: true, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, text: String(text).slice(0, 500) });
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err) });
    }
  });
})();
</script>`;
