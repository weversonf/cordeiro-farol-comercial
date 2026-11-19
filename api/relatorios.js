import { getPool, toNumber as number } from './_db.js';
import { requireAdminMaster } from './_auth.js';
import { buildBillingBaseCte, normalizeDealUnitSql, safeNumericDealSql } from './_dw.js';

function cleanParam(val) {
  const s = String(val ?? '').trim();
  return s ? s : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  const user = await requireAdminMaster(req, res);
  if (!user) return;

  const requestedYear = Number(req.query?.year);
  const currentYear = new Date().getFullYear();
  const year = Number.isInteger(requestedYear) && requestedYear >= 2023 && requestedYear <= currentYear + 1
    ? requestedYear
    : currentYear;
  const start = `${year}-01-01`;
  const end = `${year + 1}-01-01`;

  const rawMes = cleanParam(req.query?.mes);
  const mesFiltro = rawMes && /^\d{4}-\d{2}$/.test(rawMes) ? rawMes : null;
  const unidadeFiltro = cleanParam(req.query?.unidade);
  const contratoFiltro = cleanParam(req.query?.contrato);
  const equipamentoFiltro = cleanParam(req.query?.equipamento);
  const consultorFiltro = cleanParam(req.query?.consultor);

  try {
    const client = getPool();
    const hasFatBrutoRes = await client.query(`SELECT EXISTS (SELECT 1 FROM comercial.faturamento_bruto LIMIT 1) AS has_rows`);
    const useFatBruto = Boolean(hasFatBrutoRes.rows[0]?.has_rows);

    const protheusParams = [
      start,
      end,
      mesFiltro,
      unidadeFiltro,
      contratoFiltro,
      equipamentoFiltro,
      consultorFiltro
    ];

    const baseSourceCte = useFatBruto
      ? `
        WITH faturamento_base AS (
          SELECT
            f.data_emissao AS emissao,
            TO_CHAR(DATE_TRUNC('month', f.data_emissao), 'YYYY-MM') AS mes_iso,
            CASE LEFT(TRIM(COALESCE(f.cod_centro_custo::text, '')), 3)
              WHEN '413' THEN 'Pecém'
              WHEN '414' THEN 'Wind'
              WHEN '423' THEN 'Wind'
              WHEN '415' THEN 'Engenharia'
              WHEN '416' THEN 'Norte'
              WHEN '417' THEN 'Complexo'
              WHEN '424' THEN 'Complexo'
              WHEN '425' THEN 'Complexo'
              WHEN '420' THEN 'Transportes'
              ELSE COALESCE(NULLIF(TRIM(f.unidade), ''), 'Outras / Controladoria')
            END AS unidade,
            TRIM(COALESCE(f.numero_contrato::text, '')) AS numero_contrato,
            COALESCE(NULLIF(TRIM(f.nome_curto), ''), 'Cliente não identificado') AS cliente,
            COALESCE(NULLIF(TRIM(f.descricao_produto), ''), 'Produto não identificado') AS produto,
            COALESCE(NULLIF(TRIM(dv.nome_vendedor), ''), NULLIF(TRIM(f.cod_vendedor::text), ''), 'Sem consultor identificado') AS executivo,
            COALESCE(f.valor_bruto, 0)::numeric AS valor_total,
            (
              TRIM(COALESCE(f.cod_filial::text, '')) IN ('121201', '101001', '040401', '111101')
              OR TRIM(COALESCE(f.cod_vendedor::text, '')) IN ('00049', '000050')
            ) AS is_expurgo
          FROM comercial.faturamento_bruto f
          LEFT JOIN (
            SELECT DISTINCT ON (TRIM(cod_vendedor::text))
              TRIM(cod_vendedor::text) AS codigo,
              NULLIF(TRIM(nome_vendedor), '') AS nome_vendedor
            FROM comercial.dim_vendedor
            ORDER BY TRIM(cod_vendedor::text), id DESC
          ) dv ON dv.codigo = TRIM(COALESCE(f.cod_vendedor::text, ''))
          WHERE f.data_emissao >= $1::date AND f.data_emissao < $2::date
        )
      `
      : buildBillingBaseCte({ startParam: '$1', endParam: '$2', escopo: 'pbix' });

    const crossProtheusQuery = `
      ${baseSourceCte},
      base_anotada AS (
        SELECT
          mes_iso,
          unidade,
          numero_contrato,
          cliente,
          produto,
          executivo,
          valor_total,
          is_expurgo,
          ($3::text IS NULL OR mes_iso = $3::text) AS match_mes,
          ($4::text IS NULL OR LOWER(unidade) = LOWER($4::text)) AS match_unid,
          ($5::text IS NULL OR numero_contrato = $5::text) AS match_ctr,
          ($6::text IS NULL OR produto = $6::text) AS match_eqp,
          ($7::text IS NULL OR LOWER(executivo) = LOWER($7::text)) AS match_cons
        FROM faturamento_base
      ),
      resumo_agg AS (
        SELECT
          COALESCE(SUM(valor_total) FILTER (WHERE match_mes AND match_unid AND match_ctr AND match_eqp AND match_cons), 0) AS bruto,
          COALESCE(SUM(valor_total) FILTER (WHERE NOT is_expurgo AND match_mes AND match_unid AND match_ctr AND match_eqp AND match_cons), 0) AS liquido
        FROM base_anotada
      ),
      mensal_agg AS (
        SELECT
          mes_iso AS mes,
          COALESCE(SUM(valor_total), 0) AS valor
        FROM base_anotada
        WHERE NOT is_expurgo AND match_unid AND match_ctr AND match_eqp AND match_cons
        GROUP BY 1
        ORDER BY 1
      ),
      unidades_agg AS (
        SELECT
          unidade,
          COALESCE(SUM(valor_total), 0) AS valor
        FROM base_anotada
        WHERE NOT is_expurgo AND match_mes AND match_ctr AND match_eqp AND match_cons
        GROUP BY 1
        HAVING COALESCE(SUM(valor_total), 0) > 0
        ORDER BY valor DESC
        LIMIT 10
      ),
      contratos_agg AS (
        SELECT
          numero_contrato AS contrato,
          MAX(cliente) AS cliente,
          COALESCE(SUM(valor_total), 0) AS valor
        FROM base_anotada
        WHERE NOT is_expurgo AND NULLIF(numero_contrato, '') IS NOT NULL AND match_mes AND match_unid AND match_eqp AND match_cons
        GROUP BY 1
        HAVING COALESCE(SUM(valor_total), 0) > 0
        ORDER BY valor DESC
        LIMIT 10
      ),
      equipamentos_agg AS (
        SELECT
          produto AS equipamento,
          COALESCE(SUM(valor_total), 0) AS valor
        FROM base_anotada
        WHERE NOT is_expurgo AND match_mes AND match_unid AND match_ctr AND match_cons
        GROUP BY 1
        HAVING COALESCE(SUM(valor_total), 0) > 0
        ORDER BY valor DESC
        LIMIT 10
      ),
      consultores_agg AS (
        SELECT
          executivo AS consultor,
          COALESCE(SUM(valor_total), 0) AS valor
        FROM base_anotada
        WHERE NOT is_expurgo AND match_mes AND match_unid AND match_ctr AND match_eqp
        GROUP BY 1
        HAVING COALESCE(SUM(valor_total), 0) > 0
        ORDER BY valor DESC
        LIMIT 10
      )
      SELECT
        (SELECT ROW_TO_JSON(resumo_agg) FROM resumo_agg) AS resumo,
        COALESCE((SELECT JSON_AGG(mensal_agg) FROM mensal_agg), '[]'::json) AS mensal,
        COALESCE((SELECT JSON_AGG(unidades_agg) FROM unidades_agg), '[]'::json) AS unidades,
        COALESCE((SELECT JSON_AGG(contratos_agg) FROM contratos_agg), '[]'::json) AS contratos,
        COALESCE((SELECT JSON_AGG(equipamentos_agg) FROM equipamentos_agg), '[]'::json) AS equipamentos,
        COALESCE((SELECT JSON_AGG(consultores_agg) FROM consultores_agg), '[]'::json) AS consultores
    `;

    // Pipeline Bitrix aceita recorte por unidade e/ou consultor selecionados no painel
    const unitSql = normalizeDealUnitSql('d', 'uf');
    const oppSql = safeNumericDealSql('d."OPPORTUNITY"');
    const bitrixWhere = [];
    const bitrixParams = [];

    if (unidadeFiltro) {
      bitrixParams.push(unidadeFiltro);
      bitrixWhere.push(`LOWER(unidade_deal) = LOWER($${bitrixParams.length})`);
    }
    if (consultorFiltro) {
      bitrixParams.push(consultorFiltro);
      bitrixWhere.push(`LOWER(consultor) = LOWER($${bitrixParams.length})`);
    }
    const bitrixWhereSql = bitrixWhere.length ? `WHERE ${bitrixWhere.join(' AND ')}` : '';

    // Totais completos do pipeline respeitando apenas filtro de unidade (para manter lista de consultores clicável quando um consultor é filtrado)
    const pipeUnitOnlySql = unidadeFiltro ? `WHERE LOWER(unidade_deal) = LOWER($1)` : '';
    const pipeRankParams = unidadeFiltro ? [unidadeFiltro] : [];
    const pipelineRankingQuery = `
      WITH pipe_base AS (
        SELECT
          COALESCE(NULLIF(TRIM(CONCAT(u."NAME", ' ', COALESCE(u."LAST_NAME", ''))), ''), 'Sem consultor') AS consultor,
          ${unitSql} AS unidade_deal,
          ${oppSql} AS valor
        FROM stage_bitrix.b_crm_deal d
        LEFT JOIN stage_bitrix.b_crm_deal_uf uf ON uf."ID"::text = d."ID"::text
        LEFT JOIN stage_bitrix.b_user u ON u."ID"::text = d."ASSIGNED_BY_ID"::text
        WHERE d."CATEGORY_ID" IN ('4', '19')
          AND d."STAGE_SEMANTIC_ID" = 'P'
      )
      SELECT
        consultor,
        COUNT(*)::int AS negocios,
        COALESCE(SUM(valor), 0) AS valor
      FROM pipe_base
      ${pipeUnitOnlySql}
      GROUP BY 1
      ORDER BY valor DESC
      LIMIT 10
    `;

    const pipelineKpiQuery = `
      WITH pipe_base AS (
        SELECT
          COALESCE(NULLIF(TRIM(CONCAT(u."NAME", ' ', COALESCE(u."LAST_NAME", ''))), ''), 'Sem consultor') AS consultor,
          ${unitSql} AS unidade_deal,
          ${oppSql} AS valor
        FROM stage_bitrix.b_crm_deal d
        LEFT JOIN stage_bitrix.b_crm_deal_uf uf ON uf."ID"::text = d."ID"::text
        LEFT JOIN stage_bitrix.b_user u ON u."ID"::text = d."ASSIGNED_BY_ID"::text
        WHERE d."CATEGORY_ID" IN ('4', '19')
          AND d."STAGE_SEMANTIC_ID" = 'P'
      )
      SELECT
        COUNT(*)::int AS negocios,
        COALESCE(SUM(valor), 0) AS valor
      FROM pipe_base
      ${bitrixWhereSql}
    `;

    const freshnessQuery = useFatBruto
      ? `SELECT (SELECT MAX(data_emissao) FROM comercial.faturamento_bruto) AS protheus, (SELECT MAX("DATE_MODIFY") FROM stage_bitrix.b_crm_deal) AS bitrix`
      : `SELECT (SELECT MAX(emissao) FROM comercial.fato_itens_vendas) AS protheus, (SELECT MAX("DATE_MODIFY") FROM stage_bitrix.b_crm_deal) AS bitrix`;

    const [protheusAggRes, pipeRankRes, pipeKpiRes, atualizacaoRes] = await Promise.all([
      client.query(crossProtheusQuery, protheusParams),
      client.query(pipelineRankingQuery, pipeRankParams),
      client.query(pipelineKpiQuery, bitrixParams),
      client.query(freshnessQuery)
    ]);

    const aggRow = protheusAggRes.rows[0] || {};
    const resumo = aggRow.resumo || {};
    const pipeKpi = pipeKpiRes.rows[0] || {};
    const pipeline = (pipeRankRes.rows || []).map(row => ({
      consultor: row.consultor,
      negocios: number(row.negocios),
      valor: number(row.valor)
    }));

    return res.status(200).json({
      ok: true,
      ano: year,
      geradoEm: new Date().toISOString(),
      filtrosAtivos: {
        mes: mesFiltro,
        unidade: unidadeFiltro,
        contrato: contratoFiltro,
        equipamento: equipamentoFiltro,
        consultor: consultorFiltro
      },
      fontes: {
        protheus: useFatBruto ? 'comercial.faturamento_bruto (SD2)' : 'comercial.fato_itens_vendas (SD2)',
        bitrix: 'stage_bitrix.b_crm_deal'
      },
      atualizacao: atualizacaoRes.rows[0] || {},
      resumo: {
        bruto: number(resumo.bruto),
        liquido: number(resumo.liquido),
        pipeline: number(pipeKpi.valor),
        negociosPipeline: number(pipeKpi.negocios)
      },
      mensal: (aggRow.mensal || []).map(row => ({ mes: row.mes, valor: number(row.valor) })),
      unidades: (aggRow.unidades || []).map(row => ({ unidade: row.unidade, valor: number(row.valor) })),
      contratos: (aggRow.contratos || []).map(row => ({
        contrato: row.contrato,
        cliente: row.cliente || 'Cliente não identificado',
        valor: number(row.valor)
      })),
      equipamentos: (aggRow.equipamentos || []).map(row => ({ equipamento: row.equipamento, valor: number(row.valor) })),
      consultores: (aggRow.consultores || []).map(row => ({ consultor: row.consultor, valor: number(row.valor) })),
      pipeline
    });
  } catch (error) {
    console.error('Falha ao consultar relatórios:', error);
    return res.status(500).json({ ok: false, error: 'Não foi possível atualizar os relatórios agora.' });
  }
}
