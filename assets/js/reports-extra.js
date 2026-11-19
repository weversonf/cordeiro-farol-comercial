/* ================================================================
   FAROL CORDEIRO COMERCIAL — RMR COMERCIAL & FATURAMENTO
   Consome /api/rmr e /api/faturamento autenticados via Supabase JWT.
   ================================================================ */

(function initFarolReportsExtra() {
  const core = () => window.FarolReportsCore;

  let rmrPayload = null;
  let rmrCarregadoKey = '';
  let rmrControlsReady = false;

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
          backlog: 'rmrPanelBacklog',
          clientes: 'rmrPanelClientes',
          projecoes: 'rmrPanelProjecoes',
          funil: 'rmrPanelFunil'
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
    const bitData = d.atualizacao?.bitrixUltimaModificacao ? new Date(d.atualizacao.bitrixUltimaModificacao).toLocaleString('pt-BR') : '—';
    document.getElementById('rmrAtualizacaoTexto').textContent = `Protheus emissão até ${protData} · Bitrix atualizado em ${bitData}`;
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
    document.getElementById('tbodyRmrMetasUnidades').innerHTML = unidades.length
      ? unidades.map(u => `
          <tr>
            <td><strong>${esc(u.unidade)}</strong> ${u.isExpurgoUnidade ? '<span class="metric-pill is-neutral">Expurgo</span>' : ''}</td>
            <td class="num">${fmtMoedaExata(u.realizadoMes)}</td>
            <td class="num">${fmtMoedaExata(u.metaMes)}</td>
            <td class="num">${badgePct(u.atingimentoMesPct)}</td>
            <td class="num"><strong>${fmtMoedaExata(u.realizadoYtd)}</strong></td>
            <td class="num">${fmtMoedaExata(u.metaYtd)}</td>
            <td class="num">${badgePct(u.atingimentoYtdPct)}</td>
            <td class="num">${fmtMoedaExata(u.metaAnual)}</td>
            <td class="num">${fmtMoedaExata(u.runRateAnual)}</td>
          </tr>`).join('')
      : '<tr><td colspan="9" class="contracts-empty">Sem dados de unidades no período.</td></tr>';

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
      ? execs.map(e => `
          <tr>
            <td><strong>${esc(e.executivo)}</strong> <small class="text-muted">(${esc(e.codVendedor)})</small></td>
            <td>${esc(e.unidadeMeta)}</td>
            <td class="num">${fmtMoedaExata(e.realizadoMes)}</td>
            <td class="num"><strong>${fmtMoedaExata(e.realizadoYtd)}</strong></td>
            <td class="num">${e.metaProportionalYtd > 0 ? fmtMoedaExata(e.metaProportionalYtd) : '—'}</td>
            <td class="num">${badgePct(e.atingimentoYtdPct)}</td>
            <td class="num">${e.metaAnualAlvo > 0 ? fmtMoedaExata(e.metaAnualAlvo) : '—'}</td>
            <td class="num ${e.gapAnual !== null && e.gapAnual < 0 ? 'text-neg' : 'text-pos'}">${e.gapAnual !== null ? fmtMoedaExata(e.gapAnual) : '—'}</td>
            <td class="num">${fmtInt(e.qtdNfsYtd)} / ${fmtInt(e.qtdClientesYtd)}</td>
          </tr>`).join('')
      : '<tr><td colspan="9" class="contracts-empty">Sem executivos com movimento ou meta no período.</td></tr>';

    // Aba 3: Backlog & Medições Pendentes
    const bm = d.backlogMedicoes || {};
    const stMed = bm.statusMedicoesProtheus || {};
    const stCtr = bm.statusContratosProtheus || {};
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
    document.getElementById('rmrClientesContratosBanner').innerHTML = `
      <i class="ph ph-info"></i>
      <div>
        <strong>Visão por Cliente e Contrato (Protheus SD2):</strong>
        Ranking baseado nas notas fiscais emitidas e validadas no Protheus. Contratos sem NFs emitidas no período dependem da liberação de <code>comercial.contratos_operacional</code>.
      </div>`;

    const cliRows = d.contratosClientes?.clientes || [];
    document.getElementById('tbodyRmrClientes').innerHTML = cliRows.length
      ? cliRows.map(c => `
          <tr>
            <td>${String(c.posicao).padStart(2, '0')}</td>
            <td><strong>${esc(c.cliente)}</strong></td>
            <td>${esc(c.unidadePrincipal)}</td>
            <td>${esc(c.executivoPrincipal)}</td>
            <td class="num">${fmtMoedaExata(c.valorMes)}</td>
            <td class="num"><strong>${fmtMoedaExata(c.valorYtd)}</strong></td>
            <td class="num">${fmtPct(c.participacaoPct)}</td>
            <td class="num">${fmtPct(c.paretoAcumuladoPct)}</td>
            <td class="num">${fmtInt(c.qtdNfsYtd)} / ${fmtInt(c.qtdContratosYtd)}</td>
          </tr>`).join('')
      : '<tr><td colspan="9" class="contracts-empty">Nenhum cliente com faturamento no período.</td></tr>';

    const ctrProtheus = d.contratosClientes?.contratosProtheus || [];
    document.getElementById('tbodyRmrContratosProtheus').innerHTML = ctrProtheus.length
      ? ctrProtheus.map(c => `
          <tr>
            <td><strong>${esc(c.numeroContrato)}</strong></td>
            <td>${esc(c.cliente)}</td>
            <td>${esc(c.unidade)}</td>
            <td>${esc(c.executivo)}</td>
            <td class="num">${fmtMoedaExata(c.valorMes)}</td>
            <td class="num"><strong>${fmtMoedaExata(c.valorYtd)}</strong></td>
            <td class="num">${fmtInt(c.qtdNfsYtd)}</td>
            <td>${c.ultimaEmissao ? core().formatarDataBr(c.ultimaEmissao) : '—'}</td>
          </tr>`).join('')
      : '<tr><td colspan="8" class="contracts-empty">Sem contratos identificados nas NFs do período.</td></tr>';

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

    // Aba 6: Funil de Vendas & Motivos de Perda
    const fp = d.funilPerdas || {};
    const fpRes = fp.resumo || {};
    document.getElementById('rmrFunilGanhosVal').textContent = fmtMoeda(fpRes.ganhosValor);
    document.getElementById('rmrFunilGanhosQtd').textContent = `${fmtInt(fpRes.ganhosQtd)} negócios ganhos no YTD`;
    document.getElementById('rmrFunilPerdasVal').textContent = fmtMoeda(fpRes.perdasReaisValor);
    document.getElementById('rmrFunilPerdasQtd').textContent = `${fmtInt(fpRes.perdasReaisQtd)} perdas reais (competitivas/operacionais)`;
    document.getElementById('rmrFunilCancelVal').textContent = fmtMoeda(fpRes.canceladosClienteValor);
    document.getElementById('rmrFunilCancelQtd').textContent = `${fmtInt(fpRes.canceladosClienteQtd)} cancelados pelo cliente / orientativos`;
    document.getElementById('rmrFunilConv').textContent = fmtPct(fpRes.taxaConversaoCompetitivaPct);
    document.getElementById('rmrFunilConvBruta').textContent =
      `Conversão bruta (c/ cancelamentos): ${fmtPct(fpRes.taxaConversaoBrutaPct)}`;

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

    document.getElementById('tbodyRmrUltimosGanhos').innerHTML = (fp.ultimosGanhos || []).length
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

    ['inadFiltroExecutivo', 'inadFiltroMargem'].forEach(id => {
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
      const qs = new URLSearchParams({ data_corte: dataCorte, escopo: 'all' });
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
      renderizarInadimplencia();
      conteudo.style.display = 'block';
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
      if (!(Number(t.saldoInadimplente || 0) > 0)) return false;
      if (dataCorte && t.vencimentoReal && t.vencimentoReal >= dataCorte) return false;
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
        <span class="report-kpi-label">Saldo Inadimplente</span>
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
    document.getElementById('inadAnaliticoCountTag').textContent = `${fmtInt(filtrados.length)} títulos`;
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
            <td><strong>${esc(t.titulo || '—')}</strong></td>
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
        'Valor Original Título (R$)', 'Saldo Inadimplente (R$)', 'Emissão', 'Vencimento Real'
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
        t.vencimentoReal ? core().formatarDataBr(t.vencimentoReal) : ''
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
    const dataTag = document.getElementById('inadDataCorte')?.value || hojeLocalIso();
    XLSX.writeFile(wb, `Inadimplencia_Executivo_Cliente_Margem_${dataTag}.xlsx`);
  }

  window.FarolReportsExtra = {
    openRmr: () => carregarRmr(false),
    openFaturamento: () => carregarFaturamento(false),
    openInadimplencia: () => carregarInadimplencia(false),
    reset: () => {
      rmrPayload = null;
      rmrCarregadoKey = '';
      fatPayload = null;
      fatCarregado = false;
      inadPayload = null;
      inadCarregado = false;
      inadFiliaisSelecionadas = new Set();
      inadFiliaisCatalogo = [];
    }
  };
})();
