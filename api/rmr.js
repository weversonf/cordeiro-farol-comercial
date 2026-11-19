import { getPool, toNumber } from './_db.js';
import { requireAdminMaster } from './_auth.js';
import {
  buildBillingBaseCte,
  mapIndicadorUnitName,
  normalizeDealUnitSql,
  safeNumericDealSql
} from './_dw.js';

const EXPURGO_UNIDADES_SET = new Set(['CM Máquinas', 'Central ADM', 'Metalmecânica', 'Outras / Controladoria']);

function isCanceladoOuDeclinado(motivoRaw) {
  if (!motivoRaw) return false;
  const m = String(motivoRaw)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (m.includes('limpeza crm') || m.includes('executivo anterior')) return true;
  if (m.includes('cancelad') || m.includes('cancelou') || m.includes('cancelamento')) return true;
  if (m.includes('declinad') || m.includes('declinou')) return true;
  if (m.includes('desistiu') || m.includes('desistencia') || m.includes('desprogramad') || m.includes('desprogramou')) return true;
  if (m.includes('orcamento orientativo') || m.includes('nao apresentou proposta')) return true;
  if (m.includes('nao ira mais realizar') || m.includes('nao vai mais necessitar') || m.includes('nao vamos mais precisar') || m.includes('nao vao mais precisar')) return true;
  if (m.includes('optou por nao continuar') || m.includes('optou em nao continuar')) return true;
  if (m.includes('nao precisou dos equipamentos') || m.includes('nao sera mais necessario')) return true;
  if (m.includes('atividade nao realizada') || m.includes('servico nao executado') || m.includes('operacao nao foi viabilizada')) return true;
  if (m.includes('nao aprovad') || m.includes('nao aprovou') || m.includes('aprovacao negada') || m.includes('sem aprovacao do cliente')) return true;
  if (m.includes('invalid') || m.includes('licitacao')) return true;
  return false;
}

function getStageWeight(stageId, categoryId) {
  const s = String(stageId || '');
  if (s === 'C19:PREPAYMENT_INVOIC') return { peso: 0.5, grupo: 'Curto Prazo (1-2m)', etapaLabel: 'Fechamento Curto Prazo' };
  if (s === 'C19:PREPARATION') return { peso: 0.25, grupo: 'Médio Prazo (3-5m)', etapaLabel: 'Fechamento Médio Prazo' };
  if (s === 'C19:NEW') return { peso: 0.1, grupo: 'Longo Prazo (6-12m)', etapaLabel: 'Fechamento Longo Prazo' };
  if (s === 'C4:UC_RPFFJU' || s === 'C4:UC_2ZQLVL') return { peso: 0.9, grupo: 'Ganho / Atendimento', etapaLabel: 'Ganho / Em Atendimento' };
  if (s === 'C4:UC_JDNYZT' || s === 'C4:UC_FOYMHF' || s === 'C4:UC_VHKW1X') return { peso: 0.85, grupo: 'Contratação / Jurídico', etapaLabel: 'Contrato / Jurídico / Assinatura' };
  if (s === 'C4:UC_14YH5M' || s === 'C4:UC_9K4V7E') return { peso: 0.55, grupo: 'Negociação / Proposta', etapaLabel: 'Em Negociação / Mobilização' };
  if (s === 'C4:UC_MJVUDX' || s === 'C4:UC_3I7OLC' || s === 'C4:UC_PTGX4A') return { peso: 0.35, grupo: 'Qualificação Técnica/Crédito', etapaLabel: 'Avaliação Técnica / Crédito' };
  if (String(categoryId) === '4') return { peso: 0.15, grupo: 'Prospecção / Demanda', etapaLabel: 'Prospecção / Avaliação Inicial' };
  return { peso: 0.2, grupo: 'Pipeline Comercial', etapaLabel: s || 'Sem etapa' };
}

function addMonths(year, month, delta) {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    mesIso: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  };
}

function monthRangeDates(year, monthStart, monthEndInclusive) {
  const start = `${year}-${String(monthStart).padStart(2, '0')}-01`;
  const next = addMonths(year, monthEndInclusive, 1);
  const endExclusive = `${next.year}-${String(next.month).padStart(2, '0')}-01`;
  return { start, endExclusive };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  const user = await requireAdminMaster(req, res);
  if (!user) return;

  // Data atual em BRT (-03:00)
  const nowBr = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const currentYear = nowBr.getUTCFullYear();
  const currentMonth = nowBr.getUTCMonth() + 1;
  const defaultRefMonth = currentMonth > 1 ? currentMonth - 1 : 12;
  const defaultRefYear = currentMonth > 1 ? currentYear : currentYear - 1;

  const reqYear = Number(req.query?.year);
  const reqMonth = Number(req.query?.month);
  const year = Number.isInteger(reqYear) && reqYear >= 2023 && reqYear <= currentYear + 1 ? reqYear : defaultRefYear;
  const month = Number.isInteger(reqMonth) && reqMonth >= 1 && reqMonth <= 12
    ? reqMonth
    : (year === defaultRefYear ? defaultRefMonth : 12);

  const escopo = req.query?.escopo === 'all' ? 'all' : 'pbix';
  const incluirExpurgos = req.query?.incluirExpurgos === '1';

  const mesRefIso = `${year}-${String(month).padStart(2, '0')}`;
  const prevM = addMonths(year, month, -1);
  const prevMesIso = prevM.mesIso;
  const prevYear = year - 1;

  // Consultamos o ano inteiro selecionado (para série mensal + YTD) e o ano anterior inteiro (para YoY mensal e acumulado)
  const { start: yearStart, endExclusive: yearEndExcl } = monthRangeDates(year, 1, 12);
  const { start: prevYearStart, endExclusive: prevYearEndExcl } = monthRangeDates(prevYear, 1, 12);

  const valorExpr = incluirExpurgos
    ? 'valor_total'
    : 'CASE WHEN NOT is_expurgo THEN valor_total ELSE 0 END';

  try {
    const pool = getPool();

    const baseCte = buildBillingBaseCte({ startParam: '$1', endParam: '$2', escopo });

    const privBatchRes = await pool.query(`
      SELECT
        n.nspname || '.' || c.relname AS obj,
        (has_schema_privilege(current_user, n.nspname, 'USAGE')
         AND pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT')) AS can_select
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname = 'comercial' AND c.relname IN (
        'protheus_gold_medicoes_pendentes',
        'contratos_operacional',
        'fato_apropriacao_receita_mensal',
        'fato_tempo_etapa_negocio',
        'dim_motivo_perda',
        'fato_negocios'
      ))
      OR (n.nspname = 'stage_bitrix' AND c.relname = 'b_crm_deal')
    `);
    const privMap = Object.fromEntries(privBatchRes.rows.map(r => [r.obj, Boolean(r.can_select)]));
    const permMedicoes = { canSelect: Boolean(privMap['comercial.protheus_gold_medicoes_pendentes']) };
    const permContratosOp = { canSelect: Boolean(privMap['comercial.contratos_operacional']) };
    const permAprop = { canSelect: Boolean(privMap['comercial.fato_apropriacao_receita_mensal']) };
    const permTempoEtapa = { canSelect: Boolean(privMap['comercial.fato_tempo_etapa_negocio']) };
    const permNegocios = { canSelect: Boolean(privMap['comercial.fato_negocios']) };
    const permBitrixDeal = { canSelect: Boolean(privMap['stage_bitrix.b_crm_deal']) };

    const rmrProtheusAggQuery = `
      ${baseCte},
      mensal_agg AS (
        SELECT
          mes_iso AS mes,
          COALESCE(SUM(valor_total), 0) AS bruto,
          COALESCE(SUM(CASE WHEN NOT is_expurgo THEN valor_total ELSE 0 END), 0) AS liquido,
          COALESCE(SUM(CASE WHEN is_expurgo THEN valor_total ELSE 0 END), 0) AS expurgos,
          COUNT(DISTINCT (cod_filial || '-' || numero_documento || '-' || serie)) AS qtd_nfs,
          COUNT(DISTINCT cod_cliente) AS qtd_clientes
        FROM faturamento_base
        GROUP BY 1
        ORDER BY 1
      ),
      unidades_agg AS (
        SELECT
          unidade,
          COALESCE(SUM(CASE WHEN mes_iso = $3 THEN ${valorExpr} ELSE 0 END), 0) AS realizado_mes,
          COALESCE(SUM(CASE WHEN mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS realizado_ytd,
          COALESCE(SUM(CASE WHEN mes_iso <= $3 THEN valor_total ELSE 0 END), 0) AS bruto_ytd,
          COALESCE(SUM(CASE WHEN mes_iso <= $3 AND is_expurgo THEN valor_total ELSE 0 END), 0) AS expurgo_ytd,
          COUNT(DISTINCT CASE WHEN mes_iso <= $3 THEN (cod_filial || '-' || numero_documento || '-' || serie) END) AS qtd_nfs_ytd
        FROM faturamento_base
        GROUP BY 1
        ORDER BY realizado_ytd DESC
      ),
      executivos_agg AS (
        SELECT
          COALESCE(NULLIF(cod_vendedor, ''), 'SEM_COD') AS cod_vendedor,
          executivo,
          COALESCE(SUM(CASE WHEN mes_iso = $3 THEN ${valorExpr} ELSE 0 END), 0) AS realizado_mes,
          COALESCE(SUM(CASE WHEN mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS realizado_ytd,
          COUNT(DISTINCT CASE WHEN mes_iso <= $3 THEN (cod_filial || '-' || numero_documento || '-' || serie) END) AS qtd_nfs_ytd,
          COUNT(DISTINCT CASE WHEN mes_iso <= $3 THEN cliente END) AS qtd_clientes_ytd
        FROM faturamento_base
        GROUP BY 1, 2
        ORDER BY realizado_ytd DESC
      ),
      clientes_agg AS (
        SELECT
          cliente,
          MAX(cnpj) AS cnpj,
          MODE() WITHIN GROUP (ORDER BY unidade) AS unidade_principal,
          MODE() WITHIN GROUP (ORDER BY executivo) AS executivo_principal,
          COALESCE(SUM(CASE WHEN mes_iso = $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_mes,
          COALESCE(SUM(CASE WHEN mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_ytd,
          COUNT(DISTINCT CASE WHEN mes_iso <= $3 THEN (cod_filial || '-' || numero_documento || '-' || serie) END) AS qtd_nfs_ytd,
          COUNT(DISTINCT CASE WHEN mes_iso <= $3 AND NULLIF(numero_contrato, '') IS NOT NULL THEN numero_contrato END) AS qtd_contratos_ytd
        FROM faturamento_base
        WHERE mes_iso <= $3
        GROUP BY 1
        HAVING COALESCE(SUM(${valorExpr}), 0) > 0
        ORDER BY valor_ytd DESC
        LIMIT 30
      ),
      contratos_agg AS (
        SELECT
          numero_contrato,
          MAX(cliente) AS cliente,
          MODE() WITHIN GROUP (ORDER BY unidade) AS unidade,
          MODE() WITHIN GROUP (ORDER BY executivo) AS executivo,
          COALESCE(SUM(CASE WHEN mes_iso = $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_mes,
          COALESCE(SUM(CASE WHEN mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_ytd,
          COUNT(DISTINCT CASE WHEN mes_iso <= $3 THEN (cod_filial || '-' || numero_documento || '-' || serie) END) AS qtd_nfs_ytd,
          MAX(emissao) AS ultima_emissao
        FROM faturamento_base
        WHERE mes_iso <= $3
          AND NULLIF(numero_contrato, '') IS NOT NULL
        GROUP BY 1
        HAVING COALESCE(SUM(${valorExpr}), 0) > 0
        ORDER BY valor_ytd DESC
        LIMIT 25
      )
      SELECT
        COALESCE((SELECT JSON_AGG(mensal_agg) FROM mensal_agg), '[]'::json) AS mensal,
        COALESCE((SELECT JSON_AGG(unidades_agg) FROM unidades_agg), '[]'::json) AS unidades,
        COALESCE((SELECT JSON_AGG(executivos_agg) FROM executivos_agg), '[]'::json) AS executivos,
        COALESCE((SELECT JSON_AGG(clientes_agg) FROM clientes_agg), '[]'::json) AS clientes,
        COALESCE((SELECT JSON_AGG(contratos_agg) FROM contratos_agg), '[]'::json) AS contratos
    `;

    const [
      protheusAggRes,
      mensalPrevYearRes,
      metasUnidadesRes,
      metasExecRes,
      freshnessRes,
      prevMesRes
    ] = await Promise.all([
      pool.query(rmrProtheusAggQuery, [yearStart, yearEndExcl, mesRefIso]),
      pool.query(`
        ${baseCte}
        SELECT
          mes_iso AS mes,
          COALESCE(SUM(valor_total), 0) AS bruto,
          COALESCE(SUM(CASE WHEN NOT is_expurgo THEN valor_total ELSE 0 END), 0) AS liquido
        FROM faturamento_base
        GROUP BY 1
        ORDER BY 1
      `, [prevYearStart, prevYearEndExcl]),
      pool.query(`
        SELECT
          TRIM(zi0_unidad) AS zi0_unidad,
          LPAD(TRIM(zi1_mes), 2, '0') AS mes_num,
          COALESCE(MAX(zi1_vlrmet), 0) AS meta_orcada,
          COALESCE(MAX(zi1_vlmalv), 0) AS meta_alvo
        FROM comercial.indicador_unidade
        WHERE zi0_ano = $1
          AND zi0_metric = '000001'
          AND zi0_status = 'A'
        GROUP BY 1, 2
        ORDER BY 1, 2
      `, [String(year)]),
      pool.query(`
        WITH meta_anual AS (
          SELECT
            TRIM(COALESCE(cod_vendedor::text, '')) AS cod_vendedor,
            MAX(COALESCE(valor_alvo, 0))::numeric AS meta_anual_alvo,
            MAX(COALESCE(valor_meta_realista, 0))::numeric AS meta_anual_realista,
            MAX(COALESCE(valor_meta, 0))::numeric AS meta_anual_base,
            MAX(NULLIF(TRIM(descricao), '')) AS nome_meta,
            MAX(NULLIF(TRIM(unidade), '')) AS unidade_meta
          FROM comercial.dim_meta_vendedores
          WHERE EXTRACT(YEAR FROM data_referencia)::int = $1
            AND UPPER(COALESCE(descricao, '')) NOT LIKE '%NPS%'
          GROUP BY 1
        )
        SELECT * FROM meta_anual WHERE cod_vendedor <> ''
      `, [year]),
      pool.query(`
        SELECT
          (SELECT MAX(emissao) FROM comercial.fato_itens_vendas) AS max_emissao_protheus,
          (SELECT MAX(data_criacao) FROM comercial.fato_itens_vendas) AS max_carga_protheus,
          (SELECT MAX("DATE_MODIFY") FROM stage_bitrix.b_crm_deal) AS max_modify_bitrix,
          (SELECT MAX(atualizado_em) FROM stage_bitrix._controle_extracao) AS max_extracao_bitrix
      `),
      // Caso o mês de referência seja Janeiro, o mês anterior cai em Dezembro do ano anterior
      prevM.year < year
        ? pool.query(`
            ${buildBillingBaseCte({ startParam: '$1', endParam: '$2', escopo })}
            SELECT
              COALESCE(SUM(valor_total), 0) AS bruto,
              COALESCE(SUM(CASE WHEN NOT is_expurgo THEN valor_total ELSE 0 END), 0) AS liquido
            FROM faturamento_base
          `, monthRangeDates(prevM.year, prevM.month, prevM.month).start
            ? [monthRangeDates(prevM.year, prevM.month, prevM.month).start, monthRangeDates(prevM.year, prevM.month, prevM.month).endExclusive]
            : [`${prevM.year}-12-01`, `${year}-01-01`])
        : Promise.resolve({ rows: [] })
    ]);

    const rmrAgg = protheusAggRes.rows[0] || {};
    const mensalAtualRes = { rows: rmrAgg.mensal || [] };
    const unidadesAtualRes = { rows: rmrAgg.unidades || [] };
    const executivosAtualRes = { rows: rmrAgg.executivos || [] };
    const clientesAtualRes = { rows: rmrAgg.clientes || [] };
    const contratosAtualRes = { rows: rmrAgg.contratos || [] };

    // 2) Bitrix CRM + Apropriação + Funil + Perdas + Pipeline (consultados em paralelo e com guardas de leitura)
    let apropMensal = [];
    let apropPorUnidade = [];
    let apropBacklogResumo = { noAno: 0, noMesRef: 0, futurosProximoAno: 0, qtdContratosMes: 0, qtdContratosAno: 0 };

    if (permAprop.canSelect) {
      const [apropMesRes, apropUnidRes, apropFutRes] = await Promise.all([
        pool.query(`
          SELECT
            mes,
            COUNT(DISTINCT id_negocio)::int AS qtd_contratos,
            COALESCE(SUM(receita_apropriada), 0) AS receita_apropriada
          FROM comercial.fato_apropriacao_receita_mensal
          WHERE ano = $1
          GROUP BY 1
          ORDER BY 1
        `, [year]),
        pool.query(`
          SELECT
            COALESCE(NULLIF(TRIM(unidade_negocio), ''), 'Não informado') AS unidade,
            COUNT(DISTINCT id_negocio)::int AS qtd_contratos,
            COALESCE(SUM(CASE WHEN mes = $2 THEN receita_apropriada ELSE 0 END), 0) AS receita_mes,
            COALESCE(SUM(CASE WHEN mes <= $2 THEN receita_apropriada ELSE 0 END), 0) AS receita_ytd,
            COALESCE(SUM(receita_apropriada), 0) AS receita_ano_completo
          FROM comercial.fato_apropriacao_receita_mensal
          WHERE ano = $1
          GROUP BY 1
          ORDER BY receita_ytd DESC
        `, [year, month]),
        pool.query(`
          SELECT
            COALESCE(SUM(CASE WHEN ano = $1 AND mes > $2 THEN receita_apropriada ELSE 0 END), 0) AS restante_ano,
            COALESCE(SUM(CASE WHEN ano > $1 THEN receita_apropriada ELSE 0 END), 0) AS anos_seguintes
          FROM comercial.fato_apropriacao_receita_mensal
        `, [year, month])
      ]);
      apropMensal = apropMesRes.rows.map(r => ({
        mes: `${year}-${String(r.mes).padStart(2, '0')}`,
        qtdContratos: Number(r.qtd_contratos || 0),
        valor: toNumber(r.receita_apropriada)
      }));
      apropPorUnidade = apropUnidRes.rows.map(r => ({
        unidade: r.unidade,
        qtdContratos: Number(r.qtd_contratos || 0),
        receitaMes: toNumber(r.receita_mes),
        receitaYtd: toNumber(r.receita_ytd),
        receitaAnoCompleto: toNumber(r.receita_ano_completo)
      }));
      const rowMes = apropMesRes.rows.find(r => Number(r.mes) === month);
      apropBacklogResumo = {
        noMesRef: toNumber(rowMes?.receita_apropriada),
        qtdContratosMes: Number(rowMes?.qtd_contratos || 0),
        noAnoYtd: apropMesRes.rows
          .filter(r => Number(r.mes) <= month)
          .reduce((s, r) => s + toNumber(r.receita_apropriada), 0),
        noAnoTotal: apropMesRes.rows.reduce((s, r) => s + toNumber(r.receita_apropriada), 0),
        restanteAno: toNumber(apropFutRes.rows[0]?.restante_ano),
        anosSeguintes: toNumber(apropFutRes.rows[0]?.anos_seguintes)
      };
    }

    // Pipeline aberto + Contratos Ativos Bitrix + Ganhos/Perdas Bitrix
    let pipelineRows = [];
    let activeContractsBitrix = [];
    let closedDealsRows = [];
    let stageAvgRows = [];

    if (permBitrixDeal.canSelect) {
      const unitSql = normalizeDealUnitSql('d', 'uf');
      const oppSql = safeNumericDealSql('d."OPPORTUNITY"');

      const [pipeRes, activeCtrRes, closedRes, tempoRes] = await Promise.all([
        pool.query(`
          SELECT
            d."ID"::text AS id,
            d."CATEGORY_ID"::text AS category_id,
            d."STAGE_ID"::text AS stage_id,
            COALESCE(st."NAME", d."STAGE_ID"::text) AS stage_name,
            COALESCE(NULLIF(TRIM(d."TITLE"), ''), 'Sem título') AS negocio,
            COALESCE(NULLIF(TRIM(c."TITLE"), ''), 'Cliente não identificado') AS cliente,
            COALESCE(NULLIF(TRIM(CONCAT(u."NAME", ' ', COALESCE(u."LAST_NAME", ''))), ''), 'Sem executivo') AS executivo,
            ${unitSql} AS unidade,
            ${oppSql} AS valor,
            LEFT(COALESCE(uf."UF_CRM_1704904017946"::text, d."BEGINDATE"::text, ''), 10) AS data_inicio,
            LEFT(COALESCE(uf."UF_CRM_1704904033370"::text, d."CLOSEDATE"::text, ''), 10) AS data_fechamento,
            LEFT(COALESCE(d."DATE_CREATE"::text, ''), 10) AS data_criacao
          FROM stage_bitrix.b_crm_deal d
          LEFT JOIN stage_bitrix.b_crm_deal_uf uf ON uf."ID"::text = d."ID"::text
          LEFT JOIN stage_bitrix.b_user u ON u."ID"::text = d."ASSIGNED_BY_ID"::text
          LEFT JOIN stage_bitrix.b_crm_company c ON c."ID"::text = d."COMPANY_ID"::text
          LEFT JOIN stage_bitrix.b_crm_status st
            ON st."STATUS_ID"::text = d."STAGE_ID"::text
           AND st."ENTITY_ID" IN ('DEAL_STAGE_4', 'DEAL_STAGE_19')
          WHERE d."CATEGORY_ID" IN ('4', '19')
            AND d."STAGE_SEMANTIC_ID" = 'P'
            AND COALESCE(d."TITLE", '') NOT ILIKE '%ORÇAMENTO ORIENTATIVO%'
            AND COALESCE(d."TITLE", '') NOT ILIKE '%ORCAMENTO ORIENTATIVO%'
          ORDER BY valor DESC
        `),
        pool.query(`
          SELECT
            d."ID"::text AS id,
            d."STAGE_ID"::text AS stage_id,
            COALESCE(st."NAME", d."STAGE_ID"::text) AS etapa,
            COALESCE(NULLIF(TRIM(d."TITLE"), ''), 'Sem título') AS titulo,
            COALESCE(NULLIF(TRIM(c."TITLE"), ''), 'Cliente não identificado') AS cliente,
            COALESCE(NULLIF(TRIM(CONCAT(u."NAME", ' ', COALESCE(u."LAST_NAME", ''))), ''), 'Sem executivo') AS executivo,
            ${unitSql} AS unidade,
            ${oppSql} AS valor,
            LEFT(COALESCE(uf."UF_CRM_1704904017946"::text, d."BEGINDATE"::text, ''), 10) AS data_inicio,
            LEFT(COALESCE(uf."UF_CRM_1704904033370"::text, d."CLOSEDATE"::text, ''), 10) AS data_termino
          FROM stage_bitrix.b_crm_deal d
          LEFT JOIN stage_bitrix.b_crm_deal_uf uf ON uf."ID"::text = d."ID"::text
          LEFT JOIN stage_bitrix.b_user u ON u."ID"::text = d."ASSIGNED_BY_ID"::text
          LEFT JOIN stage_bitrix.b_crm_company c ON c."ID"::text = d."COMPANY_ID"::text
          LEFT JOIN stage_bitrix.b_crm_status st
            ON st."STATUS_ID"::text = d."STAGE_ID"::text
           AND st."ENTITY_ID" IN ('DEAL_STAGE_4', 'DEAL_STAGE_19')
          WHERE (
            d."STAGE_ID" IN ('C4:UC_2ZQLVL', 'C4:UC_RPFFJU', 'C4:UC_JDNYZT', 'C4:UC_FOYMHF', 'C4:UC_VHKW1X', 'C19:WON')
          )
          ORDER BY valor DESC
          LIMIT 60
        `),
        pool.query(`
          SELECT
            d."ID"::text AS id,
            d."CATEGORY_ID"::text AS category_id,
            d."STAGE_ID"::text AS stage_id,
            d."STAGE_SEMANTIC_ID"::text AS semantic_id,
            COALESCE(NULLIF(TRIM(d."TITLE"), ''), 'Sem título') AS negocio,
            COALESCE(NULLIF(TRIM(c."TITLE"), ''), 'Cliente não identificado') AS cliente,
            COALESCE(NULLIF(TRIM(CONCAT(u."NAME", ' ', COALESCE(u."LAST_NAME", ''))), ''), 'Sem executivo') AS executivo,
            ${unitSql} AS unidade,
            ${oppSql} AS valor,
            COALESCE(
              NULLIF(TRIM(uf."UF_CRM_1728564440301"::text), ''),
              ${permNegocios.canSelect ? "NULLIF(TRIM(fn.id_motivo_perda), '')," : ''}
              'Não informado'
            ) AS motivo_perda,
            ${permNegocios.canSelect ? 'fn.dias_ciclo_venda' : 'NULL::integer'} AS dias_ciclo,
            LEFT(COALESCE(d."CLOSEDATE"::text, d."MOVED_TIME"::text, d."DATE_MODIFY"::text, ''), 10) AS data_evento
          FROM stage_bitrix.b_crm_deal d
          LEFT JOIN stage_bitrix.b_crm_deal_uf uf ON uf."ID"::text = d."ID"::text
          LEFT JOIN stage_bitrix.b_user u ON u."ID"::text = d."ASSIGNED_BY_ID"::text
          LEFT JOIN stage_bitrix.b_crm_company c ON c."ID"::text = d."COMPANY_ID"::text
          ${permNegocios.canSelect ? 'LEFT JOIN comercial.fato_negocios fn ON fn.id_negocio::text = d."ID"::text' : ''}
          WHERE d."CATEGORY_ID" IN ('4', '19')
            AND d."STAGE_SEMANTIC_ID" IN ('S', 'F')
            AND LEFT(COALESCE(d."CLOSEDATE"::text, d."MOVED_TIME"::text, ''), 4) = $1
            AND LEFT(COALESCE(d."CLOSEDATE"::text, d."MOVED_TIME"::text, ''), 7) <= $2
        `, [String(year), mesRefIso]),
        permTempoEtapa.canSelect
          ? pool.query(`
              SELECT
                nome_funil,
                nome_etapa,
                COUNT(*)::int AS passagens,
                ROUND(AVG(COALESCE(dias_na_etapa, 0))::numeric, 1) AS media_dias
              FROM comercial.fato_tempo_etapa_negocio
              WHERE EXTRACT(YEAR FROM data_entrada)::int = $1
                AND id_categoria_funil IN (4, 19)
              GROUP BY 1, 2
              ORDER BY passagens DESC
              LIMIT 12
            `, [year]).catch(() => ({ rows: [] }))
          : Promise.resolve({ rows: [] })
      ]);

      pipelineRows = pipeRes.rows;
      activeContractsBitrix = activeCtrRes.rows;
      closedDealsRows = closedRes.rows;
      stageAvgRows = tempoRes.rows;
    }

    // --- Montagem 1: Metas de Unidades & Série Mensal Consolidada ---
    const metaPorMes = {};
    const metaPorUnidadeMes = {};
    const metaUnidadeAnualMap = {};

    for (const r of metasUnidadesRes.rows) {
      const unitName = mapIndicadorUnitName(r.zi0_unidad);
      const mesIso = `${year}-${r.mes_num}`;
      const metaAlvo = toNumber(r.meta_alvo);
      const metaOrc = toNumber(r.meta_orcada);
      metaPorMes[mesIso] = (metaPorMes[mesIso] || 0) + metaAlvo;
      if (!metaPorUnidadeMes[unitName]) metaPorUnidadeMes[unitName] = {};
      metaPorUnidadeMes[unitName][mesIso] = { alvo: metaAlvo, orcada: metaOrc };
      metaUnidadeAnualMap[unitName] = (metaUnidadeAnualMap[unitName] || 0) + metaAlvo;
    }

    const mensalAtualMap = Object.fromEntries(mensalAtualRes.rows.map(r => [r.mes, r]));
    const mensalPrevMap = Object.fromEntries(mensalPrevYearRes.rows.map(r => [r.mes.slice(5, 7), r]));
    const apropMesMap = Object.fromEntries(apropMensal.map(r => [r.mes, r.valor]));

    const serieMensal = [];
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const mesIso = `${year}-${mm}`;
      const row = mensalAtualMap[mesIso];
      const prevRow = mensalPrevMap[mm];
      const bruto = toNumber(row?.bruto);
      const liquido = toNumber(row?.liquido);
      const expurgos = toNumber(row?.expurgos);
      const principal = incluirExpurgos ? bruto : liquido;
      const prevPrincipal = incluirExpurgos ? toNumber(prevRow?.bruto) : toNumber(prevRow?.liquido);
      const metaMes = metaPorMes[mesIso] || 0;
      serieMensal.push({
        mes: mesIso,
        mesNumero: m,
        fechado: m <= month,
        bruto,
        liquido,
        expurgos,
        valorPrincipal: principal,
        metaUnidades: metaMes,
        atingimentoPct: metaMes > 0 && principal > 0 ? (principal / metaMes) * 100 : null,
        anoAnterior: prevPrincipal,
        apropriacaoBitrix: toNumber(apropMesMap[mesIso]),
        qtdNfs: Number(row?.qtd_nfs || 0),
        qtdClientes: Number(row?.qtd_clientes || 0)
      });
    }

    // Indicadores Executivos (Mês ref & YTD)
    const refSerie = serieMensal[month - 1] || {};
    const ytdSlices = serieMensal.slice(0, month);
    const ytdBruto = ytdSlices.reduce((s, r) => s + r.bruto, 0);
    const ytdLiquido = ytdSlices.reduce((s, r) => s + r.liquido, 0);
    const ytdExpurgos = ytdSlices.reduce((s, r) => s + r.expurgos, 0);
    const ytdPrincipal = ytdSlices.reduce((s, r) => s + r.valorPrincipal, 0);
    const ytdMeta = ytdSlices.reduce((s, r) => s + r.metaUnidades, 0);
    const ytdAnoAnterior = ytdSlices.reduce((s, r) => s + r.anoAnterior, 0);
    const metaAnualTotal = Object.values(metaUnidadeAnualMap).reduce((s, v) => s + v, 0);

    let prevMonthPrincipal = 0;
    if (month > 1) {
      prevMonthPrincipal = serieMensal[month - 2]?.valorPrincipal || 0;
    } else if (prevMesRes.rows[0]) {
      prevMonthPrincipal = incluirExpurgos
        ? toNumber(prevMesRes.rows[0].bruto)
        : toNumber(prevMesRes.rows[0].liquido);
    }

    const executivoResumo = {
      ano: year,
      mesReferencia: mesRefIso,
      mesAnterior: prevMesIso,
      mes: {
        valorPrincipal: refSerie.valorPrincipal || 0,
        faturamentoLiquido: refSerie.liquido || 0,
        faturamentoBruto: refSerie.bruto || 0,
        expurgos: refSerie.expurgos || 0,
        meta: refSerie.metaUnidades || 0,
        atingimentoPct: (refSerie.metaUnidades || 0) > 0 ? ((refSerie.valorPrincipal || 0) / refSerie.metaUnidades) * 100 : null,
        variacaoMoMPct: prevMonthPrincipal > 0 ? (((refSerie.valorPrincipal || 0) - prevMonthPrincipal) / prevMonthPrincipal) * 100 : null,
        variacaoYoYPct: (refSerie.anoAnterior || 0) > 0 ? (((refSerie.valorPrincipal || 0) - refSerie.anoAnterior) / refSerie.anoAnterior) * 100 : null,
        valorMesAnterior: prevMonthPrincipal,
        valorAnoAnterior: refSerie.anoAnterior || 0,
        qtdNfs: refSerie.qtdNfs || 0,
        qtdClientes: refSerie.qtdClientes || 0,
        apropriacaoBitrix: refSerie.apropriacaoBitrix || 0
      },
      ytd: {
        valorPrincipal: ytdPrincipal,
        faturamentoLiquido: ytdLiquido,
        faturamentoBruto: ytdBruto,
        expurgos: ytdExpurgos,
        metaYtd: ytdMeta,
        metaAnual: metaAnualTotal,
        atingimentoYtdPct: ytdMeta > 0 ? (ytdPrincipal / ytdMeta) * 100 : null,
        atingimentoAnualPct: metaAnualTotal > 0 ? (ytdPrincipal / metaAnualTotal) * 100 : null,
        variacaoYoYPct: ytdAnoAnterior > 0 ? ((ytdPrincipal - ytdAnoAnterior) / ytdAnoAnterior) * 100 : null,
        valorAnoAnteriorYtd: ytdAnoAnterior,
        apropriacaoBitrixYtd: apropBacklogResumo.noAnoYtd || 0
      }
    };

    // --- Montagem 2: Metas vs Realizado (Unidades + Executivos) ---
    const allUnits = new Set([
      ...Object.keys(metaUnidadeAnualMap),
      ...unidadesAtualRes.rows.map(r => r.unidade)
    ]);
    const fatUnitMap = Object.fromEntries(unidadesAtualRes.rows.map(r => [r.unidade, r]));

const UNIDADES_COMERCIAIS_OFICIAIS = new Set([
  'Wind',
  'Norte',
  'Pecém',
  'Complexo',
  'Engenharia',
  'Transportes'
]);

const EXECUTIVOS_COMERCIAIS_OFICIAIS = [
  'CRISTIANE',
  'CRISTIANO',
  'FERNANDO',
  'FABRICIO',
  'BRUNO',
  'MARCIO'
];

function isExecutivoComercialOficial(nome) {
  const norm = String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  return EXECUTIVOS_COMERCIAIS_OFICIAIS.some(ex => norm.includes(ex));
}

    const unidadesComparativo = Array.from(allUnits)
      .filter(unidade => UNIDADES_COMERCIAIS_OFICIAIS.has(unidade))
      .map(unidade => {
      const f = fatUnitMap[unidade];
      const mesesMeta = metaPorUnidadeMes[unidade] || {};
      const metaMes = mesesMeta[mesRefIso]?.alvo || 0;
      let metaYtd = 0;
      for (let m = 1; m <= month; m++) {
        const k = `${year}-${String(m).padStart(2, '0')}`;
        metaYtd += mesesMeta[k]?.alvo || 0;
      }
      const metaAnual = metaUnidadeAnualMap[unidade] || 0;
      const realizadoMes = toNumber(f?.realizado_mes);
      const realizadoYtd = toNumber(f?.realizado_ytd);
      const runRateAnual = month > 0 ? (realizadoYtd / month) * 12 : realizadoYtd;
      return {
        unidade,
        isExpurgoUnidade: EXPURGO_UNIDADES_SET.has(unidade),
        realizadoMes,
        metaMes,
        atingimentoMesPct: metaMes > 0 ? (realizadoMes / metaMes) * 100 : null,
        realizadoYtd,
        metaYtd,
        atingimentoYtdPct: metaYtd > 0 ? (realizadoYtd / metaYtd) * 100 : null,
        gapYtd: realizadoYtd - metaYtd,
        metaAnual,
        atingimentoAnualPct: metaAnual > 0 ? (realizadoYtd / metaAnual) * 100 : null,
        gapAnual: realizadoYtd - metaAnual,
        runRateAnual,
        qtdNfsYtd: Number(f?.qtd_nfs_ytd || 0)
      };
    }).sort((a, b) => (b.realizadoYtd + b.metaAnual) - (a.realizadoYtd + a.metaAnual));

    const metaExecMap = Object.fromEntries(metasExecRes.rows.map(r => [r.cod_vendedor, r]));
    const execRealMap = Object.fromEntries(executivosAtualRes.rows.map(r => [r.cod_vendedor, r]));
    const allExecCod = new Set([...Object.keys(metaExecMap), ...Object.keys(execRealMap)]);

    const executivosComparativo = Array.from(allExecCod).map(cod => {
      const real = execRealMap[cod];
      const meta = metaExecMap[cod];
      const nome = real?.executivo || meta?.nome_meta || `Vendedor ${cod}`;
      const realizadoMes = toNumber(real?.realizado_mes);
      const realizadoYtd = toNumber(real?.realizado_ytd);
      const metaAnualAlvo = toNumber(meta?.meta_anual_alvo);
      const metaProportionalYtd = metaAnualAlvo > 0 ? (metaAnualAlvo / 12) * month : 0;
      return {
        codVendedor: cod,
        executivo: nome,
        unidadeMeta: meta?.unidade_meta || '—',
        realizadoMes,
        realizadoYtd,
        metaProportionalYtd,
        metaAnualAlvo,
        atingimentoYtdPct: metaProportionalYtd > 0 ? (realizadoYtd / metaProportionalYtd) * 100 : null,
        atingimentoAnualPct: metaAnualAlvo > 0 ? (realizadoYtd / metaAnualAlvo) * 100 : null,
        gapAnual: metaAnualAlvo > 0 ? realizadoYtd - metaAnualAlvo : null,
        qtdNfsYtd: Number(real?.qtd_nfs_ytd || 0),
        qtdClientesYtd: Number(real?.qtd_clientes_ytd || 0)
      };
    })
      .filter(e => (e.realizadoYtd > 0 || e.metaAnualAlvo > 0) && isExecutivoComercialOficial(e.executivo))
      .sort((a, b) => b.realizadoYtd - a.realizadoYtd);

    // --- Montagem 3: Backlog & Medições Pendentes ---
    const porEstagioContrato = {};
    for (const c of activeContractsBitrix) {
      const st = c.etapa || c.stage_id;
      if (!porEstagioContrato[st]) porEstagioContrato[st] = { etapa: st, stageId: c.stage_id, qtd: 0, valor: 0 };
      porEstagioContrato[st].qtd += 1;
      porEstagioContrato[st].valor += toNumber(c.valor);
    }

    const backlogMedicoes = {
      statusMedicoesProtheus: {
        disponivel: Boolean(permMedicoes.canSelect),
        objeto: 'comercial.protheus_gold_medicoes_pendentes',
        observacao: permMedicoes.canSelect
          ? 'Permissão liberada (atenção: objeto espelha cabeçalho ZC0010, validar contra ZD1010).'
          : 'Acesso bloqueado (SELECT negado em comercial.protheus_gold_medicoes_pendentes) e planilha SharePoint CONTROLE DE MEDICAO (Medições Pendentes / Fechamento Informakon) não ingerida no PostgreSQL.'
      },
      statusContratosProtheus: {
        disponivel: Boolean(permContratosOp.canSelect),
        objeto: 'comercial.contratos_operacional',
        observacao: permContratosOp.canSelect
          ? 'Permissão liberada.'
          : 'Acesso bloqueado (SELECT negado em comercial.contratos_operacional) e comercial.contratos_comercial possui 0 registros.'
      },
      apropriacaoBitrix: {
        disponivel: Boolean(permAprop.canSelect),
        resumo: apropBacklogResumo,
        porUnidade: apropPorUnidade
      },
      carteiraContratosBitrix: {
        qtdTotal: activeContractsBitrix.length,
        valorTotal: activeContractsBitrix.reduce((s, r) => s + toNumber(r.valor), 0),
        porEtapa: Object.values(porEstagioContrato).sort((a, b) => b.valor - a.valor),
        itens: activeContractsBitrix.slice(0, 30).map(r => ({
          id: r.id,
          etapa: r.etapa,
          titulo: r.titulo,
          cliente: r.cliente,
          executivo: r.executivo,
          unidade: r.unidade,
          valor: toNumber(r.valor),
          dataInicio: r.data_inicio || null,
          dataTermino: r.data_termino || null
        }))
      }
    };

    // --- Montagem 4: Contratos & Resultados por Cliente ---
    let paretoAcum = 0;
    const clientesRanking = clientesAtualRes.rows.map((r, idx) => {
      const val = toNumber(r.valor_ytd);
      paretoAcum += val;
      return {
        posicao: idx + 1,
        cliente: r.cliente,
        cnpj: r.cnpj || '',
        unidadePrincipal: r.unidade_principal || '—',
        executivoPrincipal: r.executivo_principal || '—',
        valorMes: toNumber(r.valor_mes),
        valorYtd: val,
        participacaoPct: ytdPrincipal > 0 ? (val / ytdPrincipal) * 100 : 0,
        paretoAcumuladoPct: ytdPrincipal > 0 ? (paretoAcum / ytdPrincipal) * 100 : 0,
        qtdNfsYtd: Number(r.qtd_nfs_ytd || 0),
        qtdContratosYtd: Number(r.qtd_contratos_ytd || 0)
      };
    });

    const contratosProtheus = contratosAtualRes.rows.map(r => ({
      numeroContrato: r.numero_contrato,
      cliente: r.cliente,
      unidade: r.unidade,
      executivo: r.executivo,
      valorMes: toNumber(r.valor_mes),
      valorYtd: toNumber(r.valor_ytd),
      qtdNfsYtd: Number(r.qtd_nfs_ytd || 0),
      ultimaEmissao: r.ultima_emissao ? String(r.ultima_emissao).slice(0, 10) : null
    }));

    // --- Montagem 5: Projeções Comerciais (Metodologia projecao-comercial) ---
    const mesesFechadosCount = month;
    const mesesRestantes = Math.max(0, 12 - mesesFechadosCount);
    const runRateMensal = mesesFechadosCount > 0 ? ytdPrincipal / mesesFechadosCount : 0;
    const cutoffYearEnd = `${year}-12-31`;

    let pipelineBrutoTotal = 0;
    let pipelinePonderadoTotal = 0;
    let pipelineCurtoAnoBruto = 0;
    let pipelineCurtoAnoPonderado = 0;
    const pipelinePorEtapaMap = {};
    const pipelinePorUnidadeMap = {};

    for (const deal of pipelineRows) {
      const val = toNumber(deal.valor);
      if (val <= 0) continue;
      const { peso, grupo, etapaLabel } = getStageWeight(deal.stage_id, deal.category_id);
      const valPonderado = val * peso;
      const dtClose = String(deal.data_fechamento || '').slice(0, 10);
      const dentroDoAno = !dtClose || dtClose <= cutoffYearEnd;

      pipelineBrutoTotal += val;
      pipelinePonderadoTotal += valPonderado;
      if (dentroDoAno) {
        pipelineCurtoAnoBruto += val;
        pipelineCurtoAnoPonderado += valPonderado;
      }

      if (!pipelinePorEtapaMap[etapaLabel]) {
        pipelinePorEtapaMap[etapaLabel] = {
          etapa: etapaLabel,
          grupo,
          pesoPct: Math.round(peso * 100),
          qtd: 0,
          valorBruto: 0,
          valorPonderado: 0
        };
      }
      pipelinePorEtapaMap[etapaLabel].qtd += 1;
      pipelinePorEtapaMap[etapaLabel].valorBruto += val;
      pipelinePorEtapaMap[etapaLabel].valorPonderado += valPonderado;

      const un = deal.unidade || 'Não informado';
      if (!pipelinePorUnidadeMap[un]) {
        pipelinePorUnidadeMap[un] = { unidade: un, qtd: 0, valorBruto: 0, valorPonderado: 0 };
      }
      pipelinePorUnidadeMap[un].qtd += 1;
      pipelinePorUnidadeMap[un].valorBruto += val;
      pipelinePorUnidadeMap[un].valorPonderado += valPonderado;
    }

    const metaRestanteAno = Math.max(0, metaAnualTotal - ytdPrincipal);
    const gapInicialPct = metaAnualTotal > 0 ? ((ytdPrincipal - metaAnualTotal) / metaAnualTotal) * 100 : null;

    const cenarios = [
      {
        codigo: 'inercia',
        nome: 'Inércia (Run-Rate Puro)',
        premissa: `YTD (${mesesFechadosCount}m) + média mensal histórica × ${mesesRestantes}m`,
        valorAnual: ytdPrincipal + runRateMensal * mesesRestantes
      },
      {
        codigo: 'conservador',
        nome: 'Conservador',
        premissa: 'YTD + 70% Run-Rate restante + 15% Pipeline Curto Ponderado',
        valorAnual: ytdPrincipal + runRateMensal * mesesRestantes * 0.7 + pipelineCurtoAnoPonderado * 0.15
      },
      {
        codigo: 'base',
        nome: 'Base (Recomendado)',
        premissa: 'YTD + 100% Run-Rate restante + Pipeline Janela Ano Ponderado',
        valorAnual: ytdPrincipal + runRateMensal * mesesRestantes + pipelineCurtoAnoPonderado * 0.35
      },
      {
        codigo: 'otimista',
        nome: 'Otimista',
        premissa: 'YTD + 110% Run-Rate restante + 60% Pipeline Curto Ponderado',
        valorAnual: ytdPrincipal + runRateMensal * mesesRestantes * 1.1 + pipelineCurtoAnoPonderado * 0.6
      }
    ].map(c => ({
      ...c,
      gapVsMetaAnual: metaAnualTotal > 0 ? c.valorAnual - metaAnualTotal : null,
      atingimentoProjetadoPct: metaAnualTotal > 0 ? (c.valorAnual / metaAnualTotal) * 100 : null
    }));

    const projecoes = {
      mesesFechados: mesesFechadosCount,
      mesesRestantes,
      realizadoYtd: ytdPrincipal,
      runRateMensal,
      metaAnualTotal,
      metaRestanteAno,
      gapInicial: ytdPrincipal - metaAnualTotal,
      gapInicialPct,
      pipelineAberto: {
        qtdNegocios: pipelineRows.length,
        brutoTotal: pipelineBrutoTotal,
        ponderadoTotal: pipelinePonderadoTotal,
        janelaAnoBruto: pipelineCurtoAnoBruto,
        janelaAnoPonderado: pipelineCurtoAnoPonderado,
        porEtapa: Object.values(pipelinePorEtapaMap).sort((a, b) => b.valorPonderado - a.valorPonderado),
        porUnidade: Object.values(pipelinePorUnidadeMap).sort((a, b) => b.valorPonderado - a.valorPonderado).slice(0, 12)
      },
      cenarios
    };

    // --- Montagem 6: Funil de Vendas & Motivos de Perda ---
    const wonDeals = [];
    const lostRealMap = {};
    const lostClientMap = {};
    let lostRealQtd = 0;
    let lostRealVal = 0;
    let lostClientQtd = 0;
    let lostClientVal = 0;

    for (const d of closedDealsRows) {
      const val = toNumber(d.valor);
      const isWon = d.semantic_id === 'S' || String(d.stage_id || '').endsWith(':WON');
      if (isWon) {
        wonDeals.push(d);
      } else {
        const motivo = String(d.motivo_perda || 'Não informado').trim();
        const isClientCancel = isCanceladoOuDeclinado(motivo);
        if (isClientCancel) {
          lostClientQtd += 1;
          lostClientVal += val;
          if (!lostClientMap[motivo]) lostClientMap[motivo] = { motivo, qtd: 0, valor: 0, categoria: 'Cancelamento / Orientativo / Cliente' };
          lostClientMap[motivo].qtd += 1;
          lostClientMap[motivo].valor += val;
        } else {
          lostRealQtd += 1;
          lostRealVal += val;
          if (!lostRealMap[motivo]) lostRealMap[motivo] = { motivo, qtd: 0, valor: 0, categoria: 'Perda Competitiva / Operacional' };
          lostRealMap[motivo].qtd += 1;
          lostRealMap[motivo].valor += val;
        }
      }
    }

    const wonValorTotal = wonDeals.reduce((s, d) => s + toNumber(d.valor), 0);
    const totalEncerradosCompetitivos = wonDeals.length + lostRealQtd;
    const totalEncerradosBruto = wonDeals.length + lostRealQtd + lostClientQtd;

    const funilPerdas = {
      resumo: {
        abertoQtd: pipelineRows.length,
        abertoValor: pipelineBrutoTotal,
        ganhosQtd: wonDeals.length,
        ganhosValor: wonValorTotal,
        perdasReaisQtd: lostRealQtd,
        perdasReaisValor: lostRealVal,
        canceladosClienteQtd: lostClientQtd,
        canceladosClienteValor: lostClientVal,
        taxaConversaoCompetitivaPct: totalEncerradosCompetitivos > 0 ? (wonDeals.length / totalEncerradosCompetitivos) * 100 : null,
        taxaConversaoBrutaPct: totalEncerradosBruto > 0 ? (wonDeals.length / totalEncerradosBruto) * 100 : null
      },
      funilAbertoPorEtapa: Object.values(pipelinePorEtapaMap).sort((a, b) => b.valorBruto - a.valorBruto),
      motivosPerdaReais: Object.values(lostRealMap).sort((a, b) => b.valor - a.valor || b.qtd - a.qtd),
      motivosCancelamentoCliente: Object.values(lostClientMap).sort((a, b) => b.valor - a.valor || b.qtd - a.qtd),
      tempoMedioEtapas: stageAvgRows.map(r => ({
        funil: r.nome_funil,
        etapa: r.nome_etapa,
        passagens: Number(r.passagens || 0),
        mediaDias: toNumber(r.media_dias)
      })),
      ultimosGanhos: wonDeals
        .sort((a, b) => toNumber(b.valor) - toNumber(a.valor))
        .slice(0, 15)
        .map(d => ({
          id: d.id,
          negocio: d.negocio,
          cliente: d.cliente,
          executivo: d.executivo,
          unidade: d.unidade,
          valor: toNumber(d.valor),
          data: d.data_evento
        }))
    };

    const fresh = freshnessRes.rows[0] || {};

    return res.status(200).json({
      ok: true,
      geradoEm: new Date().toISOString(),
      parametros: { year, month, mesRefIso, escopo, incluirExpurgos },
      fontes: {
        faturamentoProtheus: 'comercial.fato_itens_vendas (SD2 · NFs multi-cliente deduplicadas + TES comerciais + CFOP receita)',
        metasUnidades: 'comercial.indicador_unidade (ZI0/ZI1 · zi0_metric=000001 · ZI1_VLMALV)',
        metasExecutivos: 'comercial.dim_meta_vendedores (alvo anual deduplicado via MAX)',
        crmFunil: 'stage_bitrix.b_crm_deal + b_crm_deal_uf + b_crm_status + comercial.fato_negocios + dim_motivo_perda',
        apropriacaoCrm: 'comercial.fato_apropriacao_receita_mensal',
        referenciasPbix: [
          'Resultado Comercial - RMR OUT26 - 2026-11-05.pbix',
          'Dashboard Comercial - INBOX - 2026-10-30.pbix'
        ],
        observacaoReconciliacao: 'Regra fiscal PBIX aplica deduplicação multi-cliente, TES/CFOP comerciais e expurgo (filiais 121201,101001,040401,111101 e vendedores 00049,000050). Fechamento gerencial Engenharia via Informakon e Medições Pendentes SharePoint dependem de ingestão/permissão adicional.'
      },
      atualizacao: {
        protheusUltimaEmissao: fresh.max_emissao_protheus ? String(fresh.max_emissao_protheus).slice(0, 10) : null,
        protheusUltimaCarga: fresh.max_carga_protheus || null,
        bitrixUltimaModificacao: fresh.max_modify_bitrix || null,
        bitrixUltimaExtracao: fresh.max_extracao_bitrix || null
      },
      executivo: executivoResumo,
      serieMensal,
      metasVsRealizado: {
        unidades: unidadesComparativo,
        executivos: executivosComparativo
      },
      backlogMedicoes,
      contratosClientes: {
        clientes: clientesRanking,
        contratosProtheus
      },
      projecoes,
      funilPerdas
    });
  } catch (error) {
    console.error('Falha ao consultar painel RMR Comercial:', error);
    return res.status(500).json({ ok: false, error: 'Não foi possível carregar os indicadores do RMR Comercial agora.' });
  }
}
