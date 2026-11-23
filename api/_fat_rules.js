/**
 * Regras da prévia de faturamento (SD2).
 *
 * Fonte das regras: planilha de premiação de outubro/2026
 *  - POP de faturamento (TES comerciais + CFOPs de receita)
 *  - Expurgos homologados: CM Máquinas e Central ADM
 *  - Regra financeira de outubro: expurgo das NFs série 4 do contrato 68673 (T&A)
 *
 * Toda alteração de critério deve gerar nova versão em FAT_RULES_VERSION.
 */

export const FAT_RULES_VERSION = '2';

// TES comerciais validados contra vbi_Mov_FatBruto (RMR OUT26 PBIX).
export const TES_COMERCIAIS = [
  '501', '503', '511', '520', '522', '586',
  '620', '623', '628', '629', '630', '633', '636', '653'
];

// CFOPs de receita.
export const CFOPS_RECEITA = [
  '5933', '6933', '000', '5405', '6932',
  '6404', '6353', '5353', '5352', '5932', '5102'
];

// Unidades que compõem o faturamento comercial na consulta original da
// premiação v03. A classificação é feita pelo centro de custo, não pela
// filial nem pelo vendedor fiscal.
export const PREFIXOS_UNIDADES_COMERCIAIS = ['413', '414', '415', '416', '417', '423'];

// Expurgo da locação T&A (série 4 do contrato 68673).
export const EXPURGO_CONTRATO = { numero: '68673', serie: '4' };

export const ROTULOS_EXPURGO = {
  fora_escopo: 'Fora do escopo de receita (TES/CFOP não comerciais)',
  cm_maquinas: 'CM Máquinas',
  central_adm: 'Central ADM',
  fora_unidades: 'Fora das unidades comerciais',
  t_a_contrato: 'Locação T&A (contrato 68673, série 4)'
};

/**
 * Mapa de unidade a partir do centro de custo (3 primeiros dígitos).
 * Mantém a mesma classificação usada no RMR/Faturamento do portal.
 */
export function unidadeSql(alias) {
  return `CASE LEFT(TRIM(COALESCE(${alias}.cod_centro_custo, '')), 3)
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
  END`;
}

/**
 * Motivo do expurgo. Retorna NULL quando a linha permanece no faturamento comercial.
 * A prioridade segue a ordem da premiação: CM, depois ADM, depois T&A.
 */
export function motivoExpurgoSql(alias) {
  return `CASE
    WHEN LEFT(TRIM(COALESCE(${alias}.cod_centro_custo, '')), 3) = '421' THEN 'cm_maquinas'
    WHEN LEFT(TRIM(COALESCE(${alias}.cod_centro_custo, '')), 3) IN ('321', '330') THEN 'central_adm'
    WHEN LEFT(TRIM(COALESCE(${alias}.cod_centro_custo, '')), 3)
      NOT IN ('413', '414', '415', '416', '417', '423') THEN 'fora_unidades'
    WHEN TRIM(COALESCE(${alias}.numero_contrato, '')) = '${EXPURGO_CONTRATO.numero}'
      AND TRIM(COALESCE(${alias}.serie, '')) = '${EXPURGO_CONTRATO.serie}' THEN 't_a_contrato'
    ELSE NULL
  END`;
}

/**
 * Conversão de data ISO (YYYY-MM-DD) para o formato do Protheus (YYYYMMDD).
 */
export function paraProtheus(isoDate) {
  return String(isoDate || '').replace(/-/g, '');
}
