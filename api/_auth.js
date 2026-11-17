const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mufykevpimzgudsgzfpb.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_KNpBaTlv2ZjAIhrJA3Ykbw_K-Lv-kNx';

const ALLOWED_MASTER_EMAILS = new Set([
  'weverson.feitosa@cordeiroguindastes.com.br'
]);

async function hasDelegatedReportsPermission(email, bearerToken) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios_nps?email=ilike.${encodeURIComponent(email)}&select=ativo,permissao_relatorios&limit=1`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${bearerToken}`
        }
      }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    return Boolean(row && row.ativo !== false && row.permissao_relatorios === true);
  } catch {
    return false;
  }
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
    if (!delegated) {
      res.status(403).json({
        ok: false,
        error: 'Acesso restrito aos usuários autorizados em Relatórios.'
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
