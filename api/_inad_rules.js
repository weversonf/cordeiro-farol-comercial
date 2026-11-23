/**
 * Regras do relatório de Inadimplência.
 *
 * Fonte única de verdade: usada pela consulta ao vivo e pelo fechamento mensal.
 * Qualquer alteração de critério exige nova versão em INAD_RULES_VERSION, para que
 * fechamentos antigos continuem reproduzíveis.
 *
 * Escopo derivado da planilha do financeiro (aba "BASE MES" e "RETIRADOS"):
 *  - Somente naturezas de faturamento (11101/11201/11202/11203/11301) e retenções (ISS/INSS).
 *  - Somente títulos vencidos dentro da janela de 365 dias antes da data de corte.
 *  - Exclui RA/ADT/NCC, mútuos, intercompany (grupo Cordeiro), venda de ativos (prefixo 1)
 *    e títulos com seguro Petrobras.
 */

export const INAD_RULES_VERSION = '3';

// Naturezas de faturamento consideradas pelo relatório.
export const NATUREZAS_FATURAMENTO = ['11101', '11201', '11202', '11203', '11301'];

// Janela (em dias) para trás a partir da data de corte. Títulos vencidos há mais
// de 365 dias não entram no índice de inadimplência (vão para a faixa "perda").
export const JANELA_DIAS = 365;

// Clientes do próprio grupo (intercompany). Códigos no formato do Protheus
// (sem zeros à esquerda) e prefixo de nome como reforço.
export const CLIENTES_INTERCOMPANY = [
  '1', '2', '3', '7', '200', '737', '1616',
  '14279', '14281', '14729', '14730', '14731', '14732',
  '14888', '14891', '14949', '14951', '15031', '15083',
  '15224', '15245', '15327', '15371'
];

// Prefixos de nome que identificam empresas do grupo.
export const NOME_PREFIXO_INTERCOMPANY = ['CORDEIRO'];

// Títulos com seguro Petrobras (curated pelo financeiro na planilha).
export const CLIENTES_SEGURO_PETROBRAS = ['T&A'];

/**
 * Regras ativas por padrão. Cada uma pode ser desligada por parâmetro,
 * e o relatório sempre informa quanto cada uma retirou.
 */
export const REGRAS_PADRAO = [
  'natureza_faturamento',
  'janela_365',
  'ra_adt',
  'mutuos',
  'intercompany',
  'venda_ativos',
  'petrobras_seguro'
];

export const REGRAS_DESCRICAO = {
  natureza_faturamento: 'Considera apenas naturezas de faturamento (11101/11201/11202/11203/11301) e retenções',
  janela_365: 'Exclui títulos vencidos há mais de 365 dias',
  ra_adt: 'Exclui RA/ADT e NCC (adiantamentos e notas de crédito)',
  mutuos: 'Exclui mútuos (prefixo MUT)',
  intercompany: 'Exclui títulos entre empresas do grupo',
  venda_ativos: 'Exclui venda de ativos (prefixo 1)',
  petrobras_seguro: 'Exclui títulos com seguro Petrobras'
};

/**
 * CTE base. Parâmetros:
 *   $1 text[]  filiais (null = todas)
 *   $2 date    data de corte dos vencimentos
 *   $3 text[]  códigos de cliente intercompany
 *   $4 text[]  regras ativas
 *   $5 text[]  naturezas de faturamento
 *   $6 text[]  prefixos de nome intercompany
 *   $7 text[]  clientes com seguro Petrobras
 *
 * Produz `se1_inad` (incluídos) e `se1_fora` (excluídos, com motivo).
 */
export function buildInadCte() {
  return `
    se1_base AS MATERIALIZED (
      SELECT
        TRIM(COALESCE(se1.e1_cliente, '')) AS cod_cliente,
        TRIM(COALESCE(se1.e1_loja, '')) AS loja,
        NULLIF(TRIM(COALESCE(se1.e1_nomcli, '')), '') AS nomcli,
        TRIM(COALESCE(se1.e1_filial, '')) AS cod_filial,
        TRIM(COALESCE(se1.e1_prefixo, '')) AS serie,
        TRIM(COALESCE(se1.e1_num, '')) AS titulo,
        TRIM(COALESCE(se1.e1_parcela, '')) AS parcela,
        TRIM(COALESCE(se1.e1_naturez, '')) AS natureza,
        TRIM(COALESCE(se1.e1_tipo, '')) AS tipo,
        NULLIF(TRIM(COALESCE(se1.e1_vend1, '')), '') AS vend1,
        COALESCE(se1.e1_valor, 0)::numeric AS valor_original,
        (CASE WHEN RIGHT(TRIM(COALESCE(se1.e1_tipo, '')), 1) = '-' THEN -1 ELSE 1 END
          * COALESCE(se1.e1_saldo, 0))::numeric AS saldo_inadimplente,
        CASE
          WHEN TRIM(COALESCE(se1.e1_emissao::text, '')) ~ '^\\d{8}$' THEN TO_DATE(TRIM(se1.e1_emissao::text), 'YYYYMMDD')
          WHEN TRIM(COALESCE(se1.e1_emissao::text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN SUBSTRING(TRIM(COALESCE(se1.e1_emissao::text, '')), 1, 10)::date
          ELSE NULL
        END AS emissao,
        CASE
          WHEN TRIM(COALESCE(se1.e1_vencrea::text, '')) ~ '^\\d{8}$' THEN TO_DATE(TRIM(COALESCE(se1.e1_vencrea::text, '')), 'YYYYMMDD')
          WHEN TRIM(COALESCE(se1.e1_vencrea::text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN SUBSTRING(TRIM(COALESCE(se1.e1_vencrea::text, '')), 1, 10)::date
          WHEN TRIM(COALESCE(se1.e1_vencto::text, '')) ~ '^\\d{8}$' THEN TO_DATE(TRIM(COALESCE(se1.e1_vencto::text, '')), 'YYYYMMDD')
          WHEN TRIM(COALESCE(se1.e1_vencto::text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN SUBSTRING(TRIM(COALESCE(se1.e1_vencto::text, '')), 1, 10)::date
          ELSE NULL
        END AS vencimento_real,
        CASE
          WHEN 'natureza_faturamento' = ANY($4::text[])
            AND RIGHT(TRIM(COALESCE(se1.e1_tipo, '')), 1) <> '-'
            AND TRIM(COALESCE(se1.e1_naturez, '')) <> ALL($5::text[]) THEN 'natureza_faturamento'
          WHEN 'ra_adt' = ANY($4::text[])
            AND TRIM(COALESCE(se1.e1_tipo, '')) IN ('RA', 'NCC') THEN 'ra_adt'
          WHEN 'ra_adt' = ANY($4::text[])
            AND UPPER(TRIM(COALESCE(se1.e1_prefixo, ''))) = 'ADT' THEN 'ra_adt'
          WHEN 'mutuos' = ANY($4::text[])
            AND UPPER(TRIM(COALESCE(se1.e1_prefixo, ''))) = 'MUT' THEN 'mutuos'
          WHEN 'venda_ativos' = ANY($4::text[])
            AND TRIM(COALESCE(se1.e1_prefixo, '')) = '1' THEN 'venda_ativos'
          WHEN 'intercompany' = ANY($4::text[])
            AND (
              LPAD(TRIM(COALESCE(se1.e1_cliente, '')), 6, '0') = ANY(
                SELECT LPAD(x, 6, '0') FROM unnest($3::text[]) AS x
              )
              OR UPPER(TRIM(COALESCE(se1.e1_nomcli, ''))) LIKE ANY(
                SELECT UPPER(p) || '%' FROM unnest($6::text[]) AS p
              )
            ) THEN 'intercompany'
          WHEN 'petrobras_seguro' = ANY($4::text[])
            AND UPPER(TRIM(COALESCE(se1.e1_nomcli, ''))) = ANY(
              SELECT UPPER(x) FROM unnest($7::text[]) AS x
            ) THEN 'petrobras_seguro'
          ELSE NULL
        END AS motivo_exclusao
      FROM stage_protheus.se1010 se1
      WHERE COALESCE(TRIM(se1.d_e_l_e_t_), '') <> '*'
        AND COALESCE(se1.e1_saldo, 0) <> 0
        AND ($1::text[] IS NULL OR TRIM(COALESCE(se1.e1_filial, '')) = ANY($1::text[]))
    ),
    se1_venc AS MATERIALIZED (
      SELECT
        b.*,
        (($2::date - b.vencimento_real)) AS dias_atraso,
        CASE
          WHEN b.vencimento_real < ($2::date - ${JANELA_DIAS}) THEN 'acima_365'
          ELSE 'ate_365'
        END AS faixa
      FROM se1_base b
      WHERE b.vencimento_real IS NOT NULL
        AND b.vencimento_real <= $2::date
    ),
    se1_inad AS MATERIALIZED (
      SELECT * FROM se1_venc
      WHERE motivo_exclusao IS NULL
        AND NOT ('janela_365' = ANY($4::text[]) AND faixa = 'acima_365')
    ),
    se1_fora AS MATERIALIZED (
      SELECT * FROM se1_venc
      WHERE motivo_exclusao IS NOT NULL
         OR ('janela_365' = ANY($4::text[]) AND faixa = 'acima_365')
    )
  `;
}

export function parseRegras(raw) {
  const pedidas = String(raw || '').trim();
  if (!pedidas) return REGRAS_PADRAO.slice();
  if (pedidas === 'todas') return Object.keys(REGRAS_DESCRICAO);
  if (pedidas === 'nenhuma') return [];
  const validas = new Set(Object.keys(REGRAS_DESCRICAO));
  return pedidas.split(',').map(s => s.trim()).filter(s => validas.has(s));
}
