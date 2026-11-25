import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function loadEnvLocal() {
  const envPath = path.join(rootDir, '.env.local');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0 && !line.trim().startsWith('#')) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

loadEnvLocal();

const { getPool, toNumber } = await import('../api/_db.js');
const { buildBillingBaseCte, mapIndicadorUnitName, normalizeDealUnitSql, safeNumericDealSql } = await import('../api/_dw.js');

function parseArgs() {
  const args = process.argv.slice(2);
  const nowBr = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const curY = nowBr.getUTCFullYear();
  const curM = nowBr.getUTCMonth() + 1;
  let year = curM > 1 ? curY : curY - 1;
  let month = curM > 1 ? curM - 1 : 12;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--year' && args[i + 1]) year = Number(args[++i]);
    if (args[i] === '--month' && args[i + 1]) month = Number(args[++i]);
  }
  return { year, month };
}

/**
 * Regra oficial Obsidian (2026-11-12 - Auditoria Funil de Vendas):
 * Separa "Perda Real Competitiva" de "Cancelado pelo Cliente / Nao Ofende Indicador".
 * Inclui: Cancelamento/Desistencia/Primarizacao, Orcamento Orientativo/Referencial,
 * Licitacao/Edital de terceiro, Inadimplencia do Cliente e Limpeza CRM.
 */
function classificarMotivoPerdaOficial(motivoRaw) {
  const raw = String(motivoRaw || '').trim();
  const m = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (!m || m === 'nao informado') {
    return { categoria: 'PERDA_REAL', subtipo: 'Sem motivo informado', ofendeConversao: true };
  }
  if (m.includes('limpeza crm') || m.includes('executivo anterior')) {
    return { categoria: 'EXPURGO_CRM', subtipo: 'Limpeza CRM / Legado', ofendeConversao: false };
  }
  if (m.includes('orientativ') || m.includes('referencial') || m.includes('conhecer os precos') || m.includes('conhecer precos')) {
    return { categoria: 'CANCELADO_CLIENTE', subtipo: 'Orçamento Orientativo / Ref.', ofendeConversao: false };
  }
  if (m.includes('licitac') || m.includes('edital') || m.includes('concorrendo a um tac')) {
    return { categoria: 'CANCELADO_CLIENTE', subtipo: 'Licitação (Perda de terceiro)', ofendeConversao: false };
  }
  if (m.includes('inadimpl')) {
    return { categoria: 'CANCELADO_CLIENTE', subtipo: 'Inadimplência do Cliente', ofendeConversao: false };
  }
  if (
    m.includes('cancelad') || m.includes('cancelou') || m.includes('cancelar') || m.includes('cancelamento') ||
    m.includes('declinad') || m.includes('declinou') ||
    m.includes('desist') || m.includes('desprogram') || m.includes('primariz') ||
    m.includes('nao apresentou proposta') ||
    m.includes('nao ira mais realizar') || m.includes('nao vai mais necessitar') ||
    m.includes('nao vamos mais precisar') || m.includes('nao vao mais precisar') ||
    m.includes('optou por nao continuar') || m.includes('optou em nao continuar') ||
    m.includes('nao precisou dos equipamentos') || m.includes('nao sera mais necessario') ||
    m.includes('atividade nao realizada') || m.includes('servico nao executado') || m.includes('operacao nao foi viabilizada') ||
    m.includes('nao aprovad') || m.includes('nao aprovou') || m.includes('aprovacao negada') || m.includes('sem aprovacao do cliente') ||
    m.includes('invalid')
  ) {
    return { categoria: 'CANCELADO_CLIENTE', subtipo: 'Cancelado / Desistência do Cliente', ofendeConversao: false };
  }
  if (m.includes('indisponibilidade') || m.includes('sem equipamento') || m.includes('frota ocupada')) {
    return { categoria: 'INDISPONIBILIDADE', subtipo: 'Indisponibilidade Cordeiro', ofendeConversao: true };
  }
  return { categoria: 'PERDA_REAL', subtipo: raw, ofendeConversao: true };
}

function fmtBrl(n) {
  return Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function runAudit() {
  const { year, month } = parseArgs();
  const mesRefIso = `${year}-${String(month).padStart(2, '0')}`;
  const yearStart = `${year}-01-01`;
  const yearEndExcl = `${year + 1}-01-01`;
  const pool = getPool();

  const achados = [];
  const addAchado = (nivel, area, titulo, detalhe) => achados.push({ nivel, area, titulo, detalhe });

  try {
    console.log(`\n=== CONFERENTE RMR (${mesRefIso}) — AUDITORIA OFICIAL DW x REGRAS OBSIDIAN ===\n`);

    // 1. Auditoria Faturamento & Expurgos (CM Maquinas + Central ADM)
    const baseCte = buildBillingBaseCte({ startParam: '$1', endParam: '$2', escopo: 'pbix' });
    const fatRes = await pool.query(`
      ${baseCte}
      SELECT
        unidade,
        is_expurgo,
        COALESCE(SUM(CASE WHEN mes_iso = $3 THEN valor_total ELSE 0 END), 0) AS val_mes,
        COALESCE(SUM(CASE WHEN mes_iso <= $3 THEN valor_total ELSE 0 END), 0) AS val_ytd,
        COUNT(DISTINCT CASE WHEN mes_iso = $3 THEN (cod_filial || '-' || numero_documento || '-' || serie) END)::int AS nfs_mes
      FROM faturamento_base
      GROUP BY 1, 2
      ORDER BY val_ytd DESC
    `, [yearStart, yearEndExcl, mesRefIso]);

    let fatLiqMes = 0;
    let fatExpMes = 0;
    let fatLiqYtd = 0;
    let fatExpYtd = 0;
    const cmAdmCheck = { cmMes: 0, admMes: 0, cmYtd: 0, admYtd: 0, vazouSemExpurgo: [] };

    for (const r of fatRes.rows) {
      const vm = toNumber(r.val_mes);
      const vy = toNumber(r.val_ytd);
      if (r.is_expurgo) {
        fatExpMes += vm;
        fatExpYtd += vy;
        if (r.unidade === 'CM Máquinas') { cmAdmCheck.cmMes += vm; cmAdmCheck.cmYtd += vy; }
        if (r.unidade === 'Central ADM') { cmAdmCheck.admMes += vm; cmAdmCheck.admYtd += vy; }
      } else {
        fatLiqMes += vm;
        fatLiqYtd += vy;
        if (r.unidade === 'CM Máquinas' || r.unidade === 'Central ADM') {
          cmAdmCheck.vazouSemExpurgo.push({ unidade: r.unidade, vm, vy });
        }
      }
    }

    console.log(`[1. FATURAMENTO PROTHEUS (${mesRefIso})]`);
    console.log(`  - Faturamento Líquido Mês (pós-expurgo): ${fmtBrl(fatLiqMes)}`);
    console.log(`  - Expurgos Mês (CM + ADM + filiais/vendedores): ${fmtBrl(fatExpMes)} (CM: ${fmtBrl(cmAdmCheck.cmMes)} | ADM: ${fmtBrl(cmAdmCheck.admMes)})`);
    console.log(`  - Faturamento Líquido YTD (Jan..${String(month).padStart(2, '0')}): ${fmtBrl(fatLiqYtd)}`);
    console.log(`  - Expurgos YTD: ${fmtBrl(fatExpYtd)} (CM: ${fmtBrl(cmAdmCheck.cmYtd)} | ADM: ${fmtBrl(cmAdmCheck.admYtd)})`);

    if (cmAdmCheck.vazouSemExpurgo.length > 0) {
      addAchado('ERRO', 'Faturamento/Expurgo', 'Vazamento de CM Máquinas ou Central ADM sem flag is_expurgo',
        JSON.stringify(cmAdmCheck.vazouSemExpurgo));
    } else {
      addAchado('OK', 'Faturamento/Expurgo', 'Expurgo CM Máquinas e Central ADM íntegro',
        `CM (${fmtBrl(cmAdmCheck.cmYtd)} YTD) e ADM (${fmtBrl(cmAdmCheck.admYtd)} YTD) totalmente isolados em is_expurgo=true.`);
    }

    // Conferir fechamento oficial Outubro/2026 se year=2026 e month>=10
    if (year === 2026 && month === 10) {
      const pbixOut = 5667444.54;
      const diffOut = fatLiqMes - pbixOut;
      console.log(`  - Batimento PBIX/Congelado Out/26 (${fmtBrl(pbixOut)}): diferença = ${fmtBrl(diffOut)}`);
      if (Math.abs(diffOut) > 100) {
        addAchado('ALERTA', 'Faturamento Out/26', 'Diferença DW atual vs Fechamento Congelado PBIX',
          `DW líquido Out/26 = ${fmtBrl(fatLiqMes)} vs Congelado = ${fmtBrl(pbixOut)} (dif: ${fmtBrl(diffOut)}).`);
      }
    }

    // 2. Auditoria Metas (ZI0/ZI1 Alvo vs Orcado)
    const metasRes = await pool.query(`
      SELECT
        TRIM(zi0_unidad) AS cod_unid,
        COUNT(*)::int AS meses,
        COALESCE(SUM(zi1_vlrmet), 0) AS orcado_ano,
        COALESCE(SUM(zi1_vlmalv), 0) AS alvo_ano,
        COALESCE(SUM(CASE WHEN LPAD(TRIM(zi1_mes), 2, '0') = $2 THEN zi1_vlmalv ELSE 0 END), 0) AS alvo_mes,
        COALESCE(SUM(CASE WHEN LPAD(TRIM(zi1_mes), 2, '0') = $2 THEN zi1_vlrmet ELSE 0 END), 0) AS orcado_mes
      FROM comercial.indicador_unidade
      WHERE zi0_ano = $1 AND zi0_metric = '000001' AND zi0_status = 'A'
      GROUP BY 1 ORDER BY alvo_ano DESC
    `, [String(year), String(month).padStart(2, '0')]);

    const UNIDADES_OFICIAIS = new Set(['Complexo', 'Norte', 'Pecém', 'Transportes', 'Wind', 'Engenharia']);
    let alvoComercialAno = 0;
    let orcadoComercialAno = 0;
    const unidadesComMeta = new Set();
    const metasExpurgadas = [];

    for (const r of metasRes.rows) {
      const nome = mapIndicadorUnitName(r.cod_unid);
      if (UNIDADES_OFICIAIS.has(nome)) {
        unidadesComMeta.add(nome);
        alvoComercialAno += toNumber(r.alvo_ano);
        orcadoComercialAno += toNumber(r.orcado_ano);
      } else {
        metasExpurgadas.push({ cod: r.cod_unid, nome, alvoAno: toNumber(r.alvo_ano) });
      }
    }

    console.log(`\n[2. METAS UNIDADES (ZI0/ZI1 · ${year})]`);
    console.log(`  - Soma Alvo Comercial (unidades oficiais): ${fmtBrl(alvoComercialAno)} | Soma Orçado: ${fmtBrl(orcadoComercialAno)}`);
    for (const u of UNIDADES_OFICIAIS) {
      if (!unidadesComMeta.has(u)) {
        console.log(`  - [!] Unidade oficial SEM meta cadastrada em indicador_unidade: ${u}`);
        addAchado('ALERTA', 'Metas', `Unidade ${u} sem meta em comercial.indicador_unidade`,
          `A unidade oficial ${u} não possui registros em indicador_unidade (zi0_metric='000001') para ${year}.`);
      }
    }
    if (metasExpurgadas.length) {
      console.log(`  - Metas de unidades fora do escopo comercial (devem ficar fora): ${metasExpurgadas.map(x => `${x.nome} (${fmtBrl(x.alvoAno)})`).join(', ')}`);
    }

    // 3. Auditoria Perdidos vs Cancelados pelo Cliente (Regra Obsidian 2026-11-12)
    const oppSql = safeNumericDealSql('d."OPPORTUNITY"');
    const unitSql = normalizeDealUnitSql('d', 'uf');
    const dealsClosedRes = await pool.query(`
      SELECT
        d."ID"::text AS id,
        d."CATEGORY_ID"::text AS category_id,
        d."STAGE_ID"::text AS stage_id,
        d."STAGE_SEMANTIC_ID"::text AS semantic_id,
        COALESCE(NULLIF(TRIM(d."TITLE"), ''), 'Sem título') AS negocio,
        ${unitSql} AS unidade,
        ${oppSql} AS valor,
        COALESCE(NULLIF(TRIM(uf."UF_CRM_1728564440301"::text), ''), 'Não informado') AS motivo_perda,
        LEFT(COALESCE(d."CLOSEDATE"::text, d."MOVED_TIME"::text, d."DATE_MODIFY"::text, ''), 10) AS data_evento
      FROM stage_bitrix.b_crm_deal d
      LEFT JOIN stage_bitrix.b_crm_deal_uf uf ON uf."ID"::text = d."ID"::text
      WHERE d."CATEGORY_ID" IN ('4', '19')
        AND d."STAGE_SEMANTIC_ID" IN ('S', 'F')
        AND LEFT(COALESCE(d."CLOSEDATE"::text, d."MOVED_TIME"::text, ''), 4) = $1
        AND LEFT(COALESCE(d."CLOSEDATE"::text, d."MOVED_TIME"::text, ''), 7) <= $2
    `, [String(year), mesRefIso]);

    let ganhosQtd = 0, ganhosVal = 0;
    let perdidosReaisQtd = 0, perdidosReaisVal = 0;
    let canceladosQtd = 0, canceladosVal = 0;
    let expurgoCrmQtd = 0, expurgoCrmVal = 0;
    const canceladosPorSubtipo = {};
    const divergenciaCodigoRmr = [];

    // Compara regra completa do Obsidian contra a regex atual de api/rmr.js (para detectar vazamentos)
    const rmrCode = fs.readFileSync(path.join(rootDir, 'api', 'rmr.js'), 'utf8');
    const rmrHasInadimpl = rmrCode.includes('inadimpl');
    const rmrHasPrimariz = rmrCode.includes('primariz');
    const rmrHasEdital = rmrCode.includes('edital');

    for (const d of dealsClosedRes.rows) {
      const val = toNumber(d.valor);
      const isWon = d.semantic_id === 'S' || String(d.stage_id || '').endsWith(':WON');
      if (isWon) {
        ganhosQtd++;
        ganhosVal += val;
      } else {
        const cls = classificarMotivoPerdaOficial(d.motivo_perda);
        if (cls.categoria === 'CANCELADO_CLIENTE') {
          canceladosQtd++;
          canceladosVal += val;
          canceladosPorSubtipo[cls.subtipo] = (canceladosPorSubtipo[cls.subtipo] || 0) + 1;
          const mNorm = String(d.motivo_perda || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          if ((mNorm.includes('inadimpl') && !rmrHasInadimpl) ||
              (mNorm.includes('primariz') && !rmrHasPrimariz) ||
              (mNorm.includes('edital') && !rmrHasEdital)) {
            divergenciaCodigoRmr.push({ id: d.id, motivo: d.motivo_perda, valor: val });
          }
        } else if (cls.categoria === 'EXPURGO_CRM') {
          expurgoCrmQtd++;
          expurgoCrmVal += val;
        } else {
          perdidosReaisQtd++;
          perdidosReaisVal += val;
        }
      }
    }

    const convLimpa = (ganhosQtd + perdidosReaisQtd) > 0 ? (ganhosQtd / (ganhosQtd + perdidosReaisQtd)) * 100 : 0;
    const convBruta = (ganhosQtd + perdidosReaisQtd + canceladosQtd + expurgoCrmQtd) > 0
      ? (ganhosQtd / (ganhosQtd + perdidosReaisQtd + canceladosQtd + expurgoCrmQtd)) * 100 : 0;

    console.log(`\n[3. FUNIL FECHADO YTD (PERDIDO REAL vs CANCELADO PELO CLIENTE)]`);
    console.log(`  - Ganhos: ${ganhosQtd} negócios (${fmtBrl(ganhosVal)})`);
    console.log(`  - Perdidos Reais (ofende conversão): ${perdidosReaisQtd} negócios (${fmtBrl(perdidosReaisVal)})`);
    console.log(`  - Cancelados pelo Cliente (RETIRAR da conta): ${canceladosQtd} negócios (${fmtBrl(canceladosVal)}) ->`, canceladosPorSubtipo);
    console.log(`  - Limpeza CRM (expurgo): ${expurgoCrmQtd} negócios (${fmtBrl(expurgoCrmVal)})`);
    console.log(`  - Taxa Conversão Limpa (sem Cancelados): ${convLimpa.toFixed(1)}% | Taxa Bruta: ${convBruta.toFixed(1)}%`);

    if (!rmrHasInadimpl || !rmrHasPrimariz || !rmrHasEdital) {
      addAchado('ALERTA', 'Regra Cancelado vs Perdido',
        'api/rmr.js não cobre todas as palavras-chave da regra Obsidian',
        `Faltam em isCanceladoOuDeclinado (api/rmr.js): ${!rmrHasInadimpl ? 'inadimpl ' : ''}${!rmrHasPrimariz ? 'primariz ' : ''}${!rmrHasEdital ? 'edital ' : ''}. Itens impactados no período: ${divergenciaCodigoRmr.length}.`);
    } else {
      addAchado('OK', 'Regra Cancelado vs Perdido',
        'Regra de segregação alinhada ao Obsidian',
        `${canceladosQtd} negócios cancelados pelo cliente (${fmtBrl(canceladosVal)}) devidamente retirados da taxa de conversão.`);
    }

    // 4. Auditoria Backlog (CRM vs Protheus) e Funil Aberto
    const [apropRes, ctrOpRes, pipeRes] = await Promise.all([
      pool.query(`
        SELECT mes, COALESCE(SUM(receita_apropriada), 0) AS val
        FROM comercial.fato_apropriacao_receita_mensal
        WHERE ano = $1 AND mes > $2
        GROUP BY 1 ORDER BY 1
      `, [year, month]),
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE status = 'Aberto')::int AS qtd_abertos,
               COALESCE(SUM(GREATEST(COALESCE(valor_global_contrato, 0) - COALESCE(valor_faturado, 0), 0)) FILTER (WHERE status = 'Aberto'), 0) AS saldo_aberto
        FROM comercial.contratos_operacional
      `),
      pool.query(`
        SELECT
          d."ID"::text AS id,
          d."STAGE_ID"::text AS stage_id,
          ${oppSql} AS valor,
          LEFT(COALESCE(uf."UF_CRM_1704904033370"::text, d."CLOSEDATE"::text, ''), 10) AS data_fechamento
        FROM stage_bitrix.b_crm_deal d
        LEFT JOIN stage_bitrix.b_crm_deal_uf uf ON uf."ID"::text = d."ID"::text
        WHERE d."CATEGORY_ID" IN ('4', '19')
          AND d."STAGE_SEMANTIC_ID" = 'P'
          AND COALESCE(d."TITLE", '') NOT ILIKE '%ORÇAMENTO ORIENTATIVO%'
          AND COALESCE(d."TITLE", '') NOT ILIKE '%ORCAMENTO ORIENTATIVO%'
      `)
    ]);

    const backlogRestanteCrm = apropRes.rows.reduce((s, r) => s + toNumber(r.val), 0);
    const saldoProtheus = toNumber(ctrOpRes.rows[0]?.saldo_aberto);
    const pipeSemValor = pipeRes.rows.filter(r => toNumber(r.valor) <= 0).length;
    const pipeNoAnoRestante = pipeRes.rows
      .filter(r => {
        const ym = String(r.data_fechamento || '').slice(0, 7);
        return ym.startsWith(`${year}-`) && Number(ym.slice(5, 7)) > month;
      })
      .reduce((s, r) => s + toNumber(r.valor), 0);

    console.log(`\n[4. BACKLOG & FUNIL ABERTO]`);
    console.log(`  - Backlog CRM restante no ano (${month + 1}..12/${year}): ${fmtBrl(backlogRestanteCrm)}`);
    console.log(`  - Saldo Contratual Aberto Protheus (contratos_operacional): ${fmtBrl(saldoProtheus)} (${ctrOpRes.rows[0]?.qtd_abertos || 0} abertos)`);
    console.log(`  - Funil Aberto previsto para meses restantes (${month + 1}..12/${year}): ${fmtBrl(pipeNoAnoRestante)}`);
    console.log(`  - Deals abertos no Bitrix sem valor (OPPORTUNITY <= 0): ${pipeSemValor} de ${pipeRes.rows.length}`);

    if (backlogRestanteCrm < 100000 && month < 12) {
      addAchado('ALERTA', 'Backlog Contratado',
        'Apropriação CRM restante muito baixa frente ao saldo Protheus',
        `fato_apropriacao_receita_mensal soma ${fmtBrl(backlogRestanteCrm)} para os meses restantes de ${year}, enquanto contratos_operacional tem ${fmtBrl(saldoProtheus)} em aberto. Verificar planilha SharePoint/backlog.`);
    }

    // 5. Resumo final dos achados
    console.log(`\n=== RESUMO DA AUDITORIA ===`);
    for (const a of achados) {
      console.log(`  [${a.nivel}] ${a.area}: ${a.titulo}\n     -> ${a.detalhe}`);
    }
    console.log('');
  } finally {
    await pool.end();
  }
}

runAudit().catch(err => {
  console.error('Erro na auditoria RMR:', err);
  process.exit(1);
});
