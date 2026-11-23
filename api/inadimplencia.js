import { getPool, toNumber } from './_db.js';
import { requireAdminMaster } from './_auth.js';
import { PBIX_FILIAIS, checkTableReadable } from './_dw.js';
import { INAD_RULES_VERSION, parseRegras } from './_inad_rules.js';
import { queryInadimplencia } from './_inad_query.js';

const FILIAL_NOMES = {
  '010101': '010101 - Matriz Fortaleza',
  '010102': '010102 - Filial 010102',
  '010103': '010103 - Filial 010103',
  '010104': '010104 - Filial 010104',
  '020201': '020201 - Cordeiro Guindastes',
  '030301': '030301 - Transportes Matriz',
  '030302': '030302 - Transportes Filial 02',
  '030303': '030303 - Transportes Pecém',
  '040401': '040401 - JVC Locações',
  '060601': '060601 - Cordeiro Locações',
  '060602': '060602 - Cordeiro Locações (Wind)',
  '070701': '070701 - Filial 070701',
  '101001': '101001 - Central Administrativa',
  '111101': '111101 - ALSM Locações',
  '121201': '121201 - CM Máquinas (Matriz)',
  '121202': '121202 - CM Máquinas (Mossoró)',
  '121203': '121203 - CM Máquinas (Recife)',
  '141401': '141401 - Cordeiro Engenharia',
  '161601': '161601 - Holding / Central ADM',
  '171701': '171701 - Cordeiro Metalmecânica'
};

function formatarNomeFilial(codFilial) {
  const cod = String(codFilial || '').trim();
  if (!cod) return 'Sem Filial';
  return FILIAL_NOMES[cod] || `${cod} - Filial ${cod}`;
}

function normalizeMargin(raw) {
  const txt = String(raw || '').trim().toUpperCase();
  if (!txt) return 'Sem Margem';
  if (txt === 'A' || txt.startsWith('MARGEM A')) return 'A';
  if (txt === 'B' || txt.startsWith('MARGEM B')) return 'B';
  if (txt === 'C' || txt.startsWith('MARGEM C')) return 'C';
  return txt;
}

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

function getHojeSaoPauloIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

const SNAPSHOT_MIGRATION_SQL = `CREATE SCHEMA IF NOT EXISTS farol;
CREATE TABLE IF NOT EXISTS farol.inadimplencia_fechamento (
  id bigserial PRIMARY KEY,
  competencia char(7) NOT NULL UNIQUE,
  data_ref date NOT NULL,
  gerado_em timestamptz NOT NULL DEFAULT now(),
  gerado_por text NOT NULL,
  origem text NOT NULL,
  regras_versao text NOT NULL,
  regras text[] NOT NULL DEFAULT '{}',
  qtd_titulos integer NOT NULL,
  saldo_total numeric(18,2) NOT NULL,
  valor_total numeric(18,2) NOT NULL,
  impacto jsonb,
  observacao text
);
CREATE TABLE IF NOT EXISTS farol.inadimplencia_fechamento_titulo (
  id bigserial PRIMARY KEY,
  fechamento_id bigint NOT NULL REFERENCES farol.inadimplencia_fechamento(id) ON DELETE CASCADE,
  cod_filial text, serie text, titulo text, parcela text, tipo text, loja text,
  cod_cliente text, nome_cliente text, natureza text, cod_vendedor text, executivo text,
  margem text, contrato text, faixa text,
  emissao date, vencimento_real date,
  valor_original numeric(18,2), saldo numeric(18,2)
);
CREATE INDEX IF NOT EXISTS ix_inad_fech_titulo ON farol.inadimplencia_fechamento_titulo (fechamento_id);
GRANT USAGE ON SCHEMA farol TO :ROLE;
GRANT SELECT, INSERT, DELETE ON farol.inadimplencia_fechamento TO :ROLE;
GRANT SELECT, INSERT, DELETE ON farol.inadimplencia_fechamento_titulo TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE farol.inadimplencia_fechamento_id_seq TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE farol.inadimplencia_fechamento_titulo_id_seq TO :ROLE;`;

function tabelaAusente(error) {
  return ['42P01', '3F000', '42501'].includes(String(error?.code || ''));
}

function mapTitulo(r) {
  return {
    origem: r.origem || 'PROTHEUS (SE1010)',
    executivo: normalizarExecutivoInad(r.executivo),
    codCliente: r.cod_cliente,
    cliente: r.cliente,
    margem: normalizeMargin(r.margem),
    contrato: r.contrato || '',
    filial: formatarNomeFilial(r.cod_filial),
    codFilial: r.cod_filial,
    serie: r.serie,
    titulo: r.titulo,
    parcela: r.parcela,
    loja: r.loja,
    natureza: r.natureza,
    tipo: r.tipo,
    valorOriginal: toNumber(r.valor_original),
    saldoInadimplente: toNumber(r.saldo_inadimplente),
    faixa: r.faixa || null,
    emissao: r.emissao || null,
    vencimentoReal: r.vencimento_real || null
  };
}

async function carregarFechamento(pool, competencia) {
  const header = await pool.query(
    `SELECT id, competencia, data_ref, gerado_em, origem, regras_versao, regras,
            qtd_titulos, saldo_total, valor_total, impacto, observacao
     FROM farol.inadimplencia_fechamento
     WHERE competencia = $1`,
    [competencia]
  );
  if (!header.rows.length) return null;
  const h = header.rows[0];
  const rows = await pool.query(
    `SELECT cod_filial, serie, titulo, parcela, tipo, loja, cod_cliente, nome_cliente,
            natureza, cod_vendedor, executivo, margem, contrato, faixa, emissao,
            vencimento_real, valor_original, saldo
     FROM farol.inadimplencia_fechamento_titulo
     WHERE fechamento_id = $1
     ORDER BY saldo DESC`,
    [h.id]
  );
  return { h, rows: rows.rows };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  const user = await requireAdminMaster(req, res);
  if (!user) return;

  const escopo = String(req.query?.escopo || 'all').toLowerCase() === 'pbix' ? 'pbix' : 'all';
  const dataCorte = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.data_corte || ''))
    ? String(req.query.data_corte)
    : getHojeSaoPauloIso();
  const competencia = /^\d{4}-\d{2}$/.test(String(req.query?.competencia || ''))
    ? String(req.query.competencia)
    : null;
  const executivoFiltro = String(req.query?.executivo || '').trim();
  const margemFiltro = String(req.query?.margem || '').trim().toUpperCase();
  const filiaisFiltro = String(req.query?.filiais || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  try {
    const pool = getPool();
    const filiaisParam = escopo === 'pbix' ? PBIX_FILIAIS : null;
    let titulos = [];
    let meta = {};

    if (competencia) {
      let fechado;
      try {
        fechado = await carregarFechamento(pool, competencia);
      } catch (error) {
        if (!tabelaAusente(error)) throw error;
        return res.status(200).json({
          ok: true,
          disponivel: false,
          fonte: 'farol.inadimplencia_fechamento',
          competencia,
          motivo: 'O fechamento mensal ainda não está habilitado no DW.',
          sqlLiberacao: SNAPSHOT_MIGRATION_SQL,
          titulos: [],
          resumoExecutivo: [],
          topClientes: []
        });
      }
      if (!fechado) {
        return res.status(404).json({
          ok: false,
          error: `Não existe fechamento publicado para ${competencia}.`
        });
      }
      const { h, rows } = fechado;
      titulos = rows
        .filter(r => escopo !== 'pbix' || PBIX_FILIAIS.includes(String(r.cod_filial || '').trim()))
        .map(r => mapTitulo({
          ...r,
          cliente: r.nome_cliente,
          saldo_inadimplente: r.saldo
        }));
      meta = {
        posicao: 'fechamento',
        dataCorte: h.data_ref,
        competencia: h.competencia,
        geradoEm: h.gerado_em,
        origemFechamento: h.origem,
        regrasVersao: h.regras_versao,
        regras: h.regras,
        impactoRegras: h.impacto || null,
        observacao: h.observacao
      };
    } else {
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

      const regras = parseRegras(req.query?.regras);
      const [{ titulos: linhas, impacto }, freshRes] = await Promise.all([
        queryInadimplencia(pool, {
          filiais: filiaisParam,
          corte: dataCorte,
          regras
        }),
        pool.query(`
          SELECT
            (SELECT TO_CHAR(MAX(TO_DATE(TRIM(e1_emissao), 'YYYYMMDD')), 'YYYY-MM-DD')
             FROM stage_protheus.se1010
             WHERE COALESCE(TRIM(d_e_l_e_t_), '') <> '*' AND TRIM(COALESCE(e1_emissao, '')) ~ '^\\d{8}$') AS max_emissao,
            (SELECT TO_CHAR(MAX(TO_DATE(TRIM(e1_baixa), 'YYYYMMDD')), 'YYYY-MM-DD')
             FROM stage_protheus.se1010
             WHERE COALESCE(TRIM(d_e_l_e_t_), '') <> '*' AND TRIM(COALESCE(e1_baixa, '')) ~ '^\\d{8}$') AS max_baixa,
            (SELECT MAX(s_t_a_m_p_) FROM stage_protheus.se1010 WHERE COALESCE(TRIM(d_e_l_e_t_), '') <> '*') AS max_stamp,
            (SELECT MAX(emissao)::text FROM comercial.fato_itens_vendas) AS max_margem_emissao
        `)
      ]);
      const fresh = freshRes.rows[0] || {};

      titulos = linhas.map(mapTitulo);
      meta = {
        posicao: 'saldo_atual',
        dataCorte,
        atualizacao: {
          protheusUltimaEmissao: fresh.max_emissao || null,
          protheusUltimaBaixa: fresh.max_baixa || null,
          protheusUltimaCarga: fresh.max_stamp || null,
          protheusMargemAte: fresh.max_margem_emissao ? String(fresh.max_margem_emissao).slice(0, 10) : null
        },
        regrasVersao: INAD_RULES_VERSION,
        regras,
        impactoRegras: impacto,
        observacao: 'Saldo atual da réplica Protheus (SE1010), com as regras do relatório: naturezas de faturamento, janela de 365 dias, exclusão de RA/ADT, mútuos, intercompany, venda de ativos e seguro Petrobras. Retenções de ISS/INSS são deduzidas. A data filtra vencimentos; não recompõe o saldo de uma data passada. Informakon não faz parte da SE1.',
        conciliacao: 'pendente'
      };
    }

    const filialMap = new Map();
    for (const t of titulos) {
      const cod = t.codFilial || t.filial || '';
      if (!cod) continue;
      if (!filialMap.has(cod)) {
        filialMap.set(cod, { codFilial: cod, label: t.filial, qtdTitulos: 0, saldoTotal: 0 });
      }
      const f = filialMap.get(cod);
      f.qtdTitulos += 1;
      f.saldoTotal += t.saldoInadimplente;
    }
    const filiaisDisponiveis = Array.from(filialMap.values()).sort((a, b) => a.codFilial.localeCompare(b.codFilial));

    if (filiaisFiltro.length) {
      const setFil = new Set(filiaisFiltro);
      titulos = titulos.filter(t => setFil.has(t.codFilial) || setFil.has(t.filial));
    }
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
      fonte: competencia
        ? 'farol.inadimplencia_fechamento (SE1010 congelada)'
        : 'stage_protheus.se1010 + comercial.fato_itens_vendas',
      escopo,
      consultadoEm: new Date().toISOString(),
      ...meta,
      filiaisDisponiveis,
      resumoExecutivo,
      topClientes,
      titulos
    });
  } catch (error) {
    console.error('Falha ao consultar inadimplência:', error);
    return res.status(500).json({ ok: false, error: 'Não foi possível consultar a inadimplência no DW agora.' });
  }
}
