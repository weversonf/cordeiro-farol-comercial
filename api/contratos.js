import { getPool, toNumber } from './_db.js';
import { requireAdminMaster } from './_auth.js';

const ACTIVE_CONTRACT_STAGES = [
  'C4:UC_FOYMHF', // JURÍDICO - Análise do contrato
  'C4:UC_VHKW1X', // Elaborar contrato
  'C4:UC_JDNYZT', // Fechado - Enviar para Assinatura
  'C4:UC_RPFFJU', // Negocio Ganho
  'C4:UC_2ZQLVL', // Em atendimento
  'C19:WON'       // Elaborar contrato (Funil de vendas)
];

const SIGNATURE_PENDING_STAGES = new Set([
  'C4:UC_FOYMHF',
  'C4:UC_VHKW1X',
  'C4:UC_JDNYZT',
  'C19:WON'
]);

const STAGE_LABELS = {
  'C4:UC_FOYMHF': 'Análise Jurídica',
  'C4:UC_VHKW1X': 'Elaborar Contrato',
  'C4:UC_JDNYZT': 'Enviar p/ Assinatura',
  'C4:UC_RPFFJU': 'Negócio Ganho',
  'C4:UC_2ZQLVL': 'Em Atendimento',
  'C19:WON': 'Elaborar Contrato (Funil)'
};

function classifyStatusPrazo(faltamDias) {
  if (faltamDias === null || faltamDias === undefined) return 'sem_data';
  if (faltamDias < 0) return 'vencido';
  if (faltamDias <= 30) return 'critico_30';
  if (faltamDias <= 90) return 'alerta_90';
  if (faltamDias <= 180) return 'atencao_180';
  return 'vigente';
}

function uniqueSorted(items) {
  return [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  const user = await requireAdminMaster(req, res);
  if (!user) return;

  const bitrixPortal = String(process.env.BITRIX_PORTAL_URL || '').trim().replace(/\/+$/, '');

  try {
    const client = getPool();

    const [dealsResult, syncResult] = await Promise.all([
      client.query(`
        WITH unidades_deal AS (
          SELECT
            uf."ID"::text AS deal_id,
            STRING_AGG(DISTINCT ev."VALOR", ', ' ORDER BY ev."VALOR") AS unidade_nome
          FROM stage_bitrix.b_crm_deal_uf uf
          CROSS JOIN LATERAL regexp_split_to_table(
            regexp_replace(COALESCE(uf."UF_CRM_1705060456626", ''), '[^0-9,]', '', 'g'),
            ','
          ) AS uid
          JOIN stage_bitrix.b_uf_enum_values ev
            ON ev."FIELD_NAME" = 'UF_CRM_1705060456626'
           AND ev."ITEM_ID"::text = NULLIF(uid, '')
          GROUP BY uf."ID"::text
        ),
        equipamentos_deal AS (
          SELECT
            p."OWNER_ID"::text AS deal_id,
            STRING_AGG(
              DISTINCT COALESCE(NULLIF(TRIM(p."PRODUCT_NAME"), ''), 'Equipamento'),
              ', '
            ) AS equipamentos
          FROM stage_bitrix.b_crm_product_row p
          WHERE p."OWNER_TYPE" = 'D'
          GROUP BY p."OWNER_ID"::text
        ),
        base AS (
          SELECT
            d."ID"::text AS id,
            COALESCE(NULLIF(TRIM(d."TITLE"), ''), 'Negócio #' || d."ID"::text) AS titulo,
            d."STAGE_ID" AS stage_id,
            COALESCE(NULLIF(TRIM(s."NAME"), ''), d."STAGE_ID") AS stage_nome,
            COALESCE(NULLIF(TRIM(c."TITLE"), ''), 'Empresa não vinculada') AS cliente,
            COALESCE(NULLIF(TRIM(CONCAT(uv."NAME", ' ', COALESCE(uv."LAST_NAME", ''))), ''), 'Sem consultor') AS consultor,
            COALESCE(
              NULLIF(u_unid.unidade_nome, ''),
              CASE
                WHEN d."TITLE" ILIKE '%WIND%'   THEN 'Wind'
                WHEN d."TITLE" ILIKE '%PEC%'    THEN 'Pecém'
                WHEN d."TITLE" ILIKE '%CLCP%'   THEN 'Centro Logístico'
                WHEN d."TITLE" ILIKE '%NORT%'   THEN 'Norte'
                WHEN d."TITLE" ILIKE '%TRANSP%' THEN 'Transportes'
                WHEN d."TITLE" ILIKE '%ENG%'    THEN 'Engenharia'
                ELSE 'Não informado'
              END
            ) AS unidade,
            COALESCE(et."VALOR", 'Não informado') AS tipo_contrato,
            COALESCE(eq.equipamentos, '') AS equipamentos,
            CASE
              WHEN TRIM(COALESCE(d."OPPORTUNITY"::text, '')) ~ '^-?[0-9]+(\\.[0-9]+)?$'
                THEN d."OPPORTUNITY"::numeric
              ELSE 0
            END AS valor,
            COALESCE(
              CASE WHEN TRIM(COALESCE(uf."UF_CRM_1704904017946"::text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN uf."UF_CRM_1704904017946"::date END,
              CASE WHEN TRIM(COALESCE(uf."UF_CRM_1713470874"::text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN uf."UF_CRM_1713470874"::date END,
              CASE WHEN TRIM(COALESCE(d."BEGINDATE"::text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN d."BEGINDATE"::date END
            ) AS dt_inicio,
            COALESCE(
              CASE WHEN TRIM(COALESCE(uf."UF_CRM_1704904033370"::text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN uf."UF_CRM_1704904033370"::date END,
              CASE WHEN TRIM(COALESCE(uf."UF_CRM_1713470907"::text, '')) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN uf."UF_CRM_1713470907"::date END
            ) AS dt_fim,
            d."DATE_MODIFY" AS date_modify
          FROM stage_bitrix.b_crm_deal d
          LEFT JOIN stage_bitrix.b_crm_deal_uf uf ON uf."ID"::text = d."ID"::text
          LEFT JOIN stage_bitrix.b_crm_company c ON c."ID"::text = d."COMPANY_ID"::text
          LEFT JOIN stage_bitrix.b_user uv ON uv."ID"::text = d."ASSIGNED_BY_ID"::text
          LEFT JOIN stage_bitrix.b_crm_status s ON s."STATUS_ID" = d."STAGE_ID" AND s."ENTITY_ID" LIKE 'DEAL_STAGE%'
          LEFT JOIN unidades_deal u_unid ON u_unid.deal_id = d."ID"::text
          LEFT JOIN equipamentos_deal eq ON eq.deal_id = d."ID"::text
          LEFT JOIN stage_bitrix.b_uf_enum_values et
            ON et."FIELD_NAME" = 'UF_CRM_1757342596090'
           AND et."ITEM_ID"::text = NULLIF(regexp_replace(COALESCE(uf."UF_CRM_1757342596090"::text, ''), '[^0-9]', '', 'g'), '')
          WHERE d."STAGE_ID" = ANY($1::text[])
        )
        SELECT
          id,
          titulo,
          stage_id,
          stage_nome,
          cliente,
          consultor,
          unidade,
          tipo_contrato,
          equipamentos,
          valor,
          TO_CHAR(dt_inicio, 'YYYY-MM-DD') AS dt_inicio,
          TO_CHAR(dt_fim, 'YYYY-MM-DD') AS dt_fim,
          CASE WHEN dt_fim IS NOT NULL THEN (dt_fim - CURRENT_DATE)::int ELSE NULL END AS faltam_dias,
          CASE WHEN dt_inicio IS NOT NULL AND dt_fim IS NOT NULL THEN (dt_fim - dt_inicio)::int ELSE NULL END AS vigencia_dias,
          date_modify
        FROM base
        ORDER BY
          CASE
            WHEN dt_fim IS NULL THEN 5
            WHEN dt_fim < CURRENT_DATE THEN 4
            WHEN dt_fim <= CURRENT_DATE + 30 THEN 0
            WHEN dt_fim <= CURRENT_DATE + 90 THEN 1
            WHEN dt_fim <= CURRENT_DATE + 180 THEN 2
            ELSE 3
          END ASC,
          (dt_fim - CURRENT_DATE) ASC NULLS LAST,
          valor DESC
      `, [ACTIVE_CONTRACT_STAGES]),
      client.query(`SELECT MAX("DATE_MODIFY") AS bitrix FROM stage_bitrix.b_crm_deal`)
    ]);

    const contratos = dealsResult.rows.map(row => {
      const faltamDias = row.faltam_dias === null ? null : Number(row.faltam_dias);
      const vigenciaDias = row.vigencia_dias === null ? null : Number(row.vigencia_dias);
      const statusPrazo = classifyStatusPrazo(faltamDias);
      return {
        id: row.id,
        titulo: row.titulo,
        cliente: row.cliente,
        consultor: row.consultor,
        unidade: row.unidade,
        tipoContrato: row.tipo_contrato,
        stageId: row.stage_id,
        etapa: STAGE_LABELS[row.stage_id] || row.stage_nome,
        equipamentos: row.equipamentos,
        valor: toNumber(row.valor),
        dataInicio: row.dt_inicio,
        dataFim: row.dt_fim,
        faltamDias,
        vigenciaDias,
        statusPrazo,
        assinaturaPendente: SIGNATURE_PENDING_STAGES.has(row.stage_id),
        dataAtualizacao: row.date_modify,
        bitrixUrl: bitrixPortal ? `${bitrixPortal}/crm/deal/details/${encodeURIComponent(row.id)}/` : null
      };
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
      fonte: 'stage_bitrix.b_crm_deal',
      atualizacao: {
        bitrix: syncResult.rows[0]?.bitrix || null
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
    console.error('Falha ao consultar contratos do Bitrix:', error);
    return res.status(500).json({ ok: false, error: 'Não foi possível consultar os contratos do Bitrix agora.' });
  }
}
