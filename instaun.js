(() => {
  'use strict';

  // ── GUARD ────────────────────────────────────────────────────────
  if (location.hostname !== 'www.instagram.com') {
    alert('Instagram Desfollowers: ejecuta esto en www.instagram.com'); return;
  }
  if (window.__iu_running__) {
    document.getElementById('__iu_root__')?.remove();
    window.__iu_running__ = false; return;
  }
  window.__iu_running__ = true;

  // ── CONSTANTS ────────────────────────────────────────────────────
  const SK = { WL:'iu_wl_v3', CFG:'iu_cfg_v3', RESUME:'iu_res_v3', LOG:'iu_log_v3' };
  const PER_PAGE = 50;
  const GQL_HASH = '3dec7e2c57367ef3da3d987d89f9dbc8';
  const RESUME_TTL = 86400000; // 24h (#3 fix — was 1h)
  const DAILY_LIMIT = 150;     // safe daily unfollow limit (#6)

  const DEFAULT_CFG = {
    delayBetweenRequests  : 1200,
    delayBurst            : 12000,
    delayBetweenUnfollows : 4000,
    delayBurstUnfollows   : 300000,
    batchSizeRequests     : 6,
    batchSizeUnfollows    : 5,
    adaptiveDelay         : true,
    confirmUnfollow       : true,
    perUserConfirm        : false, // #20
  };

  // ── STATE ────────────────────────────────────────────────────────
  const S = {
    phase        : 'idle',   // idle | scanning | paused | unfollowing | done
    users        : [],       // following list
    selected     : new Set(),
    whitelist    : new Set(),
    filter       : { nonFollowers:true, followers:false, verified:true, private:true, noAvatar:true },
    search       : '',
    page         : 1,
    tab          : 'non_whitelisted',  // non_whitelisted | whitelisted | mutual | ghost
    scan         : { cursor:'', total:0, fetched:0, reqs:0, retries:0, startedAt:0 },
    unfollow     : { queue:[], log:[], idx:0, paused:false, skipId:null },
    cfg          : { ...DEFAULT_CFG },
    adaptiveMs   : 1200,
    settingsOpen : false,
    wlImportMode : 'merge',
    // dirty flags per section (#14)
    dirty        : { header:true, sidebar:true, main:true, settings:true },
  };

  // ── PERSISTENCE ──────────────────────────────────────────────────
  const lsGet = (k, fb)  => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
  const lsSet = (k, v)   => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const lsDel = (k)      => { try { localStorage.removeItem(k); } catch {} };

  const loadWL  = () => new Set(lsGet(SK.WL, []));
  const saveWL  = () => lsSet(SK.WL, [...S.whitelist]);
  const loadCfg = () => ({ ...DEFAULT_CFG, ...lsGet(SK.CFG, {}) });
  const saveCfg = () => lsSet(SK.CFG, S.cfg);

  // Debounced saveResume (#2 fix)
  let _resumeTimer = null;
  const saveResume = () => {
    clearTimeout(_resumeTimer);
    _resumeTimer = setTimeout(() => {
      lsSet(SK.RESUME, { users:S.users, cursor:S.scan.cursor, total:S.scan.total, fetched:S.scan.fetched, at:Date.now() });
    }, 3000);
  };

  // Cross-session unfollow log (#10, #19)
  const loadUnfollowLog = () => lsGet(SK.LOG, []);
  const appendUnfollowLog = (entry) => {
    const log = loadUnfollowLog();
    log.unshift({ username:entry.user.username, id:entry.user.id, ok:entry.ok, at:Date.now() });
    lsSet(SK.LOG, log.slice(0, 500)); // keep last 500
  };
  // daily count (#6)
  const todayUnfollowCount = () => {
    const today = new Date().toDateString();
    return loadUnfollowLog().filter(e => e.ok && new Date(e.at).toDateString() === today).length;
  };

  // ── UTILITIES ────────────────────────────────────────────────────
  const sleep   = ms  => new Promise(r => setTimeout(r, ms));
  const jitter  = ms  => ms + Math.floor(Math.random() * ms * 0.3);
  const fmtTime = ms  => ms < 60000 ? `${Math.round(ms/1000)}s` : `${Math.round(ms/60000)}m`;
  const esc     = s   => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const getCsrf = ()  => { const p = `; ${document.cookie}`.split('; csrftoken='); return p.length===2 ? p.pop().split(';').shift() : null; };
  const getDsUid= ()  => { const p = `; ${document.cookie}`.split('; ds_user_id='); return p.length===2 ? p.pop().split(';').shift() : null; };
  const byId    = id  => document.getElementById(id);

  // #4 fix — robust no-avatar detection (structural + known IDs)
  const DEFAULT_AV_IDS = ['44884218_345707102882519','464760996_1254146839119862'];
  const noAvatar = url => !url || DEFAULT_AV_IDS.some(id => url.includes(id))
    || /\/(?:default|anonymous|blank)[\w_-]*\.(jpg|png|webp)/i.test(url);

  const gqlUrl = cursor => {
    const uid  = getDsUid();
    const base = `{"id":"${uid}","include_reel":"true","fetch_mutual":"false","first":"24"`;
    const vars = cursor ? `${base},"after":"${cursor}"}` : `${base}}`;
    return `https://www.instagram.com/graphql/query/?query_hash=${GQL_HASH}&variables=${encodeURIComponent(vars)}`;
  };
  const unfollowUrl = id => `https://www.instagram.com/web/friendships/${id}/unfollow/`;

  // ── DERIVED / FILTER (#13 — single pass) ─────────────────────────
  const computeDerived = () => {
    let mutual=0, ghost=0, verified=0, priv=0, noAv=0;
    const filtered = [];
    for (const u of S.users) {
      if (u.follows_viewer) mutual++; else ghost++;
      if (u.is_verified)    verified++;
      if (u.is_private)     priv++;
      if (noAvatar(u.profile_pic_url)) noAv++;

      const inWl = S.whitelist.has(u.id);
      if (S.tab === 'non_whitelisted' &&  inWl) continue;
      if (S.tab === 'whitelisted'     && !inWl) continue;
      if (S.tab === 'ghost'           &&  u.follows_viewer) continue;
      if (S.tab === 'mutual'          && !u.follows_viewer) continue;
      // category filters only apply on non_whitelisted/whitelisted tabs
      const structuralTab = S.tab === 'ghost' || S.tab === 'mutual';
      if (!structuralTab) {
        if (!S.filter.followers    &&  u.follows_viewer) continue;
        if (!S.filter.nonFollowers && !u.follows_viewer) continue;
        if (!S.filter.verified     &&  u.is_verified)    continue;
        if (!S.filter.private      &&  u.is_private)     continue;
        if (!S.filter.noAvatar     &&  noAvatar(u.profile_pic_url)) continue;
      } else {
        // on ghost/mutual still apply search and noAvatar filter
        if (!S.filter.verified &&  u.is_verified)          continue;
        if (!S.filter.private  &&  u.is_private)           continue;
        if (!S.filter.noAvatar &&  noAvatar(u.profile_pic_url)) continue;
      }
      if (S.search) {
        const q = S.search.toLowerCase();
        if (!u.username.toLowerCase().includes(q) && !u.full_name?.toLowerCase().includes(q)) continue;
      }
      filtered.push(u);
    }
    filtered.sort((a, b) => a.username.localeCompare(b.username));
    return { filtered, stats:{ total:S.users.length, mutual, ghost, verified, priv, noAv, ratio: S.users.length ? Math.round(mutual/S.users.length*100) : 0 } };
  };

  const getPage = all => all.slice((S.page-1)*PER_PAGE, S.page*PER_PAGE);
  const maxPage = all => Math.max(1, Math.ceil(all.length / PER_PAGE));

  // ETA calc (#9)
  const calcETA = () => {
    if (!S.scan.total || !S.scan.fetched || !S.scan.startedAt) return null;
    const elapsed = Date.now() - S.scan.startedAt;
    const rate    = S.scan.fetched / elapsed;
    if (!rate) return null;
    const remaining = S.scan.total - S.scan.fetched;
    return Math.round(remaining / rate);
  };

  // ── DIRTY FLAG HELPERS (#14) ──────────────────────────────────────
  const markDirty = (...sections) => sections.forEach(s => S.dirty[s] = true);
  const markAllDirty = () => markDirty('header', 'sidebar', 'main', 'settings');

  // ── TOAST ────────────────────────────────────────────────────────
  let _toastTimer = null;
  const toast = (msg, type='info', dur=4000) => {
    const el = byId('__iu_toast__');
    if (!el) return;
    el.dataset.type = type;
    el.classList.remove('iu-t-hidden');
    el.classList.add('iu-t-show');
    const span = el.querySelector('.iu-t-msg');
    if (span) span.textContent = msg;
    clearTimeout(_toastTimer);
    if (dur > 0) _toastTimer = setTimeout(() => el.classList.replace('iu-t-show','iu-t-hidden'), dur);
  };

  // ── RENDER (dirty-flag gated) ─────────────────────────────────────
  let _derived = null; // cached per render cycle

  const render = (force = false) => {
    _derived = computeDerived(); // single pass per render
    if (force) markAllDirty();
    if (S.dirty.header)   { renderHeader();   S.dirty.header   = false; }
    if (S.dirty.sidebar)  { renderSidebar();  S.dirty.sidebar  = false; }
    if (S.dirty.main)     { renderMain();     S.dirty.main     = false; }
    if (S.dirty.settings) { renderSettings(); S.dirty.settings = false; }
    // #18 — update document title
    if (S.phase === 'scanning' && S.scan.total) {
      const pct = Math.round(S.scan.fetched / S.scan.total * 100);
      document.title = `(${pct}%) Instagram Desfollowers`;
    } else if (S.phase === 'unfollowing') {
      document.title = `(${S.unfollow.idx}/${S.unfollow.queue.length}) Instagram Desfollowers`;
    } else {
      document.title = 'Instagram Desfollowers';
    }
  };

  // ── RENDER HEADER ────────────────────────────────────────────────
  const renderHeader = () => {
    const active = S.phase === 'scanning' || S.phase === 'unfollowing';
    const pct = S.scan.total ? Math.min(100, Math.round(S.scan.fetched/S.scan.total*100)) : 0;
    const pb = byId('__iu_progress__');
    if (pb) { pb.style.display = active ? 'block':'none'; pb.style.width = pct+'%'; }
    const sb = byId('__iu_search__');
    if (sb) sb.disabled = S.phase === 'idle';
    const hasData = S.phase !== 'idle';
    const exp = byId('__iu_hdr_export__');
    if (exp) exp.style.display = hasData ? 'flex' : 'none';
    const { filtered } = _derived;
    const pageUsers = getPage(filtered);
    const allSel  = filtered.length  > 0 && filtered.every(u => S.selected.has(u.id));
    const pageSel = pageUsers.length > 0 && pageUsers.every(u => S.selected.has(u.id));
    const ca = byId('__iu_chk_all__');
    const cp = byId('__iu_chk_page__');
    if (ca) { ca.checked = allSel;  ca.style.display = hasData ? '' : 'none'; }
    if (cp) { cp.checked = pageSel; cp.style.display = hasData ? '' : 'none'; }
  };

  // ── RENDER SIDEBAR ────────────────────────────────────────────────
  const renderSidebar = () => {
    const sidebar = byId('__iu_sidebar__');
    if (!sidebar) return;
    if (S.phase === 'idle') { sidebar.innerHTML = ''; return; }
    const { filtered, stats:st } = _derived;
    const mp = maxPage(filtered);
    const scanRunning = S.phase === 'scanning';
    const scanPaused  = S.phase === 'paused';
    const dailyCount  = todayUnfollowCount(); // #6
    const eta = calcETA(); // #9
    sidebar.innerHTML = `
      <div class="iu-stats">
        <div class="iu-sr"><span>Siguiendo</span><b>${st.total}</b></div>
        <div class="iu-sr"><span>Mutuos</span><b class="iu-g">${st.mutual}</b></div>
        <div class="iu-sr"><span>No te siguen</span><b class="iu-r">${st.ghost}</b></div>
        <div class="iu-sr"><span>% Seguimiento mutuo</span><b>${st.ratio}%</b></div>
        ${S.scan.total ? `<div class="iu-sr iu-sr-scan"><span>Escaneado</span><b>${S.scan.fetched}/${S.scan.total}</b></div>` : ''}
        ${eta ? `<div class="iu-sr"><span>Tiempo restante</span><b class="iu-eta">~${fmtTime(eta)}</b></div>` : ''}
      </div>
      <div class="iu-daily-bar">
        <div class="iu-daily-lbl">
          <span>Desfollows hoy</span>
          <b class="${dailyCount >= DAILY_LIMIT ? 'iu-r' : dailyCount > DAILY_LIMIT*0.7 ? 'iu-warn-txt' : ''}">${dailyCount}/${DAILY_LIMIT}</b>
        </div>
        <div class="iu-bar"><div class="iu-bar-fill ${dailyCount>=DAILY_LIMIT?'iu-bar-red':dailyCount>DAILY_LIMIT*0.7?'iu-bar-warn':''}" style="width:${Math.min(100,Math.round(dailyCount/DAILY_LIMIT*100))}%"></div></div>
      </div>
      <hr class="iu-hr">
      <p class="iu-lbl">Filtros</p>
      <label class="iu-chk-row"><input type="checkbox" data-action="filter" data-key="nonFollowers" ${S.filter.nonFollowers?'checked':''}> No te siguen</label>
      <label class="iu-chk-row"><input type="checkbox" data-action="filter" data-key="followers"    ${S.filter.followers?'checked':''}> Te siguen</label>
      <label class="iu-chk-row"><input type="checkbox" data-action="filter" data-key="verified"     ${S.filter.verified?'checked':''}> Verificados</label>
      <label class="iu-chk-row"><input type="checkbox" data-action="filter" data-key="private"      ${S.filter.private?'checked':''}> Privados</label>
      <label class="iu-chk-row"><input type="checkbox" data-action="filter" data-key="noAvatar"     ${S.filter.noAvatar?'checked':''}> Sin foto</label>
      <hr class="iu-hr">
      <p class="iu-lbl">Selección rápida</p>
      <div class="iu-smart-grid">
        <button class="iu-sec-btn" data-action="smart-select" data-type="ghost">No te siguen</button>
        <button class="iu-sec-btn" data-action="smart-select" data-type="verified">Verificados</button>
        <button class="iu-sec-btn" data-action="smart-select" data-type="private">Privados</button>
        <button class="iu-sec-btn" data-action="smart-select" data-type="noAvatar">Sin foto</button>
        <button class="iu-sec-btn iu-danger" data-action="clear-selection">✕ Limpiar</button>
      </div>
      <hr class="iu-hr">
      <div class="iu-stats">
        <div class="iu-sr"><span>Seleccionados</span><b>${S.selected.size}</b></div>
        <div class="iu-sr"><span>Lista blanca</span><b class="iu-gold">★ ${S.whitelist.size}</b></div>
        <div class="iu-sr"><span>Mostrados</span><b>${filtered.length}</b></div>
      </div>
      <hr class="iu-hr">
      ${scanRunning ? `<button class="iu-ctrl-btn" data-action="pause-scan">⏸ Pausar escaneo</button>` : ''}
      ${scanPaused  ? `<button class="iu-ctrl-btn" data-action="resume-scan">▶ Continuar escaneo</button>` : ''}
      ${(scanRunning||scanPaused) ? `<button class="iu-ctrl-btn" data-action="save-resume">💾 Guardar progreso</button>` : ''}
      <hr class="iu-hr">
      <div class="iu-pag">
        <button class="iu-pag-btn" data-action="page" data-dir="-1" ${S.page<=1?'disabled':''}>‹</button>
        <input class="iu-page-input" id="__iu_page_inp__" type="number" min="1" max="${mp}" value="${S.page}" data-action="page-jump" title="Ir a página">
        <span class="iu-page-total">/ ${mp}</span>
        <button class="iu-pag-btn" data-action="page" data-dir="1" ${S.page>=mp?'disabled':''}>›</button>
      </div>
      ${S.phase !== 'unfollowing' ? `
        <button class="iu-unfollow-btn" data-action="start-unfollow"
          ${S.selected.size===0||dailyCount>=DAILY_LIMIT?'disabled':''}
          title="${dailyCount>=DAILY_LIMIT?'Límite diario alcanzado':'Dejar de seguir seleccionados'}">
          ${dailyCount>=DAILY_LIMIT ? '⚠ Límite diario alcanzado' : `DEJAR DE SEGUIR (${S.selected.size})`}
        </button>
      ` : `
        <button class="iu-unfollow-btn iu-unfollow-pause" data-action="toggle-unfollow-pause">
          ${S.unfollow.paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <div class="iu-uf-prog">
          ${S.unfollow.idx} / ${S.unfollow.queue.length}
          <div class="iu-bar"><div class="iu-bar-fill" style="width:${Math.round(S.unfollow.idx/Math.max(1,S.unfollow.queue.length)*100)}%"></div></div>
        </div>
      `}
    `;
  };

  // ── SKELETON (#17) ───────────────────────────────────────────────
  const skeletonCards = (n=5) => Array.from({length:n}, ()=>`
    <div class="iu-card iu-skeleton">
      <div class="iu-sk-av"></div>
      <div class="iu-sk-info">
        <div class="iu-sk-line iu-sk-w60"></div>
        <div class="iu-sk-line iu-sk-w40"></div>
        <div class="iu-sk-line iu-sk-w30"></div>
      </div>
    </div>
  `).join('');

  // ── RENDER MAIN ───────────────────────────────────────────────────
  const renderMain = () => {
    const main = byId('__iu_main__');
    if (!main) return;

    if (S.phase === 'idle') {
      const saved    = lsGet(SK.RESUME, null);
      const canResume= saved && (Date.now() - saved.at) < RESUME_TTL;
      const hist     = loadUnfollowLog().slice(0, 5);
      main.innerHTML = `
        <div class="iu-idle">
          <div class="iu-idle-hero">
            <button class="iu-run-btn" data-action="start-scan">
              <span class="iu-run-icon">🕵️</span>
              <span class="iu-run-label">Iniciar</span>
            </button>
            <p class="iu-run-hint">Analiza a quién sigues en Instagram</p>
          </div>
          ${canResume ? `
            <button class="iu-resume-saved-btn" data-action="resume-saved">
              ↩ Continuar escaneo anterior<br>
              <small>${saved.fetched}/${saved.total} cuentas · hace ${Math.round((Date.now()-saved.at)/60000)}m</small>
            </button>` : ''}
          ${hist.length ? `
            <div class="iu-idle-hist">
              <p class="iu-idle-hist-lbl">Últimos desfollows</p>
              ${hist.map(e=>`<span class="iu-idle-hist-item ${e.ok?'':'iu-fail-txt'}">@${esc(e.username)}</span>`).join('')}
            </div>` : ''}
        </div>
      `;
      return;
    }

    if (S.phase === 'unfollowing') {
      const log  = S.unfollow.log;
      const done = S.unfollow.idx >= S.unfollow.queue.length && S.unfollow.queue.length > 0;
      main.innerHTML = `
        <nav class="iu-tabs"><div class="iu-tab iu-tab-active">Registro de desfollows</div></nav>
        <div class="iu-log">
          ${done ? `<div class="iu-done">✓ Done — ${log.filter(l=>l.ok).length} dejados de seguir, ${log.filter(l=>!l.ok).length} fallidos</div>` : ''}
          ${!log.length ? '<div class="iu-log-empty">Iniciando…</div>' : ''}
          ${[...log].reverse().map((e,i) => `
            <div class="iu-log-row ${e.ok?'iu-ok':'iu-fail'}">
              <span>${e.ok?'✓':'✗'}</span>
              <a href="/${esc(e.user.username)}" target="_blank" rel="noreferrer">@${esc(e.user.username)}</a>
              <span class="iu-log-n">[${log.length-i}/${S.unfollow.queue.length}]</span>
              ${e.error ? `<span class="iu-log-err">${esc(e.error)}</span>` : ''}
            </div>`).join('')}
        </div>
      `;
      return;
    }

    const { filtered } = _derived;
    const pageUsers = getPage(filtered);
    const mp = maxPage(filtered);
    // Reset tab if it was on whitelisted (now removed)
    if (S.tab === 'whitelisted') S.tab = 'non_whitelisted';

    main.innerHTML = `
      <nav class="iu-tabs" id="__iu_tabs__">
        <div class="iu-tab ${S.tab==='non_whitelisted'?'iu-tab-active':''}" data-action="set-tab" data-tab="non_whitelisted">
          Todos <span class="iu-tab-count">${S.users.length}</span>
        </div>
        <div class="iu-tab ${S.tab==='ghost'?'iu-tab-active':''}" data-action="set-tab" data-tab="ghost">
          No te siguen <span class="iu-tab-count">${_derived.stats.ghost}</span>
        </div>
        <div class="iu-tab ${S.tab==='mutual'?'iu-tab-active':''}" data-action="set-tab" data-tab="mutual">
          Mutuos <span class="iu-tab-count">${_derived.stats.mutual}</span>
        </div>
      </nav>
      <div class="iu-results" id="__iu_results__">
        ${!pageUsers.length
          ? (S.phase==='scanning'
              ? skeletonCards(5)  // #17
              : '<div class="iu-empty">Sin resultados para los filtros actuales.</div>')
          : pageUsers.map(u => renderCard(u)).join('')}
        ${pageUsers.length && mp > 1 ? `
          <div class="iu-bottom-pag">
            <button class="iu-pag-btn" data-action="page" data-dir="-1" ${S.page<=1?'disabled':''}>‹ Anterior</button>
            <span>${S.page} / ${mp}</span>
            <button class="iu-pag-btn" data-action="page" data-dir="1" ${S.page>=mp?'disabled':''}>Siguiente ›</button>
          </div>` : ''}
      </div>
    `;
  };

  const renderCard = u => {
    const sel  = S.selected.has(u.id);
    const inWl = S.whitelist.has(u.id);
    return `
      <label class="iu-card ${sel?'iu-card-sel':''}">
        <div class="iu-av-wrap" data-action="toggle-wl" data-uid="${esc(u.id)}" title="${inWl?'Quitar de lista blanca':'Agregar a lista blanca'}">
          <img class="iu-av" src="${esc(u.profile_pic_url)}" alt="${esc(u.username)}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><circle cx=%2220%22 cy=%2220%22 r=%2220%22 fill=%22%23333%22/></svg>'">
          <div class="iu-av-ov">${inWl?'★':'☆'}</div>
          <div class="iu-av-preview"><img src="${esc(u.profile_pic_url.replace('s150x150/','s320x320/'))}" alt="${esc(u.username)}" loading="lazy"></div>
        </div>
        <div class="iu-info">
          <span class="iu-uname">
            <a href="/${esc(u.username)}" target="_blank" rel="noreferrer">@${esc(u.username)}</a>
            ${u.is_verified ? '<span class="iu-ver" title="Verificado">✔</span>' : ''}
          </span>
          <span class="iu-fname">${esc(u.full_name||'')}</span>
          <div class="iu-badges">
            ${u.follows_viewer ? '<span class="iu-b-follows">Te sigue</span>' : '<span class="iu-b-ghost">No te sigue</span>'}
            ${u.is_private ? '<span class="iu-b-priv">Private</span>' : ''}
            ${inWl ? '<span class="iu-b-wl">★</span>' : ''}
          </div>
        </div>
        <input type="checkbox" class="iu-chk" data-action="toggle-user" data-uid="${esc(u.id)}" ${sel?'checked':''}>
      </label>
    `;
  };

  // ── RENDER SETTINGS ───────────────────────────────────────────────
  const renderSettings = () => {
    const panel = byId('__iu_settings__');
    if (!panel) return;
    panel.style.display = S.settingsOpen ? 'flex' : 'none';
    if (!S.settingsOpen) return;
    const c = S.cfg;
    panel.innerHTML = `
      <div class="iu-backdrop" data-action="close-settings"></div>
      <div class="iu-modal">
        <h3>Configuración</h3>
        <p class="iu-s-lbl">Tiempos de escaneo</p>
        <div class="iu-row">
          <label>Retardo entre peticiones (ms)</label>
          <input id="__iu_s_req__" type="number" value="${c.delayBetweenRequests}" min="500" max="30000">
        </div>
        <div class="iu-row">
          <label>Pausa cada ${c.batchSizeRequests} peticiones (ms)</label>
          <input id="__iu_s_burst__" type="number" value="${c.delayBurst}" min="2000" max="120000">
        </div>
        <div class="iu-row">
          <label><input id="__iu_s_adap__" type="checkbox" ${c.adaptiveDelay?'checked':''}> Retardo adaptativo (reduce velocidad en 429)</label>
        </div>
        <p class="iu-s-lbl">Tiempos de desfollows</p>
        <div class="iu-row">
          <label>Retardo entre desfollows (ms)</label>
          <input id="__iu_s_unf__" type="number" value="${c.delayBetweenUnfollows}" min="1000" max="30000">
        </div>
        <div class="iu-row">
          <label>Pausa cada ${c.batchSizeUnfollows} desfollows (ms)</label>
          <input id="__iu_s_ufb__" type="number" value="${c.delayBurstUnfollows}" min="60000" max="600000">
        </div>
        <p class="iu-s-lbl">Comportamiento de desfollows</p>
        <div class="iu-row">
          <label><input id="__iu_s_conf__" type="checkbox" ${c.confirmUnfollow?'checked':''}> Confirmar antes de iniciar desfollows</label>
        </div>
        <div class="iu-row">
          <label><input id="__iu_s_peruser__" type="checkbox" ${c.perUserConfirm?'checked':''}> Confirmar cada usuario individualmente</label>
        </div>
        <div class="iu-warn">
          <b>⚠ Warning:</b> Reducir los tiempos aumenta el riesgo de ban. Instagram limita ~${DAILY_LIMIT} desfollows/día.
        </div>
        <hr class="iu-hr">
        <p class="iu-s-lbl">Lista blanca (${S.whitelist.size} usuarios)</p>
        <div class="iu-btn-row">
          <button class="iu-btn iu-btn-blue"  data-action="wl-export">📥 Exportar</button>
          <button class="iu-btn iu-btn-green" data-action="wl-import" data-mode="merge">📤 Fusionar</button>
          <button class="iu-btn iu-btn-green" data-action="wl-import" data-mode="replace">📤 Reemplazar</button>
          <button class="iu-btn iu-btn-red"   data-action="wl-clear" ${S.whitelist.size===0?'disabled':''}>🗑 Vaciar</button>
        </div>
        <hr class="iu-hr">
        <p class="iu-s-lbl">Historial de desfollows</p>
        <div class="iu-unfollow-hist-wrap" id="__iu_hist__">${renderHistoryHtml()}</div>
        <div class="iu-modal-footer">
          <button class="iu-btn" data-action="close-settings">Cancelar</button>
          <button class="iu-btn iu-btn-blue" data-action="save-settings">Guardar</button>
        </div>
      </div>
    `;
  };

  const renderHistoryHtml = () => {
    const log = loadUnfollowLog().slice(0, 20);
    if (!log.length) return '<p style="color:#555;font-size:.78rem">Sin historial aún.</p>';
    return `<div class="iu-hist-list">${log.map(e=>`
      <div class="iu-hist-row ${e.ok?'':'iu-fail-row'}">
        <span>@${esc(e.username)}</span>
        <span class="iu-hist-date">${new Date(e.at).toLocaleDateString()}</span>
      </div>`).join('')}</div>`;
  };

  // ── SCAN ENGINE ───────────────────────────────────────────────────
  let _scanActive = false, _scanPaused = false, _scanRunning = false;
  let _seenIds = new Set(); // dedup guard — prevents any user appearing twice

  const _resetScanState = () => {
    _scanActive = false; _scanPaused = false; _scanRunning = false;
    _seenIds = new Set();
    clearTimeout(_resumeTimer); // cancel any pending save
  };

  // Safe push: ignores users already seen in this session
  const _pushUsers = (nodes) => {
    let added = 0;
    for (const node of nodes) {
      if (node?.id && !_seenIds.has(node.id)) {
        _seenIds.add(node.id);
        S.users.push(node);
        added++;
      }
    }
    return added;
  };

  const startScan = async () => {
    if (S.phase !== 'idle') return;
    if (_scanRunning) return;
    _resetScanState();
    S.phase = 'scanning'; S.users = []; S.selected.clear();
    S.scan  = { cursor:'', total:0, fetched:0, reqs:0, retries:0, startedAt:Date.now() };
    S.adaptiveMs = S.cfg.delayBetweenRequests;
    _scanActive = true;
    markAllDirty(); render();
    await runScan();
  };

  const resumeFromSaved = () => {
    const saved = lsGet(SK.RESUME, null);
    if (!saved) return;
    if (_scanRunning) return;
    _resetScanState();
    // Deduplicate the saved users in case they were saved by a buggy version
    const cleanUsers = [];
    const seenSet    = new Set();
    for (const u of (saved.users || [])) {
      if (u?.id && !seenSet.has(u.id)) { seenSet.add(u.id); cleanUsers.push(u); }
    }
    S.phase  = 'scanning';
    S.users  = cleanUsers;
    S.scan   = { cursor:saved.cursor||'', total:saved.total||0, fetched:cleanUsers.length, reqs:0, retries:0, startedAt:Date.now() };
    S.adaptiveMs = S.cfg.delayBetweenRequests;
    _seenIds = seenSet; // seed dedup from loaded users
    _scanActive = true;
    markAllDirty(); render(); runScan();
  };

  const pauseScan = () => {
    _scanPaused = true;
    S.phase = 'paused';
    // Save immediately on pause (no debounce) so the state is always consistent
    clearTimeout(_resumeTimer);
    lsSet(SK.RESUME, { users:S.users, cursor:S.scan.cursor, total:S.scan.total, fetched:S.scan.fetched, at:Date.now() });
    markDirty('sidebar'); render();
  };

  const resumeScan = () => {
    // CRITICAL: do NOT call runScan() — the loop is alive, spinning on while(_scanPaused)
    _scanPaused = false;
    S.phase = 'scanning';
    markDirty('sidebar'); render();
    // Safety fallback: if loop somehow died, restart it
    if (!_scanRunning && _scanActive) runScan();
  };

  const doSaveResume = () => {
    clearTimeout(_resumeTimer);
    lsSet(SK.RESUME, { users:S.users, cursor:S.scan.cursor, total:S.scan.total, fetched:S.scan.fetched, at:Date.now() });
    toast('Progreso guardado — puedes cerrar y continuar en 24h', 'success');
  };

  const runScan = async () => {
    if (_scanRunning) return;
    _scanRunning = true;
    let batchN = 0, hasMore = true;
    while (hasMore && _scanActive) {
      while (_scanPaused && _scanActive) await sleep(500);
      if (!_scanActive) break;
      if (batchN > 0 && batchN % S.cfg.batchSizeRequests === 0) {
        const w = jitter(S.cfg.delayBurst);
        toast(`Pausa de caudal: ${fmtTime(w)}…`, 'info', w);
        await sleep(w);
      }
      const r = await fetchPage(S.scan.cursor);
      if (!r) {
        S.scan.retries++;
        if (S.scan.retries > 5) { toast('Demasiados errores — escaneo detenido', 'error'); break; }
        await sleep(jitter(S.adaptiveMs * 2)); continue;
      }
      if (r.status === 429) {
        S.adaptiveMs = Math.min(S.adaptiveMs * 2, 30000);
        toast(`Límite de velocidad — esperando ${fmtTime(S.adaptiveMs)}`, 'warning', S.adaptiveMs);
        await sleep(S.adaptiveMs); continue;
      }
      if (!r.ok) { await sleep(jitter(S.adaptiveMs)); continue; }
      const ef = r.data?.data?.user?.edge_follow;
      if (!ef) { toast('Respuesta inesperada de la API', 'error'); break; }
      if (!S.scan.total) S.scan.total = ef.count;
      const added = _pushUsers(ef.edges.map(e => e.node)); // dedup-safe push
      S.scan.fetched += added; // count only truly new users
      S.scan.cursor   = ef.page_info.end_cursor || '';
      S.scan.reqs++; batchN++;
      hasMore = ef.page_info.has_next_page;
      if (S.cfg.adaptiveDelay) S.adaptiveMs = Math.max(S.cfg.delayBetweenRequests, S.adaptiveMs * 0.95);
      S.scan.retries = 0;
      saveResume(); // debounced — fires 3s after last page
      markDirty('header', 'sidebar', 'main');
      render();
      await sleep(jitter(S.adaptiveMs));
    }
    if (_scanActive && !_scanPaused) {
      S.phase = 'done'; _scanActive = false; _scanRunning = false;
      clearTimeout(_resumeTimer);
      lsDel(SK.RESUME);
      toast(`Escaneo completo — ${S.users.length} cuentas encontradas`, 'success', 8000);
    } else {
      _scanRunning = false;
    }
    markAllDirty(); render();
  };

  const fetchPage = async cursor => {
    try {
      const r = await fetch(gqlUrl(cursor), { credentials:'include', headers:{'x-ig-app-id':'936619743392459'} });
      if (r.status === 429) return { status:429 };
      if (!r.ok) return { ok:false };
      return { ok:true, data: await r.json() };
    } catch { return null; }
  };

  // ── UNFOLLOW ENGINE (#1 fix — no full render on each step) ────────
  const startUnfollow = () => {
    if (!S.selected.size) { toast('Selecciona al menos un usuario', 'warning'); return; }
    const dailyCount = todayUnfollowCount();
    if (dailyCount >= DAILY_LIMIT) { toast(`Límite diario (${DAILY_LIMIT}) alcanzado — intenta mañana`, 'error'); return; }
    if (S.cfg.confirmUnfollow && !confirm(`¿Dejar de seguir ${S.selected.size} cuenta(s)? Esta acción no se puede deshacer.`)) return;
    S.unfollow = { queue: S.users.filter(u => S.selected.has(u.id)), log:[], idx:0, paused:false, skipId:null };
    S.phase = 'unfollowing';
    markAllDirty(); render();
    runUnfollow();
  };

  const toggleUnfollowPause = () => {
    S.unfollow.paused = !S.unfollow.paused;
    if (!S.unfollow.paused) runUnfollow();
    markDirty('sidebar'); render();
  };

  const runUnfollow = async () => {
    const csrf = getCsrf();
    if (!csrf) { toast('Token CSRF no encontrado — recarga Instagram', 'error'); return; }
    const { queue } = S.unfollow;
    while (S.unfollow.idx < queue.length) {
      if (S.unfollow.paused || S.phase !== 'unfollowing') return;
      // per-user confirm (#20)
      const user = queue[S.unfollow.idx];
      if (S.cfg.perUserConfirm && !confirm(`¿Dejar de seguir @${user.username}?`)) {
        S.unfollow.log.push({ user, ok:false, error:'Omitido' });
        S.unfollow.idx++;
        markDirty('main','sidebar'); render();
        continue;
      }
      // burst pause
      if (S.unfollow.idx > 0 && S.unfollow.idx % S.cfg.batchSizeUnfollows === 0) {
        const w = jitter(S.cfg.delayBurstUnfollows);
        toast(`Enfriando ${fmtTime(w)} para evitar ban…`, 'info', w);
        await sleep(w);
      }
      // check daily limit mid-run
      if (todayUnfollowCount() >= DAILY_LIMIT) {
        toast(`Límite diario (${DAILY_LIMIT}) alcanzado — detenido para proteger tu cuenta`, 'error', 0);
        S.unfollow.paused = true; markDirty('sidebar'); render(); return;
      }
      let ok = false, error = '';
      try {
        const r = await fetch(unfollowUrl(user.id), {
          method:'POST', credentials:'include',
          headers:{ 'content-type':'application/x-www-form-urlencoded', 'x-csrftoken':csrf },
        });
        if (r.status === 429) { error='Límite de velocidad'; await sleep(300000); }
        else if (!r.ok)       { error=`HTTP ${r.status}`; }
        else                  { ok=true; S.selected.delete(user.id); S.users = S.users.filter(u=>u.id!==user.id); }
      } catch(e) { error=e.message; }

      const entry = { user, ok, error };
      S.unfollow.log.push(entry);
      appendUnfollowLog(entry); // persist (#10, #19)
      S.unfollow.idx++;
      // #1 fix — only re-render main + sidebar, not header (which is expensive)
      markDirty('main','sidebar'); render();
      if (S.unfollow.idx < queue.length) await sleep(jitter(S.cfg.delayBetweenUnfollows));
    }
    const okCount = S.unfollow.log.filter(l=>l.ok).length;
    toast(`Listo: ${okCount} dejados de seguir, ${S.unfollow.log.length-okCount} fallidos`, 'success', 10000);
    S.phase = 'done';
    markAllDirty(); render();
  };

  // ── EXPORT ────────────────────────────────────────────────────────
  const dl = (blob, name) => { const a = Object.assign(document.createElement('a'), { href:URL.createObjectURL(blob), download:name }); a.click(); URL.revokeObjectURL(a.href); };
  const exportJSON = () => {
    const d = _derived.filtered;
    dl(new Blob([JSON.stringify({ meta:{ exportedAt:new Date().toISOString(), total:d.length }, users:d },null,2)],{type:'application/json'}), `ig_unfollowers_${Date.now()}.json`);
    toast(`${d.length} usuarios exportados como JSON`, 'success');
  };
  const exportCSV = () => {
    const d = _derived.filtered;
    const hdr = ['id','username','full_name','is_verified','is_private','follows_viewer'];
    const rows = d.map(u => hdr.map(k => typeof u[k]==='string' ? `"${u[k].replace(/"/g,'""')}"` : u[k]).join(','));
    dl(new Blob([[hdr.join(','),...rows].join('\n')],{type:'text/csv'}), `ig_unfollowers_${Date.now()}.csv`);
    toast(`${d.length} usuarios exportados como CSV`, 'success');
  };
  const copyList = () => {
    navigator.clipboard.writeText(_derived.filtered.map(u=>u.username).sort().join('\n'))
      .then(()=>toast(`${_derived.filtered.length} usuarios copiados`,'success'), ()=>toast('Error al copiar al portapapeles','error'));
  };

  // ── WHITELIST ─────────────────────────────────────────────────────
  const toggleWl = uid => { S.whitelist.has(uid) ? S.whitelist.delete(uid) : S.whitelist.add(uid); saveWL(); markAllDirty(); render(); };
  const clearWl  = () => { if (!confirm(`¿Vaciar lista blanca (${S.whitelist.size} usuarios)?`)) return; S.whitelist.clear(); saveWL(); toast('Lista blanca vaciada','success'); markAllDirty(); render(); };
  const exportWl = () => { const d=S.users.filter(u=>S.whitelist.has(u.id)); if(!d.length){toast('La lista blanca está vacía','warning');return;} dl(new Blob([JSON.stringify(d,null,2)],{type:'application/json'}),`ig_whitelist_${Date.now()}.json`); toast(`${d.length} usuarios exportados`,'success'); };
  const importWl = mode => { const fi=byId('__iu_wl_file__'); if(fi){S.wlImportMode=mode;fi.value='';fi.click();} };
  const onWlFile = file => {
    if (!file) return;
    const r = new FileReader();
    r.onload = e => { try { const arr=JSON.parse(e.target.result); if(!Array.isArray(arr))throw new Error('Se esperaba un array'); if(S.wlImportMode==='replace')S.whitelist.clear(); arr.forEach(u=>{if(u?.id)S.whitelist.add(u.id);}); saveWL(); toast(`Lista blanca ${S.wlImportMode==='merge'?'fusionada':'reemplazada'}: ${S.whitelist.size} en total`,'success'); markAllDirty(); render(); } catch(err){toast('Error al importar: '+err.message,'error');} };
    r.readAsText(file);
  };

  // ── SMART SELECT ──────────────────────────────────────────────────
  const smartSelect = type => {
    const target = _derived.filtered.filter(u =>
      type==='ghost'    ? !u.follows_viewer :
      type==='verified' ?  u.is_verified    :
      type==='private'  ?  u.is_private     :
      type==='noAvatar' ?  noAvatar(u.profile_pic_url) : false
    );
    target.forEach(u => S.selected.add(u.id));
    toast(`${target.length} seleccionados (${type})`,'info');
    markDirty('header','sidebar','main'); render();
  };

  // ── SETTINGS SAVE ────────────────────────────────────────────────
  const doSaveSettings = () => {
    const gN = id => Math.max(0, parseInt(byId(id)?.value||'0',10));
    const gB = id => !!byId(id)?.checked;
    S.cfg = { ...S.cfg,
      delayBetweenRequests  : Math.max(500,   gN('__iu_s_req__')),
      delayBurst            : Math.max(2000,  gN('__iu_s_burst__')),
      delayBetweenUnfollows : Math.max(1000,  gN('__iu_s_unf__')),
      delayBurstUnfollows   : Math.max(60000, gN('__iu_s_ufb__')),
      adaptiveDelay         : gB('__iu_s_adap__'),
      confirmUnfollow       : gB('__iu_s_conf__'),
      perUserConfirm        : gB('__iu_s_peruser__'),
    };
    saveCfg(); S.settingsOpen = false;
    toast('Configuración guardada','success'); markAllDirty(); render();
  };

  // ── APP LIFECYCLE ────────────────────────────────────────────────
  const goHome = () => {
    if (['scanning','unfollowing'].includes(S.phase) && !confirm('¿Detener y volver al inicio?')) return;
    _resetScanState();
    S.phase = 'idle'; S.users = []; S.selected.clear();
    S.scan  = { cursor:'', total:0, fetched:0, reqs:0, retries:0, startedAt:0 };
    markAllDirty(); render();
  };
  const closeApp = () => {
    if (['scanning','unfollowing'].includes(S.phase) && !confirm('¿Detener y cerrar?')) return;
    _resetScanState();
    document.getElementById('__iu_root__')?.remove();
    document.head.querySelectorAll('style[data-iu]').forEach(s=>s.remove());
    document.title = 'Instagram';
    window.__iu_running__ = false;
  };

  // ── EVENT DELEGATION ─────────────────────────────────────────────
  const scrollToTop = () => {
    const m = byId('__iu_main__');
    if (m) m.scrollTo({ top: 0, behavior: 'instant' });
  };

  const handleClick = e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    if (a==='start-scan')            { startScan(); return; }
    if (a==='resume-saved')          { resumeFromSaved(); return; }
    if (a==='pause-scan')            { pauseScan(); return; }
    if (a==='resume-scan')           { resumeScan(); return; }
    if (a==='save-resume')           { doSaveResume(); return; }
    if (a==='start-unfollow')        { startUnfollow(); return; }
    if (a==='toggle-unfollow-pause') { toggleUnfollowPause(); return; }
    if (a==='clear-selection')       { S.selected.clear(); markDirty('header','sidebar','main'); render(); return; }
    if (a==='set-tab')               { S.tab=el.dataset.tab; S.selected.clear(); S.page=1; markAllDirty(); render(); scrollToTop(); return; }
    if (a==='page')                  { const mp=maxPage(_derived.filtered); S.page=Math.max(1,Math.min(S.page+Number(el.dataset.dir),mp)); markDirty('header','sidebar','main'); render(); scrollToTop(); return; }
    if (a==='toggle-settings')       { S.settingsOpen=!S.settingsOpen; markDirty('settings'); render(); return; }
    if (a==='close-settings')        { S.settingsOpen=false; markDirty('settings'); render(); return; }
    if (a==='save-settings')         { doSaveSettings(); return; }
    if (a==='smart-select')          { smartSelect(el.dataset.type); return; }
    if (a==='export-json')           { exportJSON(); return; }
    if (a==='export-csv')            { exportCSV(); return; }
    if (a==='copy-list')             { copyList(); return; }
    if (a==='wl-export')             { exportWl(); return; }
    if (a==='wl-import')             { importWl(el.dataset.mode); return; }
    if (a==='wl-clear')              { clearWl(); return; }
    if (a==='close-toast')           { byId('__iu_toast__')?.classList.replace('iu-t-show','iu-t-hidden'); return; }
    if (a==='go-home')               { goHome(); return; }
    if (a==='close-app')             { closeApp(); return; }
    if (a==='toggle-wl')             { e.preventDefault(); e.stopPropagation(); toggleWl(el.dataset.uid); return; }
  };

  const handleChange = e => {
    const el=e.target, a=el.dataset.action;
    if (!a) return;
    if (a==='filter')      { S.filter[el.dataset.key]=el.checked; S.page=1; markAllDirty(); render(); return; }
    if (a==='toggle-user') { el.checked?S.selected.add(el.dataset.uid):S.selected.delete(el.dataset.uid); markDirty('header','sidebar'); render(); return; }
    if (a==='select-all')  { const f=_derived.filtered; el.checked?f.forEach(u=>S.selected.add(u.id)):f.forEach(u=>S.selected.delete(u.id)); markDirty('header','sidebar','main'); render(); return; }
    if (a==='select-page') { getPage(_derived.filtered).forEach(u=>el.checked?S.selected.add(u.id):S.selected.delete(u.id)); markDirty('header','sidebar','main'); render(); return; }
    if (a==='wl-file')     { onWlFile(el.files?.[0]); el.value=''; return; }
  };

  const handleInput = e => {
    const el=e.target;
    if (el.id==='__iu_search__')    { S.search=el.value; S.page=1; markDirty('header','sidebar','main'); render(); return; }
    if (el.dataset.action==='page-jump') { /* handled on change */ }
  };

  // page-jump input (#12)
  const handlePageJump = e => {
    const el = e.target;
    if (el.dataset.action !== 'page-jump') return;
    const mp  = maxPage(_derived?.filtered ?? []);
    const val = Math.max(1, Math.min(parseInt(el.value||'1',10), mp));
    if (isNaN(val)) return;
    S.page = val;
    markDirty('header','sidebar','main'); render(); scrollToTop();
  };

  // ── KEYBOARD (#11) ───────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (!window.__iu_running__) return;
    const tag = document.activeElement?.tagName;
    if (tag==='INPUT'||tag==='TEXTAREA') return; // don't hijack while typing
    if (e.key==='Escape' && S.settingsOpen)  { S.settingsOpen=false; markDirty('settings'); render(); return; }
    if (e.ctrlKey && e.key==='f')            { e.preventDefault(); byId('__iu_search__')?.focus(); return; }
    if (S.phase==='idle') return;
    if (e.key==='ArrowLeft'  || e.key==='h') { const mp=maxPage(_derived.filtered); if(S.page>1){S.page--;markDirty('header','sidebar','main');render();scrollToTop();} return; }
    if (e.key==='ArrowRight' || e.key==='l') { const mp=maxPage(_derived.filtered); if(S.page<mp){S.page++;markDirty('header','sidebar','main');render();scrollToTop();} return; }
  });

  // ── STYLES ───────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.setAttribute('data-iu','1');
  style.textContent = `
    *,*::before,*::after{box-sizing:border-box}
    html,body{margin:0;background:#0e0e0e !important;color-scheme:dark}

    #__iu_root__{
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
      color:#e8e8e8;display:flex;flex-direction:column;
      min-height:100vh;background:#0e0e0e;
      -webkit-font-smoothing:antialiased;
    }

    /* PROGRESS */
    #__iu_progress__{position:fixed;top:0;left:0;height:2px;background:linear-gradient(90deg,#0a84ff,#30d158);transition:width .4s;z-index:300;display:none;box-shadow:0 0 8px #0a84ff66}

    /* HEADER */
    .iu-header{
      position:fixed;top:0;left:0;right:0;height:50px;
      background:rgba(14,14,14,.96);border-bottom:1px solid rgba(255,255,255,.07);
      backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
      display:flex;align-items:center;padding:0 12px;z-index:100;gap:8px;
    }
    .iu-logo{display:flex;align-items:center;gap:7px;cursor:pointer;user-select:none;flex-shrink:0;padding:4px 6px;border-radius:8px;transition:background .15s}
    .iu-logo:hover{background:rgba(255,255,255,.06)}
    .iu-logo svg{width:32px;height:32px;flex-shrink:0}
    .iu-logo-txt{display:flex;flex-direction:column;font-size:.68rem;font-weight:700;letter-spacing:.04em;line-height:1.25}
    .iu-h-center{flex:1;display:flex;align-items:center;justify-content:center;padding:0 8px}
    #__iu_search__{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);border-radius:20px;color:#fff;padding:5px 14px;font-size:.83rem;width:220px;outline:none;transition:border .2s,background .2s}
    #__iu_search__:focus{border-color:#0a84ff;background:rgba(255,255,255,.11)}
    #__iu_search__::placeholder{color:#555}
    #__iu_search__:disabled{opacity:.3;cursor:not-allowed}
    .iu-h-right{display:flex;align-items:center;gap:4px;flex-shrink:0}
    .iu-hbtn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);color:#ccc;border-radius:7px;padding:4px 10px;font-size:.75rem;cursor:pointer;transition:background .15s,color .15s;font-weight:500}
    .iu-hbtn:hover{background:rgba(255,255,255,.14);color:#fff}
    .iu-hico{background:none;border:none;color:#666;font-size:1rem;cursor:pointer;padding:5px 6px;border-radius:7px;transition:color .15s,background .15s;line-height:1}
    .iu-hico:hover{color:#e8e8e8;background:rgba(255,255,255,.08)}
    .iu-chk-hdr{width:14px;height:14px;cursor:pointer;accent-color:#0a84ff}

    /* LAYOUT */
    .iu-body{display:flex;margin-top:50px;min-height:calc(100vh - 50px)}

    /* SIDEBAR */
    .iu-sidebar{width:220px;flex-shrink:0;border-right:1px solid rgba(255,255,255,.07);padding:8px 7px 20px;position:sticky;top:50px;height:calc(100vh - 50px);overflow-y:auto;overflow-x:hidden;background:#0e0e0e}
    .iu-sidebar::-webkit-scrollbar{width:3px}
    .iu-sidebar::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:3px}

    .iu-lbl{margin:8px 0 4px;padding:0 2px;font-size:.6rem;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.1em}
    .iu-hr{border:0;border-top:1px solid rgba(255,255,255,.07);margin:7px 0}

    .iu-stats{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:6px 9px;margin-bottom:6px}
    .iu-sr{display:flex;justify-content:space-between;align-items:center;padding:2px 0;font-size:.76rem}
    .iu-sr span{color:#666}
    .iu-sr b{font-weight:600;font-variant-numeric:tabular-nums}
    .iu-sr-scan{border-top:1px solid rgba(255,255,255,.07);margin-top:4px;padding-top:4px}
    .iu-g{color:#30d158}.iu-r{color:#ff453a}.iu-gold{color:#ffd60a}
    .iu-eta{color:#0a84ff}
    .iu-warn-txt{color:#ff9f0a}
    .iu-fail-txt{color:#ff453a}

    /* Daily limit bar (#6) */
    .iu-daily-bar{padding:6px 9px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:10px;margin-bottom:6px}
    .iu-daily-lbl{display:flex;justify-content:space-between;font-size:.74rem;margin-bottom:5px}
    .iu-daily-lbl span{color:#666}
    .iu-bar{width:100%;height:3px;background:rgba(255,255,255,.08);border-radius:3px}
    .iu-bar-fill{height:100%;background:#30d158;border-radius:3px;transition:width .4s}
    .iu-bar-warn{background:#ff9f0a}
    .iu-bar-red {background:#ff453a}

    .iu-chk-row{display:flex;align-items:center;gap:7px;padding:5px 7px;border-radius:7px;cursor:pointer;font-size:.78rem;color:#bbb;margin-bottom:2px;transition:background .12s,color .12s}
    .iu-chk-row:hover{background:rgba(255,255,255,.07);color:#fff}
    .iu-chk-row input{cursor:pointer;accent-color:#0a84ff;width:13px;height:13px;flex-shrink:0}

    .iu-smart-grid{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:2px}
    .iu-sec-btn{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);color:#aaa;padding:3px 9px;border-radius:20px;cursor:pointer;font-size:.72rem;font-weight:500;transition:background .12s,color .12s;white-space:nowrap}
    .iu-sec-btn:hover{background:rgba(255,255,255,.14);color:#fff}
    .iu-danger{color:#ff453a !important;border-color:rgba(255,69,58,.3) !important}
    .iu-danger:hover{background:rgba(255,69,58,.12) !important}

    .iu-ctrl-btn{display:block;width:100%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);color:#ccc;padding:5px 8px;border-radius:8px;cursor:pointer;font-size:.76rem;font-weight:500;transition:background .12s;text-align:center;margin-bottom:3px}
    .iu-ctrl-btn:hover{background:rgba(255,255,255,.14);color:#fff}

    /* Pagination */
    .iu-pag{display:flex;align-items:center;gap:5px}
    .iu-pag-btn{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);color:#ccc;width:26px;height:26px;border-radius:7px;cursor:pointer;font-size:.85rem;flex-shrink:0;transition:background .12s}
    .iu-pag-btn:not(:disabled):hover{background:rgba(255,255,255,.14);color:#fff}
    .iu-pag-btn:disabled{opacity:.3;cursor:not-allowed}
    /* #12 page jump input */
    .iu-page-input{flex:1;min-width:0;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#fff;padding:3px 6px;font-size:.76rem;text-align:center;outline:none;transition:border .15s}
    .iu-page-input:focus{border-color:#0a84ff}
    .iu-page-total{font-size:.76rem;color:#555;flex-shrink:0;white-space:nowrap}

    .iu-unfollow-btn{display:block;width:100%;margin-top:8px;padding:9px;background:#ff3b30;color:#fff;border:none;border-radius:10px;cursor:pointer;font-size:.85rem;font-weight:700;letter-spacing:.02em;transition:background .15s,opacity .15s;box-shadow:0 2px 8px rgba(255,59,48,.25)}
    .iu-unfollow-btn:not(:disabled):hover{background:#e02a20}
    .iu-unfollow-btn:disabled{opacity:.35;cursor:not-allowed;box-shadow:none}
    .iu-unfollow-pause{background:#3a3a3c !important;box-shadow:none !important}
    .iu-unfollow-pause:hover{background:#48484a !important}
    .iu-uf-prog{font-size:.72rem;color:#555;margin-top:5px}

    /* MAIN — scroll container */
    .iu-main{flex:1;min-width:0;overflow-y:auto;scroll-behavior:smooth;scroll-padding-top:46px}

    /* IDLE */
    .iu-idle{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;min-height:calc(100vh - 50px);padding:20px}
    .iu-idle-hero{display:flex;flex-direction:column;align-items:center;gap:10px}
    .iu-run-btn{
      width:156px;height:156px;border-radius:50%;
      background:linear-gradient(145deg,#1a1a1a,#0e0e0e);
      border:2px solid rgba(255,255,255,.15);
      color:#fff;cursor:pointer;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;
      transition:border-color .2s,background .2s,transform .15s,box-shadow .2s;
      box-shadow:0 4px 24px rgba(0,0,0,.4);
    }
    .iu-run-btn:hover{border-color:rgba(10,132,255,.7);background:linear-gradient(145deg,#1c2333,#111827);transform:scale(1.04);box-shadow:0 6px 32px rgba(10,132,255,.3)}
    .iu-run-btn:active{transform:scale(.97)}
    .iu-run-icon{font-size:2.5rem;line-height:1;filter:drop-shadow(0 2px 8px rgba(10,132,255,.4))}
    .iu-run-label{font-size:.9rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#e8e8e8}
    .iu-run-hint{font-size:.76rem;color:#444;text-align:center;max-width:200px;line-height:1.4;margin:0}
    .iu-resume-saved-btn{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:#888;padding:10px 18px;border-radius:12px;cursor:pointer;font-size:.8rem;text-align:center;line-height:1.55;transition:background .15s}
    .iu-resume-saved-btn:hover{background:rgba(255,255,255,.09);color:#ccc}
    .iu-resume-saved-btn small{font-size:.7rem;color:#555;display:block;margin-top:2px}
    .iu-idle-hist{text-align:center}
    .iu-idle-hist-lbl{font-size:.68rem;color:#555;margin:0 0 6px;text-transform:uppercase;letter-spacing:.07em}
    .iu-idle-hist-item{display:inline-block;background:rgba(255,255,255,.06);border-radius:20px;padding:2px 9px;font-size:.75rem;color:#aaa;margin:2px}

    /* TABS — sticky inside .iu-main (the scroll container), so top:0 */
    .iu-tabs{display:flex;border-bottom:1px solid rgba(255,255,255,.07);padding:0 10px;background:#0e0e0e;position:sticky;top:0;z-index:10;overflow-x:auto;scrollbar-width:none}
    .iu-tabs::-webkit-scrollbar{display:none}
    .iu-tab{padding:10px 12px;cursor:pointer;font-size:.8rem;color:#666;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;user-select:none;font-weight:500;white-space:nowrap;display:flex;align-items:center;gap:5px}
    .iu-tab:hover{color:#aaa}
    .iu-tab-active{color:#e8e8e8;border-bottom-color:#0a84ff}
    .iu-tab-count{background:rgba(255,255,255,.1);border-radius:10px;padding:1px 6px;font-size:.65rem;font-weight:600}
    .iu-tab-active .iu-tab-count{background:rgba(10,132,255,.2);color:#6eb8ff}

    /* RESULTS — padding-top clears sticky tabs (~44px) */
    .iu-results{padding:8px 10px 16px;display:flex;flex-direction:column;gap:2px}

    .iu-empty{padding:48px;text-align:center;color:#444;font-size:.9rem}

    /* USER CARD */
    .iu-card{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:10px;cursor:pointer;transition:background .12s,border-color .18s;border:1px solid transparent;min-width:0}
    .iu-card:hover{background:rgba(255,255,255,.05)}
    /* #16 — selection with smooth transition */
    .iu-card-sel{background:rgba(10,132,255,.1) !important;border-color:rgba(10,132,255,.3) !important}

    /* Avatar */
    .iu-av-wrap{position:relative;flex-shrink:0;cursor:pointer;width:44px;height:44px}
    .iu-av{width:44px;height:44px;border-radius:50%;display:block;object-fit:cover;transition:filter .2s;background:#1c1c1e}
    .iu-av-wrap:hover .iu-av{filter:brightness(0.35) blur(2px)}
    .iu-av-ov{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:1rem;opacity:0;transition:opacity .15s;pointer-events:none}
    .iu-av-wrap:hover .iu-av-ov{opacity:1}
    .iu-av-preview{position:absolute;left:52px;top:-52px;z-index:50;opacity:0;pointer-events:none;transform:scale(.88) translateY(4px);transition:opacity .22s,transform .22s cubic-bezier(.175,.885,.32,1.275)}
    .iu-av-wrap:hover .iu-av-preview{opacity:1;transform:scale(1) translateY(0)}
    .iu-av-preview img{width:110px;height:110px;border-radius:10px;border:2.5px solid rgba(255,255,255,.8);box-shadow:0 12px 32px rgba(0,0,0,.7);display:block;background:#1c1c1e}

    /* Info — overflow safe */
    .iu-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;overflow:hidden}
    .iu-uname{display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden}
    .iu-uname a{color:#e8e8e8;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex-shrink:1;font-size:.85rem;font-weight:600}
    .iu-uname a:hover{color:#0a84ff}
    .iu-fname{font-size:.73rem;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .iu-ver{background:#0a84ff;border-radius:50%;padding:.12em .26em;font-size:.5em;flex-shrink:0;line-height:1}
    .iu-badges{display:flex;gap:4px;margin-top:2px;overflow:hidden;flex-wrap:nowrap}
    .iu-b-follows,.iu-b-ghost,.iu-b-priv,.iu-b-wl{padding:1px 7px;border-radius:20px;font-size:.64rem;font-weight:600;white-space:nowrap;flex-shrink:0}
    .iu-b-follows{background:rgba(48,209,88,.15);color:#30d158}
    .iu-b-ghost  {background:rgba(255,69,58,.13) ;color:#ff6b6b}
    .iu-b-priv   {background:rgba(255,255,255,.07);color:#666}
    .iu-b-wl     {background:rgba(255,214,10,.12) ;color:#ffd60a}
    .iu-chk{width:16px;height:16px;cursor:pointer;accent-color:#0a84ff;flex-shrink:0}

    /* Bottom pagination (#fix first card) */
    .iu-bottom-pag{display:flex;align-items:center;justify-content:center;gap:10px;padding:12px 0 4px;font-size:.82rem;color:#555}
    .iu-bottom-pag .iu-pag-btn{width:auto;padding:4px 12px;font-size:.78rem;height:28px}

    /* Skeleton (#17) */
    @keyframes iu-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    .iu-skeleton{pointer-events:none;opacity:.6}
    .iu-sk-av{width:44px;height:44px;border-radius:50%;background:linear-gradient(90deg,#1a1a1a 25%,#2a2a2a 50%,#1a1a1a 75%);background-size:200% 100%;animation:iu-shimmer 1.4s infinite;flex-shrink:0}
    .iu-sk-info{flex:1;display:flex;flex-direction:column;gap:6px}
    .iu-sk-line{height:10px;border-radius:5px;background:linear-gradient(90deg,#1a1a1a 25%,#2a2a2a 50%,#1a1a1a 75%);background-size:200% 100%;animation:iu-shimmer 1.4s infinite}
    .iu-sk-w60{width:60%}.iu-sk-w40{width:40%}.iu-sk-w30{width:30%}

    /* UNFOLLOW LOG */
    .iu-log{padding:10px 12px;display:flex;flex-direction:column;gap:3px}
    .iu-log-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;font-size:.8rem}
    .iu-ok  {background:rgba(48,209,88,.08);color:#30d158}
    .iu-fail{background:rgba(255,69,58,.08);color:#ff6b6b}
    .iu-log-row a{color:inherit;text-decoration:none;font-weight:600}
    .iu-log-row a:hover{text-decoration:underline}
    .iu-log-n{margin-left:auto;color:#444;font-size:.7rem;flex-shrink:0}
    .iu-log-err{color:#ff9f0a;font-size:.7rem}
    .iu-log-empty{color:#444;text-align:center;padding:24px}
    .iu-done{background:rgba(48,209,88,.12);color:#30d158;border:1px solid rgba(48,209,88,.2);border-radius:10px;padding:10px;text-align:center;font-weight:700;margin-bottom:8px}

    /* TOAST */
    .iu-toast{position:fixed;bottom:-100px;right:14px;max-width:300px;background:#2c2c2e;color:#e8e8e8;padding:10px 14px;border-radius:12px;display:flex;align-items:center;gap:9px;font-size:.82rem;box-shadow:0 8px 24px rgba(0,0,0,.5);z-index:9999;transition:bottom .3s cubic-bezier(.175,.885,.32,1.275);border:1px solid rgba(255,255,255,.1)}
    .iu-t-show{bottom:14px}
    .iu-t-hidden{bottom:-100px}
    .iu-toast[data-type=success]{background:#1a3a24;border-color:rgba(48,209,88,.3);color:#30d158}
    .iu-toast[data-type=error]  {background:#3a1a1a;border-color:rgba(255,69,58,.3);color:#ff6b6b}
    .iu-toast[data-type=warning]{background:#3a2e0a;border-color:rgba(255,159,10,.3);color:#ff9f0a}
    .iu-t-msg{flex:1;line-height:1.4}
    .iu-t-close{background:none;border:none;color:inherit;cursor:pointer;font-size:1rem;opacity:.5;padding:0;flex-shrink:0;line-height:1;transition:opacity .15s}
    .iu-t-close:hover{opacity:1}

    /* MODAL */
    .iu-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:200}
    .iu-modal{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1c1c1e;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:20px;z-index:201;width:90%;max-width:480px;max-height:85vh;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
    .iu-modal::-webkit-scrollbar{width:3px}
    .iu-modal::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:3px}
    .iu-modal h3{margin:0;font-size:1.05rem;font-weight:700;text-align:center;color:#fff}
    .iu-s-lbl{margin:.3rem 0 .1rem;font-size:.6rem;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.1em}
    .iu-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:9px;font-size:.81rem}
    .iu-row label{flex:1;min-width:170px;color:#ccc;display:flex;align-items:center;gap:6px}
    .iu-row input[type=number]{width:84px;padding:4px 8px;background:#111;border:1px solid rgba(255,255,255,.12);border-radius:7px;color:#fff;font-size:.81rem}
    .iu-row input[type=number]:focus{outline:none;border-color:#0a84ff}
    .iu-warn{background:rgba(255,69,58,.08);border:1px solid rgba(255,69,58,.2);border-radius:9px;padding:9px 11px;font-size:.78rem;color:#ff9f9f;line-height:1.45}
    .iu-warn b{color:#ff453a}
    .iu-btn{border:none;border-radius:8px;padding:7px 16px;cursor:pointer;color:#fff;font-size:.8rem;font-weight:600;transition:opacity .15s,transform .1s}
    .iu-btn:hover{opacity:.88}
    .iu-btn:active{transform:scale(.97)}
    .iu-btn:disabled{opacity:.3;cursor:not-allowed}
    .iu-btn-blue {background:#0a84ff}
    .iu-btn-green{background:#30d158}
    .iu-btn-red  {background:#ff3b30}
    .iu-btn-row{display:flex;flex-wrap:wrap;gap:5px}
    .iu-modal-footer{display:flex;justify-content:flex-end;gap:7px;padding-top:8px;border-top:1px solid rgba(255,255,255,.07)}

    /* History in settings (#19) */
    .iu-hist-list{display:flex;flex-direction:column;gap:2px;max-height:160px;overflow-y:auto}
    .iu-hist-row{display:flex;justify-content:space-between;align-items:center;padding:4px 8px;border-radius:6px;font-size:.78rem;background:rgba(255,255,255,.03)}
    .iu-fail-row{color:#ff6b6b}
    .iu-hist-date{color:#555;font-size:.7rem}

    #__iu_settings__{position:fixed;inset:0;z-index:199;display:none;flex-direction:column}

    @media(max-width:760px){.iu-sidebar{width:190px}}
    @media(max-width:560px){.iu-sidebar{width:160px}.iu-av-preview{display:none}}
    @media(max-width:420px){.iu-sidebar{display:none}}
  `;
  document.head.appendChild(style);

  // ── BUILD DOM ────────────────────────────────────────────────────
  document.title = 'Instagram Desfollowers';
  document.body.innerHTML = '';

  const root = document.createElement('div');
  root.id = '__iu_root__';
  root.innerHTML = `
    <div id="__iu_progress__"></div>
    <header class="iu-header">
      <div class="iu-logo" data-action="go-home">
        <svg viewBox="0 0 354 354" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="177" cy="177" r="177" fill="#1a1a1a"/>
          <circle cx="177" cy="115" r="50" fill="#2a2a2a"/>
          <ellipse cx="177" cy="243" rx="76" ry="66" fill="#2a2a2a"/>
          <rect x="243" y="112" width="66" height="20" rx="10" fill="#00FFFF"/>
        </svg>
        <div class="iu-logo-txt"><span>Instagram</span><span>Unfollowers</span></div>
      </div>
      <div class="iu-h-center">
        <input id="__iu_search__" type="text" placeholder="Buscar… (Ctrl+F)" disabled>
      </div>
      <div class="iu-h-right">
        <span id="__iu_hdr_export__" style="display:none;gap:5px;align-items:center">
          <button class="iu-hbtn" data-action="copy-list">Copiar</button>
          <button class="iu-hbtn" data-action="export-json">JSON</button>
          <button class="iu-hbtn" data-action="export-csv">CSV</button>
        </span>
        <label title="Seleccionar página actual"><input type="checkbox" id="__iu_chk_page__" class="iu-chk-hdr" data-action="select-page" style="display:none"></label>
        <label title="Seleccionar todo"><input type="checkbox" id="__iu_chk_all__" class="iu-chk-hdr" data-action="select-all" style="display:none"></label>
        <button class="iu-hico" data-action="toggle-settings" title="Configuración (⚙)">⚙</button>
        <button class="iu-hico" data-action="close-app" title="Cerrar">✕</button>
      </div>
    </header>
    <div class="iu-body">
      <aside class="iu-sidebar" id="__iu_sidebar__"></aside>
      <main class="iu-main" id="__iu_main__"></main>
    </div>
    <div id="__iu_settings__"></div>
    <input type="file" id="__iu_wl_file__" accept=".json" style="display:none" data-action="wl-file">
    <div id="__iu_toast__" class="iu-toast iu-t-hidden">
      <span class="iu-t-msg"></span>
      <button class="iu-t-close" data-action="close-toast">×</button>
    </div>
  `;
  document.body.appendChild(root);

  root.addEventListener('click',  handleClick);
  root.addEventListener('change', handleChange);
  root.addEventListener('input',  handleInput);
  root.addEventListener('change', e => { if (e.target.dataset.action==='page-jump') handlePageJump(e); });

  // ── INIT ─────────────────────────────────────────────────────────
  S.whitelist = loadWL();
  S.cfg       = loadCfg();

  _derived = computeDerived();
  markAllDirty();
  render(true);

  const daily = todayUnfollowCount();
  toast(`Instagram Desfollowers listo${daily>0?` · ${daily}/${DAILY_LIMIT} hoy`:''} — haz clic en INICIAR`, 'info', 5000);
})();
