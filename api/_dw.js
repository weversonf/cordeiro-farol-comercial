import { toNumber } from './_db.js';

export const PBIX_FILIAIS = [
  '010101',
  '030301',
  '040401',
  '060601',
  '101001',
  '111101',
  '121201'
];

// TES comerciais e CFOPs de receita validados contra vbi_Mov_FatBruto (RMR OUT26 PBIX)
export const COMMERCIAL_TES = [
  '501', '503', '511', '520', '522', '586',
  '620', '623', '628', '629', '630', '633', '636', '653'
];

export const REVENUE_CFOPS = [
  '5933', '6933', '000', '5405', '6932',
  '6404', '6353', '5353', '5352', '5932', '5102'
];

// Regra oficial de expurgo comercial (CM Máquinas + Rateios/Intercompany ADM)
export const EXPURGO_FILIAIS = ['121201', '101001', '040401', '111101'];
export const EXPURGO_VENDEDORES = ['00049', '000050'];

export const UNIT_FROM_CC3_SQL = `
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
    WHEN '421' THEN 'CM Máquinas'
    WHEN '422' THEN 'Metalmecânica'
    WHEN '321' THEN 'Central ADM'
    ELSE 'Outras / Controladoria'
  END
`;

export const EXPURGO_COND_SQL = `
  (
    TRIM(COALESCE(f.cod_filial::text, '')) = ANY($EXPURGO_FILIAIS)
    OR TRIM(COALESCE(f.cod_vendedor::text, '')) = ANY($EXPURGO_VEND)
    OR LEFT(TRIM(COALESCE(f.cod_centro_custo::text, '')), 3) IN ('321', '330', '421')
    OR (
      TRIM(COALESCE(f.cod_filial::text, '')) = '060601'
      AND TRIM(COALESCE(f.numero_documento::text, '')) = '000003052'
      AND TRIM(COALESCE(f.cod_cliente::text, '')) = '003316'
    )
  )
`;

/**
 * CTE base de faturamento fiscal lida direto da stage_protheus.sd2010 (itens ativos),
 * enriquecida com cod_vendedor da comercial.fato_itens_vendas (deduplicada por NF)
 * e deduplicada para NFs multi-cliente.
 */
export function buildBillingBaseCte({ startParam = '$1', endParam = '$2', escopo = 'pbix' } = {}) {
  const filialArraySql = `ARRAY[${PBIX_FILIAIS.map(f => `'${f}'`).join(',')}]`;
  const filialFilter = alias => (escopo === 'all'
    ? ''
    : `AND TRIM(COALESCE(${alias}.d2_filial::text, '')) = ANY(${filialArraySql})`);

  const tesList = COMMERCIAL_TES.map(t => `'${t}'`).join(',');
  const cfopList = REVENUE_CFOPS.map(c => `'${c}'`).join(',');

  return `
    WITH fiv_vend_nf AS MATERIALIZED (
      SELECT DISTINCT ON (
        TRIM(COALESCE(cod_filial::text, '')),
        TRIM(COALESCE(numero_documento::text, '')),
        TRIM(COALESCE(serie::text, ''))
      )
        TRIM(COALESCE(cod_filial::text, '')) AS cod_filial,
        TRIM(COALESCE(numero_documento::text, '')) AS numero_documento,
        TRIM(COALESCE(serie::text, '')) AS serie,
        TRIM(COALESCE(cod_vendedor::text, '')) AS cod_vendedor
      FROM comercial.fato_itens_vendas
      WHERE emissao >= (${startParam}::date - INTERVAL '14 days')
        AND emissao < (${endParam}::date + INTERVAL '14 days')
      ORDER BY
        TRIM(COALESCE(cod_filial::text, '')),
        TRIM(COALESCE(numero_documento::text, '')),
        TRIM(COALESCE(serie::text, '')),
        data_criacao DESC NULLS LAST,
        id DESC
    ),
    fiv_scope AS MATERIALIZED (
      SELECT
        sd.r_e_c_n_o_ AS id,
        TO_DATE(TRIM(sd.d2_emissao::text), 'YYYYMMDD') AS emissao,
        sd.s_t_a_m_p_ AS data_criacao,
        TRIM(COALESCE(sd.d2_filial::text, '')) AS cod_filial,
        TRIM(COALESCE(sd.d2_doc::text, '')) AS numero_documento,
        TRIM(COALESCE(sd.d2_serie::text, '')) AS serie,
        TRIM(COALESCE(sd.d2_pedido::text, '')) AS numero_pedido,
        TRIM(COALESCE(sd.d2_ynumctr::text, '')) AS numero_contrato,
        TRIM(COALESCE(sd.d2_cliente::text, '')) AS cod_cliente,
        TRIM(COALESCE(sd.d2_loja::text, '')) AS loja,
        COALESCE(vn.cod_vendedor, '') AS cod_vendedor,
        TRIM(COALESCE(sd.d2_ccusto::text, '')) AS cod_centro_custo,
        TRIM(COALESCE(sd.d2_cod::text, '')) AS cod_produto,
        TRIM(COALESCE(sd.d2_tes::text, '')) AS tipo_saida,
        TRIM(COALESCE(sd.d2_cf::text, '')) AS cod_fiscal,
        NULLIF(TRIM(COALESCE(sd.d2_ymargct::text, '')), '') AS margem,
        COALESCE(sd.d2_quant, 0)::numeric AS quantidade_produto,
        COALESCE(sd.d2_prcven, 0)::numeric AS valor_unitario,
        COALESCE(sd.d2_total, 0)::numeric AS valor_total
      FROM stage_protheus.sd2010 sd
      LEFT JOIN fiv_vend_nf vn
        ON vn.cod_filial = TRIM(COALESCE(sd.d2_filial::text, ''))
       AND vn.numero_documento = TRIM(COALESCE(sd.d2_doc::text, ''))
       AND vn.serie = TRIM(COALESCE(sd.d2_serie::text, ''))
      WHERE COALESCE(TRIM(sd.d_e_l_e_t_), '') <> '*'
        AND TRIM(COALESCE(sd.d2_emissao::text, '')) ~ '^\\d{8}$'
        AND TRIM(sd.d2_emissao::text) >= TO_CHAR(${startParam}::date, 'YYYYMMDD')
        AND TRIM(sd.d2_emissao::text) < TO_CHAR(${endParam}::date, 'YYYYMMDD')
        AND TRIM(COALESCE(sd.d2_tes::text, '')) IN (${tesList})
        AND TRIM(COALESCE(sd.d2_cf::text, '')) IN (${cfopList})
        ${filialFilter('sd')}
    ),
    cli_dedup_nf AS MATERIALIZED (
      SELECT DISTINCT ON (cod_filial, numero_documento, serie)
        cod_filial,
        numero_documento,
        serie,
        cod_cliente AS cod_cliente_principal
      FROM fiv_scope
      ORDER BY
        cod_filial,
        numero_documento,
        serie,
        data_criacao ASC NULLS LAST,
        id ASC
    ),
    dim_cli_loja AS (
      SELECT DISTINCT ON (TRIM(cod_cliente), TRIM(loja))
        TRIM(cod_cliente) AS cod_cliente,
        TRIM(loja) AS loja,
        NULLIF(TRIM(nome_cliente), '') AS nome_cliente,
        NULLIF(TRIM(cnpj), '') AS cnpj
      FROM comercial.dim_clientes
      WHERE TRIM(cod_cliente) IN (SELECT DISTINCT cod_cliente FROM fiv_scope WHERE cod_cliente <> '')
      ORDER BY TRIM(cod_cliente), TRIM(loja), data_modificacao DESC NULLS LAST, id DESC
    ),
    dim_cli_cod AS (
      SELECT DISTINCT ON (TRIM(cod_cliente))
        TRIM(cod_cliente) AS cod_cliente,
        NULLIF(TRIM(nome_cliente), '') AS nome_cliente,
        NULLIF(TRIM(cnpj), '') AS cnpj
      FROM comercial.dim_clientes
      WHERE TRIM(cod_cliente) IN (SELECT DISTINCT cod_cliente FROM fiv_scope WHERE cod_cliente <> '')
      ORDER BY TRIM(cod_cliente), data_modificacao DESC NULLS LAST, id DESC
    ),
    dim_vend AS (
      SELECT DISTINCT ON (TRIM(cod_vendedor))
        TRIM(cod_vendedor) AS cod_vendedor,
        NULLIF(TRIM(nome_vendedor), '') AS nome_vendedor
      FROM comercial.dim_vendedor
      ORDER BY TRIM(cod_vendedor), id DESC
    ),
    dim_prod AS (
      SELECT DISTINCT ON (TRIM(cod_filial), TRIM(cod_produto))
        TRIM(cod_filial) AS cod_filial,
        TRIM(cod_produto) AS cod_produto,
        NULLIF(TRIM(nome_produto), '') AS nome_produto
      FROM comercial.dim_produtos_protheus
      WHERE TRIM(cod_produto) IN (SELECT DISTINCT cod_produto FROM fiv_scope WHERE cod_produto <> '')
      ORDER BY TRIM(cod_filial), TRIM(cod_produto), data_modificacao DESC NULLS LAST, id DESC
    ),
    dim_cc AS (
      SELECT DISTINCT ON (TRIM(cod_filial), TRIM(cod_centro_custo))
        TRIM(cod_filial) AS cod_filial,
        TRIM(cod_centro_custo) AS cod_centro_custo,
        NULLIF(TRIM(nome_centro_custo), '') AS nome_centro_custo
      FROM comercial.dim_centro_custo
      WHERE TRIM(cod_centro_custo) IN (SELECT DISTINCT cod_centro_custo FROM fiv_scope WHERE cod_centro_custo <> '')
      ORDER BY TRIM(cod_filial), TRIM(cod_centro_custo), data_modificacao DESC NULLS LAST, id DESC
    ),
    faturamento_base AS MATERIALIZED (
      SELECT
        f.id,
        f.emissao,
        TO_CHAR(DATE_TRUNC('month', f.emissao), 'YYYY-MM') AS mes_iso,
        f.cod_filial,
        f.numero_documento,
        f.serie,
        f.numero_pedido,
        f.numero_contrato,
        f.cod_cliente,
        f.loja,
        COALESCE(cl.nome_cliente, cc2.nome_cliente, 'Cliente ' || NULLIF(f.cod_cliente, ''), 'Cliente N/I') AS cliente,
        COALESCE(cl.cnpj, cc2.cnpj, '') AS cnpj,
        f.cod_vendedor,
        COALESCE(dv.nome_vendedor, NULLIF(f.cod_vendedor, ''), 'Sem executivo') AS executivo,
        f.cod_centro_custo,
        COALESCE(dcc.nome_centro_custo, '') AS centro_custo,
        ${UNIT_FROM_CC3_SQL} AS unidade,
        f.cod_produto,
        COALESCE(dp.nome_produto, NULLIF(f.cod_produto, ''), 'Produto não identificado') AS produto,
        f.tipo_saida AS tes,
        f.cod_fiscal AS cfop,
        f.margem,
        f.quantidade_produto AS quantidade,
        f.valor_unitario,
        f.valor_total,
        (
          f.cod_filial IN (${EXPURGO_FILIAIS.map(x => `'${x}'`).join(',')})
          OR f.cod_vendedor IN (${EXPURGO_VENDEDORES.map(x => `'${x}'`).join(',')})
          OR LEFT(COALESCE(f.cod_centro_custo, ''), 3) IN ('321', '330', '421')
          OR (f.cod_filial = '060601' AND f.numero_documento = '000003052' AND f.cod_cliente = '003316')
        ) AS is_expurgo
      FROM fiv_scope f
      JOIN cli_dedup_nf d
        ON d.cod_filial = f.cod_filial
       AND d.numero_documento = f.numero_documento
       AND d.serie = f.serie
       AND d.cod_cliente_principal = f.cod_cliente
      LEFT JOIN dim_cli_loja cl
        ON cl.cod_cliente = f.cod_cliente
       AND cl.loja = f.loja
      LEFT JOIN dim_cli_cod cc2
        ON cc2.cod_cliente = f.cod_cliente
      LEFT JOIN dim_vend dv
        ON dv.cod_vendedor = f.cod_vendedor
      LEFT JOIN dim_prod dp
        ON dp.cod_filial = f.cod_filial
       AND dp.cod_produto = f.cod_produto
      LEFT JOIN dim_cc dcc
        ON dcc.cod_filial = f.cod_filial
       AND dcc.cod_centro_custo = f.cod_centro_custo
    )
  `;
}

/**
 * Verifica com segurança se o usuário atual possui USAGE no schema e SELECT no objeto.
 */
export async function checkTableReadable(pool, schemaName, tableName) {
  try {
    const res = await pool.query(
      `
        SELECT
          has_schema_privilege(current_user, $1, 'USAGE') AS has_usage,
          CASE
            WHEN to_regclass($2) IS NULL THEN false
            ELSE pg_catalog.has_table_privilege(current_user, to_regclass($2), 'SELECT')
          END AS can_select,
          (to_regclass($2) IS NOT NULL) AS exists_obj
      `,
      [schemaName, `${schemaName}.${tableName}`]
    );
    const row = res.rows[0] || {};
    return {
      exists: Boolean(row.exists_obj),
      hasUsage: Boolean(row.has_usage),
      canSelect: Boolean(row.has_usage && row.can_select)
    };
  } catch {
    return { exists: false, hasUsage: false, canSelect: false };
  }
}

export function mapIndicadorUnitName(zi0Unidad) {
  const code = String(zi0Unidad || '').trim();
  const map = {
    '413': 'Pecém',
    '414': 'Wind',
    '415': 'Engenharia',
    '416': 'Norte',
    '417': 'Complexo',
    '420': 'Transportes',
    '421': 'CM Máquinas',
    '422': 'Metalmecânica',
    '321': 'Central ADM'
  };
  return map[code] || `Unidade ${code}`;
}

export function normalizeDealUnitSql(dealAlias = 'd', ufAlias = 'uf') {
  return `
    COALESCE(
      NULLIF((
        SELECT CASE
          WHEN STRING_AGG(DISTINCT ev."VALOR", ', ') ILIKE '%Wind%' THEN 'Wind'
          WHEN STRING_AGG(DISTINCT ev."VALOR", ', ') ILIKE '%Pec%' THEN 'Pecém'
          WHEN STRING_AGG(DISTINCT ev."VALOR", ', ') ILIKE '%Norte%' THEN 'Norte'
          WHEN STRING_AGG(DISTINCT ev."VALOR", ', ') ILIKE '%Engenharia%' THEN 'Engenharia'
          WHEN STRING_AGG(DISTINCT ev."VALOR", ', ') ILIKE '%Transportes%' THEN 'Transportes'
          WHEN STRING_AGG(DISTINCT ev."VALOR", ', ') ILIKE '%Centro%' THEN 'Complexo'
          ELSE STRING_AGG(DISTINCT ev."VALOR", ', ' ORDER BY ev."VALOR")
        END
        FROM regexp_split_to_table(regexp_replace(COALESCE(${ufAlias}."UF_CRM_1705060456626", ''), '[^0-9,]', '', 'g'), ',') AS uid
        JOIN stage_bitrix.b_uf_enum_values ev
          ON ev."FIELD_NAME" = 'UF_CRM_1705060456626'
         AND ev."ITEM_ID"::text = NULLIF(uid, '')
      ), ''),
      CASE
        WHEN ${dealAlias}."TITLE" ILIKE '%WIND%' THEN 'Wind'
        WHEN ${dealAlias}."TITLE" ILIKE '%PEC%' THEN 'Pecém'
        WHEN ${dealAlias}."TITLE" ILIKE '%CLCP%' THEN 'Complexo'
        WHEN ${dealAlias}."TITLE" ILIKE '%NORT%' THEN 'Norte'
        WHEN ${dealAlias}."TITLE" ILIKE '%TRANSP%' THEN 'Transportes'
        WHEN ${dealAlias}."TITLE" ILIKE '%ENG%' THEN 'Engenharia'
        ELSE 'Não informado'
      END
    )
  `;
}

export function safeNumericDealSql(col = 'd."OPPORTUNITY"') {
  return `
    CASE
      WHEN TRIM(COALESCE(${col}::text, '')) ~ '^-?[0-9]+(\\.[0-9]+)?$'
        THEN ${col}::numeric
      ELSE 0::numeric
    END
  `;
}

export function formatMoneySum(rows, key = 'valor') {
  return rows.reduce((acc, row) => acc + toNumber(row[key]), 0);
}
