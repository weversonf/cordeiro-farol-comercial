import { getPool } from './_db.js';
import { requireAdminMaster } from './_auth.js';
import { FAT_RULES_VERSION } from './_fat_rules.js';
import { queryFaturamentoDetalhe, queryFaturamentoSd2 } from './_fat_query.js';

function isValidIsoDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(str || ''));
}

function hojeSaoPauloIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function inicioDoMes(isoDate) {
  return `${isoDate.slice(0, 7)}-01`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  const user = await requireAdminMaster(req, res);
  if (!user) return;

  const hoje = hojeSaoPauloIso();
  const startRaw = String(req.query?.startDate || inicioDoMes(hoje)).trim();
  const endRaw = String(req.query?.endDate || hoje).trim();
  const startDate = isValidIsoDate(startRaw) ? startRaw : inicioDoMes(hoje);
  const endDate = isValidIsoDate(endRaw) && endRaw >= startDate ? endRaw : startDate;

  const unidade = String(req.query?.unidade || '').trim();
  const executivo = String(req.query?.executivo || '').trim();
  const cliente = String(req.query?.cliente || '').trim();

  try {
    const pool = getPool();
    const detalhe = String(req.query?.detalhe || '') === '1';

    if (detalhe) {
      const linhas = await queryFaturamentoDetalhe(pool, { startDate, endDate, unidade, executivo, cliente });
      return res.status(200).json({
        ok: true,
        disponivel: true,
        fonte: 'stage_protheus.sd2010 (Protheus SD2)',
        regrasVersao: FAT_RULES_VERSION,
        consultadoEm: new Date().toISOString(),
        periodo: { startDate, endDate },
        parametros: { unidade: unidade || null, executivo: executivo || null, cliente: cliente || null },
        totalLinhas: linhas.length,
        linhas
      });
    }

    const dados = await queryFaturamentoSd2(pool, { startDate, endDate, unidade, executivo, cliente });

    return res.status(200).json({
      ok: true,
      disponivel: true,
      fonte: 'stage_protheus.sd2010 (Protheus SD2)',
      regrasVersao: FAT_RULES_VERSION,
      consultadoEm: new Date().toISOString(),
      periodo: { startDate, endDate },
      parametros: {
        unidade: unidade || null,
        executivo: executivo || null,
        cliente: cliente || null
      },
      ...dados
    });
  } catch (error) {
    console.error('Falha ao consultar faturamento SD2:', error);
    return res.status(500).json({
      ok: false,
      error: 'Não foi possível consultar o faturamento na SD2 agora.'
    });
  }
}
