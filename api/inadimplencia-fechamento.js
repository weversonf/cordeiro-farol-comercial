import { getPool, toNumber } from './_db.js';
import { requireAdminMaster } from './_auth.js';
import { INAD_RULES_VERSION, parseRegras, REGRAS_PADRAO } from './_inad_rules.js';
import { queryInadimplencia } from './_inad_query.js';

const MIGRATION_SQL = `CREATE SCHEMA IF NOT EXISTS farol;
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

function hojeBrIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function ultimoDiaDoMes(competencia) {
  const [ano, mes] = competencia.split('-').map(Number);
  const ultimo = new Date(Date.UTC(ano, mes, 0));
  return ultimo.toISOString().slice(0, 10);
}

function competenciaDe(isoDate) {
  return isoDate.slice(0, 7);
}

function mesAnterior(competencia) {
  const [ano, mes] = competencia.split('-').map(Number);
  const d = new Date(Date.UTC(ano, mes - 2, 1));
  return d.toISOString().slice(0, 7);
}

function tabelaAusente(error) {
  return ['42P01', '3F000', '42501'].includes(String(error?.code || ''));
}

function respostaIndisponivel(res, extra = {}) {
  return res.status(503).json({
    ok: false,
    disponivel: false,
    motivo: 'O fechamento mensal ainda não está habilitado no DW. É necessário criar as tabelas e liberar o GRANT.',
    sqlLiberacao: MIGRATION_SQL,
    ...extra
  });
}

async function gerarFechamento(pool, { competencia, origem, usuario, forcar, regras }) {
  const dataRef = ultimoDiaDoMes(competencia);
  const { titulos, impacto } = await queryInadimplencia(pool, {
    filiais: null,
    corte: dataRef,
    regras
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existente = await client.query(
      'SELECT id, origem FROM farol.inadimplencia_fechamento WHERE competencia = $1 FOR UPDATE',
      [competencia]
    );

    if (existente.rows.length && !forcar) {
      await client.query('ROLLBACK');
      return {
        conflito: true,
        fechamento: {
          competencia,
          origem: existente.rows[0].origem,
          id: existente.rows[0].id
        }
      };
    }

    if (existente.rows.length) {
      await client.query('DELETE FROM farol.inadimplencia_fechamento_titulo WHERE fechamento_id = $1', [existente.rows[0].id]);
      await client.query('DELETE FROM farol.inadimplencia_fechamento WHERE id = $1', [existente.rows[0].id]);
    }

    const saldoTotal = titulos.reduce((acc, t) => acc + toNumber(t.saldo_inadimplente), 0);
    const valorTotal = titulos.reduce((acc, t) => acc + toNumber(t.valor_original), 0);

    const header = await client.query(
      `INSERT INTO farol.inadimplencia_fechamento
        (competencia, data_ref, gerado_por, origem, regras_versao, regras,
         qtd_titulos, saldo_total, valor_total, impacto, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        competencia,
        dataRef,
        usuario,
        origem,
        INAD_RULES_VERSION,
        regras,
        titulos.length,
        saldoTotal.toFixed(2),
        valorTotal.toFixed(2),
        JSON.stringify(impacto),
        origem === 'cron_fallback'
          ? 'Captura de segurança executada no primeiro dia do mês: pode incluir movimentos do dia 1.'
          : null
      ]
    );
    const fechamentoId = header.rows[0].id;

    const cols = [
      'cod_filial', 'serie', 'titulo', 'parcela', 'tipo', 'loja', 'cod_cliente',
      'nome_cliente', 'natureza', 'cod_vendedor', 'executivo', 'margem', 'contrato',
      'faixa', 'emissao', 'vencimento_real', 'valor_original', 'saldo'
    ];
    const chunk = 500;
    for (let i = 0; i < titulos.length; i += chunk) {
      const lote = titulos.slice(i, i + chunk);
      const values = [];
      const params = [];
      let p = 1;
      for (const t of lote) {
        values.push(`($${p++},${cols.map(() => `$${p++}`).join(',')})`);
        params.push(
          fechamentoId,
          t.cod_filial, t.serie, t.titulo, t.parcela, t.tipo, t.loja, t.cod_cliente,
          t.cliente, t.natureza, t.cod_vendedor || null, t.executivo, t.margem, t.contrato,
          t.faixa, t.emissao || null, t.vencimento_real || null,
          toNumber(t.valor_original).toFixed(2), toNumber(t.saldo_inadimplente).toFixed(2)
        );
      }
      await client.query(
        `INSERT INTO farol.inadimplencia_fechamento_titulo (fechamento_id, ${cols.join(',')})
         VALUES ${values.join(',')}`,
        params
      );
    }

    await client.query('COMMIT');
    return {
      conflito: false,
      fechamento: {
        id: fechamentoId,
        competencia,
        dataRef,
        origem,
        regrasVersao: INAD_RULES_VERSION,
        qtdTitulos: titulos.length,
        saldoTotal
      }
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const pool = getPool();
  const modoCron = String(req.query?.modo || '').toLowerCase() === 'cron';

  if (modoCron) {
    const secret = process.env.CRON_SECRET;
    const auth = String(req.headers?.authorization || '');
    const autorizado = (secret && auth === `Bearer ${secret}`) || req.headers?.['x-vercel-cron'];
    if (!autorizado) {
      return res.status(401).json({ ok: false, error: 'Execução de cron não autorizada.' });
    }
  }

  if (req.method === 'GET') {
    if (!modoCron) {
      const user = await requireAdminMaster(req, res);
      if (!user) return;
    }
    try {
      const r = await pool.query(
        `SELECT competencia, data_ref, gerado_em, origem, regras_versao, regras,
                qtd_titulos, saldo_total, valor_total, impacto
         FROM farol.inadimplencia_fechamento
         ORDER BY competencia DESC
         LIMIT 24`
      );
      return res.status(200).json({
        ok: true,
        disponivel: true,
        regrasVersao: INAD_RULES_VERSION,
        fechamentos: r.rows.map(x => ({
          competencia: String(x.competencia).trim(),
          dataRef: x.data_ref,
          geradoEm: x.gerado_em,
          origem: x.origem,
          regrasVersao: x.regras_versao,
          regras: x.regras,
          qtdTitulos: Number(x.qtd_titulos),
          saldoTotal: toNumber(x.saldo_total),
          valorTotal: toNumber(x.valor_total),
          impacto: x.impacto || []
        }))
      });
    } catch (error) {
      if (tabelaAusente(error)) {
        return res.status(200).json({
          ok: true,
          disponivel: false,
          motivo: 'O fechamento mensal ainda não está habilitado no DW.',
          sqlLiberacao: MIGRATION_SQL,
          fechamentos: []
        });
      }
      console.error('Falha ao listar fechamentos:', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível listar os fechamentos.' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  let usuario = 'cron';
  if (!modoCron) {
    const user = await requireAdminMaster(req, res);
    if (!user) return;
    usuario = String(user.email || 'desconhecido');
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const hoje = hojeBrIso();
  const competenciaAtual = competenciaDe(hoje);
  let competencia = /^\d{4}-\d{2}$/.test(String(req.query?.competencia || body.competencia || ''))
    ? String(req.query?.competencia || body.competencia)
    : mesAnterior(competenciaAtual);
  let origem = modoCron ? 'cron_fechamento' : 'manual';

  if (modoCron) {
    const amanha = new Date(`${hoje}T12:00:00Z`);
    amanha.setUTCDate(amanha.getUTCDate() + 1);
    const ehUltimoDia = amanha.toISOString().slice(0, 10).slice(8, 10) === '01';
    if (ehUltimoDia) {
      competencia = competenciaAtual;
      origem = 'cron_fechamento';
    } else if (hoje.slice(8, 10) === '01') {
      competencia = mesAnterior(competenciaAtual);
      origem = 'cron_fallback';
    } else {
      return res.status(200).json({ ok: true, ignorado: true, motivo: 'Fora da janela de fechamento.' });
    }
  }

  if (competencia > competenciaAtual) {
    return res.status(400).json({ ok: false, error: 'Não é possível fechar uma competência futura.' });
  }

  const regras = parseRegras(body.regras) || REGRAS_PADRAO;
  const forcar = Boolean(body.forcar) || String(req.query?.forcar || '') === '1';

  try {
    const resultado = await gerarFechamento(pool, { competencia, origem, usuario, forcar, regras });
    if (resultado.conflito) {
      return res.status(409).json({
        ok: false,
        error: `A competência ${competencia} já está fechada. Reenvie com forcar=true para substituir.`,
        fechamento: resultado.fechamento
      });
    }
    return res.status(201).json({ ok: true, fechamento: resultado.fechamento });
  } catch (error) {
    if (tabelaAusente(error)) return respostaIndisponivel(res, { competencia });
    console.error('Falha ao gerar fechamento:', error);
    return res.status(500).json({ ok: false, error: 'Não foi possível gerar o fechamento mensal.' });
  }
}
