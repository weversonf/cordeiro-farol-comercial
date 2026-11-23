import {
  CLIENTES_INTERCOMPANY,
  CLIENTES_SEGURO_PETROBRAS,
  NATUREZAS_FATURAMENTO,
  NOME_PREFIXO_INTERCOMPANY,
  buildInadCte
} from './_inad_rules.js';

/**
 * Consulta título a título da carteira inadimplente.
 * Fonte única usada pelo painel ao vivo e pelo fechamento mensal,
 * garantindo que os dois apliquem exatamente as mesmas regras.
 */
const SQL_TITULOS = `
  WITH ${buildInadCte()},
  fiv_nf AS (
    SELECT
      TRIM(COALESCE(f.cod_filial, '')) AS cod_filial,
      TRIM(COALESCE(f.cod_cliente, '')) AS cod_cliente,
      TRIM(COALESCE(f.loja, '')) AS loja,
      TRIM(COALESCE(f.numero_documento, '')) AS numero_documento,
      TRIM(COALESCE(f.serie, '')) AS serie,
      CASE WHEN COUNT(DISTINCT NULLIF(TRIM(f.margem), '')) = 1
        THEN MIN(NULLIF(TRIM(f.margem), '')) ELSE NULL END AS margem,
      CASE WHEN COUNT(DISTINCT NULLIF(TRIM(f.numero_contrato), '')) = 1
        THEN MIN(NULLIF(TRIM(f.numero_contrato), '')) ELSE NULL END AS numero_contrato,
      CASE WHEN COUNT(DISTINCT NULLIF(TRIM(f.cod_vendedor), '')) = 1
        THEN MIN(NULLIF(TRIM(f.cod_vendedor), '')) ELSE NULL END AS cod_vendedor
    FROM comercial.fato_itens_vendas f
    WHERE NULLIF(TRIM(COALESCE(f.numero_documento, '')), '') IS NOT NULL
      AND TRIM(COALESCE(f.numero_documento, '')) IN (SELECT DISTINCT titulo FROM se1_inad WHERE titulo <> '')
    GROUP BY
      TRIM(COALESCE(f.cod_filial, '')),
      TRIM(COALESCE(f.cod_cliente, '')),
      TRIM(COALESCE(f.loja, '')),
      TRIM(COALESCE(f.numero_documento, '')),
      TRIM(COALESCE(f.serie, ''))
  ),
  dim_cli_loja AS (
    SELECT DISTINCT ON (TRIM(COALESCE(c.cod_cliente, '')), TRIM(COALESCE(c.loja, '')))
      TRIM(COALESCE(c.cod_cliente, '')) AS cod_cliente,
      TRIM(COALESCE(c.loja, '')) AS loja,
      NULLIF(TRIM(c.nome_cliente), '') AS nome_cliente
    FROM comercial.dim_clientes c
    WHERE TRIM(COALESCE(c.cod_cliente, '')) IN (SELECT DISTINCT cod_cliente FROM se1_inad WHERE cod_cliente <> '')
    ORDER BY TRIM(COALESCE(c.cod_cliente, '')), TRIM(COALESCE(c.loja, '')), c.data_modificacao DESC NULLS LAST, c.id DESC
  ),
  dim_cli_cod AS (
    SELECT DISTINCT ON (TRIM(COALESCE(c.cod_cliente, '')))
      TRIM(COALESCE(c.cod_cliente, '')) AS cod_cliente,
      NULLIF(TRIM(c.nome_cliente), '') AS nome_cliente
    FROM comercial.dim_clientes c
    WHERE TRIM(COALESCE(c.cod_cliente, '')) IN (SELECT DISTINCT cod_cliente FROM se1_inad WHERE cod_cliente <> '')
    ORDER BY TRIM(COALESCE(c.cod_cliente, '')), c.data_modificacao DESC NULLS LAST, c.id DESC
  ),
  vend_nome AS (
    SELECT DISTINCT ON (TRIM(COALESCE(v.cod_vendedor, '')))
      TRIM(COALESCE(v.cod_vendedor, '')) AS cod_vendedor,
      UPPER(COALESCE(NULLIF(TRIM(v.nome_vendedor), ''), 'Vendedor ' || TRIM(COALESCE(v.cod_vendedor, '')))) AS nome_vendedor
    FROM comercial.dim_vendedor v
    ORDER BY TRIM(COALESCE(v.cod_vendedor, '')), v.id DESC
  )
  SELECT
    'PROTHEUS (SE1010)' AS origem,
    COALESCE(v.nome_vendedor, 'SEM EXECUTIVO') AS executivo,
    s.vend1 AS cod_vendedor,
    s.cod_cliente,
    COALESCE(cl.nome_cliente, cc.nome_cliente, s.nomcli, 'Cliente ' || s.cod_cliente) AS cliente,
    COALESCE(fn.margem, 'Sem Margem') AS margem,
    COALESCE(fn.numero_contrato, '') AS contrato,
    s.cod_filial,
    s.serie,
    s.titulo,
    s.parcela,
    s.loja,
    s.natureza,
    s.tipo,
    s.valor_original,
    s.saldo_inadimplente,
    s.faixa,
    TO_CHAR(s.emissao, 'YYYY-MM-DD') AS emissao,
    TO_CHAR(s.vencimento_real, 'YYYY-MM-DD') AS vencimento_real
  FROM se1_inad s
  LEFT JOIN fiv_nf fn
    ON fn.cod_filial = s.cod_filial
   AND fn.cod_cliente = s.cod_cliente
   AND fn.loja = s.loja
   AND fn.numero_documento = s.titulo
   AND fn.serie = s.serie
  LEFT JOIN dim_cli_loja cl
    ON cl.cod_cliente = s.cod_cliente
   AND cl.loja = s.loja
  LEFT JOIN dim_cli_cod cc
    ON cc.cod_cliente = s.cod_cliente
  LEFT JOIN vend_nome v
    ON v.cod_vendedor = COALESCE(s.vend1, fn.cod_vendedor)
  ORDER BY s.saldo_inadimplente DESC
`;

const SQL_IMPACTO = `
  WITH ${buildInadCte()}
  SELECT COALESCE(motivo_exclusao, 'janela_365') AS motivo_exclusao,
         COUNT(*)::int AS qtd,
         ROUND(COALESCE(SUM(saldo_inadimplente), 0)::numeric, 2) AS saldo
  FROM se1_fora
  GROUP BY 1
  ORDER BY saldo DESC
`;

export async function queryInadimplencia(pool, { filiais = null, corte, regras }) {
  const params = [
    filiais,
    corte,
    CLIENTES_INTERCOMPANY,
    regras,
    NATUREZAS_FATURAMENTO,
    NOME_PREFIXO_INTERCOMPANY,
    CLIENTES_SEGURO_PETROBRAS
  ];
  const [titulos, impacto] = await Promise.all([
    pool.query(SQL_TITULOS, params),
    pool.query(SQL_IMPACTO, params)
  ]);

  return {
    titulos: titulos.rows,
    impacto: impacto.rows.map(r => ({
      motivo: r.motivo_exclusao,
      qtd: Number(r.qtd),
      saldo: Number(r.saldo || 0)
    }))
  };
}
