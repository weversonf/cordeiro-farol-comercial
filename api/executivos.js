import fs from 'node:fs';
import path from 'node:path';
import { getPool, toNumber } from './_db.js';
import { isAdminMasterEmail, requireAdminMaster } from './_auth.js';
import { buildBillingBaseCte, mapIndicadorUnitName } from './_dw.js';

const EXECUTIVOS_CATALOGO = [
  {
    cod: '000056',
    crmId: '5423',
    nome: 'Cristiano Assis',
    unidadeRef: 'Norte',
    unidadesPermitidas: ['NORTE'],
    cor: '#38BDF8',
    emailPrefixes: ['cristiano.assis'],
    match: ['CRISTIANO']
  },
  {
    cod: '000036',
    crmId: '1670',
    nome: 'Bruno Pessoa',
    unidadeRef: 'Wind',
    unidadesPermitidas: ['WIND'],
    cor: '#2563EB',
    emailPrefixes: ['bruno.pessoa'],
    match: ['BRUNO']
  },
  {
    cod: '000057',
    crmId: '15299',
    nome: 'Fernando Oliveira',
    unidadeRef: 'Complexo + Pecém (50%)',
    unidadesPermitidas: ['PECEM', 'COMPLEXO'],
    cor: '#F59E0B',
    emailPrefixes: ['fernando.oliveira'],
    match: ['FERNANDO']
  },
  {
    cod: '000058',
    crmId: '15257',
    nome: 'Fabrício Medeiros',
    unidadeRef: 'Complexo + Pecém (50%)',
    unidadesPermitidas: ['PECEM', 'COMPLEXO'],
    cor: '#10B981',
    emailPrefixes: ['fabricio.medeiros'],
    match: ['FABRICIO', 'FABRÍCIO']
  },
  {
    cod: '0050',
    crmId: '7379',
    nome: 'Cristiane Lúcio',
    unidadeRef: 'Spot / Inbound',
    unidadesPermitidas: ['SPOT'],
    cor: '#EC4899',
    emailPrefixes: ['cristiane.lucio'],
    match: ['CRISTIANE']
  },
  {
    cod: '000054',
    crmId: '14149',
    nome: 'Thiago do Nascimento',
    unidadeRef: 'Spot / Pecém',
    unidadesPermitidas: ['PECEM', 'SPOT'],
    cor: '#6366F1',
    emailPrefixes: ['thiago.nascimento'],
    match: ['THIAGO']
  },
  {
    cod: '059',
    crmId: '15413',
    nome: 'Marcio Funghi',
    unidadeRef: 'Head Comercial',
    unidadesPermitidas: [],
    cor: '#A855F7',
    emailPrefixes: ['marcio.funghi'],
    match: ['MARCIO', 'MÁRCIO']
  }
];

const UF_DATA_CONTATO = 'ufCrm139_1747310182';
const UF_RANKING_SPA = 'ufCrm139_1747309983';
const UF_MEIO_CONTATO = 'ufCrm139_1747312303';
const UF_RANKING_EMPRESA = 'UF_CRM_1722348669945';
const RANKING_AB_SPA = new Set(['11115', '11117']);
const RANKING_AB_EMPRESA = new Set(['10233', '10235']);

function normText(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeClientKey(raw) {
  return normText(raw)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(LTDA|S\/A|SA|S\.A\.|EIRELI|ME|EPP|FILIAL|MATRIZ|DO BRASIL|BRASIL)\b/g, ' ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findExecByEmail(email) {
  const clean = String(email || '').trim().toLowerCase();
  const [localPart, domain] = clean.split('@');
  if (!localPart || !domain || !domain.startsWith('cordeiroguindastes.com')) return null;
  return EXECUTIVOS_CATALOGO.find(e => e.emailPrefixes.includes(localPart)) || null;
}

function findExecByName(name) {
  const n = normText(name);
  if (!n) return null;
  return EXECUTIVOS_CATALOGO.find(e => e.match.some(m => n.includes(normText(m)))) || null;
}

function readJsonSafe(relPath, fallback) {
  try {
    const pCwd = path.join(process.cwd(), ...relPath);
    if (fs.existsSync(pCwd)) return JSON.parse(fs.readFileSync(pCwd, 'utf8'));
    const fileUrl = new URL(`../${relPath.join('/')}`, import.meta.url);
    if (fs.existsSync(fileUrl)) return JSON.parse(fs.readFileSync(fileUrl, 'utf8'));
  } catch {
    // Fallback abaixo
  }
  return fallback;
}

async function bitrixCall(hook, metodo, parametros = {}) {
  const res = await fetch(`${hook}/${metodo}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parametros),
    signal: AbortSignal.timeout(20000)
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(json.error_description || json.error || `Bitrix HTTP ${res.status}`);
  }
  return json.result;
}

async function bitrixPaginar(hook, metodo, parametros, selecionar, maxPages = 80) {
  const registros = [];
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const start = page * 50;
    const resultado = await bitrixCall(hook, metodo, { ...parametros, start });
    const pagina = selecionar(resultado) || [];
    const novos = pagina.filter(item => {
      const key = String(item?.ID ?? item?.id ?? '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!novos.length) break;
    registros.push(...novos);
    if (pagina.length < 50) break;
  }
  return registros;
}

async function consultarCoberturaAoVivo(hook, year, month, targetExecs) {
  const inicio = `${year}-${String(month).padStart(2, '0')}-01`;
  const fim = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const crmIds = targetExecs.map(e => e.crmId).filter(Boolean);

  const [fieldsRes, itens, empresas] = await Promise.all([
    bitrixCall(hook, 'crm.item.fields', { entityTypeId: 1100 }),
    bitrixPaginar(
      hook,
      'crm.item.list',
      {
        entityTypeId: 1100,
        order: { id: 'DESC' },
        filter: crmIds.length === 1 ? { assignedById: crmIds[0] } : {}
      },
      r => r?.items || []
    ),
    bitrixPaginar(
      hook,
      'crm.company.list',
      {
        order: { ID: 'ASC' },
        filter: { ASSIGNED_BY_ID: crmIds },
        select: ['ID', 'TITLE', 'ASSIGNED_BY_ID', 'COMPANY_TYPE', UF_RANKING_EMPRESA]
      },
      r => (Array.isArray(r) ? r : [])
    )
  ]);

  const meioEnums = {};
  const spaFields = fieldsRes?.fields || {};
  for (const item of spaFields[UF_MEIO_CONTATO]?.items || []) {
    meioEnums[String(item.ID)] = String(item.VALUE || '');
  }

  const empresaPorId = new Map(empresas.map(e => [String(e.ID), e]));
  const porCrmId = new Map();
  for (const ex of targetExecs) {
    porCrmId.set(ex.crmId, {
      codVendedor: ex.cod,
      crmId: ex.crmId,
      executivo: ex.nome,
      carteiraAB: 0,
      carteiraA: 0,
      carteiraB: 0,
      cobertosDistintosAB: 0,
      cobertosA: 0,
      cobertosB: 0,
      contatosValidosAB: 0,
      divergenciasRanking: 0,
      semRankingSpa: 0,
      percentual: 0,
      empresasMap: new Map()
    });
  }

  for (const emp of empresas) {
    const bucket = porCrmId.get(String(emp.ASSIGNED_BY_ID || ''));
    const rCode = String(emp[UF_RANKING_EMPRESA] || '');
    if (!bucket || !RANKING_AB_EMPRESA.has(rCode)) continue;
    const ranking = rCode === '10235' ? 'A' : 'B';
    bucket.carteiraAB += 1;
    if (ranking === 'A') bucket.carteiraA += 1;
    else bucket.carteiraB += 1;
    bucket.empresasMap.set(String(emp.ID), {
      companyId: String(emp.ID),
      cliente: String(emp.TITLE || `Empresa ${emp.ID}`).trim(),
      segmento: String(emp.COMPANY_TYPE || '—').trim() || '—',
      ranking,
      coberto: false,
      status: 'Pendente',
      meioContato: null,
      dataContato: null,
      contatosNoMes: 0,
      observacao: null
    });
  }

  for (const item of itens) {
    const bucket = porCrmId.get(String(item.assignedById || ''));
    if (!bucket) continue;
    const dataContato = String(item[UF_DATA_CONTATO] || '').slice(0, 10);
    if (!dataContato || dataContato < inicio || dataContato >= fim) continue;

    const rSpa = String(item[UF_RANKING_SPA] || '');
    if (!rSpa) {
      bucket.semRankingSpa += 1;
      continue;
    }
    if (!RANKING_AB_SPA.has(rSpa)) continue;

    const cid = String(item.companyId || '');
    const cliEntry = bucket.empresasMap.get(cid);
    if (!cliEntry) {
      bucket.divergenciasRanking += 1;
      continue;
    }

    bucket.contatosValidosAB += 1;
    cliEntry.contatosNoMes += 1;
    if (!cliEntry.coberto) {
      cliEntry.coberto = true;
      cliEntry.status = 'Cobertura Feita';
      bucket.cobertosDistintosAB += 1;
      if (cliEntry.ranking === 'A') bucket.cobertosA += 1;
      else bucket.cobertosB += 1;
    }
    if (!cliEntry.dataContato || dataContato >= cliEntry.dataContato) {
      cliEntry.dataContato = dataContato;
      const meioRaw = item[UF_MEIO_CONTATO];
      cliEntry.meioContato = meioEnums[String(meioRaw)] || (meioRaw ? String(meioRaw) : null);
    }
  }

  const out = {};
  for (const b of porCrmId.values()) {
    const clientes = Array.from(b.empresasMap.values()).sort((a, c) => {
      if (a.coberto !== c.coberto) return a.coberto ? 1 : -1;
      if (a.ranking !== c.ranking) return a.ranking.localeCompare(c.ranking);
      return a.cliente.localeCompare(c.cliente, 'pt-BR');
    });
    out[b.codVendedor] = {
      codVendedor: b.codVendedor,
      crmId: b.crmId,
      executivo: b.executivo,
      carteiraAB: b.carteiraAB,
      carteiraA: b.carteiraA,
      carteiraB: b.carteiraB,
      cobertosDistintosAB: b.cobertosDistintosAB,
      cobertosA: b.cobertosA,
      cobertosB: b.cobertosB,
      contatosValidosAB: b.contatosValidosAB,
      divergenciasRanking: b.divergenciasRanking,
      semRankingSpa: b.semRankingSpa,
      percentual: b.carteiraAB > 0 ? Number(((b.cobertosDistintosAB / b.carteiraAB) * 100).toFixed(2)) : 0,
      clientes
    };
  }
  return out;
}

async function obterCoberturaCarteira(year, month, mesRefIso, targetExecs) {
  const hook = String(process.env.BITRIX_HOOK || '').replace(/\/+$/, '');
  const hookValido = /^https:\/\/grupocordeiro\.bitrix24\.com\.br\/rest\/\d+\/[A-Za-z0-9]+$/.test(hook);

  if (hookValido) {
    try {
      const execMap = await consultarCoberturaAoVivo(hook, year, month, targetExecs);
      return {
        disponivel: true,
        aoVivo: true,
        competencia: mesRefIso,
        fonte: 'Bitrix24 SPA 1100 + Empresas (Ao vivo)',
        observacao: 'Clientes únicos A/B contatados no SPA 1100 no mês ÷ carteira A/B atribuída ao executivo.',
        porExecutivo: execMap
      };
    } catch (err) {
      console.warn('Falha ao consultar Bitrix SPA 1100 ao vivo; tentando snapshot:', err.message);
    }
  }

  const snapshot = readJsonSafe(['data', 'cobertura-carteira-snapshot.json'], { competencias: {} });
  const compData = snapshot.competencias?.[mesRefIso];
  if (compData && compData.executivos) {
    return {
      disponivel: true,
      aoVivo: false,
      competencia: mesRefIso,
      fonte: `Snapshot (${compData.rotulo || compData.fonte || 'Planilha Premiação'})`,
      observacao: hookValido
        ? 'Consulta ao vivo Bitrix falhou temporariamente; exibindo snapshot salvo.'
        : 'Para atualização em tempo real do SPA 1100, configure a variável BITRIX_HOOK na Vercel / .env.local.',
      porExecutivo: compData.executivos
    };
  }

  return {
    disponivel: false,
    aoVivo: false,
    competencia: mesRefIso,
    fonte: 'Sem carga para a competência',
    observacao: 'Sem snapshot salvo para esta competência e variável BITRIX_HOOK não configurada.',
    porExecutivo: {}
  };
}

function normUnitKey(raw) {
  const n = normText(raw);
  if (n.includes('WIND')) return 'WIND';
  if (n.includes('NORTE')) return 'NORTE';
  if (n.includes('PECEM')) return 'PECEM';
  if (n.includes('COMPLEXO') || n.includes('CENTRO LOGISTICO') || n.includes('CLCP')) return 'COMPLEXO';
  return n || 'OUTRA';
}

function execAcceptsUnit(cod, unitKey, modalidade) {
  const ex = EXECUTIVOS_CATALOGO.find(e => e.cod === cod);
  if (!ex) return false;
  if (ex.unidadesPermitidas.includes(unitKey)) return true;
  if (String(modalidade || '').toLowerCase() === 'spot' && ex.unidadesPermitidas.includes('SPOT')) return true;
  return false;
}

function buildClienteExecLookup(sd2ClientExecRows, contratosPlanilha) {
  const lookup = new Map();

  for (const r of sd2ClientExecRows || []) {
    const key = normalizeClientKey(r.cliente);
    const uKey = normUnitKey(r.unidade);
    const cod = String(r.cod_vendedor || '').trim();
    if (!key || !cod || !execAcceptsUnit(cod, uKey, '')) continue;
    const mapKey = `${uKey}|||${key}`;
    if (!lookup.has(mapKey)) lookup.set(mapKey, cod);
  }

  for (const c of contratosPlanilha?.contratos || []) {
    const key = normalizeClientKey(c.cliente);
    const uKey = normUnitKey(c.unidade);
    const ex = findExecByName(c.consultor);
    if (key && ex && execAcceptsUnit(ex.cod, uKey, c.tipoContrato)) {
      const mapKey = `${uKey}|||${key}`;
      if (!lookup.has(mapKey)) lookup.set(mapKey, ex.cod);
    }
  }
  return lookup;
}

function matchClientExec(clienteRaw, unidadeRaw, modalidade, lookup) {
  const key = normalizeClientKey(clienteRaw);
  const uKey = normUnitKey(unidadeRaw);
  if (!key) return null;
  const exactKey = `${uKey}|||${key}`;
  if (lookup.has(exactKey)) {
    const cod = lookup.get(exactKey);
    if (execAcceptsUnit(cod, uKey, modalidade)) return cod;
  }

  const tokens = key.split(' ').filter(t => t.length >= 3);
  if (!tokens.length) return null;
  const firstToken = tokens[0];
  const twoTokens = tokens.slice(0, 2).join(' ');

  for (const [kFull, cod] of lookup.entries()) {
    const [kUnit, kCli] = kFull.split('|||');
    if (kUnit !== uKey) continue;
    if (!execAcceptsUnit(cod, uKey, modalidade)) continue;
    if (twoTokens.length >= 6 && kCli.includes(twoTokens)) return cod;
    if (firstToken.length >= 4 && kCli.startsWith(firstToken)) return cod;
  }
  return null;
}

function atribuirMedicoesPorExecutivo(medicoesAll, mesRefIso, clientLookup) {
  const medMes = medicoesAll.filter(x => x.competencia === mesRefIso);
  const compUsada = medMes.length
    ? mesRefIso
    : (medicoesAll.map(x => x.competencia).filter(Boolean).sort().pop() || mesRefIso);
  const itensBase = medMes.length ? medMes : medicoesAll.filter(x => x.competencia === compUsada);

  const porExec = {};
  const addItem = (cod, item, rateioPct, origemVinculo) => {
    if (!porExec[cod]) {
      porExec[cod] = {
        valorTotal: 0,
        qtdItens: 0,
        valorContrato: 0,
        valorSpot: 0,
        valorAguardandoPedido: 0,
        qtdAguardandoPedido: 0,
        itens: []
      };
    }
    const valOrig = toNumber(item.valor);
    const valAtrib = Number((valOrig * (rateioPct / 100)).toFixed(2));
    const bucket = porExec[cod];
    bucket.valorTotal += valAtrib;
    bucket.qtdItens += 1;
    if (String(item.modalidade || '').toLowerCase() === 'spot') bucket.valorSpot += valAtrib;
    else bucket.valorContrato += valAtrib;
    if (item.aguardandoPedido) {
      bucket.valorAguardandoPedido += valAtrib;
      bucket.qtdAguardandoPedido += 1;
    }
    bucket.itens.push({
      competencia: item.competencia,
      modalidade: item.modalidade || 'Contrato',
      cliente: item.cliente,
      unidade: item.unidade || '—',
      aguardandoPedido: Boolean(item.aguardandoPedido),
      valorOriginal: valOrig,
      valorAtribuido: valAtrib,
      percentualRateio: rateioPct,
      origemVinculo,
      observacao: item.observacao || ''
    });
  };

  for (const item of itensBase) {
    // 1. Executivo ou cod_vendedor explícito na planilha RMR
    if (item.codVendedor) {
      addItem(String(item.codVendedor).trim(), item, 100, 'Planilha RMR (Executivo)');
      continue;
    }
    if (item.executivo) {
      const exExplicit = findExecByName(item.executivo);
      if (exExplicit) {
        addItem(exExplicit.cod, item, 100, 'Planilha RMR (Executivo)');
        continue;
      }
    }

    // 2. Vínculo por cliente dentro da mesma unidade (SD2 / Contratos)
    const matchedCod = matchClientExec(item.cliente, item.unidade, item.modalidade, clientLookup);
    if (matchedCod && EXECUTIVOS_CATALOGO.some(e => e.cod === matchedCod)) {
      addItem(matchedCod, item, 100, 'Vínculo Cliente (SD2/Contratos)');
      continue;
    }

    // 3. Fallback por unidade comercial
    const un = normText(item.unidade);
    if (un.includes('WIND')) {
      addItem('000036', item, 100, 'Unidade Wind (100%)');
    } else if (un.includes('NORTE')) {
      addItem('000056', item, 100, 'Unidade Norte (100%)');
    } else if (un.includes('PECEM') || un.includes('COMPLEXO')) {
      addItem('000057', item, 50, 'Rateio Unidade (50%)');
      addItem('000058', item, 50, 'Rateio Unidade (50%)');
    }
  }

  for (const b of Object.values(porExec)) {
    b.itens.sort((a, c) => c.valorAtribuido - a.valorAtribuido);
  }

  return {
    competenciaExibida: compUsada,
    mesSolicitado: mesRefIso,
    divergente: Boolean(compUsada && compUsada !== mesRefIso),
    totalGeral: itensBase.reduce((s, x) => s + toNumber(x.valor), 0),
    qtdGeral: itensBase.length,
    porExecutivo: porExec
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  const user = await requireAdminMaster(req, res, { allowExecutivo: true });
  if (!user) return;

  const userEmail = String(user.email || '').trim().toLowerCase();
  const isMaster = isAdminMasterEmail(userEmail);
  const loggedExec = findExecByEmail(userEmail);

  if (!isMaster && !loggedExec) {
    return res.status(403).json({
      ok: false,
      error: 'Seu e-mail corporativo não está vinculado a um perfil de executivo neste painel.'
    });
  }

  const nowBr = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const curY = nowBr.getUTCFullYear();
  const curM = nowBr.getUTCMonth() + 1;

  const reqY = Number(req.query?.year);
  const reqM = Number(req.query?.month);
  const year = Number.isInteger(reqY) && reqY >= 2024 && reqY <= curY + 1 ? reqY : curY;
  const month = Number.isInteger(reqM) && reqM >= 1 && reqM <= 12 ? reqM : curM;
  const mesRefIso = `${year}-${String(month).padStart(2, '0')}`;
  const startDate = `${year}-01-01`;
  const endDate = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  const targetExecs = isMaster ? EXECUTIVOS_CATALOGO : [loggedExec];
  const targetCodes = targetExecs.map(e => e.cod);

  const reqExec = String(req.query?.executivo || (isMaster ? 'ALL' : loggedExec.cod)).trim();
  const selectedExec = isMaster
    ? (reqExec === 'ALL' || targetCodes.includes(reqExec) ? reqExec : 'ALL')
    : loggedExec.cod;

  try {
    const pool = getPool();
    const baseOficial = readJsonSafe(['data', 'rmr-base-oficial.json'], {
      metasExecutivos: [],
      unidadesRmr: [],
      medicoesPendentes: []
    });
    const contratosPlanilha = readJsonSafe(['data', 'contratos-planilha.json'], { contratos: [] });

    const [
      metasDwRes,
      metasUnidRes,
      fatMensalRes,
      fatClientesRes,
      clientExecMapRes,
      freshnessRes,
      coberturaData
    ] = await Promise.all([
      pool.query(`
        SELECT
          TRIM(COALESCE(cod_vendedor::text, '')) AS cod_vendedor,
          MAX(COALESCE(valor_alvo, 0))::numeric AS meta_ano
        FROM comercial.dim_meta_vendedores
        WHERE EXTRACT(YEAR FROM data_referencia)::int = $1
          AND UPPER(COALESCE(descricao, '')) NOT LIKE '%NPS%'
        GROUP BY 1
      `, [year]),

      pool.query(`
        SELECT
          TRIM(zi0_unidad) AS zi0_unidad,
          LPAD(TRIM(zi1_mes), 2, '0') AS mes_num,
          COALESCE(MAX(zi1_vlmalv), 0)::numeric AS meta_alvo
        FROM comercial.indicador_unidade
        WHERE zi0_ano = $1
          AND zi0_metric = '000001'
          AND zi0_status = 'A'
        GROUP BY 1, 2
      `, [String(year)]),

      pool.query(`
        ${buildBillingBaseCte({ startParam: '$1', endParam: '$2', escopo: 'pbix' })},
        fat_norm AS (
          SELECT
            CASE
              WHEN COALESCE(NULLIF(TRIM(cod_vendedor), ''), '000016') IN ('000016', 'SEM_COD') AND unidade = 'Norte' THEN '000056'
              ELSE COALESCE(NULLIF(TRIM(cod_vendedor), ''), 'SEM_COD')
            END AS cod_vendedor,
            mes_iso,
            cod_filial,
            numero_documento,
            serie,
            cod_cliente,
            valor_total
          FROM faturamento_base
          WHERE NOT is_expurgo
        )
        SELECT
          cod_vendedor,
          mes_iso,
          COUNT(DISTINCT (cod_filial || '-' || numero_documento || '-' || serie))::int AS qtd_nfs,
          COUNT(DISTINCT cod_cliente)::int AS qtd_clientes,
          COALESCE(SUM(valor_total), 0)::numeric AS valor
        FROM fat_norm
        WHERE cod_vendedor = ANY($3)
        GROUP BY 1, 2
        ORDER BY 1, 2
      `, [startDate, endDate, targetCodes]),

      pool.query(`
        ${buildBillingBaseCte({ startParam: '$1', endParam: '$2', escopo: 'pbix' })},
        fat_norm AS (
          SELECT
            CASE
              WHEN COALESCE(NULLIF(TRIM(cod_vendedor), ''), '000016') IN ('000016', 'SEM_COD') AND unidade = 'Norte' THEN '000056'
              ELSE COALESCE(NULLIF(TRIM(cod_vendedor), ''), 'SEM_COD')
            END AS cod_vendedor,
            mes_iso,
            cod_filial,
            numero_documento,
            serie,
            cliente,
            COALESCE(NULLIF(TRIM(numero_contrato), ''), 'SEM_CONTRATO') AS numero_contrato,
            unidade,
            valor_total
          FROM faturamento_base
          WHERE NOT is_expurgo
        )
        SELECT
          cod_vendedor,
          cliente,
          numero_contrato,
          MODE() WITHIN GROUP (ORDER BY unidade) AS unidade,
          COUNT(DISTINCT CASE WHEN mes_iso = $3 THEN (cod_filial || '-' || numero_documento || '-' || serie) END)::int AS qtd_nfs_mes,
          COUNT(DISTINCT (cod_filial || '-' || numero_documento || '-' || serie))::int AS qtd_nfs_ytd,
          COALESCE(SUM(CASE WHEN mes_iso = $3 THEN valor_total ELSE 0 END), 0)::numeric AS valor_mes,
          COALESCE(SUM(valor_total), 0)::numeric AS valor_ytd
        FROM fat_norm
        WHERE cod_vendedor = ANY($4)
        GROUP BY 1, 2, 3
        ORDER BY valor_ytd DESC, valor_mes DESC
      `, [startDate, endDate, mesRefIso, targetCodes]),

      pool.query(`
        ${buildBillingBaseCte({ startParam: '$1', endParam: '$2', escopo: 'pbix' })},
        fat_norm AS (
          SELECT
            CASE
              WHEN COALESCE(NULLIF(TRIM(cod_vendedor), ''), '000016') IN ('000016', 'SEM_COD') AND unidade = 'Norte' THEN '000056'
              ELSE COALESCE(NULLIF(TRIM(cod_vendedor), ''), 'SEM_COD')
            END AS cod_vendedor,
            cliente,
            unidade,
            valor_total
          FROM faturamento_base
          WHERE NOT is_expurgo
        )
        SELECT
          cliente,
          unidade,
          cod_vendedor,
          COALESCE(SUM(valor_total), 0)::numeric AS total_ytd
        FROM fat_norm
        WHERE cod_vendedor = ANY($3)
        GROUP BY 1, 2, 3
        ORDER BY total_ytd DESC
      `, [startDate, endDate, EXECUTIVOS_CATALOGO.map(e => e.cod)]),

      pool.query(`
        SELECT
          (SELECT MAX(TO_DATE(TRIM(d2_emissao::text), 'YYYYMMDD')) FROM stage_protheus.sd2010 WHERE COALESCE(TRIM(d_e_l_e_t_), '') <> '*' AND TRIM(COALESCE(d2_emissao::text, '')) ~ '^\\d{8}$') AS max_emissao_protheus,
          (SELECT MAX("DATE_MODIFY") FROM stage_bitrix.b_crm_deal) AS max_modify_bitrix
      `),

      obterCoberturaCarteira(year, month, mesRefIso, targetExecs)
    ]);

    // 1. Metas por executivo (Planilha RMR + DW fallback + regra Norte 000056)
    const metasDwMap = Object.fromEntries(
      metasDwRes.rows.map(r => [r.cod_vendedor, toNumber(r.meta_ano)])
    );
    const norteUnidMesMap = {};
    let metaUnidadeAnualNorte = 0;
    for (const r of metasUnidRes.rows) {
      if (mapIndicadorUnitName(r.zi0_unidad) === 'Norte') {
        const val = toNumber(r.meta_alvo);
        norteUnidMesMap[Number(r.mes_num)] = val;
        metaUnidadeAnualNorte += val;
      }
    }

    const planMesExecMap = {};
    for (const r of baseOficial.metasExecutivos || []) {
      if (Number(r.ano) !== year) continue;
      const cod = String(r.codVendedor || '').trim();
      if (!cod) continue;
      if (!planMesExecMap[cod]) planMesExecMap[cod] = {};
      planMesExecMap[cod][Number(r.mes)] = toNumber(r.metaMensal);
    }

    // 2. Faturamento mensal & clientes por executivo
    const fatMesExecMap = {};
    for (const r of fatMensalRes.rows) {
      const cod = r.cod_vendedor;
      if (!fatMesExecMap[cod]) fatMesExecMap[cod] = {};
      fatMesExecMap[cod][r.mes_iso] = {
        valor: toNumber(r.valor),
        qtdNfs: Number(r.qtd_nfs || 0),
        qtdClientes: Number(r.qtd_clientes || 0)
      };
    }

    const clientesFatExecMap = {};
    for (const r of fatClientesRes.rows) {
      const cod = r.cod_vendedor;
      if (!clientesFatExecMap[cod]) clientesFatExecMap[cod] = [];
      clientesFatExecMap[cod].push({
        cliente: r.cliente,
        numeroContrato: r.numero_contrato,
        unidade: r.unidade || '—',
        qtdNfsMes: Number(r.qtd_nfs_mes || 0),
        qtdNfsYtd: Number(r.qtd_nfs_ytd || 0),
        valorMes: toNumber(r.valor_mes),
        valorYtd: toNumber(r.valor_ytd)
      });
    }

    // 3. Medições pendentes atribuídas
    const clientLookup = buildClienteExecLookup(clientExecMapRes.rows, contratosPlanilha);
    const medicoesAtribuidas = atribuirMedicoesPorExecutivo(
      baseOficial.medicoesPendentes || [],
      mesRefIso,
      clientLookup
    );

    // 4. Montagem consolidada por executivo
    const executivosMontados = targetExecs.map(ex => {
      const cod = ex.cod;
      const metaAnualAlvo = cod === '000056' && metaUnidadeAnualNorte > 0
        ? metaUnidadeAnualNorte
        : (metasDwMap[cod] || 0);

      const serieMensal = [];
      let faturamentoYtd = 0;
      let metaYtd = 0;
      let qtdNfsYtd = 0;
      for (let m = 1; m <= 12; m++) {
        const mIso = `${year}-${String(m).padStart(2, '0')}`;
        const fatRow = fatMesExecMap[cod]?.[mIso];
        const fatVal = fatRow ? fatRow.valor : 0;
        const planMeta = planMesExecMap[cod]?.[m];
        let metaM = 0;
        if (planMeta !== undefined) {
          metaM = planMeta;
        } else if (cod === '000056' && norteUnidMesMap[m] > 0) {
          metaM = norteUnidMesMap[m];
        } else if (metaAnualAlvo > 0) {
          metaM = metaAnualAlvo / 12;
        }
        if (m <= month) {
          faturamentoYtd += fatVal;
          metaYtd += metaM;
          qtdNfsYtd += fatRow ? fatRow.qtdNfs : 0;
        }
        serieMensal.push({
          mes: m,
          mesIso: mIso,
          fechado: m <= month,
          realizado: fatVal,
          meta: Number(metaM.toFixed(2)),
          atingimentoPct: metaM > 0 && fatVal > 0 ? Number(((fatVal / metaM) * 100).toFixed(2)) : null,
          qtdNfs: fatRow ? fatRow.qtdNfs : 0,
          qtdClientes: fatRow ? fatRow.qtdClientes : 0
        });
      }

      const mesAtual = serieMensal[month - 1] || { realizado: 0, meta: 0, qtdNfs: 0, qtdClientes: 0 };
      const hasPlanMes = planMesExecMap[cod]?.[month] !== undefined;
      const medExec = medicoesAtribuidas.porExecutivo[cod] || {
        valorTotal: 0,
        qtdItens: 0,
        valorContrato: 0,
        valorSpot: 0,
        valorAguardandoPedido: 0,
        qtdAguardandoPedido: 0,
        itens: []
      };
      const cobExec = coberturaData.porExecutivo?.[cod] || {
        carteiraAB: 0,
        carteiraA: 0,
        carteiraB: 0,
        cobertosDistintosAB: 0,
        cobertosA: 0,
        cobertosB: 0,
        contatosValidosAB: 0,
        percentual: 0,
        clientes: []
      };

      const atingimentoMesPct = mesAtual.meta > 0 ? (mesAtual.realizado / mesAtual.meta) * 100 : null;
      const atingimentoYtdPct = metaYtd > 0 ? (faturamentoYtd / metaYtd) * 100 : null;
      const atingimentoAnualPct = metaAnualAlvo > 0 ? (faturamentoYtd / metaAnualAlvo) * 100 : null;

      return {
        codVendedor: cod,
        crmId: ex.crmId,
        executivo: ex.nome,
        unidadeRef: ex.unidadeRef,
        cor: ex.cor,
        faturamento: {
          mes: mesAtual.realizado,
          ytd: faturamentoYtd,
          qtdNfsMes: mesAtual.qtdNfs,
          qtdClientesMes: mesAtual.qtdClientes,
          qtdNfsYtd,
          serieMensal,
          topClientesContratos: (clientesFatExecMap[cod] || []).slice(0, 40)
        },
        meta: {
          mes: mesAtual.meta,
          ytd: metaYtd,
          anual: metaAnualAlvo,
          fonte: hasPlanMes ? 'Planilha RMR' : (cod === '000056' && norteUnidMesMap[month] > 0 ? 'DW Indicador Norte' : 'DW (Anual/12)'),
          atingimentoMesPct,
          atingimentoYtdPct,
          atingimentoAnualPct,
          gapMes: mesAtual.meta > 0 ? mesAtual.realizado - mesAtual.meta : null,
          gapYtd: metaYtd > 0 ? faturamentoYtd - metaYtd : null
        },
        medicoesPendentes: {
          valorTotal: medExec.valorTotal,
          qtdItens: medExec.qtdItens,
          valorContrato: medExec.valorContrato,
          valorSpot: medExec.valorSpot,
          valorAguardandoPedido: medExec.valorAguardandoPedido,
          qtdAguardandoPedido: medExec.qtdAguardandoPedido,
          itens: medExec.itens
        },
        coberturaCarteira: {
          carteiraAB: cobExec.carteiraAB || 0,
          carteiraA: cobExec.carteiraA || 0,
          carteiraB: cobExec.carteiraB || 0,
          cobertosDistintosAB: cobExec.cobertosDistintosAB || 0,
          cobertosA: cobExec.cobertosA || 0,
          cobertosB: cobExec.cobertosB || 0,
          contatosValidosAB: cobExec.contatosValidosAB || 0,
          pendentesAB: Math.max(0, (cobExec.carteiraAB || 0) - (cobExec.cobertosDistintosAB || 0)),
          percentual: Number(cobExec.percentual || 0),
          clientes: cobExec.clientes || []
        }
      };
    }).filter(ex => {
      if (!isMaster) return true;
      // Na visão comparativa do Master, mantém os executivos com operação/meta/carteira no recorte
      return ex.codVendedor !== '059' && (
        ex.faturamento.ytd > 0 ||
        ex.meta.anual > 0 ||
        ex.meta.mes > 0 ||
        ex.coberturaCarteira.carteiraAB > 0
      );
    });

    const comparativo = executivosMontados.map(ex => ({
      codVendedor: ex.codVendedor,
      executivo: ex.executivo,
      unidadeRef: ex.unidadeRef,
      cor: ex.cor,
      faturamentoMes: ex.faturamento.mes,
      faturamentoYtd: ex.faturamento.ytd,
      metaMes: ex.meta.mes,
      metaYtd: ex.meta.ytd,
      metaAnual: ex.meta.anual,
      atingimentoMesPct: ex.meta.atingimentoMesPct,
      atingimentoYtdPct: ex.meta.atingimentoYtdPct,
      medicoesValor: ex.medicoesPendentes.valorTotal,
      medicoesQtd: ex.medicoesPendentes.qtdItens,
      coberturaCarteiraAB: ex.coberturaCarteira.carteiraAB,
      coberturaCobertosAB: ex.coberturaCarteira.cobertosDistintosAB,
      coberturaPct: ex.coberturaCarteira.percentual
    })).sort((a, b) => b.faturamentoMes - a.faturamentoMes || b.faturamentoYtd - a.faturamentoYtd);

    const detalhe = selectedExec === 'ALL'
      ? null
      : (executivosMontados.find(e => e.codVendedor === selectedExec) || executivosMontados[0] || null);

    const resumoGeral = {
      faturamentoMes: comparativo.reduce((s, e) => s + e.faturamentoMes, 0),
      faturamentoYtd: comparativo.reduce((s, e) => s + e.faturamentoYtd, 0),
      metaMes: comparativo.reduce((s, e) => s + e.metaMes, 0),
      metaYtd: comparativo.reduce((s, e) => s + e.metaYtd, 0),
      medicoesValor: medicoesAtribuidas.totalGeral,
      medicoesQtd: medicoesAtribuidas.qtdGeral,
      coberturaCarteiraAB: comparativo.reduce((s, e) => s + e.coberturaCarteiraAB, 0),
      coberturaCobertosAB: comparativo.reduce((s, e) => s + e.coberturaCobertosAB, 0)
    };
    resumoGeral.atingimentoMesPct = resumoGeral.metaMes > 0 ? (resumoGeral.faturamentoMes / resumoGeral.metaMes) * 100 : null;
    resumoGeral.atingimentoYtdPct = resumoGeral.metaYtd > 0 ? (resumoGeral.faturamentoYtd / resumoGeral.metaYtd) * 100 : null;
    resumoGeral.coberturaPct = resumoGeral.coberturaCarteiraAB > 0
      ? Number(((resumoGeral.coberturaCobertosAB / resumoGeral.coberturaCarteiraAB) * 100).toFixed(2))
      : 0;

    const fresh = freshnessRes.rows[0] || {};

    return res.status(200).json({
      ok: true,
      geradoEm: new Date().toISOString(),
      parametros: { year, month, mesRefIso, selectedExec },
      acesso: {
        isMaster,
        travadoParaExecutivo: isMaster ? null : loggedExec.cod,
        executivoLogado: loggedExec ? { cod: loggedExec.cod, nome: loggedExec.nome, unidadeRef: loggedExec.unidadeRef } : null
      },
      executivosDisponiveis: executivosMontados.map(e => ({
        cod: e.codVendedor,
        nome: e.executivo,
        unidadeRef: e.unidadeRef,
        cor: e.cor
      })),
      atualizacao: {
        protheusUltimaEmissao: fresh.max_emissao_protheus ? String(fresh.max_emissao_protheus).slice(0, 10) : null,
        bitrixUltimaModificacao: fresh.max_modify_bitrix || null
      },
      fontes: {
        medicoes: {
          competenciaExibida: medicoesAtribuidas.competenciaExibida,
          mesSolicitado: medicoesAtribuidas.mesSolicitado,
          divergente: medicoesAtribuidas.divergente
        },
        cobertura: {
          disponivel: coberturaData.disponivel,
          aoVivo: coberturaData.aoVivo,
          competencia: coberturaData.competencia,
          fonte: coberturaData.fonte,
          observacao: coberturaData.observacao
        }
      },
      resumoGeral: isMaster ? resumoGeral : null,
      comparativo: isMaster ? comparativo : null,
      detalhe
    });
  } catch (error) {
    console.error('Falha ao consultar Painel Executivos:', error);
    return res.status(500).json({
      ok: false,
      error: 'Não foi possível carregar os indicadores do Painel Executivos agora.'
    });
  }
}
