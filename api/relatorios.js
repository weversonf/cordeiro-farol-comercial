import pg from 'pg';

const { Pool } = pg;
let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.PGHOST || process.env.DB_HOST,
      port: Number(process.env.PGPORT || process.env.DB_PORT || 6543),
      database: process.env.PGDATABASE || process.env.DB_NAME || 'postgres',
      user: process.env.PGUSER || process.env.DB_USER,
      password: process.env.PGPASSWORD || process.env.DB_PASS,
      ssl: { rejectUnauthorized: false },
      max: 4,
      connectionTimeoutMillis: 10000
    });
  }
  return pool;
}

function number(value) {
  return Number(value || 0);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  const requestedYear = Number(req.query?.year);
  const currentYear = new Date().getFullYear();
  const year = Number.isInteger(requestedYear) && requestedYear >= 2023 && requestedYear <= currentYear + 1
    ? requestedYear
    : currentYear;
  const start = `${year}-01-01`;
  const end = `${year + 1}-01-01`;
  const values = [start, end];

  const filtroComercialPuro = `
    f.data_emissao >= $1::date
    AND f.data_emissao < $2::date
    AND TRIM(COALESCE(f.cod_filial::text, '')) NOT IN ('121201', '101001', '040401', '111101')
    AND TRIM(COALESCE(f.cod_vendedor::text, '')) NOT IN ('00049', '000050')`;

  try {
    const client = getPool();
    const [resumoResult, mensalResult, unidadesResult, contratosResult, equipamentosResult, consultoresResult, pipelineResult, atualizacaoResult] = await Promise.all([
      client.query(`
        SELECT
          COALESCE(SUM(f.valor_bruto), 0) AS bruto,
          COALESCE(SUM(CASE WHEN ${filtroComercialPuro} THEN f.valor_bruto ELSE 0 END), 0) AS liquido,
          COALESCE(SUM(CASE WHEN NOT (${filtroComercialPuro}) THEN f.valor_bruto ELSE 0 END), 0) AS expurgos
        FROM comercial.faturamento_bruto f
        WHERE f.data_emissao >= $1::date AND f.data_emissao < $2::date`, values),
      client.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', f.data_emissao), 'YYYY-MM') AS mes,
          COALESCE(SUM(f.valor_bruto), 0) AS valor
        FROM comercial.faturamento_bruto f
        WHERE ${filtroComercialPuro}
        GROUP BY 1
        ORDER BY 1`, values),
      client.query(`
        SELECT
          CASE LEFT(TRIM(COALESCE(f.cod_centro_custo::text, '')), 3)
            WHEN '413' THEN 'Pecém'
            WHEN '414' THEN 'Wind'
            WHEN '415' THEN 'Engenharia'
            WHEN '416' THEN 'Norte'
            WHEN '417' THEN 'Complexo'
            WHEN '420' THEN 'Transportes'
            WHEN '423' THEN 'Wind Service'
            ELSE COALESCE(NULLIF(TRIM(f.unidade), ''), 'Outras unidades')
          END AS unidade,
          COALESCE(SUM(f.valor_bruto), 0) AS valor
        FROM comercial.faturamento_bruto f
        WHERE ${filtroComercialPuro}
        GROUP BY 1
        ORDER BY valor DESC
        LIMIT 10`, values),
      client.query(`
        SELECT
          TRIM(f.numero_contrato::text) AS contrato,
          MAX(NULLIF(TRIM(f.nome_curto), '')) AS cliente,
          COALESCE(SUM(f.valor_bruto), 0) AS valor
        FROM comercial.faturamento_bruto f
        WHERE ${filtroComercialPuro}
          AND NULLIF(TRIM(f.numero_contrato::text), '') IS NOT NULL
        GROUP BY 1
        ORDER BY valor DESC
        LIMIT 10`, values),
      client.query(`
        SELECT
          COALESCE(NULLIF(TRIM(f.descricao_produto), ''), 'Produto não identificado') AS equipamento,
          COALESCE(SUM(f.valor_bruto), 0) AS valor
        FROM comercial.faturamento_bruto f
        WHERE ${filtroComercialPuro}
        GROUP BY 1
        ORDER BY valor DESC
        LIMIT 10`, values),
      client.query(`
        WITH receita AS (
          SELECT TRIM(f.cod_vendedor::text) AS codigo, COALESCE(SUM(f.valor_bruto), 0) AS valor
          FROM comercial.faturamento_bruto f
          WHERE ${filtroComercialPuro}
          GROUP BY 1
        ), nomes AS (
          SELECT TRIM(cod_vendedor::text) AS codigo, MAX(NULLIF(TRIM(nome_vendedor), '')) AS nome
          FROM comercial.dim_vendedor
          GROUP BY 1
        )
        SELECT COALESCE(n.nome, r.codigo, 'Sem consultor identificado') AS consultor, r.valor
        FROM receita r
        LEFT JOIN nomes n USING (codigo)
        ORDER BY r.valor DESC
        LIMIT 10`, values),
      client.query(`
        SELECT
          COALESCE(NULLIF(TRIM(CONCAT(u."NAME", ' ', COALESCE(u."LAST_NAME", ''))), ''), 'Sem consultor') AS consultor,
          COUNT(*) AS negocios,
          COALESCE(SUM(COALESCE(NULLIF(d."OPPORTUNITY"::text, ''), '0')::numeric), 0) AS valor
        FROM stage_bitrix.b_crm_deal d
        LEFT JOIN stage_bitrix.b_user u ON u."ID"::text = d."ASSIGNED_BY_ID"::text
        WHERE d."CATEGORY_ID" IN ('4', '19')
          AND d."STAGE_SEMANTIC_ID" = 'P'
        GROUP BY 1
        ORDER BY valor DESC
        LIMIT 10`),
      client.query(`
        SELECT
          (SELECT MAX(data_emissao) FROM comercial.faturamento_bruto) AS protheus,
          (SELECT MAX("DATE_MODIFY") FROM stage_bitrix.b_crm_deal) AS bitrix`)
    ]);

    const resumo = resumoResult.rows[0];
    const pipeline = pipelineResult.rows.map(row => ({
      consultor: row.consultor,
      negocios: number(row.negocios),
      valor: number(row.valor)
    }));

    return res.status(200).json({
      ok: true,
      ano: year,
      geradoEm: new Date().toISOString(),
      fontes: {
        protheus: 'comercial.faturamento_bruto (SD2)',
        bitrix: 'stage_bitrix.b_crm_deal'
      },
      atualizacao: atualizacaoResult.rows[0],
      resumo: {
        bruto: number(resumo.bruto),
        liquido: number(resumo.liquido),
        expurgos: number(resumo.expurgos),
        pipeline: pipeline.reduce((total, item) => total + item.valor, 0),
        negociosPipeline: pipeline.reduce((total, item) => total + item.negocios, 0)
      },
      mensal: mensalResult.rows.map(row => ({ mes: row.mes, valor: number(row.valor) })),
      unidades: unidadesResult.rows.map(row => ({ unidade: row.unidade, valor: number(row.valor) })),
      contratos: contratosResult.rows.map(row => ({ contrato: row.contrato, cliente: row.cliente || 'Cliente não identificado', valor: number(row.valor) })),
      equipamentos: equipamentosResult.rows.map(row => ({ equipamento: row.equipamento, valor: number(row.valor) })),
      consultores: consultoresResult.rows.map(row => ({ consultor: row.consultor, valor: number(row.valor) })),
      pipeline
    });
  } catch (error) {
    console.error('Falha ao consultar relatórios:', error);
    return res.status(500).json({ ok: false, error: 'Não foi possível atualizar os relatórios agora.' });
  }
}
