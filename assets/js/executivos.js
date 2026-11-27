/* ================================================================
   FAROL CORDEIRO COMERCIAL — PAINEL EXECUTIVOS (/relatorios/painel-executivos)
   Consome /api/executivos autenticado via Supabase JWT.
   - Executivo logado vê exclusivamente seu próprio painel.
   - Admin Master alterna entre visão comparativa e cada executivo.
   ================================================================ */

(function initFarolPainelExecutivos() {
  const core = () => window.FarolReportsCore;
  const MESES_PT = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
  ];
  const MESES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

  const state = {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    selectedExec: 'ALL',
    cobStatusFilter: 'todos',
    cobRankFilter: 'todos',
    cobSearch: '',
    payload: null,
    loadedKey: '',
    wired: false,
    charts: {}
  };

  const esc = v => core().escaparHtml(v ?? '');
  const fmtMoeda = v => core().formatarMoeda(Number(v || 0));
  const fmtMoedaExata = v => core().formatarMoedaCompleta(Number(v || 0));
  const fmtInt = v => Number(v || 0).toLocaleString('pt-BR');

  function fmtPct(v) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
    return `${Number(v).toFixed(1).replace('.', ',')}%`;
  }

  function badgePct(pct) {
    if (pct === null || pct === undefined || Number.isNaN(Number(pct))) {
      return '<span class="metric-pill is-neutral">Sem meta</span>';
    }
    const n = Number(pct);
    const cls = n >= 100 ? 'is-good' : (n >= 80 ? 'is-warn' : 'is-bad');
    return `<span class="metric-pill ${cls}">${fmtPct(n)}</span>`;
  }

  function renderChart(canvasId, config) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof window.Chart !== 'function') return;
    if (state.charts[canvasId]) {
      state.charts[canvasId].destroy();
    }
    state.charts[canvasId] = new window.Chart(canvas.getContext('2d'), config);
  }

  function populatePeriodSelect() {
    const sel = document.getElementById('execPeriodoSelect');
    if (!sel) return;
    const now = new Date();
    const curY = now.getFullYear();
    const curM = now.getMonth() + 1;
    const options = [];
    for (let y = curY; y >= 2025; y--) {
      const maxM = y === curY ? curM : 12;
      for (let m = maxM; m >= 1; m--) {
        const val = `${y}-${String(m).padStart(2, '0')}`;
        options.push(`<option value="${val}">${MESES_CURTO[m - 1]}/${String(y).slice(-2)} (${MESES_PT[m - 1]})</option>`);
      }
    }
    sel.innerHTML = options.join('');
    sel.value = `${state.year}-${String(state.month).padStart(2, '0')}`;
  }

  function wireEvents() {
    if (state.wired) return;
    state.wired = true;

    populatePeriodSelect();

    document.getElementById('execPeriodoSelect')?.addEventListener('change', e => {
      const [y, m] = String(e.target.value || '').split('-').map(Number);
      if (y && m) {
        state.year = y;
        state.month = m;
        load(true);
      }
    });

    document.getElementById('btnAtualizarExecutivos')?.addEventListener('click', () => load(true));
    document.getElementById('btnExportarExecutivosCsv')?.addEventListener('click', exportarCsv);

    document.querySelectorAll('#execCobStatusFilter .exec-pill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#execCobStatusFilter .exec-pill-btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        state.cobStatusFilter = btn.dataset.cobStatus || 'todos';
        renderCoberturaClientes();
      });
    });

    document.querySelectorAll('#execCobRankingFilter .exec-pill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#execCobRankingFilter .exec-pill-btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        state.cobRankFilter = btn.dataset.cobRank || 'todos';
        renderCoberturaClientes();
      });
    });

    document.getElementById('execCobBusca')?.addEventListener('input', e => {
      state.cobSearch = String(e.target.value || '').trim().toLowerCase();
      renderCoberturaClientes();
    });
  }

  function renderProfileBar(data) {
    const bar = document.getElementById('execPerfilBar');
    if (!bar) return;

    const acesso = data.acesso || {};
    const execs = data.executivosDisponiveis || [];
    const compLabel = `${MESES_PT[(data.parametros?.month || 1) - 1]}/${data.parametros?.year}`;

    if (!acesso.isMaster) {
      const ex = acesso.executivoLogado || data.detalhe || {};
      bar.innerHTML = `
        <div class="exec-locked-badge">
          <i class="ph ph-lock-key"></i>
          <span>Perfil vinculado: <strong>${esc(ex.nome || ex.executivo || 'Executivo')}</strong> · ${esc(ex.unidadeRef || '—')}</span>
        </div>
        <div class="exec-profile-meta">Competência: <strong>${esc(compLabel)}</strong> · Acesso individual restrito ao seu usuário</div>
      `;
      return;
    }

    const active = data.parametros?.selectedExec || state.selectedExec;
    const pills = [
      `<button type="button" class="exec-profile-pill ${active === 'ALL' ? 'is-active' : ''}" data-exec-cod="ALL">
        <i class="ph ph-users-three"></i> Visão Geral (Todos)
      </button>`,
      ...execs.map(ex => `
        <button type="button" class="exec-profile-pill ${active === ex.cod ? 'is-active' : ''}" data-exec-cod="${esc(ex.cod)}">
          <span class="exec-profile-dot" style="background:${esc(ex.cor || '#2563eb')}"></span>
          <span>${esc(ex.nome)}</span>
        </button>
      `)
    ].join('');

    bar.innerHTML = `
      <div class="exec-profile-pills">${pills}</div>
      <div class="exec-profile-meta">Modo Admin Master · Competência: <strong>${esc(compLabel)}</strong></div>
    `;

    bar.querySelectorAll('.exec-profile-pill[data-exec-cod]').forEach(btn => {
      btn.addEventListener('click', () => {
        const cod = btn.dataset.execCod || 'ALL';
        if (cod === state.selectedExec) return;
        state.selectedExec = cod;
        load(true);
      });
    });
  }

  function renderBanners(data) {
    const wrap = document.getElementById('execStatusBanners');
    if (!wrap) return;
    const html = [];
    const fCob = data.fontes?.cobertura || {};
    const fMed = data.fontes?.medicoes || {};

    if (!fCob.disponivel) {
      html.push(`
        <div class="report-status-banner is-warning">
          <i class="ph ph-warning"></i>
          <div>
            <strong>Cobertura de Carteira (SPA 1100):</strong> ${esc(fCob.observacao || 'Indisponível para esta competência.')}
          </div>
        </div>
      `);
    } else if (!fCob.aoVivo) {
      html.push(`
        <div class="report-status-banner is-info">
          <i class="ph ph-info"></i>
          <div>
            <strong>Cobertura de Carteira em Snapshot (${esc(fCob.fonte)}):</strong> ${esc(fCob.observacao)}
          </div>
        </div>
      `);
    }

    if (fMed.divergente) {
      html.push(`
        <div class="report-status-banner is-info">
          <i class="ph ph-hourglass-high"></i>
          <div>
            <strong>Medições Pendentes — competência exibida ${esc(fMed.competenciaExibida)}:</strong>
            O mês ${esc(fMed.mesSolicitado)} ainda não possui fechamento de medições na base RMR; exibindo a última competência carregada (${esc(fMed.competenciaExibida)}).
          </div>
        </div>
      `);
    }

    wrap.innerHTML = html.join('');
  }

  function renderComparativo(data) {
    const wrap = document.getElementById('execComparativoView');
    const indWrap = document.getElementById('execIndividualView');
    if (!wrap || !indWrap) return;

    wrap.style.display = 'block';
    indWrap.style.display = 'none';

    const r = data.resumoGeral || {};
    const lista = data.comparativo || [];
    const mesNome = MESES_CURTO[(data.parametros?.month || 1) - 1];

    document.getElementById('execCompFatMes').textContent = fmtMoeda(r.faturamentoMes);
    document.getElementById('execCompFatMesSub').textContent = `YTD acumulado: ${fmtMoeda(r.faturamentoYtd)}`;
    document.getElementById('execCompMetaMes').textContent = fmtMoeda(r.metaMes);
    document.getElementById('execCompMetaMesSub').textContent = `Atingimento ${mesNome}: ${fmtPct(r.atingimentoMesPct)} · YTD ${fmtPct(r.atingimentoYtdPct)}`;
    document.getElementById('execCompCobPct').textContent = fmtPct(r.coberturaPct);
    document.getElementById('execCompCobSub').textContent = `${fmtInt(r.coberturaCobertosAB)} / ${fmtInt(r.coberturaCarteiraAB)} clientes A/B cobertos`;
    document.getElementById('execCompMedVal').textContent = fmtMoeda(r.medicoesValor);
    document.getElementById('execCompMedSub').textContent = `${fmtInt(r.medicoesQtd)} itens pendentes (${data.fontes?.medicoes?.competenciaExibida || '—'})`;
    document.getElementById('execCompTag').textContent = `${lista.length} executivos · ${mesNome}/${data.parametros?.year}`;

    const tbody = document.getElementById('tbodyExecComparativo');
    if (!tbody) return;
    tbody.innerHTML = lista.length
      ? lista.map(ex => {
          const cobCls = ex.coberturaPct >= 100 ? 'is-good' : (ex.coberturaPct >= 75 ? 'is-warn' : 'is-bad');
          return `
            <tr class="exec-comp-row" data-exec-cod="${esc(ex.codVendedor)}">
              <td>
                <div style="display:flex;align-items:center;gap:8px;">
                  <span class="exec-profile-dot" style="background:${esc(ex.cor || '#2563eb')}"></span>
                  <strong>${esc(ex.executivo)}</strong>
                </div>
              </td>
              <td>${esc(ex.unidadeRef)}</td>
              <td class="num"><strong>${fmtMoedaExata(ex.faturamentoMes)}</strong></td>
              <td class="num">${fmtMoedaExata(ex.metaMes)}</td>
              <td class="num">${badgePct(ex.atingimentoMesPct)}</td>
              <td class="num">${fmtMoeda(ex.faturamentoYtd)}</td>
              <td class="num">${badgePct(ex.atingimentoYtdPct)}</td>
              <td class="num"><span class="metric-pill ${cobCls}">${fmtInt(ex.coberturaCobertosAB)}/${fmtInt(ex.coberturaCarteiraAB)} (${fmtPct(ex.coberturaPct)})</span></td>
              <td class="num">${ex.medicoesQtd > 0 ? `<strong>${fmtMoeda(ex.medicoesValor)}</strong> <small style="color:#64748b">(${ex.medicoesQtd})</small>` : '—'}</td>
            </tr>
          `;
        }).join('')
      : '<tr><td colspan="9" class="contracts-empty">Sem dados para os executivos nesta competência.</td></tr>';

    tbody.querySelectorAll('.exec-comp-row[data-exec-cod]').forEach(row => {
      row.addEventListener('click', () => {
        state.selectedExec = row.dataset.execCod;
        load(true);
      });
    });
  }

  function renderCoberturaClientes() {
    const ex = state.payload?.detalhe;
    const tbody = document.getElementById('tbodyExecCoberturaClientes');
    const tag = document.getElementById('execCobListaTag');
    if (!ex || !tbody) return;

    const clientesAll = ex.coberturaCarteira?.clientes || [];
    const filtered = clientesAll.filter(c => {
      if (state.cobStatusFilter === 'pendente' && c.coberto) return false;
      if (state.cobStatusFilter === 'coberto' && !c.coberto) return false;
      if (state.cobRankFilter !== 'todos' && c.ranking !== state.cobRankFilter) return false;
      if (state.cobSearch) {
        const hay = `${c.cliente} ${c.segmento || ''} ${c.meioContato || ''}`.toLowerCase();
        if (!hay.includes(state.cobSearch)) return false;
      }
      return true;
    });

    if (tag) {
      tag.textContent = `${fmtInt(filtered.length)} de ${fmtInt(clientesAll.length)} clientes`;
    }

    tbody.innerHTML = filtered.length
      ? filtered.map(c => {
          const rankPill = c.ranking === 'A'
            ? '<span class="metric-pill is-info">Margem A</span>'
            : '<span class="metric-pill is-neutral">Margem B</span>';
          const statusPill = c.coberto
            ? '<span class="metric-pill is-good">Cobertura Feita</span>'
            : '<span class="metric-pill is-bad">Pendente</span>';
          const dtBr = c.dataContato ? core().formatarDataBr(c.dataContato) : '—';
          return `
            <tr>
              <td><strong>${esc(c.cliente)}</strong></td>
              <td>${rankPill}</td>
              <td>${statusPill}</td>
              <td>${esc(c.meioContato || '—')}</td>
              <td>${esc(dtBr)}</td>
              <td class="num">${fmtInt(c.contatosNoMes || 0)}</td>
            </tr>
          `;
        }).join('')
      : '<tr><td colspan="6" class="contracts-empty">Nenhum cliente encontrado com os filtros selecionados.</td></tr>';
  }

  function renderIndividual(data) {
    const compWrap = document.getElementById('execComparativoView');
    const indWrap = document.getElementById('execIndividualView');
    const ex = data.detalhe;
    if (!compWrap || !indWrap || !ex) return;

    compWrap.style.display = 'none';
    indWrap.style.display = 'block';

    const fat = ex.faturamento || {};
    const meta = ex.meta || {};
    const cob = ex.coberturaCarteira || {};
    const med = ex.medicoesPendentes || {};
    const mesNome = MESES_CURTO[(data.parametros?.month || 1) - 1];

    // 1. KPI Faturamento
    document.getElementById('execKpiFatMes').textContent = fmtMoedaExata(fat.mes);
    document.getElementById('execKpiFatSub').textContent =
      `YTD ${data.parametros?.year}: ${fmtMoeda(fat.ytd)} · ${fmtInt(fat.qtdNfsMes)} NFs / ${fmtInt(fat.qtdClientesMes)} clientes no mês`;

    // 2. KPI Meta de Faturamento
    const atingMes = meta.atingimentoMesPct;
    const gapMes = meta.gapMes;
    document.getElementById('execKpiMetaMes').textContent = meta.mes > 0 ? fmtMoedaExata(meta.mes) : 'Sem meta';
    const gapTxt = gapMes === null || gapMes === undefined
      ? ''
      : (gapMes >= 0 ? `Superávit ${fmtMoeda(gapMes)}` : `Faltam ${fmtMoeda(Math.abs(gapMes))}`);
    document.getElementById('execKpiMetaSub').textContent = meta.mes > 0
      ? `Ating. ${mesNome}: ${fmtPct(atingMes)} (${gapTxt}) · YTD: ${fmtPct(meta.atingimentoYtdPct)} · Fonte: ${meta.fonte}`
      : `Meta YTD: ${fmtMoeda(meta.ytd)} · Anual: ${fmtMoeda(meta.anual)}`;
    const metaBar = document.getElementById('execKpiMetaBar');
    if (metaBar) {
      const pctClamp = Math.max(0, Math.min(100, Number(atingMes || 0)));
      metaBar.style.width = `${pctClamp}%`;
      metaBar.className = atingMes >= 100 ? 'is-good' : (atingMes >= 80 ? 'is-warn' : 'is-bad');
    }

    // 3. KPI Cobertura de Carteira
    document.getElementById('execKpiCobPct').textContent = fmtPct(cob.percentual);
    document.getElementById('execKpiCobSub').textContent =
      `${fmtInt(cob.cobertosDistintosAB)} de ${fmtInt(cob.carteiraAB)} clientes A/B cobertos · Faltam ${fmtInt(cob.pendentesAB)}`;
    const cobBar = document.getElementById('execKpiCobBar');
    if (cobBar) {
      const cobClamp = Math.max(0, Math.min(100, Number(cob.percentual || 0)));
      cobBar.style.width = `${cobClamp}%`;
      cobBar.className = cob.percentual >= 100 ? 'is-good' : (cob.percentual >= 75 ? 'is-warn' : 'is-bad');
    }

    // 4. KPI Medições Pendentes
    document.getElementById('execKpiMedVal').textContent = fmtMoedaExata(med.valorTotal);
    document.getElementById('execKpiMedSub').textContent =
      `${fmtInt(med.qtdItens)} medições (${data.fontes?.medicoes?.competenciaExibida || '—'}) · Aguardando pedido: ${fmtMoeda(med.valorAguardandoPedido)} (${fmtInt(med.qtdAguardandoPedido)})`;

    // Gráfico 1: Faturamento Mensal vs Meta (Jan-Dez)
    const serie = fat.serieMensal || [];
    document.getElementById('execChartFatTag').textContent = `${ex.executivo} · ${data.parametros?.year}`;
    renderChart('chartExecFatMeta', {
      type: 'bar',
      data: {
        labels: serie.map(s => MESES_CURTO[s.mes - 1]),
        datasets: [
          {
            label: 'Realizado (Protheus SD2)',
            data: serie.map(s => (s.fechado ? s.realizado : null)),
            backgroundColor: ex.cor || '#2563eb',
            borderRadius: 6,
            order: 2
          },
          {
            label: 'Meta Mensal',
            type: 'line',
            data: serie.map(s => s.meta),
            borderColor: '#0f2942',
            backgroundColor: '#0f2942',
            borderWidth: 2.5,
            borderDash: [5, 4],
            pointRadius: 3,
            tension: 0.2,
            order: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${fmtMoedaExata(ctx.parsed.y)}`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { callback: v => fmtMoeda(v) }
          }
        }
      }
    });

    // Breakdown + Gráfico 2: Cobertura de Carteira
    document.getElementById('execChartCobTag').textContent =
      `${fmtInt(cob.cobertosDistintosAB)}/${fmtInt(cob.carteiraAB)} (${fmtPct(cob.percentual)})`;
    const pctA = cob.carteiraA > 0 ? (cob.cobertosA / cob.carteiraA) * 100 : 0;
    const pctB = cob.carteiraB > 0 ? (cob.cobertosB / cob.carteiraB) * 100 : 0;
    document.getElementById('execCobBreakdown').innerHTML = `
      <div class="exec-cob-mini">
        <span>Chave A</span>
        <strong>${fmtInt(cob.cobertosA)} / ${fmtInt(cob.carteiraA)}</strong>
        <small>${fmtPct(pctA)} coberto</small>
      </div>
      <div class="exec-cob-mini">
        <span>Chave B</span>
        <strong>${fmtInt(cob.cobertosB)} / ${fmtInt(cob.carteiraB)}</strong>
        <small>${fmtPct(pctB)} coberto</small>
      </div>
      <div class="exec-cob-mini">
        <span>Registros SPA</span>
        <strong>${fmtInt(cob.contatosValidosAB)}</strong>
        <small>Contatos válidos no mês</small>
      </div>
    `;

    renderChart('chartExecCobertura', {
      type: 'doughnut',
      data: {
        labels: ['Cobertos Chave A', 'Cobertos Chave B', 'Pendentes'],
        datasets: [{
          data: [cob.cobertosA || 0, cob.cobertosB || 0, cob.pendentesAB || 0],
          backgroundColor: ['#0f766e', '#2563eb', '#e2e8f0'],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '64%',
        plugins: {
          legend: { position: 'right' }
        }
      }
    });

    // Tabela Cobertura Clientes
    renderCoberturaClientes();

    // Tabela Medições Pendentes
    const medItens = med.itens || [];
    document.getElementById('execMedTag').textContent = `${fmtInt(medItens.length)} itens · ${fmtMoedaExata(med.valorTotal)}`;
    document.getElementById('tbodyExecMedicoes').innerHTML = medItens.length
      ? medItens.map(m => `
          <tr>
            <td><span class="metric-pill is-info">${esc(m.modalidade)}</span></td>
            <td><strong>${esc(m.cliente)}</strong><br><small style="color:#64748b">${esc(m.unidade)}</small></td>
            <td>${m.aguardandoPedido ? '<span class="metric-pill is-warn">Aguardando pedido</span>' : '<span class="metric-pill is-good">Em faturamento</span>'}</td>
            <td><small style="color:#475569">${esc(m.origemVinculo)}</small></td>
            <td class="num"><strong>${fmtMoedaExata(m.valorAtribuido)}</strong>${m.percentualRateio < 100 ? `<br><small style="color:#64748b">(${m.percentualRateio}% de ${fmtMoeda(m.valorOriginal)})</small>` : ''}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="5" class="contracts-empty">Sem medições pendentes atribuídas para este executivo.</td></tr>';

    // Tabela Faturamento por Cliente & Contrato
    const fatClis = fat.topClientesContratos || [];
    document.getElementById('execFatCliTag').textContent = `${fmtInt(fatClis.length)} contratos/clientes`;
    document.getElementById('tbodyExecFatClientes').innerHTML = fatClis.length
      ? fatClis.map(c => `
          <tr>
            <td><strong>${esc(c.cliente)}</strong></td>
            <td><code>${esc(c.numeroContrato)}</code></td>
            <td>${esc(c.unidade)}</td>
            <td class="num">${fmtInt(c.qtdNfsYtd)}</td>
            <td class="num">${c.valorMes > 0 ? `<strong>${fmtMoedaExata(c.valorMes)}</strong>` : '—'}</td>
            <td class="num"><strong>${fmtMoedaExata(c.valorYtd)}</strong></td>
          </tr>
        `).join('')
      : '<tr><td colspan="6" class="contracts-empty">Sem faturamento registrado neste período para o executivo.</td></tr>';
  }

  function renderAll(data) {
    state.payload = data;
    renderProfileBar(data);
    renderBanners(data);

    const upd = document.getElementById('execAtualizadoEm');
    if (upd) {
      const prDt = data.atualizacao?.protheusUltimaEmissao ? core().formatarDataBr(data.atualizacao.protheusUltimaEmissao) : '—';
      upd.textContent = `Protheus SD2 até ${prDt} · Cobertura: ${data.fontes?.cobertura?.aoVivo ? 'SPA 1100 Ao vivo' : 'Snapshot'}`;
    }

    if (data.acesso?.isMaster && !data.detalhe) {
      renderComparativo(data);
    } else {
      renderIndividual(data);
    }

    core().registrarAtualizacaoTela('executivos', {
      updatedAt: data.geradoEm || Date.now(),
      sourceInfo: data.fontes?.cobertura?.aoVivo ? 'Protheus SD2 + Bitrix SPA 1100' : 'Protheus SD2 + Snapshot Cobertura',
      autoRefresh: true
    });
  }

  async function load(force = false) {
    wireEvents();
    const key = `${state.year}-${state.month}-${state.selectedExec}`;
    if (!force && state.payload && state.loadedKey === key) {
      renderAll(state.payload);
      return;
    }

    const loading = document.getElementById('execLoading');
    const erro = document.getElementById('execErro');
    const conteudo = document.getElementById('execConteudo');
    if (loading) loading.style.display = 'flex';
    if (erro) erro.style.display = 'none';
    if (conteudo && !state.payload) conteudo.style.display = 'none';

    try {
      const qs = new URLSearchParams({
        year: String(state.year),
        month: String(state.month),
        executivo: state.selectedExec
      });
      const data = await core().fetchRelatorioAutenticado(`/api/executivos?${qs.toString()}`);
      if (data.acesso && !data.acesso.isMaster && data.acesso.travadoParaExecutivo) {
        state.selectedExec = data.acesso.travadoParaExecutivo;
      } else if (data.parametros?.selectedExec) {
        state.selectedExec = data.parametros.selectedExec;
      }
      state.loadedKey = `${state.year}-${state.month}-${state.selectedExec}`;
      if (conteudo) conteudo.style.display = 'block';
      renderAll(data);
    } catch (err) {
      if (conteudo) conteudo.style.display = 'none';
      if (erro) {
        erro.style.display = 'block';
        erro.innerHTML = `<strong>Não foi possível carregar o Painel Executivos:</strong> ${esc(err.message || 'Erro desconhecido.')}`;
      }
    } finally {
      if (loading) loading.style.display = 'none';
    }
  }

  function exportarCsv() {
    const data = state.payload;
    if (!data) return;
    const sep = ';';
    const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

    let headers = [];
    let rows = [];
    let filename = `painel-executivos-${data.parametros?.mesRefIso || 'competencia'}.csv`;

    if (data.detalhe) {
      const ex = data.detalhe;
      filename = `painel-executivo-${ex.codVendedor}-${data.parametros?.mesRefIso}.csv`;
      headers = ['Executivo', 'Tipo', 'Item / Cliente', 'Detalhe / Contrato', 'Status / Vínculo', 'Valor / Qtd'];
      rows.push([ex.executivo, 'RESUMO', 'Faturado Mês', data.parametros?.mesRefIso, '', ex.faturamento.mes.toFixed(2)]);
      rows.push([ex.executivo, 'RESUMO', 'Meta Mês', ex.meta.fonte, fmtPct(ex.meta.atingimentoMesPct), ex.meta.mes.toFixed(2)]);
      rows.push([ex.executivo, 'RESUMO', 'Faturado YTD', String(data.parametros?.year), fmtPct(ex.meta.atingimentoYtdPct), ex.faturamento.ytd.toFixed(2)]);
      rows.push([ex.executivo, 'RESUMO', 'Cobertura Carteira A/B', `${ex.coberturaCarteira.cobertosDistintosAB}/${ex.coberturaCarteira.carteiraAB}`, fmtPct(ex.coberturaCarteira.percentual), ex.coberturaCarteira.percentual.toFixed(2)]);
      rows.push([ex.executivo, 'RESUMO', 'Medições Pendentes', `${ex.medicoesPendentes.qtdItens} itens`, data.fontes?.medicoes?.competenciaExibida || '', ex.medicoesPendentes.valorTotal.toFixed(2)]);
      for (const c of ex.coberturaCarteira.clientes || []) {
        rows.push([ex.executivo, 'COBERTURA_CARTEIRA', c.cliente, `Ranking ${c.ranking}`, c.status, c.contatosNoMes || 0]);
      }
      for (const m of ex.medicoesPendentes.itens || []) {
        rows.push([ex.executivo, 'MEDICAO_PENDENTE', m.cliente, m.modalidade, m.origemVinculo, m.valorAtribuido.toFixed(2)]);
      }
    } else {
      headers = ['Executivo', 'Unidade', 'Faturado Mês', 'Meta Mês', 'Ating. Mês %', 'Faturado YTD', 'Meta YTD', 'Cobertos A/B', 'Carteira A/B', 'Cobertura %', 'Medições Pend.'];
      rows = (data.comparativo || []).map(e => [
        e.executivo, e.unidadeRef,
        e.faturamentoMes.toFixed(2), e.metaMes.toFixed(2), e.atingimentoMesPct !== null ? e.atingimentoMesPct.toFixed(1) : '',
        e.faturamentoYtd.toFixed(2), e.metaYtd.toFixed(2),
        e.coberturaCobertosAB, e.coberturaCarteiraAB, e.coberturaPct.toFixed(2),
        e.medicoesValor.toFixed(2)
      ]);
    }

    const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(csvCell).join(sep)).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  window.FarolExecutivos = {
    open: () => load(false),
    refresh: () => load(true)
  };
})();
