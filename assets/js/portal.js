/**
 * GRUPO CORDEIRO - FAROL CORDEIRO COMERCIAL
 * Sincronização em Tempo Real com Supabase (mufykevpimzgudsgzfpb)
 * Acesso Exclusivo de Gestão Geral (IAM): weverson.feitosa@cordeiroguindastes.com.br
 */

// Configuração do Supabase Oficial
const SUPABASE_URL = "https://mufykevpimzgudsgzfpb.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_KNpBaTlv2ZjAIhrJA3Ykbw_K-Lv-kNx";

// Inicializa o cliente Supabase oficial sem colidir com o escopo global window.supabase
const sbClient = (window.supabase && typeof window.supabase.createClient === 'function')
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// Chaves de armazenamento
const STORAGE_KEY_AUTH = 'cordeiro_farol_session_v1';
const STORAGE_KEY_USERS = 'cordeiro_farol_users_v1';

// E-mail do Administrador Master Exclusivo do Farol Geral
const ADMIN_MASTER_EMAIL = 'weverson.feitosa@cordeiroguindastes.com.br';

// Domínios válidos corporativos
const DOMINIOS_AUTORIZADOS = [
  'cordeiroguindastes.com.br',
  'cordeiroguindastes.com',
  'grupocordeiro.com',
  'grupocordeiro.srv.br'
];

function validarDominioCorporativo(email) {
  const parts = String(email || '').trim().toLowerCase().split('@');
  if (parts.length !== 2) return false;
  return DOMINIOS_AUTORIZADOS.includes(parts[1]);
}

// URLs dos 3 sistemas em produção
const URLS_SISTEMAS = {
  mapa: 'https://cordeiro-mapa-ocupacao.vercel.app',
  nps: 'https://cordeiro-nps.vercel.app',
  funil: 'https://cordeiro-funil-vendas.vercel.app'
};

// Base inicial padrão de contingência (fallback local caso banco offline)
const USUARIOS_PADRAO = [
  {
    id: 'u-1',
    nome: 'Weverson Feitosa',
    email: 'weverson.feitosa@cordeiroguindastes.com.br',
    cargo: 'Administrador Master',
    status: 'ativo',
    permissoes: {
      mapa: { liberado: true, perfil: 'Admin' },
      nps: { liberado: true, perfil: 'Admin' },
      funil: { liberado: true, perfil: 'Admin' }
    }
  }
];

// Estado
let currentUser = null;
let usersList = [];
let editingUserId = null;
let editingUserEmail = null;
let usuarioParaExcluir = null;

// Inicialização
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  setupModalSwitches();
  checkPasswordRecovery();
  await initStorage();
  checkSession();
});

// Carrega usuários da nuvem (Supabase) ou fallback local
async function initStorage() {
  let loadedFromCloud = false;

  if (sbClient) {
    try {
      const { data, error } = await sbClient
        .from('usuarios_nps')
        .select('*');

      if (!error && Array.isArray(data) && data.length > 0) {
        window._supabaseDataCloud = data;
        usersList = data
          .filter(row => {
            const e = String(row.email || '').toLowerCase();
            return e !== 'marcio.funghi@cordeiroguindastes.com' && e !== 'comercial@cordeiroguindastes.com.br';
          })
          .map(row => {
            const emailLow = String(row.email || '').toLowerCase();
            const isNpsLiberado = row.perfil && row.perfil !== 'bloqueado' && row.perfil !== 'sem_acesso';
            let npsPerfilLabel = 'Visualizador';
            if (row.perfil === 'admin' || row.perfil === 'admin_master') npsPerfilLabel = 'Admin';
            else if (row.perfil === 'comercial') npsPerfilLabel = 'Comercial';

            let defaultCargo = 'Colaborador';
            if (emailLow === ADMIN_MASTER_EMAIL) defaultCargo = 'Administrador Master';
            else if (emailLow.includes('marcio')) defaultCargo = 'Head Comercial';
            else if (emailLow.includes('erika')) defaultCargo = 'Gestão NPS & Qualidade';

            return {
              id: String(row.id),
              nome: row.nome || 'Colaborador',
              email: emailLow,
              cargo: row.cargo || defaultCargo,
              status: row.ativo === false ? 'inativo' : 'ativo',
              permissoes: {
                mapa: {
                  liberado: row.permissao_mapa !== false,
                  perfil: row.perfil_mapa || 'Operação'
                },
                nps: {
                  liberado: isNpsLiberado,
                  perfil: isNpsLiberado ? npsPerfilLabel : 'Sem Acesso'
                },
                funil: {
                  liberado: row.permissao_funil !== false,
                  perfil: row.perfil_funil || 'Comercial'
                }
              }
            };
          });

        loadedFromCloud = true;
      }
    } catch (err) {
      console.warn('Aviso: Supabase em sincronização local temporária.', err);
    }
  }

  if (!loadedFromCloud) {
    const storedUsers = localStorage.getItem(STORAGE_KEY_USERS);
    if (!storedUsers) {
      usersList = [...USUARIOS_PADRAO];
    } else {
      try {
        const parsed = JSON.parse(storedUsers);
        usersList = Array.isArray(parsed) && parsed.length > 0 ? parsed : [...USUARIOS_PADRAO];
      } catch (e) {
        usersList = [...USUARIOS_PADRAO];
      }
    }
  }

  // Garante apenas que o Administrador Master esteja sempre na lista para evitar lockout acidental
  const existeMaster = usersList.some(u => u.email.toLowerCase() === ADMIN_MASTER_EMAIL.toLowerCase());
  if (!existeMaster) {
    usersList.unshift(USUARIOS_PADRAO[0]);
  }

  // Se carregou do banco de dados na nuvem, limpa quaisquer usuários locais legados que já foram excluídos
  if (loadedFromCloud) {
    usersList = usersList.filter(u => {
      const e = u.email.toLowerCase();
      return e === ADMIN_MASTER_EMAIL.toLowerCase() || (window._supabaseDataCloud && window._supabaseDataCloud.some(row => String(row.email).toLowerCase() === e));
    });
  }

  localStorage.setItem(STORAGE_KEY_USERS, JSON.stringify(usersList));
}

function checkSession() {
  const sessionData = localStorage.getItem(STORAGE_KEY_AUTH);
  if (sessionData) {
    try {
      const cached = JSON.parse(sessionData);
      // Atualiza os dados da sessão com a versão mais recente da lista de usuários
      const updatedUser = usersList.find(u => u.email.toLowerCase() === cached.email.toLowerCase());
      currentUser = updatedUser || cached;
      localStorage.setItem(STORAGE_KEY_AUTH, JSON.stringify(currentUser));
      showAppScreen();
    } catch (e) {
      showLoginScreen();
    }
  } else {
    showLoginScreen();
  }
}

function showLoginScreen() {
  document.getElementById('telaLogin').style.display = 'flex';
  document.getElementById('portalApp').style.display = 'none';
}

function showAppScreen() {
  document.getElementById('telaLogin').style.display = 'none';
  document.getElementById('portalApp').style.display = 'block';

  document.getElementById('headerUserName').textContent = currentUser.nome;
  document.getElementById('headerUserRole').textContent = currentUser.cargo;

  // Apenas Weverson Feitosa tem acesso à aba de Gestão de Perfis & Acessos
  const tabGestaoBtn = document.getElementById('tabGestaoBtn');
  const isMasterAdmin = currentUser.email.toLowerCase() === ADMIN_MASTER_EMAIL;

  if (isMasterAdmin) {
    tabGestaoBtn.style.display = 'flex';
  } else {
    tabGestaoBtn.style.display = 'none';
    switchTab('launcher');
  }

  renderLauncher();
  if (isMasterAdmin) {
    renderTabelaUsuarios();
  }
}

function setupEventListeners() {
  // Login
  document.getElementById('formLogin').addEventListener('submit', handleLogin);

  // Olho de mostrar/ocultar senha
  const btnToggleEye = document.getElementById('btnToggleEye');
  const inputSenha = document.getElementById('loginSenha');
  btnToggleEye.addEventListener('click', () => {
    const isPass = inputSenha.getAttribute('type') === 'password';
    inputSenha.setAttribute('type', isPass ? 'text' : 'password');
    btnToggleEye.innerHTML = isPass ? '<i class="ph ph-eye-slash"></i>' : '<i class="ph ph-eye"></i>';
  });

  // Logout
  document.getElementById('btnLogout').addEventListener('click', handleLogout);

  // Abas
  document.getElementById('tabLauncherBtn').addEventListener('click', () => switchTab('launcher'));
  document.getElementById('tabGestaoBtn').addEventListener('click', () => {
    if (currentUser.email.toLowerCase() === ADMIN_MASTER_EMAIL) {
      switchTab('gestao');
    }
  });

  // Esqueci senha
  document.getElementById('btnAbrirEsqueci').addEventListener('click', () => abrirModal('modalEsqueci'));
  document.getElementById('btnFecharEsqueci').addEventListener('click', () => fecharModal('modalEsqueci'));
  document.getElementById('formEsqueci').addEventListener('submit', handleEnviarEsqueci);

  // Redefinir Senha (Recovery)
  const btnFecharRec = document.getElementById('btnFecharRecovery');
  if (btnFecharRec) btnFecharRec.addEventListener('click', () => fecharModal('modalNovaSenhaRecovery'));
  const formRec = document.getElementById('formNovaSenhaRecovery');
  if (formRec) formRec.addEventListener('submit', handleSalvarNovaSenhaRecovery);

  // Novo usuário
  document.getElementById('btnNovoColaborador').addEventListener('click', () => {
    document.getElementById('formNovoUsuario').reset();
    abrirModal('modalNovoUsuario');
  });
  document.getElementById('btnFecharNovo').addEventListener('click', () => fecharModal('modalNovoUsuario'));
  document.getElementById('btnCancelarNovo').addEventListener('click', () => fecharModal('modalNovoUsuario'));
  document.getElementById('formNovoUsuario').addEventListener('submit', handleSalvarNovoUsuario);

  // Edição
  document.getElementById('btnFecharEditar').addEventListener('click', () => fecharModal('modalEditarUsuario'));
  document.getElementById('btnCancelarEditar').addEventListener('click', () => fecharModal('modalEditarUsuario'));
  document.getElementById('formEditarUsuario').addEventListener('submit', handleSalvarEdicaoUsuario);

  // Exclusão de Colaborador
  const btnFecharExclusao = document.getElementById('btnFecharConfirmExclusao');
  if (btnFecharExclusao) btnFecharExclusao.addEventListener('click', () => fecharModal('modalConfirmExclusao'));
  const btnCancelarExclusao = document.getElementById('btnCancelarExclusao');
  if (btnCancelarExclusao) btnCancelarExclusao.addEventListener('click', () => fecharModal('modalConfirmExclusao'));
  const btnConfirmarExclusao = document.getElementById('btnConfirmarExclusaoAcao');
  if (btnConfirmarExclusao) btnConfirmarExclusao.addEventListener('click', executarExclusaoConfirmada);

  // Busca
  document.getElementById('buscaUsuarios').addEventListener('input', (e) => {
    renderTabelaUsuarios(e.target.value.toLowerCase());
  });
}

function setupModalSwitches() {
  const setupSwitch = (switchId, cardId, selectId) => {
    const el = document.getElementById(switchId);
    if (!el) return;
    el.addEventListener('change', () => {
      const card = document.getElementById(cardId);
      const sel = document.getElementById(selectId);
      if (card) card.className = el.checked ? 'app-permission-card ativo' : 'app-permission-card inativo';
      if (sel) sel.disabled = !el.checked;
    });
  };

  setupSwitch('editPermMapa', 'cardEditMapa', 'editPerfilMapa');
  setupSwitch('editPermNps', 'cardEditNps', 'editPerfilNps');
  setupSwitch('editPermFunil', 'cardEditFunil', 'editPerfilFunil');
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const senha = document.getElementById('loginSenha').value.trim();
  const erroBox = document.getElementById('loginErro');

  erroBox.style.display = 'none';

  if (!validarDominioCorporativo(email)) {
    erroBox.textContent = 'Acesso restrito. Utilize seu e-mail corporativo autorizado (@cordeiroguindastes ou @grupocordeiro).';
    erroBox.style.display = 'flex';
    return;
  }

  if (email === 'marcio.funghi@cordeiroguindastes.com' || email === 'comercial@cordeiroguindastes.com.br') {
    erroBox.textContent = 'Este e-mail corporativo não está ativo no Farol.';
    erroBox.style.display = 'flex';
    return;
  }

  // Tenta recarregar a versão mais atual do Supabase antes de validar
  await initStorage();

  const user = usersList.find(u => u.email.toLowerCase() === email);

  if (!user) {
    erroBox.textContent = 'E-mail corporativo não cadastrado. Solicite liberação ao Weverson Feitosa.';
    erroBox.style.display = 'flex';
    return;
  }

  if (user.status !== 'ativo') {
    erroBox.textContent = 'Este perfil de acesso está suspenso em todas as plataformas.';
    erroBox.style.display = 'flex';
    return;
  }

  currentUser = user;
  localStorage.setItem(STORAGE_KEY_AUTH, JSON.stringify(currentUser));
  showToast(`Autenticado com sucesso. Bem-vindo, ${user.nome}!`, 'success');
  showAppScreen();
}

function handleLogout() {
  localStorage.removeItem(STORAGE_KEY_AUTH);
  currentUser = null;
  document.getElementById('loginEmail').value = '';
  document.getElementById('loginSenha').value = '';
  showLoginScreen();
  showToast('Sessão encerrada com sucesso.', 'success');
}

function switchTab(tab) {
  document.querySelectorAll('.nav-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-view').forEach(view => view.classList.remove('active'));

  if (tab === 'launcher') {
    document.getElementById('tabLauncherBtn').classList.add('active');
    document.getElementById('viewLauncher').classList.add('active');
  } else if (tab === 'gestao' && currentUser.email.toLowerCase() === ADMIN_MASTER_EMAIL) {
    document.getElementById('tabGestaoBtn').classList.add('active');
    document.getElementById('viewGestao').classList.add('active');
    renderTabelaUsuarios();
  }
}

function renderLauncher() {
  const p = currentUser.permissoes || {};

  // 1. Mapa de Ocupação
  const mapaPerm = p.mapa && p.mapa.liberado;
  const mapaBadge = document.getElementById('badgeStatusMapa');
  const mapaBtn = document.getElementById('btnLaunchMapa');
  if (mapaPerm) {
    mapaBadge.className = 'badge-status-app liberado';
    mapaBadge.innerHTML = `<i class="ph ph-check-circle"></i> Liberado (${p.mapa.perfil})`;
    mapaBtn.className = 'btn-launch-app btn-primary-launch';
    mapaBtn.href = getSSORedirectUrl('mapa');
    mapaBtn.target = '_blank';
    mapaBtn.innerHTML = '<span>Acessar Mapa de Ocupação</span> <i class="ph ph-arrow-square-out"></i>';
  } else {
    mapaBadge.className = 'badge-status-app bloqueado';
    mapaBadge.innerHTML = '<i class="ph ph-lock-key"></i> Sem Acesso';
    mapaBtn.className = 'btn-launch-app btn-disabled-launch';
    mapaBtn.removeAttribute('href');
    mapaBtn.removeAttribute('target');
    mapaBtn.innerHTML = '<span>Acesso Bloqueado</span> <i class="ph ph-lock"></i>';
  }

  // 2. Pesquisa NPS
  const npsPerm = p.nps && p.nps.liberado;
  const npsBadge = document.getElementById('badgeStatusNps');
  const npsBtn = document.getElementById('btnLaunchNps');
  if (npsPerm) {
    npsBadge.className = 'badge-status-app liberado';
    npsBadge.innerHTML = `<i class="ph ph-check-circle"></i> Liberado (${p.nps.perfil})`;
    npsBtn.className = 'btn-launch-app btn-primary-launch';
    npsBtn.href = getSSORedirectUrl('nps');
    npsBtn.target = '_blank';
    npsBtn.innerHTML = '<span>Acessar Painel NPS</span> <i class="ph ph-arrow-square-out"></i>';
  } else {
    npsBadge.className = 'badge-status-app bloqueado';
    npsBadge.innerHTML = '<i class="ph ph-lock-key"></i> Sem Acesso';
    npsBtn.className = 'btn-launch-app btn-disabled-launch';
    npsBtn.removeAttribute('href');
    npsBtn.removeAttribute('target');
    npsBtn.innerHTML = '<span>Acesso Bloqueado</span> <i class="ph ph-lock"></i>';
  }

  // 3. Funil de Vendas
  const funilPerm = p.funil && p.funil.liberado;
  const funilBadge = document.getElementById('badgeStatusFunil');
  const funilBtn = document.getElementById('btnLaunchFunil');
  if (funilPerm) {
    funilBadge.className = 'badge-status-app liberado';
    funilBadge.innerHTML = `<i class="ph ph-check-circle"></i> Liberado (${p.funil.perfil})`;
    funilBtn.className = 'btn-launch-app btn-primary-launch';
    funilBtn.href = getSSORedirectUrl('funil');
    funilBtn.target = '_blank';
    funilBtn.innerHTML = '<span>Acessar Funil de Vendas</span> <i class="ph ph-arrow-square-out"></i>';
  } else {
    funilBadge.className = 'badge-status-app bloqueado';
    funilBadge.innerHTML = '<i class="ph ph-lock-key"></i> Sem Acesso';
    funilBtn.className = 'btn-launch-app btn-disabled-launch';
    funilBtn.removeAttribute('href');
    funilBtn.removeAttribute('target');
    funilBtn.innerHTML = '<span>Acesso Bloqueado</span> <i class="ph ph-lock"></i>';
  }
}

function getSSORedirectUrl(appKey) {
  const baseUrl = URLS_SISTEMAS[appKey];
  const payload = {
    userId: currentUser.id,
    email: currentUser.email,
    nome: currentUser.nome,
    cargo: currentUser.cargo,
    perfil: currentUser.permissoes[appKey].perfil,
    issuedAt: Date.now()
  };
  const token = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  return `${baseUrl}#sso_token=${token}`;
}

function renderTabelaUsuarios(termoBusca = '') {
  if (currentUser.email.toLowerCase() !== ADMIN_MASTER_EMAIL) return;

  const tbody = document.getElementById('tbodyUsuarios');
  tbody.innerHTML = '';

  const filtrados = usersList.filter(u => {
    return u.nome.toLowerCase().includes(termoBusca) || 
           u.email.toLowerCase().includes(termoBusca) ||
           u.cargo.toLowerCase().includes(termoBusca);
  });

  if (filtrados.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--text-dimmed);">Nenhum colaborador encontrado para "${termoBusca}".</td></tr>`;
    return;
  }

  filtrados.forEach(u => {
    const tr = document.createElement('tr');
    const isMaster = u.email.toLowerCase() === ADMIN_MASTER_EMAIL;

    const permMapa = u.permissoes.mapa && u.permissoes.mapa.liberado 
      ? `<span class="badge-role-app ativo-mapa"><i class="ph ph-check-circle"></i> ${u.permissoes.mapa.perfil}</span>`
      : `<span class="badge-role-app bloqueado"><i class="ph ph-x"></i> Bloqueado</span>`;

    const permNps = u.permissoes.nps && u.permissoes.nps.liberado 
      ? `<span class="badge-role-app ativo-nps"><i class="ph ph-check-circle"></i> ${u.permissoes.nps.perfil}</span>`
      : `<span class="badge-role-app bloqueado"><i class="ph ph-x"></i> Bloqueado</span>`;

    const permFunil = u.permissoes.funil && u.permissoes.funil.liberado 
      ? `<span class="badge-role-app ativo-funil"><i class="ph ph-check-circle"></i> ${u.permissoes.funil.perfil}</span>`
      : `<span class="badge-role-app bloqueado"><i class="ph ph-x"></i> Bloqueado</span>`;

    const statusPill = u.status === 'ativo' 
      ? `<span class="status-pill ativo"><i class="ph ph-circle-fill" style="font-size:8px;"></i> Ativo</span>`
      : `<span class="status-pill inativo"><i class="ph ph-circle-fill" style="font-size:8px;"></i> Inativo</span>`;

    tr.innerHTML = `
      <td>
        <div class="colaborador-cell">
          <div class="colaborador-avatar">
            <i class="ph ph-user" style="font-size:18px; color:var(--accent-gold);"></i>
          </div>
          <div>
            <div class="colaborador-nome">${u.nome}</div>
            <div class="colaborador-email">${u.email}</div>
          </div>
        </div>
      </td>
      <td>${u.cargo}</td>
      <td>${statusPill}</td>
      <td>${permMapa}</td>
      <td>${permNps}</td>
      <td>${permFunil}</td>
      <td>
        <div class="actions-cell">
          <!-- 1. Editar Permissões -->
          <button class="btn-table-action" title="Editar Permissões" onclick="abrirEdicaoUsuario('${u.id}')">
            <i class="ph ph-sliders"></i>
          </button>

          <!-- 2. Ativar / Desativar -->
          <button class="btn-table-action ${u.status === 'ativo' ? 'warning' : 'success'}" 
                  title="${isMaster ? 'Conta Master Imutável' : (u.status === 'ativo' ? 'Suspender / Desativar Colaborador' : 'Reativar Colaborador')}" 
                  onclick="${isMaster ? '' : `toggleStatusUsuario('${u.id}')`}"
                  ${isMaster ? 'disabled style="opacity:0.3; cursor:not-allowed;"' : ''}>
            <i class="ph ${u.status === 'ativo' ? 'ph-user-minus' : 'ph-user-check'}"></i>
          </button>

          <!-- 3. Excluir Colaborador -->
          <button class="btn-table-action danger" 
                  title="${isMaster ? 'Não é possível excluir o Administrador Master' : 'Excluir Colaborador Definitivamente'}" 
                  onclick="${isMaster ? '' : `solicitarExclusaoUsuario('${u.id}')`}"
                  ${isMaster ? 'disabled style="opacity:0.3; cursor:not-allowed;"' : ''}>
            <i class="ph ph-trash"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function handleSalvarNovoUsuario(e) {
  e.preventDefault();
  const nome = document.getElementById('novoNome').value.trim();
  const email = document.getElementById('novoEmail').value.trim().toLowerCase();
  const cargo = document.getElementById('novoCargo').value.trim();

  if (!validarDominioCorporativo(email)) {
    showToast('O e-mail precisa pertencer a um dos domínios corporativos autorizados (@cordeiroguindastes ou @grupocordeiro).', 'error');
    return;
  }

  if (usersList.some(u => u.email.toLowerCase() === email)) {
    showToast('Já existe um usuário cadastrado com este e-mail.', 'error');
    return;
  }

  const btnSubmit = document.getElementById('btnSalvarNovoUsuario');
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<i class="ph ph-spinner-gap animate-spin"></i> <span>Cadastrando no Auth & Farol...</span>';
  }

  const mapaLiberado = document.getElementById('novoPermMapa').checked;
  const mapaPerfil = document.getElementById('novoPerfilMapa').value;

  const npsLiberado = document.getElementById('novoPermNps').checked;
  const npsPerfil = document.getElementById('novoPerfilNps').value;

  const funilLiberado = document.getElementById('novoPermFunil').checked;
  const funilPerfil = document.getElementById('novoPerfilFunil').value;

  const novoUsuario = {
    id: 'usr_' + Date.now(),
    nome,
    email,
    cargo,
    status: 'ativo',
    permissoes: {
      mapa: { liberado: mapaLiberado, perfil: mapaLiberado ? mapaPerfil : 'Sem Acesso' },
      nps: { liberado: npsLiberado, perfil: npsLiberado ? npsPerfil : 'Sem Acesso' },
      funil: { liberado: funilLiberado, perfil: funilLiberado ? funilPerfil : 'Sem Acesso' }
    }
  };

  try {
    // 1. Cria automaticamente a conta no Supabase Auth usando cliente secundário isolado (sem afetar a sessão atual)
    const secondaryAuth = (window.supabase && typeof window.supabase.createClient === 'function')
      ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
        })
      : null;

    if (secondaryAuth) {
      try {
        const { error: authErr } = await secondaryAuth.auth.signUp({
          email: email,
          password: 'Cordeiro@2026',
          options: {
            emailRedirectTo: window.location.origin,
            data: {
              nome: nome,
              cargo: cargo,
              precisaTrocarSenha: true
            }
          }
        });
        if (authErr && !authErr.message?.toLowerCase().includes('already')) {
          console.warn('Aviso ao registrar no Supabase Auth:', authErr);
        }
      } catch (authEx) {
        console.warn('Exceção ao criar no Supabase Auth:', authEx);
      }
    }

    // 2. Salva na tabela oficial de permissões (usuarios_nps)
    if (sbClient) {
      try {
        const nextNumericId = Math.max(0, ...usersList.map(u => parseInt(u.id) || 0)) + 1;
        novoUsuario.id = String(nextNumericId);

        const perfilNpsDb = !npsLiberado ? 'bloqueado' : (npsPerfil === 'Admin' ? 'admin' : (npsPerfil === 'Comercial' ? 'comercial' : 'visualizador'));
        const { data: insertedData, error: dbErr } = await sbClient
          .from('usuarios_nps')
          .insert([{
            id: nextNumericId,
            nome,
            email,
            senha: 'Cordeiro@2026',
            ativo: true,
            perfil: perfilNpsDb,
            permissao_mapa: mapaLiberado,
            perfil_mapa: mapaPerfil,
            permissao_funil: funilLiberado,
            perfil_funil: funilPerfil
          }])
          .select();

        if (dbErr) {
          console.warn('Aviso Supabase ao inserir na tabela:', dbErr);
        } else if (Array.isArray(insertedData) && insertedData.length > 0) {
          novoUsuario.id = String(insertedData[0].id);
        }
      } catch (err) {
        console.warn('Erro ao inserir no Supabase, mantendo local.', err);
      }
    }

    usersList.push(novoUsuario);
    salvarUsuariosStorage();
    fecharModal('modalNovoUsuario');
    renderTabelaUsuarios();
    showToast(`Colaborador ${nome} criado com sucesso no Auth e no Farol!`, 'success');
  } catch (errGeral) {
    console.error('Erro ao cadastrar novo usuário:', errGeral);
    showToast('Falha ao cadastrar: ' + errGeral.message, 'error');
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<i class="ph ph-plus-circle"></i> <span>Cadastrar Colaborador</span>';
    }
  }
}

window.abrirEdicaoUsuario = function(id) {
  const u = usersList.find(x => String(x.id) === String(id) || String(x.email).toLowerCase() === String(id).toLowerCase());
  if (!u) {
    console.error('Usuário não encontrado para edição:', id);
    return;
  }

  editingUserId = String(u.id);
  editingUserEmail = String(u.email).toLowerCase();

  const nomeDisplay = document.getElementById('editNomeDisplay');
  const emailDisplay = document.getElementById('editEmailDisplay');
  if (nomeDisplay) nomeDisplay.textContent = u.nome;
  if (emailDisplay) emailDisplay.innerHTML = `<i class="ph ph-envelope-simple"></i> <span>${u.email}</span>`;

  document.getElementById('editNome').value = u.nome;
  document.getElementById('editEmail').value = u.email;
  document.getElementById('editCargo').value = u.cargo;

  // Mapa
  const mapaEl = document.getElementById('editPermMapa');
  mapaEl.checked = !!(u.permissoes.mapa && u.permissoes.mapa.liberado);
  const cardMapa = document.getElementById('cardEditMapa');
  if (cardMapa) cardMapa.className = mapaEl.checked ? 'app-permission-card ativo' : 'app-permission-card inativo';
  const selMapa = document.getElementById('editPerfilMapa');
  if (selMapa) {
    selMapa.value = mapaEl.checked ? u.permissoes.mapa.perfil : 'Operação / CCO';
    selMapa.disabled = !mapaEl.checked;
  }

  // NPS
  const npsEl = document.getElementById('editPermNps');
  npsEl.checked = !!(u.permissoes.nps && u.permissoes.nps.liberado);
  const cardNps = document.getElementById('cardEditNps');
  if (cardNps) cardNps.className = npsEl.checked ? 'app-permission-card ativo' : 'app-permission-card inativo';
  const selNps = document.getElementById('editPerfilNps');
  if (selNps) {
    selNps.value = npsEl.checked ? u.permissoes.nps.perfil : 'Visualizador de Relatórios';
    selNps.disabled = !npsEl.checked;
  }

  // Funil
  const funilEl = document.getElementById('editPermFunil');
  funilEl.checked = !!(u.permissoes.funil && u.permissoes.funil.liberado);
  const cardFunil = document.getElementById('cardEditFunil');
  if (cardFunil) cardFunil.className = funilEl.checked ? 'app-permission-card ativo' : 'app-permission-card inativo';
  const selFunil = document.getElementById('editPerfilFunil');
  if (selFunil) {
    selFunil.value = funilEl.checked ? u.permissoes.funil.perfil : 'Executivo Comercial';
    selFunil.disabled = !funilEl.checked;
  }

  abrirModal('modalEditarUsuario');
};

async function handleSalvarEdicaoUsuario(e) {
  e.preventDefault();
  const btnSubmit = document.getElementById('btnSalvarEdicaoUsuario');
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<i class="ph ph-spinner-gap animate-spin"></i> <span>Salvando...</span>';
  }

  try {
    const emailAlvo = (document.getElementById('editEmail').value || editingUserEmail || '').trim().toLowerCase();
    const u = usersList.find(x => String(x.id) === String(editingUserId) || String(x.email).toLowerCase() === emailAlvo);
    if (!u) {
      showToast('Erro: Colaborador não encontrado para salvar.', 'error');
      return;
    }

    const novoCargo = (document.getElementById('editCargo').value || '').trim();
    if (novoCargo) u.cargo = novoCargo;

    const mapaLiberado = document.getElementById('editPermMapa').checked;
    const mapaPerfil = document.getElementById('editPerfilMapa').value;

    const npsLiberado = document.getElementById('editPermNps').checked;
    const npsPerfil = document.getElementById('editPerfilNps').value;

    const funilLiberado = document.getElementById('editPermFunil').checked;
    const funilPerfil = document.getElementById('editPerfilFunil').value;

    u.permissoes = {
      mapa: { liberado: mapaLiberado, perfil: mapaLiberado ? mapaPerfil : 'Sem Acesso' },
      nps: { liberado: npsLiberado, perfil: npsLiberado ? npsPerfil : 'Sem Acesso' },
      funil: { liberado: funilLiberado, perfil: funilLiberado ? funilPerfil : 'Sem Acesso' }
    };

    // Salva no Supabase se conectado (usando colunas válidas)
    if (sbClient) {
      try {
        const perfilNpsDb = !npsLiberado ? 'bloqueado' : (npsPerfil === 'Admin' ? 'admin' : (npsPerfil === 'Comercial' ? 'comercial' : 'visualizador'));
        const { error: dbError } = await sbClient
          .from('usuarios_nps')
          .update({
            perfil: perfilNpsDb,
            permissao_mapa: mapaLiberado,
            perfil_mapa: mapaPerfil,
            permissao_funil: funilLiberado,
            perfil_funil: funilPerfil
          })
          .ilike('email', u.email);

        if (dbError) {
          console.warn('Aviso Supabase ao sincronizar:', dbError);
        }
      } catch (err) {
        console.warn('Erro ao atualizar Supabase, mantendo sincronização local.', err);
      }
    }

    salvarUsuariosStorage();
    fecharModal('modalEditarUsuario');
    renderTabelaUsuarios();

    if (currentUser && (String(currentUser.id) === String(u.id) || currentUser.email.toLowerCase() === u.email.toLowerCase())) {
      currentUser = u;
      localStorage.setItem(STORAGE_KEY_AUTH, JSON.stringify(currentUser));
      renderLauncher();
    }

    showToast(`Permissões de ${u.nome} sincronizadas com sucesso!`, 'success');
  } catch (errGeral) {
    console.error('Erro ao salvar permissões:', errGeral);
    showToast('Falha ao salvar: ' + errGeral.message, 'error');
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<i class="ph ph-check-bold"></i> <span>Salvar Alterações</span>';
    }
  }
}

async function toggleStatusUsuario(id) {
  const u = usersList.find(x => x.id === id);
  if (!u) return;

  if (u.id === currentUser.id || u.email.toLowerCase() === ADMIN_MASTER_EMAIL) {
    showToast('Você não pode desativar seu próprio usuário administrador.', 'error');
    return;
  }

  u.status = u.status === 'ativo' ? 'inativo' : 'ativo';

  if (sbClient) {
    try {
      await sbClient
        .from('usuarios_nps')
        .update({ ativo: u.status === 'ativo' })
        .ilike('email', u.email);
    } catch (err) {
      console.warn('Erro ao atualizar status no Supabase.', err);
    }
  }

  salvarUsuariosStorage();
  renderTabelaUsuarios();

  const msg = u.status === 'ativo' 
    ? `Acesso de ${u.nome} reativado em todas as ferramentas.` 
    : `Acesso de ${u.nome} suspenso no Farol!`;
  showToast(msg, u.status === 'ativo' ? 'success' : 'error');
}

window.toggleStatusUsuario = toggleStatusUsuario;

// Exclusão com Confirmação
window.solicitarExclusaoUsuario = function(id) {
  const u = usersList.find(x => String(x.id) === String(id) || x.email.toLowerCase() === String(id).toLowerCase());
  if (!u) return;

  if (String(u.id) === String(currentUser.id) || u.email.toLowerCase() === ADMIN_MASTER_EMAIL.toLowerCase()) {
    showToast('Você não pode excluir o Administrador Master.', 'error');
    return;
  }

  usuarioParaExcluir = u;
  document.getElementById('nomeExcluirDisplay').textContent = u.nome;
  abrirModal('modalConfirmExclusao');
};

async function executarExclusaoConfirmada() {
  if (!usuarioParaExcluir) return;

  const nome = usuarioParaExcluir.nome;
  const email = usuarioParaExcluir.email;
  const id = usuarioParaExcluir.id;

  const btnConfirmar = document.getElementById('btnConfirmarExclusaoAcao');
  if (btnConfirmar) {
    btnConfirmar.disabled = true;
    btnConfirmar.innerHTML = '<i class="ph ph-spinner-gap animate-spin"></i> <span>Excluindo...</span>';
  }

  try {
    if (sbClient) {
      try {
        await sbClient
          .from('usuarios_nps')
          .delete()
          .ilike('email', email);
      } catch (err) {
        console.warn('Erro ao deletar no Supabase.', err);
      }
    }

    usersList = usersList.filter(x => String(x.id) !== String(id) && x.email.toLowerCase() !== email.toLowerCase());
    salvarUsuariosStorage();
    fecharModal('modalConfirmExclusao');
    renderTabelaUsuarios();

    showToast(`Colaborador ${nome} excluído permanentemente do Farol.`, 'success');
  } finally {
    if (btnConfirmar) {
      btnConfirmar.disabled = false;
      btnConfirmar.innerHTML = '<i class="ph ph-trash"></i> <span>Excluir Permanentemente</span>';
    }
    usuarioParaExcluir = null;
  }
}

function salvarUsuariosStorage() {
  localStorage.setItem(STORAGE_KEY_USERS, JSON.stringify(usersList));
}

async function handleEnviarEsqueci(e) {
  e.preventDefault();
  const email = document.getElementById('inputEmailEsqueci').value.trim().toLowerCase();
  
  if (!validarDominioCorporativo(email)) {
    showToast('Informe um e-mail oficial corporativo autorizado (@cordeiroguindastes ou @grupocordeiro).', 'error');
    return;
  }

  if (sbClient) {
    try {
      const { error } = await sbClient.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin
      });
      if (error) {
        showToast('Erro ao solicitar redefinição: ' + error.message, 'error');
        return;
      }
    } catch (err) {
      console.warn('Erro ao chamar resetPasswordForEmail:', err);
    }
  }

  fecharModal('modalEsqueci');
  showToast(`Instruções de redefinição enviadas para ${email}! Verifique sua caixa de entrada.`, 'success');
}

function checkPasswordRecovery() {
  const hash = window.location.hash || '';
  if (hash.includes('type=recovery') || hash.includes('access_token=')) {
    setTimeout(() => {
      abrirModal('modalNovaSenhaRecovery');
    }, 400);
  }
}

async function handleSalvarNovaSenhaRecovery(e) {
  e.preventDefault();
  const novaSenha = document.getElementById('inputNovaSenha').value;
  const confirmaSenha = document.getElementById('inputConfirmaNovaSenha').value;
  const erroBox = document.getElementById('erroRecovery');

  erroBox.style.display = 'none';

  if (novaSenha.length < 6) {
    erroBox.textContent = 'A nova senha deve ter no mínimo 6 caracteres.';
    erroBox.style.display = 'block';
    return;
  }

  if (novaSenha !== confirmaSenha) {
    erroBox.textContent = 'As senhas digitadas não coincidem.';
    erroBox.style.display = 'block';
    return;
  }

  const btn = document.getElementById('btnSalvarNovaSenha');
  btn.disabled = true;
  btn.textContent = 'Salvando...';

  try {
    if (sbClient) {
      const { error } = await sbClient.auth.updateUser({ password: novaSenha });
      if (error) {
        erroBox.textContent = 'Falha ao atualizar senha: ' + error.message;
        erroBox.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Salvar Nova Senha';
        return;
      }
    }
    fecharModal('modalNovaSenhaRecovery');
    // Limpa o hash de recuperação da URL
    window.history.replaceState(null, '', window.location.pathname);
    showToast('Senha redefinida com sucesso! Você já pode entrar.', 'success');
  } catch (err) {
    erroBox.textContent = 'Erro inesperado: ' + err.message;
    erroBox.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salvar Nova Senha';
  }
}

function abrirModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

function fecharModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

function showToast(mensagem, tipo = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast-item ${tipo}`;
  toast.innerHTML = `
    <i class="ph ${tipo === 'success' ? 'ph-check-circle' : 'ph-warning-circle'}" style="font-size:18px;"></i>
    <span>${mensagem}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}
