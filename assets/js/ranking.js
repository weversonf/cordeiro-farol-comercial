/**
 * Farol Cordeiro Comercial — Ranking dos Executivos (Exclusivo Admin Master)
 * Alterna entre Vendido (Bitrix: Vendas + Funil de vendas) e Faturado (Protheus SD2)
 * com Corrida dos Guindastes por posição (Treliçado 800T -> Munck).
 */
(() => {
  const EQUIPAMENTOS = [
    { nome: 'Treliçado 800T', tipo: 'trelica800' },
    { nome: 'AT 500T', tipo: 'at500' },
    { nome: 'AT 220T', tipo: 'at220' },
    { nome: 'RT 90T', tipo: 'rt90' },
    { nome: 'TM 45T', tipo: 'tm45' },
    { nome: 'Munck', tipo: 'munck' }
  ];

  const state = {
    fonte: 'vendido', // padrão: Vendido (Bitrix)
    periodo: 'mes',   // 'mes' | 'ano'
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    data: null,
    loading: false,
    wired: false
  };

  function getEquipamento(pos, total) {
    if (pos === 0) return EQUIPAMENTOS[0];
    if (total > 1 && pos >= total - 1) return EQUIPAMENTOS[EQUIPAMENTOS.length - 1];
    const idx = Math.min(EQUIPAMENTOS.length - 2, Math.max(1, pos));
    return EQUIPAMENTOS[idx];
  }

  function guindasteSvg(tipo, cor) {
    if (tipo === 'trelica800') {
      return `
<svg viewBox="0 0 104 54" aria-hidden="true">
  <rect x="6" y="38" width="52" height="10" rx="5" fill="#1E293B" stroke="#64748B" stroke-width="1.5"/>
  <circle cx="13" cy="43" r="3" fill="#94a3b8"/><circle cx="23" cy="43" r="3" fill="#94a3b8"/>
  <circle cx="33" cy="43" r="3" fill="#94a3b8"/><circle cx="43" cy="43" r="3" fill="#94a3b8"/>
  <circle cx="52" cy="43" r="3" fill="#94a3b8"/>
  <rect x="10" y="26" width="44" height="12" rx="2" fill="${cor}"/>
  <rect x="4" y="23" width="12" height="13" rx="1.5" fill="#CBD5E1"/>
  <rect x="38" y="21" width="14" height="13" rx="2" fill="#fff"/>
  <rect x="42" y="23" width="8" height="6" rx="1" fill="#0F2A44"/>
  <line x1="22" y1="26" x2="18" y2="10" stroke="#CBD5E1" stroke-width="2"/>
  <line x1="18" y1="10" x2="94" y2="5" stroke="#CBD5E1" stroke-width="1" stroke-dasharray="2,2"/>
  <g transform="rotate(-17 34 27)">
    <rect x="34" y="22" width="64" height="7" fill="none" stroke="#FBBF24" stroke-width="2"/>
    <path d="M36,22 L44,29 L52,22 L60,29 L68,22 L76,29 L84,22 L92,29 L98,22" fill="none" stroke="#FBBF24" stroke-width="1.4"/>
  </g>
  <line x1="94" y1="6" x2="94" y2="22" stroke="#fff" stroke-width="1.5"/>
  <rect x="91" y="22" width="6" height="6" rx="1" fill="#FBBF24"/>
</svg>`;
    }
    if (tipo === 'at500') {
      return `
<svg viewBox="0 0 98 54" aria-hidden="true">
  <rect x="6" y="30" width="64" height="10" rx="2" fill="${cor}"/>
  <rect x="58" y="22" width="14" height="16" rx="2" fill="#fff"/>
  <rect x="62" y="24" width="8" height="6" rx="1" fill="#0F2A44"/>
  <rect x="14" y="21" width="24" height="10" rx="2" fill="${cor}" stroke="#fff" stroke-width="1"/>
  <g transform="rotate(-14 26 24)">
    <rect x="26" y="18" width="58" height="6" rx="1.5" fill="#FBBF24"/>
    <rect x="62" y="19" width="26" height="4" rx="1" fill="#FDE68A"/>
  </g>
  <line x1="88" y1="7" x2="88" y2="21" stroke="#fff" stroke-width="1.5"/>
  <rect x="85" y="21" width="6" height="5" rx="1" fill="#CBD5E1"/>
  <g class="rk-roda"><circle cx="14" cy="44" r="5.5" fill="#111"/><circle cx="14" cy="44" r="2" fill="#94a3b8"/></g>
  <g class="rk-roda"><circle cx="27" cy="44" r="5.5" fill="#111"/><circle cx="27" cy="44" r="2" fill="#94a3b8"/></g>
  <g class="rk-roda"><circle cx="40" cy="44" r="5.5" fill="#111"/><circle cx="40" cy="44" r="2" fill="#94a3b8"/></g>
  <g class="rk-roda"><circle cx="53" cy="44" r="5.5" fill="#111"/><circle cx="53" cy="44" r="2" fill="#94a3b8"/></g>
  <g class="rk-roda"><circle cx="65" cy="44" r="5.5" fill="#111"/><circle cx="65" cy="44" r="2" fill="#94a3b8"/></g>
</svg>`;
    }
    if (tipo === 'at220') {
      return `
<svg viewBox="0 0 92 54" aria-hidden="true">
  <rect x="6" y="30" width="58" height="10" rx="2" fill="${cor}"/>
  <rect x="52" y="22" width="14" height="16" rx="2" fill="#fff"/>
  <rect x="56" y="24" width="8" height="6" rx="1" fill="#0F2A44"/>
  <rect x="14" y="22" width="20" height="9" rx="2" fill="${cor}" stroke="#fff" stroke-width="1"/>
  <g transform="rotate(-12 24 24)">
    <rect x="24" y="18" width="50" height="6" rx="1.5" fill="#FBBF24"/>
    <rect x="56" y="19" width="22" height="4" rx="1" fill="#FDE68A"/>
  </g>
  <line x1="78" y1="10" x2="78" y2="23" stroke="#fff" stroke-width="1.5"/>
  <rect x="75" y="23" width="6" height="5" rx="1" fill="#CBD5E1"/>
  <g class="rk-roda"><circle cx="14" cy="44" r="6" fill="#111"/><circle cx="14" cy="44" r="2" fill="#94a3b8"/></g>
  <g class="rk-roda"><circle cx="29" cy="44" r="6" fill="#111"/><circle cx="29" cy="44" r="2" fill="#94a3b8"/></g>
  <g class="rk-roda"><circle cx="44" cy="44" r="6" fill="#111"/><circle cx="44" cy="44" r="2" fill="#94a3b8"/></g>
  <g class="rk-roda"><circle cx="59" cy="44" r="6" fill="#111"/><circle cx="59" cy="44" r="2" fill="#94a3b8"/></g>
</svg>`;
    }
    if (tipo === 'rt90') {
      return `
<svg viewBox="0 0 86 54" aria-hidden="true">
  <rect x="10" y="28" width="44" height="10" rx="2" fill="${cor}"/>
  <rect x="34" y="18" width="16" height="14" rx="2" fill="#fff"/>
  <rect x="38" y="20" width="9" height="6" rx="1" fill="#0F2A44"/>
  <g transform="rotate(-14 20 26)">
    <rect x="18" y="20" width="48" height="6" rx="1.5" fill="#FBBF24"/>
  </g>
  <line x1="65" y1="12" x2="65" y2="24" stroke="#fff" stroke-width="1.5"/>
  <rect x="62" y="24" width="6" height="5" rx="1" fill="#CBD5E1"/>
  <g class="rk-roda"><circle cx="20" cy="42" r="8" fill="#111"/><circle cx="20" cy="42" r="3" fill="#94a3b8"/></g>
  <g class="rk-roda"><circle cx="46" cy="42" r="8" fill="#111"/><circle cx="46" cy="42" r="3" fill="#94a3b8"/></g>
</svg>`;
    }
    if (tipo === 'tm45') {
      return `
<svg viewBox="0 0 84 54" aria-hidden="true">
  <rect x="6" y="30" width="48" height="10" rx="2" fill="${cor}"/>
  <rect x="46" y="20" width="16" height="18" rx="2" fill="#fff"/>
  <rect x="50" y="23" width="9" height="7" rx="1" fill="#0F2A44"/>
  <g transform="rotate(-12 18 27)">
    <rect x="18" y="22" width="40" height="5.5" rx="1.5" fill="#FBBF24"/>
  </g>
  <line x1="58" y1="16" x2="58" y2="27" stroke="#fff" stroke-width="1.5"/>
  <rect x="55" y="27" width="6" height="5" rx="1" fill="#CBD5E1"/>
  <g class="rk-roda"><circle cx="16" cy="44" r="6.5" fill="#111"/><circle cx="16" cy="44" r="2.2" fill="#94a3b8"/></g>
  <g class="rk-roda"><circle cx="34" cy="44" r="6.5" fill="#111"/><circle cx="34" cy="44" r="2.2" fill="#94a3b8"/></g>
  <g class="rk-roda"><circle cx="53" cy="44" r="6.5" fill="#111"/><circle cx="53" cy="44" r="2.2" fill="#94a3b8"/></g>
</svg>`;
    }
    return `
<svg viewBox="0 0 84 54" aria-hidden="true">
  <rect x="4" y="28" width="44" height="12" rx="2" fill="${cor}"/>
  <rect x="48" y="20" width="18" height="20" rx="2" fill="#fff"/>
  <rect x="52" y="23" width="10" height="8" rx="1" fill="#0F2A44"/>
  <rect x="14" y="12" width="4" height="18" fill="#FBBF24"/>
  <rect x="14" y="10" width="34" height="4" rx="2" fill="#FBBF24" transform="rotate(18 14 10)"/>
  <line x1="46" y1="16" x2="46" y2="26" stroke="#fff" stroke-width="2"/>
  <rect x="42" y="26" width="8" height="6" rx="1" fill="#CBD5E1"/>
  <g class="rk-roda"><circle cx="18" cy="44" r="7" fill="#111"/><circle cx="18" cy="44" r="2.5" fill="#94a3b8"/></g>
  <g class="rk-roda"><circle cx="38" cy="44" r="7" fill="#111"/><circle cx="38" cy="44" r="2.5" fill="#94a3b8"/></g>
  <g class="rk-roda"><circle cx="58" cy="44" r="7" fill="#111"/><circle cx="58" cy="44" r="2.5" fill="#94a3b8"/></g>
</svg>`;
  }

  function fmtBrl(v) {
    return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  }

  function fmtCompact(v) {
    const abs = Math.abs(Number(v) || 0);
    if (abs >= 1e6) return 'R$ ' + (abs / 1e6).toFixed(2).replace('.', ',') + 'M';
    if (abs >= 1e3) return 'R$ ' + (abs / 1e3).toFixed(0).replace('.', ',') + 'k';
    return 'R$ ' + abs.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  }

  function wireControls() {
    if (state.wired) return;
    state.wired = true;

    const btnVendido = document.getElementById('rkBtnVendido');
    const btnFaturado = document.getElementById('rkBtnFaturado');
    const btnMes = document.getElementById('rkBtnMes');
    const btnAno = document.getElementById('rkBtnAno');
    const selMes = document.getElementById('rkSelectMes');
    const btnAtualizar = document.getElementById('rkBtnAtualizar');

    if (selMes) {
      selMes.value = `${state.year}-${String(state.month).padStart(2, '0')}`;
      selMes.addEventListener('change', () => {
        const [y, m] = String(selMes.value || '').split('-').map(Number);
        if (y && m) {
          state.year = y;
          state.month = m;
          loadRanking(true);
        }
      });
    }

    if (btnVendido) {
      btnVendido.addEventListener('click', () => {
        state.fonte = 'vendido';
        render();
      });
    }
    if (btnFaturado) {
      btnFaturado.addEventListener('click', () => {
        state.fonte = 'faturado';
        render();
      });
    }
    if (btnMes) {
      btnMes.addEventListener('click', () => {
        state.periodo = 'mes';
        render();
      });
    }
    if (btnAno) {
      btnAno.addEventListener('click', () => {
        state.periodo = 'ano';
        render();
      });
    }
    if (btnAtualizar) {
      btnAtualizar.addEventListener('click', () => loadRanking(true));
    }
  }

  function render() {
    const pista = document.getElementById('rkPista');
    const tbody = document.getElementById('rkTbody');
    const fonteInfo = document.getElementById('rkFonteInfo');
    if (!pista || !tbody) return;

    document.getElementById('rkBtnVendido')?.classList.toggle('active', state.fonte === 'vendido');
    document.getElementById('rkBtnFaturado')?.classList.toggle('active', state.fonte === 'faturado');
    document.getElementById('rkBtnMes')?.classList.toggle('active', state.periodo === 'mes');
    document.getElementById('rkBtnAno')?.classList.toggle('active', state.periodo === 'ano');

    if (!state.data) {
      pista.innerHTML = '<div class="rk-empty">Carregando ranking dos executivos...</div>';
      tbody.innerHTML = '';
      return;
    }

    const rawList = state.fonte === 'faturado' ? (state.data.faturado || []) : (state.data.vendido || []);
    const isAno = state.periodo === 'ano';

    const lista = rawList.map(item => {
      const realizado = isAno ? Number(item.realizadoAno || 0) : Number(item.realizadoMes || 0);
      const meta = isAno ? Number(item.metaYtd || item.metaAno || 0) : Number(item.metaMes || 0);
      const pct = meta > 0 ? (realizado / meta) * 100 : (isAno ? Number(item.pctAno || 0) : Number(item.pctMes || 0));
      const qtd = isAno ? Number(item.qtdAno || 0) : Number(item.qtdMes || 0);
      return { ...item, realizado, meta, pct, qtd };
    }).sort((a, b) => {
      if (b.pct !== a.pct) return b.pct - a.pct;
      return b.realizado - a.realizado;
    });

    if (fonteInfo) {
      const fonteDesc = state.fonte === 'faturado'
        ? 'Faturado (Protheus SD2 · pós-expurgos)'
        : 'Vendido (Bitrix24 · Vendas + Funil de vendas)';
      const periodoDesc = isAno ? `Acumulado Jan–${String(state.month).padStart(2, '0')}/${state.year}` : `Competência ${String(state.month).padStart(2, '0')}/${state.year}`;
      fonteInfo.textContent = `${fonteDesc} • ${periodoDesc}`;
    }

    pista.innerHTML = lista.map((v, i) => {
      const equip = getEquipamento(i, lista.length);
      const batida = v.pct >= 100;
      const pos = batida
        ? Math.min(88, 75 + 13 * Math.min(1, (v.pct - 100) / 100))
        : Math.min(71, Math.max(4, 4 + 67 * (v.pct / 100)));
      const dif = v.meta - v.realizado;
      const saldoTxt = v.meta > 0
        ? (dif > 0 ? `Falta ${fmtCompact(dif)}` : `+${fmtCompact(Math.abs(dif))}`)
        : '';

      return `
        <div class="rk-faixa ${i === 0 ? 'lider' : ''}">
          <div class="rk-faixa-top">
            <span class="rk-pos">${i + 1}º</span>
            <span class="rk-nome">${v.nome}</span>
            <span class="rk-equip-badge">${equip.nome}</span>
            ${i === 0 ? '<span class="rk-lider-badge">LÍDER</span>' : ''}
            <span class="rk-pct-badge ${batida ? 'batida' : ''}">${v.pct.toFixed(1)}% da Meta</span>
            <div class="rk-meta-nums">
              <span>Realizado: <b>${fmtCompact(v.realizado)}</b></span>
              <span>Meta: <b>${v.meta > 0 ? fmtCompact(v.meta) : '—'}</b></span>
              ${saldoTxt ? `<span class="${dif <= 0 ? 'rk-ok' : 'rk-falta'}">(${saldoTxt})</span>` : ''}
            </div>
          </div>
          <div class="rk-trilho">
            ${batida ? `<div class="rk-rastro" style="width:${Math.max(0, pos - 75).toFixed(1)}%"></div>` : ''}
            <div class="rk-marco">
              <div class="rk-marco-linha"></div>
              <span class="rk-marco-lbl">100% META</span>
            </div>
            <div class="rk-caminhao" style="left:${pos.toFixed(1)}%">
              ${guindasteSvg(equip.tipo, v.cor)}
            </div>
          </div>
        </div>
      `;
    }).join('');

    const qtdLabel = state.fonte === 'faturado' ? 'NFs' : 'Negócios';
    const thQtd = document.getElementById('rkThQtd');
    if (thQtd) thQtd.textContent = qtdLabel;

    tbody.innerHTML = lista.map((v, i) => {
      const equip = getEquipamento(i, lista.length);
      return `
        <tr>
          <td><strong>${i + 1}º</strong></td>
          <td><span class="rk-dot" style="background:${v.cor}"></span>${v.nome}</td>
          <td><span class="rk-equip-pill">${equip.nome}</span></td>
          <td style="text-align:right;">${v.qtd}</td>
          <td style="text-align:right;"><strong>${fmtBrl(v.realizado)}</strong></td>
          <td style="text-align:right;">${v.meta > 0 ? fmtBrl(v.meta) : '—'}</td>
          <td style="text-align:right;"><strong>${v.pct.toFixed(1)}%</strong></td>
        </tr>
      `;
    }).join('');
  }

  async function loadRanking(force = false) {
    wireControls();
    if (state.loading) return;
    if (state.data && !force && state.data.year === state.year && state.data.month === state.month) {
      render();
      return;
    }
    const core = window.FarolPortalCore;
    if (!core?.fetchRelatorioAutenticado) return;
    state.loading = true;
    const pista = document.getElementById('rkPista');
    if (pista && !state.data) {
      pista.innerHTML = '<div class="rk-empty">Consultando Bitrix e Protheus SD2...</div>';
    }
    try {
      const qs = new URLSearchParams({ year: String(state.year), month: String(state.month) });
      const res = await core.fetchRelatorioAutenticado(`/api/ranking?${qs.toString()}`);
      state.data = res;
      render();
    } catch (err) {
      if (pista) {
        pista.innerHTML = `<div class="rk-empty">Erro ao carregar ranking: ${err.message || 'falha na consulta'}</div>`;
      }
    } finally {
      state.loading = false;
    }
  }

  window.FarolRanking = { loadRanking, render };
})();
