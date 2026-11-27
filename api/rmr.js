import fs from 'fs';
import path from 'path';
import { getPool, toNumber } from './_db.js';
import { requireAdminMaster } from './_auth.js';
import {
  buildBillingBaseCte,
  COMMERCIAL_TES,
  EXPURGO_FILIAIS,
  mapIndicadorUnitName,
  normalizeDealUnitSql,
  REVENUE_CFOPS,
  safeNumericDealSql
} from './_dw.js';

function loadRmrBaseOficial() {
  try {
    const pCwd = path.join(process.cwd(), 'data', 'rmr-base-oficial.json');
    if (fs.existsSync(pCwd)) {
      return JSON.parse(fs.readFileSync(pCwd, 'utf8'));
    }
    const fileUrl = new URL('../data/rmr-base-oficial.json', import.meta.url);
    return JSON.parse(fs.readFileSync(fileUrl, 'utf8'));
  } catch {
    return { metasExecutivos: [], unidadesRmr: [], medicoesPendentes: [] };
  }
}

const EXPURGO_UNIDADES_SET = new Set(['CM Máquinas', 'Central ADM', 'Metalmecânica', 'Outras / Controladoria']);

let cacheBitrixTempC4 = { ts: 0, map: {} };
async function getBitrixTemperaturasC4() {
  const agora = Date.now();
  if (agora - cacheBitrixTempC4.ts < 90 * 1000 && Object.keys(cacheBitrixTempC4.map).length > 0) {
    return cacheBitrixTempC4.map;
  }
  const webhook = process.env.BITRIX_WEBHOOK_URL || 'https://grupocordeiro.bitrix24.com.br/rest/15605/83aqgne7c875cvkz';
  const map = {};
  try {
    let start = 0;
    while (true) {
      const url = `${webhook.replace(/\/$/, '')}/crm.deal.list.json?filter[CATEGORY_ID]=19&filter[STAGE_SEMANTIC_ID]=P&select[]=ID&select[]=UF_CRM_1793185794697&start=${start}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) break;
      const data = await res.json();
      if (!data.result || !Array.isArray(data.result) || !data.result.length) break;
      for (const d of data.result) {
        const raw = String(d.UF_CRM_1793185794697 || '').trim();
        if (raw === '14580' || raw.toLowerCase().includes('quente')) map[String(d.ID)] = 'quente';
        else if (raw === '14582' || raw.toLowerCase().includes('morno')) map[String(d.ID)] = 'morno';
        else if (raw === '14584' || raw.toLowerCase().includes('frio')) map[String(d.ID)] = 'frio';
      }
      if (!data.next) break;
      start = data.next;
    }
    if (Object.keys(map).length > 0) {
      cacheBitrixTempC4 = { ts: agora, map };
    }
  } catch (err) {
    console.warn('Falha ao buscar temperaturas Bitrix C4:', err.message);
  }
  return Object.keys(map).length > 0 ? map : cacheBitrixTempC4.map;
}

function isCanceladoOuDeclinado(motivoRaw) {
  if (!motivoRaw) return false;
  const m = String(motivoRaw)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (m.includes('limpeza crm') || m.includes('executivo anterior')) return true;
  if (m.includes('cancelad') || m.includes('cancelou') || m.includes('cancelar') || m.includes('cancelamento')) return true;
  if (m.includes('declinad') || m.includes('declinou')) return true;
  if (m.includes('desist') || m.includes('desprogram') || m.includes('primariz')) return true;
  if (m.includes('orientativ') || m.includes('referencial') || m.includes('conhecer os precos') || m.includes('conhecer precos') || m.includes('nao apresentou proposta')) return true;
  if (m.includes('inadimpl')) return true;
  if (m.includes('nao ira mais realizar') || m.includes('nao vai mais necessitar') || m.includes('nao vamos mais precisar') || m.includes('nao vao mais precisar')) return true;
  if (m.includes('optou por nao continuar') || m.includes('optou em nao continuar')) return true;
  if (m.includes('nao precisou dos equipamentos') || m.includes('nao sera mais necessario')) return true;
  if (m.includes('atividade nao realizada') || m.includes('servico nao executado') || m.includes('operacao nao foi viabilizada')) return true;
  if (m.includes('nao aprovad') || m.includes('nao aprovou') || m.includes('aprovacao negada') || m.includes('sem aprovacao do cliente')) return true;
  if (m.includes('invalid') || m.includes('licitac') || m.includes('edital') || m.includes('concorrendo a um tac')) return true;
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
      OR (n.nspname = 'stage_protheus' AND c.relname = 'se1010')
    `);
    const privMap = Object.fromEntries(privBatchRes.rows.map(r => [r.obj, Boolean(r.can_select)]));
    const permMedicoes = { canSelect: Boolean(privMap['comercial.protheus_gold_medicoes_pendentes']) };
    const permContratosOp = { canSelect: Boolean(privMap['comercial.contratos_operacional']) };
    const permAprop = { canSelect: Boolean(privMap['comercial.fato_apropriacao_receita_mensal']) };
    const permTempoEtapa = { canSelect: Boolean(privMap['comercial.fato_tempo_etapa_negocio']) };
    const permNegocios = { canSelect: Boolean(privMap['comercial.fato_negocios']) };
    const permBitrixDeal = { canSelect: Boolean(privMap['stage_bitrix.b_crm_deal']) };
    const permSe1010 = { canSelect: Boolean(privMap['stage_protheus.se1010']) };

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
          COALESCE(SUM(CASE WHEN mes_iso >= $4 AND mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS realizado_s2,
          COALESCE(SUM(CASE WHEN mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS realizado_ytd,
          COALESCE(SUM(CASE WHEN mes_iso <= $3 THEN valor_total ELSE 0 END), 0) AS bruto_ytd,
          COALESCE(SUM(CASE WHEN mes_iso <= $3 AND is_expurgo THEN valor_total ELSE 0 END), 0) AS expurgo_ytd,
          COUNT(DISTINCT CASE WHEN mes_iso <= $3 THEN (cod_filial || '-' || numero_documento || '-' || serie) END) AS qtd_nfs_ytd
        FROM faturamento_base
        GROUP BY 1
        ORDER BY realizado_ytd DESC
      ),
      unidades_mes_agg AS (
        SELECT
          unidade,
          mes_iso AS mes,
          COALESCE(SUM(${valorExpr}), 0) AS valor
        FROM faturamento_base
        WHERE mes_iso <= $3
        GROUP BY 1, 2
      ),
      executivos_agg AS (
        SELECT
          CASE
            WHEN COALESCE(NULLIF(TRIM(cod_vendedor), ''), '000016') IN ('000016', 'SEM_COD') AND unidade = 'Norte' THEN '000056'
            ELSE COALESCE(NULLIF(TRIM(cod_vendedor), ''), 'SEM_COD')
          END AS cod_vendedor,
          CASE
            WHEN COALESCE(NULLIF(TRIM(cod_vendedor), ''), '000016') IN ('000016', 'SEM_COD') AND unidade = 'Norte' THEN 'CRISTIANO ASSIS'
            ELSE executivo
          END AS executivo,
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
      ),
      clientes_contratos_agg AS (
        SELECT
          fb.cliente,
          COALESCE(NULLIF(TRIM(fb.numero_contrato), ''), 'SEM_CONTRATO') AS numero_contrato,
          MODE() WITHIN GROUP (ORDER BY fb.unidade) AS unidade,
          COALESCE(SUM(CASE WHEN fb.mes_iso = $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_mes,
          COALESCE(SUM(CASE WHEN fb.mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_ytd,
          COUNT(DISTINCT CASE WHEN fb.mes_iso <= $3 THEN (fb.cod_filial || '-' || fb.numero_documento || '-' || fb.serie) END) AS qtd_nfs_ytd
        FROM faturamento_base fb
        WHERE fb.mes_iso <= $3
          AND fb.cliente IN (SELECT cliente FROM clientes_agg)
        GROUP BY 1, 2
        HAVING COALESCE(SUM(${valorExpr}), 0) > 0
        ORDER BY fb.cliente, valor_ytd DESC
      ),
      contratos_itens_agg AS (
        SELECT
          fb.cliente,
          COALESCE(NULLIF(TRIM(fb.numero_contrato), ''), 'SEM_CONTRATO') AS numero_contrato,
          COALESCE(NULLIF(TRIM(fb.cod_produto), ''), '—') AS cod_produto,
          COALESCE(NULLIF(TRIM(fb.produto), ''), 'Produto não identificado') AS produto,
          COALESCE(SUM(CASE WHEN fb.mes_iso <= $3 AND (NOT is_expurgo OR ${incluirExpurgos ? 'TRUE' : 'FALSE'}) THEN fb.quantidade ELSE 0 END), 0) AS quantidade,
          COALESCE(SUM(CASE WHEN fb.mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_ytd,
          COUNT(DISTINCT CASE WHEN fb.mes_iso <= $3 THEN (fb.cod_filial || '-' || fb.numero_documento || '-' || fb.serie) END) AS qtd_nfs_ytd
        FROM faturamento_base fb
        WHERE fb.mes_iso <= $3
          AND (
            fb.cliente IN (SELECT cliente FROM clientes_agg)
            OR fb.numero_contrato IN (SELECT numero_contrato FROM contratos_agg)
          )
        GROUP BY 1, 2, 3, 4
        HAVING COALESCE(SUM(${valorExpr}), 0) > 0
        ORDER BY valor_ytd DESC
      ),
      unid_clientes_agg AS (
        SELECT
          fb.unidade,
          fb.cliente,
          COALESCE(SUM(CASE WHEN fb.mes_iso = $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_mes,
          COALESCE(SUM(CASE WHEN fb.mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_ytd,
          COUNT(DISTINCT CASE WHEN fb.mes_iso <= $3 THEN (fb.cod_filial || '-' || fb.numero_documento || '-' || fb.serie) END) AS qtd_nfs_ytd
        FROM faturamento_base fb
        WHERE fb.mes_iso <= $3
          AND fb.unidade IN ('Wind', 'Norte', 'Pecém', 'Complexo', 'Engenharia', 'Transportes')
        GROUP BY 1, 2
        HAVING COALESCE(SUM(${valorExpr}), 0) > 0
        ORDER BY fb.unidade, valor_ytd DESC
      ),
      unid_contratos_agg AS (
        SELECT
          fb.unidade,
          fb.cliente,
          COALESCE(NULLIF(TRIM(fb.numero_contrato), ''), 'SEM_CONTRATO') AS numero_contrato,
          COALESCE(SUM(CASE WHEN fb.mes_iso = $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_mes,
          COALESCE(SUM(CASE WHEN fb.mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_ytd,
          COUNT(DISTINCT CASE WHEN fb.mes_iso <= $3 THEN (fb.cod_filial || '-' || fb.numero_documento || '-' || fb.serie) END) AS qtd_nfs_ytd
        FROM faturamento_base fb
        WHERE fb.mes_iso <= $3
          AND fb.unidade IN ('Wind', 'Norte', 'Pecém', 'Complexo', 'Engenharia', 'Transportes')
        GROUP BY 1, 2, 3
        HAVING COALESCE(SUM(${valorExpr}), 0) > 0
        ORDER BY fb.unidade, fb.cliente, valor_ytd DESC
      ),
      unid_itens_agg AS (
        SELECT
          fb.unidade,
          fb.cliente,
          COALESCE(NULLIF(TRIM(fb.numero_contrato), ''), 'SEM_CONTRATO') AS numero_contrato,
          COALESCE(NULLIF(TRIM(fb.cod_produto), ''), '—') AS cod_produto,
          COALESCE(NULLIF(TRIM(fb.produto), ''), 'Produto não identificado') AS produto,
          COALESCE(SUM(CASE WHEN fb.mes_iso <= $3 THEN fb.quantidade ELSE 0 END), 0) AS quantidade,
          COALESCE(SUM(CASE WHEN fb.mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_ytd,
          COUNT(DISTINCT CASE WHEN fb.mes_iso <= $3 THEN (fb.cod_filial || '-' || fb.numero_documento || '-' || fb.serie) END) AS qtd_nfs_ytd
        FROM faturamento_base fb
        WHERE fb.mes_iso <= $3
          AND fb.unidade IN ('Wind', 'Norte', 'Pecém', 'Complexo', 'Engenharia', 'Transportes')
        GROUP BY 1, 2, 3, 4, 5
        HAVING COALESCE(SUM(${valorExpr}), 0) > 0
        ORDER BY valor_ytd DESC
      ),
      exec_clientes_agg AS (
        SELECT
          CASE
            WHEN COALESCE(NULLIF(TRIM(fb.cod_vendedor), ''), '000016') IN ('000016', 'SEM_COD') AND fb.unidade = 'Norte' THEN '000056'
            ELSE COALESCE(NULLIF(TRIM(fb.cod_vendedor), ''), 'SEM_COD')
          END AS cod_vendedor,
          fb.cliente,
          COALESCE(SUM(CASE WHEN fb.mes_iso = $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_mes,
          COALESCE(SUM(CASE WHEN fb.mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_ytd,
          COUNT(DISTINCT CASE WHEN fb.mes_iso <= $3 THEN (fb.cod_filial || '-' || fb.numero_documento || '-' || fb.serie) END) AS qtd_nfs_ytd
        FROM faturamento_base fb
        WHERE fb.mes_iso <= $3
        GROUP BY 1, 2
        HAVING COALESCE(SUM(${valorExpr}), 0) > 0
        ORDER BY 1, valor_ytd DESC
      ),
      exec_contratos_agg AS (
        SELECT
          CASE
            WHEN COALESCE(NULLIF(TRIM(fb.cod_vendedor), ''), '000016') IN ('000016', 'SEM_COD') AND fb.unidade = 'Norte' THEN '000056'
            ELSE COALESCE(NULLIF(TRIM(fb.cod_vendedor), ''), 'SEM_COD')
          END AS cod_vendedor,
          fb.cliente,
          COALESCE(NULLIF(TRIM(fb.numero_contrato), ''), 'SEM_CONTRATO') AS numero_contrato,
          MODE() WITHIN GROUP (ORDER BY fb.unidade) AS unidade,
          COALESCE(SUM(CASE WHEN fb.mes_iso = $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_mes,
          COALESCE(SUM(CASE WHEN fb.mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_ytd,
          COUNT(DISTINCT CASE WHEN fb.mes_iso <= $3 THEN (fb.cod_filial || '-' || fb.numero_documento || '-' || fb.serie) END) AS qtd_nfs_ytd
        FROM faturamento_base fb
        WHERE fb.mes_iso <= $3
        GROUP BY 1, 2, 3
        HAVING COALESCE(SUM(${valorExpr}), 0) > 0
        ORDER BY 1, 2, valor_ytd DESC
      ),
      exec_itens_agg AS (
        SELECT
          CASE
            WHEN COALESCE(NULLIF(TRIM(fb.cod_vendedor), ''), '000016') IN ('000016', 'SEM_COD') AND fb.unidade = 'Norte' THEN '000056'
            ELSE COALESCE(NULLIF(TRIM(fb.cod_vendedor), ''), 'SEM_COD')
          END AS cod_vendedor,
          CASE
            WHEN COALESCE(NULLIF(TRIM(fb.cod_vendedor), ''), '000016') IN ('000016', 'SEM_COD') AND fb.unidade = 'Norte' THEN 'CRISTIANO ASSIS'
            ELSE fb.executivo
          END AS executivo,
          COALESCE(NULLIF(TRIM(fb.produto), ''), 'Produto não identificado') AS produto,
          COALESCE(SUM(CASE WHEN fb.mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_ytd
        FROM faturamento_base fb
        WHERE fb.mes_iso <= $3
        GROUP BY 1, 2, 3
        HAVING COALESCE(SUM(${valorExpr}), 0) > 0
        ORDER BY 1, valor_ytd DESC
      ),
      ctr_itens_all_agg AS (
        SELECT
          TRIM(fb.numero_contrato) AS numero_contrato,
          COALESCE(NULLIF(TRIM(fb.cod_produto), ''), '—') AS cod_produto,
          COALESCE(NULLIF(TRIM(fb.produto), ''), 'Produto não identificado') AS produto,
          COALESCE(SUM(CASE WHEN fb.mes_iso <= $3 THEN fb.quantidade ELSE 0 END), 0) AS quantidade,
          COALESCE(SUM(CASE WHEN fb.mes_iso <= $3 THEN ${valorExpr} ELSE 0 END), 0) AS valor_ytd
        FROM faturamento_base fb
        WHERE fb.mes_iso <= $3
          AND NULLIF(TRIM(fb.numero_contrato), '') IS NOT NULL
        GROUP BY 1, 2, 3
        HAVING COALESCE(SUM(${valorExpr}), 0) > 0
        ORDER BY 1, valor_ytd DESC
      )
      SELECT
        COALESCE((SELECT JSON_AGG(mensal_agg) FROM mensal_agg), '[]'::json) AS mensal,
        COALESCE((SELECT JSON_AGG(unidades_agg) FROM unidades_agg), '[]'::json) AS unidades,
        COALESCE((SELECT JSON_AGG(unidades_mes_agg) FROM unidades_mes_agg), '[]'::json) AS unidades_mes,
        COALESCE((SELECT JSON_AGG(executivos_agg) FROM executivos_agg), '[]'::json) AS executivos,
        COALESCE((SELECT JSON_AGG(clientes_agg) FROM clientes_agg), '[]'::json) AS clientes,
        COALESCE((SELECT JSON_AGG(contratos_agg) FROM contratos_agg), '[]'::json) AS contratos,
        COALESCE((SELECT JSON_AGG(clientes_contratos_agg) FROM clientes_contratos_agg), '[]'::json) AS clientes_contratos,
        COALESCE((SELECT JSON_AGG(contratos_itens_agg) FROM contratos_itens_agg), '[]'::json) AS contratos_itens,
        COALESCE((SELECT JSON_AGG(unid_clientes_agg) FROM unid_clientes_agg), '[]'::json) AS unid_clientes,
        COALESCE((SELECT JSON_AGG(unid_contratos_agg) FROM unid_contratos_agg), '[]'::json) AS unid_contratos,
        COALESCE((SELECT JSON_AGG(unid_itens_agg) FROM unid_itens_agg), '[]'::json) AS unid_itens,
        COALESCE((SELECT JSON_AGG(exec_clientes_agg) FROM exec_clientes_agg), '[]'::json) AS exec_clientes,
        COALESCE((SELECT JSON_AGG(exec_contratos_agg) FROM exec_contratos_agg), '[]'::json) AS exec_contratos,
        COALESCE((SELECT JSON_AGG(exec_itens_agg) FROM exec_itens_agg), '[]'::json) AS exec_itens,
        COALESCE((SELECT JSON_AGG(ctr_itens_all_agg) FROM ctr_itens_all_agg), '[]'::json) AS ctr_itens_all
    `;

    const [
      protheusAggRes,
      mensalPrevYearRes,
      metasUnidadesRes,
      metasExecRes,
      freshnessRes,
      prevMesRes
    ] = await Promise.all([
      pool.query(rmrProtheusAggQuery, [yearStart, yearEndExcl, mesRefIso, `${year}-07`]),
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
          (SELECT MAX(TO_DATE(TRIM(d2_emissao), 'YYYYMMDD'))
           FROM stage_protheus.sd2010
           WHERE COALESCE(TRIM(d_e_l_e_t_), '') <> '*' AND TRIM(COALESCE(d2_emissao, '')) ~ '^\\d{8}$') AS max_emissao_protheus,
          (SELECT MAX(s_t_a_m_p_) FROM stage_protheus.sd2010 WHERE COALESCE(TRIM(d_e_l_e_t_), '') <> '*') AS max_carga_protheus,
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
    const unidadesMesAtualRes = { rows: rmrAgg.unidades_mes || [] };
    const executivosAtualRes = { rows: rmrAgg.executivos || [] };
    const clientesAtualRes = { rows: rmrAgg.clientes || [] };
    const contratosAtualRes = { rows: rmrAgg.contratos || [] };

    // 2) Bitrix CRM + Apropriação + Funil + Perdas + Pipeline + Backlog Protheus + Inadimplência SE1010
    let apropMensal = [];
    let apropPorUnidade = [];
    let apropBacklogResumo = { noAno: 0, noMesRef: 0, futurosProximoAno: 0, qtdContratosMes: 0, qtdContratosAno: 0 };
    let contratosProtheusOp = { resumo: null, itens: [] };
    let medicoesProtheusInfo = { resumoPorSituacao: [], maxEmissao: null };
    let backlogProtheusReal = { disponivel: false, resumo: null, porUnidade: [], contratos: [] };
    let inadimplencia = { disponivel: false, resumo: null, porFaixa: [], topClientes: [] };

    const tesSql = COMMERCIAL_TES.map(t => `'${t}'`).join(',');
    const cfopSql = REVENUE_CFOPS.map(c => `'${c}'`).join(',');
    const expurgoFilialSql = EXPURGO_FILIAIS.map(f => `'${f}'`).join(',');

    const [apropResult, contratosOpResult, medicoesOpResult, backlogRealResult, inadResult] = await Promise.all([
      permAprop.canSelect
        ? Promise.all([
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
            `, [year, month]),
            pool.query(`
              SELECT
                mes,
                COALESCE(NULLIF(TRIM(unidade_negocio), ''), 'Não informado') AS unidade,
                COALESCE(SUM(receita_apropriada), 0) AS valor
              FROM comercial.fato_apropriacao_receita_mensal
              WHERE ano = $1 AND mes > $2
              GROUP BY 1, 2
              ORDER BY 1, 2
            `, [year, month])
          ])
        : Promise.resolve(null),
      permContratosOp.canSelect
        ? Promise.all([
            pool.query(`
              SELECT
                COUNT(*) FILTER (WHERE status = 'Aberto')::int AS qtd_abertos,
                COUNT(*) FILTER (WHERE status = 'Aberto' AND modalidade_contrato = 'Contrato')::int AS qtd_contratos_abertos,
                COUNT(*) FILTER (WHERE status = 'Aberto' AND modalidade_contrato = 'Spot')::int AS qtd_spot_abertos,
                COALESCE(SUM(valor_global_contrato) FILTER (WHERE status = 'Aberto'), 0) AS valor_global_abertos,
                COALESCE(SUM(valor_faturado) FILTER (WHERE status = 'Aberto'), 0) AS valor_faturado_abertos,
                COALESCE(SUM(GREATEST(COALESCE(valor_global_contrato, 0) - COALESCE(valor_faturado, 0), 0)) FILTER (WHERE status = 'Aberto'), 0) AS saldo_contratual_abertos,
                COALESCE(SUM(saldo_receber) FILTER (WHERE status = 'Aberto'), 0) AS saldo_receber_abertos,
                MAX(data_emissao_contrato) AS ultima_emissao,
                MAX(ultima_alteracao) AS ultima_alteracao
              FROM comercial.contratos_operacional
            `),
            pool.query(`
              SELECT
                TRIM(COALESCE(nr_contrato, '')) AS nr_contrato,
                TRIM(COALESCE(cod_filial, '')) AS cod_filial,
                COALESCE(NULLIF(TRIM(modalidade_contrato), ''), 'Não informado') AS modalidade,
                COALESCE(NULLIF(TRIM(nome_cliente), ''), 'Cliente N/I') AS cliente,
                COALESCE(NULLIF(TRIM(nome_unidade), ''), NULLIF(TRIM(cod_unidade), ''), '—') AS unidade,
                COALESCE(NULLIF(TRIM(nome_gerente), ''), NULLIF(TRIM(nome_vendedor), ''), '—') AS responsavel,
                TO_CHAR(data_inicio_contrato, 'YYYY-MM-DD') AS data_inicio,
                TO_CHAR(data_fim_contrato, 'YYYY-MM-DD') AS data_fim,
                COALESCE(valor_global_contrato, 0)::numeric AS valor_global,
                COALESCE(valor_faturado, 0)::numeric AS valor_faturado,
                GREATEST(COALESCE(valor_global_contrato, 0) - COALESCE(valor_faturado, 0), 0)::numeric AS saldo_contratual,
                COALESCE(saldo_receber, 0)::numeric AS saldo_receber
              FROM comercial.contratos_operacional
              WHERE status = 'Aberto'
              ORDER BY COALESCE(valor_global_contrato, 0) DESC, data_inicio_contrato DESC NULLS LAST
              LIMIT 15
            `)
          ]).catch(() => null)
        : Promise.resolve(null),
      permMedicoes.canSelect
        ? pool.query(`
            SELECT
              COALESCE(NULLIF(TRIM(situacao), ''), 'Sem situação') AS situacao,
              COALESCE(NULLIF(TRIM(modalidade), ''), 'Não informado') AS modalidade,
              COUNT(*)::int AS qtd,
              COALESCE(SUM(valor_global), 0)::numeric AS valor_global,
              MAX(dt_emissao) AS max_emissao
            FROM comercial.protheus_gold_medicoes_pendentes
            GROUP BY 1, 2
            ORDER BY qtd DESC
          `).catch(() => null)
        : Promise.resolve(null),
      permMedicoes.canSelect
        ? pool.query(`
            WITH sd2_ctr AS (
              SELECT
                TRIM(d2_ynumctr) AS nr_contrato,
                COALESCE(SUM(d2_total), 0)::numeric AS fat_sd2,
                MAX(NULLIF(LEFT(TRIM(COALESCE(d2_ccusto, '')), 3), '')) AS sd2_cc3
              FROM stage_protheus.sd2010
              WHERE COALESCE(TRIM(d_e_l_e_t_), '') <> '*'
                AND TRIM(COALESCE(d2_ynumctr, '')) <> ''
                AND TRIM(COALESCE(d2_tes, '')) IN (${tesSql})
                AND TRIM(COALESCE(d2_cf, '')) IN (${cfopSql})
              GROUP BY 1
            ),
            ctr_base AS (
              SELECT DISTINCT ON (TRIM(numero_contrato))
                TRIM(numero_contrato) AS nr_contrato,
                TRIM(COALESCE(cod_filial, '')) AS cod_filial,
                COALESCE(NULLIF(TRIM(modalidade), ''), 'Contrato') AS modalidade,
                COALESCE(NULLIF(TRIM(cliente), ''), 'Cliente N/I') AS cliente,
                NULLIF(LEFT(TRIM(COALESCE(centro_custo, '')), 3), '') AS cc3,
                COALESCE(NULLIF(TRIM(vendedor), ''), '—') AS responsavel,
                dt_inicio::date AS dt_ini,
                CASE
                  WHEN dt_inicio IS NULL OR COALESCE(duracao, 0) <= 0 THEN NULL
                  WHEN UPPER(COALESCE(tipo_duracao, '')) LIKE 'DIA%' THEN (dt_inicio::date + (duracao || ' days')::interval)::date
                  WHEN UPPER(COALESCE(tipo_duracao, '')) LIKE 'M%' THEN (dt_inicio::date + (duracao || ' months')::interval)::date
                  WHEN UPPER(COALESCE(tipo_duracao, '')) LIKE 'ANO%' THEN (dt_inicio::date + (duracao || ' years')::interval)::date
                  ELSE NULL
                END AS dt_fim,
                COALESCE(valor_global, 0)::numeric AS valor_global
              FROM comercial.protheus_gold_medicoes_pendentes
              WHERE situacao = 'Aberto'
                AND TRIM(COALESCE(cod_filial, '')) NOT IN (${expurgoFilialSql})
                AND LEFT(TRIM(COALESCE(centro_custo, '')), 3) NOT IN ('321', '330', '421')
              ORDER BY TRIM(numero_contrato), dt_inicio DESC NULLS LAST, valor_global DESC
            ),
            ctr_vigente AS (
              SELECT
                c.*,
                COALESCE(c.cc3, s.sd2_cc3) AS cc3_real,
                COALESCE(s.fat_sd2, 0)::numeric AS fat_sd2
              FROM ctr_base c
              LEFT JOIN sd2_ctr s ON s.nr_contrato = c.nr_contrato
              WHERE c.dt_fim IS NULL OR c.dt_fim >= CURRENT_DATE
            )
            SELECT
              c.nr_contrato,
              c.cod_filial,
              c.modalidade,
              c.cliente,
              CASE
                WHEN c.cc3_real = '413' THEN 'Pecém'
                WHEN c.cc3_real IN ('414', '423') THEN 'Wind'
                WHEN c.cc3_real = '415' THEN 'Engenharia'
                WHEN c.cc3_real = '416' THEN 'Norte'
                WHEN c.cc3_real IN ('417', '424', '425') THEN 'Complexo'
                WHEN c.cc3_real = '420' THEN 'Transportes'
                WHEN UPPER(c.responsavel) LIKE '%BRUNO%' THEN 'Wind'
                WHEN UPPER(c.responsavel) LIKE '%CRISTIANO%' THEN 'Norte'
                WHEN UPPER(c.responsavel) LIKE '%MARCIO%' THEN 'Engenharia'
                WHEN UPPER(c.responsavel) LIKE '%THIAGO%' THEN 'Pecém'
                WHEN UPPER(c.responsavel) LIKE '%FERNANDO%' OR UPPER(c.responsavel) LIKE '%FABRICIO%' THEN 'Complexo'
                WHEN c.cod_filial = '030301' THEN 'Norte'
                WHEN c.cod_filial = '060601' THEN 'Pecém'
                ELSE 'Outros'
              END AS unidade,
              c.responsavel,
              TO_CHAR(c.dt_ini, 'YYYY-MM-DD') AS data_inicio,
              TO_CHAR(c.dt_fim, 'YYYY-MM-DD') AS data_fim,
              CASE WHEN c.dt_ini IS NOT NULL THEN GREATEST(0, (CURRENT_DATE - c.dt_ini)::int) ELSE NULL END AS dias_decorridos,
              CASE WHEN c.dt_fim IS NOT NULL THEN (c.dt_fim - CURRENT_DATE)::int ELSE NULL END AS dias_restantes,
              CASE WHEN c.dt_ini IS NOT NULL AND c.dt_fim IS NOT NULL THEN GREATEST(1, (c.dt_fim - c.dt_ini)::int) ELSE NULL END AS dias_totais,
              c.valor_global,
              c.fat_sd2 AS faturado_real,
              GREATEST(c.valor_global - c.fat_sd2, 0)::numeric AS backlog_real
            FROM ctr_vigente c
            ORDER BY backlog_real DESC, c.valor_global DESC
          `).catch(() => null)
        : Promise.resolve(null),
      permSe1010.canSelect
        ? pool.query(`
            WITH titulos AS (
              SELECT
                TRIM(e1_filial) AS filial,
                TRIM(e1_prefixo) AS prefixo,
                TRIM(e1_num) AS titulo,
                TRIM(COALESCE(NULLIF(TRIM(e1_nomcli), ''), 'Cliente N/I')) AS cliente,
                TO_DATE(TRIM(e1_vencto), 'YYYYMMDD') AS vencto,
                (CURRENT_DATE - TO_DATE(TRIM(e1_vencto), 'YYYYMMDD'))::int AS dias_atraso,
                COALESCE(e1_saldo, 0)::numeric AS saldo
              FROM stage_protheus.se1010
              WHERE COALESCE(TRIM(d_e_l_e_t_), '') <> '*'
                AND COALESCE(e1_saldo, 0) > 0
                AND TRIM(COALESCE(e1_vencto, '')) ~ '^\\d{8}$'
                AND TO_DATE(TRIM(e1_vencto), 'YYYYMMDD') < CURRENT_DATE
                AND TRIM(COALESCE(e1_tipo, '')) = 'NF'
                AND TRIM(COALESCE(e1_naturez, '')) IN ('11101', '11201', '11202', '11203', '11301')
                AND TRIM(COALESCE(e1_prefixo, '')) <> '1'
                AND TRIM(COALESCE(e1_filial, '')) NOT IN (${expurgoFilialSql})
                AND UPPER(COALESCE(e1_nomcli, '')) NOT LIKE '%CORDEIRO%'
            ),
            resumo AS (
              SELECT
                COUNT(*) FILTER (WHERE dias_atraso <= 30)::int AS qtd_ate_30,
                COALESCE(SUM(saldo) FILTER (WHERE dias_atraso <= 30), 0)::numeric AS val_ate_30,
                COUNT(*) FILTER (WHERE dias_atraso > 30 AND dias_atraso <= 365)::int AS qtd_31_365,
                COALESCE(SUM(saldo) FILTER (WHERE dias_atraso > 30 AND dias_atraso <= 365), 0)::numeric AS val_31_365,
                COUNT(*) FILTER (WHERE dias_atraso <= 365)::int AS qtd_total_365,
                COALESCE(SUM(saldo) FILTER (WHERE dias_atraso <= 365), 0)::numeric AS val_total_365,
                COUNT(DISTINCT cliente) FILTER (WHERE dias_atraso <= 365)::int AS clientes_365,
                COUNT(*) FILTER (WHERE dias_atraso > 365)::int AS qtd_perda_365,
                COALESCE(SUM(saldo) FILTER (WHERE dias_atraso > 365), 0)::numeric AS val_perda_365
              FROM titulos
            ),
            faixas AS (
              SELECT
                CASE
                  WHEN dias_atraso <= 30 THEN '1 a 30 dias (Atraso)'
                  WHEN dias_atraso <= 90 THEN '31 a 90 dias'
                  WHEN dias_atraso <= 180 THEN '91 a 180 dias'
                  WHEN dias_atraso <= 365 THEN '181 a 365 dias'
                  ELSE 'Acima de 365 dias (Perda)'
                END AS faixa,
                CASE
                  WHEN dias_atraso <= 30 THEN 1
                  WHEN dias_atraso <= 90 THEN 2
                  WHEN dias_atraso <= 180 THEN 3
                  WHEN dias_atraso <= 365 THEN 4
                  ELSE 5
                END AS ordem,
                COUNT(*)::int AS qtd,
                COALESCE(SUM(saldo), 0)::numeric AS valor
              FROM titulos
              GROUP BY 1, 2
              ORDER BY 2
            ),
            clientes AS (
              SELECT
                cliente,
                COUNT(*)::int AS qtd_titulos,
                MAX(dias_atraso)::int AS max_dias_atraso,
                COALESCE(SUM(saldo), 0)::numeric AS valor
              FROM titulos
              WHERE dias_atraso <= 365
              GROUP BY 1
              ORDER BY valor DESC
              LIMIT 15
            )
            SELECT
              (SELECT ROW_TO_JSON(resumo) FROM resumo) AS resumo,
              COALESCE((SELECT JSON_AGG(faixas) FROM faixas), '[]'::json) AS faixas,
              COALESCE((SELECT JSON_AGG(clientes) FROM clientes), '[]'::json) AS clientes
          `).catch(() => null)
        : Promise.resolve(null)
    ]);

    let apropRestantePorUnidadeMes = [];
    if (apropResult) {
      const [apropMesRes, apropUnidRes, apropFutRes, apropRestUnidRes] = apropResult;
      apropRestantePorUnidadeMes = apropRestUnidRes?.rows || [];
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

    if (contratosOpResult) {
      const [ctrResumoRes, ctrItensRes] = contratosOpResult;
      const cr = ctrResumoRes.rows[0] || {};
      contratosProtheusOp = {
        resumo: {
          qtdAbertos: Number(cr.qtd_abertos || 0),
          qtdContratosAbertos: Number(cr.qtd_contratos_abertos || 0),
          qtdSpotAbertos: Number(cr.qtd_spot_abertos || 0),
          valorGlobalAbertos: toNumber(cr.valor_global_abertos),
          valorFaturadoAbertos: toNumber(cr.valor_faturado_abertos),
          saldoContratualAbertos: toNumber(cr.saldo_contratual_abertos),
          saldoReceberAbertos: toNumber(cr.saldo_receber_abertos),
          ultimaEmissao: cr.ultima_emissao ? String(cr.ultima_emissao).slice(0, 10) : null,
          ultimaAlteracao: cr.ultima_alteracao ? String(cr.ultima_alteracao).slice(0, 10) : null
        },
        itens: (ctrItensRes.rows || []).map(r => ({
          nrContrato: r.nr_contrato,
          codFilial: r.cod_filial,
          modalidade: r.modalidade,
          cliente: r.cliente,
          unidade: r.unidade,
          responsavel: r.responsavel,
          dataInicio: r.data_inicio || null,
          dataFim: r.data_fim || null,
          valorGlobal: toNumber(r.valor_global),
          valorFaturado: toNumber(r.valor_faturado),
          saldoContratual: toNumber(r.saldo_contratual),
          saldoReceber: toNumber(r.saldo_receber)
        }))
      };
    }

    if (medicoesOpResult) {
      const medRows = medicoesOpResult.rows || [];
      const maxDt = medRows.reduce((acc, r) => {
        const d = r.max_emissao ? String(r.max_emissao).slice(0, 10) : '';
        return d && d > acc ? d : acc;
      }, '');
      medicoesProtheusInfo = {
        maxEmissao: maxDt || null,
        resumoPorSituacao: medRows.map(r => ({
          situacao: r.situacao,
          modalidade: r.modalidade,
          qtd: Number(r.qtd || 0),
          valorGlobal: toNumber(r.valor_global)
        }))
      };
    }

    if (backlogRealResult && backlogRealResult.rows) {
      const rows = backlogRealResult.rows;
      const contratos = rows.map(r => {
        const valorGlobal = toNumber(r.valor_global);
        const faturadoReal = toNumber(r.faturado_real);
        const backlogReal = toNumber(r.backlog_real);
        const pctConsumido = valorGlobal > 0 ? Math.min(100, (faturadoReal / valorGlobal) * 100) : 0;
        return {
          nrContrato: r.nr_contrato,
          codFilial: r.cod_filial,
          modalidade: r.modalidade,
          cliente: r.cliente,
          unidade: r.unidade,
          responsavel: r.responsavel,
          dataInicio: r.data_inicio || null,
          dataFim: r.data_fim || null,
          diasDecorridos: r.dias_decorridos !== null && r.dias_decorridos !== undefined ? Number(r.dias_decorridos) : null,
          diasRestantes: r.dias_restantes !== null && r.dias_restantes !== undefined ? Number(r.dias_restantes) : null,
          diasTotais: r.dias_totais !== null && r.dias_totais !== undefined ? Number(r.dias_totais) : null,
          valorGlobal,
          faturadoReal,
          backlogReal,
          pctConsumido
        };
      });
      const porUnidadeMap = {};
      let venc30Qtd = 0;
      let venc30Val = 0;
      let venc60Qtd = 0;
      let venc60Val = 0;
      for (const c of contratos) {
        if (!porUnidadeMap[c.unidade]) {
          porUnidadeMap[c.unidade] = { unidade: c.unidade, qtd: 0, valorGlobal: 0, faturadoReal: 0, backlogReal: 0 };
        }
        porUnidadeMap[c.unidade].qtd += 1;
        porUnidadeMap[c.unidade].valorGlobal += c.valorGlobal;
        porUnidadeMap[c.unidade].faturadoReal += c.faturadoReal;
        porUnidadeMap[c.unidade].backlogReal += c.backlogReal;
        if (c.diasRestantes !== null && c.diasRestantes <= 30) {
          venc30Qtd += 1;
          venc30Val += c.backlogReal;
        } else if (c.diasRestantes !== null && c.diasRestantes <= 60) {
          venc60Qtd += 1;
          venc60Val += c.backlogReal;
        }
      }
      backlogProtheusReal = {
        disponivel: true,
        resumo: {
          qtdVigentes: contratos.length,
          valorGlobal: contratos.reduce((s, c) => s + c.valorGlobal, 0),
          faturadoReal: contratos.reduce((s, c) => s + c.faturadoReal, 0),
          backlogReal: contratos.reduce((s, c) => s + c.backlogReal, 0),
          vencendo30dQtd: venc30Qtd,
          vencendo30dValor: venc30Val,
          vencendo60dQtd: venc60Qtd,
          vencendo60dValor: venc60Val
        },
        porUnidade: Object.values(porUnidadeMap).sort((a, b) => b.backlogReal - a.backlogReal),
        contratos
      };
    }

    if (inadResult && inadResult.rows && inadResult.rows[0]) {
      const ir = inadResult.rows[0];
      const resRow = ir.resumo || {};
      inadimplencia = {
        disponivel: true,
        fonte: 'stage_protheus.se1010 (NF · Naturezas 11101/11201/11202/11203/11301 · Sem expurgos/intercompany/ativo)',
        resumo: {
          ate30DiasQtd: Number(resRow.qtd_ate_30 || 0),
          ate30DiasValor: toNumber(resRow.val_ate_30),
          de31a365DiasQtd: Number(resRow.qtd_31_365 || 0),
          de31a365DiasValor: toNumber(resRow.val_31_365),
          total365DiasQtd: Number(resRow.qtd_total_365 || 0),
          total365DiasValor: toNumber(resRow.val_total_365),
          clientes365: Number(resRow.clientes_365 || 0),
          perdaAcima365Qtd: Number(resRow.qtd_perda_365 || 0),
          perdaAcima365Valor: toNumber(resRow.val_perda_365)
        },
        porFaixa: (ir.faixas || []).map(f => ({
          faixa: f.faixa,
          qtd: Number(f.qtd || 0),
          valor: toNumber(f.valor)
        })),
        topClientes: (ir.clientes || []).map(c => ({
          cliente: c.cliente,
          qtdTitulos: Number(c.qtd_titulos || 0),
          maxDiasAtraso: Number(c.max_dias_atraso || 0),
          valor: toNumber(c.valor)
        }))
      };
    }

    // Pipeline aberto + Contratos Ativos Bitrix + Ganhos/Perdas Bitrix + Produtos Funil
    let pipelineRows = [];
    let activeContractsBitrix = [];
    let closedDealsRows = [];
    let stageAvgRows = [];
    let funilProdRows = [];
    let bitrixTempMap = {};

    if (permBitrixDeal.canSelect) {
      const unitSql = normalizeDealUnitSql('d', 'uf');
      const oppSql = safeNumericDealSql('d."OPPORTUNITY"');

      const [pipeRes, activeCtrRes, closedRes, tempoRes, funilProdRes, tempRes] = await Promise.all([
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
           AND st."ENTITY_ID" = 'DEAL_STAGE_19'
          WHERE d."CATEGORY_ID" = '19'
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
           AND st."ENTITY_ID" = 'DEAL_STAGE_4'
          WHERE (
            d."STAGE_ID" IN ('C4:UC_2ZQLVL', 'C4:UC_RPFFJU', 'C4:UC_JDNYZT', 'C4:UC_FOYMHF', 'C4:UC_VHKW1X')
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
          WHERE d."CATEGORY_ID" = '19'
            AND d."STAGE_SEMANTIC_ID" IN ('S', 'F')
            AND LEFT(COALESCE(d."CLOSEDATE"::text, d."MOVED_TIME"::text, ''), 7) = $1
        `, [mesRefIso]),
        permTempoEtapa.canSelect
          ? pool.query(`
              SELECT
                nome_funil,
                nome_etapa,
                COUNT(*)::int AS passagens,
                ROUND(AVG(COALESCE(dias_na_etapa, 0))::numeric, 1) AS media_dias
              FROM comercial.fato_tempo_etapa_negocio
              WHERE EXTRACT(YEAR FROM data_entrada)::int = $1
                AND id_categoria_funil = 19
              GROUP BY 1, 2
              ORDER BY passagens DESC
              LIMIT 12
            `, [year]).catch(() => ({ rows: [] }))
          : Promise.resolve({ rows: [] }),
        pool.query(`
          SELECT
            d."ID"::text AS deal_id,
            COALESCE(NULLIF(TRIM(CONCAT(u."NAME", ' ', COALESCE(u."LAST_NAME", ''))), ''), 'Sem executivo') AS executivo,
            COALESCE(NULLIF(TRIM(pr."PRODUCT_NAME"), ''), NULLIF(TRIM(pr."ORIGINAL_PRODUCT_NAME"), ''), 'Equipamento não especificado') AS produto,
            COALESCE(SUM(COALESCE(NULLIF(pr."QUANTITY"::numeric, 0), 1)), 0)::numeric AS quantidade,
            COALESCE(SUM(COALESCE(pr."PRICE_ACCOUNT"::numeric, pr."PRICE"::numeric, 0) * COALESCE(NULLIF(pr."QUANTITY"::numeric, 0), 1)), 0)::numeric AS valor_total
          FROM stage_bitrix.b_crm_product_row pr
          JOIN stage_bitrix.b_crm_deal d ON d."ID"::text = pr."OWNER_ID"::text
          LEFT JOIN stage_bitrix.b_user u ON u."ID"::text = d."ASSIGNED_BY_ID"::text
          WHERE pr."OWNER_TYPE" = 'D'
            AND d."CATEGORY_ID" = '19'
            AND d."STAGE_SEMANTIC_ID" = 'P'
            AND COALESCE(d."TITLE", '') NOT ILIKE '%ORÇAMENTO ORIENTATIVO%'
            AND COALESCE(d."TITLE", '') NOT ILIKE '%ORCAMENTO ORIENTATIVO%'
          GROUP BY 1, 2, 3
          HAVING COALESCE(SUM(COALESCE(pr."PRICE_ACCOUNT"::numeric, pr."PRICE"::numeric, 0) * COALESCE(NULLIF(pr."QUANTITY"::numeric, 0), 1)), 0) > 0
          ORDER BY valor_total DESC
        `).catch(() => ({ rows: [] })),
        getBitrixTemperaturasC4().catch(() => ({}))
      ]);

      pipelineRows = pipeRes.rows;
      activeContractsBitrix = activeCtrRes.rows;
      closedDealsRows = closedRes.rows;
      stageAvgRows = tempoRes.rows;
      funilProdRows = funilProdRes?.rows || [];
      bitrixTempMap = tempRes || {};
    }

    // --- Montagem 1: Metas de Unidades & Série Mensal Consolidada ---
    const baseOficial = loadRmrBaseOficial();
    const unidPlanilhaMesMap = {};
    const unidPlanilhaAnualMap = {};
    const unidPlanilhaMesTotalRealizado = {};
    const unidPlanilhaMesTotalMeta = {};

    for (const r of baseOficial.unidadesRmr || []) {
      if (Number(r.ano) !== year) continue;
      const mIso = r.mesIso || `${year}-${String(r.mes).padStart(2, '0')}`;
      if (!unidPlanilhaMesMap[mIso]) unidPlanilhaMesMap[mIso] = {};
      unidPlanilhaMesMap[mIso][r.unidade] = r;
      if (r.metaAnualOficial !== null && r.metaAnualOficial !== undefined) {
        unidPlanilhaAnualMap[r.unidade] = toNumber(r.metaAnualOficial);
      }
      if (r.realizadoOficial !== null && r.realizadoOficial !== undefined) {
        unidPlanilhaMesTotalRealizado[mIso] = (unidPlanilhaMesTotalRealizado[mIso] || 0) + toNumber(r.realizadoOficial);
      }
      if (r.metaMes !== null && r.metaMes !== undefined) {
        unidPlanilhaMesTotalMeta[mIso] = (unidPlanilhaMesTotalMeta[mIso] || 0) + toNumber(r.metaMes);
      }
    }

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

    if (!incluirExpurgos) {
      for (const [u, metaAnual] of Object.entries(unidPlanilhaAnualMap)) {
        metaUnidadeAnualMap[u] = metaAnual;
      }
      for (const [mIso, rowsByU] of Object.entries(unidPlanilhaMesMap)) {
        if (unidPlanilhaMesTotalMeta[mIso] > 0) {
          metaPorMes[mIso] = unidPlanilhaMesTotalMeta[mIso];
        }
        for (const [u, r] of Object.entries(rowsByU)) {
          if (r.metaMes !== null && r.metaMes !== undefined) {
            if (!metaPorUnidadeMes[u]) metaPorUnidadeMes[u] = {};
            metaPorUnidadeMes[u][mIso] = {
              ...(metaPorUnidadeMes[u][mIso] || {}),
              alvo: toNumber(r.metaMes)
            };
          }
        }
      }
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
      const hasOficialMes = !incluirExpurgos && unidPlanilhaMesTotalRealizado[mesIso] !== undefined;
      const liquido = hasOficialMes ? unidPlanilhaMesTotalRealizado[mesIso] : toNumber(row?.liquido);
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
const UNIDADES_COMERCIAIS_OFICIAIS = new Set([
  'Wind',
  'Norte',
  'Pecém',
  'Complexo',
  'Engenharia',
  'Transportes'
]);

const EXECUTIVOS_COMERCIAIS_OFICIAIS = [
  'CRISTIANO',
  'BRUNO',
  'FERNANDO',
  'CORDEIRO',
  'CRISTIANE',
  'MARCIO',
  'FABRICIO'
];

function isExecutivoComercialOficial(nome) {
  const norm = String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  return EXECUTIVOS_COMERCIAIS_OFICIAIS.some(ex => norm.includes(ex));
}

    const metaAnualTotal = Array.from(UNIDADES_COMERCIAIS_OFICIAIS)
      .reduce((s, u) => s + (metaUnidadeAnualMap[u] || 0), 0);

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
    const fatUnitMesMap = {};
    for (const r of unidadesMesAtualRes.rows) {
      if (!fatUnitMesMap[r.unidade]) fatUnitMesMap[r.unidade] = {};
      fatUnitMesMap[r.unidade][r.mes] = toNumber(r.valor);
    }

    const calcRealizadoYtdUnidade = (unidade, fallbackDwYtd) => {
      if (incluirExpurgos) return toNumber(fallbackDwYtd);
      const planMes = unidPlanilhaMesMap[mesRefIso]?.[unidade];
      if (planMes?.realizadoYtdOficial !== null && planMes?.realizadoYtdOficial !== undefined) {
        return toNumber(planMes.realizadoYtdOficial);
      }
      // Se o mês atual ainda não tem fechamento oficial YTD, soma o último mês fechado oficial + meses seguintes do DW
      for (let mPrev = month - 1; mPrev >= 1; mPrev--) {
        const mPrevIso = `${year}-${String(mPrev).padStart(2, '0')}`;
        const prevPlan = unidPlanilhaMesMap[mPrevIso]?.[unidade];
        if (prevPlan?.realizadoYtdOficial !== null && prevPlan?.realizadoYtdOficial !== undefined) {
          let soma = toNumber(prevPlan.realizadoYtdOficial);
          for (let mPost = mPrev + 1; mPost <= month; mPost++) {
            const mPostIso = `${year}-${String(mPost).padStart(2, '0')}`;
            soma += fatUnitMesMap[unidade]?.[mPostIso] || 0;
          }
          return soma;
        }
      }
      return toNumber(fallbackDwYtd);
    };

    const unidItensMap = {};
    for (const it of rmrAgg.unid_itens || []) {
      const k = `${it.unidade}|||${it.cliente}|||${it.numero_contrato}`;
      if (!unidItensMap[k]) unidItensMap[k] = [];
      unidItensMap[k].push({
        codProduto: it.cod_produto,
        produto: it.produto,
        quantidade: toNumber(it.quantidade),
        valorYtd: toNumber(it.valor_ytd),
        qtdNfsYtd: Number(it.qtd_nfs_ytd || 0)
      });
    }
    const unidContratosMap = {};
    for (const cc of rmrAgg.unid_contratos || []) {
      const kCli = `${cc.unidade}|||${cc.cliente}`;
      const kCtr = `${cc.unidade}|||${cc.cliente}|||${cc.numero_contrato}`;
      if (!unidContratosMap[kCli]) unidContratosMap[kCli] = [];
      unidContratosMap[kCli].push({
        numeroContrato: cc.numero_contrato,
        valorMes: toNumber(cc.valor_mes),
        valorYtd: toNumber(cc.valor_ytd),
        qtdNfsYtd: Number(cc.qtd_nfs_ytd || 0),
        itens: unidItensMap[kCtr] || []
      });
    }
    const unidClientesMap = {};
    for (const cl of rmrAgg.unid_clientes || []) {
      if (!unidClientesMap[cl.unidade]) unidClientesMap[cl.unidade] = [];
      const kCli = `${cl.unidade}|||${cl.cliente}`;
      unidClientesMap[cl.unidade].push({
        cliente: cl.cliente,
        valorMes: toNumber(cl.valor_mes),
        valorYtd: toNumber(cl.valor_ytd),
        qtdNfsYtd: Number(cl.qtd_nfs_ytd || 0),
        contratos: unidContratosMap[kCli] || []
      });
    }

    const unidadesComparativo = Array.from(allUnits)
      .filter(unidade => UNIDADES_COMERCIAIS_OFICIAIS.has(unidade))
      .map(unidade => {
      const f = fatUnitMap[unidade];
      const planMes = !incluirExpurgos ? unidPlanilhaMesMap[mesRefIso]?.[unidade] : null;
      const mesesMeta = metaPorUnidadeMes[unidade] || {};
      const metaMes = mesesMeta[mesRefIso]?.alvo || 0;
      let metaYtd = 0;
      for (let m = 1; m <= month; m++) {
        const k = `${year}-${String(m).padStart(2, '0')}`;
        metaYtd += mesesMeta[k]?.alvo || 0;
      }
      const metaAnual = metaUnidadeAnualMap[unidade] || 0;
      const realizadoMes = planMes?.realizadoOficial !== null && planMes?.realizadoOficial !== undefined
        ? toNumber(planMes.realizadoOficial)
        : toNumber(f?.realizado_mes);
      const realizadoYtd = calcRealizadoYtdUnidade(unidade, f?.realizado_ytd);
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
        qtdNfsYtd: Number(f?.qtd_nfs_ytd || 0),
        clientes: unidClientesMap[unidade] || []
      };
    }).sort((a, b) => (b.realizadoYtd + b.metaAnual) - (a.realizadoYtd + a.metaAnual));

    // Garante consistência total entre o YTD Executivo e a soma das Unidades Oficiais
    const ytdUnidadesTotal = unidadesComparativo.reduce((s, u) => s + u.realizadoYtd, 0);
    if (!incluirExpurgos && ytdUnidadesTotal > 0) {
      executivoResumo.ytd.valorPrincipal = ytdUnidadesTotal;
      executivoResumo.ytd.atingimentoYtdPct = executivoResumo.ytd.metaYtd > 0 ? (ytdUnidadesTotal / executivoResumo.ytd.metaYtd) * 100 : null;
      executivoResumo.ytd.atingimentoAnualPct = executivoResumo.ytd.metaAnual > 0 ? (ytdUnidadesTotal / executivoResumo.ytd.metaAnual) * 100 : null;
      executivoResumo.ytd.variacaoYoYPct = executivoResumo.ytd.valorAnoAnteriorYtd > 0 ? ((ytdUnidadesTotal - executivoResumo.ytd.valorAnoAnteriorYtd) / executivoResumo.ytd.valorAnoAnteriorYtd) * 100 : null;
    }

    const planExecMesMap = {};
    const planExecYtdMap = {};
    const planExecMetaInfoMap = {};
    for (const r of baseOficial.metasExecutivos || []) {
      if (Number(r.ano) !== year) continue;
      const cod = String(r.codVendedor || '').trim();
      if (!cod) continue;
      planExecMetaInfoMap[cod] = r;
      if (Number(r.mes) === month) {
        planExecMesMap[cod] = toNumber(r.metaMensal);
      }
      if (Number(r.mes) <= month) {
        if (!planExecYtdMap[cod]) planExecYtdMap[cod] = { sum: 0, count: 0 };
        planExecYtdMap[cod].sum += toNumber(r.metaMensal);
        planExecYtdMap[cod].count += 1;
      }
    }

    const metaExecMap = Object.fromEntries(metasExecRes.rows.map(r => [r.cod_vendedor, r]));
    const execRealMap = Object.fromEntries(executivosAtualRes.rows.map(r => [r.cod_vendedor, r]));
    const allExecCod = new Set([
      ...Object.keys(metaExecMap),
      ...Object.keys(execRealMap),
      ...Object.keys(planExecMetaInfoMap)
    ]);

    const execContratosMap = {};
    for (const cc of rmrAgg.exec_contratos || []) {
      const k = `${cc.cod_vendedor}|||${cc.cliente}`;
      if (!execContratosMap[k]) execContratosMap[k] = [];
      execContratosMap[k].push({
        numeroContrato: cc.numero_contrato,
        unidade: cc.unidade || '—',
        valorMes: toNumber(cc.valor_mes),
        valorYtd: toNumber(cc.valor_ytd),
        qtdNfsYtd: Number(cc.qtd_nfs_ytd || 0)
      });
    }
    const execClientesMap = {};
    for (const cl of rmrAgg.exec_clientes || []) {
      if (!execClientesMap[cl.cod_vendedor]) execClientesMap[cl.cod_vendedor] = [];
      const k = `${cl.cod_vendedor}|||${cl.cliente}`;
      execClientesMap[cl.cod_vendedor].push({
        cliente: cl.cliente,
        valorMes: toNumber(cl.valor_mes),
        valorYtd: toNumber(cl.valor_ytd),
        qtdNfsYtd: Number(cl.qtd_nfs_ytd || 0),
        contratos: execContratosMap[k] || []
      });
    }

    const executivosComparativo = Array.from(allExecCod).map(cod => {
      const real = execRealMap[cod];
      const meta = metaExecMap[cod];
      const planInfo = planExecMetaInfoMap[cod];
      const nome = real?.executivo || planInfo?.executivo || meta?.nome_meta || `Vendedor ${cod}`;
      const realizadoMes = toNumber(real?.realizado_mes);
      const realizadoYtd = toNumber(real?.realizado_ytd);
      const metaAnualAlvo = cod === '000056' && metaUnidadeAnualMap['Norte']
        ? metaUnidadeAnualMap['Norte']
        : toNumber(meta?.meta_anual_alvo);
      const hasPlanMes = planExecMesMap[cod] !== undefined;
      const metaMes = hasPlanMes
        ? planExecMesMap[cod]
        : (metaAnualAlvo > 0 ? metaAnualAlvo / 12 : 0);
      const planYtd = planExecYtdMap[cod];
      let metaYtdNorte = 0;
      if (cod === '000056') {
        for (let m = 1; m <= month; m++) {
          const k = `${year}-${String(m).padStart(2, '0')}`;
          metaYtdNorte += metaPorUnidadeMes['Norte']?.[k]?.alvo || 0;
        }
      }
      const metaProportionalYtd = cod === '000056' && metaYtdNorte > 0
        ? metaYtdNorte
        : (planYtd && planYtd.count >= month
          ? planYtd.sum
          : (metaAnualAlvo > 0 ? (metaAnualAlvo / 12) * month : (planYtd?.sum || 0)));
      return {
        codVendedor: cod,
        executivo: nome,
        unidadeMeta: planInfo?.unidadeRef || meta?.unidade_meta || '—',
        metaMes,
        metaFonte: hasPlanMes ? 'Planilha RMR' : 'DW (Anual/12)',
        atingimentoMesPct: metaMes > 0 ? (realizadoMes / metaMes) * 100 : null,
        realizadoMes,
        realizadoYtd,
        metaProportionalYtd,
        metaAnualAlvo,
        atingimentoYtdPct: metaProportionalYtd > 0 ? (realizadoYtd / metaProportionalYtd) * 100 : null,
        atingimentoAnualPct: metaAnualAlvo > 0 ? (realizadoYtd / metaAnualAlvo) * 100 : null,
        gapAnual: metaAnualAlvo > 0 ? realizadoYtd - metaAnualAlvo : null,
        qtdNfsYtd: Number(real?.qtd_nfs_ytd || 0),
        qtdClientesYtd: Number(real?.qtd_clientes_ytd || 0),
        clientes: execClientesMap[cod] || []
      };
    })
      .filter(e => (e.realizadoYtd > 0 || e.metaAnualAlvo > 0 || e.metaMes > 0) && isExecutivoComercialOficial(e.executivo))
      .sort((a, b) => b.realizadoYtd - a.realizadoYtd);

    // --- Montagem 3: Backlog & Medições Pendentes ---
    const porEstagioContrato = {};
    for (const c of activeContractsBitrix) {
      const st = c.etapa || c.stage_id;
      if (!porEstagioContrato[st]) porEstagioContrato[st] = { etapa: st, stageId: c.stage_id, qtd: 0, valor: 0 };
      porEstagioContrato[st].qtd += 1;
      porEstagioContrato[st].valor += toNumber(c.valor);
    }

    const medPlanAll = baseOficial.medicoesPendentes || [];
    const medPlanMes = medPlanAll.filter(x => x.competencia === mesRefIso);
    const medPlanComp = medPlanMes.length
      ? mesRefIso
      : (medPlanAll.map(x => x.competencia).sort().pop() || mesRefIso);
    const medPlanItens = medPlanMes.length
      ? medPlanMes
      : medPlanAll.filter(x => x.competencia === medPlanComp);

    const backlogMedicoes = {
      statusMedicoesProtheus: {
        disponivel: Boolean(permMedicoes.canSelect),
        objeto: 'comercial.protheus_gold_medicoes_pendentes',
        observacao: permMedicoes.canSelect
          ? 'Permissão liberada (objeto espelha cabeçalho ZC0010; não contém itens mensais da ZD1010 nem planilha SharePoint).'
          : 'Acesso bloqueado (SELECT negado em comercial.protheus_gold_medicoes_pendentes) e planilha SharePoint CONTROLE DE MEDICAO (Medições Pendentes / Fechamento Informakon) não ingerida no PostgreSQL.'
      },
      statusContratosProtheus: {
        disponivel: Boolean(permContratosOp.canSelect),
        objeto: 'comercial.contratos_operacional',
        observacao: permContratosOp.canSelect
          ? 'Permissão liberada e contratos operacionais em aberto integrados abaixo.'
          : 'Acesso bloqueado (SELECT negado em comercial.contratos_operacional) e comercial.contratos_comercial possui 0 registros.'
      },
      contratosProtheusOperacional: contratosProtheusOp,
      backlogProtheusReal,
      medicoesProtheus: medicoesProtheusInfo,
      medicoesPlanilha: {
        competencia: medPlanComp,
        mesSolicitado: mesRefIso,
        qtd: medPlanItens.length,
        valorTotal: medPlanItens.reduce((s, r) => s + toNumber(r.valor), 0),
        itens: medPlanItens
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
    const itensPorCliCtr = {};
    const itensPorCtr = {};
    for (const it of rmrAgg.contratos_itens || []) {
      const itemObj = {
        codProduto: it.cod_produto,
        produto: it.produto,
        quantidade: toNumber(it.quantidade),
        valorYtd: toNumber(it.valor_ytd),
        qtdNfsYtd: Number(it.qtd_nfs_ytd || 0)
      };
      const kCliCtr = `${it.cliente}|||${it.numero_contrato}`;
      if (!itensPorCliCtr[kCliCtr]) itensPorCliCtr[kCliCtr] = [];
      itensPorCliCtr[kCliCtr].push(itemObj);

      if (it.numero_contrato && it.numero_contrato !== 'SEM_CONTRATO') {
        if (!itensPorCtr[it.numero_contrato]) itensPorCtr[it.numero_contrato] = [];
        itensPorCtr[it.numero_contrato].push(itemObj);
      }
    }

    const contratosPorCli = {};
    for (const cc of rmrAgg.clientes_contratos || []) {
      if (!contratosPorCli[cc.cliente]) contratosPorCli[cc.cliente] = [];
      const kCliCtr = `${cc.cliente}|||${cc.numero_contrato}`;
      contratosPorCli[cc.cliente].push({
        numeroContrato: cc.numero_contrato,
        unidade: cc.unidade || '—',
        valorMes: toNumber(cc.valor_mes),
        valorYtd: toNumber(cc.valor_ytd),
        qtdNfsYtd: Number(cc.qtd_nfs_ytd || 0),
        itens: itensPorCliCtr[kCliCtr] || []
      });
    }

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
        qtdContratosYtd: Number(r.qtd_contratos_ytd || 0),
        contratos: contratosPorCli[r.cliente] || []
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
      ultimaEmissao: r.ultima_emissao ? String(r.ultima_emissao).slice(0, 10) : null,
      itens: itensPorCtr[r.numero_contrato] || []
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
    let negociosQuentesQtd = 0;
    let negociosQuentesBruto = 0;
    const pipelinePorEtapaMap = {};
    const pipelinePorUnidadeMap = {};
    const tempLabels = {
      quente: 'Quente',
      morno: 'Morno',
      frio: 'Frio',
      sem_temperatura: 'Não informado'
    };
    const pipelinePorTempMap = {
      quente: { temperatura: 'quente', label: 'Quente', qtd: 0, valorBruto: 0, valorPonderado: 0 },
      morno: { temperatura: 'morno', label: 'Morno', qtd: 0, valorBruto: 0, valorPonderado: 0 },
      frio: { temperatura: 'frio', label: 'Frio', qtd: 0, valorBruto: 0, valorPonderado: 0 },
      sem_temperatura: { temperatura: 'sem_temperatura', label: 'Não informado', qtd: 0, valorBruto: 0, valorPonderado: 0 }
    };
    const pipelineUnidadesPorTempMap = {
      todas: {},
      quente: {},
      morno: {},
      frio: {},
      sem_temperatura: {}
    };
    const negociosAbertosLista = [];

    for (const deal of pipelineRows) {
      const val = toNumber(deal.valor);
      if (val <= 0) continue;
      const { peso, grupo, etapaLabel } = getStageWeight(deal.stage_id, deal.category_id);
      const valPonderado = val * peso;
      const dtClose = String(deal.data_fechamento || '').slice(0, 10);
      const dentroDoAno = !dtClose || dtClose <= cutoffYearEnd;
      const tempKey = bitrixTempMap[String(deal.id)] || 'sem_temperatura';

      pipelineBrutoTotal += val;
      pipelinePonderadoTotal += valPonderado;
      if (tempKey === 'quente') {
        negociosQuentesQtd += 1;
        negociosQuentesBruto += val;
      }
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

      pipelinePorTempMap[tempKey].qtd += 1;
      pipelinePorTempMap[tempKey].valorBruto += val;
      pipelinePorTempMap[tempKey].valorPonderado += valPonderado;

      const un = deal.unidade || 'Não informado';
      if (!pipelinePorUnidadeMap[un]) {
        pipelinePorUnidadeMap[un] = { unidade: un, qtd: 0, valorBruto: 0, valorPonderado: 0 };
      }
      pipelinePorUnidadeMap[un].qtd += 1;
      pipelinePorUnidadeMap[un].valorBruto += val;
      pipelinePorUnidadeMap[un].valorPonderado += valPonderado;

      for (const bucketKey of ['todas', tempKey]) {
        const uMap = pipelineUnidadesPorTempMap[bucketKey];
        if (!uMap[un]) uMap[un] = { unidade: un, qtd: 0, valorBruto: 0, valorPonderado: 0 };
        uMap[un].qtd += 1;
        uMap[un].valorBruto += val;
        uMap[un].valorPonderado += valPonderado;
      }

      negociosAbertosLista.push({
        id: deal.id,
        negocio: deal.negocio,
        cliente: deal.cliente,
        executivo: deal.executivo,
        unidade: un,
        etapa: deal.stage_name || etapaLabel,
        dataFechamento: dtClose || null,
        valor: val,
        temperatura: tempKey,
        temperaturaLabel: tempLabels[tempKey] || 'Não informado'
      });
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

    // --- Montagem 5B: Cenário Dinâmico Backlog + Funil de Vendas ---
    const normalizeUnitCenario = raw => {
      const s = String(raw || '').trim().toLowerCase();
      if (s.includes('complexo') || s.includes('centro') || s.includes('clcp')) return 'Complexo';
      if (s.includes('norte')) return 'Norte';
      if (s.includes('pec')) return 'Pecém';
      if (s.includes('transp')) return 'Transportes';
      if (s.includes('wind')) return 'Wind';
      if (s.includes('eng')) return 'Engenharia';
      return raw || 'Não informado';
    };

    const mesesRestantesLista = [];
    for (let m = month + 1; m <= 12; m++) {
      mesesRestantesLista.push({
        mes: m,
        mesIso: `${year}-${String(m).padStart(2, '0')}`
      });
    }

    const backlogUnidMesMap = {};
    for (const r of apropRestantePorUnidadeMes) {
      const u = normalizeUnitCenario(r.unidade);
      const m = Number(r.mes);
      if (!backlogUnidMesMap[u]) backlogUnidMesMap[u] = {};
      backlogUnidMesMap[u][m] = (backlogUnidMesMap[u][m] || 0) + toNumber(r.valor);
    }

    const funilUnidMesBrutoMap = {};
    const funilUnidMesPondMap = {};
    for (const deal of pipelineRows) {
      const u = normalizeUnitCenario(deal.unidade);
      const fechaMesIso = String(deal.data_fechamento || '').slice(0, 7);
      if (!fechaMesIso.startsWith(`${year}-`)) continue;
      const m = Number(fechaMesIso.slice(5, 7));
      if (!Number.isInteger(m) || m <= month || m > 12) continue;
      const val = toNumber(deal.valor);
      const { peso } = getStageWeight(deal.stage_id, deal.category_id);
      if (!funilUnidMesBrutoMap[u]) funilUnidMesBrutoMap[u] = {};
      if (!funilUnidMesPondMap[u]) funilUnidMesPondMap[u] = {};
      funilUnidMesBrutoMap[u][m] = (funilUnidMesBrutoMap[u][m] || 0) + val;
      funilUnidMesPondMap[u][m] = (funilUnidMesPondMap[u][m] || 0) + val * peso;
    }

    const cenarioBacklogFunilUnidades = Array.from(UNIDADES_COMERCIAIS_OFICIAIS).map(unidade => {
      const f = fatUnitMap[unidade];
      const planMes = !incluirExpurgos ? unidPlanilhaMesMap[mesRefIso]?.[unidade] : null;
      const metaMes = metaPorUnidadeMes[unidade]?.[mesRefIso]?.alvo || 0;
      const realizadoMes = planMes?.realizadoOficial !== null && planMes?.realizadoOficial !== undefined
        ? toNumber(planMes.realizadoOficial)
        : toNumber(f?.realizado_mes);
      const realizadoS2 = planMes?.realizadoS2Oficial !== null && planMes?.realizadoS2Oficial !== undefined
        ? toNumber(planMes.realizadoS2Oficial)
        : toNumber(f?.realizado_s2);
      const realizadoYtd = calcRealizadoYtdUnidade(unidade, f?.realizado_ytd);
      const metaAnual = metaUnidadeAnualMap[unidade] || 0;

      const backlogPorMes = {};
      const funilBrutoPorMes = {};
      const funilPonderadoPorMes = {};
      let backlogRestante = 0;
      let funilTotalBruto = 0;
      let funilTotalPonderado = 0;

      for (const mr of mesesRestantesLista) {
        const planRest = !incluirExpurgos ? unidPlanilhaMesMap[mr.mesIso]?.[unidade] : null;
        const bVal = planRest?.backlogContratado !== null && planRest?.backlogContratado !== undefined
          ? toNumber(planRest.backlogContratado)
          : (backlogUnidMesMap[unidade]?.[mr.mes] || 0);
        const fBruto = funilUnidMesBrutoMap[unidade]?.[mr.mes] || 0;
        const fPond = funilUnidMesPondMap[unidade]?.[mr.mes] || 0;
        backlogPorMes[mr.mes] = bVal;
        funilBrutoPorMes[mr.mes] = fBruto;
        funilPonderadoPorMes[mr.mes] = fPond;
        backlogRestante += bVal;
        funilTotalBruto += fBruto;
        funilTotalPonderado += fPond;
      }

      const totalMesMaisBacklog = realizadoMes + backlogRestante;
      const semestre2ComBacklog = realizadoS2 + backlogRestante;
      const totalAnoComBacklog = realizadoYtd + backlogRestante;
      const atingimentoPct = metaAnual > 0 ? (totalAnoComBacklog / metaAnual) * 100 : null;
      const gapResidualBruto = metaAnual > 0 ? metaAnual - (totalAnoComBacklog + funilTotalBruto) : null;
      const gapResidualPonderado = metaAnual > 0 ? metaAnual - (totalAnoComBacklog + funilTotalPonderado) : null;

      return {
        unidade,
        metaMes,
        realizadoMes,
        backlogPorMes,
        backlogRestante,
        totalMesMaisBacklog,
        semestre2ComBacklog,
        totalAnoComBacklog,
        metaAnual,
        atingimentoPct,
        funilBrutoPorMes,
        funilPonderadoPorMes,
        funilTotalBruto,
        funilTotalPonderado,
        gapResidualBruto,
        gapResidualPonderado
      };
    });

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
        negociosQuentesQtd,
        negociosQuentesBruto,
        janelaAnoBruto: pipelineCurtoAnoBruto,
        janelaAnoPonderado: pipelineCurtoAnoPonderado,
        porEtapa: Object.values(pipelinePorEtapaMap).sort((a, b) => b.valorPonderado - a.valorPonderado),
        porTemperatura: ['quente', 'morno', 'frio', 'sem_temperatura']
          .map(k => pipelinePorTempMap[k])
          .filter(t => t.temperatura !== 'sem_temperatura' || t.qtd > 0),
        porUnidade: Object.values(pipelinePorUnidadeMap).sort((a, b) => b.valorPonderado - a.valorPonderado).slice(0, 12),
        porUnidadePorTemperatura: Object.fromEntries(
          Object.entries(pipelineUnidadesPorTempMap).map(([k, uMap]) => [
            k,
            Object.values(uMap).sort((a, b) => b.valorBruto - a.valorBruto).slice(0, 12)
          ])
        ),
        negociosAbertos: negociosAbertosLista.sort((a, b) => b.valor - a.valor)
      },
      cenarios,
      cenarioBacklogFunil: {
        ano: year,
        mesRef: month,
        mesRefIso,
        mesesRestantes: mesesRestantesLista,
        unidades: cenarioBacklogFunilUnidades
      }
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
        .filter(d => String(d.data_evento || '').slice(0, 7) === mesRefIso)
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

    // --- Montagem 7: Executivos (Contratos Protheus x Funil CRM x Equipamentos) ---
    const normExecKey = raw => {
      const s = String(raw || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
      if (s.includes('CRISTIANO')) return 'CRISTIANO ASSIS';
      if (s.includes('BRUNO')) return 'BRUNO PESSOA';
      if (s.includes('FERNANDO')) return 'FERNANDO OLIVEIRA';
      if (s.includes('FABRICIO')) return 'FABRÍCIO MEDEIROS';
      if (s.includes('CRISTIANE')) return 'CRISTIANE LUCIO';
      if (s.includes('MARCIO')) return 'MARCIO FUNGHI';
      if (s.includes('THIAGO')) return 'THIAGO DO NASCIMENTO';
      if (s.includes('CORDEIRO')) return 'CORDEIRO GUINDASTES';
      return s || 'SEM EXECUTIVO';
    };

    const ctrItensAllMap = {};
    for (const it of rmrAgg.ctr_itens_all || []) {
      const kCtr = String(it.numero_contrato || '').trim();
      if (!kCtr) continue;
      if (!ctrItensAllMap[kCtr]) ctrItensAllMap[kCtr] = [];
      ctrItensAllMap[kCtr].push({
        codProduto: it.cod_produto,
        produto: it.produto,
        quantidade: toNumber(it.quantidade),
        valor: toNumber(it.valor_ytd)
      });
    }

    const dealItensMap = {};
    for (const pr of funilProdRows) {
      const did = String(pr.deal_id || '').trim();
      if (!did) continue;
      if (!dealItensMap[did]) dealItensMap[did] = [];
      dealItensMap[did].push({
        codProduto: 'CRM',
        produto: pr.produto,
        quantidade: toNumber(pr.quantidade),
        valor: toNumber(pr.valor_total)
      });
    }

    const execDetalheMap = {};
    const ensureExec = key => {
      if (!execDetalheMap[key]) {
        execDetalheMap[key] = {
          executivo: key,
          contratosValor: 0,
          contratosQtd: 0,
          funilValor: 0,
          funilQtd: 0,
          equipamentosMap: {},
          contratosList: []
        };
      }
      return execDetalheMap[key];
    };
    const ensureEquip = (exObj, prodRaw) => {
      const prod = String(prodRaw || 'Equipamento não especificado').trim();
      if (!exObj.equipamentosMap[prod]) {
        exObj.equipamentosMap[prod] = { produto: prod, emContratosValor: 0, emFunilValor: 0 };
      }
      return exObj.equipamentosMap[prod];
    };

    for (const c of backlogProtheusReal.contratos || []) {
      const k = normExecKey(c.responsavel);
      const ex = ensureExec(k);
      const val = toNumber(c.backlogReal);
      ex.contratosValor += val;
      ex.contratosQtd += 1;
      ex.contratosList.push({
        origem: 'Contrato Protheus',
        codigo: c.nrContrato,
        titulo: c.cliente,
        unidade: c.unidade,
        valor: val,
        itens: ctrItensAllMap[String(c.nrContrato || '').trim()] || []
      });
    }
    for (const it of rmrAgg.exec_itens || []) {
      const k = normExecKey(it.executivo);
      const ex = ensureExec(k);
      const eq = ensureEquip(ex, it.produto);
      eq.emContratosValor += toNumber(it.valor_ytd);
    }
    for (const deal of pipelineRows) {
      const val = toNumber(deal.valor);
      if (val <= 0) continue;
      const k = normExecKey(deal.executivo);
      const ex = ensureExec(k);
      ex.funilValor += val;
      ex.funilQtd += 1;
      ex.contratosList.push({
        origem: 'Funil CRM',
        codigo: `#${deal.id}`,
        titulo: `${deal.negocio} · ${deal.cliente}`,
        unidade: deal.unidade || '—',
        valor: val,
        itens: dealItensMap[String(deal.id || '').trim()] || []
      });
    }
    for (const pr of funilProdRows) {
      const val = toNumber(pr.valor_total);
      if (val <= 0) continue;
      const k = normExecKey(pr.executivo);
      const ex = ensureExec(k);
      const eq = ensureEquip(ex, pr.produto);
      eq.emFunilValor += val;
    }

    const executivosFunilRaw = Object.values(execDetalheMap)
      .filter(ex => (ex.contratosValor > 0 || ex.funilValor > 0) && isExecutivoComercialOficial(ex.executivo));

    const execTotContratos = executivosFunilRaw.reduce((s, e) => s + e.contratosValor, 0);
    const execTotFunil = executivosFunilRaw.reduce((s, e) => s + e.funilValor, 0);

    const executivosFunilList = executivosFunilRaw
      .map(ex => {
        const totalSobGestao = ex.contratosValor + ex.funilValor;
        const equipamentos = Object.values(ex.equipamentosMap)
          .map(eq => {
            const totEq = eq.emContratosValor + eq.emFunilValor;
            return {
              produto: eq.produto,
              emContratosValor: eq.emContratosValor,
              emContratosPct: totEq > 0 ? (eq.emContratosValor / totEq) * 100 : 0,
              emFunilValor: eq.emFunilValor,
              emFunilPct: totEq > 0 ? (eq.emFunilValor / totEq) * 100 : 0,
              totalValor: totEq
            };
          })
          .sort((a, b) => b.totalValor - a.totalValor)
          .slice(0, 25);
        const contratos = ex.contratosList
          .map(ct => ({
            ...ct,
            pctExec: totalSobGestao > 0 ? (ct.valor / totalSobGestao) * 100 : 0
          }))
          .sort((a, b) => b.valor - a.valor);
        return {
          executivo: ex.executivo,
          contratosValor: ex.contratosValor,
          contratosPct: execTotContratos > 0 ? (ex.contratosValor / execTotContratos) * 100 : 0,
          contratosQtd: ex.contratosQtd,
          funilValor: ex.funilValor,
          funilPct: execTotFunil > 0 ? (ex.funilValor / execTotFunil) * 100 : 0,
          funilQtd: ex.funilQtd,
          totalSobGestao,
          contratos,
          equipamentos
        };
      })
      .sort((a, b) => b.totalSobGestao - a.totalSobGestao);

    const executivosFunilDetalhe = {
      resumo: {
        totalContratos: execTotContratos,
        totalFunil: execTotFunil,
        totalSobGestao: execTotContratos + execTotFunil,
        ociosidadeDisponivel: false,
        ociosidadeObs: 'Ociosidade em R$ e % depende da liberação de stage_protheus.st9010 ou tabela de diária/valor da frota.'
      },
      executivos: executivosFunilList
    };

    const fresh = freshnessRes.rows[0] || {};

    return res.status(200).json({
      ok: true,
      geradoEm: new Date().toISOString(),
      parametros: { year, month, mesRefIso, escopo, incluirExpurgos },
      fontes: {
        faturamentoProtheus: 'stage_protheus.sd2010 (SD2 · NFs ativas sem duplicidade + executivo via fato_itens_vendas)',
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
      inadimplencia,
      contratosClientes: {
        clientes: clientesRanking,
        contratosProtheus
      },
      projecoes,
      funilPerdas,
      executivosFunilDetalhe
    });
  } catch (error) {
    console.error('Falha ao consultar painel RMR Comercial:', error);
    return res.status(500).json({ ok: false, error: 'Não foi possível carregar os indicadores do RMR Comercial agora.' });
  }
}
