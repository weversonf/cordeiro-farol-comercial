import { getPool, toNumber } from './_db.js';
import { requireAdminMaster } from './_auth.js';
import {
  buildBillingBaseCte,
  checkTableReadable,
  mapIndicadorUnitName
} from './_dw.js';

function isValidIsoDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(str || ''));
}

function addDaysIso(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function addYearsIso(isoDate, deltaYears) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y + deltaYears, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

function buildMonthsInRange(startDate, endDate) {
  const [sy, sm] = startDate.split('-').map(Number);
  const [ey, em] = endDate.split('-').map(Number);
  const list = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    list.push({ ano: String(y), mes: String(m).padStart(2, '0'), mesIso: `${y}-${String(m).padStart(2, '0')}` });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return list;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  const user = await requireAdminMaster(req, res);
  if (!user) return;

  const now = new Date();
  const currentYear = now.getFullYear();
  const todayIso = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rawStart = String(req.query?.startDate || `${currentYear}-01-01`).trim();
  const rawEnd = String(req.query?.endDate || todayIso).trim();
  const startDate = isValidIsoDate(rawStart) ? rawStart : `${currentYear}-01-01`;
  const endDate = isValidIsoDate(rawEnd) && rawEnd >= startDate ? rawEnd : startDate;
  const endExclusive = addDaysIso(endDate, 1);

  const escopo = req.query?.escopo === 'all' ? 'all' : 'pbix';
  const incluirExpurgos = req.query?.incluirExpurgos === '1';
  const unidadeFiltro = String(req.query?.unidade || '').trim();
  const clienteFiltro = String(req.query?.cliente || '').trim();
  const executivoFiltro = String(req.query?.executivo || '').trim();
  const buscaFiltro = String(req.query?.busca || '').trim();

  try {
    const pool = getPool();
    const baseCte = buildBillingBaseCte({ startParam: '$1', endParam: '$2', escopo });

    const whereParts = ['1=1'];
    const queryParams = [startDate, endExclusive];

    if (unidadeFiltro) {
      queryParams.push(unidadeFiltro);
      whereParts.push(`unidade = $${queryParams.length}`);
    }
    if (clienteFiltro) {
      queryParams.push(clienteFiltro);
      whereParts.push(`cliente = $${queryParams.length}`);
    }
    if (executivoFiltro) {
      queryParams.push(executivoFiltro);
      whereParts.push(`executivo = $${queryParams.length}`);
    }
    if (buscaFiltro) {
      queryParams.push(`%${buscaFiltro}%`);
      const p = `$${queryParams.length}`;
      whereParts.push(`(
        cliente ILIKE ${p}
        OR numero_documento ILIKE ${p}
        OR numero_contrato ILIKE ${p}
        OR produto ILIKE ${p}
        OR executivo ILIKE ${p}
        OR cnpj ILIKE ${p}
      )`);
    }

    const whereSql = whereParts.join(' AND ');
    const valorExpr = incluirExpurgos
      ? 'valor_total'
      : 'CASE WHEN NOT is_expurgo THEN valor_total ELSE 0 END';
    const filtroAtivoLinha = incluirExpurgos ? 'TRUE' : 'NOT is_expurgo';

    const prevStart = addYearsIso(startDate, -1);
    const prevEndExclusive = addYearsIso(endExclusive, -1);
    const prevParams = [prevStart, prevEndExclusive];
    const prevWhereParts = ['1=1'];
    if (unidadeFiltro) { prevParams.push(unidadeFiltro); prevWhereParts.push(`unidade = $${prevParams.length}`); }
    if (clienteFiltro) { prevParams.push(clienteFiltro); prevWhereParts.push(`cliente = $${prevParams.length}`); }
    if (executivoFiltro) { prevParams.push(executivoFiltro); prevWhereParts.push(`executivo = $${prevParams.length}`); }
    const prevWhereSql = prevWhereParts.join(' AND ');

    const monthsRange = buildMonthsInRange(startDate, endDate);
    const yearsInRange = [...new Set(monthsRange.map(m => m.ano))];

    // Consolida todas as agregações de faturamento em UMA única varredura sobre faturamento_base (evita fila no pool)
    const faturamentoAggQuery = `
      ${baseCte},
      filtrado AS (
        SELECT *
        FROM faturamento_base
        WHERE ${whereSql}
      ),
      resumo_agg AS (
        SELECT
          COALESCE(SUM(valor_total), 0) AS bruto,
          COALESCE(SUM(CASE WHEN NOT is_expurgo THEN valor_total ELSE 0 END), 0) AS liquido,
          COALESCE(SUM(CASE WHEN is_expurgo THEN valor_total ELSE 0 END), 0) AS expurgos,
          COUNT(*) FILTER (WHERE ${filtroAtivoLinha})::int AS qtd_itens,
          COUNT(DISTINCT (cod_filial || '|' || numero_documento || '|' || serie)) FILTER (WHERE ${filtroAtivoLinha})::int AS qtd_nfs,
          COUNT(DISTINCT cod_cliente) FILTER (WHERE ${filtroAtivoLinha})::int AS qtd_clientes
        FROM filtrado
      ),
      mensal_agg AS (
        SELECT
          mes_iso AS mes,
          COALESCE(SUM(valor_total), 0) AS bruto,
          COALESCE(SUM(CASE WHEN NOT is_expurgo THEN valor_total ELSE 0 END), 0) AS liquido,
          COALESCE(SUM(CASE WHEN is_expurgo THEN valor_total ELSE 0 END), 0) AS expurgos,
          COUNT(DISTINCT (cod_filial || '|' || numero_documento || '|' || serie)) FILTER (WHERE ${filtroAtivoLinha})::int AS qtd_nfs
        FROM filtrado
        GROUP BY 1
        ORDER BY 1
      ),
      unidades_agg AS (
        SELECT
          unidade,
          COALESCE(SUM(valor_total), 0) AS bruto,
          COALESCE(SUM(CASE WHEN NOT is_expurgo THEN valor_total ELSE 0 END), 0) AS liquido,
          COALESCE(SUM(CASE WHEN is_expurgo THEN valor_total ELSE 0 END), 0) AS expurgos,
          COUNT(DISTINCT (cod_filial || '|' || numero_documento || '|' || serie)) FILTER (WHERE ${filtroAtivoLinha})::int AS qtd_nfs,
          COUNT(DISTINCT cod_cliente) FILTER (WHERE ${filtroAtivoLinha})::int AS qtd_clientes
        FROM filtrado
        GROUP BY 1
        ORDER BY ${incluirExpurgos ? 'bruto' : 'liquido'} DESC
      ),
      clientes_agg AS (
        SELECT
          cod_cliente,
          cliente,
          MAX(cnpj) AS cnpj,
          (ARRAY_AGG(unidade ORDER BY valor_total DESC))[1] AS unidade_principal,
          COUNT(DISTINCT (cod_filial || '|' || numero_documento || '|' || serie))::int AS qtd_nfs,
          COUNT(DISTINCT NULLIF(numero_contrato, ''))::int AS qtd_contratos,
          MAX(emissao)::text AS ultima_emissao,
          COALESCE(SUM(${valorExpr}), 0) AS valor
        FROM filtrado
        WHERE ${filtroAtivoLinha}
        GROUP BY 1, 2
        ORDER BY valor DESC
        LIMIT 100
      ),
      executivos_agg AS (
        SELECT
          cod_vendedor,
          executivo,
          COUNT(DISTINCT (cod_filial || '|' || numero_documento || '|' || serie))::int AS qtd_nfs,
          COUNT(DISTINCT cod_cliente)::int AS qtd_clientes,
          COALESCE(SUM(${valorExpr}), 0) AS valor
        FROM filtrado
        WHERE ${filtroAtivoLinha}
        GROUP BY 1, 2
        ORDER BY valor DESC
      ),
      margem_agg AS (
        SELECT
          COALESCE(margem, 'Não informada') AS margem,
          COUNT(*)::int AS qtd_itens,
          COUNT(DISTINCT (cod_filial || '|' || numero_documento || '|' || serie))::int AS qtd_nfs,
          COALESCE(SUM(${valorExpr}), 0) AS valor
        FROM filtrado
        WHERE ${filtroAtivoLinha}
        GROUP BY 1
        ORDER BY valor DESC
      ),
      produtos_agg AS (
        SELECT
          produto,
          COUNT(*)::int AS qtd_itens,
          COUNT(DISTINCT (cod_filial || '|' || numero_documento || '|' || serie))::int AS qtd_nfs,
          COALESCE(SUM(${valorExpr}), 0) AS valor
        FROM filtrado
        WHERE ${filtroAtivoLinha}
        GROUP BY 1
        ORDER BY valor DESC
        LIMIT 20
      ),
      analitico_total AS (
        SELECT COUNT(*)::int AS total_registros
        FROM filtrado
        WHERE ${filtroAtivoLinha}
      ),
      analitico_rows AS (
        SELECT
          id::text AS id,
          TO_CHAR(emissao, 'YYYY-MM-DD') AS emissao,
          cod_filial,
          numero_documento,
          serie,
          unidade,
          cod_cliente,
          cliente,
          executivo,
          numero_contrato,
          produto,
          tes,
          cfop,
          COALESCE(margem, '—') AS margem,
          quantidade,
          valor_unitario,
          valor_total,
          is_expurgo
        FROM filtrado
        WHERE ${filtroAtivoLinha}
        ORDER BY emissao DESC, numero_documento DESC, id DESC
        LIMIT 1500
      ),
      filtros_opcoes AS (
        SELECT
          ARRAY_AGG(DISTINCT unidade ORDER BY unidade) FILTER (WHERE unidade IS NOT NULL) AS unidades,
          ARRAY_AGG(DISTINCT cliente ORDER BY cliente) FILTER (WHERE cliente IS NOT NULL) AS clientes,
          ARRAY_AGG(DISTINCT executivo ORDER BY executivo) FILTER (WHERE executivo IS NOT NULL) AS executivos
        FROM faturamento_base
      )
      SELECT
        (SELECT ROW_TO_JSON(resumo_agg) FROM resumo_agg) AS resumo,
        COALESCE((SELECT JSON_AGG(mensal_agg) FROM mensal_agg), '[]'::json) AS mensal,
        COALESCE((SELECT JSON_AGG(unidades_agg) FROM unidades_agg), '[]'::json) AS por_unidade,
        COALESCE((SELECT JSON_AGG(clientes_agg) FROM clientes_agg), '[]'::json) AS por_cliente,
        COALESCE((SELECT JSON_AGG(executivos_agg) FROM executivos_agg), '[]'::json) AS por_executivo,
        COALESCE((SELECT JSON_AGG(margem_agg) FROM margem_agg), '[]'::json) AS por_margem,
        COALESCE((SELECT JSON_AGG(produtos_agg) FROM produtos_agg), '[]'::json) AS por_produto,
        (SELECT total_registros FROM analitico_total) AS total_registros,
        COALESCE((SELECT JSON_AGG(analitico_rows) FROM analitico_rows), '[]'::json) AS analitico,
        (SELECT ROW_TO_JSON(filtros_opcoes) FROM filtros_opcoes) AS filtros
    `;

    const [
      aggRes,
      prevResumoRes,
      metasRes,
      metaExecRes,
      freshnessRes,
      se1GoldPriv,
      se1RawPriv
    ] = await Promise.all([
      pool.query(faturamentoAggQuery, queryParams),
      pool.query(`
        ${baseCte}
        SELECT
          COALESCE(SUM(valor_total), 0) AS bruto,
          COALESCE(SUM(CASE WHEN NOT is_expurgo THEN valor_total ELSE 0 END), 0) AS liquido
        FROM faturamento_base
        WHERE ${prevWhereSql}
      `, prevParams),
      pool.query(`
        SELECT
          zi0_ano AS ano,
          zi1_mes AS mes,
          zi0_unidad AS cod_unidade,
          COALESCE(SUM(zi1_vlmalv), 0) AS meta_alvo,
          COALESCE(SUM(zi1_vlrmet), 0) AS meta_base
        FROM comercial.indicador_unidade
        WHERE zi0_ano = ANY($1::text[])
          AND zi0_status = 'A'
          AND zi0_metric = '000001'
        GROUP BY 1, 2, 3
        ORDER BY 1, 2, 3
      `, [yearsInRange]),
      pool.query(`
        SELECT
          EXTRACT(YEAR FROM data_referencia)::int AS ano,
          TRIM(cod_vendedor) AS cod_vendedor,
          MAX(valor_alvo) AS meta_anual
        FROM comercial.dim_meta_vendedores
        WHERE EXTRACT(YEAR FROM data_referencia)::int = ANY($1::int[])
          AND TRIM(COALESCE(cod_vendedor, '')) <> ''
          AND UPPER(COALESCE(descricao, '')) NOT LIKE '%NPS%'
        GROUP BY 1, 2
      `, [yearsInRange.map(Number)]),
      pool.query(`
        SELECT
          (SELECT MAX(emissao)::text FROM comercial.fato_itens_vendas) AS max_emissao,
          (SELECT MAX(data_alteracao)::text FROM comercial.fato_itens_vendas) AS max_alteracao,
          (SELECT COUNT(*)::int FROM comercial.faturamento_bruto) AS fat_bruto_rows
      `),
      checkTableReadable(pool, 'financeiro', 'protheus_se1_gold_nota_fiscais_entrada'),
      checkTableReadable(pool, 'stage_protheus', 'se1010')
    ]);

    const agg = aggRes.rows[0] || {};
    const resRow = agg.resumo || {};
    const prevRow = prevResumoRes.rows[0] || {};

    // Mapear metas do período por mês e por unidade (somente meses incluídos no range)
    const monthSet = new Set(monthsRange.map(m => m.mesIso));
    const metaPorMes = {};
    const metaPorUnidade = {};
    for (const r of metasRes.rows) {
      const mIso = `${String(r.ano).trim()}-${String(r.mes).trim().padStart(2, '0')}`;
      if (!monthSet.has(mIso)) continue;
      const metaVal = toNumber(r.meta_alvo);
      const unitName = mapIndicadorUnitName(r.cod_unidade);
      if (!unidadeFiltro || unidadeFiltro.toLowerCase() === unitName.toLowerCase()) {
        metaPorMes[mIso] = (metaPorMes[mIso] || 0) + metaVal;
        metaPorUnidade[unitName] = (metaPorUnidade[unitName] || 0) + metaVal;
      }
    }

    // Mapear meta anual por executivo (somar apenas 1x por ano distinto presente no filtro, nunca 12x!)
    const metaExecMap = {};
    for (const r of metaExecRes.rows) {
      const cod = String(r.cod_vendedor || '').trim();
      metaExecMap[cod] = (metaExecMap[cod] || 0) + toNumber(r.meta_anual);
    }

    const bruto = toNumber(resRow.bruto);
    const liquido = toNumber(resRow.liquido);
    const expurgos = toNumber(resRow.expurgos);
    const valorFoco = incluirExpurgos ? bruto : liquido;
    const prevValor = incluirExpurgos ? toNumber(prevRow.bruto) : toNumber(prevRow.liquido);
    const qtdNfs = Number(resRow.qtd_nfs || 0);
    const metaPeriodo = Object.values(metaPorMes).reduce((a, b) => a + b, 0);

    const porUnidade = (agg.por_unidade || []).map(r => {
      const val = incluirExpurgos ? toNumber(r.bruto) : toNumber(r.liquido);
      const meta = metaPorUnidade[r.unidade] || 0;
      return {
        unidade: r.unidade,
        bruto: toNumber(r.bruto),
        liquido: toNumber(r.liquido),
        expurgos: toNumber(r.expurgos),
        valor: val,
        qtdNfs: Number(r.qtd_nfs || 0),
        qtdClientes: Number(r.qtd_clientes || 0),
        participacaoPct: valorFoco > 0 ? (val / valorFoco) * 100 : 0,
        meta,
        atingimentoPct: meta > 0 ? (val / meta) * 100 : null
      };
    });

    let acumuladoCli = 0;
    const porCliente = (agg.por_cliente || []).map(r => {
      const val = toNumber(r.valor);
      acumuladoCli += val;
      return {
        codCliente: r.cod_cliente,
        cliente: r.cliente,
        cnpj: r.cnpj || '—',
        unidadePrincipal: r.unidade_principal || '—',
        qtdNfs: Number(r.qtd_nfs || 0),
        qtdContratos: Number(r.qtd_contratos || 0),
        ultimaEmissao: r.ultima_emissao ? String(r.ultima_emissao).slice(0, 10) : null,
        valor: val,
        participacaoPct: valorFoco > 0 ? (val / valorFoco) * 100 : 0,
        acumuladoPct: valorFoco > 0 ? (acumuladoCli / valorFoco) * 100 : 0
      };
    });

    const porExecutivo = (agg.por_executivo || []).map(r => {
      const val = toNumber(r.valor);
      const metaAnual = metaExecMap[r.cod_vendedor] || 0;
      return {
        codVendedor: r.cod_vendedor,
        executivo: r.executivo,
        qtdNfs: Number(r.qtd_nfs || 0),
        qtdClientes: Number(r.qtd_clientes || 0),
        valor: val,
        participacaoPct: valorFoco > 0 ? (val / valorFoco) * 100 : 0,
        metaAnual: metaAnual > 0 ? metaAnual : null
      };
    });

    // Seção separada: Recebimentos Efetivos (SE1 — data de baixa/liquidação real)
    let recebimentos;
    if (se1GoldPriv.canSelect) {
      const [recResumo, recMensal, recClientes] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*)::int AS qtd_titulos,
            COALESCE(SUM(valor_liquido_ultima_baixa), 0) AS valor_recebido,
            COALESCE(SUM(valor_titulo), 0) AS valor_original,
            COALESCE(SUM(valor_juros + valor_multa), 0) AS juros_multa,
            COALESCE(SUM(valor_desconto), 0) AS descontos,
            MAX(data_ultima_baixa)::text AS ultima_baixa
          FROM financeiro.protheus_se1_gold_nota_fiscais_entrada
          WHERE data_ultima_baixa >= $1::date
            AND data_ultima_baixa < $2::date
            AND tipo_registro = 'TITULO'
            AND valor_liquido_ultima_baixa > 0
        `, [startDate, endExclusive]),
        pool.query(`
          SELECT
            TO_CHAR(DATE_TRUNC('month', data_ultima_baixa), 'YYYY-MM') AS mes,
            COUNT(*)::int AS qtd_titulos,
            COALESCE(SUM(valor_liquido_ultima_baixa), 0) AS valor_recebido
          FROM financeiro.protheus_se1_gold_nota_fiscais_entrada
          WHERE data_ultima_baixa >= $1::date
            AND data_ultima_baixa < $2::date
            AND tipo_registro = 'TITULO'
            AND valor_liquido_ultima_baixa > 0
          GROUP BY 1 ORDER BY 1
        `, [startDate, endExclusive]),
        pool.query(`
          SELECT
            TRIM(nome_cliente) AS cliente,
            COUNT(*)::int AS qtd_titulos,
            MAX(data_ultima_baixa)::text AS ultima_baixa,
            COALESCE(SUM(valor_liquido_ultima_baixa), 0) AS valor_recebido
          FROM financeiro.protheus_se1_gold_nota_fiscais_entrada
          WHERE data_ultima_baixa >= $1::date
            AND data_ultima_baixa < $2::date
            AND tipo_registro = 'TITULO'
            AND valor_liquido_ultima_baixa > 0
          GROUP BY 1 ORDER BY 4 DESC LIMIT 25
        `, [startDate, endExclusive])
      ]);
      const rr = recResumo.rows[0] || {};
      recebimentos = {
        disponivel: true,
        fonte: 'financeiro.protheus_se1_gold_nota_fiscais_entrada (SE1)',
        regraData: 'data_ultima_baixa (e1_baixa — liquidação financeira real)',
        resumo: {
          qtdTitulos: Number(rr.qtd_titulos || 0),
          valorRecebido: toNumber(rr.valor_recebido),
          valorOriginal: toNumber(rr.valor_original),
          jurosMulta: toNumber(rr.juros_multa),
          descontos: toNumber(rr.descontos),
          ultimaBaixa: rr.ultima_baixa ? String(rr.ultima_baixa).slice(0, 10) : null
        },
        mensal: recMensal.rows.map(r => ({
          mes: r.mes,
          qtdTitulos: Number(r.qtd_titulos || 0),
          valorRecebido: toNumber(r.valor_recebido)
        })),
        porCliente: recClientes.rows.map(r => ({
          cliente: r.cliente || 'Não identificado',
          qtdTitulos: Number(r.qtd_titulos || 0),
          ultimaBaixa: r.ultima_baixa ? String(r.ultima_baixa).slice(0, 10) : null,
          valorRecebido: toNumber(r.valor_recebido)
        }))
      };
    } else {
      recebimentos = {
        disponivel: false,
        status: 'pendente_permissao_dw',
        fonteEsperada: 'financeiro.protheus_se1_gold_nota_fiscais_entrada / stage_protheus.se1010',
        regraData: 'data_ultima_baixa (e1_baixa) — nunca usar data de emissão como recebimento',
        diagnostico: {
          se1GoldExiste: se1GoldPriv.exists,
          se1GoldUsage: se1GoldPriv.hasUsage,
          se1GoldSelect: se1GoldPriv.canSelect,
          se1RawExiste: se1RawPriv.exists,
          se1RawUsage: se1RawPriv.hasUsage,
          se1RawSelect: se1RawPriv.canSelect
        },
        motivo: 'O usuário de leitura do Farol no PostgreSQL não possui permissão USAGE no schema financeiro/stage_protheus nem SELECT nas tabelas SE1010 / protheus_se1_gold_nota_fiscais_entrada.',
        acaoNecessaria: 'Solicitar ao DBA: GRANT USAGE ON SCHEMA financeiro TO <usuario_farol>; GRANT SELECT ON financeiro.protheus_se1_gold_nota_fiscais_entrada TO <usuario_farol>;'
      };
    }

    const filtrosRow = agg.filtros || {};
    const freshRow = freshnessRes.rows[0] || {};
    const analiticoRows = agg.analitico || [];
    const totalRegistrosAnalitico = Number(agg.total_registros || 0);

    return res.status(200).json({
      ok: true,
      geradoEm: new Date().toISOString(),
      periodo: { startDate, endDate },
      parametros: {
        escopo,
        incluirExpurgos,
        unidade: unidadeFiltro,
        cliente: clienteFiltro,
        executivo: executivoFiltro,
        busca: buscaFiltro
      },
      fontes: {
        faturamentoPrincipal: 'comercial.fato_itens_vendas (SD2 · deduplicação multi-cliente + TES comerciais + CFOP receita)',
        metasUnidades: 'comercial.indicador_unidade (ZI0/ZI1 · ZI1_VLMALV)',
        metasExecutivos: 'comercial.dim_meta_vendedores (alvo anual deduplicado)',
        faturamentoBrutoLegadoRows: Number(freshRow.fat_bruto_rows || 0)
      },
      atualizacao: {
        protheusUltimaEmissao: freshRow.max_emissao ? String(freshRow.max_emissao).slice(0, 10) : null,
        protheusUltimaAlteracao: freshRow.max_alteracao || null
      },
      resumo: {
        valorPrincipal: valorFoco,
        faturamentoLiquido: liquido,
        faturamentoBruto: bruto,
        expurgos,
        qtdNfs,
        qtdItens: Number(resRow.qtd_itens || 0),
        qtdClientes: Number(resRow.qtd_clientes || 0),
        ticketMedioNf: qtdNfs > 0 ? valorFoco / qtdNfs : 0,
        metaPeriodo,
        atingimentoPct: metaPeriodo > 0 ? (valorFoco / metaPeriodo) * 100 : null,
        variacaoYoYPct: prevValor > 0 ? ((valorFoco - prevValor) / prevValor) * 100 : null,
        valorAnoAnterior: prevValor
      },
      filtros: {
        unidades: filtrosRow.unidades || [],
        clientes: filtrosRow.clientes || [],
        executivos: filtrosRow.executivos || []
      },
      mensal: (agg.mensal || []).map(r => ({
        mes: r.mes,
        bruto: toNumber(r.bruto),
        liquido: toNumber(r.liquido),
        expurgos: toNumber(r.expurgos),
        valor: incluirExpurgos ? toNumber(r.bruto) : toNumber(r.liquido),
        qtdNfs: Number(r.qtd_nfs || 0),
        meta: metaPorMes[r.mes] || 0
      })),
      porUnidade,
      porCliente,
      porExecutivo,
      porMargem: (agg.por_margem || []).map(r => ({
        margem: r.margem,
        qtdItens: Number(r.qtd_itens || 0),
        qtdNfs: Number(r.qtd_nfs || 0),
        valor: toNumber(r.valor),
        participacaoPct: valorFoco > 0 ? (toNumber(r.valor) / valorFoco) * 100 : 0
      })),
      porProduto: (agg.por_produto || []).map(r => ({
        produto: r.produto,
        qtdItens: Number(r.qtd_itens || 0),
        qtdNfs: Number(r.qtd_nfs || 0),
        valor: toNumber(r.valor),
        participacaoPct: valorFoco > 0 ? (toNumber(r.valor) / valorFoco) * 100 : 0
      })),
      analitico: {
        totalRegistros: totalRegistrosAnalitico,
        exibidos: analiticoRows.length,
        truncado: totalRegistrosAnalitico > analiticoRows.length,
        linhas: analiticoRows.map(r => ({
          id: r.id,
          emissao: r.emissao,
          codFilial: r.cod_filial,
          numeroDocumento: r.numero_documento,
          serie: r.serie,
          unidade: r.unidade,
          codCliente: r.cod_cliente,
          cliente: r.cliente,
          executivo: r.executivo,
          numeroContrato: r.numero_contrato || '—',
          produto: r.produto,
          tes: r.tes,
          cfop: r.cfop,
          margem: r.margem,
          quantidade: toNumber(r.quantidade),
          valorUnitario: toNumber(r.valor_unitario),
          valorTotal: toNumber(r.valor_total),
          isExpurgo: Boolean(r.is_expurgo)
        }))
      },
      recebimentos
    });
  } catch (error) {
    console.error('Falha ao consultar painel de Faturamento:', error);
    return res.status(500).json({ ok: false, error: 'Não foi possível consultar o faturamento no DW agora.' });
  }
}
