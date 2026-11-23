import { toNumber } from './_db.js';
import {
  CFOPS_RECEITA,
  ROTULOS_EXPURGO,
  TES_COMERCIAIS,
  motivoExpurgoSql,
  paraProtheus,
  unidadeSql
} from './_fat_rules.js';

function cteBase() {
  return `
    sd_raw AS MATERIALIZED (
      SELECT
        TRIM(COALESCE(sd.d2_filial, '')) AS cod_filial,
        TRIM(COALESCE(sd.d2_doc, '')) AS numero_documento,
        TRIM(COALESCE(sd.d2_serie, '')) AS serie,
        TRIM(COALESCE(sd.d2_cliente, '')) AS cod_cliente,
        TRIM(COALESCE(sd.d2_loja, '')) AS loja,
        TRIM(COALESCE(sd.d2_ccusto, '')) AS cod_centro_custo,
        TRIM(COALESCE(sd.d2_pedido, '')) AS numero_pedido,
        TRIM(COALESCE(sd.d2_ynumctr, '')) AS numero_contrato,
        TRIM(COALESCE(sd.d2_tes, '')) AS tes,
        TRIM(COALESCE(sd.d2_cf, '')) AS cfop,
        TRIM(COALESCE(sd.d2_item::text, '')) AS item,
        TRIM(COALESCE(sd.d2_cod::text, '')) AS cod_produto,
        TRIM(COALESCE(sd.d2_conta::text, '')) AS item_conta,
        COALESCE(sd.d2_quant, 0)::numeric AS quantidade,
        COALESCE(sd.d2_prcven, 0)::numeric AS valor_unitario,
        TRIM(COALESCE(sd.d2_ymargct::text, '')) AS margem_contrato,
        TRIM(COALESCE(sd.d2_emissao, '')) AS emissao,
        COALESCE(sd.d2_total, 0)::numeric AS valor
      FROM stage_protheus.sd2010 sd
      WHERE COALESCE(TRIM(sd.d_e_l_e_t_), '') <> '*'
        AND TRIM(COALESCE(sd.d2_emissao, '')) >= $1
        AND TRIM(COALESCE(sd.d2_emissao, '')) <= $2
    ),
    nf_vendedor AS MATERIALIZED (
      SELECT DISTINCT ON (cod_filial, numero_documento, serie)
        TRIM(COALESCE(f.cod_filial, '')) AS cod_filial,
        TRIM(COALESCE(f.numero_documento, '')) AS numero_documento,
        TRIM(COALESCE(f.serie, '')) AS serie,
        TRIM(COALESCE(f.cod_vendedor, '')) AS cod_vendedor
      FROM comercial.fato_itens_vendas f
      WHERE f.emissao >= TO_DATE($1, 'YYYYMMDD')
        AND f.emissao <= TO_DATE($2, 'YYYYMMDD')
      ORDER BY
        TRIM(COALESCE(f.cod_filial, '')),
        TRIM(COALESCE(f.numero_documento, '')),
        TRIM(COALESCE(f.serie, '')),
        TRIM(COALESCE(f.cod_vendedor, ''))
    ),
    vend_nome AS (
      SELECT DISTINCT ON (TRIM(COALESCE(v.cod_vendedor, '')))
        TRIM(COALESCE(v.cod_vendedor, '')) AS cod_vendedor,
        NULLIF(TRIM(v.nome_vendedor), '') AS nome_vendedor
      FROM comercial.dim_vendedor v
      ORDER BY TRIM(COALESCE(v.cod_vendedor, '')), v.id DESC
    ),
    classificado AS MATERIALIZED (
      SELECT
        r.cod_filial,
        r.numero_documento,
        r.serie,
        r.cod_cliente,
        r.loja,
        r.cod_centro_custo,
        r.numero_pedido,
        r.numero_contrato,
        r.item,
        r.cod_produto,
        r.item_conta,
        r.quantidade,
        r.valor_unitario,
        r.margem_contrato,
        r.tes,
        r.cfop,
        r.emissao,
        r.valor,
        COALESCE(nv.cod_vendedor, '') AS cod_vendedor,
        COALESCE(vn.nome_vendedor, NULLIF(nv.cod_vendedor, ''), 'Sem executivo') AS executivo,
        ${unidadeSql('r')} AS unidade,
        (r.tes = ANY($3::text[]) AND r.cfop = ANY($4::text[])) AS is_receita,
        ${motivoExpurgoSql('r')} AS motivo
      FROM sd_raw r
      LEFT JOIN nf_vendedor nv
        ON nv.cod_filial = r.cod_filial
       AND nv.numero_documento = r.numero_documento
       AND nv.serie = r.serie
      LEFT JOIN vend_nome vn
        ON vn.cod_vendedor = nv.cod_vendedor
    )
  `;
}

function buildFiltros({ unidade, executivo, cliente }, params) {
  const filtros = [];
  if (unidade) {
    params.push(unidade);
    filtros.push(`unidade = $${params.length}`);
  }
  if (executivo) {
    params.push(executivo);
    filtros.push(`executivo = $${params.length}`);
  }
  if (cliente) {
    params.push(cliente);
    filtros.push(`cod_cliente = $${params.length}`);
  }
  return filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
}

/**
 * Consulta a prévia de faturamento diretamente na SD2 do Protheus,
 * aplicando as regras de expurgo da planilha de premiação.
 */
export async function queryFaturamentoSd2(pool, { startDate, endDate, unidade, executivo, cliente }) {
  const params = [paraProtheus(startDate), paraProtheus(endDate), TES_COMERCIAIS, CFOPS_RECEITA];
  const whereFiltro = buildFiltros({ unidade, executivo, cliente }, params);

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'America/Sao_Paulo'");

    const resumoQuery = `
      WITH ${cteBase()},
      f AS (SELECT * FROM classificado ${whereFiltro})
      SELECT
        COALESCE(SUM(valor), 0) AS bruto,
        COALESCE(SUM(valor) FILTER (WHERE NOT is_receita), 0) AS fora_escopo,
        COALESCE(SUM(valor) FILTER (WHERE is_receita), 0) AS receita,
        COALESCE(SUM(valor) FILTER (WHERE is_receita AND motivo IS NULL), 0) AS comercial,
        COALESCE(SUM(valor) FILTER (WHERE is_receita AND motivo = 'cm_maquinas'), 0) AS cm_maquinas,
        COALESCE(SUM(valor) FILTER (WHERE is_receita AND motivo = 'central_adm'), 0) AS central_adm,
        COALESCE(SUM(valor) FILTER (WHERE is_receita AND motivo = 'fora_unidades'), 0) AS fora_unidades,
        COALESCE(SUM(valor) FILTER (WHERE is_receita AND motivo = 't_a_contrato'), 0) AS t_a_contrato,
        COUNT(*) FILTER (WHERE is_receita AND motivo IS NULL) AS itens,
        COUNT(DISTINCT (cod_filial, numero_documento, serie))
          FILTER (WHERE is_receita AND motivo IS NULL) AS nfs,
        COUNT(DISTINCT cod_cliente) FILTER (WHERE is_receita AND motivo IS NULL) AS clientes
      FROM f
    `;

    const mensalQuery = `
      WITH ${cteBase()},
      f AS (SELECT * FROM classificado ${whereFiltro})
      SELECT
        TO_CHAR(TO_DATE(emissao, 'YYYYMMDD'), 'YYYY-MM') AS mes_iso,
        COALESCE(SUM(valor), 0) AS bruto,
        COALESCE(SUM(valor) FILTER (WHERE is_receita AND motivo IS NULL), 0) AS comercial
      FROM f
      GROUP BY 1
      ORDER BY 1
    `;

    const unidadeQuery = `
      WITH ${cteBase()},
      f AS (SELECT * FROM classificado ${whereFiltro})
      SELECT
        unidade,
        COALESCE(SUM(valor), 0) AS bruto,
        COALESCE(SUM(valor) FILTER (WHERE is_receita AND motivo IS NULL), 0) AS comercial,
        COALESCE(SUM(valor) FILTER (WHERE is_receita AND motivo = 'cm_maquinas'), 0) AS cm_maquinas,
        COALESCE(SUM(valor) FILTER (WHERE is_receita AND motivo = 'central_adm'), 0) AS central_adm,
        COUNT(DISTINCT (cod_filial, numero_documento, serie))
          FILTER (WHERE is_receita AND motivo IS NULL) AS nfs
      FROM f
      GROUP BY 1
      ORDER BY comercial DESC
    `;

    const executivoQuery = `
      WITH ${cteBase()},
      f AS (SELECT * FROM classificado ${whereFiltro})
      SELECT
        executivo,
        cod_vendedor,
        COALESCE(SUM(valor) FILTER (WHERE is_receita AND motivo IS NULL), 0) AS comercial,
        COUNT(DISTINCT (cod_filial, numero_documento, serie))
          FILTER (WHERE is_receita AND motivo IS NULL) AS nfs
      FROM f
      WHERE is_receita AND motivo IS NULL
      GROUP BY 1, 2
      ORDER BY comercial DESC
    `;

    const clienteQuery = `
      WITH ${cteBase()},
      f AS (SELECT * FROM classificado ${whereFiltro})
      SELECT
        cod_cliente,
        COALESCE(SUM(valor) FILTER (WHERE is_receita AND motivo IS NULL), 0) AS comercial,
        COUNT(DISTINCT (cod_filial, numero_documento, serie))
          FILTER (WHERE is_receita AND motivo IS NULL) AS nfs
      FROM f
      WHERE is_receita AND motivo IS NULL
      GROUP BY 1
      ORDER BY comercial DESC
      LIMIT 20
    `;

    const listaUnidadesQuery = `
      WITH ${cteBase()}
      SELECT DISTINCT unidade FROM classificado ORDER BY 1
    `;

    const listaExecutivosQuery = `
      WITH ${cteBase()}
      SELECT DISTINCT executivo FROM classificado
      WHERE executivo <> 'Sem executivo' ORDER BY 1
    `;

    const freshnessQuery = `
      SELECT
        (SELECT TO_CHAR(MAX(TO_DATE(TRIM(d2_emissao), 'YYYYMMDD')), 'YYYY-MM-DD')
         FROM stage_protheus.sd2010
         WHERE COALESCE(TRIM(d_e_l_e_t_), '') <> '*' AND TRIM(COALESCE(d2_emissao, '')) ~ '^\\d{8}$') AS max_emissao,
        (SELECT MAX(s_t_a_m_p_) FROM stage_protheus.sd2010 WHERE COALESCE(TRIM(d_e_l_e_t_), '') <> '*') AS max_stamp,
        (SELECT MAX(emissao)::text FROM comercial.fato_itens_vendas) AS max_vend_emissao
    `;

    const resumo = await client.query(resumoQuery, params);
    const mensal = await client.query(mensalQuery, params);
    const unidades = await client.query(unidadeQuery, params);
    const executivos = await client.query(executivoQuery, params);
    const clientes = await client.query(clienteQuery, params);
    // As consultas de catálogo usam somente os quatro parâmetros da CTE.
    // Repassar os parâmetros extras dos filtros causa erro de bind no PostgreSQL.
    const paramsBase = params.slice(0, 4);
    const listaUnidades = await client.query(listaUnidadesQuery, paramsBase);
    const listaExecutivos = await client.query(listaExecutivosQuery, paramsBase);
    const freshness = await client.query(freshnessQuery);
    const freshRow = freshness.rows[0] || {};

    const r = resumo.rows[0] || {};
    const comercial = toNumber(r.comercial);
    const nfs = Number(r.nfs || 0);

    return {
      atualizacao: {
        protheusUltimaEmissao: freshRow.max_emissao || null,
        protheusUltimaCarga: freshRow.max_stamp || null,
        vendedorUltimaEmissao: freshRow.max_vend_emissao ? String(freshRow.max_vend_emissao).slice(0, 10) : null
      },
      resumo: {
        bruto: toNumber(r.bruto),
        foraEscopo: toNumber(r.fora_escopo),
        receita: toNumber(r.receita),
        comercial,
        expurgos: toNumber(r.cm_maquinas) + toNumber(r.central_adm)
          + toNumber(r.fora_unidades) + toNumber(r.t_a_contrato),
        qtdItens: Number(r.itens || 0),
        qtdNfs: nfs,
        qtdClientes: Number(r.clientes || 0),
        ticketMedioNf: nfs > 0 ? comercial / nfs : 0
      },
      expurgos: [
        { motivo: 'fora_escopo', rotulo: ROTULOS_EXPURGO.fora_escopo, valor: toNumber(r.fora_escopo), base: 'bruto' },
        { motivo: 'cm_maquinas', rotulo: ROTULOS_EXPURGO.cm_maquinas, valor: toNumber(r.cm_maquinas) },
        { motivo: 'central_adm', rotulo: ROTULOS_EXPURGO.central_adm, valor: toNumber(r.central_adm) },
        { motivo: 'fora_unidades', rotulo: ROTULOS_EXPURGO.fora_unidades, valor: toNumber(r.fora_unidades) },
        { motivo: 't_a_contrato', rotulo: ROTULOS_EXPURGO.t_a_contrato, valor: toNumber(r.t_a_contrato) }
      ],
      mensal: mensal.rows.map(x => ({
        mesIso: x.mes_iso,
        bruto: toNumber(x.bruto),
        comercial: toNumber(x.comercial)
      })),
      porUnidade: unidades.rows.map(x => ({
        unidade: x.unidade,
        bruto: toNumber(x.bruto),
        comercial: toNumber(x.comercial),
        cmMaquinas: toNumber(x.cm_maquinas),
        centralAdm: toNumber(x.central_adm),
        qtdNfs: Number(x.nfs || 0)
      })),
      porExecutivo: executivos.rows.map(x => ({
        executivo: x.executivo,
        codVendedor: x.cod_vendedor,
        comercial: toNumber(x.comercial),
        qtdNfs: Number(x.nfs || 0)
      })),
      porCliente: clientes.rows.map(x => ({
        codCliente: x.cod_cliente,
        comercial: toNumber(x.comercial),
        qtdNfs: Number(x.nfs || 0)
      })),
      filtros: {
        unidades: listaUnidades.rows.map(x => x.unidade).filter(Boolean),
        executivos: listaExecutivos.rows.map(x => x.executivo).filter(Boolean)
      }
    };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * Extrato analítico no formato da base SD2 usada na premiação.
 * Retorna todas as linhas do período, incluindo as expurgadas e o motivo.
 */
export async function queryFaturamentoDetalhe(pool, { startDate, endDate, unidade, executivo, cliente }) {
  const params = [paraProtheus(startDate), paraProtheus(endDate), TES_COMERCIAIS, CFOPS_RECEITA];
  const whereFiltro = buildFiltros({ unidade, executivo, cliente }, params);

  const sql = `
    WITH ${cteBase()},
    cli AS (
      SELECT DISTINCT ON (TRIM(cod_cliente), TRIM(loja))
        TRIM(cod_cliente) AS cod_cliente,
        TRIM(loja) AS loja,
        NULLIF(TRIM(nome_cliente), '') AS nome_cliente
      FROM comercial.dim_clientes
      ORDER BY TRIM(cod_cliente), TRIM(loja), data_modificacao DESC NULLS LAST, id DESC
    ),
    prod AS (
      SELECT DISTINCT ON (TRIM(cod_filial), TRIM(cod_produto))
        TRIM(cod_filial) AS cod_filial,
        TRIM(cod_produto) AS cod_produto,
        NULLIF(TRIM(nome_produto), '') AS nome_produto
      FROM comercial.dim_produtos_protheus
      ORDER BY TRIM(cod_filial), TRIM(cod_produto), data_modificacao DESC NULLS LAST, id DESC
    ),
    f AS (SELECT * FROM classificado ${whereFiltro})
    SELECT
      f.cod_filial,
      f.numero_documento,
      f.serie,
      f.item,
      TO_CHAR(TO_DATE(f.emissao, 'YYYYMMDD'), 'YYYY-MM-DD') AS emissao,
      f.cod_cliente,
      f.loja,
      cli.nome_cliente,
      f.cod_produto,
      prod.nome_produto,
      f.quantidade,
      f.valor_unitario,
      f.valor,
      f.tes,
      f.cfop,
      f.numero_pedido,
      f.numero_contrato,
      f.cod_centro_custo,
      f.item_conta,
      f.margem_contrato,
      f.unidade,
      f.cod_vendedor,
      f.executivo,
      f.is_receita,
      f.motivo
    FROM f
    LEFT JOIN cli ON cli.cod_cliente = f.cod_cliente AND cli.loja = f.loja
    LEFT JOIN prod ON prod.cod_filial = f.cod_filial AND prod.cod_produto = f.cod_produto
    ORDER BY f.cod_filial, f.numero_documento, f.serie, f.item
  `;

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const r = await client.query(sql, params);
    return r.rows.map(x => ({
      codFilial: x.cod_filial,
      numeroDocumento: x.numero_documento,
      serie: x.serie,
      item: x.item,
      emissao: x.emissao,
      codCliente: x.cod_cliente,
      loja: x.loja,
      cliente: x.nome_cliente || '',
      codProduto: x.cod_produto,
      produto: x.nome_produto || '',
      quantidade: toNumber(x.quantidade),
      valorUnitario: toNumber(x.valor_unitario),
      valor: toNumber(x.valor),
      tes: x.tes,
      cfop: x.cfop,
      numeroPedido: x.numero_pedido,
      numeroContrato: x.numero_contrato,
      centroCusto: x.cod_centro_custo,
      itemConta: x.item_conta,
      margemContrato: x.margem_contrato || '',
      unidade: x.unidade,
      codVendedor: x.cod_vendedor,
      executivo: x.executivo,
      isReceita: x.is_receita,
      motivo: x.motivo
    }));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}
