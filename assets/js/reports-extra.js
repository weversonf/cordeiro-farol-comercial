/* ================================================================
   FAROL CORDEIRO COMERCIAL — RMR COMERCIAL & FATURAMENTO
   Consome /api/rmr e /api/faturamento autenticados via Supabase JWT.
   ================================================================ */

(function initFarolReportsExtra() {
  const core = () => window.FarolReportsCore;

  let rmrPayload = null;
  let rmrCarregadoKey = '';
  let rmrControlsReady = false;
  let rmrFunilTempFiltro = null;
  let rmrFunilUnidadeFiltro = null;

  let fatPayload = null;
  let fatCarregado = false;
  let fatControlsReady = false;
  let fatBuscaTimer = null;

  let inadPayload = null;
  let inadCarregado = false;
  let inadBinded = false;
  let inadFiliaisSelecionadas = new Set();
  let inadFiliaisCatalogo = [];
  const inadCharts = {};

  function renderInadChart(canvasId, config) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof window.Chart !== 'function') return;
    if (inadCharts[canvasId]) {
      inadCharts[canvasId].destroy();
    }
    inadCharts[canvasId] = new window.Chart(canvas.getContext('2d'), config);
  }

  const MESES_PT = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
  ];
  const MESES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

  function fmtMoeda(v) {
    return core().formatarMoeda(Number(v || 0));
  }

  function fmtMoedaExata(v) {
    return core().formatarMoedaCompleta(Number(v || 0));
  }

  function fmtPct(v, sinal = false) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
    const num = Number(v);
    const prefix = sinal && num > 0 ? '+' : '';
    return `${prefix}${num.toFixed(1).replace('.', ',')}%`;
  }

  function fmtInt(v) {
    return Number(v || 0).toLocaleString('pt-BR');
  }

  function esc(v) {
    return core().escaparHtml(v ?? '');
  }

  function badgePct(pct) {
    if (pct === null || pct === undefined || Number.isNaN(Number(pct))) {
      return '<span class="metric-pill is-neutral">Sem meta</span>';
    }
    const n = Number(pct);
    const cls = n >= 100 ? 'is-good' : (n >= 80 ? 'is-warn' : 'is-bad');
    return `<span class="metric-pill ${cls}">${fmtPct(n)}</span>`;
  }

  function renderRankingList(containerId, items, { labelKey = 'unidade', valueKey = 'valor', detailFn = null, emptyMsg = 'Sem registros no período.', activeValue = '', onClick = null } = {}) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!items || !items.length) {
      el.innerHTML = `<p class="report-empty">${esc(emptyMsg)}</p>`;
      return;
    }
    const maxVal = Math.max(...items.map(i => Number(i[valueKey] || 0)), 1);
    const activeLow = String(activeValue || '').toLowerCase();
    el.innerHTML = items.map((item, idx) => {
      const val = Number(item[valueKey] || 0);
      const pctBar = Math.max(3, (val / maxVal) * 100);
      const label = item[labelKey] || 'Não identificado';
      const detail = detailFn ? detailFn(item) : '';
      const isSelected = activeLow && String(label).toLowerCase() === activeLow;
      const isDimmed = activeLow && !isSelected;
      const cls = ['report-ranking-row', onClick ? 'is-interactive' : '', isSelected ? 'is-selected' : '', isDimmed ? 'is-dimmed' : ''].filter(Boolean).join(' ');
      return `
        <div class="${cls}" ${onClick ? `role="button" tabindex="0" data-item-label="${esc(label)}"` : ''}>
          <span class="report-ranking-position">${String(idx + 1).padStart(2, '0')}</span>
          <div class="report-ranking-main">
            <div class="report-ranking-label" title="${esc(label)}">${esc(label)}</div>
            ${detail ? `<div class="report-ranking-detail">${esc(detail)}</div>` : ''}
            <div class="report-ranking-track"><span style="width:${pctBar}%"></span></div>
          </div>
          <strong>${fmtMoeda(val)}</strong>
        </div>`;
    }).join('');
    if (onClick) {
      el.querySelectorAll('.report-ranking-row[data-item-label]').forEach(row => {
        row.addEventListener('click', () => onClick(row.dataset.itemLabel));
      });
    }
  }

  function renderMonthlyComparisonBars(containerId, items, { valKey = 'valorPrincipal', metaKey = 'metaUnidades', closedKey = 'fechado', activeMes = '', onClick = null } = {}) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!items || !items.length) {
      el.innerHTML = '<p class="report-empty">Sem movimento mensal no período.</p>';
      return;
    }
    const maxVal = Math.max(...items.map(i => Math.max(Number(i[valKey] || 0), Number(i[metaKey] || 0))), 1);
    el.innerHTML = items.map(item => {
      const mIdx = Number(String(item.mes).slice(-2)) - 1;
      const val = Number(item[valKey] || 0);
      const meta = Number(item[metaKey] || 0);
      const hVal = val > 0 ? Math.max(4, (val / maxVal) * 100) : 2;
      const hMeta = meta > 0 ? Math.max(4, (meta / maxVal) * 100) : 0;
      const fech = closedKey in item ? Boolean(item[closedKey]) : true;
      const ating = meta > 0 && val > 0 ? ` (${fmtPct((val / meta) * 100)})` : '';
      const tip = `${MESES_CURTO[mIdx] || item.mes}: Realizado ${fmtMoedaExata(val)}${meta > 0 ? ` | Meta ${fmtMoedaExata(meta)}${ating}` : ''}`;
      const isSelected = activeMes && item.mes === activeMes;
      const cls = [
        'monthly-chart-item',
        fech ? '' : 'is-open-month',
        onClick ? 'is-interactive' : '',
        isSelected ? 'is-selected' : ''
      ].filter(Boolean).join(' ');
      return `
        <div class="${cls}" ${onClick ? `role="button" tabindex="0" data-mes-iso="${esc(item.mes)}"` : ''} title="${esc(tip)}">
          <span class="monthly-chart-value">${val > 0 ? fmtMoeda(val) : '—'}</span>
          <div class="monthly-chart-bar monthly-dual-bar">
            ${hMeta > 0 ? `<span class="bar-meta-line" style="bottom:${hMeta}%" title="Meta"></span>` : ''}
            <span style="height:${hVal}%"></span>
          </div>
          <small>${MESES_CURTO[mIdx] || item.mes}</small>
        </div>`;
    }).join('');
    if (onClick) {
      el.querySelectorAll('.monthly-chart-item[data-mes-iso]').forEach(bar => {
        bar.addEventListener('click', () => onClick(bar.dataset.mesIso));
      });
    }
  }

  function baixarCsv(filename, cabecalhos, linhas) {
    const escaparCsv = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const conteudo = '\uFEFF' + [cabecalhos.map(escaparCsv).join(';'), ...linhas.map(l => l.map(escaparCsv).join(';'))].join('\r\n');
    const blob = new Blob([conteudo], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    core().showToast(`Arquivo ${filename} exportado com sucesso.`, 'success');
  }

  /* ==============================================================
     PAINEL 1: RMR COMERCIAL
     ============================================================== */
  function setupRmrControls() {
    if (rmrControlsReady) return;
    rmrControlsReady = true;

    const nowBr = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const curYear = nowBr.getUTCFullYear();
    const curMonth = nowBr.getUTCMonth() + 1;
    const defMonth = curMonth > 1 ? curMonth - 1 : 12;
    const defYear = curMonth > 1 ? curYear : curYear - 1;

    const selAno = document.getElementById('rmrAnoSelect');
    const selMes = document.getElementById('rmrMesSelect');

    if (selAno && !selAno.options.length) {
      for (let y = curYear; y >= 2023; y -= 1) {
        const opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = String(y);
        if (y === defYear) opt.selected = true;
        selAno.appendChild(opt);
      }
    }

    if (selMes && !selMes.options.length) {
      MESES_PT.forEach((nome, idx) => {
        const m = idx + 1;
        const opt = document.createElement('option');
        opt.value = String(m);
        opt.textContent = `Ref: ${nome}`;
        if (m === defMonth) opt.selected = true;
        selMes.appendChild(opt);
      });
    }

    document.querySelectorAll('[data-rmr-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-rmr-tab]').forEach(b => b.classList.remove('is-active'));
        document.querySelectorAll('.rmr-panel-section').forEach(p => p.classList.remove('is-active'));
        btn.classList.add('is-active');
        const mapPanel = {
          executivo: 'rmrPanelExecutivo',
          metas: 'rmrPanelMetas',
          medicoes: 'rmrPanelMedicoes',
          backlog: 'rmrPanelBacklog',
          projecoes: 'rmrPanelProjecoes',
          funil: 'rmrPanelFunil',
          executivos: 'rmrPanelExecutivos',
          perdidos: 'rmrPanelPerdidos',
          margem: 'rmrPanelMargem',
          clientes: 'rmrPanelClientes'
        };
        const target = document.getElementById(mapPanel[btn.dataset.rmrTab]);
        if (target) target.classList.add('is-active');
      });
    });

    const reload = () => carregarRmr(true);
    selAno?.addEventListener('change', reload);
    selMes?.addEventListener('change', reload);
    document.getElementById('rmrIncluirExpurgos')?.addEventListener('change', reload);
    document.getElementById('btnAtualizarRmr')?.addEventListener('click', reload);
    document.getElementById('btnExportarRmrCsv')?.addEventListener('click', exportarRmrCsv);
  }

  async function carregarRmr(forcar = false) {
    setupRmrControls();
    if (!core().podeAcessarRelatorios()) return;

    const year = document.getElementById('rmrAnoSelect')?.value || '2026';
    const month = document.getElementById('rmrMesSelect')?.value || '10';
    const escopo = 'pbix';
    const incluirExpurgos = document.getElementById('rmrIncluirExpurgos')?.checked ? '1' : '0';
    const reqKey = `${year}-${month}-${escopo}-${incluirExpurgos}`;

    if (rmrPayload && rmrCarregadoKey === reqKey && !forcar) return;

    const loading = document.getElementById('rmrLoading');
    const conteudo = document.getElementById('rmrConteudo');
    const erro = document.getElementById('rmrErro');
    const btn = document.getElementById('btnAtualizarRmr');
    const jaVisivel = conteudo.style.display === 'block';

    if (!jaVisivel) {
      loading.style.display = 'flex';
      conteudo.style.display = 'none';
    } else {
      conteudo.classList.add('is-reloading');
    }
    erro.style.display = 'none';
    if (btn) btn.disabled = true;

    try {
      const qs = new URLSearchParams({ year, month, escopo, incluirExpurgos }).toString();
      const dados = await core().fetchRelatorioAutenticado(`/api/rmr?${qs}`);
      rmrPayload = dados;
      rmrCarregadoKey = reqKey;
      renderizarRmr(dados);
      conteudo.style.display = 'block';
    } catch (ex) {
      if (!jaVisivel) conteudo.style.display = 'none';
      erro.innerHTML = `<i class="ph ph-warning-circle"></i><span>${esc(ex.message || 'Falha ao carregar RMR Comercial.')}</span>`;
      erro.style.display = 'flex';
    } finally {
      loading.style.display = 'none';
      conteudo.classList.remove('is-reloading');
      if (btn) btn.disabled = false;
    }
  }

  function renderizarRmr(d) {
    const ex = d.executivo || {};
    const mesObj = ex.mes || {};
    const ytdObj = ex.ytd || {};
    const mName = MESES_PT[(d.parametros?.month || 1) - 1] || '';

    const protData = d.atualizacao?.protheusUltimaEmissao ? core().formatarDataBr(d.atualizacao.protheusUltimaEmissao) : '—';
    const protCarga = d.atualizacao?.protheusUltimaCarga ? new Date(d.atualizacao.protheusUltimaCarga).toLocaleString('pt-BR') : '';
    const bitData = d.atualizacao?.bitrixUltimaModificacao ? new Date(d.atualizacao.bitrixUltimaModificacao).toLocaleString('pt-BR') : '—';
    const bitExtr = d.atualizacao?.bitrixUltimaExtracao ? new Date(d.atualizacao.bitrixUltimaExtracao).toLocaleString('pt-BR') : '';
    const textoRmrAt = `Protheus emissão até ${protData}${protCarga ? ` (carga ${protCarga})` : ''} · Bitrix mod. ${bitData}${bitExtr ? ` (extração ${bitExtr})` : ''}`;
    document.getElementById('rmrAtualizacaoTexto').textContent = textoRmrAt;
    core().registrarAtualizacaoTela?.('relatorios:rmr', {
      updatedAt: d.geradoEm || Date.now(),
      sourceInfo: textoRmrAt,
      autoRefresh: true
    });
    document.getElementById('rmrFonteTexto').textContent =
      `Competência: ${mName}/${ex.ano} · Escopo: ${d.parametros?.escopo === 'all' ? 'Todas Filiais' : '7 Filiais PBIX'} (${d.parametros?.incluirExpurgos ? 'Bruto' : 'Comercial Puro'})`;

    // Aba 1: Visão Executiva
    document.getElementById('rmrKpiMesLabel').textContent = `Faturamento ${mName}/${ex.ano} (${d.parametros?.incluirExpurgos ? 'Bruto' : 'Puro'})`;
    document.getElementById('rmrKpiMesPrincipal').textContent = fmtMoeda(mesObj.valorPrincipal);
    document.getElementById('rmrKpiMesDelta').textContent =
      `MoM: ${fmtPct(mesObj.variacaoMoMPct, true)} · YoY: ${fmtPct(mesObj.variacaoYoYPct, true)} · ${fmtInt(mesObj.qtdNfs)} NFs`;

    document.getElementById('rmrKpiMesMeta').textContent = fmtMoeda(mesObj.meta);
    document.getElementById('rmrKpiMesAting').textContent =
      `Atingimento mês: ${fmtPct(mesObj.atingimentoPct)} · Aprop. CRM mês: ${fmtMoeda(mesObj.apropriacaoBitrix)}`;

    document.getElementById('rmrKpiYtdPrincipal').textContent = fmtMoeda(ytdObj.valorPrincipal);
    document.getElementById('rmrKpiYtdMeta').textContent =
      `Meta YTD: ${fmtMoeda(ytdObj.metaYtd)} (${fmtPct(ytdObj.atingimentoYtdPct)}) · YoY: ${fmtPct(ytdObj.variacaoYoYPct, true)}`;

    const inad = d.inadimplencia || {};
    const inadRes = inad.resumo || {};
    const elExecInad = document.getElementById('rmrKpiExecInad');
    if (elExecInad) {
      elExecInad.textContent = inad.disponivel ? fmtMoeda(inadRes.total365DiasValor) : '—';
      document.getElementById('rmrKpiExecInadSub').textContent = inad.disponivel
        ? `Atraso ≤30d: ${fmtMoeda(inadRes.ate30DiasValor)} · 31-365d: ${fmtMoeda(inadRes.de31a365DiasValor)} · ${fmtInt(inadRes.clientes365)} clientes`
        : 'Acesso SE1010 indisponível';
    }

    const blReal = d.backlogMedicoes?.backlogProtheusReal || {};
    const blRealRes = blReal.resumo || {};
    const elExecBl = document.getElementById('rmrKpiExecBacklog');
    if (elExecBl) {
      elExecBl.textContent = blReal.disponivel ? fmtMoeda(blRealRes.backlogReal) : '—';
      document.getElementById('rmrKpiExecBacklogSub').textContent = blReal.disponivel
        ? `${fmtInt(blRealRes.qtdVigentes)} contratos vigentes · Global: ${fmtMoeda(blRealRes.valorGlobal)}`
        : 'Dados Protheus indisponíveis';
    }

    const pipeExec = d.projecoes?.pipelineAberto || {};
    const elExecFn = document.getElementById('rmrKpiExecFunil');
    if (elExecFn) {
      elExecFn.textContent = fmtMoeda(pipeExec.brutoTotal);
      document.getElementById('rmrKpiExecFunilSub').textContent =
        `Ponderado: ${fmtMoeda(pipeExec.ponderadoTotal)} · ${fmtInt(pipeExec.qtdNegocios)} deals abertos`;
    }

    const elInadFaixas = document.getElementById('rmrExecInadFaixas');
    if (elInadFaixas) {
      renderRankingList('rmrExecInadFaixas', inad.porFaixa || [], {
        labelKey: 'faixa',
        valueKey: 'valor',
        detailFn: f => `${fmtInt(f.qtd)} títulos em aberto`,
        emptyMsg: 'Sem títulos vencidos no recorte.'
      });
    }
    const elInadClientes = document.getElementById('tbodyRmrExecInadClientes');
    if (elInadClientes) {
      const topInad = inad.topClientes || [];
      elInadClientes.innerHTML = topInad.length
        ? topInad.map(c => `
            <tr>
              <td><strong>${esc(c.cliente)}</strong></td>
              <td class="num">${fmtInt(c.qtdTitulos)}</td>
              <td class="num">${fmtInt(c.maxDiasAtraso)}d</td>
              <td class="num"><strong>${fmtMoedaExata(c.valor)}</strong></td>
            </tr>`).join('')
        : '<tr><td colspan="4" class="contracts-empty">Sem títulos vencidos ≤ 365 dias.</td></tr>';
    }

    document.getElementById('rmrKpiYtdBruto').textContent = fmtMoeda(ytdObj.faturamentoBruto);
    document.getElementById('rmrKpiYtdExpurgos').textContent =
      `Expurgos YTD: ${fmtMoeda(ytdObj.expurgos)} · Meta Anual: ${fmtMoeda(ytdObj.metaAnual)}`;

    document.getElementById('rmrReconciliacaoAlert').innerHTML = `
      <i class="ph ph-check-circle"></i>
      <div>
        <strong>Reconciliação de Fontes RMR:</strong>
        ${esc(d.fontes?.observacaoReconciliacao || '')}
      </div>`;

    document.getElementById('rmrSerieSub').textContent = `${ex.ano} · Barras = Faturamento Protheus · Linha = Meta Unidades (clique no mês para alternar)`;
    renderMonthlyComparisonBars('rmrGraficoMensal', d.serieMensal || [], {
      activeMes: ex.mesReferencia,
      onClick: mesIso => {
        const mNum = String(Number(mesIso.slice(-2)));
        const selMes = document.getElementById('rmrMesSelect');
        if (selMes && selMes.value !== mNum) {
          selMes.value = mNum;
          carregarRmr(true);
        }
      }
    });

    const serieMensal = d.serieMensal || [];
    const tbodyMensal = document.getElementById('tbodyRmrMensal');
    tbodyMensal.innerHTML = serieMensal.map(r => {
      const mIdx = Number(r.mesNumero || 1) - 1;
      const rowCls = r.mes === ex.mesReferencia ? 'row-highlight' : (!r.fechado ? 'row-muted' : '');
      const faturado = Number(r.valorPrincipal ?? r.liquido ?? 0);
      return `
        <tr class="${rowCls}">
          <td><strong>${MESES_CURTO[mIdx] || r.mes}/${String(ex.ano).slice(-2)}</strong> ${r.mes === ex.mesReferencia ? '<span class="metric-pill is-info">Ref.</span>' : ''}</td>
          <td class="num"><strong>${fmtMoedaExata(faturado)}</strong></td>
          <td class="num">${fmtMoedaExata(r.metaUnidades)}</td>
          <td class="num">${badgePct(r.atingimentoPct)}</td>
        </tr>`;
    }).join('');

    const tfootMensal = document.getElementById('tfootRmrMensal');
    if (tfootMensal) {
      if (serieMensal.length) {
        const totFat = serieMensal.reduce((acc, r) => acc + Number(r.valorPrincipal ?? r.liquido ?? 0), 0);
        const totMeta = serieMensal.reduce((acc, r) => acc + Number(r.metaUnidades || 0), 0);
        const totAting = totMeta > 0 ? (totFat / totMeta) * 100 : null;
        tfootMensal.innerHTML = `
          <tr class="table-total-row">
            <td><strong>Total</strong></td>
            <td class="num"><strong>${fmtMoedaExata(totFat)}</strong></td>
            <td class="num"><strong>${fmtMoedaExata(totMeta)}</strong></td>
            <td class="num">${badgePct(totAting)}</td>
          </tr>`;
      } else {
        tfootMensal.innerHTML = '';
      }
    }

    // Aba 2: Metas vs Realizado
    const unidades = d.metasVsRealizado?.unidades || [];
    const btnExpandUnidStyle = 'display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-right:6px;border:1px solid #cbd5e1;border-radius:4px;background:#f8fafc;color:#0f2942;font-weight:700;cursor:pointer;font-size:13px;line-height:1;';
    const renderUnidItensHtml = itens => {
      if (!itens || !itens.length) return '<div class="contracts-empty" style="padding:6px;">Sem itens detalhados nas NFs.</div>';
      return `
        <table class="contracts-table" style="margin:4px 0;background:#fff;border:1px solid #e2e8f0;">
          <thead>
            <tr>
              <th>Cód. Produto</th>
              <th>Item / Produto / Equipamento</th>
              <th class="num">Qtd.</th>
              <th class="num">NFs</th>
              <th class="num">Faturado YTD</th>
            </tr>
          </thead>
          <tbody>
            ${itens.map(it => `
              <tr>
                <td><code>${esc(it.codProduto)}</code></td>
                <td>${esc(it.produto)}</td>
                <td class="num">${Number(it.quantidade || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}</td>
                <td class="num">${fmtInt(it.qtdNfsYtd)}</td>
                <td class="num"><strong>${fmtMoedaExata(it.valorYtd)}</strong></td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    };

    document.getElementById('tbodyRmrMetasUnidades').innerHTML = unidades.length
      ? unidades.map((u, uIdx) => {
          const clis = u.clientes || [];
          return `
          <tr>
            <td>
              ${clis.length ? `<button type="button" class="rmr-expand-btn" data-expand-target="rmr-unid-clis-${uIdx}" style="${btnExpandUnidStyle}" title="Expandir clientes da unidade">+</button>` : ''}
              <strong>${esc(u.unidade)}</strong> ${u.isExpurgoUnidade ? '<span class="metric-pill is-neutral">Expurgo</span>' : ''}
            </td>
            <td class="num">${fmtMoedaExata(u.realizadoMes)}</td>
            <td class="num">${fmtMoedaExata(u.metaMes)}</td>
            <td class="num">${badgePct(u.atingimentoMesPct)}</td>
            <td class="num"><strong>${fmtMoedaExata(u.realizadoYtd)}</strong></td>
            <td class="num">${fmtMoedaExata(u.metaYtd)}</td>
            <td class="num">${badgePct(u.atingimentoYtdPct)}</td>
            <td class="num">${fmtMoedaExata(u.metaAnual)}</td>
            <td class="num">${fmtMoedaExata(u.runRateAnual)}</td>
          </tr>
          ${clis.length ? `
          <tr id="rmr-unid-clis-${uIdx}" style="display:none;background:#f8fafc;">
            <td colspan="9" style="padding:10px 14px 10px 28px;">
              <div style="font-size:11.5px;font-weight:700;color:#475569;margin-bottom:6px;">Clientes de ${esc(u.unidade)} (${fmtInt(clis.length)}):</div>
              <table class="contracts-table" style="background:#fff;border:1px solid #cbd5e1;">
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th class="num">Faturado Mês Ref.</th>
                    <th class="num">Faturado YTD</th>
                    <th class="num">NFs YTD</th>
                  </tr>
                </thead>
                <tbody>
                  ${clis.map((cl, cIdx) => {
                    const ctrs = cl.contratos || [];
                    return `
                    <tr>
                      <td>
                        ${ctrs.length ? `<button type="button" class="rmr-expand-btn" data-expand-target="rmr-unid-cli-ctrs-${uIdx}-${cIdx}" style="${btnExpandUnidStyle}" title="Expandir contratos do cliente">+</button>` : ''}
                        <strong>${esc(cl.cliente)}</strong>
                      </td>
                      <td class="num">${fmtMoedaExata(cl.valorMes)}</td>
                      <td class="num"><strong>${fmtMoedaExata(cl.valorYtd)}</strong></td>
                      <td class="num">${fmtInt(cl.qtdNfsYtd)}</td>
                    </tr>
                    ${ctrs.length ? `
                    <tr id="rmr-unid-cli-ctrs-${uIdx}-${cIdx}" style="display:none;background:#f1f5f9;">
                      <td colspan="4" style="padding:8px 12px 8px 28px;">
                        <div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:4px;">Contratos de ${esc(cl.cliente)} (${fmtInt(ctrs.length)}):</div>
                        <table class="contracts-table" style="background:#fff;border:1px solid #cbd5e1;">
                          <thead>
                            <tr>
                              <th>Contrato</th>
                              <th class="num">Faturado Mês Ref.</th>
                              <th class="num">Faturado YTD</th>
                              <th class="num">NFs YTD</th>
                            </tr>
                          </thead>
                          <tbody>
                            ${ctrs.map((cc, kIdx) => {
                              const itens = cc.itens || [];
                              const labelCtr = cc.numeroContrato === 'SEM_CONTRATO' ? 'Sem contrato vinculado' : cc.numeroContrato;
                              return `
                              <tr>
                                <td>
                                  ${itens.length ? `<button type="button" class="rmr-expand-btn" data-expand-target="rmr-unid-ctr-itens-${uIdx}-${cIdx}-${kIdx}" style="${btnExpandUnidStyle}" title="Expandir itens/equipamentos">+</button>` : ''}
                                  <strong>${esc(labelCtr)}</strong>
                                </td>
                                <td class="num">${fmtMoedaExata(cc.valorMes)}</td>
                                <td class="num"><strong>${fmtMoedaExata(cc.valorYtd)}</strong></td>
                                <td class="num">${fmtInt(cc.qtdNfsYtd)}</td>
                              </tr>
                              ${itens.length ? `
                              <tr id="rmr-unid-ctr-itens-${uIdx}-${cIdx}-${kIdx}" style="display:none;background:#e2e8f0;">
                                <td colspan="4" style="padding:6px 10px 6px 24px;">
                                  ${renderUnidItensHtml(itens)}
                                </td>
                              </tr>` : ''}`;
                            }).join('')}
                          </tbody>
                        </table>
                      </td>
                    </tr>` : ''}`;
                  }).join('')}
                </tbody>
              </table>
            </td>
          </tr>` : ''}`;
        }).join('')
      : '<tr><td colspan="9" class="contracts-empty">Sem dados de unidades no período.</td></tr>';

    document.querySelectorAll('#tbodyRmrMetasUnidades .rmr-expand-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-expand-target');
        const row = targetId ? document.getElementById(targetId) : null;
        if (!row) return;
        const isOpen = row.style.display !== 'none';
        row.style.display = isOpen ? 'none' : 'table-row';
        btn.textContent = isOpen ? '+' : '−';
        btn.classList.toggle('is-open', !isOpen);
        btn.closest('tr')?.classList.toggle('rmr-row-expanded', !isOpen);
        row.classList.toggle('rmr-subrow-open', !isOpen);
      });
    });

    const tfootUnidades = document.getElementById('tfootRmrMetasUnidades');
    if (tfootUnidades) {
      if (unidades.length) {
        const tot = unidades.reduce((acc, u) => {
          acc.realizadoMes += Number(u.realizadoMes || 0);
          acc.metaMes += Number(u.metaMes || 0);
          acc.realizadoYtd += Number(u.realizadoYtd || 0);
          acc.metaYtd += Number(u.metaYtd || 0);
          acc.metaAnual += Number(u.metaAnual || 0);
          acc.runRateAnual += Number(u.runRateAnual || 0);
          return acc;
        }, { realizadoMes: 0, metaMes: 0, realizadoYtd: 0, metaYtd: 0, metaAnual: 0, runRateAnual: 0 });
        const atingMesTot = tot.metaMes > 0 ? (tot.realizadoMes / tot.metaMes) * 100 : null;
        const atingYtdTot = tot.metaYtd > 0 ? (tot.realizadoYtd / tot.metaYtd) * 100 : null;
        tfootUnidades.innerHTML = `
          <tr class="table-total-row">
            <td><strong>Total</strong></td>
            <td class="num"><strong>${fmtMoedaExata(tot.realizadoMes)}</strong></td>
            <td class="num"><strong>${fmtMoedaExata(tot.metaMes)}</strong></td>
            <td class="num">${badgePct(atingMesTot)}</td>
            <td class="num"><strong>${fmtMoedaExata(tot.realizadoYtd)}</strong></td>
            <td class="num"><strong>${fmtMoedaExata(tot.metaYtd)}</strong></td>
            <td class="num">${badgePct(atingYtdTot)}</td>
            <td class="num"><strong>${fmtMoedaExata(tot.metaAnual)}</strong></td>
            <td class="num"><strong>${fmtMoedaExata(tot.runRateAnual)}</strong></td>
          </tr>`;
      } else {
        tfootUnidades.innerHTML = '';
      }
    }

    const execs = d.metasVsRealizado?.executivos || [];
    document.getElementById('tbodyRmrMetasExecutivos').innerHTML = execs.length
      ? execs.map((e, eIdx) => {
          const clis = e.clientes || [];
          return `
          <tr>
            <td>
              ${clis.length ? `<button type="button" class="rmr-expand-btn" data-expand-target="rmr-exec-clis-${eIdx}" style="${btnExpandUnidStyle}" title="Expandir clientes do executivo">+</button>` : ''}
              <strong>${esc(e.executivo)}</strong> <small class="text-muted">(${esc(e.codVendedor)})</small>
            </td>
            <td>${esc(e.unidadeMeta)}</td>
            <td class="num">${fmtMoedaExata(e.realizadoMes)}</td>
            <td class="num">${e.metaMes > 0 ? fmtMoedaExata(e.metaMes) : '—'} ${e.metaFonte === 'Planilha RMR' ? '<span class="metric-pill is-info" title="Meta mensal vinda da planilha RMR_Base_Oficial_Editavel.xlsx">Plan.</span>' : ''}</td>
            <td class="num">${badgePct(e.atingimentoMesPct)}</td>
            <td class="num"><strong>${fmtMoedaExata(e.realizadoYtd)}</strong></td>
            <td class="num">${e.metaProportionalYtd > 0 ? fmtMoedaExata(e.metaProportionalYtd) : '—'}</td>
            <td class="num">${badgePct(e.atingimentoYtdPct)}</td>
            <td class="num">${e.metaAnualAlvo > 0 ? fmtMoedaExata(e.metaAnualAlvo) : '—'}</td>
            <td class="num ${e.gapAnual !== null && e.gapAnual < 0 ? 'text-neg' : 'text-pos'}">${e.gapAnual !== null ? fmtMoedaExata(e.gapAnual) : '—'}</td>
            <td class="num">${fmtInt(e.qtdNfsYtd)} / ${fmtInt(e.qtdClientesYtd)}</td>
          </tr>
          ${clis.length ? `
          <tr id="rmr-exec-clis-${eIdx}" style="display:none;background:#f8fafc;">
            <td colspan="11" style="padding:10px 14px 10px 28px;text-align:left;">
              <div style="font-size:11.5px;font-weight:700;color:#475569;margin-bottom:6px;">Clientes de ${esc(e.executivo)} (${fmtInt(clis.length)}):</div>
              <table class="contracts-table" style="background:#fff;border:1px solid #cbd5e1;">
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th class="num">Faturado Mês Ref.</th>
                    <th class="num">Faturado YTD</th>
                    <th class="num">NFs YTD</th>
                  </tr>
                </thead>
                <tbody>
                  ${clis.map((cl, cIdx) => {
                    const ctrs = cl.contratos || [];
                    return `
                    <tr>
                      <td style="text-align:left;">
                        ${ctrs.length ? `<button type="button" class="rmr-expand-btn" data-expand-target="rmr-exec-cli-ctrs-${eIdx}-${cIdx}" style="${btnExpandUnidStyle}" title="Expandir contratos do cliente">+</button>` : ''}
                        <strong>${esc(cl.cliente)}</strong>
                      </td>
                      <td class="num">${fmtMoedaExata(cl.valorMes)}</td>
                      <td class="num"><strong>${fmtMoedaExata(cl.valorYtd)}</strong></td>
                      <td class="num">${fmtInt(cl.qtdNfsYtd)}</td>
                    </tr>
                    ${ctrs.length ? `
                    <tr id="rmr-exec-cli-ctrs-${eIdx}-${cIdx}" style="display:none;background:#f1f5f9;">
                      <td colspan="4" style="padding:8px 12px 8px 28px;text-align:left;">
                        <div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:4px;">Contratos de ${esc(cl.cliente)} (${fmtInt(ctrs.length)}):</div>
                        <table class="contracts-table" style="background:#fff;border:1px solid #cbd5e1;">
                          <thead>
                            <tr>
                              <th>Contrato</th>
                              <th>Unidade</th>
                              <th class="num">Faturado Mês Ref.</th>
                              <th class="num">Faturado YTD</th>
                              <th class="num">NFs YTD</th>
                            </tr>
                          </thead>
                          <tbody>
                            ${ctrs.map(cc => {
                              const labelCtr = cc.numeroContrato === 'SEM_CONTRATO' ? 'Sem contrato vinculado' : cc.numeroContrato;
                              return `
                              <tr>
                                <td style="text-align:left;"><strong>${esc(labelCtr)}</strong></td>
                                <td>${esc(cc.unidade)}</td>
                                <td class="num">${fmtMoedaExata(cc.valorMes)}</td>
                                <td class="num"><strong>${fmtMoedaExata(cc.valorYtd)}</strong></td>
                                <td class="num">${fmtInt(cc.qtdNfsYtd)}</td>
                              </tr>`;
                            }).join('')}
                          </tbody>
                        </table>
                      </td>
                    </tr>` : ''}`;
                  }).join('')}
                </tbody>
              </table>
            </td>
          </tr>` : ''}`;
        }).join('')
      : '<tr><td colspan="11" class="contracts-empty">Sem executivos com movimento ou meta no período.</td></tr>';

    document.querySelectorAll('#tbodyRmrMetasExecutivos .rmr-expand-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-expand-target');
        const row = targetId ? document.getElementById(targetId) : null;
        if (!row) return;
        const isOpen = row.style.display !== 'none';
        row.style.display = isOpen ? 'none' : 'table-row';
        btn.textContent = isOpen ? '+' : '−';
        btn.classList.toggle('is-open', !isOpen);
        btn.closest('tr')?.classList.toggle('rmr-row-expanded', !isOpen);
        row.classList.toggle('rmr-subrow-open', !isOpen);
      });
    });

    // Aba Medições Pendentes (Slide 3)
    const bm = d.backlogMedicoes || {};
    const medPlanTab = bm.medicoesPlanilha || {};
    const medItensTab = medPlanTab.itens || [];
    const elMedBanner = document.getElementById('rmrMedicoesStatusBanner');
    if (elMedBanner) {
      const compDiff = medPlanTab.competencia && medPlanTab.mesSolicitado && medPlanTab.competencia !== medPlanTab.mesSolicitado;
      elMedBanner.className = `report-status-banner ${compDiff ? 'is-warning' : 'is-info'}`;
      elMedBanner.innerHTML = `
        <i class="ph ${compDiff ? 'ph-warning' : 'ph-info'}"></i>
        <div>
          <strong>Competência exibida: ${esc(medPlanTab.competencia || '—')}</strong>
          ${compDiff ? ` (Mês selecionado: ${esc(medPlanTab.mesSolicitado)} ainda sem carga de Medições Pendentes — exibindo última competência disponível).` : ' · Fonte: Planilha Editável RMR / SharePoint CONTROLE DE MEDICAO.'}
        </div>`;
      const sumMod = mod => medItensTab.filter(x => String(x.modalidade || '').toLowerCase() === mod);
      const valContrato = sumMod('contrato').reduce((s, x) => s + Number(x.valor || 0), 0);
      const valSpot = sumMod('spot').reduce((s, x) => s + Number(x.valor || 0), 0);
      const aguard = medItensTab.filter(x => x.aguardandoPedido);
      const valAguard = aguard.reduce((s, x) => s + Number(x.valor || 0), 0);
      document.getElementById('rmrMedTotalVal').textContent = fmtMoeda(medPlanTab.valorTotal);
      document.getElementById('rmrMedTotalQtd').textContent = `${fmtInt(medPlanTab.qtd)} medições pendentes`;
      document.getElementById('rmrMedContratoVal').textContent = fmtMoeda(valContrato);
      document.getElementById('rmrMedContratoQtd').textContent = `${fmtInt(sumMod('contrato').length)} itens de contrato`;
      document.getElementById('rmrMedSpotVal').textContent = fmtMoeda(valSpot);
      document.getElementById('rmrMedSpotQtd').textContent = `${fmtInt(sumMod('spot').length)} itens spot`;
      document.getElementById('rmrMedAguardVal').textContent = fmtMoeda(valAguard);
      document.getElementById('rmrMedAguardQtd').textContent = `${fmtInt(aguard.length)} itens aguardando pedido`;
      document.getElementById('rmrMedicoesTabTag').textContent = `Comp. ${medPlanTab.competencia || '—'} · ${fmtInt(medPlanTab.qtd)} itens`;
      document.getElementById('tbodyRmrMedicoesTab').innerHTML = medItensTab.length
        ? medItensTab.map(m => `
            <tr>
              <td><span class="metric-pill is-info">${esc(m.modalidade)}</span></td>
              <td><strong>${esc(m.cliente)}</strong></td>
              <td>${esc(m.unidade)}</td>
              <td>${m.aguardandoPedido ? '<span class="metric-pill is-warn">* Aguardando pedido</span>' : 'Em faturamento'}</td>
              <td class="num"><strong>${fmtMoedaExata(m.valor)}</strong></td>
            </tr>`).join('')
        : '<tr><td colspan="5" class="contracts-empty">Sem medições pendentes cadastradas.</td></tr>';
    }

    // Aba Backlog (Protheus Real: Timeline + Tabela)
    const blProth = bm.backlogProtheusReal || {};
    const blProthRes = blProth.resumo || {};
    if (document.getElementById('rmrBlRealTotal')) {
      document.getElementById('rmrBlRealTotal').textContent = fmtMoeda(blProthRes.backlogReal);
      document.getElementById('rmrBlRealQtd').textContent = `${fmtInt(blProthRes.qtdVigentes)} contratos vigentes (sem duplicidade)`;
      document.getElementById('rmrBlRealGlobal').textContent = fmtMoeda(blProthRes.valorGlobal);
      document.getElementById('rmrBlRealFat').textContent = fmtMoeda(blProthRes.faturadoReal);
      const pctFatGeral = blProthRes.valorGlobal > 0 ? (blProthRes.faturadoReal / blProthRes.valorGlobal) * 100 : 0;
      document.getElementById('rmrBlRealPct').textContent = `${pctFatGeral.toFixed(1)}% do valor global faturado`;
      const venc60Val = Number(blProthRes.vencendo30dValor || 0) + Number(blProthRes.vencendo60dValor || 0);
      const venc60Qtd = Number(blProthRes.vencendo30dQtd || 0) + Number(blProthRes.vencendo60dQtd || 0);
      document.getElementById('rmrBlRealVenc60').textContent = fmtMoeda(venc60Val);
      document.getElementById('rmrBlRealVenc60Qtd').textContent = `${fmtInt(venc60Qtd)} contratos vencem em até 60d`;

      const UNIDS_OFICIAIS_BL = ['Complexo', 'Engenharia', 'Norte', 'Pecém', 'Transportes', 'Wind'];
      const EXECS_OFICIAIS_BL = ['CRISTIANO', 'BRUNO', 'FERNANDO', 'CORDEIRO', 'CRISTIANE', 'MARCIO', 'FABRICIO'];
      const isExecOficialBl = nome => {
        const n = String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
        return EXECS_OFICIAIS_BL.some(ex => n.includes(ex));
      };
      const fmtTitleCase = s => String(s || '')
        .toLowerCase()
        .replace(/\b\w/g, ch => ch.toUpperCase());

      const allBlContracts = blProth.contratos || [];
      const selBlUnid = document.getElementById('rmrBlUnidadeFilter');
      if (selBlUnid) {
        const curU = selBlUnid.value || 'ALL';
        const unids = [...new Set(allBlContracts.map(c => c.unidade).filter(u => UNIDS_OFICIAIS_BL.includes(u)))].sort();
        selBlUnid.innerHTML = '<option value="ALL">Todas as unidades</option>' +
          unids.map(u => `<option value="${esc(u)}"${u === curU ? ' selected' : ''}>${esc(u)}</option>`).join('');
      }
      const selBlExec = document.getElementById('rmrBlExecutivoFilter');
      if (selBlExec) {
        const curE = selBlExec.value || 'ALL';
        const execs = [...new Set(allBlContracts.map(c => c.responsavel).filter(isExecOficialBl))].sort();
        selBlExec.innerHTML = '<option value="ALL">Todos os executivos</option>' +
          execs.map(e => `<option value="${esc(e)}"${e === curE ? ' selected' : ''}>${esc(fmtTitleCase(e))}</option>`).join('');
      }

      const initCustomDd = (selectEl, iconCls) => {
        if (!selectEl) return;
        const fieldWrap = selectEl.closest('.rmr-bl-field');
        if (!fieldWrap) return;
        let dd = fieldWrap.nextElementSibling;
        if (!dd || !dd.classList.contains('rmr-dd')) {
          fieldWrap.style.display = 'none';
          dd = document.createElement('div');
          dd.className = 'rmr-dd';
          fieldWrap.insertAdjacentElement('afterend', dd);
        }
        if (!Array.isArray(selectEl._multiVals)) {
          selectEl._multiVals = selectEl.value && selectEl.value !== 'ALL' ? [selectEl.value] : [];
        }
        const multi = selectEl._multiVals;
        const isFiltered = multi.length > 0;
        let triggerLabel = selectEl.options[0]?.textContent || '';
        if (multi.length === 1) {
          const optMatch = Array.from(selectEl.options).find(o => o.value === multi[0]);
          triggerLabel = optMatch ? optMatch.textContent : multi[0];
        } else if (multi.length > 1) {
          const labels = multi.map(v => {
            const optMatch = Array.from(selectEl.options).find(o => o.value === v);
            return optMatch ? optMatch.textContent : v;
          });
          triggerLabel = `${multi.length} selecionados (${labels.join(', ')})`;
        }

        const wasOpenBefore = dd.classList.contains('is-open');
        dd.innerHTML = `
          <button type="button" class="rmr-dd-trigger ${isFiltered ? 'is-filtered' : ''}" title="${esc(triggerLabel)} · Segure Ctrl para selecionar mais de uma">
            <i class="ph ${iconCls}"></i>
            <span style="max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(triggerLabel)}</span>
            <i class="ph ph-caret-down" style="font-size:12px;opacity:.7;"></i>
          </button>
          <div class="rmr-dd-menu">
            ${Array.from(selectEl.options).map(opt => {
              const selected = opt.value === 'ALL' ? multi.length === 0 : multi.includes(opt.value);
              return `
              <button type="button" class="rmr-dd-item ${selected ? 'is-selected' : ''}" data-val="${esc(opt.value)}">
                <span>${esc(opt.textContent)}</span>
                ${selected ? '<i class="ph ph-check" style="font-size:13px;"></i>' : ''}
              </button>`;
            }).join('')}
            <div style="font-size:10px;color:#64748b;padding:5px 8px 2px;border-top:1px solid #f1f5f9;margin-top:4px;">
              Dica: segure <strong>Ctrl</strong> para marcar vários
            </div>
          </div>`;
        if (wasOpenBefore) dd.classList.add('is-open');

        const trig = dd.querySelector('.rmr-dd-trigger');
        trig.addEventListener('click', ev => {
          ev.stopPropagation();
          const wasOpen = dd.classList.contains('is-open');
          document.querySelectorAll('.rmr-dd.is-open').forEach(x => x.classList.remove('is-open'));
          if (!wasOpen) dd.classList.add('is-open');
        });
        dd.querySelectorAll('.rmr-dd-item').forEach(item => {
          item.addEventListener('click', ev => {
            ev.stopPropagation();
            const val = item.getAttribute('data-val');
            const isCtrl = ev.ctrlKey || ev.metaKey;
            if (val === 'ALL') {
              selectEl._multiVals = [];
              selectEl.value = 'ALL';
              dd.classList.remove('is-open');
            } else if (isCtrl) {
              const cur = [...(selectEl._multiVals || [])];
              const idx = cur.indexOf(val);
              if (idx >= 0) cur.splice(idx, 1);
              else cur.push(val);
              selectEl._multiVals = cur;
              selectEl.value = cur.length === 1 ? cur[0] : (cur.length === 0 ? 'ALL' : cur[0]);
            } else {
              selectEl._multiVals = [val];
              selectEl.value = val;
              dd.classList.remove('is-open');
            }
            selectEl.dispatchEvent(new Event('change'));
          });
        });
        if (!document._rmrDdOutsideBound) {
          document._rmrDdOutsideBound = true;
          document.addEventListener('click', () => {
            document.querySelectorAll('.rmr-dd.is-open').forEach(x => x.classList.remove('is-open'));
          });
        }
      };

      initCustomDd(selBlUnid, 'ph-buildings');
      initCustomDd(selBlExec, 'ph-user');

      const renderBacklogProtheusView = () => {
        const uMulti = selBlUnid?._multiVals || [];
        const eMulti = selBlExec?._multiVals || [];
        const clearBtn = document.getElementById('rmrBlClearBtn');
        if (clearBtn) {
          clearBtn.style.display = (uMulti.length > 0 || eMulti.length > 0) ? 'inline-flex' : 'none';
        }
        const viewBtn = document.querySelector('.rmr-bl-view-btn.is-active');
        const viewMode = viewBtn?.dataset.blView || 'ambos';
        const list = allBlContracts.filter(c =>
          (uMulti.length === 0 || uMulti.includes(c.unidade)) &&
          (eMulti.length === 0 || eMulti.includes(c.responsavel))
        );

        const tlWrap = document.getElementById('rmrBlTimelineContainer');
        const tbWrap = document.getElementById('rmrBlTableContainer');
        if (tlWrap) tlWrap.style.display = (viewMode === 'ambos' || viewMode === 'timeline') ? 'block' : 'none';
        if (tbWrap) tbWrap.style.display = (viewMode === 'ambos' || viewMode === 'tabela') ? 'block' : 'none';

        if (tlWrap && (viewMode === 'ambos' || viewMode === 'timeline')) {
          const dated = list.filter(c => c.dataInicio && c.dataFim && c.valorGlobal > 0).slice(0, 20);
          if (!dated.length) {
            tlWrap.innerHTML = '<div class="contracts-empty">Sem contratos vigentes com vigência para exibir na timeline.</div>';
          } else {
            const minTs = Math.min(...dated.map(c => new Date(c.dataInicio).getTime()));
            const maxTs = Math.max(...dated.map(c => new Date(c.dataFim).getTime()));
            const span = Math.max(1, maxTs - minTs);
            const nowTs = Date.now();
            const todayPct = Math.max(0, Math.min(100, ((nowTs - minTs) / span) * 100));

            tlWrap.innerHTML = `
              <div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-bottom:8px;padding:0 4px;">
                <span>Início janela: <strong>${core().formatarDataBr(new Date(minTs).toISOString().slice(0, 10))}</strong></span>
                <span>Linha vermelha = <strong>Hoje (${core().formatarDataBr(new Date(nowTs).toISOString().slice(0, 10))})</strong> · Top 20 contratos</span>
                <span>Fim janela: <strong>${core().formatarDataBr(new Date(maxTs).toISOString().slice(0, 10))}</strong></span>
              </div>
              <div style="position:relative;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;background:#f8fafc;">
                <div class="rmr-tl-today" style="position:absolute;top:0;bottom:0;left:calc(352px + (100% - 366px) * ${todayPct / 100});width:2px;background:#ef4444;opacity:0.7;z-index:2;pointer-events:none;"></div>
                ${dated.map(c => {
                  const sTs = new Date(c.dataInicio).getTime();
                  const eTs = new Date(c.dataFim).getTime();
                  const leftPct = Math.max(0, ((sTs - minTs) / span) * 100);
                  const widthPct = Math.max(6, ((eTs - sTs) / span) * 100);
                  const execPct = Math.max(0, Math.min(100, c.pctConsumido || 0));
                  const dtIniBr = core().formatarDataBr(c.dataInicio);
                  const dtFimBr = core().formatarDataBr(c.dataFim);
                  const diasDec = c.diasDecorridos !== null ? `${c.diasDecorridos}d` : '—';
                  const diasFalt = c.diasRestantes !== null ? `${c.diasRestantes}d` : '—';
                  const corFalt = c.diasRestantes !== null && c.diasRestantes <= 30 ? '#dc2626' : (c.diasRestantes !== null && c.diasRestantes <= 60 ? '#d97706' : '#0f766e');
                  return `
                    <div class="rmr-tl-row">
                      <div class="rmr-tl-label" title="${esc(c.cliente)} · #${esc(c.nrContrato)}">
                        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><strong>#${esc(c.nrContrato)}</strong> ${esc(c.cliente)}</div>
                        <div style="color:#475569;font-size:10.5px;">${esc(c.unidade)} · ${esc(c.responsavel)}</div>
                        <div style="color:#64748b;font-size:10.5px;">Início: <strong>${dtIniBr}</strong> · Hoje: <strong>${diasDec}</strong> · Fim: <strong>${dtFimBr}</strong> <span style="color:${corFalt};font-weight:700;">(faltam ${diasFalt})</span></div>
                      </div>
                      <div class="rmr-tl-bar-col">
                        <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#334155;padding:0 2px;">
                          <span><span style="display:inline-block;width:8px;height:8px;background:#0f2942;border-radius:2px;margin-right:4px;"></span>Faturado: <strong>${fmtMoeda(c.faturadoReal)}</strong> (${execPct.toFixed(0)}%)</span>
                          <span><span style="display:inline-block;width:8px;height:8px;background:#0ea5e9;border-radius:2px;margin-right:4px;"></span>A Faturar: <strong>${fmtMoeda(c.backlogReal)}</strong></span>
                        </div>
                        <div style="position:relative;height:14px;background:#e2e8f0;border-radius:7px;overflow:hidden;">
                          <div style="position:absolute;left:${leftPct}%;width:${widthPct}%;height:100%;background:#0ea5e9;border-radius:7px;display:flex;align-items:center;overflow:hidden;" title="Global: ${fmtMoedaExata(c.valorGlobal)} | Faturado: ${fmtMoedaExata(c.faturadoReal)} | A Faturar: ${fmtMoedaExata(c.backlogReal)}">
                            <div style="width:${execPct}%;height:100%;background:#0f2942;"></div>
                          </div>
                        </div>
                      </div>
                    </div>`;
                }).join('')}
                <div style="display:flex;gap:16px;font-size:11px;color:#475569;margin-top:6px;">
                  <span><span style="display:inline-block;width:10px;height:10px;background:#0f2942;border-radius:2px;margin-right:4px;"></span>Faturado (SD2010)</span>
                  <span><span style="display:inline-block;width:10px;height:10px;background:#0ea5e9;border-radius:2px;margin-right:4px;"></span>A Faturar (Backlog)</span>
                  <span><span style="display:inline-block;width:2px;height:10px;background:#ef4444;margin-right:4px;vertical-align:middle;"></span>Data Atual (Hoje)</span>
                </div>
              </div>`;
          }
        }

        const tbodyBl = document.getElementById('tbodyRmrBlReal');
        if (tbodyBl) {
          tbodyBl.innerHTML = list.length
            ? list.map(c => {
                const iniStr = c.dataInicio ? core().formatarDataBr(c.dataInicio) : '—';
                const fimStr = c.dataFim ? core().formatarDataBr(c.dataFim) : '—';
                const hojeBadge = c.diasDecorridos !== null ? `<span class="metric-pill is-neutral">Hoje: ${c.diasDecorridos}d</span>` : '';
                const faltamBadge = c.diasRestantes !== null
                  ? `<span class="metric-pill ${c.diasRestantes <= 60 ? 'is-warn' : 'is-info'}">Faltam ${c.diasRestantes}d</span>`
                  : '';
                return `
                <tr>
                  <td><strong>${esc(c.nrContrato)}</strong></td>
                  <td>${esc(c.cliente)}</td>
                  <td>${esc(c.unidade)}</td>
                  <td>${esc(c.responsavel)}</td>
                  <td><span class="metric-pill is-info">${esc(c.modalidade)}</span></td>
                  <td>${iniStr} → ${fimStr}<br/>${hojeBadge} ${faltamBadge}</td>
                  <td class="num">${fmtMoedaExata(c.valorGlobal)}</td>
                  <td class="num">${fmtMoedaExata(c.faturadoReal)}</td>
                  <td class="num"><strong>${fmtMoedaExata(c.backlogReal)}</strong></td>
                  <td class="num">${Number(c.pctConsumido || 0).toFixed(1)}%</td>
                </tr>`;
              }).join('')
            : '<tr><td colspan="10" class="contracts-empty">Sem contratos vigentes no recorte.</td></tr>';
        }
      };

      renderBacklogProtheusView();
      if (selBlUnid && !selBlUnid._bound) {
        selBlUnid._bound = true;
        selBlUnid.addEventListener('change', () => {
          initCustomDd(selBlUnid, 'ph-buildings');
          renderBacklogProtheusView();
        });
      }
      if (selBlExec && !selBlExec._bound) {
        selBlExec._bound = true;
        selBlExec.addEventListener('change', () => {
          initCustomDd(selBlExec, 'ph-user');
          renderBacklogProtheusView();
        });
      }
      const btnBlClear = document.getElementById('rmrBlClearBtn');
      if (btnBlClear && !btnBlClear._bound) {
        btnBlClear._bound = true;
        btnBlClear.addEventListener('click', () => {
          if (selBlUnid) { selBlUnid.value = 'ALL'; selBlUnid._multiVals = []; }
          if (selBlExec) { selBlExec.value = 'ALL'; selBlExec._multiVals = []; }
          initCustomDd(selBlUnid, 'ph-buildings');
          initCustomDd(selBlExec, 'ph-user');
          renderBacklogProtheusView();
        });
      }
      document.querySelectorAll('.rmr-bl-view-btn').forEach(btn => {
        if (!btn._bound) {
          btn._bound = true;
          btn.addEventListener('click', () => {
            document.querySelectorAll('.rmr-bl-view-btn').forEach(b => b.classList.remove('is-active'));
            btn.classList.add('is-active');
            renderBacklogProtheusView();
          });
        }
      });
    }

    // Aba 3 (legado compatibilidade): Backlog & Medições Pendentes
    const stMed = bm.statusMedicoesProtheus || {};
    const stCtr = bm.statusContratosProtheus || {};
    const ctrOp = bm.contratosProtheusOperacional || {};
    const medInfo = bm.medicoesProtheus || {};
    const pendHtml = [];
    if (!stMed.disponivel) {
      pendHtml.push(`
        <div class="report-status-banner is-warning">
          <i class="ph ph-warning"></i>
          <div>
            <strong>Medições Pendentes Protheus / SharePoint pendente de acesso:</strong>
            ${esc(stMed.observacao)} Objeto alvo: <code>${esc(stMed.objeto)}</code>.
          </div>
        </div>`);
    } else if (Array.isArray(medInfo.resumoPorSituacao) && medInfo.resumoPorSituacao.length) {
      const abertosMed = medInfo.resumoPorSituacao.filter(x => x.situacao === 'Aberto');
      const qtdAbertosMed = abertosMed.reduce((s, x) => s + Number(x.qtd || 0), 0);
      const valAbertosMed = abertosMed.reduce((s, x) => s + Number(x.valorGlobal || 0), 0);
      pendHtml.push(`
        <div class="report-status-banner is-info">
          <i class="ph ph-info"></i>
          <div>
            <strong>Medições Protheus (<code>comercial.protheus_gold_medicoes_pendentes</code> · espelho ZC0010):</strong>
            ${fmtInt(qtdAbertosMed)} contratos em situação <em>Aberto</em> (${fmtMoeda(valAbertosMed)} em valor global; última emissão ${medInfo.maxEmissao ? core().formatarDataBr(medInfo.maxEmissao) : '—'}).
            <p>${esc(stMed.observacao)}</p>
          </div>
        </div>`);
    }
    if (!stCtr.disponivel) {
      pendHtml.push(`
        <div class="report-status-banner is-warning">
          <i class="ph ph-lock-simple"></i>
          <div>
            <strong>Backlog Contratado Protheus (${esc(stCtr.objeto)}) pendente de permissão:</strong>
            ${esc(stCtr.observacao)} Abaixo são exibidos exclusivamente os dados reais disponíveis no Bitrix CRM (Apropriação Mensal e Contratos Ativos).
          </div>
        </div>`);
    }
    document.getElementById('rmrBacklogPendencias').innerHTML = pendHtml.join('');

    const panelMedPlan = document.getElementById('rmrPanelMedicoesPlanilha');
    if (panelMedPlan) {
      const medPlan = bm.medicoesPlanilha || {};
      const medItens = medPlan.itens || [];
      if (medItens.length) {
        panelMedPlan.style.display = 'block';
        const tagMed = document.getElementById('rmrMedicoesPlanilhaTag');
        if (tagMed) {
          tagMed.textContent = `Comp. ${medPlan.competencia || '—'} · ${fmtInt(medPlan.qtd)} itens · Total ${fmtMoedaExata(medPlan.valorTotal)}`;
        }
        document.getElementById('tbodyRmrMedicoesPlanilha').innerHTML = medItens.map(m => `
          <tr>
            <td><span class="metric-pill is-info">${esc(m.modalidade)}</span></td>
            <td><strong>${esc(m.cliente)}</strong></td>
            <td>${esc(m.unidade)}</td>
            <td>${m.aguardandoPedido ? '<span class="metric-pill is-warn">* Aguardando pedido</span>' : 'Em faturamento'}</td>
            <td class="num"><strong>${fmtMoedaExata(m.valor)}</strong></td>
          </tr>`).join('');
      } else {
        panelMedPlan.style.display = 'none';
      }
    }

    const panelCtrOp = document.getElementById('rmrPanelCtrOpProtheus');
    if (panelCtrOp) {
      if (stCtr.disponivel && ctrOp.resumo) {
        panelCtrOp.style.display = 'block';
        const rOp = ctrOp.resumo;
        const tagOp = document.getElementById('rmrCtrOpTag');
        if (tagOp) {
          tagOp.textContent = `${fmtInt(rOp.qtdAbertos)} abertos · Global ${fmtMoeda(rOp.valorGlobalAbertos)} · Faturado ${fmtMoeda(rOp.valorFaturadoAbertos)} · Saldo ${fmtMoeda(rOp.saldoContratualAbertos)}`;
        }
        const itensOp = ctrOp.itens || [];
        document.getElementById('tbodyRmrCtrOpProtheus').innerHTML = itensOp.length
          ? itensOp.map(c => `
              <tr>
                <td><strong>${esc(c.nrContrato)}</strong></td>
                <td>${esc(c.cliente)}</td>
                <td>${esc(c.unidade)}</td>
                <td><span class="metric-pill is-info">${esc(c.modalidade)}</span></td>
                <td>${c.dataInicio ? core().formatarDataBr(c.dataInicio) : '—'} → ${c.dataFim ? core().formatarDataBr(c.dataFim) : '—'}</td>
                <td class="num">${fmtMoedaExata(c.valorGlobal)}</td>
                <td class="num">${fmtMoedaExata(c.valorFaturado)}</td>
                <td class="num"><strong>${fmtMoedaExata(c.saldoContratual)}</strong></td>
              </tr>`).join('')
          : '<tr><td colspan="8" class="contracts-empty">Sem contratos operacionais em aberto no Protheus.</td></tr>';
      } else {
        panelCtrOp.style.display = 'none';
      }
    }

    const apropRes = bm.apropriacaoBitrix?.resumo || {};
    const cartBitrix = bm.carteiraContratosBitrix || {};
    document.getElementById('rmrApropMes').textContent = fmtMoeda(apropRes.noMesRef);
    document.getElementById('rmrApropMesQtd').textContent = `${fmtInt(apropRes.qtdContratosMes)} contratos apropriados no mês`;
    document.getElementById('rmrApropYtd').textContent = fmtMoeda(apropRes.noAnoYtd);
    const futuroTotal = Number(apropRes.restanteAno || 0) + Number(apropRes.anosSeguintes || 0);
    document.getElementById('rmrApropFuturo').textContent = fmtMoeda(futuroTotal);
    document.getElementById('rmrApropFuturoSub').textContent =
      `Restante ano: ${fmtMoeda(apropRes.restanteAno)} · Anos seguintes: ${fmtMoeda(apropRes.anosSeguintes)}`;
    document.getElementById('rmrBacklogBitrixTotal').textContent = fmtMoeda(cartBitrix.valorTotal);
    document.getElementById('rmrBacklogBitrixQtd').textContent = `${fmtInt(cartBitrix.qtdTotal)} deals ativos/em contratação no Bitrix`;

    renderRankingList('rmrApropUnidades', bm.apropriacaoBitrix?.porUnidade || [], {
      labelKey: 'unidade',
      valueKey: 'receitaYtd',
      detailFn: r => `Mês: ${fmtMoeda(r.receitaMes)} · Ano cheio: ${fmtMoeda(r.receitaAnoCompleto)} · ${fmtInt(r.qtdContratos)} ctrs`
    });
    renderRankingList('rmrBacklogEtapas', cartBitrix.porEtapa || [], {
      labelKey: 'etapa',
      valueKey: 'valor',
      detailFn: r => `${fmtInt(r.qtd)} negócios no estágio`
    });
    document.getElementById('tbodyRmrBacklogContratos').innerHTML = (cartBitrix.itens || []).length
      ? cartBitrix.itens.map(c => `
          <tr>
            <td><strong>#${esc(c.id)}</strong> ${esc(c.titulo)}</td>
            <td>${esc(c.cliente)}</td>
            <td>${esc(c.unidade)}</td>
            <td>${esc(c.executivo)}</td>
            <td><span class="metric-pill is-info">${esc(c.etapa)}</span></td>
            <td>${c.dataInicio ? core().formatarDataBr(c.dataInicio) : '—'} → ${c.dataTermino ? core().formatarDataBr(c.dataTermino) : '—'}</td>
            <td class="num"><strong>${fmtMoedaExata(c.valor)}</strong></td>
          </tr>`).join('')
      : '<tr><td colspan="7" class="contracts-empty">Sem contratos ativos ou em contratação no Bitrix.</td></tr>';

    // Aba 4: Contratos & Resultados por Cliente
    const bannerCliEl = document.getElementById('rmrClientesContratosBanner');
    if (bannerCliEl) {
      bannerCliEl.className = stCtr.disponivel ? 'report-status-banner is-info' : 'report-status-banner is-warning';
      bannerCliEl.innerHTML = `
        <i class="ph ph-info"></i>
        <div>
          <strong>Visão por Cliente e Contrato (Protheus SD2):</strong>
          ${stCtr.disponivel
            ? 'Ranking baseado nas notas fiscais emitidas e validadas na SD2 do Protheus. Os contratos operacionais em aberto sem faturamento recente já estão listados na aba <em>Backlog &amp; Medições</em>.'
            : 'Ranking baseado nas notas fiscais emitidas e validadas no Protheus. Contratos sem NFs emitidas no período dependem da liberação de <code>comercial.contratos_operacional</code>.'}
        </div>`;
    }

    const renderItensTableHtml = itens => {
      if (!itens || !itens.length) {
        return '<div class="contracts-empty" style="padding:8px;">Sem itens/produtos detalhados nas NFs deste contrato.</div>';
      }
      return `
        <table class="contracts-table" style="margin:6px 0;background:#fff;border:1px solid #e2e8f0;border-radius:6px;">
          <thead>
            <tr>
              <th>Cód. Produto</th>
              <th>Item / Produto / Equipamento</th>
              <th class="num">Qtd.</th>
              <th class="num">NFs</th>
              <th class="num">Faturado YTD</th>
            </tr>
          </thead>
          <tbody>
            ${itens.map(it => `
              <tr>
                <td><code>${esc(it.codProduto)}</code></td>
                <td>${esc(it.produto)}</td>
                <td class="num">${Number(it.quantidade || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}</td>
                <td class="num">${fmtInt(it.qtdNfsYtd)}</td>
                <td class="num"><strong>${fmtMoedaExata(it.valorYtd)}</strong></td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    };

    const toggleBtnStyle = 'display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-right:6px;border:1px solid #cbd5e1;border-radius:4px;background:#f8fafc;color:#0f2942;font-weight:700;cursor:pointer;font-size:13px;line-height:1;';

    const cliRows = d.contratosClientes?.clientes || [];
    const tbodyCliEl = document.getElementById('tbodyRmrClientes');
    tbodyCliEl.innerHTML = cliRows.length
      ? cliRows.map((c, idx) => {
          const ctrs = c.contratos || [];
          const hasCtrs = ctrs.length > 0;
          return `
          <tr>
            <td>${String(c.posicao).padStart(2, '0')}</td>
            <td>
              <div class="rmr-cell-expand">
                ${hasCtrs ? `<button type="button" class="rmr-expand-btn" data-expand-target="rmr-cli-sub-${idx}" style="${toggleBtnStyle}" title="Expandir contratos do cliente">+</button>` : '<span style="display:inline-block;width:20px;flex-shrink:0;"></span>'}
                <span class="rmr-cell-expand-text"><strong>${esc(c.cliente)}</strong></span>
              </div>
            </td>
            <td>${esc(c.unidadePrincipal)}</td>
            <td>${esc(c.executivoPrincipal)}</td>
            <td class="num">${fmtMoedaExata(c.valorMes)}</td>
            <td class="num"><strong>${fmtMoedaExata(c.valorYtd)}</strong></td>
            <td class="num">${fmtPct(c.participacaoPct)}</td>
            <td class="num">${fmtPct(c.paretoAcumuladoPct)}</td>
            <td class="num">${fmtInt(c.qtdNfsYtd)} / ${fmtInt(c.qtdContratosYtd)}</td>
          </tr>
          ${hasCtrs ? `
          <tr id="rmr-cli-sub-${idx}" style="display:none;background:#f8fafc;">
            <td colspan="9" style="padding:10px 14px 10px 32px;">
              <div style="font-size:11.5px;font-weight:700;color:#475569;margin-bottom:6px;">Contratos de ${esc(c.cliente)} (${fmtInt(ctrs.length)}):</div>
              <table class="contracts-table" style="background:#fff;border:1px solid #cbd5e1;">
                <thead>
                  <tr>
                    <th>Contrato</th>
                    <th>Unidade</th>
                    <th class="num">Faturado Mês Ref.</th>
                    <th class="num">Faturado YTD</th>
                    <th class="num">NFs YTD</th>
                  </tr>
                </thead>
                <tbody>
                  ${ctrs.map((cc, cIdx) => {
                    const itens = cc.itens || [];
                    const labelCtr = cc.numeroContrato === 'SEM_CONTRATO' ? 'Sem contrato vinculado' : cc.numeroContrato;
                    return `
                    <tr>
                      <td>
                        ${itens.length ? `<button type="button" class="rmr-expand-btn" data-expand-target="rmr-cli-ctr-items-${idx}-${cIdx}" style="${toggleBtnStyle}" title="Expandir itens/equipamentos">+</button>` : ''}
                        <strong>${esc(labelCtr)}</strong>
                      </td>
                      <td>${esc(cc.unidade)}</td>
                      <td class="num">${fmtMoedaExata(cc.valorMes)}</td>
                      <td class="num"><strong>${fmtMoedaExata(cc.valorYtd)}</strong></td>
                      <td class="num">${fmtInt(cc.qtdNfsYtd)}</td>
                    </tr>
                    ${itens.length ? `
                    <tr id="rmr-cli-ctr-items-${idx}-${cIdx}" style="display:none;background:#f1f5f9;">
                      <td colspan="5" style="padding:8px 12px 8px 28px;">
                        ${renderItensTableHtml(itens)}
                      </td>
                    </tr>` : ''}`;
                  }).join('')}
                </tbody>
              </table>
            </td>
          </tr>` : ''}`;
        }).join('')
      : '<tr><td colspan="9" class="contracts-empty">Nenhum cliente com faturamento no período.</td></tr>';

    const ctrProtheus = d.contratosClientes?.contratosProtheus || [];
    const tbodyCtrEl = document.getElementById('tbodyRmrContratosProtheus');
    tbodyCtrEl.innerHTML = ctrProtheus.length
      ? ctrProtheus.map((c, idx) => {
          const itens = c.itens || [];
          return `
          <tr>
            <td>
              ${itens.length ? `<button type="button" class="rmr-expand-btn" data-expand-target="rmr-ctr-items-${idx}" style="${toggleBtnStyle}" title="Expandir itens/equipamentos">+</button>` : ''}
              <strong>${esc(c.numeroContrato)}</strong>
            </td>
            <td>${esc(c.cliente)}</td>
            <td>${esc(c.unidade)}</td>
            <td>${esc(c.executivo)}</td>
            <td class="num">${fmtMoedaExata(c.valorMes)}</td>
            <td class="num"><strong>${fmtMoedaExata(c.valorYtd)}</strong></td>
            <td class="num">${fmtInt(c.qtdNfsYtd)}</td>
            <td>${c.ultimaEmissao ? core().formatarDataBr(c.ultimaEmissao) : '—'}</td>
          </tr>
          ${itens.length ? `
          <tr id="rmr-ctr-items-${idx}" style="display:none;background:#f8fafc;">
            <td colspan="8" style="padding:8px 14px 8px 32px;">
              <div style="font-size:11.5px;font-weight:700;color:#475569;margin-bottom:4px;">Itens / Produtos / Equipamentos do Contrato ${esc(c.numeroContrato)}:</div>
              ${renderItensTableHtml(itens)}
            </td>
          </tr>` : ''}`;
        }).join('')
      : '<tr><td colspan="8" class="contracts-empty">Sem contratos identificados nas NFs do período.</td></tr>';

    document.querySelectorAll('#rmrPanelClientes .rmr-expand-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-expand-target');
        const row = targetId ? document.getElementById(targetId) : null;
        if (!row) return;
        const isOpen = row.style.display !== 'none';
        row.style.display = isOpen ? 'none' : 'table-row';
        btn.textContent = isOpen ? '+' : '−';
        btn.classList.toggle('is-open', !isOpen);
        btn.closest('tr')?.classList.toggle('rmr-row-expanded', !isOpen);
        row.classList.toggle('rmr-subrow-open', !isOpen);
      });
    });

    // Aba 5: Projeções Comerciais
    const proj = d.projecoes || {};
    const pipeAb = proj.pipelineAberto || {};
    document.getElementById('rmrProjRunRate').textContent = fmtMoeda(proj.runRateMensal);
    document.getElementById('rmrProjMeses').textContent = `${fmtInt(proj.mesesFechados)} meses fechados · ${fmtInt(proj.mesesRestantes)} restantes`;
    document.getElementById('rmrProjGapInicial').textContent = fmtMoeda(proj.gapInicial);
    document.getElementById('rmrProjMetaRestante').textContent =
      `Meta Anual: ${fmtMoeda(proj.metaAnualTotal)} · Falta p/ alvo: ${fmtMoeda(proj.metaRestanteAno)}`;
    document.getElementById('rmrProjPipeAnoBruto').textContent = fmtMoeda(pipeAb.janelaAnoBruto);
    document.getElementById('rmrProjPipeAnoPond').textContent = `Ponderado janela do ano: ${fmtMoeda(pipeAb.janelaAnoPonderado)}`;
    document.getElementById('rmrProjPipeTotalBruto').textContent = fmtMoeda(pipeAb.brutoTotal);
    document.getElementById('rmrProjPipeTotalPond').textContent = `${fmtInt(pipeAb.qtdNegocios)} negócios · Ponderado total: ${fmtMoeda(pipeAb.ponderadoTotal)}`;

    document.getElementById('tbodyRmrCenarios').innerHTML = (proj.cenarios || []).map(c => `
      <tr class="${c.codigo === 'base' ? 'row-highlight' : ''}">
        <td><strong>${esc(c.nome)}</strong></td>
        <td>${esc(c.premissa)}</td>
        <td class="num"><strong>${fmtMoedaExata(c.valorAnual)}</strong></td>
        <td class="num">${badgePct(c.atingimentoProjetadoPct)}</td>
        <td class="num ${c.gapVsMetaAnual !== null && c.gapVsMetaAnual < 0 ? 'text-neg' : 'text-pos'}">${c.gapVsMetaAnual !== null ? fmtMoedaExata(c.gapVsMetaAnual) : '—'}</td>
      </tr>`).join('');

    const renderCenarioBacklogFunil = () => {
      const cbf = proj.cenarioBacklogFunil;
      const theadBl = document.getElementById('theadRmrBacklogCenario');
      const tbodyBl = document.getElementById('tbodyRmrBacklogCenario');
      const tfootBl = document.getElementById('tfootRmrBacklogCenario');
      const theadFn = document.getElementById('theadRmrFunilCenario');
      const tbodyFn = document.getElementById('tbodyRmrFunilCenario');
      const tfootFn = document.getElementById('tfootRmrFunilCenario');
      if (!cbf || !theadBl || !tbodyBl || !theadFn || !tbodyFn) return;

      const NOMES_MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
      const NOMES_MESES_COMP = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
      const mesRefNome = NOMES_MESES_COMP[(cbf.mesRef || 1) - 1] || 'Mês Ref';
      const mesRefAbrev = NOMES_MESES[(cbf.mesRef || 1) - 1] || 'Mês';
      const mesesRest = cbf.mesesRestantes || [];
      const unidadesCbf = cbf.unidades || [];
      const modoEl = document.getElementById('rmrFunilCenarioModo');
      const modo = modoEl?.value === 'ponderado' ? 'ponderado' : 'bruto';

      const tagBl = document.getElementById('rmrBacklogCenarioTag');
      if (tagBl) tagBl.textContent = `${mesRefNome}/${cbf.ano} + ${mesesRest.length ? mesesRest.map(m => NOMES_MESES[m.mes - 1]).join(', ') : 'Ano fechado'}`;

      const tagFn = document.getElementById('rmrFunilCenarioTag');
      if (tagFn) tagFn.textContent = modo === 'ponderado' ? 'Bitrix24 · Ponderado por estágio' : 'Bitrix24 · Valor cheio (100%)';

      const blColsHtml = mesesRest.map(m => `<th class="num">${NOMES_MESES_COMP[m.mes - 1]}</th>`).join('');
      const blColsCount = Math.max(1, mesesRest.length);
      theadBl.innerHTML = `
        <tr>
          <th rowspan="2">Unidades</th>
          <th colspan="2" class="num" style="text-align:center;">${esc(mesRefNome)} / ${cbf.ano}</th>
          <th colspan="${blColsCount}" class="num" style="text-align:center;">Backlog Contratado</th>
          <th class="num" style="text-align:center;">Total ${esc(mesRefAbrev)} + BL</th>
          <th class="num" style="text-align:center;">2º Semestre</th>
          <th colspan="3" class="num" style="text-align:center;">Consolidado ${cbf.ano}</th>
        </tr>
        <tr>
          <th class="num">Meta</th>
          <th class="num">Realizado</th>
          ${mesesRest.length ? blColsHtml : '<th class="num">Restante</th>'}
          <th class="num">${esc(mesRefAbrev)} + Backlog</th>
          <th class="num">Jul - Dez (c/ BL)</th>
          <th class="num">Total ${cbf.ano}</th>
          <th class="num">Meta Anual</th>
          <th class="num">Ating.</th>
        </tr>`;

      const totBl = {
        metaMes: 0, realizadoMes: 0, backlogPorMes: {}, totalMesMaisBacklog: 0,
        semestre2ComBacklog: 0, totalAnoComBacklog: 0, metaAnual: 0
      };
      for (const mr of mesesRest) totBl.backlogPorMes[mr.mes] = 0;

      tbodyBl.innerHTML = unidadesCbf.map(u => {
        totBl.metaMes += Number(u.metaMes || 0);
        totBl.realizadoMes += Number(u.realizadoMes || 0);
        totBl.totalMesMaisBacklog += Number(u.totalMesMaisBacklog || 0);
        totBl.semestre2ComBacklog += Number(u.semestre2ComBacklog || 0);
        totBl.totalAnoComBacklog += Number(u.totalAnoComBacklog || 0);
        totBl.metaAnual += Number(u.metaAnual || 0);
        const cellsMes = mesesRest.length
          ? mesesRest.map(mr => {
              const v = Number(u.backlogPorMes?.[mr.mes] || 0);
              totBl.backlogPorMes[mr.mes] += v;
              return `<td class="num">${v > 0 ? fmtMoedaExata(v) : '—'}</td>`;
            }).join('')
          : '<td class="num">—</td>';
        return `
          <tr>
            <td><strong>${esc(u.unidade)}</strong></td>
            <td class="num">${u.metaMes > 0 ? fmtMoedaExata(u.metaMes) : '—'}</td>
            <td class="num">${u.realizadoMes > 0 ? fmtMoedaExata(u.realizadoMes) : '—'}</td>
            ${cellsMes}
            <td class="num"><strong>${fmtMoedaExata(u.totalMesMaisBacklog)}</strong></td>
            <td class="num">${fmtMoedaExata(u.semestre2ComBacklog)}</td>
            <td class="num"><strong>${fmtMoedaExata(u.totalAnoComBacklog)}</strong></td>
            <td class="num">${u.metaAnual > 0 ? fmtMoedaExata(u.metaAnual) : '—'}</td>
            <td class="num">${badgePct(u.atingimentoPct)}</td>
          </tr>`;
      }).join('');

      if (tfootBl) {
        const atingTot = totBl.metaAnual > 0 ? (totBl.totalAnoComBacklog / totBl.metaAnual) * 100 : null;
        const totCellsMes = mesesRest.length
          ? mesesRest.map(mr => `<td class="num"><strong>${fmtMoedaExata(totBl.backlogPorMes[mr.mes] || 0)}</strong></td>`).join('')
          : '<td class="num">—</td>';
        tfootBl.innerHTML = `
          <tr class="table-total-row">
            <td><strong>Total Geral</strong></td>
            <td class="num"><strong>${fmtMoedaExata(totBl.metaMes)}</strong></td>
            <td class="num"><strong>${fmtMoedaExata(totBl.realizadoMes)}</strong></td>
            ${totCellsMes}
            <td class="num"><strong>${fmtMoedaExata(totBl.totalMesMaisBacklog)}</strong></td>
            <td class="num"><strong>${fmtMoedaExata(totBl.semestre2ComBacklog)}</strong></td>
            <td class="num"><strong>${fmtMoedaExata(totBl.totalAnoComBacklog)}</strong></td>
            <td class="num"><strong>${fmtMoedaExata(totBl.metaAnual)}</strong></td>
            <td class="num">${badgePct(atingTot)}</td>
          </tr>`;
      }

      const fnLabelTotal = mesesRest.length ? mesesRest.map(m => NOMES_MESES[m.mes - 1]).join(' + ') : 'Restante';
      theadFn.innerHTML = `
        <tr>
          <th rowspan="2">Unidades</th>
          <th colspan="${blColsCount}" class="num" style="text-align:center;">Funil de Vendas</th>
          <th class="num" style="text-align:center;">Total Funil</th>
          <th class="num" style="text-align:center;">Diferença Meta</th>
        </tr>
        <tr>
          ${mesesRest.length ? blColsHtml : '<th class="num">Restante</th>'}
          <th class="num">${esc(fnLabelTotal)}</th>
          <th class="num">Gap Residual</th>
        </tr>`;

      const totFn = { porMes: {}, totalFunil: 0, gapResidual: 0 };
      for (const mr of mesesRest) totFn.porMes[mr.mes] = 0;

      tbodyFn.innerHTML = unidadesCbf.map(u => {
        const mapMes = modo === 'ponderado' ? u.funilPonderadoPorMes : u.funilBrutoPorMes;
        const totalFunil = modo === 'ponderado' ? Number(u.funilTotalPonderado || 0) : Number(u.funilTotalBruto || 0);
        const gapRes = modo === 'ponderado' ? u.gapResidualPonderado : u.gapResidualBruto;
        totFn.totalFunil += totalFunil;
        if (gapRes !== null && gapRes !== undefined) totFn.gapResidual += Number(gapRes);
        const cellsFn = mesesRest.length
          ? mesesRest.map(mr => {
              const v = Number(mapMes?.[mr.mes] || 0);
              totFn.porMes[mr.mes] += v;
              return `<td class="num">${v > 0 ? fmtMoedaExata(v) : '—'}</td>`;
            }).join('')
          : '<td class="num">—</td>';
        const gapCls = gapRes === null || gapRes === undefined ? '' : (gapRes <= 0 ? 'text-pos' : 'text-neg');
        return `
          <tr>
            <td><strong>${esc(u.unidade)}</strong></td>
            ${cellsFn}
            <td class="num"><strong>${fmtMoedaExata(totalFunil)}</strong></td>
            <td class="num ${gapCls}"><strong>${gapRes !== null && gapRes !== undefined ? fmtMoedaExata(gapRes) : '—'}</strong></td>
          </tr>`;
      }).join('');

      if (tfootFn) {
        const totGap = totBl.metaAnual > 0 ? totBl.metaAnual - (totBl.totalAnoComBacklog + totFn.totalFunil) : null;
        const totGapCls = totGap === null ? '' : (totGap <= 0 ? 'text-pos' : 'text-neg');
        const totCellsFn = mesesRest.length
          ? mesesRest.map(mr => `<td class="num"><strong>${fmtMoedaExata(totFn.porMes[mr.mes] || 0)}</strong></td>`).join('')
          : '<td class="num">—</td>';
        tfootFn.innerHTML = `
          <tr class="table-total-row">
            <td><strong>Total Geral</strong></td>
            ${totCellsFn}
            <td class="num"><strong>${fmtMoedaExata(totFn.totalFunil)}</strong></td>
            <td class="num ${totGapCls}"><strong>${totGap !== null ? fmtMoedaExata(totGap) : '—'}</strong></td>
          </tr>`;
      }
    };

    renderCenarioBacklogFunil();
    const modoSel = document.getElementById('rmrFunilCenarioModo');
    if (modoSel) {
      modoSel._renderFn = renderCenarioBacklogFunil;
      if (!modoSel.dataset.bound) {
        modoSel.dataset.bound = '1';
        modoSel.addEventListener('change', () => modoSel._renderFn?.());
      }
    }

    document.getElementById('tbodyRmrProjEtapas').innerHTML = (pipeAb.porEtapa || []).map(e => `
      <tr>
        <td><strong>${esc(e.etapa)}</strong></td>
        <td class="num">${e.pesoPct}%</td>
        <td class="num">${fmtInt(e.qtd)}</td>
        <td class="num">${fmtMoedaExata(e.valorBruto)}</td>
        <td class="num"><strong>${fmtMoedaExata(e.valorPonderado)}</strong></td>
      </tr>`).join('');

    renderRankingList('rmrProjUnidades', pipeAb.porUnidade || [], {
      labelKey: 'unidade',
      valueKey: 'valorPonderado',
      detailFn: u => `Bruto: ${fmtMoeda(u.valorBruto)} · ${fmtInt(u.qtd)} deals`
    });

    // Aba Funil de Vendas (Slide 7) & Negócios Perdidos (Slide 8)
    const fp = d.funilPerdas || {};
    const fpRes = fp.resumo || {};
    const TEMP_META = {
      quente: { label: 'Quente', plural: 'Quentes', bg: 'linear-gradient(135deg, #ef4444, #dc2626)' },
      morno: { label: 'Morno', plural: 'Mornos', bg: 'linear-gradient(135deg, #f59e0b, #d97706)' },
      frio: { label: 'Frio', plural: 'Frios', bg: 'linear-gradient(135deg, #38bdf8, #0284c7)' },
      sem_temperatura: { label: 'Não informado', plural: 'Sem temperatura', bg: 'linear-gradient(135deg, #94a3b8, #64748b)' }
    };

    const animateEl = el => {
      if (!el) return;
      el.classList.remove('rmr-anim-filter-in');
      void el.offsetWidth;
      el.classList.add('rmr-anim-filter-in');
    };

    const renderFunilTemperaturaEUnidades = (fromFilterClick = false) => {
      const elAbBruto = document.getElementById('rmrFunilAbertoBruto');
      if (!elAbBruto) return;

      const allOpenDeals = pipeAb.negociosAbertos || [];
      elAbBruto.textContent = fmtMoeda(pipeAb.brutoTotal);
      document.getElementById('rmrFunilAbertoQtd').textContent = `${fmtInt(pipeAb.qtdNegocios)} negócios abertos no Funil de Vendas`;
      document.getElementById('rmrFunilAbertoPond').textContent = fmtMoeda(pipeAb.negociosQuentesBruto);
      document.getElementById('rmrFunilJanelaAno').textContent = `${fmtInt(pipeAb.negociosQuentesQtd)} negócios quentes (clique p/ filtrar)`;

      const cardQuentes = document.getElementById('rmrCardQuentesAction');
      if (cardQuentes) {
        const isQuenteAtivo = rmrFunilTempFiltro === 'quente';
        cardQuentes.style.outline = isQuenteAtivo ? '2px solid #dc2626' : '';
        cardQuentes.style.background = isQuenteAtivo ? '#fef2f2' : '';
        cardQuentes.style.transition = 'outline-color .2s ease, background-color .2s ease';
      }

      const btnLimparTemp = document.getElementById('rmrBtnLimparTemp');
      if (btnLimparTemp) {
        btnLimparTemp.style.display = rmrFunilTempFiltro ? 'inline-flex' : 'none';
      }
      const btnLimparUnidade = document.getElementById('rmrBtnLimparUnidade');
      if (btnLimparUnidade) {
        btnLimparUnidade.style.display = rmrFunilUnidadeFiltro ? 'inline-flex' : 'none';
      }

      const elFunilEtapas = document.getElementById('rmrFunilAbertoEtapas');
      if (elFunilEtapas) {
        let tempsRaw = pipeAb.porTemperatura || [];
        if (rmrFunilUnidadeFiltro) {
          const mapT = {
            quente: { temperatura: 'quente', label: 'Quente', qtd: 0, valorBruto: 0, valorPonderado: null },
            morno: { temperatura: 'morno', label: 'Morno', qtd: 0, valorBruto: 0, valorPonderado: null },
            frio: { temperatura: 'frio', label: 'Frio', qtd: 0, valorBruto: 0, valorPonderado: null },
            sem_temperatura: { temperatura: 'sem_temperatura', label: 'Não informado', qtd: 0, valorBruto: 0, valorPonderado: null }
          };
          allOpenDeals.forEach(n => {
            if (n.unidade !== rmrFunilUnidadeFiltro) return;
            const k = mapT[n.temperatura] ? n.temperatura : 'sem_temperatura';
            mapT[k].qtd += 1;
            mapT[k].valorBruto += Number(n.valor || 0);
          });
          tempsRaw = ['quente', 'morno', 'frio', 'sem_temperatura']
            .map(k => mapT[k])
            .filter(t => t.qtd > 0);
        }

        const totalFunilTemp = tempsRaw.reduce((s, t) => s + Number(t.valorBruto || 0), 0);
        const widthsTemp = [100, 86, 72, 60];
        elFunilEtapas.innerHTML = tempsRaw.length
          ? `<div class="rmr-funnel-wrap">
              ${tempsRaw.map((t, idx) => {
                const key = t.temperatura;
                const meta = TEMP_META[key] || { label: t.label || key, bg: 'linear-gradient(135deg, #0ea5e9, #0369a1)' };
                const w = widthsTemp[idx] || 60;
                const pct = totalFunilTemp > 0 ? (Number(t.valorBruto || 0) / totalFunilTemp) * 100 : 0;
                const ativo = rmrFunilTempFiltro === key;
                const dimmed = rmrFunilTempFiltro && !ativo;
                const subInfo = t.valorPonderado !== null && t.valorPonderado !== undefined
                  ? `${fmtInt(t.qtd)} negócios · Pond.: ${fmtMoeda(t.valorPonderado)}`
                  : `${fmtInt(t.qtd)} negócios em ${esc(rmrFunilUnidadeFiltro)}`;
                return `
                <div class="rmr-funnel-stage" data-temp-key="${esc(key)}"
                  style="width:${w}%;background:${meta.bg};cursor:pointer;transition:opacity .24s ease,transform .24s cubic-bezier(0.22,1,0.36,1),outline .2s ease;${dimmed ? 'opacity:0.42;' : ''}${ativo ? 'outline:3px solid #0f172a;transform:translateX(4px);' : ''}"
                  title="Clique para filtrar ${esc(meta.label)} no gráfico por unidade e na tabela">
                  <div>
                    <div class="rmr-funnel-stage-name">${esc(meta.label)}</div>
                    <div class="rmr-funnel-stage-sub">${subInfo}</div>
                  </div>
                  <div class="rmr-funnel-stage-val">
                    <strong>${fmtMoeda(t.valorBruto)}</strong>
                    <span>${pct.toFixed(1)}% ${rmrFunilUnidadeFiltro ? 'da unidade' : 'do funil'}</span>
                  </div>
                </div>`;
              }).join('')}
            </div>`
          : '<div class="contracts-empty">Sem negócios abertos neste recorte.</div>';

        if (fromFilterClick) animateEl(elFunilEtapas.querySelector('.rmr-funnel-wrap'));

        elFunilEtapas.querySelectorAll('[data-temp-key]').forEach(el => {
          el.addEventListener('click', () => {
            const k = el.getAttribute('data-temp-key');
            rmrFunilTempFiltro = rmrFunilTempFiltro === k ? null : k;
            renderFunilTemperaturaEUnidades(true);
          });
        });
      }

      const elFunilUnids = document.getElementById('rmrFunilAbertoUnidades');
      const elUnidTag = document.getElementById('rmrFunilUnidadeTag');
      if (elUnidTag) {
        const tagParts = ['Pipeline Funil de Vendas (Bitrix C19)'];
        if (rmrFunilTempFiltro) tagParts.push(TEMP_META[rmrFunilTempFiltro]?.label || rmrFunilTempFiltro);
        if (rmrFunilUnidadeFiltro) tagParts.push(rmrFunilUnidadeFiltro);
        elUnidTag.textContent = tagParts.join(' · ');
      }

      if (elFunilUnids) {
        const fonteUnids = rmrFunilTempFiltro
          ? (pipeAb.porUnidadePorTemperatura?.[rmrFunilTempFiltro] || [])
          : (pipeAb.porUnidadePorTemperatura?.todas || pipeAb.porUnidade || []);
        const unidsFunil = [...fonteUnids].sort((a, b) => Number(b.valorBruto || 0) - Number(a.valorBruto || 0));
        const totFunilUnid = unidsFunil.reduce((s, u) => s + Number(u.valorBruto || 0), 0);
        const totalDealsUnid = unidsFunil.reduce((a, b) => a + Number(b.qtd || 0), 0);
        const defaultCenterLabel = rmrFunilTempFiltro
          ? `Funil · ${TEMP_META[rmrFunilTempFiltro]?.label || rmrFunilTempFiltro}`
          : 'Total Funil';

        if (!unidsFunil.length || totFunilUnid <= 0) {
          elFunilUnids.innerHTML = '<div class="contracts-empty">Sem negócios abertos por unidade neste filtro.</div>';
        } else {
          const paletteDonut = ['#0f2942', '#0284c7', '#0ea5e9', '#10b981', '#f59e0b', '#6366f1', '#94a3b8'];
          const r = 78;
          const circ = 2 * Math.PI * r;
          let offset = 0;
          const segs = unidsFunil.map((u, idx) => {
            const val = Number(u.valorBruto || 0);
            const pct = (val / totFunilUnid) * 100;
            const dash = (val / totFunilUnid) * circ;
            const seg = {
              idx,
              unidade: u.unidade,
              qtd: u.qtd,
              valorBruto: val,
              valorPonderado: u.valorPonderado,
              pct,
              color: paletteDonut[idx % paletteDonut.length],
              dash: Math.max(0, dash - 1.5),
              offset
            };
            offset += dash;
            return seg;
          });

          const selectedSeg = rmrFunilUnidadeFiltro
            ? segs.find(s => s.unidade === rmrFunilUnidadeFiltro) || null
            : null;
          const initCenterTitle = selectedSeg ? selectedSeg.unidade : defaultCenterLabel;
          const initCenterVal = selectedSeg ? fmtMoeda(selectedSeg.valorBruto) : fmtMoeda(totFunilUnid);
          const initCenterSub = selectedSeg
            ? `${selectedSeg.pct.toFixed(1)}% · ${fmtInt(selectedSeg.qtd)} deals`
            : `${fmtInt(totalDealsUnid)} deals`;

          elFunilUnids.innerHTML = `
            <div class="rmr-donut-wrap">
              <div class="rmr-donut-svg-box">
                <svg viewBox="0 0 210 210" width="210" height="210" style="transform:rotate(-90deg);">
                  <circle cx="105" cy="105" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="28"></circle>
                  ${segs.map(s => {
                    const isSel = rmrFunilUnidadeFiltro === s.unidade;
                    const isDim = rmrFunilUnidadeFiltro && !isSel;
                    return `
                    <circle class="rmr-donut-seg ${isSel ? 'is-selected' : ''} ${isDim ? 'is-dimmed' : ''}" data-donut-idx="${s.idx}" cx="105" cy="105" r="${r}"
                      fill="none" stroke="${s.color}" stroke-width="28"
                      stroke-dasharray="${s.dash.toFixed(2)} ${(circ - s.dash).toFixed(2)}"
                      stroke-dashoffset="${(-s.offset).toFixed(2)}"></circle>`;
                  }).join('')}
                </svg>
                <div class="rmr-donut-center ${fromFilterClick ? 'is-animating' : ''}" id="rmrDonutCenter">
                  <span>${esc(initCenterTitle)}</span>
                  <strong>${initCenterVal}</strong>
                  <small>${initCenterSub}</small>
                </div>
              </div>
              <div class="rmr-donut-legend">
                ${segs.map(s => {
                  const isSel = rmrFunilUnidadeFiltro === s.unidade;
                  const isDim = rmrFunilUnidadeFiltro && !isSel;
                  return `
                  <div class="rmr-donut-leg-item ${isSel ? 'is-selected' : ''} ${isDim ? 'is-dimmed' : ''}" data-donut-idx="${s.idx}" title="Clique para filtrar ${esc(s.unidade)} na tabela">
                    <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                      <span style="width:10px;height:10px;border-radius:3px;background:${s.color};flex-shrink:0;"></span>
                      <div style="min-width:0;">
                        <div style="font-size:12.5px;font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(s.unidade)}</div>
                        <div style="font-size:10.5px;color:#64748b;">${fmtInt(s.qtd)} deals · Pond.: ${fmtMoeda(s.valorPonderado)}</div>
                      </div>
                    </div>
                    <div style="text-align:right;flex-shrink:0;">
                      <div style="font-size:12.5px;font-weight:700;color:#0f172a;">${fmtMoeda(s.valorBruto)}</div>
                      <div style="font-size:10.5px;font-weight:700;color:${s.color};">${s.pct.toFixed(1)}%</div>
                    </div>
                  </div>`;
                }).join('')}
              </div>
            </div>`;

          if (fromFilterClick) animateEl(elFunilUnids.querySelector('.rmr-donut-wrap'));

          const centerEl = document.getElementById('rmrDonutCenter');
          const resetCenter = () => {
            if (!centerEl) return;
            centerEl.innerHTML = `<span>${esc(initCenterTitle)}</span><strong>${initCenterVal}</strong><small>${initCenterSub}</small>`;
            elFunilUnids.querySelectorAll('.is-active').forEach(el => el.classList.remove('is-active'));
          };
          const highlightSeg = idx => {
            const s = segs[idx];
            if (!s || !centerEl) return;
            elFunilUnids.querySelectorAll('.is-active').forEach(el => el.classList.remove('is-active'));
            elFunilUnids.querySelectorAll(`[data-donut-idx="${idx}"]`).forEach(el => el.classList.add('is-active'));
            centerEl.innerHTML = `<span>${esc(s.unidade)}</span><strong>${fmtMoeda(s.valorBruto)}</strong><small>${s.pct.toFixed(1)}% · ${fmtInt(s.qtd)} deals</small>`;
          };
          elFunilUnids.querySelectorAll('[data-donut-idx]').forEach(el => {
            el.addEventListener('mouseenter', () => highlightSeg(Number(el.getAttribute('data-donut-idx'))));
            el.addEventListener('mouseleave', resetCenter);
            el.addEventListener('click', () => {
              const s = segs[Number(el.getAttribute('data-donut-idx'))];
              if (!s) return;
              rmrFunilUnidadeFiltro = rmrFunilUnidadeFiltro === s.unidade ? null : s.unidade;
              renderFunilTemperaturaEUnidades(true);
            });
          });
        }
      }

      const elTabTitle = document.getElementById('rmrSecaoUltimosGanhosTitle');
      const elTabTag = document.getElementById('rmrSecaoUltimosGanhosTag');
      const elThead = document.getElementById('theadRmrFunilTabela');
      const elTbody = document.getElementById('tbodyRmrUltimosGanhos');
      if (elTbody) {
        if (rmrFunilTempFiltro || rmrFunilUnidadeFiltro) {
          const meta = rmrFunilTempFiltro
            ? (TEMP_META[rmrFunilTempFiltro] || { label: rmrFunilTempFiltro, plural: rmrFunilTempFiltro })
            : null;
          const filtrados = allOpenDeals.filter(n =>
            (!rmrFunilTempFiltro || n.temperatura === rmrFunilTempFiltro) &&
            (!rmrFunilUnidadeFiltro || n.unidade === rmrFunilUnidadeFiltro)
          );
          const tituloBase = meta ? `Negócios ${meta.plural} no Funil` : 'Negócios Abertos no Funil';
          if (elTabTitle) {
            elTabTitle.textContent = rmrFunilUnidadeFiltro
              ? `${tituloBase} · ${rmrFunilUnidadeFiltro}`
              : tituloBase;
          }
          if (elTabTag) elTabTag.textContent = `Bitrix Funil de Vendas (C19) · ${fmtInt(filtrados.length)} negócios`;
          if (elThead) {
            elThead.innerHTML = '<tr><th>Negócio</th><th>Cliente</th><th>Unidade</th><th>Executivo</th><th>Etapa</th><th class="num">Valor</th></tr>';
          }
          elTbody.innerHTML = filtrados.length
            ? filtrados.map(n => `
                <tr>
                  <td><strong>#${esc(n.id)}</strong> ${esc(n.negocio)}</td>
                  <td>${esc(n.cliente)}</td>
                  <td>${esc(n.unidade)}</td>
                  <td>${esc(n.executivo)}</td>
                  <td>${esc(n.etapa || '—')}</td>
                  <td class="num"><strong>${fmtMoedaExata(n.valor)}</strong></td>
                </tr>`).join('')
            : `<tr><td colspan="6" class="contracts-empty">Nenhum negócio aberto para o filtro selecionado.</td></tr>`;
          if (fromFilterClick) animateEl(elTbody);
        } else {
          if (elTabTitle) elTabTitle.textContent = 'Principais Negócios Ganhos no Período';
          if (elTabTag) elTabTag.textContent = 'Bitrix Funil de Vendas (C19) · Top 15';
          if (elThead) {
            elThead.innerHTML = '<tr><th>Negócio</th><th>Cliente</th><th>Unidade</th><th>Executivo</th><th>Data</th><th class="num">Valor</th></tr>';
          }
          elTbody.innerHTML = (fp.ultimosGanhos || []).length
            ? fp.ultimosGanhos.map(g => `
                <tr>
                  <td><strong>#${esc(g.id)}</strong> ${esc(g.negocio)}</td>
                  <td>${esc(g.cliente)}</td>
                  <td>${esc(g.unidade)}</td>
                  <td>${esc(g.executivo)}</td>
                  <td>${g.data ? core().formatarDataBr(g.data) : '—'}</td>
                  <td class="num"><strong>${fmtMoedaExata(g.valor)}</strong></td>
                </tr>`).join('')
            : '<tr><td colspan="6" class="contracts-empty">Nenhum negócio ganho no recorte.</td></tr>';
          if (fromFilterClick) animateEl(elTbody);
        }
      }
    };

    const cardQuentesBind = document.getElementById('rmrCardQuentesAction');
    if (cardQuentesBind && !cardQuentesBind._bound) {
      cardQuentesBind._bound = true;
      cardQuentesBind.addEventListener('click', () => {
        rmrFunilTempFiltro = rmrFunilTempFiltro === 'quente' ? null : 'quente';
        renderFunilTemperaturaEUnidades(true);
      });
    }
    const btnLimparTempBind = document.getElementById('rmrBtnLimparTemp');
    if (btnLimparTempBind && !btnLimparTempBind._bound) {
      btnLimparTempBind._bound = true;
      btnLimparTempBind.addEventListener('click', () => {
        rmrFunilTempFiltro = null;
        renderFunilTemperaturaEUnidades(true);
      });
    }
    const btnLimparUnidBind = document.getElementById('rmrBtnLimparUnidade');
    if (btnLimparUnidBind && !btnLimparUnidBind._bound) {
      btnLimparUnidBind._bound = true;
      btnLimparUnidBind.addEventListener('click', () => {
        rmrFunilUnidadeFiltro = null;
        renderFunilTemperaturaEUnidades(true);
      });
    }

    renderFunilTemperaturaEUnidades(false);
    const totalCompetitivos = Number(fpRes.ganhosQtd || 0) + Number(fpRes.perdasReaisQtd || 0);
    const perdRealVal = Number(fpRes.perdasReaisValor || 0);
    const perdRealQtd = Number(fpRes.perdasReaisQtd || 0);

    document.getElementById('rmrFunilGanhosVal').textContent = fmtMoeda(fpRes.ganhosValor);
    document.getElementById('rmrFunilGanhosQtd').textContent = `${fmtInt(fpRes.ganhosQtd)} negócios ganhos (clique p/ detalhar)`;
    const elCardPerdVal = document.getElementById('rmrFunilCardPerdidosVal');
    if (elCardPerdVal) {
      elCardPerdVal.textContent = fmtMoeda(perdRealVal);
      document.getElementById('rmrFunilCardPerdidosQtd').textContent =
        `${fmtInt(perdRealQtd)} perdidos (clique p/ abrir)`;
    }

    document.getElementById('rmrFunilPerdasVal').textContent = fmtMoeda(perdRealVal);
    document.getElementById('rmrFunilPerdasQtd').textContent = `${fmtInt(perdRealQtd)} perdidos (competitivos/operacionais)`;
    document.getElementById('rmrFunilCancelVal').textContent = fmtMoeda(fpRes.canceladosClienteValor);
    document.getElementById('rmrFunilCancelQtd').textContent = `${fmtInt(fpRes.canceladosClienteQtd)} cancelados`;
    document.getElementById('rmrFunilConv').textContent = fmtPct(fpRes.taxaConversaoCompetitivaPct);
    document.getElementById('rmrFunilConvBruta').textContent =
      `${fmtInt(fpRes.ganhosQtd)} ganhos de ${fmtInt(totalCompetitivos)} negócios (sem cancelados)`;

    const elTopMotivo = document.getElementById('rmrPerdidosTopMotivo');
    if (elTopMotivo) {
      const topMot = (fp.motivosPerdaReais || [])[0];
      elTopMotivo.textContent = topMot ? esc(topMot.motivo) : '—';
      document.getElementById('rmrPerdidosTopMotivoSub').textContent = topMot
        ? `${fmtMoeda(topMot.valor)} · ${fmtInt(topMot.qtd)} negócios`
        : 'Sem negócios perdidos';
      document.getElementById('rmrPerdidosConvLimpa').textContent = fmtPct(fpRes.taxaConversaoCompetitivaPct);
      document.getElementById('rmrPerdidosConvLimpaSub').textContent = `${fmtInt(fpRes.ganhosQtd)} ganhos vs ${fmtInt(perdRealQtd)} perdidos`;

      const elDist = document.getElementById('rmrPerdidosDistribuicao');
      const motivos = fp.motivosPerdaReais || [];
      if (elDist) {
        if (!motivos.length) {
          elDist.innerHTML = '<div class="contracts-empty">Sem negócios perdidos registrados no período.</div>';
        } else {
          const palette = ['#dc2626', '#ea580c', '#d97706', '#0284c7', '#475569', '#94a3b8'];
          const top5 = motivos.slice(0, 5);
          const resto = motivos.slice(5);
          const grupos = resto.length
            ? [...top5, {
                motivo: 'Outros motivos',
                valor: resto.reduce((s, x) => s + Number(x.valor || 0), 0),
                qtd: resto.reduce((s, x) => s + Number(x.qtd || 0), 0)
              }]
            : top5;
          elDist.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;">
              <div style="padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;">
                <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;margin-bottom:8px;">
                  <span>Participação por Valor (R$)</span>
                  <span>Total: ${fmtMoeda(perdRealVal)}</span>
                </div>
                <div style="height:22px;border-radius:8px;overflow:hidden;display:flex;background:#e2e8f0;">
                  ${grupos.map((g, i) => {
                    const pct = perdRealVal > 0 ? (Number(g.valor || 0) / perdRealVal) * 100 : 0;
                    return `<div style="width:${pct.toFixed(1)}%;background:${palette[i % palette.length]};" title="${esc(g.motivo)}: ${pct.toFixed(1)}% (${fmtMoeda(g.valor)})"></div>`;
                  }).join('')}
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:10px;font-size:11px;margin-top:10px;color:#334155;">
                  ${grupos.map((g, i) => {
                    const pct = perdRealVal > 0 ? (Number(g.valor || 0) / perdRealVal) * 100 : 0;
                    return `<span><span style="display:inline-block;width:9px;height:9px;background:${palette[i % palette.length]};border-radius:2px;margin-right:4px;"></span>${esc(g.motivo)}: <strong>${pct.toFixed(1)}%</strong></span>`;
                  }).join('')}
                </div>
              </div>
              <div style="padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;">
                <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;margin-bottom:8px;">
                  <span>Participação por Quantidade</span>
                  <span>Total: ${fmtInt(perdRealQtd)}</span>
                </div>
                <div style="height:22px;border-radius:8px;overflow:hidden;display:flex;background:#e2e8f0;">
                  ${grupos.map((g, i) => {
                    const pct = perdRealQtd > 0 ? (Number(g.qtd || 0) / perdRealQtd) * 100 : 0;
                    return `<div style="width:${pct.toFixed(1)}%;background:${palette[i % palette.length]};" title="${esc(g.motivo)}: ${pct.toFixed(1)}% (${fmtInt(g.qtd)})"></div>`;
                  }).join('')}
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:10px;font-size:11px;margin-top:10px;color:#334155;">
                  ${grupos.map((g, i) => {
                    const pct = perdRealQtd > 0 ? (Number(g.qtd || 0) / perdRealQtd) * 100 : 0;
                    return `<span><span style="display:inline-block;width:9px;height:9px;background:${palette[i % palette.length]};border-radius:2px;margin-right:4px;"></span>${esc(g.motivo)}: <strong>${pct.toFixed(1)}%</strong> (${fmtInt(g.qtd)})</span>`;
                  }).join('')}
                </div>
              </div>
            </div>`;
        }
      }
    }

    const cardGanhos = document.getElementById('rmrCardGanhosAction');
    if (cardGanhos && !cardGanhos._bound) {
      cardGanhos._bound = true;
      cardGanhos.addEventListener('click', () => {
        if (rmrFunilTempFiltro || rmrFunilUnidadeFiltro) {
          rmrFunilTempFiltro = null;
          rmrFunilUnidadeFiltro = null;
          if (rmrPayload) renderRmr(rmrPayload);
        }
        document.getElementById('rmrSecaoUltimosGanhos')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    const cardPerdidos = document.getElementById('rmrCardPerdidosAction');
    if (cardPerdidos && !cardPerdidos._bound) {
      cardPerdidos._bound = true;
      cardPerdidos.addEventListener('click', () => {
        document.querySelector('[data-rmr-tab="perdidos"]')?.click();
      });
    }

    // Aba Executivos (Contratos Protheus x Funil CRM x Equipamentos)
    const exDet = d.executivosFunilDetalhe || {};
    const exRes = exDet.resumo || {};
    const elExTotCtr = document.getElementById('rmrExecTotContratos');
    if (elExTotCtr) {
      const totGeral = Number(exRes.totalSobGestao || 0);
      const totCtr = Number(exRes.totalContratos || 0);
      const totFn = Number(exRes.totalFunil || 0);
      elExTotCtr.textContent = fmtMoeda(totCtr);
      document.getElementById('rmrExecTotContratosPct').textContent = totGeral > 0 ? `${((totCtr / totGeral) * 100).toFixed(1)}% do total sob gestão` : '—';
      document.getElementById('rmrExecTotFunil').textContent = fmtMoeda(totFn);
      document.getElementById('rmrExecTotFunilPct').textContent = totGeral > 0 ? `${((totFn / totGeral) * 100).toFixed(1)}% do total sob gestão` : '—';
      document.getElementById('rmrExecTotGeral').textContent = fmtMoeda(totGeral);
      const elOciNote = document.getElementById('rmrExecOciosidadeNote');
      if (elOciNote && exRes.ociosidadeObs) elOciNote.textContent = ` · ${exRes.ociosidadeObs}`;

      const exList = exDet.executivos || [];
      const btnExStyle = 'display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-right:6px;border:1px solid #cbd5e1;border-radius:4px;background:#f8fafc;color:#0f2942;font-weight:700;cursor:pointer;font-size:13px;line-height:1;';
      document.getElementById('tbodyRmrExecutivosFunil').innerHTML = exList.length
        ? exList.map((ex, idx) => {
            const ctrs = ex.contratos || [];
            return `
            <tr>
              <td>
                ${ctrs.length ? `<button type="button" class="rmr-expand-btn" data-expand-target="rmr-ex-ctr-${idx}" style="${btnExStyle}" title="Detalhar contratos e negócios no funil">+</button>` : ''}
                <strong>${esc(ex.executivo)}</strong>
              </td>
              <td class="num">${fmtMoedaExata(ex.contratosValor)} <small class="text-muted">(${fmtInt(ex.contratosQtd)})</small></td>
              <td class="num">${Number(ex.contratosPct || 0).toFixed(1)}%</td>
              <td class="num">${fmtMoedaExata(ex.funilValor)} <small class="text-muted">(${fmtInt(ex.funilQtd)})</small></td>
              <td class="num">${Number(ex.funilPct || 0).toFixed(1)}%</td>
              <td class="num"><strong>${fmtMoedaExata(ex.totalSobGestao)}</strong></td>
            </tr>
            ${ctrs.length ? `
            <tr id="rmr-ex-ctr-${idx}" style="display:none;background:#f8fafc;">
              <td colspan="6" style="padding:10px 14px 10px 28px;">
                <div style="font-size:11.5px;font-weight:700;color:#475569;margin-bottom:6px;">Contratos &amp; Funil de ${esc(ex.executivo)} (${fmtInt(ctrs.length)}):</div>
                <table class="contracts-table" style="background:#fff;border:1px solid #cbd5e1;">
                  <thead>
                    <tr>
                      <th>Contrato / Negócio</th>
                      <th>Origem</th>
                      <th>Unidade</th>
                      <th class="num">% Exec.</th>
                      <th class="num">Valor (R$)</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${ctrs.map((ct, cIdx) => {
                      const itens = ct.itens || [];
                      const isCtr = ct.origem === 'Contrato Protheus';
                      return `
                      <tr>
                        <td>
                          <div class="rmr-cell-expand">
                            ${itens.length ? `<button type="button" class="rmr-expand-btn" data-expand-target="rmr-ex-ctr-itens-${idx}-${cIdx}" style="${btnExStyle}" title="Detalhar itens/produtos/equipamentos">+</button>` : '<span style="display:inline-block;width:20px;flex-shrink:0;"></span>'}
                            <span class="rmr-cell-expand-text"><strong>${esc(ct.codigo)}</strong> · ${esc(ct.titulo)}</span>
                          </div>
                        </td>
                        <td><span class="metric-pill ${isCtr ? 'is-good' : 'is-info'}">${esc(ct.origem)}</span></td>
                        <td>${esc(ct.unidade)}</td>
                        <td class="num">${Number(ct.pctExec || 0).toFixed(1)}%</td>
                        <td class="num"><strong>${fmtMoedaExata(ct.valor)}</strong></td>
                      </tr>
                      ${itens.length ? `
                      <tr id="rmr-ex-ctr-itens-${idx}-${cIdx}" style="display:none;background:#f1f5f9;">
                        <td colspan="5" style="padding:8px 12px 8px 28px;">
                          <div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:4px;">Itens / Produtos / Equipamentos (${fmtInt(itens.length)}):</div>
                          <table class="contracts-table" style="background:#fff;border:1px solid #cbd5e1;">
                            <thead>
                              <tr>
                                <th>Cód.</th>
                                <th>Item / Produto / Equipamento</th>
                                <th class="num">Qtd.</th>
                                <th class="num">Valor (R$)</th>
                              </tr>
                            </thead>
                            <tbody>
                              ${itens.map(it => `
                                <tr>
                                  <td><code>${esc(it.codProduto)}</code></td>
                                  <td><strong>${esc(it.produto)}</strong></td>
                                  <td class="num">${Number(it.quantidade || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}</td>
                                  <td class="num"><strong>${fmtMoedaExata(it.valor)}</strong></td>
                                </tr>`).join('')}
                            </tbody>
                          </table>
                        </td>
                      </tr>` : ''}`;
                    }).join('')}
                  </tbody>
                </table>
              </td>
            </tr>` : ''}`;
          }).join('')
        : '<tr><td colspan="7" class="contracts-empty">Sem dados de executivos no período.</td></tr>';

      document.querySelectorAll('#tbodyRmrExecutivosFunil .rmr-expand-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const targetId = btn.getAttribute('data-expand-target');
          const row = targetId ? document.getElementById(targetId) : null;
          if (!row) return;
          const isOpen = row.style.display !== 'none';
          row.style.display = isOpen ? 'none' : 'table-row';
          btn.textContent = isOpen ? '+' : '−';
          btn.classList.toggle('is-open', !isOpen);
          btn.closest('tr')?.classList.toggle('rmr-row-expanded', !isOpen);
          row.classList.toggle('rmr-subrow-open', !isOpen);
        });
      });
    }

    renderRankingList('rmrMotivosReais', fp.motivosPerdaReais || [], {
      labelKey: 'motivo',
      valueKey: 'valor',
      detailFn: m => `${fmtInt(m.qtd)} negócios perdidos`,
      emptyMsg: 'Sem perdas competitivas/operacionais no período.'
    });
    renderRankingList('rmrMotivosCancel', fp.motivosCancelamentoCliente || [], {
      labelKey: 'motivo',
      valueKey: 'valor',
      detailFn: m => `${fmtInt(m.qtd)} deals cancelados/declinados pelo cliente`,
      emptyMsg: 'Sem cancelamentos pelo cliente no período.'
    });

    // Aba Margem de Contribuição (Protheus · Margens A e B)
    const mc = d.margemContribuicao || {};
    const mcRes = mc.resumo || {};
    const mcContratos = mc.contratos || [];
    const elMcTotVal = document.getElementById('rmrMargemTotalVal');
    if (elMcTotVal) {
      elMcTotVal.textContent = fmtMoeda(mcRes.valorTotal);
      document.getElementById('rmrMargemTotalQtd').textContent = `${fmtInt(mcRes.totalContratos)} contratos (Margens A e B)`;
      document.getElementById('rmrMargemAVal').textContent = fmtMoeda(mcRes.valorA);
      document.getElementById('rmrMargemAQtd').textContent = `${fmtInt(mcRes.contratosA)} contratos Margem A`;
      document.getElementById('rmrMargemBVal').textContent = fmtMoeda(mcRes.valorB);
      document.getElementById('rmrMargemBQtd').textContent = `${fmtInt(mcRes.contratosB)} contratos Margem B`;

      const selTipo = document.getElementById('rmrMargemFiltroTipo');
      const selUnid = document.getElementById('rmrMargemFiltroUnidade');
      const selExec = document.getElementById('rmrMargemFiltroExec');
      const inpBusca = document.getElementById('rmrMargemBusca');

      if (selUnid) {
        const prevU = selUnid.value || 'todas';
        const unids = [...new Set(mcContratos.map(c => c.unidade).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        selUnid.innerHTML = '<option value="todas">Todas as unidades</option>' +
          unids.map(u => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
        selUnid.value = unids.includes(prevU) ? prevU : 'todas';
      }
      if (selExec) {
        const prevE = selExec.value || 'todos';
        const execs = [...new Set(mcContratos.map(c => c.executivo).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        selExec.innerHTML = '<option value="todos">Todos os executivos</option>' +
          execs.map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
        selExec.value = execs.includes(prevE) ? prevE : 'todos';
      }

      const renderTabelaMargem = () => {
        const tipo = selTipo ? selTipo.value : 'todas';
        const unid = selUnid ? selUnid.value : 'todas';
        const exec = selExec ? selExec.value : 'todos';
        const q = (inpBusca ? inpBusca.value : '').trim().toLowerCase();

        const cardA = document.getElementById('rmrCardMargemA');
        const cardB = document.getElementById('rmrCardMargemB');
        if (cardA) cardA.style.outline = tipo === 'A' ? '2px solid #0284c7' : '';
        if (cardB) cardB.style.outline = tipo === 'B' ? '2px solid #0284c7' : '';

        const filtrados = mcContratos.filter(c => {
          if (tipo !== 'todas' && c.margem !== tipo) return false;
          if (unid !== 'todas' && c.unidade !== unid) return false;
          if (exec !== 'todos' && c.executivo !== exec) return false;
          if (q) {
            const hay = `${c.numeroContrato} ${c.cliente} ${c.executivo} ${c.unidade}`.toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });

        const elTag = document.getElementById('rmrMargemTag');
        if (elTag) elTag.textContent = `Protheus · ${fmtInt(filtrados.length)} contratos exibidos`;

        const elTbody = document.getElementById('tbodyRmrMargem');
        if (elTbody) {
          elTbody.innerHTML = filtrados.length
            ? filtrados.map(c => {
                const badgeStyle = c.margem === 'A'
                  ? 'background:#dcfce7;color:#166534;border:1px solid #86efac;'
                  : 'background:#fef3c7;color:#92400e;border:1px solid #fcd34d;';
                return `
                  <tr>
                    <td><strong>${esc(c.numeroContrato)}</strong></td>
                    <td>${esc(c.cliente)}</td>
                    <td>${esc(c.unidade)}</td>
                    <td>${esc(c.executivo)}</td>
                    <td style="text-align:center;"><span style="display:inline-block;min-width:28px;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:700;${badgeStyle}">${esc(c.margem)}</span></td>
                    <td class="num"><strong>${fmtMoedaExata(c.valorContrato)}</strong></td>
                  </tr>`;
              }).join('')
            : '<tr><td colspan="6" class="contracts-empty">Nenhum contrato encontrado para os filtros selecionados.</td></tr>';
        }
      };

      [selTipo, selUnid, selExec].forEach(el => {
        if (el && !el._boundMargem) {
          el._boundMargem = true;
          el.addEventListener('change', renderTabelaMargem);
        }
      });
      if (inpBusca && !inpBusca._boundMargem) {
        inpBusca._boundMargem = true;
        inpBusca.addEventListener('input', renderTabelaMargem);
      }
      const cardA = document.getElementById('rmrCardMargemA');
      if (cardA && !cardA._boundMargem) {
        cardA._boundMargem = true;
        cardA.addEventListener('click', () => {
          if (selTipo) {
            selTipo.value = selTipo.value === 'A' ? 'todas' : 'A';
            renderTabelaMargem();
          }
        });
      }
      const cardB = document.getElementById('rmrCardMargemB');
      if (cardB && !cardB._boundMargem) {
        cardB._boundMargem = true;
        cardB.addEventListener('click', () => {
          if (selTipo) {
            selTipo.value = selTipo.value === 'B' ? 'todas' : 'B';
            renderTabelaMargem();
          }
        });
      }

      renderTabelaMargem();
    }
  }

  function exportarRmrCsv() {
    if (!rmrPayload) {
      core().showToast('Carregue o RMR Comercial antes de exportar.', 'warning');
      return;
    }
    const headers = [
      'Unidade', 'Realizado Mes', 'Meta Mes', 'Atingimento Mes %',
      'Realizado YTD', 'Meta YTD', 'Atingimento YTD %', 'Meta Anual', 'Run-Rate Anual', 'Tipo'
    ];
    const rows = (rmrPayload.metasVsRealizado?.unidades || []).map(u => [
      u.unidade,
      Number(u.realizadoMes || 0).toFixed(2).replace('.', ','),
      Number(u.metaMes || 0).toFixed(2).replace('.', ','),
      u.atingimentoMesPct === null ? '' : u.atingimentoMesPct.toFixed(1).replace('.', ','),
      Number(u.realizadoYtd || 0).toFixed(2).replace('.', ','),
      Number(u.metaYtd || 0).toFixed(2).replace('.', ','),
      u.atingimentoYtdPct === null ? '' : u.atingimentoYtdPct.toFixed(1).replace('.', ','),
      Number(u.metaAnual || 0).toFixed(2).replace('.', ','),
      Number(u.runRateAnual || 0).toFixed(2).replace('.', ','),
      u.isExpurgoUnidade ? 'Expurgo/Rateio' : 'Comercial Core'
    ]);
    baixarCsv(`rmr-comercial-${rmrPayload.parametros?.mesRefIso || 'ref'}.csv`, headers, rows);
  }

  /* ==============================================================
     PAINEL 2: FATURAMENTO DETALHADO & RECEBIMENTOS EFETIVOS
     ============================================================== */
  function setupFaturamentoControls() {
    if (fatControlsReady) return;
    fatControlsReady = true;

    const nowBr = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const curYear = nowBr.getUTCFullYear();
    const todayIso = nowBr.toISOString().slice(0, 10);

    const startEl = document.getElementById('fatStartDate');
    const endEl = document.getElementById('fatEndDate');
    if (startEl && !startEl.value) startEl.value = `${curYear}-01-01`;
    if (endEl && !endEl.value) endEl.value = todayIso;

    const triggerReload = () => carregarFaturamento(true);
    ['fatStartDate', 'fatEndDate', 'fatUnidade', 'fatCliente', 'fatExecutivo', 'fatEscopo', 'fatRegime'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', triggerReload);
    });

    document.getElementById('fatBusca')?.addEventListener('input', () => {
      clearTimeout(fatBuscaTimer);
      fatBuscaTimer = setTimeout(() => carregarFaturamento(true), 420);
    });

    document.getElementById('btnAtualizarFaturamento')?.addEventListener('click', triggerReload);
    document.getElementById('btnExportarFaturamentoCsv')?.addEventListener('click', exportarFaturamentoCsv);
  }

  function preencherSelectPreservando(selectId, opcoes, rotuloPadrao) {
    const el = document.getElementById(selectId);
    if (!el) return;
    const prev = el.value;
    core().preencherSelectFiltro(selectId, opcoes, rotuloPadrao);
    if (prev && Array.from(el.options).some(o => o.value === prev)) {
      el.value = prev;
    }
  }

  async function carregarFaturamento(forcar = false) {
    setupFaturamentoControls();
    if (!core().podeAcessarRelatorios() || (fatCarregado && !forcar)) return;

    const loading = document.getElementById('fatLoading');
    const conteudo = document.getElementById('fatConteudo');
    const erro = document.getElementById('fatErro');
    const btn = document.getElementById('btnAtualizarFaturamento');
    const jaVisivel = conteudo.style.display === 'block';

    if (!jaVisivel) {
      loading.style.display = 'flex';
      conteudo.style.display = 'none';
    } else {
      conteudo.classList.add('is-reloading');
    }
    erro.style.display = 'none';
    if (btn) btn.disabled = true;

    try {
      const params = new URLSearchParams({
        startDate: document.getElementById('fatStartDate')?.value || '',
        endDate: document.getElementById('fatEndDate')?.value || '',
        unidade: document.getElementById('fatUnidade')?.value || '',
        cliente: document.getElementById('fatCliente')?.value || '',
        executivo: document.getElementById('fatExecutivo')?.value || '',
        escopo: document.getElementById('fatEscopo')?.value || 'pbix',
        incluirExpurgos: document.getElementById('fatRegime')?.value || '0',
        busca: document.getElementById('fatBusca')?.value?.trim() || ''
      });

      const dados = await core().fetchRelatorioAutenticado(`/api/faturamento?${params.toString()}`);
      fatPayload = dados;
      fatCarregado = true;

      preencherSelectPreservando('fatUnidade', dados.filtros?.unidades || [], 'Todas as unidades');
      preencherSelectPreservando('fatCliente', dados.filtros?.clientes || [], 'Todos os clientes');
      preencherSelectPreservando('fatExecutivo', dados.filtros?.executivos || [], 'Todos os executivos');

      renderizarFaturamento(dados);
      conteudo.style.display = 'block';
    } catch (ex) {
      if (!jaVisivel) conteudo.style.display = 'none';
      erro.innerHTML = `<i class="ph ph-warning-circle"></i><span>${esc(ex.message || 'Não foi possível carregar os dados de Faturamento.')}</span>`;
      erro.style.display = 'flex';
    } finally {
      loading.style.display = 'none';
      conteudo.classList.remove('is-reloading');
      if (btn) btn.disabled = false;
    }
  }

  function renderizarFaturamento(d) {
    const res = d.resumo || {};
    const incluiExp = Boolean(d.parametros?.incluirExpurgos);
    const protEmissao = d.atualizacao?.protheusUltimaEmissao ? core().formatarDataBr(d.atualizacao.protheusUltimaEmissao) : '—';
    const dtIni = core().formatarDataBr(d.periodo?.startDate);
    const dtFim = core().formatarDataBr(d.periodo?.endDate);

    document.getElementById('fatAtualizacaoTexto').textContent = `Protheus emissão até ${protEmissao} · Período filtrado: ${dtIni} a ${dtFim}`;
    document.getElementById('fatFonteTexto').textContent =
      `${d.fontes?.faturamentoPrincipal || 'Protheus SD2'} · faturamento_bruto legado: ${fmtInt(d.fontes?.faturamentoBrutoLegadoRows || 0)} linhas`;

    document.getElementById('fatKpiPrincipalLabel').textContent = incluiExp ? 'Faturamento Bruto Fiscal' : 'Faturamento Comercial Puro';
    document.getElementById('fatKpiPrincipal').textContent = fmtMoeda(res.valorPrincipal);
    document.getElementById('fatKpiYoY').textContent =
      `YoY vs período anterior: ${fmtPct(res.variacaoYoYPct, true)} (Base anterior: ${fmtMoeda(res.valorAnoAnterior)})`;

    document.getElementById('fatKpiBruto').textContent = fmtMoeda(res.faturamentoBruto);
    document.getElementById('fatKpiExpurgos').textContent =
      `Comercial Puro: ${fmtMoeda(res.faturamentoLiquido)} · Expurgos: ${fmtMoeda(res.expurgos)}`;

    document.getElementById('fatKpiMeta').textContent = fmtMoeda(res.metaPeriodo);
    document.getElementById('fatKpiAting').textContent = `Atingimento no período: ${fmtPct(res.atingimentoPct)}`;

    document.getElementById('fatKpiVolume').textContent = `${fmtInt(res.qtdNfs)} NFs · ${fmtInt(res.qtdClientes)} clientes`;
    document.getElementById('fatKpiTicket').textContent = `Ticket médio/NF: ${fmtMoedaExata(res.ticketMedioNf)} · ${fmtInt(res.qtdItens)} itens`;

    const toggleFatSelect = (selectId, valor) => {
      const sel = document.getElementById(selectId);
      if (!sel) return;
      sel.value = sel.value === valor ? '' : valor;
      carregarFaturamento(true);
    };

    document.getElementById('fatMensalTag').textContent = `${d.mensal?.length || 0} meses com emissão no recorte (clique no mês para focar)`;
    renderMonthlyComparisonBars('fatGraficoMensal', d.mensal || [], {
      valKey: 'valor',
      metaKey: 'meta',
      closedKey: '',
      onClick: mesIso => {
        const [yy, mm] = mesIso.split('-').map(Number);
        const ultimoDia = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
        const iniEl = document.getElementById('fatStartDate');
        const fimEl = document.getElementById('fatEndDate');
        if (iniEl && fimEl) {
          iniEl.value = `${mesIso}-01`;
          fimEl.value = `${mesIso}-${String(ultimoDia).padStart(2, '0')}`;
          carregarFaturamento(true);
        }
      }
    });

    renderRankingList('fatPorUnidade', d.porUnidade || [], {
      labelKey: 'unidade',
      valueKey: 'valor',
      activeValue: d.parametros?.unidade || '',
      onClick: val => toggleFatSelect('fatUnidade', val),
      detailFn: u => `Share: ${fmtPct(u.participacaoPct)} · ${fmtInt(u.qtdNfs)} NFs${u.meta > 0 ? ` · Meta: ${fmtMoeda(u.meta)} (${fmtPct(u.atingimentoPct)})` : ''}`
    });

    renderRankingList('fatPorExecutivo', d.porExecutivo || [], {
      labelKey: 'executivo',
      valueKey: 'valor',
      activeValue: d.parametros?.executivo || '',
      onClick: val => toggleFatSelect('fatExecutivo', val),
      detailFn: e => `Share: ${fmtPct(e.participacaoPct)} · ${fmtInt(e.qtdNfs)} NFs / ${fmtInt(e.qtdClientes)} cli${e.metaAnual ? ` · Alvo anual: ${fmtMoeda(e.metaAnual)}` : ''}`
    });

    renderRankingList('fatPorCliente', (d.porCliente || []).slice(0, 15), {
      labelKey: 'cliente',
      valueKey: 'valor',
      activeValue: d.parametros?.cliente || '',
      onClick: val => toggleFatSelect('fatCliente', val),
      detailFn: c => `${c.unidadePrincipal} · Share: ${fmtPct(c.participacaoPct)} · Pareto acum.: ${fmtPct(c.acumuladoPct)} · ${fmtInt(c.qtdNfs)} NFs`
    });

    const margemTop = (d.porMargem || []).map(m => ({
      rotulo: `Margem: ${m.margem}`,
      valor: m.valor,
      detalhe: `${fmtPct(m.participacaoPct)} · ${fmtInt(m.qtdNfs)} NFs · ${fmtInt(m.qtdItens)} itens`
    }));
    const prodTop = (d.porProduto || []).slice(0, 8).map(p => ({
      rotulo: p.produto,
      valor: p.valor,
      detalhe: `${fmtPct(p.participacaoPct)} · ${fmtInt(p.qtdNfs)} NFs`
    }));
    renderRankingList('fatMargemProdutos', [...margemTop, ...prodTop], {
      labelKey: 'rotulo',
      valueKey: 'valor',
      detailFn: x => x.detalhe
    });

    const an = d.analitico || {};
    document.getElementById('fatAnaliticoResumo').textContent =
      `Exibindo ${fmtInt(an.exibidos)} de ${fmtInt(an.totalRegistros)} registros fiscais${an.truncado ? ' (limite de tela 1.500 — use filtros para refinar)' : ''}`;

    const linhas = an.linhas || [];
    document.getElementById('tbodyFatAnalitico').innerHTML = linhas.length
      ? linhas.map(l => `
          <tr class="${l.isExpurgo ? 'row-muted' : ''}">
            <td>${core().formatarDataBr(l.emissao)}</td>
            <td><strong>${esc(l.numeroDocumento)}</strong>/${esc(l.serie || '-')}</td>
            <td>${esc(l.codFilial)}</td>
            <td>${esc(l.unidade)}</td>
            <td title="${esc(l.cliente)}">${esc(l.cliente)}</td>
            <td>${esc(l.executivo)}</td>
            <td>${esc(l.numeroContrato)}</td>
            <td title="${esc(l.produto)}">${esc(l.produto)}</td>
            <td>${esc(l.tes)}/${esc(l.cfop)} ${l.isExpurgo ? '<span class="metric-pill is-neutral">Exp</span>' : ''}</td>
            <td class="num"><strong>${fmtMoedaExata(l.valorTotal)}</strong></td>
          </tr>`).join('')
      : '<tr><td colspan="10" class="contracts-empty">Nenhum item fiscal encontrado para os filtros aplicados.</td></tr>';

    // Seção Separada: Recebimentos Efetivos (SE1)
    const rec = d.recebimentos || {};
    const recEl = document.getElementById('fatRecebimentosConteudo');
    if (rec.disponivel) {
      const rr = rec.resumo || {};
      recEl.innerHTML = `
        <div class="report-status-banner is-info">
          <i class="ph ph-check-circle"></i>
          <div><strong>Fonte Financeira Conectada:</strong> ${esc(rec.fonte)} · Regra de data: ${esc(rec.regraData)}.</div>
        </div>
        <div class="reports-kpis">
          <article class="kpi-card highlight">
            <span class="kpi-label">Total Recebido Líquido (Baixa)</span>
            <strong class="kpi-value">${fmtMoeda(rr.valorRecebido)}</strong>
            <span class="kpi-note">${fmtInt(rr.qtdTitulos)} títulos liquidados · Última baixa: ${rr.ultimaBaixa ? core().formatarDataBr(rr.ultimaBaixa) : '—'}</span>
          </article>
          <article class="kpi-card">
            <span class="kpi-label">Valor Original dos Títulos</span>
            <strong class="kpi-value">${fmtMoeda(rr.valorOriginal)}</strong>
            <span class="kpi-note">Juros/Multa: ${fmtMoedaExata(rr.jurosMulta)} · Descontos: ${fmtMoedaExata(rr.descontos)}</span>
          </article>
        </div>
        <div class="reports-grid">
          <article class="report-panel">
            <div class="report-panel-header">
              <h3>Recebimentos Mensais (Data de Baixa)</h3>
              <span class="report-panel-tag">Regime de Caixa</span>
            </div>
            <div class="table-responsive">
              <table class="contracts-table">
                <thead><tr><th>Mês Baixa</th><th class="num">Qtd. Títulos</th><th class="num">Valor Recebido</th></tr></thead>
                <tbody>
                  ${(rec.mensal || []).map(m => `<tr><td>${esc(m.mes)}</td><td class="num">${fmtInt(m.qtdTitulos)}</td><td class="num"><strong>${fmtMoedaExata(m.valorRecebido)}</strong></td></tr>`).join('')}
                </tbody>
              </table>
            </div>
          </article>
          <article class="report-panel">
            <div class="report-panel-header">
              <h3>Top Clientes Pagadores no Período (Baixa)</h3>
              <span class="report-panel-tag">Top 25 por liquidação</span>
            </div>
            <div class="table-responsive">
              <table class="contracts-table">
                <thead><tr><th>Cliente</th><th class="num">Títulos</th><th>Última Baixa</th><th class="num">Recebido</th></tr></thead>
                <tbody>
                  ${(rec.porCliente || []).map(c => `<tr><td>${esc(c.cliente)}</td><td class="num">${fmtInt(c.qtdTitulos)}</td><td>${c.ultimaBaixa ? core().formatarDataBr(c.ultimaBaixa) : '—'}</td><td class="num"><strong>${fmtMoedaExata(c.valorRecebido)}</strong></td></tr>`).join('')}
                </tbody>
              </table>
            </div>
          </article>
        </div>`;
    } else {
      recEl.innerHTML = `
        <div class="report-status-banner is-warning">
          <i class="ph ph-lock-key"></i>
          <div>
            <strong>Recebimentos Efetivos — Pendência de Permissão no PostgreSQL DW:</strong>
            <p>${esc(rec.motivo || 'Fonte financeira SE1 bloqueada para o usuário de leitura atual.')}</p>
            <p><strong>Fonte esperada:</strong> <code>${esc(rec.fonteEsperada || 'financeiro.protheus_se1_gold_nota_fiscais_entrada')}</code> · <strong>Regra obrigatória:</strong> <code>${esc(rec.regraData || 'data_ultima_baixa')}</code>.</p>
            <p><strong>Ação DBA pendente:</strong> <code>${esc(rec.acaoNecessaria || '')}</code></p>
          </div>
        </div>`;
    }
  }

  function exportarFaturamentoCsv() {
    const linhas = fatPayload?.analitico?.linhas || [];
    if (!linhas.length) {
      core().showToast('Nenhum item analítico carregado para exportar.', 'warning');
      return;
    }
    const headers = [
      'Emissao', 'Filial', 'NF', 'Serie', 'Unidade', 'Cod Cliente', 'Cliente',
      'Executivo', 'Contrato', 'Produto', 'TES', 'CFOP', 'Margem',
      'Quantidade', 'Valor Unitario', 'Valor Total', 'Expurgo Comercial'
    ];
    const rows = linhas.map(l => [
      core().formatarDataBr(l.emissao),
      l.codFilial,
      l.numeroDocumento,
      l.serie,
      l.unidade,
      l.codCliente,
      l.cliente,
      l.executivo,
      l.numeroContrato,
      l.produto,
      l.tes,
      l.cfop,
      l.margem || '',
      Number(l.quantidade || 0).toFixed(2).replace('.', ','),
      Number(l.valorUnitario || 0).toFixed(2).replace('.', ','),
      Number(l.valorTotal || 0).toFixed(2).replace('.', ','),
      l.isExpurgo ? 'Sim' : 'Nao'
    ]);
    baixarCsv(`faturamento-analitico-${fatPayload.periodo?.startDate || 'ini'}-a-${fatPayload.periodo?.endDate || 'fim'}.csv`, headers, rows);
  }

  // ============================================================================
  // INADIMPLENCIA (EXECUTIVO, MARGEM E CLIENTE + EXPORTACAO XLSX 2 ABAS)
  // ============================================================================
  function hojeLocalIso() {
    const dt = new Date();
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const FILIAL_NOMES_INAD = {
    '010101': '010101 - Matriz Fortaleza',
    '010102': '010102 - Filial 010102',
    '010103': '010103 - Filial 010103',
    '010104': '010104 - Filial 010104',
    '020201': '020201 - Cordeiro Guindastes',
    '030301': '030301 - Transportes Matriz',
    '030302': '030302 - Transportes Filial 02',
    '030303': '030303 - Transportes Pecém',
    '040401': '040401 - JVC Locações',
    '060601': '060601 - Cordeiro Locações',
    '060602': '060602 - Cordeiro Locações (Wind)',
    '070701': '070701 - Filial 070701',
    '101001': '101001 - Central Administrativa',
    '111101': '111101 - ALSM Locações',
    '121201': '121201 - CM Máquinas (Matriz)',
    '121202': '121202 - CM Máquinas (Mossoró)',
    '121203': '121203 - CM Máquinas (Recife)',
    '141401': '141401 - Cordeiro Engenharia',
    '161601': '161601 - Holding / Central ADM',
    '171701': '171701 - Cordeiro Metalmecânica'
  };

  function extrairCodFilialInad(codFilial, rawFilial) {
    const cod = String(codFilial || '').trim();
    if (/^\d{6}$/.test(cod)) return cod;
    const raw = String(rawFilial || '').trim();
    const m = raw.match(/\b(\d{6})\b/);
    return m ? m[1] : '';
  }

  function formatarFilialInad(codFilial, rawFilial) {
    const cod = extrairCodFilialInad(codFilial, rawFilial);
    if (cod && FILIAL_NOMES_INAD[cod]) return FILIAL_NOMES_INAD[cod];
    const raw = String(rawFilial || '').trim();
    if (cod && raw) {
      if (raw.startsWith(`${cod} -`)) return raw;
      const nomeLimpo = raw.replace(new RegExp(`\\s*\\(${cod}\\)\\s*`, 'g'), '').trim();
      return nomeLimpo && nomeLimpo !== cod ? `${cod} - ${nomeLimpo}` : `${cod} - Filial ${cod}`;
    }
    if (cod) return `${cod} - Filial ${cod}`;
    return raw || 'Sem Filial';
  }

  function atualizarLabelFiliaisInad() {
    const labelEl = document.getElementById('inadFiltroFilialLabel');
    const btnEl = document.getElementById('inadFiltroFilialBtn');
    if (!labelEl) return;
    const total = inadFiliaisCatalogo.length;
    const qtd = inadFiliaisSelecionadas.size;
    if (qtd === 0 || (total > 0 && qtd >= total)) {
      labelEl.textContent = 'Todas as filiais';
      btnEl?.classList.remove('has-selection');
    } else if (qtd === 1) {
      const onlyKey = Array.from(inadFiliaisSelecionadas)[0];
      const item = inadFiliaisCatalogo.find(f => f.key === onlyKey);
      labelEl.textContent = item ? item.label : onlyKey;
      btnEl?.classList.add('has-selection');
    } else {
      labelEl.textContent = `${qtd} filiais selecionadas`;
      btnEl?.classList.add('has-selection');
    }
  }

  function renderizarListaFiliaisInad() {
    const listaEl = document.getElementById('inadFiltroFilialLista');
    if (!listaEl) return;
    const termo = String(document.getElementById('inadFiltroFilialBusca')?.value || '').trim().toLowerCase();
    const filtradas = termo
      ? inadFiliaisCatalogo.filter(f => f.label.toLowerCase().includes(termo) || f.key.toLowerCase().includes(termo))
      : inadFiliaisCatalogo;

    if (!filtradas.length) {
      listaEl.innerHTML = '<div class="multi-select-empty">Nenhuma filial encontrada.</div>';
      return;
    }

    listaEl.innerHTML = filtradas.map(f => {
      const checked = inadFiliaisSelecionadas.has(f.key) ? 'checked' : '';
      return `
        <label class="multi-select-option">
          <input type="checkbox" value="${esc(f.key)}" ${checked} />
          <span class="multi-select-text" title="${esc(f.label)}">${esc(f.label)}</span>
          <small class="multi-select-count">${fmtInt(f.count)}</small>
        </label>`;
    }).join('');

    listaEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) {
          inadFiliaisSelecionadas.add(cb.value);
        } else {
          inadFiliaisSelecionadas.delete(cb.value);
        }
        atualizarLabelFiliaisInad();
        renderizarInadimplencia();
      });
    });
  }

  function preencherFiltroFiliaisInad(titulos) {
    const map = new Map();
    for (const t of (titulos || [])) {
      const label = formatarFilialInad(t.codFilial, t.filial);
      const key = extrairCodFilialInad(t.codFilial, t.filial) || label;
      t.codFilial = key;
      t.filial = label;
      if (!map.has(key)) {
        map.set(key, { key, label, count: 0 });
      }
      map.get(key).count += 1;
    }
    inadFiliaisCatalogo = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));

    const validKeys = new Set(inadFiliaisCatalogo.map(f => f.key));
    inadFiliaisSelecionadas = new Set(Array.from(inadFiliaisSelecionadas).filter(k => validKeys.has(k)));

    atualizarLabelFiliaisInad();
    renderizarListaFiliaisInad();
  }

  function bindInadimplenciaControles() {
    if (inadBinded) return;
    inadBinded = true;

    const corteEl = document.getElementById('inadDataCorte');
    if (corteEl && !corteEl.value) {
      corteEl.value = hojeLocalIso();
    }

    document.getElementById('btnAtualizarInadimplencia')?.addEventListener('click', () => carregarInadimplencia(true));
    document.getElementById('inadDataCorte')?.addEventListener('change', () => {
      if (inadPayload?.importadoDe) {
        renderizarInadimplencia();
      } else {
        carregarInadimplencia(true);
      }
    });
    document.getElementById('inadCompetencia')?.addEventListener('change', () => {
      inadCarregado = false;
      carregarInadimplencia(true);
    });
    document.getElementById('btnFecharCompetencia')?.addEventListener('click', fecharCompetenciaInad);

    const btnFilial = document.getElementById('inadFiltroFilialBtn');
    const menuFilial = document.getElementById('inadFiltroFilialMenu');
    const wrapFilial = document.getElementById('inadFiltroFilialDropdown');
    if (btnFilial && menuFilial) {
      const toggleMenu = (abrir) => {
        const isOpen = abrir !== undefined ? abrir : menuFilial.style.display === 'none';
        menuFilial.style.display = isOpen ? 'block' : 'none';
        btnFilial.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        if (isOpen) {
          document.getElementById('inadFiltroFilialBusca')?.focus();
        }
      };
      btnFilial.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMenu();
      });
      document.addEventListener('click', (e) => {
        if (wrapFilial && !wrapFilial.contains(e.target)) {
          toggleMenu(false);
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') toggleMenu(false);
      });
    }
    document.getElementById('inadFiltroFilialBusca')?.addEventListener('input', renderizarListaFiliaisInad);
    document.getElementById('btnInadFilialLimpar')?.addEventListener('click', () => {
      inadFiliaisSelecionadas.clear();
      const buscaFil = document.getElementById('inadFiltroFilialBusca');
      if (buscaFil) buscaFil.value = '';
      atualizarLabelFiliaisInad();
      renderizarListaFiliaisInad();
      renderizarInadimplencia();
    });

    ['inadFiltroExecutivo', 'inadFiltroMargem', 'inadFaixaAtraso'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', renderizarInadimplencia);
    });
    document.getElementById('inadFiltroBusca')?.addEventListener('input', renderizarInadimplencia);

    document.getElementById('btnImportarInadimplenciaXlsx')?.addEventListener('click', () => {
      document.getElementById('inputImportarInadimplenciaXlsx')?.click();
    });
    document.getElementById('inputImportarInadimplenciaXlsx')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) await importarPlanilhaInadimplencia(file);
      e.target.value = '';
    });
    document.getElementById('btnExportarInadimplenciaXlsx')?.addEventListener('click', exportarInadimplenciaXlsx);
  }

  function normalizarMargemInad(raw) {
    const t = String(raw || '').trim().toUpperCase();
    if (!t) return 'Sem Margem';
    if (t === 'A' || t.startsWith('MARGEM A')) return 'A';
    if (t === 'B' || t.startsWith('MARGEM B')) return 'B';
    if (t === 'C' || t.startsWith('MARGEM C')) return 'C';
    return t;
  }

  const EXECUTIVOS_INAD_LISTA = [
    'Cristiane',
    'Cristiano',
    'Bruno',
    'Fernando',
    'Fabricio',
    'Marcio',
    'Outros'
  ];

  function normalizarExecutivoInad(nome) {
    const norm = String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
    if (!norm) return 'Outros';
    if (norm.includes('CRISTIANE')) return 'Cristiane';
    if (norm.includes('CRISTIANO')) return 'Cristiano';
    if (norm.includes('BRUNO')) return 'Bruno';
    if (norm.includes('FERNANDO')) return 'Fernando';
    if (norm.includes('FABRICIO') || norm.includes('FABRIOCIO')) return 'Fabricio';
    if (norm.includes('MARCIO')) return 'Marcio';
    return 'Outros';
  }

  function excelSerialParaIso(val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number' && val > 20000) {
      const dt = new Date(Math.round((val - 25569) * 86400 * 1000));
      return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
    }
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return null;
  }

  async function importarPlanilhaInadimplencia(file) {
    if (!window.XLSX) {
      core().showToast('Biblioteca Excel (SheetJS) não carregada.', 'error');
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array' });
      const firstSheet = wb.SheetNames[0];
      const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[firstSheet], { header: 1, defval: '' });

      const headerIdx = rows.findIndex(r =>
        r.some(c => /executivo/i.test(String(c))) &&
        r.some(c => /cliente/i.test(String(c))) &&
        r.some(c => /saldo|valor/i.test(String(c)))
      );
      if (headerIdx < 0) {
        core().showToast('Não encontrei o cabeçalho padrão (Executivo, Cliente, Margem, Saldo) na planilha.', 'error');
        return;
      }

      const headers = rows[headerIdx].map(h => String(h || '').trim().toLowerCase());
      const findCol = (patterns) => headers.findIndex(h => patterns.some(p => p.test(h)));
      const idxOrigem = findCol([/^origem/]);
      const idxExec = findCol([/executivo/]);
      const idxCodCli = findCol([/c[oó]d.*cliente/]);
      const idxCli = findCol([/^cliente/, /raz[aã]o social/]);
      const idxMargem = findCol([/margem/]);
      const idxContrato = findCol([/contrato/]);
      const idxFilial = findCol([/filial/]);
      const idxSerie = findCol([/s[eé]rie|pref/]);
      const idxTitulo = findCol([/t[ií]tulo|nf/]);
      const idxValorOrig = findCol([/valor original/, /vr\.?\s*t[ií]tulo/, /vlr\.?\s*t[ií]tulo/, /valor t[ií]tulo/]);
      const idxSaldo = findCol([/saldo inadimplente/, /^saldo/, /sld.*aberto/]);
      const idxEmissao = findCol([/emiss[aã]o/]);
      const idxVenc = findCol([/venc.*real/, /vencto.*real/, /vencimento/]);

      const titulos = [];
      for (let i = headerIdx + 1; i < rows.length; i += 1) {
        const r = rows[i];
        const cli = idxCli >= 0 ? String(r[idxCli] || '').trim() : '';
        const exec = idxExec >= 0 ? String(r[idxExec] || '').trim() : '';
        const saldo = idxSaldo >= 0 ? Number(r[idxSaldo] || 0) : 0;
        if (!cli && !exec && !saldo) continue;
        if (/^total/i.test(cli) || /^total/i.test(exec)) continue;
        if (!(saldo > 0)) continue;
        const rawFil = idxFilial >= 0 ? String(r[idxFilial] || '').trim() : '';
        const codFil = extrairCodFilialInad('', rawFil);
        titulos.push({
          origem: idxOrigem >= 0 ? String(r[idxOrigem] || 'PLANILHA').trim() : 'PLANILHA',
          executivo: normalizarExecutivoInad(exec),
          codCliente: idxCodCli >= 0 ? String(r[idxCodCli] || '').trim() : '',
          cliente: cli || 'Não informado',
          margem: normalizarMargemInad(idxMargem >= 0 ? r[idxMargem] : ''),
          contrato: idxContrato >= 0 ? String(r[idxContrato] || '').trim() : '',
          codFilial: codFil,
          filial: formatarFilialInad(codFil, rawFil),
          serie: idxSerie >= 0 ? String(r[idxSerie] || '').trim() : '',
          titulo: idxTitulo >= 0 ? String(r[idxTitulo] || '').trim() : '',
          valorOriginal: idxValorOrig >= 0 ? Number(r[idxValorOrig] || 0) : saldo,
          saldoInadimplente: saldo,
          emissao: idxEmissao >= 0 ? excelSerialParaIso(r[idxEmissao]) : null,
          vencimentoReal: idxVenc >= 0 ? excelSerialParaIso(r[idxVenc]) : null
        });
      }

      if (!titulos.length) {
        core().showToast('Nenhum título com saldo devedor > 0 encontrado na planilha importada.', 'warning');
        return;
      }

      inadPayload = {
        ok: true,
        disponivel: true,
        importadoDe: file.name,
        fonte: `Planilha (${file.name})`,
        dataCorte: document.getElementById('inadDataCorte')?.value || hojeLocalIso(),
        titulos
      };
      inadCarregado = true;
      preencherFiltroFiliaisInad(titulos);
      preencherSelectExecutivoInad(titulos);
      renderizarInadimplencia();
      document.getElementById('inadConteudo').style.display = 'block';
      document.getElementById('inadStatusBanner').innerHTML = `
        <div class="report-status-banner is-info">
          <i class="ph ph-file-xls"></i>
          <div><strong>Planilha carregada:</strong> ${esc(file.name)} (${fmtInt(titulos.length)} títulos). Você pode filtrar por Filial, Executivo, Margem e Cliente e exportar o consolidado em Excel.</div>
        </div>`;
      core().showToast(`Planilha "${file.name}" carregada com ${titulos.length} títulos!`, 'success');
    } catch (ex) {
      core().showToast(`Erro ao ler planilha: ${ex.message}`, 'error');
    }
  }

  function preencherSelectExecutivoInad(titulos) {
    const sel = document.getElementById('inadFiltroExecutivo');
    if (!sel) return;
    const atual = sel.value;
    const presentes = new Set((titulos || []).map(t => normalizarExecutivoInad(t.executivo)).filter(Boolean));
    const lista = EXECUTIVOS_INAD_LISTA.filter(e => presentes.has(e));
    presentes.forEach(e => { if (!lista.includes(e)) lista.push(e); });
    sel.innerHTML = '<option value="">Todos os executivos</option>' + lista.map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
    if (lista.includes(atual)) sel.value = atual;
  }

  async function carregarInadimplencia(forcar = false) {
    bindInadimplenciaControles();
    if (inadCarregado && !forcar && inadPayload) {
      renderizarInadimplencia();
      return;
    }

    const loading = document.getElementById('inadLoading');
    const conteudo = document.getElementById('inadConteudo');
    const erro = document.getElementById('inadErro');
    const banner = document.getElementById('inadStatusBanner');
    const btn = document.getElementById('btnAtualizarInadimplencia');

    loading.style.display = 'flex';
    conteudo.style.display = 'none';
    erro.style.display = 'none';
    banner.innerHTML = '';
    if (btn) btn.disabled = true;

    try {
      const dataCorte = document.getElementById('inadDataCorte')?.value || hojeLocalIso();
      const competencia = document.getElementById('inadCompetencia')?.value || '';
      const qs = new URLSearchParams({ data_corte: dataCorte, escopo: 'all' });
      if (competencia) qs.set('competencia', competencia);
      const dados = await core().fetchRelatorioAutenticado(`/api/inadimplencia?${qs.toString()}`);
      if (Array.isArray(dados?.titulos)) {
        dados.titulos.forEach(t => {
          t.executivo = normalizarExecutivoInad(t.executivo);
          t.filial = formatarFilialInad(t.codFilial, t.filial);
          t.codFilial = extrairCodFilialInad(t.codFilial, t.filial) || t.filial;
        });
      }
      inadPayload = dados;
      inadCarregado = true;

      if (!dados.disponivel) {
        banner.innerHTML = `
          <div class="report-status-banner is-warning">
            <i class="ph ph-lock-key"></i>
            <div>
              <strong>Protheus SE1010 pendente de permissão para leitura automática:</strong>
              <p>${esc(dados.motivo || 'Tabela stage_protheus.se1010 sem SELECT para leitura_bi.')}</p>
              <p><strong>Ação DBA/TI:</strong> <code>${esc(dados.sqlLiberacao || 'GRANT SELECT ON stage_protheus.se1010 TO leitura_bi;')}</code></p>
              <p>Enquanto a TI libera a tabela no DW, você já pode clicar em <strong>Importar Planilha (.xlsx)</strong> no topo para visualizar os gráficos, filtrar por Filial/Executivo/Margem e exportar o Excel.</p>
            </div>
          </div>`;
        return;
      }

      preencherFiltroFiliaisInad(dados.titulos || []);
      preencherSelectExecutivoInad(dados.titulos || []);

      const corteEl = document.getElementById('inadDataCorte');
      if (dados.posicao === 'fechamento' && dados.dataCorte) {
        if (corteEl) {
          corteEl.value = String(dados.dataCorte).slice(0, 10);
          corteEl.disabled = true;
        }
        banner.innerHTML = `<div class="report-status-banner is-info">
          <i class="ph ph-lock-simple"></i><div>
          <strong>Fechamento congelado · competência ${esc(dados.competencia || '')}</strong>
          <p>Posição de ${core().formatarDataBr(dados.dataCorte)} capturada em ${esc(dados.geradoEm ? new Date(dados.geradoEm).toLocaleString('pt-BR') : '')} · regras v${esc(dados.regrasVersao || '')}.</p>
          <p>Este valor não muda com novos recebimentos. Para ver a carteira de hoje, selecione “Saldo atual”.</p>
          </div></div>`;
      } else {
        if (corteEl) corteEl.disabled = false;
        const impacto = Array.isArray(dados.impactoRegras) ? dados.impactoRegras : [];
        const rotulos = {
          natureza_faturamento: 'naturezas fora do relatório',
          janela_365: 'vencidos há mais de 365 dias',
          ra_adt: 'RA/ADT e NCC',
          mutuos: 'mútuos',
          intercompany: 'intercompany',
          venda_ativos: 'venda de ativos',
          petrobras_seguro: 'seguro Petrobras'
        };
        const detalheImpacto = impacto.length
          ? impacto.map(i => `${rotulos[i.motivo] || i.motivo}: ${fmtInt(i.qtd)} títulos · ${fmtMoedaExata(i.saldo)}`).join(' | ')
          : 'nenhuma exclusão aplicada';
        const at = dados.atualizacao || {};
        const partesAtualizacao = [];
        if (at.protheusUltimaEmissao) partesAtualizacao.push(`emissões até ${core().formatarDataBr(at.protheusUltimaEmissao)}`);
        if (at.protheusUltimaBaixa) partesAtualizacao.push(`baixas até ${core().formatarDataBr(at.protheusUltimaBaixa)}`);
        if (at.protheusUltimaCarga) partesAtualizacao.push(`carga DW ${new Date(at.protheusUltimaCarga).toLocaleString('pt-BR')}`);
        const resumoReplica = partesAtualizacao.length
          ? `Protheus SE1 (${partesAtualizacao.join(' · ')}) · `
          : '';
        banner.innerHTML = `<div class="report-status-banner is-info">
          <i class="ph ph-info"></i><div>
          <strong>Saldo atual do Protheus</strong>
          <p>${esc(dados.observacao || '')}</p>
          <p><strong>Excluídos pelas regras (v${esc(dados.regrasVersao || '')}):</strong> ${esc(detalheImpacto)}</p>
          <p>${esc(resumoReplica)}Consulta: ${esc(dados.consultadoEm ? new Date(dados.consultadoEm).toLocaleString('pt-BR') : 'agora')}.</p>
          </div></div>`;
      }

      renderizarInadimplencia();
      conteudo.style.display = 'block';
      const atInad = dados.atualizacao || {};
      const fonteInad = dados.posicao === 'fechamento'
        ? `Fechamento congelado ${dados.competencia || ''} (corte ${core().formatarDataBr(dados.dataCorte)})`
        : [
            atInad.protheusUltimaEmissao ? `Protheus SE1 emissões até ${core().formatarDataBr(atInad.protheusUltimaEmissao)}` : 'Protheus SE1',
            atInad.protheusUltimaBaixa ? `baixas até ${core().formatarDataBr(atInad.protheusUltimaBaixa)}` : '',
            atInad.protheusUltimaCarga ? `carga DW ${new Date(atInad.protheusUltimaCarga).toLocaleString('pt-BR')}` : ''
          ].filter(Boolean).join(' · ');
      core().registrarAtualizacaoTela?.('relatorios:inadimplencia', {
        updatedAt: dados.consultadoEm || Date.now(),
        sourceInfo: fonteInad,
        autoRefresh: dados.posicao !== 'fechamento'
      });
    } catch (ex) {
      erro.innerHTML = `<i class="ph ph-warning-circle"></i><span>${esc(ex.message || 'Não foi possível consultar a inadimplência.')}</span>`;
      erro.style.display = 'flex';
    } finally {
      loading.style.display = 'none';
      if (btn) btn.disabled = false;
    }
  }

  function obterTitulosInadFiltrados() {
    const todos = inadPayload?.titulos || [];
    const dataCorte = document.getElementById('inadDataCorte')?.value || hojeLocalIso();
    const exec = document.getElementById('inadFiltroExecutivo')?.value || '';
    const margem = document.getElementById('inadFiltroMargem')?.value || 'TODAS';
    const busca = String(document.getElementById('inadFiltroBusca')?.value || '').trim().toLowerCase();
    const temFiltroFilial = inadFiliaisSelecionadas.size > 0 && inadFiliaisSelecionadas.size < inadFiliaisCatalogo.length;

    return todos.filter(t => {
      // Retenções são deduções: não descartar saldos negativos do consolidado.
      if (!Number.isFinite(Number(t.saldoInadimplente)) || Number(t.saldoInadimplente) === 0) return false;
      if (dataCorte && t.vencimentoReal && t.vencimentoReal > dataCorte) return false;
      const faixa = document.getElementById('inadFaixaAtraso')?.value || '365';
      const dias = t.vencimentoReal
        ? Math.round((Date.parse(`${dataCorte}T00:00:00Z`) - Date.parse(`${t.vencimentoReal}T00:00:00Z`)) / 86400000)
        : NaN;
      if (faixa !== 'todos' && !Number.isFinite(dias)) return false;
      if (faixa === '365' && (dias < 0 || dias >= 365)) return false;
      if (faixa === 'antigos' && dias < 365) return false;
      if (temFiltroFilial) {
        const keyFil = extrairCodFilialInad(t.codFilial, t.filial) || formatarFilialInad(t.codFilial, t.filial);
        if (!inadFiliaisSelecionadas.has(keyFil)) return false;
      }
      const execNorm = normalizarExecutivoInad(t.executivo);
      if (exec && execNorm !== exec) return false;
      if (margem && margem !== 'TODAS' && t.margem !== margem) return false;
      if (busca) {
        const texto = `${t.cliente} ${t.codCliente} ${execNorm} ${t.contrato} ${t.titulo} ${t.filial}`.toLowerCase();
        if (!texto.includes(busca)) return false;
      }
      return true;
    });
  }

  function consolidarInadPorExecutivo(titulos) {
    const totalGeral = titulos.reduce((acc, t) => acc + Number(t.saldoInadimplente || 0), 0);
    const map = new Map();
    for (const t of titulos) {
      const exec = normalizarExecutivoInad(t.executivo);
      if (!map.has(exec)) {
        map.set(exec, { executivo: exec, margemA: 0, margemB: 0, margemC: 0, outrasMargens: 0, saldoTotal: 0, qtdTitulos: 0 });
      }
      const r = map.get(exec);
      const s = Number(t.saldoInadimplente || 0);
      if (t.margem === 'A') r.margemA += s;
      else if (t.margem === 'B') r.margemB += s;
      else if (t.margem === 'C') r.margemC += s;
      else r.outrasMargens += s;
      r.saldoTotal += s;
      r.qtdTitulos += 1;
    }
    return Array.from(map.values())
      .map(r => ({ ...r, pctTotal: totalGeral !== 0 ? (r.saldoTotal / totalGeral) * 100 : 0 }))
      .sort((a, b) => {
        if (a.executivo === 'Outros') return 1;
        if (b.executivo === 'Outros') return -1;
        return b.saldoTotal - a.saldoTotal;
      });
  }

  function renderizarInadimplencia() {
    if (!inadPayload) return;
    const filtrados = obterTitulosInadFiltrados();
    const resumoExec = consolidarInadPorExecutivo(filtrados);

    const totalSaldo = filtrados.reduce((acc, t) => acc + Number(t.saldoInadimplente || 0), 0);
    const totalA = filtrados.filter(t => t.margem === 'A').reduce((acc, t) => acc + Number(t.saldoInadimplente || 0), 0);
    const totalB = filtrados.filter(t => t.margem === 'B').reduce((acc, t) => acc + Number(t.saldoInadimplente || 0), 0);
    const totalC = filtrados.filter(t => t.margem === 'C').reduce((acc, t) => acc + Number(t.saldoInadimplente || 0), 0);
    const clientesUnicos = new Set(filtrados.map(t => `${t.codCliente}|${t.cliente}`)).size;

    const pct = (v) => totalSaldo !== 0 ? `${((v / totalSaldo) * 100).toFixed(1).replace('.', ',')}% do saldo` : '0,0%';
    document.getElementById('inadKpiGrid').innerHTML = `
      <article class="report-kpi-card kpi-danger">
        <span class="report-kpi-label">Saldo líquido atual</span>
        <strong class="report-kpi-value">${fmtMoedaExata(totalSaldo)}</strong>
        <span class="report-kpi-sub">${fmtInt(filtrados.length)} títulos · ${fmtInt(clientesUnicos)} clientes</span>
      </article>
      <article class="report-kpi-card kpi-blue">
        <span class="report-kpi-label">Margem A (D2_YMARGCT)</span>
        <strong class="report-kpi-value">${fmtMoedaExata(totalA)}</strong>
        <span class="report-kpi-sub">${pct(totalA)}</span>
      </article>
      <article class="report-kpi-card kpi-gold">
        <span class="report-kpi-label">Margem B (D2_YMARGCT)</span>
        <strong class="report-kpi-value">${fmtMoedaExata(totalB)}</strong>
        <span class="report-kpi-sub">${pct(totalB)}</span>
      </article>
      <article class="report-kpi-card kpi-green">
        <span class="report-kpi-label">Margem C (D2_YMARGCT)</span>
        <strong class="report-kpi-value">${fmtMoedaExata(totalC)}</strong>
        <span class="report-kpi-sub">${pct(totalC)}</span>
      </article>
    `;

    // Grafico 1: Executivo x Margem A/B/C
    renderInadChart('chartInadExecutivoMargem', {
      type: 'bar',
      data: {
        labels: resumoExec.map(r => r.executivo),
        datasets: [
          { label: 'Margem A', data: resumoExec.map(r => r.margemA), backgroundColor: '#1b6fa8', borderRadius: 4 },
          { label: 'Margem B', data: resumoExec.map(r => r.margemB), backgroundColor: '#c8952e', borderRadius: 4 },
          { label: 'Margem C', data: resumoExec.map(r => r.margemC), backgroundColor: '#228b5b', borderRadius: 4 },
          { label: 'Outras', data: resumoExec.map(r => r.outrasMargens), backgroundColor: '#8fa0b2', borderRadius: 4 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (_evt, elems) => {
          if (!elems?.length) return;
          const exec = resumoExec[elems[0].index]?.executivo || '';
          const sel = document.getElementById('inadFiltroExecutivo');
          if (sel) {
            sel.value = sel.value === exec ? '' : exec;
            renderizarInadimplencia();
          }
        },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtMoedaExata(ctx.parsed.y)}` } }
        },
        scales: {
          x: { stacked: true, ticks: { font: { size: 10 } } },
          y: { stacked: true, ticks: { callback: v => core().formatarMoeda(v) } }
        }
      }
    });

    // Grafico 2: Top 10 Clientes
    const cliMap = new Map();
    for (const t of filtrados) {
      const nome = t.cliente || 'Não informado';
      cliMap.set(nome, (cliMap.get(nome) || 0) + Number(t.saldoInadimplente || 0));
    }
    const topCli = Array.from(cliMap.entries())
      .map(([cliente, saldo]) => ({ cliente, saldo }))
      .sort((a, b) => b.saldo - a.saldo)
      .slice(0, 10);

    renderInadChart('chartInadTopClientes', {
      type: 'bar',
      data: {
        labels: topCli.map(c => c.cliente.length > 28 ? `${c.cliente.slice(0, 26)}…` : c.cliente),
        datasets: [{ label: 'Saldo Inadimplente', data: topCli.map(c => c.saldo), backgroundColor: '#c93b3b', borderRadius: 5 }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => fmtMoedaExata(ctx.parsed.x) } }
        },
        scales: { x: { ticks: { callback: v => core().formatarMoeda(v) } } }
      }
    });

    // Tabela Resumo Executivo x Margem
    document.getElementById('inadResumoFonteTag').textContent = inadPayload.fonte || 'Protheus SE1010';
    document.getElementById('tbodyInadResumoExecutivo').innerHTML = resumoExec.length
      ? resumoExec.map(r => `
          <tr class="is-clickable" data-inad-exec="${esc(r.executivo)}" title="Clique para filtrar por este executivo">
            <td><strong>${esc(r.executivo)}</strong></td>
            <td class="num">${fmtMoedaExata(r.margemA)}</td>
            <td class="num">${fmtMoedaExata(r.margemB)}</td>
            <td class="num">${fmtMoedaExata(r.margemC)}</td>
            <td class="num">${fmtMoedaExata(r.outrasMargens)}</td>
            <td class="num"><strong>${fmtMoedaExata(r.saldoTotal)}</strong></td>
            <td class="num"><span class="metric-pill is-neutral">${r.pctTotal.toFixed(1).replace('.', ',')}%</span></td>
            <td class="num">${fmtInt(r.qtdTitulos)}</td>
          </tr>`).join('')
      : '<tr><td colspan="8" class="contracts-empty">Nenhum registro para os filtros aplicados.</td></tr>';

    document.querySelectorAll('#tbodyInadResumoExecutivo tr[data-inad-exec]').forEach(tr => {
      tr.addEventListener('click', () => {
        const exec = tr.dataset.inadExec || '';
        const sel = document.getElementById('inadFiltroExecutivo');
        if (sel) {
          sel.value = sel.value === exec ? '' : exec;
          renderizarInadimplencia();
        }
      });
    });

    const tfootInad = document.getElementById('tfootInadResumoExecutivo');
    if (tfootInad) {
      if (resumoExec.length) {
        const tot = resumoExec.reduce((acc, r) => {
          acc.margemA += r.margemA;
          acc.margemB += r.margemB;
          acc.margemC += r.margemC;
          acc.outras += r.outrasMargens;
          acc.saldo += r.saldoTotal;
          acc.qtd += r.qtdTitulos;
          return acc;
        }, { margemA: 0, margemB: 0, margemC: 0, outras: 0, saldo: 0, qtd: 0 });
        tfootInad.innerHTML = `
          <tr class="table-total-row">
            <td><strong>Total</strong></td>
            <td class="num"><strong>${fmtMoedaExata(tot.margemA)}</strong></td>
            <td class="num"><strong>${fmtMoedaExata(tot.margemB)}</strong></td>
            <td class="num"><strong>${fmtMoedaExata(tot.margemC)}</strong></td>
            <td class="num"><strong>${fmtMoedaExata(tot.outras)}</strong></td>
            <td class="num"><strong>${fmtMoedaExata(tot.saldo)}</strong></td>
            <td class="num"><span class="metric-pill is-neutral">100,0%</span></td>
            <td class="num"><strong>${fmtInt(tot.qtd)}</strong></td>
          </tr>`;
      } else {
        tfootInad.innerHTML = '';
      }
    }

    // Tabela Analitico (13 colunas do modelo Excel)
    document.getElementById('inadAnaliticoCountTag').textContent = filtrados.length > 300
      ? `Exibindo 300 de ${fmtInt(filtrados.length)} registros · Excel completo`
      : `${fmtInt(filtrados.length)} registros`;
    document.getElementById('tbodyInadAnalitico').innerHTML = filtrados.length
      ? filtrados.slice(0, 300).map(t => `
          <tr>
            <td><small class="text-muted">${esc(t.origem)}</small></td>
            <td><strong>${esc(t.executivo)}</strong></td>
            <td>${esc(t.codCliente)}</td>
            <td>${esc(t.cliente)}</td>
            <td><span class="metric-pill ${t.margem === 'A' ? 'is-pos' : t.margem === 'B' ? 'is-neutral' : ''}">${esc(t.margem)}</span></td>
            <td>${esc(t.contrato || '—')}</td>
            <td>${esc(t.filial || '—')}</td>
            <td>${esc(t.serie || '—')}</td>
            <td><strong>${esc(t.titulo || '—')}</strong><br><small>${esc(t.tipo || '')}${t.parcela ? ` · Parc. ${esc(t.parcela)}` : ''}${t.loja ? ` · Loja ${esc(t.loja)}` : ''}</small></td>
            <td class="num">${fmtMoedaExata(t.valorOriginal)}</td>
            <td class="num"><strong>${fmtMoedaExata(t.saldoInadimplente)}</strong></td>
            <td>${t.emissao ? core().formatarDataBr(t.emissao) : '—'}</td>
            <td>${t.vencimentoReal ? core().formatarDataBr(t.vencimentoReal) : '—'}</td>
          </tr>`).join('')
      : '<tr><td colspan="13" class="contracts-empty">Nenhum título encontrado para os filtros aplicados.</td></tr>';
  }

  function exportarInadimplenciaXlsx() {
    const filtrados = obterTitulosInadFiltrados();
    if (!filtrados.length) {
      core().showToast('Nenhum título de inadimplência carregado para exportar.', 'warning');
      return;
    }
    if (!window.XLSX) {
      core().showToast('Biblioteca Excel (SheetJS) não disponível.', 'error');
      return;
    }

    const XLSX = window.XLSX;
    const totalSaldo = filtrados.reduce((acc, t) => acc + Number(t.saldoInadimplente || 0), 0);
    const totalOrig = filtrados.reduce((acc, t) => acc + Number(t.valorOriginal || 0), 0);
    const lastRow = 3 + filtrados.length;

    // Aba 1: 1. INADIMPLENCIA (13 colunas identicas ao modelo)
    const aoa1 = [
      ['GRUPO CORDEIRO | INADIMPLÊNCIA COMERCIAL — EXECUTIVO, CLIENTE, MARGEM E VALOR'],
      [
        `Fonte: ${inadPayload?.fonte || 'Protheus SE1010 + DW'} • ${filtrados.length} títulos`,
        null, null, null, null, null, null, null, null,
        'TOTAL SALDO INADIMPLENTE:',
        { t: 'n', f: `SUBTOTAL(9,K4:K${lastRow})`, v: totalSaldo },
        { t: 'n', f: `SUBTOTAL(9,J4:J${lastRow})`, v: totalOrig },
        null
      ],
      [
        'Origem', 'Executivo Responsável (NF/Título)', 'Cód. Cliente', 'Cliente (Razão Social / Nome)',
        'Margem (D2_YMARGCT)', 'Nº Contrato', 'Filial', 'Série/Pref.', 'Nº Título / NF',
        'Valor Original Título (R$)', 'Saldo Inadimplente (R$)', 'Emissão', 'Vencimento Real',
        'Parcela', 'Tipo', 'Loja', 'Natureza'
      ],
      ...filtrados.map(t => [
        t.origem || 'PROTHEUS (SE1010)',
        normalizarExecutivoInad(t.executivo),
        t.codCliente || '',
        t.cliente || '',
        t.margem || '',
        t.contrato || '',
        t.filial || '',
        t.serie || '',
        t.titulo || '',
        Number(t.valorOriginal || 0),
        Number(t.saldoInadimplente || 0),
        t.emissao ? core().formatarDataBr(t.emissao) : '',
        t.vencimentoReal ? core().formatarDataBr(t.vencimentoReal) : '',
        t.parcela || '', t.tipo || '', t.loja || '', t.natureza || ''
      ])
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(aoa1);
    ws1['!cols'] = [
      { wch: 20 }, { wch: 28 }, { wch: 12 }, { wch: 36 }, { wch: 18 }, { wch: 14 },
      { wch: 26 }, { wch: 12 }, { wch: 15 }, { wch: 20 }, { wch: 20 }, { wch: 13 }, { wch: 14 }
    ];

    // Aba 2: 2. RESUMO EXECUTIVO E MARGEM
    const resumoExec = consolidarInadPorExecutivo(filtrados);
    const resumoLastRow = 4 + resumoExec.length;
    const totalRowIdx = resumoLastRow + 1;
    const aoa2 = [
      [`RESUMO CONSOLIDADO POR EXECUTIVO E MARGEM — INADIMPLÊNCIA (R$ ${totalSaldo.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`],
      [],
      ['CONSOLIDADO POR EXECUTIVO E MARGEM DO CONTRATO (D2_YMARGCT — CALCULADO POR FÓRMULAS DA ABA 1)'],
      ['Executivo (Atribuído pela NF)', 'Margem A (R$)', 'Margem B (R$)', 'Margem C (R$)', 'Outras / Sem Margem (R$)', 'Saldo Total (R$)', '% do Total', 'Qtd Títulos'],
      ...resumoExec.map((r, idx) => {
        const rowNum = 5 + idx;
        return [
          r.executivo,
          { t: 'n', f: `SUMIFS('1. INADIMPLENCIA'!$K$4:$K$${lastRow},'1. INADIMPLENCIA'!$B$4:$B$${lastRow},$A${rowNum},'1. INADIMPLENCIA'!$E$4:$E$${lastRow},"A")`, v: r.margemA },
          { t: 'n', f: `SUMIFS('1. INADIMPLENCIA'!$K$4:$K$${lastRow},'1. INADIMPLENCIA'!$B$4:$B$${lastRow},$A${rowNum},'1. INADIMPLENCIA'!$E$4:$E$${lastRow},"B")`, v: r.margemB },
          { t: 'n', f: `SUMIFS('1. INADIMPLENCIA'!$K$4:$K$${lastRow},'1. INADIMPLENCIA'!$B$4:$B$${lastRow},$A${rowNum},'1. INADIMPLENCIA'!$E$4:$E$${lastRow},"C")`, v: r.margemC },
          { t: 'n', f: `SUMIFS('1. INADIMPLENCIA'!$K$4:$K$${lastRow},'1. INADIMPLENCIA'!$B$4:$B$${lastRow},$A${rowNum})-SUM(B${rowNum}:D${rowNum})`, v: r.outrasMargens },
          { t: 'n', f: `SUM(B${rowNum}:E${rowNum})`, v: r.saldoTotal },
          { t: 'n', f: `F${rowNum}/$F$${totalRowIdx}`, v: totalSaldo ? (r.saldoTotal / totalSaldo) : 0 },
          { t: 'n', f: `COUNTIF('1. INADIMPLENCIA'!$B$4:$B$${lastRow},$A${rowNum})`, v: r.qtdTitulos }
        ];
      }),
      [
        'TOTAL GERAL',
        { t: 'n', f: `SUM(B5:B${resumoLastRow})`, v: resumoExec.reduce((a, r) => a + r.margemA, 0) },
        { t: 'n', f: `SUM(C5:C${resumoLastRow})`, v: resumoExec.reduce((a, r) => a + r.margemB, 0) },
        { t: 'n', f: `SUM(D5:D${resumoLastRow})`, v: resumoExec.reduce((a, r) => a + r.margemC, 0) },
        { t: 'n', f: `SUM(E5:E${resumoLastRow})`, v: resumoExec.reduce((a, r) => a + r.outrasMargens, 0) },
        { t: 'n', f: `SUM(F5:F${resumoLastRow})`, v: totalSaldo },
        { t: 'n', v: 1 },
        { t: 'n', f: `SUM(H5:H${resumoLastRow})`, v: filtrados.length }
      ]
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(aoa2);
    ws2['!cols'] = [
      { wch: 32 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 22 }, { wch: 14 }, { wch: 14 }
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, '1. INADIMPLENCIA');
    XLSX.utils.book_append_sheet(wb, ws2, '2. RESUMO EXECUTIVO E MARGEM');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Fonte', inadPayload?.fonte || 'Protheus'],
      ['Posição', inadPayload?.posicao || 'Planilha importada'],
      ['Consultado em', inadPayload?.consultadoEm || ''],
      ['Vencimentos até', document.getElementById('inadDataCorte')?.value || ''],
      ['Competência', inadPayload?.competencia || 'Saldo atual'],
      ['Regras (versão)', inadPayload?.regrasVersao || ''],
      ['Faixa', document.getElementById('inadFaixaAtraso')?.selectedOptions[0]?.textContent || ''],
      ['Metodologia', inadPayload?.observacao || ''],
      ['Conciliação', inadPayload?.conciliacao || 'Não informada']
    ]), '3. METODOLOGIA');
    const dataTag = document.getElementById('inadDataCorte')?.value || hojeLocalIso();
    XLSX.writeFile(wb, `Inadimplencia_Executivo_Cliente_Margem_${dataTag}.xlsx`);
  }

  async function carregarPosicoesInad() {
    const sel = document.getElementById('inadCompetencia');
    if (!sel) return;
    try {
      const dados = await core().fetchRelatorioAutenticado('/api/inadimplencia-fechamento');
      const atual = sel.value;
      const lista = Array.isArray(dados.fechamentos) ? dados.fechamentos : [];
      sel.innerHTML = '<option value="">Saldo atual (Protheus)</option>' + lista.map(f => {
        const [ano, mes] = String(f.competencia).split('-');
        const rotulo = `${MESES_PT[Number(mes) - 1]} / ${ano}`;
        return `<option value="${esc(f.competencia)}">Fechamento ${esc(rotulo)}</option>`;
      }).join('');
      if (lista.some(f => f.competencia === atual)) sel.value = atual;
      if (!lista.length && !dados.disponivel) {
        sel.title = 'Nenhum fechamento publicado. Falta habilitar as tabelas no DW.';
      }
    } catch (_) {
      // Lista é opcional: o relatório ao vivo continua funcionando.
    }
  }

  async function fecharCompetenciaInad() {
    const btn = document.getElementById('btnFecharCompetencia');
    const hoje = hojeLocalIso();
    const [ano, mes] = hoje.split('-').map(Number);
    const anterior = new Date(Date.UTC(ano, mes - 2, 1));
    const competencia = anterior.toISOString().slice(0, 7);
    const [anoComp, mesComp] = competencia.split('-');
    const rotulo = `${MESES_PT[Number(mesComp) - 1]} / ${anoComp}`;

    if (!window.confirm(`Fechar a competência ${rotulo}?\n\nO saldo atual da SE1 será congelado título a título. Esta ação não recalcula meses anteriores.`)) {
      return;
    }

    if (btn) btn.disabled = true;
    try {
      const dados = await core().enviarRelatorioAutenticado('/api/inadimplencia-fechamento', { competencia });
      core().showToast(`Competência ${rotulo} fechada: ${fmtInt(dados.fechamento.qtdTitulos)} títulos · ${fmtMoedaExata(dados.fechamento.saldoTotal)}.`, 'success');
      await carregarPosicoesInad();
      const sel = document.getElementById('inadCompetencia');
      if (sel) sel.value = competencia;
      inadCarregado = false;
      await carregarInadimplencia(true);
    } catch (ex) {
      const detalhe = ex?.detalhe;
      if (detalhe?.sqlLiberacao) {
        core().showToast('Fechamento indisponível: falta criar as tabelas no DW. O comando está no parecer técnico.', 'warning');
        console.warn('SQL de liberação do fechamento:\n' + detalhe.sqlLiberacao);
      } else {
        core().showToast(ex.message || 'Não foi possível fechar a competência.', 'error');
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------
  // Prévia de Faturamento (SD2 + regras da premiação)
  // ------------------------------------------------------------------
  let fatSd2Payload = null;
  let fatSd2Detalhe = [];
  let fatSd2Carregado = false;
  let fatSd2Binded = false;

  function mesesFatSd2(qtd = 24) {
    const hoje = new Date();
    const lista = [];
    for (let i = 0; i < qtd; i += 1) {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const ultimo = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      lista.push({
        iso,
        inicio: `${iso}-01`,
        fim: `${iso}-${String(ultimo).padStart(2, '0')}`,
        rotulo: `${MESES_PT[d.getMonth()]} / ${d.getFullYear()}`
      });
    }
    return lista;
  }

  function montarPeriodosFatSd2() {
    const sel = document.getElementById('fatSd2Periodo');
    if (!sel || sel.options.length) return;
    sel.innerHTML =
      mesesFatSd2(24).map(m => `<option value="${m.iso}">${esc(m.rotulo)}</option>`).join('') +
      '<option value="personalizado">Personalizado…</option>';
    const atual = hojeLocalIso().slice(0, 7);
    sel.value = [...sel.options].some(o => o.value === atual) ? atual : sel.options[0].value;
  }

  function alternarPeriodoPersonalizadoFatSd2() {
    const sel = document.getElementById('fatSd2Periodo');
    const personalizado = sel?.value === 'personalizado';
    const de = document.getElementById('fatSd2DeWrap');
    const ate = document.getElementById('fatSd2AteWrap');
    if (de) de.style.display = personalizado ? '' : 'none';
    if (ate) ate.style.display = personalizado ? '' : 'none';
    return personalizado;
  }

  function obterPeriodoFatSd2() {
    const sel = document.getElementById('fatSd2Periodo');
    const valor = sel?.value || '';
    if (valor === 'personalizado') {
      return {
        startDate: document.getElementById('fatSd2Start')?.value || '',
        endDate: document.getElementById('fatSd2End')?.value || ''
      };
    }
    const item = mesesFatSd2(24).find(m => m.iso === valor);
    if (item) return { startDate: item.inicio, endDate: item.fim };
    const hoje = hojeLocalIso();
    return { startDate: `${hoje.slice(0, 7)}-01`, endDate: hoje };
  }

  function preencherSelectFatSd2(id, itens, rotuloTodos) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const atual = sel.value;
    sel.innerHTML = `<option value="">${esc(rotuloTodos)}</option>` +
      itens.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if (itens.includes(atual)) sel.value = atual;
  }

  async function carregarFaturamentoSd2(forcar = false) {
    if (fatSd2Carregado && !forcar) return;
    montarPeriodosFatSd2();

    const loading = document.getElementById('fatSd2Loading');
    const conteudo = document.getElementById('fatSd2Conteudo');
    const erro = document.getElementById('fatSd2Erro');
    const btn = document.getElementById('btnAtualizarFaturamentoSd2');

    const { startDate, endDate } = obterPeriodoFatSd2();
    const unidade = document.getElementById('fatSd2Unidade')?.value || '';
    const executivo = document.getElementById('fatSd2Executivo')?.value || '';

    if (!startDate || !endDate) {
      if (conteudo) conteudo.style.display = 'none';
      if (erro) {
        erro.innerHTML = '<i class="ph ph-info"></i><span>Selecione as duas datas do período personalizado.</span>';
        erro.style.display = 'flex';
      }
      return;
    }

    const qs = new URLSearchParams({ startDate, endDate });
    if (unidade) qs.set('unidade', unidade);
    if (executivo) qs.set('executivo', executivo);

    if (loading) loading.style.display = 'flex';
    if (erro) erro.style.display = 'none';
    if (btn) btn.disabled = true;

    try {
      const qsDetalhe = new URLSearchParams(qs);
      qsDetalhe.set('detalhe', '1');
      const [dados, detalhe] = await Promise.all([
        core().fetchRelatorioAutenticado(`/api/faturamento-sd2?${qs.toString()}`),
        core().fetchRelatorioAutenticado(`/api/faturamento-sd2?${qsDetalhe.toString()}`)
      ]);
      fatSd2Payload = dados;
      fatSd2Detalhe = detalhe?.linhas || [];
      fatSd2Carregado = true;
      preencherSelectFatSd2('fatSd2Unidade', dados.filtros?.unidades || [], 'Todas as unidades');
      preencherSelectFatSd2('fatSd2Executivo', dados.filtros?.executivos || [], 'Todos os executivos');
      renderizarFaturamentoSd2();
      if (conteudo) conteudo.style.display = 'block';
    } catch (ex) {
      fatSd2Carregado = false;
      if (conteudo) conteudo.style.display = 'none';
      if (erro) {
        erro.innerHTML = `<i class="ph ph-warning-circle"></i><span>${esc(ex.message || 'Não foi possível carregar a prévia de faturamento.')}</span>`;
        erro.style.display = 'flex';
      }
    } finally {
      if (loading) loading.style.display = 'none';
      if (btn) btn.disabled = false;
    }
  }

  function renderizarFaturamentoSd2() {
    const d = fatSd2Payload;
    if (!d) return;
    const res = d.resumo || {};

    const atualizado = document.getElementById('fatSd2Atualizado');
    const atSd2 = d.atualizacao || {};
    const dtEmisSd2 = atSd2.protheusUltimaEmissao ? core().formatarDataBr(atSd2.protheusUltimaEmissao) : '—';
    const dtCargaSd2 = atSd2.protheusUltimaCarga ? new Date(atSd2.protheusUltimaCarga).toLocaleString('pt-BR') : '';
    const dtConsSd2 = d.consultadoEm ? new Date(d.consultadoEm).toLocaleString('pt-BR') : 'agora';
    const textoSd2At = `Protheus SD2 · emissões até ${dtEmisSd2}${dtCargaSd2 ? ` (carga DW ${dtCargaSd2})` : ''}`;
    if (atualizado) {
      atualizado.textContent = `${textoSd2At} · consultado em ${dtConsSd2}`;
    }
    core().registrarAtualizacaoTela?.('relatorios:faturamento', {
      updatedAt: d.consultadoEm || Date.now(),
      sourceInfo: textoSd2At,
      autoRefresh: true
    });
    const fonte = document.getElementById('fatSd2Fonte');
    if (fonte) {
      fonte.textContent = `${d.fonte || 'stage_protheus.sd2010'} · regras v${d.regrasVersao || ''} · período ${core().formatarDataBr(d.periodo?.startDate)} a ${core().formatarDataBr(d.periodo?.endDate)}`;
    }

    document.getElementById('fatSd2KpiComercial').textContent = fmtMoeda(res.comercial);
    document.getElementById('fatSd2KpiTicket').textContent = `Ticket médio/NF: ${fmtMoeda(res.ticketMedioNf)}`;
    document.getElementById('fatSd2KpiExpurgos').textContent = fmtMoeda(res.expurgos);
    document.getElementById('fatSd2KpiExpurgosNota').textContent = `Fora do escopo de receita: ${fmtMoeda(res.foraEscopo)}`;
    document.getElementById('fatSd2KpiVolume').textContent = `${fmtInt(res.qtdNfs)} NFs`;
    document.getElementById('fatSd2KpiClientes').textContent = `${fmtInt(res.qtdClientes)} clientes · ${fmtInt(res.qtdItens)} itens`;

    const tag = document.getElementById('fatSd2ConciliacaoTag');
    if (tag) tag.textContent = `Regras v${d.regrasVersao || ''}`;

    const linhas = [
      ['Faturamento SD2 bruto (todas as linhas do período)', res.bruto, ''],
      ['(−) Fora do escopo de receita (TES/CFOP)', -Math.abs(res.foraEscopo || 0), ''],
      ['(=) Receita comercial (TES/CFOP homologados)', res.receita, 'total'],
      ...(d.expurgos || [])
        .filter(e => e.motivo !== 'fora_escopo')
        .map(e => [`(−) ${e.rotulo}`, -Math.abs(e.valor || 0), '']),
      ['(=) Faturamento comercial da prévia', res.comercial, 'total']
    ];

    document.getElementById('tbodyFatSd2Conciliacao').innerHTML = linhas.map(([rotulo, valor, tipo]) => `
      <tr${tipo === 'total' ? ' style="font-weight:600;"' : ''}>
        <td>${esc(rotulo)}</td>
        <td class="num">${fmtMoedaExata(valor)}</td>
      </tr>`).join('');

    document.getElementById('tbodyFatSd2Unidades').innerHTML = (d.porUnidade || [])
      .filter(u => Math.abs(u.comercial) > 0.004)
      .map(u => `<tr><td>${esc(u.unidade)}</td><td class="num">${fmtMoedaExata(u.comercial)}</td><td class="num">${fmtInt(u.qtdNfs)}</td></tr>`)
      .join('') || '<tr><td colspan="3">Sem faturamento no recorte.</td></tr>';

    document.getElementById('tbodyFatSd2Executivos').innerHTML = (d.porExecutivo || [])
      .filter(e => Math.abs(e.comercial) > 0.004)
      .slice(0, 15)
      .map(e => `<tr><td>${esc(e.executivo)}</td><td class="num">${fmtMoedaExata(e.comercial)}</td><td class="num">${fmtInt(e.qtdNfs)}</td></tr>`)
      .join('') || '<tr><td colspan="3">Sem faturamento no recorte.</td></tr>';

    renderizarEstratificacaoFatSd2();

    renderMonthlyComparisonBars('fatSd2Mensal', (d.mensal || []).map(m => ({
      mes: m.mesIso,
      comercial: m.comercial,
      bruto: m.bruto,
      fechado: true
    })), {
      valKey: 'comercial',
      metaKey: '',
      closedKey: 'fechado',
      onClick: mesIso => {
        const sel = document.getElementById('fatSd2Periodo');
        if (sel && [...sel.options].some(o => o.value === mesIso)) {
          sel.value = mesIso;
          alternarPeriodoPersonalizadoFatSd2();
          carregarFaturamentoSd2(true);
          return;
        }
        const [yy, mm] = mesIso.split('-').map(Number);
        const ultimoDia = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
        const ini = document.getElementById('fatSd2Start');
        const fim = document.getElementById('fatSd2End');
        if (sel) sel.value = 'personalizado';
        alternarPeriodoPersonalizadoFatSd2();
        if (ini && fim) {
          ini.value = `${mesIso}-01`;
          fim.value = `${mesIso}-${String(ultimoDia).padStart(2, '0')}`;
          carregarFaturamentoSd2(true);
        }
      }
    });
  }

  function renderizarEstratificacaoFatSd2() {
    const linhas = (fatSd2Detalhe || []).filter(l => l.isReceita && !l.motivo);
    const clientes = new Map();
    const contratos = new Map();
    const nfs = new Map();

    const criarAcumulador = () => ({
      valor: 0,
      itens: 0,
      nfs: new Set(),
      contratos: new Set(),
      unidades: new Set(),
      executivos: new Set()
    });

    for (const l of linhas) {
      const codCliente = String(l.codCliente || '').trim();
      const loja = String(l.loja || '').trim();
      const cliente = l.cliente || `Cliente ${codCliente}${loja ? `/${loja}` : ''}`;
      const contrato = String(l.numeroContrato || '').trim() || 'Sem contrato';
      const chaveNf = `${l.codFilial}|${l.numeroDocumento}|${l.serie}`;
      const chaveCliente = `${codCliente}|${loja}`;
      const chaveContrato = `${chaveCliente}|${contrato}`;
      const valor = Number(l.valor || 0);

      if (!clientes.has(chaveCliente)) {
        clientes.set(chaveCliente, { ...criarAcumulador(), codCliente, loja, cliente });
      }
      const cli = clientes.get(chaveCliente);
      cli.valor += valor;
      cli.itens += 1;
      cli.nfs.add(chaveNf);
      cli.contratos.add(contrato);

      if (!contratos.has(chaveContrato)) {
        contratos.set(chaveContrato, {
          ...criarAcumulador(),
          codCliente,
          loja,
          cliente,
          contrato
        });
      }
      const ctr = contratos.get(chaveContrato);
      ctr.valor += valor;
      ctr.itens += 1;
      ctr.nfs.add(chaveNf);
      if (l.unidade) ctr.unidades.add(l.unidade);
      if (l.executivo) ctr.executivos.add(l.executivo);

      if (!nfs.has(chaveNf)) {
        nfs.set(chaveNf, {
          ...criarAcumulador(),
          filial: l.codFilial || '',
          nf: l.numeroDocumento || '',
          serie: l.serie || '',
          emissao: l.emissao || '',
          cliente,
          contratos: new Set()
        });
      }
      const nf = nfs.get(chaveNf);
      nf.valor += valor;
      nf.itens += 1;
      nf.contratos.add(contrato);
      if (l.unidade) nf.unidades.add(l.unidade);
      if (l.executivo) nf.executivos.add(l.executivo);
    }

    const clientesLista = [...clientes.values()]
      .sort((a, b) => b.valor - a.valor || a.cliente.localeCompare(b.cliente, 'pt-BR'));
    const contratosLista = [...contratos.values()]
      .sort((a, b) => b.valor - a.valor || a.cliente.localeCompare(b.cliente, 'pt-BR'));
    const nfsLista = [...nfs.values()]
      .sort((a, b) => b.emissao.localeCompare(a.emissao) || b.valor - a.valor);

    document.getElementById('fatSd2ClientesTag').textContent = `${fmtInt(clientesLista.length)} clientes`;
    document.getElementById('fatSd2ContratosTag').textContent = `${fmtInt(contratosLista.length)} negócios`;
    document.getElementById('fatSd2NfsTag').textContent = `${fmtInt(nfsLista.length)} NFs`;

    document.getElementById('tbodyFatSd2Clientes').innerHTML = clientesLista.length
      ? clientesLista.map(c => `
          <tr>
            <td><strong>${esc(c.cliente)}</strong><br><small>${esc(c.codCliente)}${c.loja ? `/${esc(c.loja)}` : ''}</small></td>
            <td class="num">${fmtInt(c.contratos.size)}</td>
            <td class="num">${fmtInt(c.nfs.size)}</td>
            <td class="num"><strong>${fmtMoedaExata(c.valor)}</strong></td>
          </tr>`).join('')
      : '<tr><td colspan="4">Sem faturamento comercial no recorte.</td></tr>';

    document.getElementById('tbodyFatSd2Contratos').innerHTML = contratosLista.length
      ? contratosLista.map(c => `
          <tr>
            <td><strong>${esc(c.cliente)}</strong><br><small>${esc(c.codCliente)}${c.loja ? `/${esc(c.loja)}` : ''}</small></td>
            <td><strong>${esc(c.contrato)}</strong></td>
            <td>${esc([...c.unidades].join(' | ') || '—')}<br><small>${esc([...c.executivos].join(' | ') || '—')}</small></td>
            <td class="num">${fmtInt(c.nfs.size)}</td>
            <td class="num"><strong>${fmtMoedaExata(c.valor)}</strong></td>
          </tr>`).join('')
      : '<tr><td colspan="5">Sem contratos faturados no recorte.</td></tr>';

    document.getElementById('tbodyFatSd2Nfs').innerHTML = nfsLista.length
      ? nfsLista.map(n => `
          <tr>
            <td>${n.emissao ? core().formatarDataBr(n.emissao) : '—'}</td>
            <td><strong>${esc(n.nf)}</strong> / ${esc(n.serie || '—')}<br><small>Filial ${esc(n.filial)}</small></td>
            <td>${esc(n.cliente)}</td>
            <td>${esc([...n.contratos].join(' | '))}</td>
            <td>${esc([...n.unidades].join(' | ') || '—')}</td>
            <td>${esc([...n.executivos].join(' | ') || '—')}</td>
            <td class="num">${fmtInt(n.itens)}</td>
            <td class="num"><strong>${fmtMoedaExata(n.valor)}</strong></td>
          </tr>`).join('')
      : '<tr><td colspan="8">Sem notas fiscais no recorte.</td></tr>';
  }

  async function exportarBaseSd2Xlsx() {
    if (typeof window.XLSX === 'undefined') {
      core().showToast('Biblioteca de Excel não carregada. Recarregue a página.', 'error');
      return;
    }
    const btn = document.getElementById('btnExportarFaturamentoSd2Base');
    const { startDate, endDate } = obterPeriodoFatSd2();
    const unidade = document.getElementById('fatSd2Unidade')?.value || '';
    const executivo = document.getElementById('fatSd2Executivo')?.value || '';

    if (!startDate || !endDate) {
      core().showToast('Selecione as duas datas do período personalizado.', 'warning');
      return;
    }

    const qs = new URLSearchParams({ startDate, endDate, detalhe: '1' });
    if (unidade) qs.set('unidade', unidade);
    if (executivo) qs.set('executivo', executivo);

    if (btn) btn.disabled = true;
    try {
      const dados = await core().fetchRelatorioAutenticado(`/api/faturamento-sd2?${qs.toString()}`);
      const linhas = dados.linhas || [];

      const cabecalho = [
        'Filial', 'NF', 'Série', 'Item', 'Emissão', 'Cliente', 'Loja', 'Nome Cliente',
        'Produto', 'Descrição Produto', 'Qtd', 'Vlr. Unitário', 'Vlr. Total',
        'TES', 'CFOP', 'Pedido', 'Contrato', 'Centro Custo', 'Item Conta',
        'Margem Contrato', 'Unidade', 'Cód. Vendedor', 'Executivo',
        'Receita?', 'Motivo Expurgo'
      ];

      const aoa = [cabecalho];
      for (const l of linhas) {
        aoa.push([
          l.codFilial, l.numeroDocumento, l.serie, l.item, l.emissao,
          l.codCliente, l.loja, l.cliente, l.codProduto, l.produto,
          Number(l.quantidade || 0), Number(l.valorUnitario || 0), Number(l.valor || 0),
          l.tes, l.cfop, l.numeroPedido, l.numeroContrato, l.centroCusto, l.itemConta,
          l.margemContrato || '', l.unidade, l.codVendedor, l.executivo,
          l.isReceita ? 'SIM' : 'NÃO',
          !l.isReceita ? 'Fora do escopo TES/CFOP'
            : l.motivo === 'cm_maquinas' ? 'CM Máquinas'
            : l.motivo === 'central_adm' ? 'Central ADM'
              : l.motivo === 'fora_unidades' ? 'Fora das unidades comerciais'
              : l.motivo === 't_a_contrato' ? 'Locação T&A'
                : ''
        ]);
      }

      const wsBase = XLSX.utils.aoa_to_sheet(aoa);
      wsBase['!cols'] = [
        { wch: 8 }, { wch: 11 }, { wch: 6 }, { wch: 5 }, { wch: 11 },
        { wch: 10 }, { wch: 6 }, { wch: 34 }, { wch: 14 }, { wch: 34 },
        { wch: 10 }, { wch: 14 }, { wch: 15 }, { wch: 7 }, { wch: 8 },
        { wch: 10 }, { wch: 11 }, { wch: 12 }, { wch: 14 }, { wch: 10 },
        { wch: 14 }, { wch: 10 }, { wch: 26 }, { wch: 9 }, { wch: 16 }
      ];
      wsBase['!autofilter'] = { ref: `A1:Y${Math.max(1, aoa.length)}` };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, wsBase, 'BASE SD2');

      const somarLinha = (destino, linha) => {
        destino.itens += 1;
        destino.bruto += Number(linha.valor || 0);
        if (linha.isReceita) {
          destino.receita += Number(linha.valor || 0);
          if (linha.motivo) destino.expurgos += Number(linha.valor || 0);
          else destino.comercial += Number(linha.valor || 0);
        } else {
          destino.foraEscopo += Number(linha.valor || 0);
        }
      };

      const contratos = new Map();
      const notas = new Map();
      const clientes = new Map();
      const clienteContratos = new Map();
      for (const l of linhas) {
        const contrato = String(l.numeroContrato || '').trim() || 'Sem contrato';
        if (!contratos.has(contrato)) {
          contratos.set(contrato, {
            contrato,
            unidades: new Set(),
            executivos: new Set(),
            clientes: new Set(),
            notas: new Set(),
            itens: 0,
            bruto: 0,
            foraEscopo: 0,
            receita: 0,
            expurgos: 0,
            comercial: 0
          });
        }
        const ctr = contratos.get(contrato);
        if (l.unidade) ctr.unidades.add(l.unidade);
        if (l.executivo) ctr.executivos.add(l.executivo);
        if (l.cliente) ctr.clientes.add(l.cliente);
        ctr.notas.add(`${l.codFilial}|${l.numeroDocumento}|${l.serie}`);
        somarLinha(ctr, l);

        const chaveNf = `${l.codFilial}|${l.numeroDocumento}|${l.serie}`;
        if (!notas.has(chaveNf)) {
          notas.set(chaveNf, {
            contratos: new Set(),
            filial: l.codFilial || '',
            nf: l.numeroDocumento || '',
            serie: l.serie || '',
            emissao: l.emissao || '',
            cliente: l.cliente || '',
            codCliente: l.codCliente || '',
            loja: l.loja || '',
            unidade: l.unidade || '',
            executivo: l.executivo || '',
            itens: 0,
            bruto: 0,
            foraEscopo: 0,
            receita: 0,
            expurgos: 0,
            comercial: 0,
            motivos: new Set()
          });
        }
        const nf = notas.get(chaveNf);
        nf.contratos.add(contrato);
        if (l.motivo) {
          nf.motivos.add(
            l.motivo === 'cm_maquinas' ? 'CM Máquinas'
              : l.motivo === 'central_adm' ? 'Central ADM'
                : l.motivo === 'fora_unidades' ? 'Fora das unidades comerciais'
                  : l.motivo === 't_a_contrato' ? 'Locação T&A'
                    : l.motivo
          );
        }
        if (!l.isReceita) nf.motivos.add('Fora do escopo TES/CFOP');
        somarLinha(nf, l);

        const codCliente = String(l.codCliente || '').trim() || 'Sem código';
        const loja = String(l.loja || '').trim();
        const chaveCliente = `${codCliente}|${loja}`;
        if (!clientes.has(chaveCliente)) {
          clientes.set(chaveCliente, {
            codCliente,
            loja,
            cliente: l.cliente || 'Cliente não identificado',
            unidades: new Set(),
            executivos: new Set(),
            contratos: new Set(),
            notas: new Set(),
            itens: 0,
            bruto: 0,
            foraEscopo: 0,
            receita: 0,
            expurgos: 0,
            comercial: 0
          });
        }
        const cli = clientes.get(chaveCliente);
        if (l.unidade) cli.unidades.add(l.unidade);
        if (l.executivo) cli.executivos.add(l.executivo);
        cli.contratos.add(contrato);
        cli.notas.add(chaveNf);
        somarLinha(cli, l);

        const chaveClienteContrato = `${chaveCliente}|${contrato}`;
        if (!clienteContratos.has(chaveClienteContrato)) {
          clienteContratos.set(chaveClienteContrato, {
            codCliente,
            loja,
            cliente: l.cliente || 'Cliente não identificado',
            contrato,
            unidades: new Set(),
            executivos: new Set(),
            notas: new Set(),
            itens: 0,
            bruto: 0,
            foraEscopo: 0,
            receita: 0,
            expurgos: 0,
            comercial: 0
          });
        }
        const clienteContrato = clienteContratos.get(chaveClienteContrato);
        if (l.unidade) clienteContrato.unidades.add(l.unidade);
        if (l.executivo) clienteContrato.executivos.add(l.executivo);
        clienteContrato.notas.add(chaveNf);
        somarLinha(clienteContrato, l);
      }

      const contratosAoa = [[
        'Contrato', 'Unidade', 'Executivo', 'Clientes', 'Qtd. NFs', 'Qtd. Itens',
        'SD2 Bruto', 'Fora Escopo TES/CFOP', 'Receita', 'Expurgos', 'Faturamento Comercial'
      ]];
      [...contratos.values()]
        .sort((a, b) => b.comercial - a.comercial || a.contrato.localeCompare(b.contrato, 'pt-BR'))
        .forEach(c => contratosAoa.push([
          c.contrato,
          [...c.unidades].join(' | '),
          [...c.executivos].join(' | '),
          [...c.clientes].join(' | '),
          c.notas.size,
          c.itens,
          c.bruto,
          c.foraEscopo,
          c.receita,
          c.expurgos,
          c.comercial
        ]));
      const wsContratos = XLSX.utils.aoa_to_sheet(contratosAoa);
      wsContratos['!cols'] = [
        { wch: 16 }, { wch: 18 }, { wch: 28 }, { wch: 48 }, { wch: 10 },
        { wch: 11 }, { wch: 16 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 22 }
      ];
      wsContratos['!autofilter'] = { ref: `A1:K${Math.max(1, contratosAoa.length)}` };
      XLSX.utils.book_append_sheet(wb, wsContratos, 'POR CONTRATO');

      const notasAoa = [[
        'Contrato', 'Filial', 'NF', 'Série', 'Emissão', 'Cód. Cliente', 'Loja',
        'Cliente', 'Unidade', 'Executivo', 'Qtd. Itens', 'SD2 Bruto',
        'Fora Escopo TES/CFOP', 'Receita', 'Expurgos', 'Faturamento Comercial', 'Classificação'
      ]];
      [...notas.values()]
        .sort((a, b) => [...a.contratos].join(' | ').localeCompare([...b.contratos].join(' | '), 'pt-BR')
          || a.emissao.localeCompare(b.emissao)
          || a.nf.localeCompare(b.nf))
        .forEach(n => notasAoa.push([
          [...n.contratos].join(' | '),
          n.filial,
          n.nf,
          n.serie,
          n.emissao,
          n.codCliente,
          n.loja,
          n.cliente,
          n.unidade,
          n.executivo,
          n.itens,
          n.bruto,
          n.foraEscopo,
          n.receita,
          n.expurgos,
          n.comercial,
          n.motivos.size ? [...n.motivos].join(' | ') : 'Faturamento comercial'
        ]));
      const wsNotas = XLSX.utils.aoa_to_sheet(notasAoa);
      wsNotas['!cols'] = [
        { wch: 16 }, { wch: 9 }, { wch: 13 }, { wch: 7 }, { wch: 12 },
        { wch: 13 }, { wch: 7 }, { wch: 38 }, { wch: 18 }, { wch: 28 },
        { wch: 11 }, { wch: 16 }, { wch: 20 }, { wch: 16 }, { wch: 16 },
        { wch: 22 }, { wch: 34 }
      ];
      wsNotas['!autofilter'] = { ref: `A1:Q${Math.max(1, notasAoa.length)}` };
      XLSX.utils.book_append_sheet(wb, wsNotas, 'POR NF');

      const clientesAoa = [[
        'Cód. Cliente', 'Loja', 'Cliente', 'Unidades', 'Executivos', 'Contratos',
        'Qtd. Contratos', 'Qtd. NFs', 'Qtd. Itens', 'SD2 Bruto',
        'Fora Escopo TES/CFOP', 'Receita', 'Expurgos', 'Faturamento Comercial'
      ]];
      [...clientes.values()]
        .sort((a, b) => b.comercial - a.comercial
          || a.cliente.localeCompare(b.cliente, 'pt-BR'))
        .forEach(c => clientesAoa.push([
          c.codCliente,
          c.loja,
          c.cliente,
          [...c.unidades].join(' | '),
          [...c.executivos].join(' | '),
          [...c.contratos].join(' | '),
          c.contratos.size,
          c.notas.size,
          c.itens,
          c.bruto,
          c.foraEscopo,
          c.receita,
          c.expurgos,
          c.comercial
        ]));
      const wsClientes = XLSX.utils.aoa_to_sheet(clientesAoa);
      wsClientes['!cols'] = [
        { wch: 13 }, { wch: 7 }, { wch: 42 }, { wch: 28 }, { wch: 34 },
        { wch: 38 }, { wch: 14 }, { wch: 10 }, { wch: 11 }, { wch: 16 },
        { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 22 }
      ];
      wsClientes['!autofilter'] = { ref: `A1:N${Math.max(1, clientesAoa.length)}` };
      XLSX.utils.book_append_sheet(wb, wsClientes, 'POR CLIENTE');

      const clienteContratosAoa = [[
        'Cód. Cliente', 'Loja', 'Cliente', 'Contrato / Negócio', 'Unidades',
        'Executivos', 'Qtd. NFs', 'NFs (Filial/Número/Série)', 'Qtd. Itens',
        'SD2 Bruto', 'Fora Escopo TES/CFOP', 'Receita', 'Expurgos',
        'Faturamento Comercial'
      ]];
      [...clienteContratos.values()]
        .sort((a, b) => b.comercial - a.comercial
          || a.cliente.localeCompare(b.cliente, 'pt-BR')
          || a.contrato.localeCompare(b.contrato, 'pt-BR'))
        .forEach(n => clienteContratosAoa.push([
          n.codCliente,
          n.loja,
          n.cliente,
          n.contrato,
          [...n.unidades].join(' | '),
          [...n.executivos].join(' | '),
          n.notas.size,
          [...n.notas].map(chave => {
            const [filial, nf, serie] = chave.split('|');
            return `${filial}/${nf}/${serie}`;
          }).join(' | '),
          n.itens,
          n.bruto,
          n.foraEscopo,
          n.receita,
          n.expurgos,
          n.comercial
        ]));
      const wsClienteContratos = XLSX.utils.aoa_to_sheet(clienteContratosAoa);
      wsClienteContratos['!cols'] = [
        { wch: 13 }, { wch: 7 }, { wch: 42 }, { wch: 20 }, { wch: 28 },
        { wch: 34 }, { wch: 10 }, { wch: 56 }, { wch: 11 }, { wch: 16 },
        { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 22 }
      ];
      wsClienteContratos['!autofilter'] = {
        ref: `A1:N${Math.max(1, clienteContratosAoa.length)}`
      };
      XLSX.utils.book_append_sheet(wb, wsClienteContratos, 'CLIENTE X CONTRATO');

      const r = fatSd2Payload?.resumo || {};
      const resumo = [
        ['PRÉVIA DE FATURAMENTO - SD2'],
        ['Fonte', dados.fonte || 'stage_protheus.sd2010'],
        ['Período', `${startDate} a ${endDate}`],
        ['Regras', `v${dados.regrasVersao || ''}`],
        ['Consultado em', dados.consultadoEm || ''],
        [],
        ['Etapa', 'Valor (R$)'],
        ['Faturamento SD2 bruto', Number(r.bruto || 0)],
        ['(-) Fora do escopo de receita (TES/CFOP)', Number(r.foraEscopo || 0)],
        ['(=) Receita comercial', Number(r.receita || 0)],
        ['(-) CM Máquinas', Number((fatSd2Payload?.expurgos || []).find(e => e.motivo === 'cm_maquinas')?.valor || 0)],
        ['(-) Central ADM', Number((fatSd2Payload?.expurgos || []).find(e => e.motivo === 'central_adm')?.valor || 0)],
        ['(-) Fora das unidades comerciais', Number((fatSd2Payload?.expurgos || []).find(e => e.motivo === 'fora_unidades')?.valor || 0)],
        ['(-) Locação T&A', Number((fatSd2Payload?.expurgos || []).find(e => e.motivo === 't_a_contrato')?.valor || 0)],
        ['(=) Faturamento comercial', Number(r.comercial || 0)],
        [],
        ['Linhas exportadas', linhas.length],
        ['Clientes exportados', clientes.size],
        ['Contratos exportados', contratos.size],
        ['Negócios cliente x contrato', clienteContratos.size],
        ['Notas fiscais exportadas', notas.size]
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumo), 'RESUMO');

      const regras = [
        ['REGRA', 'CRITÉRIO'],
        ['Escopo de receita', 'TES comerciais: 501, 503, 511, 520, 522, 586, 620, 623, 628, 629, 630, 633, 636, 653'],
        ['', 'CFOPs de receita: 5933, 6933, 000, 5405, 6932, 6404, 6353, 5353, 5352, 5932, 5102'],
        ['Unidades comerciais', 'Centros de custo iniciados por 413, 414, 415, 416, 417 ou 423'],
        ['CM Máquinas', 'Centro de custo iniciado por 421'],
        ['Central ADM', 'Centro de custo iniciado por 321 ou 330'],
        ['Locação T&A', 'Contrato 68673, série 4'],
        ['', ''],
        ['OBSERVAÇÃO', 'Prévia sujeita a fechamento contábil. O executivo vem do código de vendedor gravado na NF.']
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(regras), 'REGRAS');

      const nome = `base-sd2-${startDate}-a-${endDate}.xlsx`;
      XLSX.writeFile(wb, nome);
      core().showToast(
        `XLSX exportado: ${fmtInt(clientes.size)} clientes, ${fmtInt(contratos.size)} contratos e ${fmtInt(notas.size)} NFs.`,
        'success'
      );
    } catch (ex) {
      core().showToast(ex.message || 'Não foi possível exportar a base SD2.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function bindControlesFaturamentoSd2() {
    if (fatSd2Binded) return;
    fatSd2Binded = true;
    montarPeriodosFatSd2();
    alternarPeriodoPersonalizadoFatSd2();
    document.getElementById('fatSd2Periodo')?.addEventListener('change', () => {
      const personalizado = alternarPeriodoPersonalizadoFatSd2();
      if (personalizado) {
        const de = document.getElementById('fatSd2Start');
        const ate = document.getElementById('fatSd2End');
        if (!de?.value || !ate?.value) return;
      }
      carregarFaturamentoSd2(true);
    });
    ['fatSd2Start', 'fatSd2End', 'fatSd2Unidade', 'fatSd2Executivo'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => carregarFaturamentoSd2(true));
    });
    document.getElementById('btnAtualizarFaturamentoSd2')?.addEventListener('click', () => carregarFaturamentoSd2(true));
    document.getElementById('btnExportarFaturamentoSd2Base')?.addEventListener('click', exportarBaseSd2Xlsx);
  }

  window.FarolReportsExtra = {
    openRmr: () => carregarRmr(false),
    refreshRmr: () => carregarRmr(true),
    openFaturamento: () => carregarFaturamento(false),
    openFaturamentoSd2: () => {
      bindControlesFaturamentoSd2();
      return carregarFaturamentoSd2(false);
    },
    refreshFaturamentoSd2: () => {
      bindControlesFaturamentoSd2();
      return carregarFaturamentoSd2(true);
    },
    openInadimplencia: () => {
      carregarPosicoesInad();
      return carregarInadimplencia(false);
    },
    refreshInadimplencia: () => carregarInadimplencia(true),
    reset: () => {
      rmrPayload = null;
      rmrCarregadoKey = '';
      fatPayload = null;
      fatCarregado = false;
      fatSd2Payload = null;
      fatSd2Carregado = false;
      inadPayload = null;
      inadCarregado = false;
      inadFiliaisSelecionadas = new Set();
      inadFiliaisCatalogo = [];
    }
  };
})();
