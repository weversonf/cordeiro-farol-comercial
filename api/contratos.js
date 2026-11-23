import fs from 'node:fs';
import path from 'node:path';
import { requireAdminMaster } from './_auth.js';

const DATA_FILE = path.join(process.cwd(), 'data', 'contratos-planilha.json');

function classifyStatusPrazo(faltamDias) {
  if (faltamDias === null || faltamDias === undefined) return 'sem_data';
  if (faltamDias < 0) return 'vencido';
  if (faltamDias <= 30) return 'critico_30';
  if (faltamDias <= 90) return 'alerta_90';
  if (faltamDias <= 180) return 'atencao_180';
  return 'vigente';
}

function prazoOrderWeight(statusPrazo) {
  if (statusPrazo === 'critico_30') return 0;
  if (statusPrazo === 'alerta_90') return 1;
  if (statusPrazo === 'atencao_180') return 2;
  if (statusPrazo === 'vigente') return 3;
  if (statusPrazo === 'vencido') return 4;
  return 5;
}

function uniqueSorted(items) {
  return [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function getTodayIsoFortaleza() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Fortaleza',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function diffDaysIso(targetIso, baseIso) {
  if (!targetIso || !baseIso) return null;
  const t = Date.parse(`${targetIso}T00:00:00Z`);
  const b = Date.parse(`${baseIso}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(b)) return null;
  return Math.round((t - b) / 86400000);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  const user = await requireAdminMaster(req, res);
  if (!user) return;

  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const planilha = JSON.parse(raw);
    const hojeIso = getTodayIsoFortaleza();

    const contratos = (planilha.contratos || []).map(row => {
      const faltamDias = diffDaysIso(row.dataFim, hojeIso);
      const vigenciaDias = diffDaysIso(row.dataFim, row.dataInicio);
      const statusPrazo = classifyStatusPrazo(faltamDias);
      const contratoAssinado = row.contratoAssinado || null;
      const assinaturaPendente =
        contratoAssinado !== null &&
        ['não', 'nao'].includes(String(contratoAssinado).trim().toLowerCase());

      return {
        id: row.id,
        titulo: row.titulo,
        cliente: row.cliente,
        consultor: row.consultor,
        unidade: row.unidade,
        tipoContrato: row.tipoContrato || 'Não informado',
        contratoAssinado,
        indiceReajuste: row.indiceReajuste || null,
        aditivoPdf: null,
        stageId: null,
        etapa: row.etapa || 'Em andamento',
        equipamentos: row.equipamentos || '',
        valor: Number(row.valor || 0),
        dataInicio: row.dataInicio || null,
        dataFim: row.dataFim || null,
        faltamDias,
        vigenciaDias,
        statusPrazo,
        assinaturaPendente,
        dataAtualizacao: planilha.importadoEm || null,
        bitrixUrl: null
      };
    });

    contratos.sort((a, b) => {
      const wA = prazoOrderWeight(a.statusPrazo);
      const wB = prazoOrderWeight(b.statusPrazo);
      if (wA !== wB) return wA - wB;
      if (a.faltamDias !== null && b.faltamDias !== null && a.faltamDias !== b.faltamDias) {
        return a.faltamDias - b.faltamDias;
      }
      if (a.faltamDias !== null && b.faltamDias === null) return -1;
      if (a.faltamDias === null && b.faltamDias !== null) return 1;
      return String(a.cliente || '').localeCompare(String(b.cliente || ''), 'pt-BR');
    });

    const resumo = {
      total: contratos.length,
      valorTotal: 0,
      em180Dias: 0,
      valor180Dias: 0,
      critico30: 0,
      alerta90: 0,
      atencao180: 0,
      vigente: 0,
      vencido: 0,
      semData: 0,
      assinaturaPendente: 0
    };

    for (const item of contratos) {
      resumo.valorTotal += item.valor;
      if (item.assinaturaPendente) resumo.assinaturaPendente += 1;

      if (item.statusPrazo === 'critico_30') {
        resumo.critico30 += 1;
        resumo.em180Dias += 1;
        resumo.valor180Dias += item.valor;
      } else if (item.statusPrazo === 'alerta_90') {
        resumo.alerta90 += 1;
        resumo.em180Dias += 1;
        resumo.valor180Dias += item.valor;
      } else if (item.statusPrazo === 'atencao_180') {
        resumo.atencao180 += 1;
        resumo.em180Dias += 1;
        resumo.valor180Dias += item.valor;
      } else if (item.statusPrazo === 'vigente') {
        resumo.vigente += 1;
      } else if (item.statusPrazo === 'vencido') {
        resumo.vencido += 1;
      } else {
        resumo.semData += 1;
      }
    }

    const unidadesIndividuais = uniqueSorted(
      contratos.flatMap(c => String(c.unidade || '').split(',').map(part => part.trim()).filter(Boolean))
    );

    return res.status(200).json({
      ok: true,
      geradoEm: new Date().toISOString(),
      fonte: 'planilha_pgc_consolidada',
      camposNovosSincronizados: {},
      atualizacao: {
        planilha: planilha.dataReferenciaPlanilha || null,
        importadoEm: planilha.importadoEm || null
      },
      resumo,
      filtros: {
        unidades: unidadesIndividuais,
        consultores: uniqueSorted(contratos.map(c => c.consultor)),
        etapas: uniqueSorted(contratos.map(c => c.etapa)),
        tipos: uniqueSorted(contratos.map(c => c.tipoContrato))
      },
      contratos
    });
  } catch (error) {
    console.error('Falha ao carregar contratos da planilha:', error);
    return res.status(500).json({ ok: false, error: 'Não foi possível carregar os contratos da planilha agora.' });
  }
}
