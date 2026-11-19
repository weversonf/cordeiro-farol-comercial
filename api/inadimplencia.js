import { getPool, toNumber } from './_db.js';
import { requireAdminMaster } from './_auth.js';
import { PBIX_FILIAIS, checkTableReadable } from './_dw.js';

const FILIAL_NOMES = {
  '010101': 'Matriz Fortaleza (010101)',
  '010102': 'Filial 010102',
  '030301': 'Transportes Matriz (030301)',
  '030303': 'Transportes Pecém (030303)',
  '040401': 'JVC Locações (040401)',
  '060601': 'Cordeiro Locações (060601)',
  '111101': 'ALSM Locações (111101)'
};

function normalizeMargin(raw) {
  const txt = String(raw || '').trim().toUpperCase();
  if (!txt) return 'Sem Margem';
  if (txt === 'A' || txt.startsWith('MARGEM A')) return 'A';
  if (txt === 'B' || txt.startsWith('MARGEM B')) return 'B';
  if (txt === 'C' || txt.startsWith('MARGEM C')) return 'C';
  return txt;
}

const EXECUTIVOS_INAD_LISTA = [
  'Cristiane',
  'Cristiano',
  'Bruno',
  'Fernando',
  'Fabricio',
  'Marcio'
];

function normalizarExecutivoInad(nome) {
  const norm = String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
  if (!norm) return 'Outros';
  if (norm.includes('CRISTIANE')) return 'Cristiane';
  if (norm.includes('CRISTIANO')) return 'Cristiano';
  if (norm.includes('BRUNO')) return 'Bruno';
  if (norm.includes('FERNANDO')) return 'Fernando';
  if (norm.includes('FABRICIO') || norm.includes('FABRIOCIO')) return 'Fabricio';
  if (norm.includes('MARCIO')) return 'Marcio';
  return 'Outros';
}

function buildResumoPorExecutivo(titulos) {
  const totalGeral = titulos.reduce((acc, item) => acc + toNumber(item.saldoInadimplente), 0);
  const map = new Map();

  for (const item of titulos) {
    const exec = normalizarExecutivoInad(item.executivo);
    if (!map.has(exec)) {
      map.set(exec, {
        executivo: exec,
        margemA: 0,
        margemB: 0,
        margemC: 0,
        outrasMargens: 0,
        saldoTotal: 0,
        qtdTitulos: 0
      });
    }
    const row = map.get(exec);
    const saldo = toNumber(item.saldoInadimplente);
    const m = normalizeMargin(item.margem);
    if (m === 'A') row.margemA += saldo;
    else if (m === 'B') row.margemB += saldo;
    else if (m === 'C') row.margemC += saldo;
    else row.outrasMargens += saldo;
    row.saldoTotal += saldo;
    row.qtdTitulos += 1;
  }

  return Array.from(map.values())
    .map(r => ({
      ...r,
      pctTotal: totalGeral !== 0 ? (r.saldoTotal / totalGeral) * 100 : 0
    }))
    .sort((a, b) => {
      if (a.executivo === 'Outros') return 1;
      if (b.executivo === 'Outros') return -1;
      return b.saldoTotal - a.saldoTotal;
    });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  const user = await requireAdminMaster(req, res);
  if (!user) return;

  const escopo = String(req.query?.escopo || 'pbix').toLowerCase() === 'all' ? 'all' : 'pbix';
  const dataCorte = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.data_corte || ''))
    ? String(req.query.data_corte)
    : new Date().toISOString().slice(0, 10);
  const executivoFiltro = String(req.query?.executivo || '').trim();
  const margemFiltro = String(req.query?.margem || '').trim().toUpperCase();

  try {
    const pool = getPool();
    const statusSe1 = await checkTableReadable(pool, 'stage_protheus', 'se1010');

    if (!statusSe1.canSelect) {
      return res.status(200).json({
        ok: true,
        disponivel: false,
        fonte: 'stage_protheus.se1010',
        dataCorte,
        escopo,
        motivo: statusSe1.exists
          ? 'A tabela stage_protheus.se1010 existe no DW, mas o usuário atual ainda não possui permissão SELECT.'
          : 'A tabela stage_protheus.se1010 ainda não está disponível no DW.',
        sqlLiberacao: 'GRANT SELECT ON stage_protheus.se1010 TO "weverson_feitosa.7d5d4d8dwe";',
        titulos: [],
        resumoExecutivo: [],
        topClientes: []
      });
    }

    const filiaisParam = escopo === 'pbix' ? PBIX_FILIAIS : null;
    const result = await pool.query(`
      WITH fiv_nf AS (
        SELECT DISTINCT ON (
          TRIM(COALESCE(f.cod_cliente, '')),
          TRIM(COALESCE(f.loja, '')),
          TRIM(COALESCE(f.numero_documento, '')),
          TRIM(COALESCE(f.serie, ''))
        )
          TRIM(COALESCE(f.cod_cliente, '')) AS cod_cliente,
          TRIM(COALESCE(f.loja, '')) AS loja,
          TRIM(COALESCE(f.numero_documento, '')) AS numero_documento,
          TRIM(COALESCE(f.serie, '')) AS serie,
          NULLIF(TRIM(COALESCE(f.margem, '')), '') AS margem,
          NULLIF(TRIM(COALESCE(f.numero_contrato, '')), '') AS numero_contrato,
          NULLIF(TRIM(COALESCE(f.cod_vendedor, '')), '') AS cod_vendedor
        FROM comercial.fato_itens_vendas f
        WHERE NULLIF(TRIM(COALESCE(f.numero_documento, '')), '') IS NOT NULL
        ORDER BY
          TRIM(COALESCE(f.cod_cliente, '')),
          TRIM(COALESCE(f.loja, '')),
          TRIM(COALESCE(f.numero_documento, '')),
          TRIM(COALESCE(f.serie, '')),
          f.emissao DESC NULLS LAST
      ),
      cli_nome AS (
        SELECT DISTINCT ON (TRIM(COALESCE(c.cod_cliente, '')), TRIM(COALESCE(c.loja, '')))
          TRIM(COALESCE(c.cod_cliente, '')) AS cod_cliente,
          TRIM(COALESCE(c.loja, '')) AS loja,
          COALESCE(NULLIF(TRIM(c.nome_cliente), ''), 'Cliente ' || TRIM(COALESCE(c.cod_cliente, ''))) AS nome_cliente
        FROM comercial.dim_clientes c
        ORDER BY TRIM(COALESCE(c.cod_cliente, '')), TRIM(COALESCE(c.loja, ''))
      ),
      vend_nome AS (
        SELECT DISTINCT ON (TRIM(COALESCE(v.cod_vendedor, '')))
          TRIM(COALESCE(v.cod_vendedor, '')) AS cod_vendedor,
          UPPER(COALESCE(NULLIF(TRIM(v.nome_vendedor), ''), 'Vendedor ' || TRIM(COALESCE(v.cod_vendedor, '')))) AS nome_vendedor
        FROM comercial.dim_vendedor v
        ORDER BY TRIM(COALESCE(v.cod_vendedor, ''))
      )
      SELECT
        'PROTHEUS (SE1010)' AS origem,
        COALESCE(v.nome_vendedor, 'SEM EXECUTIVO') AS executivo,
        TRIM(COALESCE(se1.e1_cliente, '')) AS cod_cliente,
        COALESCE(cn.nome_cliente, NULLIF(TRIM(se1.e1_nomcli), ''), 'Cliente ' || TRIM(COALESCE(se1.e1_cliente, ''))) AS cliente,
        COALESCE(fn.margem, 'Sem Margem') AS margem,
        COALESCE(fn.numero_contrato, '') AS contrato,
        TRIM(COALESCE(se1.e1_filial, '')) AS cod_filial,
        TRIM(COALESCE(se1.e1_prefixo, '')) AS serie,
        TRIM(COALESCE(se1.e1_num, '')) AS titulo,
        COALESCE(se1.e1_valor, 0)::numeric * CASE WHEN TRIM(COALESCE(se1.e1_tipo, '')) IN ('AB-', 'NCC', 'RA') THEN -1 ELSE 1 END AS valor_original,
        COALESCE(se1.e1_saldo, 0)::numeric * CASE WHEN TRIM(COALESCE(se1.e1_tipo, '')) IN ('AB-', 'NCC', 'RA') THEN -1 ELSE 1 END AS saldo_inadimplente,
        CASE
          WHEN TRIM(COALESCE(se1.e1_emissao::text, '')) ~ '^\\d{8}$' THEN TO_DATE(TRIM(se1.e1_emissao::text), 'YYYYMMDD')
          WHEN TRIM(COALESCE(se1.e1_emissao::text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN SUBSTRING(TRIM(se1.e1_emissao::text), 1, 10)::date
          ELSE NULL
        END AS emissao,
        CASE
          WHEN TRIM(COALESCE(se1.e1_vencrea::text, '')) ~ '^\\d{8}$' THEN TO_DATE(TRIM(se1.e1_vencrea::text), 'YYYYMMDD')
          WHEN TRIM(COALESCE(se1.e1_vencrea::text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN SUBSTRING(TRIM(se1.e1_vencrea::text), 1, 10)::date
          WHEN TRIM(COALESCE(se1.e1_vencto::text, '')) ~ '^\\d{8}$' THEN TO_DATE(TRIM(se1.e1_vencto::text), 'YYYYMMDD')
          WHEN TRIM(COALESCE(se1.e1_vencto::text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN SUBSTRING(TRIM(se1.e1_vencto::text), 1, 10)::date
          ELSE NULL
        END AS vencimento_real
      FROM stage_protheus.se1010 se1
      LEFT JOIN fiv_nf fn
        ON fn.cod_cliente = TRIM(COALESCE(se1.e1_cliente, ''))
       AND fn.loja = TRIM(COALESCE(se1.e1_loja, ''))
       AND fn.numero_documento = TRIM(COALESCE(se1.e1_num, ''))
       AND fn.serie = TRIM(COALESCE(se1.e1_prefixo, ''))
      LEFT JOIN cli_nome cn
        ON cn.cod_cliente = TRIM(COALESCE(se1.e1_cliente, ''))
       AND cn.loja = TRIM(COALESCE(se1.e1_loja, ''))
      LEFT JOIN vend_nome v
        ON v.cod_vendedor = COALESCE(NULLIF(TRIM(COALESCE(se1.e1_vend1, '')), ''), fn.cod_vendedor)
      WHERE COALESCE(TRIM(se1.d_e_l_e_t_), '') <> '*'
        AND COALESCE(se1.e1_saldo, 0) <> 0
        AND ($1::text[] IS NULL OR TRIM(COALESCE(se1.e1_filial, '')) = ANY($1::text[]))
        AND (
          CASE
            WHEN TRIM(COALESCE(se1.e1_vencrea::text, '')) ~ '^\\d{8}$' THEN TO_DATE(TRIM(se1.e1_vencrea::text), 'YYYYMMDD')
            WHEN TRIM(COALESCE(se1.e1_vencrea::text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN SUBSTRING(TRIM(se1.e1_vencrea::text), 1, 10)::date
            WHEN TRIM(COALESCE(se1.e1_vencto::text, '')) ~ '^\\d{8}$' THEN TO_DATE(TRIM(se1.e1_vencto::text), 'YYYYMMDD')
            WHEN TRIM(COALESCE(se1.e1_vencto::text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN SUBSTRING(TRIM(se1.e1_vencto::text), 1, 10)::date
            ELSE NULL
          END
        ) < $2::date
      ORDER BY saldo_inadimplente DESC
    `, [filiaisParam, dataCorte]);

    let titulos = result.rows.map(r => ({
      origem: r.origem,
      executivo: normalizarExecutivoInad(r.executivo),
      codCliente: r.cod_cliente,
      cliente: r.cliente,
      margem: normalizeMargin(r.margem),
      contrato: r.contrato,
      filial: FILIAL_NOMES[r.cod_filial] || r.cod_filial,
      codFilial: r.cod_filial,
      serie: r.serie,
      titulo: r.titulo,
      valorOriginal: toNumber(r.valor_original),
      saldoInadimplente: toNumber(r.saldo_inadimplente),
      emissao: r.emissao ? new Date(r.emissao).toISOString().slice(0, 10) : null,
      vencimentoReal: r.vencimento_real ? new Date(r.vencimento_real).toISOString().slice(0, 10) : null
    }));

    if (executivoFiltro) {
      titulos = titulos.filter(t => t.executivo.toLowerCase() === executivoFiltro.toLowerCase());
    }
    if (margemFiltro && margemFiltro !== 'TODAS') {
      titulos = titulos.filter(t => t.margem === margemFiltro);
    }

    const resumoExecutivo = buildResumoPorExecutivo(titulos);

    const cliMap = new Map();
    for (const t of titulos) {
      const k = `${t.codCliente}|${t.cliente}`;
      if (!cliMap.has(k)) {
        cliMap.set(k, { codCliente: t.codCliente, cliente: t.cliente, saldo: 0, qtdTitulos: 0, executivo: t.executivo, margem: t.margem });
      }
      const c = cliMap.get(k);
      c.saldo += t.saldoInadimplente;
      c.qtdTitulos += 1;
    }
    const topClientes = Array.from(cliMap.values()).sort((a, b) => b.saldo - a.saldo).slice(0, 10);

    return res.status(200).json({
      ok: true,
      disponivel: true,
      fonte: 'stage_protheus.se1010 + comercial.fato_itens_vendas',
      dataCorte,
      escopo,
      resumoExecutivo,
      topClientes,
      titulos
    });
  } catch (error) {
    console.error('Falha ao consultar inadimplência:', error);
    return res.status(500).json({ ok: false, error: 'Não foi possível consultar a inadimplência no DW agora.' });
  }
}
