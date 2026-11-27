import { getPool, toNumber } from './_db.js';
import { requireAdminMaster } from './_auth.js';
import { buildBillingBaseCte } from './_dw.js';

const EXECUTIVOS_RANKING = [
  { cod: '059', nome: 'Marcio Funghi', cor: '#A855F7', match: ['MARCIO', 'MÁRCIO'] },
  { cod: '0050', nome: 'Cristiane Lucio Lima', cor: '#EC4899', match: ['CRISTIANE'] },
  { cod: '000056', nome: 'Cristiano Assis', cor: '#38BDF8', match: ['CRISTIANO'] },
  { cod: '000036', nome: 'Bruno Pessoa', cor: '#2563EB', match: ['BRUNO'] },
  { cod: '000058', nome: 'Fabricio Medeiros', cor: '#10B981', match: ['FABRICIO', 'FABRÍCIO'] },
  { cod: '000057', nome: 'Fernando Oliveira', cor: '#F59E0B', match: ['FERNANDO'] }
];

function mapBitrixCod(nomeRaw) {
  const norm = String(nomeRaw || '').toUpperCase().trim();
  for (const ex of EXECUTIVOS_RANKING) {
    if (ex.match.some(m => norm.includes(m))) return ex.cod;
  }
  return '';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  const user = await requireAdminMaster(req, res);
  if (!user) return;

  const nowBr = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const curY = nowBr.getUTCFullYear();
  const curM = nowBr.getUTCMonth() + 1;

  const reqY = Number(req.query?.year);
  const reqM = Number(req.query?.month);
  const year = Number.isInteger(reqY) && reqY >= 2023 && reqY <= curY + 1 ? reqY : curY;
  const month = Number.isInteger(reqM) && reqM >= 1 && reqM <= 12 ? reqM : curM;
  const mesIso = `${year}-${String(month).padStart(2, '0')}`;
  const startDate = `${year}-01-01`;
  const endDate = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  try {
    const pool = getPool();

    const [metasRes, bitrixRes, protheusRes] = await Promise.all([
      pool.query(`
        SELECT
          TRIM(COALESCE(cod_vendedor::text, '')) AS cod_vendedor,
          MAX(COALESCE(valor_alvo, 0))::numeric AS meta_ano,
          (MAX(COALESCE(valor_alvo, 0)) / 12.0)::numeric AS meta_mes
        FROM comercial.dim_meta_vendedores
        WHERE EXTRACT(YEAR FROM data_referencia)::int = $1
          AND UPPER(COALESCE(descricao, '')) NOT LIKE '%NPS%'
        GROUP BY 1
      `, [year]),

      pool.query(`
        SELECT
          TRIM(COALESCE(u."NAME", '') || ' ' || COALESCE(u."LAST_NAME", '')) AS nome,
          COUNT(*) FILTER (WHERE TO_CHAR(d."CLOSEDATE"::timestamptz, 'YYYY-MM') = $2) AS qtd_mes,
          COALESCE(SUM(CASE
            WHEN TO_CHAR(d."CLOSEDATE"::timestamptz, 'YYYY-MM') = $2 AND d."OPPORTUNITY" ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN d."OPPORTUNITY"::numeric ELSE 0
          END), 0) AS val_mes,
          COUNT(*) AS qtd_ano,
          COALESCE(SUM(CASE
            WHEN d."OPPORTUNITY" ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN d."OPPORTUNITY"::numeric ELSE 0
          END), 0) AS val_ano
        FROM stage_bitrix.b_crm_deal d
        LEFT JOIN stage_bitrix.b_user u ON d."ASSIGNED_BY_ID" = u."ID"
        WHERE d."STAGE_SEMANTIC_ID" = 'S'
          AND d."CATEGORY_ID" IN ('4', '19')
          AND d."CLOSEDATE"::timestamptz >= $1::timestamptz
          AND d."CLOSEDATE"::timestamptz < $3::timestamptz
        GROUP BY 1
      `, [startDate, mesIso, endDate]),

      pool.query(`
        ${buildBillingBaseCte({ startParam: '$1', endParam: '$2', escopo: 'pbix' })}
        SELECT
          CASE
            WHEN COALESCE(NULLIF(TRIM(cod_vendedor), ''), '000016') IN ('000016', 'SEM_COD') AND unidade = 'Norte' THEN '000056'
            ELSE COALESCE(NULLIF(TRIM(cod_vendedor), ''), 'SEM_COD')
          END AS cod_vendedor,
          COUNT(DISTINCT CASE WHEN mes_iso = $3 AND NOT is_expurgo THEN (cod_filial || '-' || numero_documento || '-' || serie) END) AS notas_mes,
          COALESCE(SUM(CASE WHEN mes_iso = $3 AND NOT is_expurgo THEN valor_total ELSE 0 END), 0) AS realizado_mes,
          COUNT(DISTINCT CASE WHEN NOT is_expurgo THEN (cod_filial || '-' || numero_documento || '-' || serie) END) AS notas_ano,
          COALESCE(SUM(CASE WHEN NOT is_expurgo THEN valor_total ELSE 0 END), 0) AS realizado_ano
        FROM faturamento_base
        GROUP BY 1
      `, [startDate, endDate, mesIso])
    ]);

    const metasMap = Object.fromEntries(
      metasRes.rows.map(r => [r.cod_vendedor, { metaAno: toNumber(r.meta_ano), metaMes: toNumber(r.meta_mes) }])
    );

    const bitrixMap = {};
    for (const r of bitrixRes.rows) {
      const cod = mapBitrixCod(r.nome);
      if (!cod) continue;
      if (!bitrixMap[cod]) bitrixMap[cod] = { qtdMes: 0, valMes: 0, qtdAno: 0, valAno: 0 };
      bitrixMap[cod].qtdMes += Number(r.qtd_mes || 0);
      bitrixMap[cod].valMes += toNumber(r.val_mes);
      bitrixMap[cod].qtdAno += Number(r.qtd_ano || 0);
      bitrixMap[cod].valAno += toNumber(r.val_ano);
    }

    const protheusMap = Object.fromEntries(
      protheusRes.rows.map(r => [
        r.cod_vendedor,
        {
          notasMes: Number(r.notas_mes || 0),
          valMes: toNumber(r.realizado_mes),
          notasAno: Number(r.notas_ano || 0),
          valAno: toNumber(r.realizado_ano)
        }
      ])
    );

    const vendido = EXECUTIVOS_RANKING.map(ex => {
      const m = metasMap[ex.cod] || { metaAno: 0, metaMes: 0 };
      const b = bitrixMap[ex.cod] || { qtdMes: 0, valMes: 0, qtdAno: 0, valAno: 0 };
      const metaYtd = m.metaMes * month;
      return {
        cod: ex.cod,
        nome: ex.nome,
        cor: ex.cor,
        qtdMes: b.qtdMes,
        realizadoMes: Number(b.valMes.toFixed(2)),
        metaMes: Number(m.metaMes.toFixed(2)),
        pctMes: m.metaMes > 0 ? Number(((b.valMes / m.metaMes) * 100).toFixed(1)) : 0,
        qtdAno: b.qtdAno,
        realizadoAno: Number(b.valAno.toFixed(2)),
        metaAno: Number(m.metaAno.toFixed(2)),
        metaYtd: Number(metaYtd.toFixed(2)),
        pctAno: metaYtd > 0 ? Number(((b.valAno / metaYtd) * 100).toFixed(1)) : 0
      };
    });

    const faturado = EXECUTIVOS_RANKING.map(ex => {
      const m = metasMap[ex.cod] || { metaAno: 0, metaMes: 0 };
      const p = protheusMap[ex.cod] || { notasMes: 0, valMes: 0, notasAno: 0, valAno: 0 };
      const metaYtd = m.metaMes * month;
      return {
        cod: ex.cod,
        nome: ex.nome,
        cor: ex.cor,
        qtdMes: p.notasMes,
        realizadoMes: Number(p.valMes.toFixed(2)),
        metaMes: Number(m.metaMes.toFixed(2)),
        pctMes: m.metaMes > 0 ? Number(((p.valMes / m.metaMes) * 100).toFixed(1)) : 0,
        qtdAno: p.notasAno,
        realizadoAno: Number(p.valAno.toFixed(2)),
        metaAno: Number(m.metaAno.toFixed(2)),
        metaYtd: Number(metaYtd.toFixed(2)),
        pctAno: metaYtd > 0 ? Number(((p.valAno / metaYtd) * 100).toFixed(1)) : 0
      };
    });

    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json({
      ok: true,
      geradoEm: new Date().toISOString(),
      year,
      month,
      mesIso,
      vendido,
      faturado
    });
  } catch (error) {
    console.error('Falha ao consultar Ranking:', error);
    return res.status(500).json({ ok: false, error: 'Não foi possível carregar o Ranking agora.' });
  }
}
