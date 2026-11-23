const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mufykevpimzgudsgzfpb.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_KNpBaTlv2ZjAIhrJA3Ykbw_K-Lv-kNx';

const ALLOWED_MASTER_EMAILS = new Set([
  'weverson.feitosa@cordeiroguindastes.com.br'
]);

async function hasDelegatedReportsPermission(email, bearerToken) {
  const endpoint = `${SUPABASE_URL}/rest/v1/usuarios_nps?email=ilike.${encodeURIComponent(email)}&select=ativo,permissao_relatorios&limit=1`;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const authTokens = [serviceKey, bearerToken, SUPABASE_ANON_KEY].filter(Boolean);

  for (const token of authTokens) {
    try {
      const res = await fetch(endpoint, {
        headers: {
          apikey: serviceKey && token === serviceKey ? serviceKey : SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`
        }
      });
      if (!res.ok) continue;
      const rows = await res.json();
      if (!Array.isArray(rows) || !rows.length) continue;
      const row = rows[0];
      return {
        checked: true,
        allowed: Boolean(row && row.ativo !== false && row.permissao_relatorios === true),
        ativo: row?.ativo !== false
      };
    } catch {
      // Tenta próximo token de leitura autorizado
    }
  }
  return { checked: false, allowed: false, ativo: false };
}

export async function requireAdminMaster(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const authHeader = String(req.headers?.authorization || '');
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();

  if (!token) {
    res.status(401).json({
      ok: false,
      error: 'Sessão não autenticada. Faça login novamente no Farol para acessar Relatórios.'
    });
    return null;
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      res.status(401).json({
        ok: false,
        error: 'Sessão expirada ou inválida no Supabase Auth. Faça login novamente ou use "Esqueci minha senha".'
      });
      return null;
    }

    const user = await response.json();
    const email = String(user?.email || '').trim().toLowerCase();

    if (ALLOWED_MASTER_EMAILS.has(email)) {
      return user;
    }

    const delegated = await hasDelegatedReportsPermission(email, token);
    if (!delegated.allowed) {
      res.status(403).json({
        ok: false,
        error: delegated.checked
          ? (!delegated.ativo
              ? 'Seu usuário está inativo no Farol Comercial.'
              : 'Seu usuário não possui permissão de Relatórios liberada no banco.')
          : 'Não foi possível confirmar sua permissão de Relatórios no Supabase.'
      });
      return null;
    }

    return user;
  } catch (error) {
    console.error('Falha ao validar sessão no Supabase Auth:', error);
    res.status(500).json({ ok: false, error: 'Não foi possível validar sua permissão agora.' });
    return null;
  }
}
